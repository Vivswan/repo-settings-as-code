/**
 * The e2e scenario runner: spawn the committed bundle (lib/index.js) as a
 * real subprocess against a fresh mock GitHub server, then assert the
 * scenario's expectations against the process exit code, its GITHUB_OUTPUT,
 * the step summary, and the mock's request log and violations.
 *
 * Two tenets shape this file:
 * - Hermetic: the child environment is built FROM SCRATCH, never spread from
 *   process.env, so a developer's real token or GitHub URL can never leak into
 *   a run. The token is the inert string "e2e-token".
 * - Production parity: the child runs under `node` (the action's node24
 *   runtime), against the bundle a user would ship, not the TypeScript source.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { MARKER_LABEL } from "../../src/report/issue-report.js";
import type { LoggedRequest } from "./mock/routes.js";
import { type ServerOptions, startMockServer } from "./mock/server.js";
import { sharedValidator } from "./openapi/validate.js";
import type { Expect, Scenario } from "./schema.js";

const ROOT = join(import.meta.dir, "..", "..");
const BUNDLE = join(ROOT, "lib", "index.js");
const OWNER = "e2e-owner";
const REPO = "e2e-repo";
const REPO_SLUG = `${OWNER}/${REPO}`;
/** Hard cap so a hung child never wedges the suite. */
const KILL_AFTER_MS = 30_000;

/** Monotonic per-process counter so repeated same-name failures never collide. */
let artifactCounter = 0;

/** The outcome of running one scenario: pass/fail plus everything observed. */
export interface ScenarioReport {
  scenario: string;
  ok: boolean;
  /** Human-readable failures; empty when the scenario met every expectation. */
  failures: string[];
  exitCode: number;
  outputs: Record<string, string>;
  summary: string;
  stdout: string;
  stderr: string;
  /** The artifact directory written on failure, for the CLI to surface. */
  artifactDir?: string;
  /** Full request log snapshot, for coverage and validation consumers. */
  requests: LoggedRequest[];
}

/** The result of one child process invocation against a running mock. */
interface Invocation {
  exitCode: number;
  outputs: Record<string, string>;
  summary: string;
  stdout: string;
  stderr: string;
}

/**
 * Compare the committed bundle against a fresh build of src/, the same check
 * test/bundle.test.ts makes. Running the stale bundle would test yesterday's
 * code, so fail loudly with the fix command. Cached across a run() batch.
 */
let freshnessChecked = false;
async function assertBundleFresh(): Promise<void> {
  if (freshnessChecked) {
    return;
  }
  const build = await Bun.build({ entrypoints: [join(ROOT, "src/main.ts")], target: "node" });
  const fresh = build.success ? await build.outputs[0]?.text() : undefined;
  const committed = readFileSync(BUNDLE, "utf8");
  if (fresh !== committed) {
    throw new Error("lib/index.js is stale; run: bun run build");
  }
  freshnessChecked = true;
}

/**
 * Parse a GITHUB_OUTPUT file, honoring @actions/core's two forms: the simple
 * `name=value` line and the heredoc block `name<<ghadelimiter_UUID\n...\ndelim`
 * that core uses for values that may contain newlines.
 */
export function parseGithubOutput(text: string): Record<string, string> {
  const outputs: Record<string, string> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const heredoc = line.match(/^([^<=]+)<<(.+)$/);
    if (heredoc) {
      const [, name, delimiter] = heredoc;
      const body: string[] = [];
      i++;
      while (i < lines.length && lines[i] !== delimiter) {
        body.push(lines[i] ?? "");
        i++;
      }
      outputs[(name ?? "").trim()] = body.join("\n");
      continue;
    }
    const eq = line.indexOf("=");
    if (eq > 0) {
      outputs[line.slice(0, eq).trim()] = line.slice(eq + 1);
    }
  }
  return outputs;
}

/**
 * Parse the per-section outcome rows from the step summary. Each managed
 * section renders as `| <key> | :<icon>: <status> | <detail> |`; return
 * key -> status.
 */
export function parseSummaryOutcomes(summary: string): Record<string, string> {
  const outcomes: Record<string, string> = {};
  for (const line of summary.split("\n")) {
    const row = line.match(/^\|\s*([a-z_]+)\s*\|\s*:[a-z_]+:\s*([a-z]+)\s*\|/);
    if (row) {
      const [, key, status] = row;
      if (key && status) {
        outcomes[key] = status;
      }
    }
  }
  return outcomes;
}

/**
 * Parse the multi-repo `repos-result` output: a JSON object mapping each
 * target slug to `{ result, source, skippedSections }`. Returns slug -> result
 * string, the per-target rollup a multi-repo scenario asserts on. A missing or
 * unparseable output yields an empty map (the assertion then reports the gap).
 */
export function parseReposResult(raw: string | undefined): Record<string, string> {
  if (!raw) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [slug, value] of Object.entries(parsed as Record<string, unknown>)) {
    const result = (value as { result?: unknown })?.result;
    if (typeof result === "string") {
      out[slug] = result;
    }
  }
  return out;
}

/**
 * The expected per-target rollup for a multi-repo scenario, merging the
 * top-level expect.repos_result with each repos.*.expect.result. The per-repo
 * results are applied first and the top-level map overwrites them, so the
 * TOP-LEVEL entry wins on conflict (it is the single place to override a
 * co-located per-repo expectation). Returns null for a scenario that pins
 * neither, so single-repo scenarios skip the assertion.
 */
function expectedReposResult(scenario: Scenario): Record<string, string> | null {
  const merged: Record<string, string> = {};
  for (const [slug, spec] of Object.entries(scenario.repos ?? {})) {
    if (spec.expect?.result !== undefined) {
      merged[slug] = spec.expect.result;
    }
  }
  for (const [slug, want] of Object.entries(scenario.expect.repos_result ?? {})) {
    merged[slug] = want;
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

/** Build the child environment from scratch: nothing leaks from process.env. */
function childEnv(scenario: Scenario, dir: string, apiUrl: string): NodeJS.ProcessEnv {
  const inputs = scenario.inputs ?? {};
  const multi = Boolean(scenario.repos || scenario.discovery);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    // Inputs: @actions/core reads INPUT_<NAME> (uppercased, dashes kept).
    INPUT_TOKEN: "e2e-token",
    GITHUB_REPOSITORY: REPO_SLUG,
    GITHUB_API_URL: apiUrl,
    GITHUB_OUTPUT: join(dir, "output.txt"),
    GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
    RUNNER_DEBUG: "1",
    // A test knob so retry scenarios run in milliseconds instead of seconds.
    RETRY_BASE_MS: "1",
  };
  // settings-file is a single-repo input; the action rejects it alongside the
  // multi-repo inputs, so it is set only in single-repo mode.
  if (!multi) {
    env["INPUT_SETTINGS-FILE"] = join(dir, "settings.yml");
  }
  if (inputs.mode) {
    env.INPUT_MODE = inputs.mode;
  }
  if (inputs.on_missing_permission) {
    env["INPUT_ON-MISSING-PERMISSION"] = inputs.on_missing_permission;
  }
  if (inputs.required_sections) {
    env["INPUT_REQUIRED-SECTIONS"] = inputs.required_sections;
  }
  if (inputs.sections) {
    env.INPUT_SECTIONS = inputs.sections;
  }
  if (inputs.private_repos) {
    env["INPUT_PRIVATE-REPOS"] = inputs.private_repos;
  }
  if (inputs.private_report) {
    env["INPUT_PRIVATE-REPORT"] = inputs.private_report;
  }

  // Multi-repo mode: the presence of `repos` or `discovery` switches the action
  // into its multi-repo path. GITHUB_REPOSITORY stays the admin repo; INPUT_REPOS
  // is "*" for discovery or the explicit target slugs; the discovery filter
  // inputs pass through verbatim; and the defaults file (if any) is written to
  // the temp dir and pointed at by INPUT_DEFAULTS-FILE.
  if (scenario.discovery) {
    env.INPUT_REPOS = "*";
    for (const [name, value] of Object.entries(scenario.discovery.inputs)) {
      env[`INPUT_${name.toUpperCase()}`] = value;
    }
  } else if (scenario.repos) {
    env.INPUT_REPOS = Object.keys(scenario.repos).join(",");
  }
  if (scenario.defaults_file) {
    const defaultsPath = join(dir, "defaults.yml");
    writeFileSync(defaultsPath, stringifyYaml(scenario.defaults_file));
    env["INPUT_DEFAULTS-FILE"] = defaultsPath;
  }
  return env;
}

/** Spawn one child run against the mock and collect its I/O. */
async function invoke(scenario: Scenario, dir: string, apiUrl: string): Promise<Invocation> {
  const outputFile = join(dir, "output.txt");
  const summaryFile = join(dir, "summary.md");
  writeFileSync(outputFile, "");
  writeFileSync(summaryFile, "");

  const proc = Bun.spawn(["node", BUNDLE], {
    cwd: dir,
    env: childEnv(scenario, dir, apiUrl),
    stdout: "pipe",
    stderr: "pipe",
  });
  const killer = setTimeout(() => {
    proc.kill();
  }, KILL_AFTER_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(killer);

  return {
    exitCode,
    outputs: parseGithubOutput(readFileSync(outputFile, "utf8")),
    summary: readFileSync(summaryFile, "utf8"),
    stdout,
    stderr,
  };
}

/** Expand the {repo} placeholder a scenario uses in mutation/never patterns. */
function expandRepo(pattern: string): string {
  return pattern.replaceAll("{repo}", REPO_SLUG);
}

/**
 * Strip the `::add-mask::<value>` workflow-command lines core.setSecret emits.
 * Those lines legitimately carry the raw slug so the real GitHub runner can
 * mask it in every later line; the runner consumes and never echoes them, so
 * the harness must drop them before checking that a redacted slug leaked
 * NOWHERE else on stdout. Every other line is matched as-is.
 */
export function stripMaskLines(stdout: string): string {
  return stdout
    .split("\n")
    .filter((line) => !line.startsWith("::add-mask::"))
    .join("\n");
}

/**
 * Drop `::debug::` workflow-command lines. These carry API request TRACES (path,
 * status, and under RUNNER_DEBUG the octokit request log), NOT the run's rendered
 * output. The unredacted counterfactual must judge whether a canary reached a
 * RENDERED public surface - the summary, annotations, or a plain log line -
 * because that is what detail-suppression regressions affect; a canary appearing
 * only in a debug trace does not prove the rendered detail was ever produced.
 */
export function stripDebugLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.startsWith("::debug::"))
    .join("\n");
}

/**
 * The redaction LEAK INVARIANT, shared by curated scenarios and the fuzzer: no
 * forbidden string (a redacted slug or a planted canary) may appear in any
 * publicly-readable surface - the step summary, stdout and stderr (both with the
 * `::add-mask::` lines stripped, since those carry the raw slug for the real
 * runner by design), or any action output value. stderr is included because a
 * GitHub Actions run log captures it too, so a slug printed there leaks just as
 * a stdout one would. Returns one failure line per surface a forbidden string
 * reached; an empty array means no leak. Implemented once here so a scenario and
 * a fuzz iteration prove the exact same property.
 */
export function checkLeaks(
  observed: { summary: string; stdout: string; stderr: string; outputs: Record<string, string> },
  forbidden: string[],
): string[] {
  const failures: string[] = [];
  const maskedStdout = stripMaskLines(observed.stdout);
  const maskedStderr = stripMaskLines(observed.stderr);
  for (const needle of forbidden) {
    if (observed.summary.includes(needle)) {
      failures.push(`leak: "${needle}" present in the step summary`);
    }
    if (maskedStdout.includes(needle)) {
      failures.push(`leak: "${needle}" present in stdout (after stripping ::add-mask:: lines)`);
    }
    if (maskedStderr.includes(needle)) {
      failures.push(`leak: "${needle}" present in stderr (after stripping ::add-mask:: lines)`);
    }
    for (const [name, value] of Object.entries(observed.outputs)) {
      if (value.includes(needle)) {
        failures.push(`leak: "${needle}" present in the "${name}" output`);
      }
    }
  }
  return failures;
}

/** The `body` field of a recorded request payload, when it is a string. */
function stringBody(request: LoggedRequest | undefined): string | undefined {
  const body = (request?.body as { body?: unknown } | undefined)?.body;
  return typeof body === "string" ? body : undefined;
}

/**
 * The report body delivered for a slug: the create POST body when the issue was
 * created this run, else the last PATCH body (an existing issue updated in
 * place). Undefined when no issue write reached the mock for that slug (e.g. the
 * permission-denied path). Shared by the curated issue_report assertion and the
 * fuzz report-body check.
 */
export function deliveredIssueBody(requests: LoggedRequest[], slug: string): string | undefined {
  const base = `/repos/${slug}/issues`;
  const create = requests.find((r) => r.method === "POST" && r.pathname === base);
  const fromCreate = stringBody(create);
  if (fromCreate !== undefined) {
    return fromCreate;
  }
  const lastPatch = requests
    .filter((r) => r.method === "PATCH" && r.pathname.startsWith(`${base}/`))
    .at(-1);
  return stringBody(lastPatch);
}

/**
 * Assert the private-report issue delivery for one slug against the recorded
 * requests: the report body carried the expected substrings (the full
 * unredacted detail), the issue's title/state matched, and the right number of
 * report issues were created. The report body is the POST /issues create body,
 * or - when the issue already existed and was updated - the PATCH body; state
 * is taken from the last create/patch that set it. `created_count` counts
 * POST /issues for the slug (0 proves no issue was created, e.g. the
 * permission-denied path).
 */
export function assertIssueReport(
  spec: NonNullable<Expect["issue_report"]>,
  requests: LoggedRequest[],
): string[] {
  const failures: string[] = [];
  const issuesPath = `/repos/${spec.slug}/issues`;
  const creates = requests.filter((r) => r.method === "POST" && r.pathname === issuesPath);
  const patches = requests.filter(
    (r) => r.method === "PATCH" && r.pathname.startsWith(`${issuesPath}/`),
  );

  if (spec.created_count !== undefined && creates.length !== spec.created_count) {
    failures.push(
      `issue_report: created ${creates.length} report issue(s) for ${spec.slug}, expected ${spec.created_count}`,
    );
  }

  // The delivered body: the create body if the issue was created this run, else
  // the last PATCH body (an existing issue updated in place).
  const created = creates[0]?.body as { title?: unknown; labels?: unknown } | undefined;
  const deliveredBody = deliveredIssueBody(requests, spec.slug);

  if (spec.title !== undefined && created && created.title !== spec.title) {
    failures.push(`issue_report: title "${String(created.title)}" != expected "${spec.title}"`);
  }
  // A created issue MUST carry the marker label - it is the lookup key that makes
  // the one-issue-per-repo reuse work; without it every run would create a new
  // issue. (Only checked on create; a reuse run PATCHes and adds no labels.)
  if (created) {
    const labels = Array.isArray(created.labels) ? created.labels.map(String) : [];
    if (!labels.includes(MARKER_LABEL)) {
      failures.push(
        `issue_report: created issue for ${spec.slug} is missing the marker label "${MARKER_LABEL}"`,
      );
    }
  }
  // The lookup is by the marker LABEL (one indexed request), not a title/creator
  // scan: assert the issues list GET carried labels=<marker>. This pins the
  // load-bearing lookup mechanism the reuse path depends on.
  if (spec.lookup_by_label) {
    const listedByLabel = requests.some(
      (r) =>
        r.method === "GET" &&
        r.pathname === issuesPath &&
        (r.query ?? "").includes(`labels=${MARKER_LABEL}`),
    );
    if (!listedByLabel) {
      failures.push(
        `issue_report: no issues list GET for ${spec.slug} used the labels=${MARKER_LABEL} filter`,
      );
    }
  }
  for (const needle of spec.body_contains ?? []) {
    if (deliveredBody === undefined) {
      failures.push(
        `issue_report: no report body delivered for ${spec.slug}, expected "${needle}"`,
      );
    } else if (!deliveredBody.includes(needle)) {
      failures.push(`issue_report: report body for ${spec.slug} missing "${needle}"`);
    }
  }
  if (spec.state !== undefined) {
    // The final state is the last create/patch that set one.
    const stateWrites = [...creates, ...patches]
      .map((r) => (r.body as { state?: unknown } | undefined)?.state)
      .filter((s): s is string => typeof s === "string");
    // A create defaults the issue open; only an explicit state on a later write
    // changes it, so the last explicit state wins (else "open" from the create).
    const finalState = stateWrites.at(-1) ?? (creates.length > 0 ? "open" : undefined);
    if (finalState !== spec.state) {
      failures.push(
        `issue_report: final issue state "${finalState ?? "(none)"}" != expected "${spec.state}"`,
      );
    }
  }
  return failures;
}

/**
 * Render a logged request to the string the expectations match against. The
 * mock logs pathname and query separately, so both match rules compose here:
 * mutations/never match a "METHOD /pathname" PREFIX (query omitted), and
 * requests_contain matches a substring of "METHOD /pathname?query".
 */
function renderRequest(request: LoggedRequest, includeQuery: boolean): string {
  const base = `${request.method} ${request.pathname}`;
  return includeQuery && request.query ? `${base}?${request.query}` : base;
}

/**
 * True when `patterns` appear as an in-order subsequence of `log`, each
 * matched as a prefix. This is the mutations rule: the declared writes must
 * occur in order, though other requests may interleave.
 */
export function isSubsequence(patterns: string[], log: string[]): boolean {
  let i = 0;
  for (const entry of log) {
    if (i < patterns.length && entry.startsWith(patterns[i] as string)) {
      i++;
    }
  }
  return i === patterns.length;
}

/**
 * The subset of `patterns` that appear as a prefix of some `log` entry. This is
 * the never rule: any forbidden pattern present in the log is a failure.
 */
export function forbiddenPresent(patterns: string[], log: string[]): string[] {
  return patterns.filter((pattern) => log.some((entry) => entry.startsWith(pattern)));
}

/**
 * Run one scenario end to end: start a fresh mock, spawn the bundle, assert
 * every declared expectation in a fixed order (violations first, then exit
 * code, then outputs, outcomes, mutations, never-patterns, substring checks),
 * and finally the optional convergence re-run against the SAME mutated server.
 * On any failure, dump an artifact directory for debugging.
 *
 * `opts.serverOptions` is merged into the mock's ServerOptions (over the
 * scenario's base_prefix), so the fuzz CLI can inject the chaos `corrupt`
 * directive programmatically. Existing single-arg callers are unaffected.
 */
export async function runScenario(
  scenario: Scenario,
  opts?: { serverOptions?: ServerOptions },
): Promise<ScenarioReport> {
  await assertBundleFresh();
  // Create the temp dir and the mock inside try/finally so a failure setting
  // up either one tears down whatever was already created. Both start
  // undefined and the finally cleans up only what exists.
  let dir: string | undefined;
  let handle: Awaited<ReturnType<typeof startMockServer>> | undefined;
  const failures: string[] = [];
  let first: Invocation | undefined;

  try {
    dir = mkdtempSync(join(tmpdir(), "e2e-"));
    handle = await startMockServer(scenario, {
      ...(scenario.base_prefix ? { basePrefix: scenario.base_prefix } : {}),
      // The scenario spells a fault's target as `endpoint`; the mock's
      // FaultOption keys it as `key`. Map the field name here.
      ...(scenario.faults
        ? {
            faults: scenario.faults.map((f) => ({ key: f.endpoint, kind: f.kind, times: f.times })),
          }
        : {}),
      ...opts?.serverOptions,
    });
    writeFileSync(join(dir, "settings.yml"), stringifyYaml(scenario.settings));
    first = await invoke(scenario, dir, handle.url);
    const exp = scenario.expect;

    // 1. Mock-detected contract violations are always fatal and come first.
    if (handle.violations.length > 0) {
      failures.push(`mock violations:\n  ${handle.violations.join("\n  ")}`);
    }
    // 2. Exit code.
    if (first.exitCode !== exp.exit_code) {
      failures.push(`exit code ${first.exitCode} != expected ${exp.exit_code}`);
    }
    // 3. The `result` output.
    if (exp.result !== undefined && first.outputs.result !== exp.result) {
      failures.push(`result "${first.outputs.result}" != expected "${exp.result}"`);
    }
    // 3b. Multi-repo per-target rollup. The expected map merges the top-level
    // expect.repos_result with any per-repo repos.*.expect.result (the latter
    // co-locates a target's expectation with its definition). When the scenario
    // pins any target's result, the live repos-result map must EXACTLY match the
    // expected one - no unexpected targets, none missing.
    const expectedRepos = expectedReposResult(scenario);
    if (expectedRepos) {
      const live = parseReposResult(first.outputs["repos-result"]);
      const liveSlugs = Object.keys(live).sort();
      const wantSlugs = Object.keys(expectedRepos).sort();
      if (JSON.stringify(liveSlugs) !== JSON.stringify(wantSlugs)) {
        failures.push(
          `repos_result targets [${liveSlugs.join(", ")}] != expected [${wantSlugs.join(", ")}]`,
        );
      }
      for (const [slug, want] of Object.entries(expectedRepos)) {
        if (live[slug] !== want) {
          failures.push(`repos_result[${slug}] "${live[slug]}" != expected "${want}"`);
        }
      }
    }
    // 4. Per-section outcomes from the summary table.
    if (exp.outcomes) {
      const live = parseSummaryOutcomes(first.summary);
      for (const [key, want] of Object.entries(exp.outcomes)) {
        if (live[key] !== want) {
          failures.push(`outcome ${key} "${live[key]}" != expected "${want}"`);
        }
      }
    }
    const pathLog = handle.requests.map((r) => renderRequest(r, false));
    const writes = handle.requests
      .filter((r) => r.method !== "GET")
      .map((r) => renderRequest(r, false));
    // 5. Mutations as an ordered subsequence of the non-GET log.
    if (exp.mutations) {
      const want = exp.mutations.map(expandRepo);
      if (!isSubsequence(want, writes)) {
        failures.push(
          `mutations not found as a subsequence:\n  want: ${want.join(", ")}\n  writes: ${writes.join(", ")}`,
        );
      }
    }
    // 6. Forbidden patterns.
    if (exp.never) {
      for (const pattern of forbiddenPresent(exp.never.map(expandRepo), pathLog)) {
        failures.push(`forbidden request present: ${pattern}`);
      }
    }
    // 7. Substring checks.
    for (const needle of exp.summary_contains ?? []) {
      if (!first.summary.includes(needle)) {
        failures.push(`summary missing: ${needle}`);
      }
    }
    for (const needle of exp.stdout_contains ?? []) {
      if (!first.stdout.includes(needle)) {
        failures.push(`stdout missing: ${needle}`);
      }
    }
    // 7b. Negative substring checks (the redaction leak guard). stdout_lacks
    // matches AFTER stripping the ::add-mask:: lines, which carry the raw slug
    // for the real runner by design; summary_lacks matches the summary as-is.
    const maskedStdout = stripMaskLines(first.stdout);
    for (const needle of exp.summary_lacks ?? []) {
      if (first.summary.includes(needle)) {
        failures.push(`summary must not contain: ${needle}`);
      }
    }
    for (const needle of exp.stdout_lacks ?? []) {
      if (maskedStdout.includes(needle)) {
        failures.push(`stdout must not contain: ${needle}`);
      }
    }
    // requests_contain may assert on a query string, so match the full form.
    const fullLog = handle.requests.map((r) => renderRequest(r, true));
    for (const needle of exp.requests_contain ?? []) {
      if (!fullLog.some((entry) => entry.includes(needle))) {
        failures.push(`no request contains: ${needle}`);
      }
    }
    // 7c. Private-report issue delivery: inspect the recorded issue writes for
    // the named slug (the one channel where the private slug/sentinel may
    // legitimately appear - inside the target repo's own issue).
    if (exp.issue_report) {
      failures.push(...assertIssueReport(exp.issue_report, handle.requests));
    }
    // 8. Convergence: rerun in check mode against the SAME mutated server. Arm
    // the mock's check-mode write barrier first (the server still holds the
    // apply-mode scenario, so without this a stray write would not be a
    // violation), then require exit 0 and zero new writes, and re-check the
    // mock's violations for anything the re-run tripped.
    if (exp.converges) {
      const violationsBefore = handle.violations.length;
      const writesBefore = handle.requests.length;
      handle.enterCheckMode();
      const converge = await invoke(
        { ...scenario, inputs: { ...scenario.inputs, mode: "check" } },
        dir,
        handle.url,
      );
      const newWrites = handle.requests.slice(writesBefore).filter((r) => r.method !== "GET");
      if (converge.exitCode !== 0) {
        failures.push(`convergence: rerun exited ${converge.exitCode}, expected 0`);
      }
      if (newWrites.length > 0) {
        failures.push(
          `convergence: rerun wrote ${newWrites.length} time(s): ${newWrites.map((r) => renderRequest(r, false)).join(", ")}`,
        );
      }
      const newViolations = handle.violations.slice(violationsBefore);
      if (newViolations.length > 0) {
        failures.push(`convergence: mock violations:\n  ${newViolations.join("\n  ")}`);
      }
    }

    // 9. OpenAPI contract: every logged request (including the convergence
    // re-run's) must match a documented path/method, and every request/response
    // body must satisfy the trimmed spec. Always on: the mock is our stand-in
    // for GitHub, so any drift from the published contract is a mock bug. Denied
    // and mock-violation traffic is excluded inside the validator.
    const openApiViolations = sharedValidator().validateLog(handle.requests);
    if (openApiViolations.length > 0) {
      const lines = openApiViolations.map((v) => `${v.request} [${v.kind}]: ${v.detail}`);
      failures.push(`OpenAPI contract violations:\n  ${lines.join("\n  ")}`);
    }

    const report: ScenarioReport = {
      scenario: scenario.name,
      ok: failures.length === 0,
      failures,
      exitCode: first.exitCode,
      outputs: first.outputs,
      summary: first.summary,
      stdout: first.stdout,
      stderr: first.stderr,
      requests: [...handle.requests],
    };
    if (!report.ok) {
      report.artifactDir = dumpArtifacts(scenario, report, handle.requests);
    }
    return report;
  } finally {
    if (handle) {
      await handle.stop();
    }
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/**
 * Write a failing scenario's inputs and observed I/O for debugging, and
 * return the directory so the CLI can point the reader at it. Keyed by
 * scenario name and pid so parallel or repeated runs never collide.
 */
function dumpArtifacts(
  scenario: Scenario,
  report: ScenarioReport,
  requests: LoggedRequest[],
): string {
  // Sanitize the scenario name to [a-z0-9-] so it cannot escape the .artifacts
  // root or collide via odd characters; a per-process counter disambiguates
  // repeated failures of the same scenario name.
  const safeName = scenario.name.toLowerCase().replace(/[^a-z0-9-]/g, "-") || "scenario";
  const dir = join(
    ROOT,
    "test",
    "e2e",
    ".artifacts",
    `${safeName}-${process.pid}-${artifactCounter++}`,
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "scenario.yml"), stringifyYaml(scenario));
  writeFileSync(join(dir, "stdout.txt"), report.stdout);
  writeFileSync(join(dir, "stderr.txt"), report.stderr);
  writeFileSync(join(dir, "summary.md"), report.summary);
  writeFileSync(join(dir, "requests.json"), JSON.stringify(requests, null, 2));
  const md = [
    `# ${scenario.name}`,
    "",
    `Artifact directory: ${dir}`,
    "",
    "## Failures",
    "",
    ...report.failures.map((f) => `- ${f.replace(/\n/g, "\n  ")}`),
    "",
    `Exit code: ${report.exitCode}`,
  ].join("\n");
  writeFileSync(join(dir, "report.md"), `${md}\n`);
  return dir;
}
