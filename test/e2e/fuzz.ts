/**
 * The fuzz CLI: `bun test/e2e/fuzz.ts`. Each iteration generates a random
 * scenario, predicts its outcome CLASSES with the oracle, runs the real bundle
 * against the mock, and asserts the observed outcome falls in the predicted
 * class. The oracle never predicts drift content, only the class, so a
 * disagreement means a real engine or oracle bug, not a flaky expectation.
 *
 * Every iteration is a pure function of its seed: the per-iteration seed is
 * printed, so any failure replays with `--seed <iterSeed> --iterations 1`.
 *
 * Modes mixed into the stream: standard single-repo (per-section outcome
 * classes, convergence on a fully-granted apply), input fuzz (a mangled doc must
 * fail before any API contact), chaos fuzz (a single corrupt response is retried
 * away so the run converges, OR a persistent corruption outlasts the retries and
 * the run fails loudly), multi-repo fuzz (per-target outcome classes plus the
 * worst-of rollup), and discovery fuzz (a `repos: "*"` pool filtered by the
 * independent predictDiscovery mirror).
 */

import { rmSync } from "node:fs";
import type { SectionKey } from "../../src/schema.js";
import {
  genDiscoveryScenario,
  genInvalidSettings,
  genLiveWitness,
  genMultiScenario,
  genScenario,
  genSettings,
  INVALID_SETTINGS_CASES,
  type LiveWitness,
  type LiveWitnessKind,
  type MultiRepoMeta,
  NON_MAPPING_YAML,
  type ScenarioMeta,
  UNPARSEABLE_YAML,
  validateAgainstPublishedSchema,
  WITNESS_KINDS,
  WITNESS_SECTIONS,
  type WitnessSection,
} from "./generators.js";
import type { LoggedRequest } from "./mock/routes.js";
import { predictDiscovery, predictMulti, predictOutcomes } from "./oracle.js";
import { Rng } from "./prng.js";
import {
  checkLeaks,
  deliveredIssueBody,
  parseReposResult,
  parseSummaryOutcomes,
  runScenario,
  stripDebugLines,
  stripMaskLines,
} from "./runner.js";
import type { Scenario } from "./schema.js";

const FAILURE_CAP = 5;

/**
 * Multi-repo and discovery fuzz share the single-repo denial barrier, so they
 * stayed gated until the barrier became policy-aware (the rule-4 fix). That has
 * landed, so the mode selector reserves ~1/4 of the stream for the multi-repo
 * drive.
 */
const MULTI_REPO_ENABLED = true;

/** Mix the master seed and an iteration index into a stable per-iteration seed. */
function iterationSeed(master: number, i: number): number {
  let h = (master ^ (i + 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

interface Flags {
  iterations: number;
  seed?: number;
  sections?: SectionKey[];
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { iterations: 50 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--iterations") {
      flags.iterations = Number(argv[++i]);
    } else if (arg === "--seed") {
      flags.seed = Number(argv[++i]);
    } else if (arg === "--sections") {
      flags.sections = (argv[++i] ?? "").split(",").map((s) => s.trim()) as SectionKey[];
    }
  }
  return flags;
}

/**
 * The master seed and whether it was explicitly pinned: flag, else FUZZ_SEED
 * env, else a crypto-random 32-bit value. `explicit` covers BOTH pinning
 * styles, so replay detection treats `FUZZ_SEED=X --iterations 1` exactly
 * like `--seed X --iterations 1`.
 */
function masterSeed(flags: Flags): { seed: number; explicit: boolean } {
  if (flags.seed !== undefined && Number.isFinite(flags.seed)) {
    return { seed: flags.seed >>> 0, explicit: true };
  }
  const raw = (process.env.FUZZ_SEED ?? "").trim();
  const env = Number(raw);
  if (raw !== "" && Number.isFinite(env)) {
    return { seed: env >>> 0, explicit: true };
  }
  return { seed: crypto.getRandomValues(new Uint32Array(1))[0] as number, explicit: false };
}

interface IterationResult {
  ok: boolean;
  failure?: string;
  artifactDir?: string;
  sections: SectionKey[];
  /** Mutation classes this run provably reached (witnessed sections only). */
  coverage?: CoverageEvent[];
}

/**
 * A mutation class the coverage guard tracks per witnessed section. The write
 * classes come from the mock's request log ("applied" alone does not prove a
 * mutation happened; a successful PATCH in the log does); "clean" is a
 * matching-witness check run that the engine reported clean.
 */
type MutationClass = "create" | "update" | "delete" | "clean";

type CoverageEvent = [WitnessSection, MutationClass];

const CLASS_BY_METHOD: Record<string, MutationClass> = {
  POST: "create",
  PATCH: "update",
  DELETE: "delete",
};

/**
 * The mutation classes a run PROVABLY reached: successful (2xx) label and
 * milestone writes from the mock's request log - a denied write mutated
 * nothing and does not count - plus a "clean" event when a matching witness
 * earned a clean check verdict.
 */
function witnessCoverage(
  requests: LoggedRequest[],
  meta: ScenarioMeta,
  observed: Record<string, string>,
): CoverageEvent[] {
  const events: CoverageEvent[] = [];
  for (const request of requests) {
    const cls = CLASS_BY_METHOD[request.method];
    if (cls === undefined || request.status < 200 || request.status >= 300) {
      continue;
    }
    const section = request.pathname.includes("/labels")
      ? "labels"
      : request.pathname.includes("/milestones")
        ? "milestones"
        : undefined;
    if (section !== undefined) {
      events.push([section, cls]);
    }
  }
  for (const key of WITNESS_SECTIONS) {
    if (meta.liveKinds?.[key] === "matching" && observed[key] === "clean") {
      events.push([key, "clean"]);
    }
  }
  return events;
}

/**
 * Run one generated single-repo scenario against its oracle prediction: the
 * shared core of the standard random iteration and the directed witness
 * battery. A fully-granted apply also asserts convergence (the runner's
 * converges machinery).
 */
async function runPredicted(scenario: Scenario, meta: ScenarioMeta): Promise<IterationResult> {
  const prediction = predictOutcomes(meta);
  // The runner requires an expect.exit_code; we assert the exit code against
  // the oracle's ALLOWED SET in fuzz.ts instead (a set cannot be expressed as
  // a single expect), so set a placeholder here and filter the runner's own
  // exit-code check out of its failures below. Fully-granted applies must
  // converge, so ask the runner to do the convergence re-run and write-barrier.
  const converges = prediction.fullyGranted && meta.mode === "apply";
  scenario.expect = { exit_code: 0, ...(converges ? { converges: true } : {}) };

  const report = await runScenario(scenario);
  const problems: string[] = [];

  // The runner folds mock violations and (for converges) the barrier/re-run
  // checks into failures; anything there but the exit-code mismatch is a real
  // problem, since we set a permissive exit_code.
  for (const failure of report.failures) {
    if (!failure.startsWith("exit code ")) {
      problems.push(failure);
    }
  }
  // Exit code must be in the oracle's allowed set.
  if (!prediction.allowedExitCodes.has(report.exitCode)) {
    problems.push(
      `exit code ${report.exitCode} not in predicted {${[...prediction.allowedExitCodes].join(",")}}`,
    );
  }
  // Each predicted section must APPEAR in the summary (a predicted section
  // missing entirely is a silent regression the old `if (got)` guard hid), and
  // its reported outcome must be in its predicted class. EXCEPTION: when the run
  // aborts at the preflight barrier (apply + fail policy + a permission-denied
  // section), the engine renders NO sections, so the summary is empty by design.
  const observed = parseSummaryOutcomes(report.summary);
  if (!prediction.preflightAborts) {
    for (const section of prediction.sections) {
      const got = observed[section.key];
      if (got === undefined) {
        problems.push(
          `${section.key}: predicted {${[...section.allowed].join(",")}} but the section is absent from the summary`,
        );
        continue;
      }
      if (!section.allowed.has(got as never)) {
        problems.push(
          `${section.key}: observed "${got}" not in predicted {${[...section.allowed].join(",")}} (grade ${section.grade})`,
        );
      }
    }
  }

  return {
    ok: problems.length === 0,
    failure: problems.length > 0 ? problems.join("; ") : undefined,
    artifactDir: report.artifactDir,
    sections: meta.sections,
    coverage: witnessCoverage(report.requests, meta, observed),
  };
}

/**
 * Run one standard (single-repo) iteration: generate, predict, execute, and
 * check the observed outcome against the oracle's allowed classes.
 */
async function standardIteration(
  seed: number,
  opts: { sections?: SectionKey[] },
): Promise<IterationResult> {
  const { scenario, meta } = genScenario(new Rng(seed), opts);
  return runPredicted(scenario, meta);
}

/**
 * A directed witness iteration: one (section, witness kind, mode) with a fully
 * granted token and warn policy, so the witness alone decides the outcome
 * class. The random stream reaches these combinations only probabilistically;
 * this battery makes the mutation-class coverage guard deterministic, so a
 * generator regression that stops producing real witnesses fails the run
 * instead of silently starving the histogram.
 */
async function witnessIteration(
  seed: number,
  key: WitnessSection,
  kind: LiveWitnessKind,
  mode: "apply" | "check",
): Promise<IterationResult> {
  const rng = new Rng(seed);
  // milestones' drift-update degrades to matching when no milestone declares a
  // perturbable field; redraw (deterministically) until the kind holds.
  let settings: unknown;
  let witness: LiveWitness | undefined;
  for (let attempt = 0; attempt < 20 && witness?.kind !== kind; attempt++) {
    const draw = rng.fork(`draw:${attempt}`);
    settings = genSettings(draw.fork("settings"), key);
    witness = genLiveWitness(draw.fork("live"), key, settings, kind);
  }
  if (witness === undefined || witness.kind !== kind) {
    return {
      ok: false,
      failure: `could not draw a "${kind}" ${key} witness in 20 attempts`,
      sections: [key],
    };
  }

  const settingsDoc = { [key]: settings };
  validateAgainstPublishedSchema(settingsDoc);
  const meta: ScenarioMeta = {
    sections: [key],
    mask: {},
    mode,
    policy: "warn",
    ownerKind: "org",
    denialStyle: "fine_grained",
    requiredSections: [],
    liveKinds: { [key]: witness.kind },
  };
  const scenario: Scenario = {
    name: `fuzz-witness-${key}-${kind}-${mode}-${seed}`,
    tiers: ["mock"],
    settings: settingsDoc,
    inputs: { mode, on_missing_permission: "warn" },
    denial_style: "fine_grained",
    owner_kind: "org",
    live_state: witness.state,
    expect: { exit_code: 0 },
  };
  return runPredicted(scenario, meta);
}

/**
 * The specification of one rejection scenario: what the settings file contains
 * (a document or raw text - exactly one) and the tokens the action's error
 * must name. Shared by the random input stream and the directed input battery.
 */
interface RejectionSpec {
  label: string;
  settings?: Record<string, unknown>;
  settingsRaw?: string;
  tokens: string[];
  /** Pinned run mode; absent means a seeded random pick (the fuzz stream). */
  mode?: "apply" | "check";
}

/**
 * Run one settings-rejection scenario: the action must exit 1, its error must
 * contain every expected token, and ZERO requests may reach the mock - a
 * validation or parse error is caught before any API contact, in both apply
 * and check mode. Belt and braces on the zero-request property: the runner's
 * `zero_requests` expectation fails the scenario, and the sampled request log
 * here names the offending calls for the failure report.
 */
async function rejectionIteration(seed: number, spec: RejectionSpec): Promise<IterationResult> {
  const rng = new Rng(seed);
  const scenario: Scenario = {
    name: `fuzz-input-${spec.label}-${seed}`,
    tiers: ["mock"],
    ...(spec.settingsRaw !== undefined
      ? { settings_raw: spec.settingsRaw }
      : { settings: spec.settings ?? {} }),
    inputs: { mode: spec.mode ?? rng.pick(["apply", "check"]) },
    denial_style: "fine_grained",
    owner_kind: "org",
    expect: { exit_code: 1, stdout_contains: spec.tokens, zero_requests: true },
  };
  const report = await runScenario(scenario);
  const problems = report.ok ? [] : [...report.failures];
  if (report.requests.length > 0) {
    const sample = report.requests
      .slice(0, 3)
      .map((r) => `${r.method} ${r.pathname}`)
      .join(", ");
    problems.push(
      `input fuzz reached the API ${report.requests.length} time(s) before rejecting the doc: ${sample}`,
    );
  }
  return {
    ok: problems.length === 0,
    failure: problems.length > 0 ? `[${spec.label}] ${problems.join("; ")}` : undefined,
    artifactDir: report.artifactDir,
    sections: [],
  };
}

/** A random validator-rejection spec drawn from the invalid-settings catalog. */
function invalidDocSpec(rng: Rng): RejectionSpec {
  const { name, doc, offendingToken } = genInvalidSettings(rng);
  return { label: `invalid-${name}`, settings: doc, tokens: [offendingToken] };
}

/**
 * A raw settings.yml the yaml parser rejects: single-repo this dies in
 * readSettingsFile (local fs + parse, before ANY API call) with the
 * "cannot read settings ... valid YAML" advice.
 */
function unparseableRawSpec(rng: Rng): RejectionSpec {
  return {
    label: "raw-unparseable",
    settingsRaw: rng.pick(UNPARSEABLE_YAML),
    tokens: ["cannot read settings", "valid YAML"],
  };
}

/**
 * A raw settings.yml that parses to a non-mapping: the parse succeeds, so
 * the rejection comes from validateSettingsDoc's top-level check instead.
 */
function nonMappingRawSpec(rng: Rng): RejectionSpec {
  return {
    label: "raw-non-mapping",
    settingsRaw: rng.pick(NON_MAPPING_YAML),
    tokens: ["must be a YAML mapping"],
  };
}

/**
 * Input fuzz: feed the action a settings file it must reject BEFORE any API
 * contact. Three shapes, weighted toward the rich validator catalog: a
 * catalog case (wrong container/item/enum/nested types, an unknown top-level
 * key), raw unparseable YAML, or raw YAML parsing to a non-mapping. Every
 * shape must exit 1 with the offending token named and zero requests.
 */
async function inputFuzzIteration(seed: number): Promise<IterationResult> {
  const rng = new Rng(seed);
  const roll = rng.int(4);
  const spec =
    roll === 2
      ? unparseableRawSpec(rng)
      : roll === 3
        ? nonMappingRawSpec(rng)
        : invalidDocSpec(rng.fork("case"));
  return rejectionIteration(seed, spec);
}

/** The three chaos corruption modes the mock supports (see CorruptOption). */
const CHAOS_MODES = ["invalid_json", "wrong_shape", "missing_envelope"] as const;

/**
 * Chaos fuzz: corrupt the labels-list response and assert the action reacts
 * correctly. Two deterministic variants, split by the seed:
 *
 * - Single-shot (retry resilience): one corrupt response. The client's retry
 *   plugin (MAX_RETRIES=2, 3 total attempts) sees a transport-level fault - a
 *   parse failure, a wrong-shaped body, or a stripped envelope, none of them a
 *   4xx - and retries it away, so the apply succeeds AND converges. The
 *   assertion is that a transient glitch does not derail the run.
 *
 * - Persistent (loud failure): the corruption is served on every attempt
 *   (times: "always"), so it outlasts the retries. The action must then fail
 *   LOUDLY: a non-zero exit, an actionable error naming the section, no write
 *   after the corrupted read, and no unhandled stack in stderr.
 *
 * labels.list is the target: every labels-bearing scenario issues it as its
 * first read, and it returns an enveloped-or-bare list all three modes mangle.
 */
async function chaosFuzzIteration(seed: number): Promise<IterationResult> {
  const rng = new Rng(seed);
  const mode = rng.pick([...CHAOS_MODES]);
  // Split the chaos stream deterministically: ~1/3 persistent, the rest single
  // shot. Both are seeded from the same rng so a chaos seed replays identically.
  const persistent = rng.int(3) === 0;
  return persistent ? persistentChaosIteration(seed, mode) : singleShotChaosIteration(seed, mode);
}

/** One corrupt response, retried away: the run must still apply and converge. */
async function singleShotChaosIteration(
  seed: number,
  mode: (typeof CHAOS_MODES)[number],
): Promise<IterationResult> {
  const scenario: Scenario = {
    name: `fuzz-chaos-single-${seed}`,
    tiers: ["mock"],
    // A single declared label with the section fully granted (default mask is
    // write), so the read reaches the mock and the corruption fires.
    settings: { labels: [{ name: "chaos", color: "d73a4a" }] },
    inputs: { mode: "apply" },
    denial_style: "fine_grained",
    owner_kind: "org",
    // The corrupt response is retried away, so the apply must both succeed AND
    // converge: a check-mode re-run against the mutated mock writes nothing.
    expect: { exit_code: 0, converges: true },
  };
  const report = await runScenario(scenario, {
    serverOptions: { corrupt: { key: "labels.list", mode } },
  });
  // The mock marks a corrupt body offSpec at source, so the OpenAPI validator
  // skips it; every remaining failure (including a broken convergence re-run) is
  // a real problem. No filtering needed.
  const problems = [...report.failures];
  if (/\n\s+at\s+\S+ \(/.test(report.stderr)) {
    problems.push(`unhandled stack in stderr under ${mode}`);
  }
  const observed = parseSummaryOutcomes(report.summary);
  if (observed.labels === undefined) {
    problems.push(`labels row absent from the summary under ${mode}, expected applied`);
  } else if (observed.labels !== "applied") {
    problems.push(`labels observed "${observed.labels}" under ${mode}, expected applied`);
  }
  return {
    ok: problems.length === 0,
    failure: problems.length > 0 ? `[single ${mode}] ${problems.join("; ")}` : undefined,
    artifactDir: report.artifactDir,
    sections: ["labels"],
  };
}

/** Corruption on every attempt: retries are exhausted, so the run fails loudly. */
async function persistentChaosIteration(
  seed: number,
  mode: (typeof CHAOS_MODES)[number],
): Promise<IterationResult> {
  const scenario: Scenario = {
    name: `fuzz-chaos-persist-${seed}`,
    tiers: ["mock"],
    settings: { labels: [{ name: "chaos", color: "d73a4a" }] },
    inputs: { mode: "apply" },
    denial_style: "fine_grained",
    owner_kind: "org",
    // The corruption outlasts every retry, so the run must fail (exit 1) with no
    // write ever leaving the client.
    expect: { exit_code: 1 },
  };
  const report = await runScenario(scenario, {
    serverOptions: { corrupt: { key: "labels.list", mode, times: "always" } },
  });
  const problems = [...report.failures];
  // The failure must be LOUD and actionable, not a crash: an ::error:: line that
  // names the labels section, no unhandled stack in stderr, and crucially NO
  // write (POST/PUT/PATCH/DELETE) after the corrupted read - the action must not
  // proceed to mutate on an unparseable list.
  if (/\n\s+at\s+\S+ \(/.test(report.stderr)) {
    problems.push(`unhandled stack in stderr under persistent ${mode}`);
  }
  const errorNamesSection = /::error::[^\n]*labels/.test(report.stdout);
  if (!errorNamesSection) {
    problems.push(`persistent ${mode}: no actionable error naming the labels section`);
  }
  const writes = (report.requests ?? []).filter(
    (r) => r.method !== "GET" && /\/labels/.test(r.pathname),
  );
  if (writes.length > 0) {
    problems.push(
      `persistent ${mode}: ${writes.length} label write(s) after the corrupted read - must not mutate`,
    );
  }
  return {
    ok: problems.length === 0,
    failure: problems.length > 0 ? `[persist ${mode}] ${problems.join("; ")}` : undefined,
    artifactDir: report.artifactDir,
    sections: ["labels"],
  };
}

/**
 * Multi-repo fuzz: generate a 2-5 repo scenario, predict each target's outcome
 * class + the worst-of rollup, run it through the multi-repo path, and assert
 * the per-target results and the run exit code fall in the predicted classes.
 * A missing-settings target, or one whose `contents` read is denied, is
 * settings-gated (skipped, or failed under the 403 style); the oracle carries
 * each target's allowed repo-level result, so this only checks membership.
 */
async function multiRepoFuzzIteration(seed: number): Promise<IterationResult> {
  const { scenario, meta } = genMultiScenario(new Rng(seed));
  const prediction = predictMulti(meta);
  scenario.expect = { exit_code: 0 };

  const report = await runScenario(scenario);
  const problems: string[] = [];
  // Non-vacuity guard: a redact run must always exercise a non-empty forbidden
  // set (the generator forces one private target), so the leak check below is
  // never trivially satisfied. A regression that lets a redact run go all-public
  // fails here instead of passing vacuously.
  if (meta.privateRepos === "redact" && prediction.forbidden.length === 0) {
    problems.push("redact run produced an empty forbidden set - the leak check would be vacuous");
  }
  for (const failure of report.failures) {
    if (!failure.startsWith("exit code ")) {
      problems.push(failure);
    }
  }
  if (!prediction.allowedExitCodes.has(report.exitCode)) {
    problems.push(
      `exit code ${report.exitCode} not in predicted {${[...prediction.allowedExitCodes].join(",")}}`,
    );
  }
  // Redaction keys a private/probe-denied target by its "private repository #N"
  // placeholder, so the results and predictions are compared on displayKey, not
  // the real slug.
  const results = parseReposResult(report.outputs["repos-result"]);
  for (const repo of prediction.repos) {
    const got = results[repo.displayKey];
    if (got === undefined) {
      problems.push(
        `${repo.displayKey}: predicted {${[...repo.allowedResults].join(",")}} but the repo is absent from repos-result`,
      );
      continue;
    }
    if (!repo.allowedResults.has(got)) {
      problems.push(
        `${repo.displayKey}: result "${got}" not in predicted {${[...repo.allowedResults].join(",")}}`,
      );
    }
  }
  // No unexpected keys in the output either: every reported key must be one the
  // oracle predicted (a stray target - or a leaked real slug where a placeholder
  // was expected - is as much a bug as a missing one).
  const predictedKeys = new Set(prediction.repos.map((r) => r.displayKey));
  for (const key of Object.keys(results)) {
    if (!predictedKeys.has(key)) {
      problems.push(`${key}: reported in repos-result but not predicted`);
    }
  }
  // A raw-settings target must fail at ITS promised gate, not just "somehow":
  // an unrelated pre-validation exception would also read as {failed}. So the
  // gate wording must appear on a rendered public surface (or, for a redacted
  // target, must NOT - the rich detail is private, and this scenario's only
  // source of that wording is this target). And the parse gate must stop the
  // run before any section call: the target's legitimate request surface is
  // the repo probe, the contents fetch, and the report channel's labels/issues
  // routes - which never PATCH or DELETE a label.
  const renderedPublic = [
    stripDebugLines(stripMaskLines(report.stdout)),
    stripDebugLines(stripMaskLines(report.stderr)),
    report.summary,
    ...Object.values(report.outputs),
  ].join("\n");
  for (const repo of meta.repos) {
    if (repo.target.kind !== "raw-invalid") {
      continue;
    }
    const wording = repo.target.raw === "unparseable" ? "cannot parse" : "must be a YAML mapping";
    if (repo.redacted) {
      if (renderedPublic.includes(wording)) {
        problems.push(
          `raw target ${repo.displayKey}: gate wording "${wording}" leaked to a public surface despite redaction`,
        );
      }
    } else if (!renderedPublic.includes(wording)) {
      problems.push(
        `raw target ${repo.slug}: failure does not carry the promised gate wording "${wording}"`,
      );
    }
    // The parse gate stops the target before any section call, so the only
    // legitimate requests are: the repo probe (GET /repos/{slug} exactly),
    // the settings-file read (GET on contents), and the report channel's
    // issue delivery (GET/POST/PATCH on issues, POST-only on labels - the
    // marker-label ensure-create; the channel never lists or edits labels).
    const probePath = `/repos/${repo.slug}`;
    const base = `${probePath}/`;
    const allowedByHead: Record<string, ReadonlySet<string>> = {
      contents: new Set(["GET"]),
      labels: new Set(["POST"]),
      issues: new Set(["GET", "POST", "PATCH"]),
    };
    for (const request of report.requests) {
      const isProbe = request.pathname === probePath;
      if (!isProbe && !request.pathname.startsWith(base)) {
        continue;
      }
      const head = isProbe ? "" : (request.pathname.slice(base.length).split("/")[0] ?? "");
      const allowed = isProbe
        ? request.method === "GET"
        : (allowedByHead[head]?.has(request.method) ?? false);
      if (!allowed) {
        problems.push(
          `raw target ${repo.slug}: unexpected request ${request.method} ${request.pathname} - the parse gate must stop the target before any section call`,
        );
      }
    }
  }
  // The shared LEAK INVARIANT: with redaction active, no redacted slug and no
  // planted canary may appear in any public surface (stdout with ::add-mask::
  // lines stripped, the summary, or any output). Empty forbidden set under show.
  problems.push(...checkLeaks(report, prediction.forbidden));

  // UNREDACTED COUNTERFACTUAL: prove this iteration is a REAL leak test, not a
  // vacuous one. Re-run the SAME scenario under private-repos: show and require
  // that at least one canary provably surfaces in a RENDERED public surface -
  // the summary, an annotation, a plain log line, or an output - NOT merely a
  // ::debug:: API trace. Detail-suppression regressions affect rendered output,
  // so a canary that only ever appears in a debug trace would not catch them.
  // The generator pins the forced-private target fully granted, so its canary
  // label's name always reaches the rendered detail under show. Only canaries
  // are checked (not slugs), since it is DETAIL suppression this guards.
  if (meta.privateRepos === "redact") {
    const canaries = meta.repos.flatMap((r) => r.canaries);
    if (canaries.length > 0) {
      const shown = await runScenario({
        ...scenario,
        // Drop the whole report config: a delivering channel (`issue` or
        // `artifact`) + `show` is rejected at config parse (show redacts
        // nothing), and a leftover report_public_key without private-report:
        // artifact is rejected too. Either rejection would make the
        // counterfactual fail to start and falsely read as "no canary surfaced".
        inputs: {
          ...scenario.inputs,
          private_repos: "show",
          private_report: "none",
          report_public_key: undefined,
        },
      });
      const rendered = [
        stripDebugLines(stripMaskLines(shown.stdout)),
        stripDebugLines(stripMaskLines(shown.stderr)),
        shown.summary,
        ...Object.values(shown.outputs),
      ].join("\n");
      if (!canaries.some((c) => rendered.includes(c))) {
        problems.push(
          "counterfactual: no canary surfaced in a rendered surface under private-repos: show, so the redacted leak check is vacuous",
        );
      }
    }
  }

  // REPORT-BODY POSITIVE ASSERTION (the plan's canary-in-report check): under
  // private-report: issue, a redacted target whose report DELIVERS (Issues
  // granted and its settings readable) must carry its canaries in ITS OWN report
  // issue body - the one private channel where the full detail legitimately
  // lands. The forced-private target is fully granted, so its report always
  // delivers; assert its canaries reached the recorded issue body. This proves
  // suppression did not eat the report.
  if (meta.privateReport === "issue") {
    for (const repo of meta.repos) {
      if (!repo.redacted || !reportDelivers(repo) || repo.canaries.length === 0) {
        continue;
      }
      const body = deliveredIssueBody(report.requests, repo.slug);
      if (body === undefined) {
        problems.push(`report: no issue body delivered for the redacted target ${repo.slug}`);
        continue;
      }
      // The label-name canary flows into the report's section detail and
      // transcript in every mode (create/update/drift all name the label), so it
      // is the one asserted here; the description canaries only surface in check
      // mode and are already covered by the leak invariant. A delivering target
      // that carries canaries MUST have a `-name` one - if the naming convention
      // changes out from under this check, that is a failure, not a silent skip.
      const nameCanary = repo.canaries.find((c) => c.endsWith("-name"));
      if (nameCanary === undefined) {
        problems.push(
          `report: ${repo.slug} has canaries but no -name canary to assert in the body`,
        );
      } else if (!body.includes(nameCanary)) {
        problems.push(`report: issue body for ${repo.slug} is missing canary ${nameCanary}`);
      }
    }
  }

  // ARTIFACT CHANNEL ASSERTION: under private-report: artifact, every redacted
  // target's report is accumulated and uploaded as ONE age-encrypted workflow
  // artifact. There is no readable delivered body in the harness (the upload
  // fails safely: ACTIONS_RUNTIME_TOKEN is absent), so there is no positive
  // canary-in-body check here - the leak invariant above already proves the
  // report plaintext reached no PUBLIC surface, which is the property that
  // matters. Two things must hold: the artifact channel never touches the issue
  // routes (that is the issue channel's job), and when a report was actually
  // composed (a redacted target delivered), the run emitted the ONE safe warning
  // naming the artifact service - never a slug or the report plaintext.
  if (meta.privateReport === "artifact") {
    const issueWrites = report.requests.filter(
      (r) => r.method !== "GET" && /\/issues(\/|$|\?)/.test(r.pathname),
    );
    if (issueWrites.length > 0) {
      const sample = issueWrites.map((r) => `${r.method} ${r.pathname}`).join(", ");
      problems.push(`artifact channel wrote to the issue routes: ${sample}`);
    }
    const composed = meta.repos.some((r) => reportDelivers(r));
    // The upload is accumulated into ONE artifact after the whole loop, so a
    // composed report yields EXACTLY ONE safe upload-failure warning - never one
    // per target. Count the warning lines so a per-target repeated-warning
    // regression (or a silent zero) fails here.
    const uploadWarnings = report.stdout
      .split("\n")
      .filter((line) => line.includes("could not upload the private report artifact")).length;
    if (composed && uploadWarnings !== 1) {
      problems.push(
        `artifact channel composed a report but emitted ${uploadWarnings} upload-failure warning(s), expected exactly 1`,
      );
    }
  }

  return {
    ok: problems.length === 0,
    failure: problems.length > 0 ? problems.join("; ") : undefined,
    artifactDir: report.artifactDir,
    sections: [],
  };
}

/**
 * Whether a redacted target's private report DEFINITELY composes and delivers.
 * Only true for the fully-granted (empty per-repo mask) forced-private target: it
 * has a settings file, Issues write, and Contents read, so its report is always
 * composed. Under the issue channel that means its canary must appear in the
 * report ISSUE body; under the artifact channel it means a report was composed,
 * so the safe upload-failure warning must fire. Other redacted targets may have
 * Issues denied (a safe warning, no body), so they are not asserted - the leak
 * invariant already covers them.
 */
function reportDelivers(repo: MultiRepoMeta): boolean {
  return (
    repo.redacted &&
    repo.target.kind === "normal" &&
    Object.keys(repo.target.meta.mask).length === 0
  );
}

/**
 * Discovery fuzz: generate a `repos: "*"` scenario with a random pool and random
 * filters, predict the kept slug set with the INDEPENDENT predictDiscovery, and
 * assert the action discovered and processed exactly those repos (the
 * repos-result keys equal the predicted kept set). This exercises the discovery
 * filter chain end to end and cross-checks the oracle's glob mirror against the
 * engine's live filtering.
 */
async function discoveryFuzzIteration(seed: number): Promise<IterationResult> {
  const { scenario, meta } = genDiscoveryScenario(new Rng(seed));
  const kept = predictDiscovery(meta.pool, meta.filters);
  // Zero surviving repos is a fatal configuration error for the action (there
  // is nothing to apply against), so the exit prediction follows the kept set.
  // The runner's own exit-code check enforces it; no failure is filtered here.
  scenario.expect = { exit_code: kept.length === 0 ? 1 : 0 };

  const report = await runScenario(scenario);
  const problems: string[] = [...report.failures];
  const results = parseReposResult(report.outputs["repos-result"]);
  const got = new Set(Object.keys(results));

  const redact = meta.privateRepos === "redact";
  const visibilityOf = new Map(meta.pool.map((r) => [r.slug, r.visibility ?? "public"]));
  // The display KEY the action emits per kept repo: under redact, a
  // private/internal kept repo is keyed by "private repository #N" numbered over
  // the kept repos in kept order (matching planRedaction); a public one keeps its
  // slug. Discovery has no per-repo probe (visibility comes from /user/repos), so
  // only the planted visibility matters.
  const expectedKeys = new Set<string>();
  let ordinal = 0;
  for (const slug of kept) {
    const isPrivate = redact && visibilityOf.get(slug) !== "public";
    if (isPrivate) {
      ordinal += 1;
      expectedKeys.add(`private repository #${ordinal}`);
    } else {
      expectedKeys.add(slug);
    }
  }
  for (const key of expectedKeys) {
    if (!got.has(key)) {
      problems.push(`discovery expected key ${key} but it is absent from repos-result`);
    }
  }
  for (const key of got) {
    if (!expectedKeys.has(key)) {
      problems.push(`discovery processed ${key} but it was not an expected key`);
    }
  }
  // The leak invariant: under redact, EVERY private/internal pool repo - kept
  // (redacted) or filtered out - must have its slug absent from every public
  // surface. Public kept slugs render normally and are not forbidden.
  if (redact) {
    const forbidden = meta.pool
      .filter((r) => (r.visibility ?? "public") !== "public")
      .map((r) => r.slug);
    problems.push(...checkLeaks(report, forbidden));
  }
  return {
    ok: problems.length === 0,
    failure:
      problems.length > 0
        ? `filters ${JSON.stringify(meta.filters)}: ${problems.join("; ")}`
        : undefined,
    artifactDir: report.artifactDir,
    sections: [],
  };
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));
  const { seed: master, explicit } = masterSeed(flags);
  // Replay convenience: one iteration under an EXPLICIT seed (--seed flag or
  // FUZZ_SEED env, treated identically) runs that exact iteration seed, so a
  // failing iteration reproduces directly from its printed seed. Otherwise
  // the per-iteration seed is hash(master, i).
  const replayOne = flags.iterations === 1 && explicit;
  console.log(`fuzz master seed: ${master} (replay: --seed ${master})`);
  console.log(`iterations: ${flags.iterations}`);

  const coverage = new Map<SectionKey, number>();
  const mutationHistogram = new Map<WitnessSection, Map<MutationClass, number>>();
  const recordCoverage = (events: CoverageEvent[] | undefined): void => {
    for (const [section, cls] of events ?? []) {
      const counts = mutationHistogram.get(section) ?? new Map<MutationClass, number>();
      counts.set(cls, (counts.get(cls) ?? 0) + 1);
      mutationHistogram.set(section, counts);
    }
  };
  const failingSeeds: number[] = [];
  let failures = 0;

  for (let i = 0; i < flags.iterations; i++) {
    const seed = replayOne ? master : iterationSeed(master, i);
    // Mode selection over an 8-way roll: ~1/4 multi-repo (when enabled), 1/8
    // input fuzz, 1/8 chaos, 1/8 discovery, the rest standard single-repo.
    const roll = new Rng(seed ^ 0x5bd1e995).int(8);
    let result: IterationResult;
    let mode: string;
    if (MULTI_REPO_ENABLED && roll < 2) {
      mode = "multi";
      result = await multiRepoFuzzIteration(seed);
    } else if (roll === 2) {
      mode = "input";
      result = await inputFuzzIteration(seed);
    } else if (roll === 3) {
      mode = "chaos";
      result = await chaosFuzzIteration(seed);
    } else if (roll === 4) {
      mode = "discovery";
      result = await discoveryFuzzIteration(seed);
    } else {
      mode = "standard";
      result = await standardIteration(seed, { sections: flags.sections });
    }
    for (const section of result.sections) {
      coverage.set(section, (coverage.get(section) ?? 0) + 1);
    }
    recordCoverage(result.coverage);
    if (!result.ok) {
      failures++;
      failingSeeds.push(seed);
      // Only the standard mode consumes --sections; when it is set, a faithful
      // replay must pass the SAME flag, since the seed alone would draw from the
      // full section pool and produce a different scenario. Echo it per failure.
      const sectionsFlag =
        mode === "standard" && flags.sections ? ` --sections ${flags.sections.join(",")}` : "";
      console.log(`  iter ${i} [${mode}] seed ${seed} FAIL: ${result.failure}`);
      console.log(`    replay: bun test/e2e/fuzz.ts --seed ${seed} --iterations 1${sectionsFlag}`);
      if (result.artifactDir) {
        console.log(`    artifact: ${result.artifactDir}`);
      }
      if (failures >= FAILURE_CAP) {
        console.log(`\nfailure cap (${FAILURE_CAP}) reached; stopping`);
        break;
      }
    } else {
      // The runner dumps an artifact whenever ITS expect check fails, and fuzz
      // sets a placeholder expect.exit_code:0 - so a legitimately-exit-1
      // iteration the ORACLE deems ok still leaves an artifact dir behind. Remove
      // it here so .artifacts holds ONLY real fuzz failures and the nightly
      // issue filer's count stays honest.
      if (result.artifactDir) {
        rmSync(result.artifactDir, { recursive: true, force: true });
      }
      console.log(`  iter ${i} [${mode}] seed ${seed} ok`);
    }
  }

  // Directed witness battery: every (section, witness kind, mode) combination,
  // deterministically derived from the master seed. The random stream reaches
  // these only probabilistically, so the mutation-class guard below would be
  // flaky without it. Skipped on a single-seed replay, which reproduces one
  // random iteration and must not drag ten extra runs along.
  let batteryFailures = 0;
  if (!replayOne) {
    const combos: Array<[WitnessSection, LiveWitnessKind, "apply" | "check"]> = [];
    for (const key of WITNESS_SECTIONS) {
      for (const kind of WITNESS_KINDS[key]) {
        combos.push([key, kind, "apply"], [key, kind, "check"]);
      }
    }
    console.log("\nwitness battery (directed live-state witnesses):");
    for (const [index, [key, kind, mode]] of combos.entries()) {
      const seed = iterationSeed(master, 0x100000 + index);
      const result = await witnessIteration(seed, key, kind, mode);
      recordCoverage(result.coverage);
      if (result.ok) {
        if (result.artifactDir) {
          rmSync(result.artifactDir, { recursive: true, force: true });
        }
        console.log(`  ${key}/${kind}/${mode} ok`);
        continue;
      }
      batteryFailures++;
      console.log(`  ${key}/${kind}/${mode} seed ${seed} FAIL: ${result.failure}`);
      // `--iterations 0` runs ZERO random iterations and then the battery, so
      // this command reproduces exactly the failing battery (which derives
      // from the master seed alone) without re-running the random stream.
      console.log(`    replay: bun test/e2e/fuzz.ts --seed ${master} --iterations 0`);
      if (result.artifactDir) {
        console.log(`    artifact: ${result.artifactDir}`);
      }
    }

    // Directed input battery: every catalog case plus every raw pool entry,
    // each run once per soak. Input mode holds 1/8 of the random stream, so a
    // random draw covers a sparse subset of the ~15-case catalog per run;
    // this pass exercises all of it deterministically, and pins that every
    // raw pool string still fails the way its pool promises (a yaml-library
    // upgrade changing parse behavior fails here, not in a nightly surprise).
    console.log("\ninput battery (directed rejection catalog):");
    const inputSpecs: Array<{ name: string; spec: (rng: Rng) => RejectionSpec }> = [
      ...INVALID_SETTINGS_CASES.map(({ name, build }) => ({
        name,
        spec: (rng: Rng): RejectionSpec => {
          const { doc, offendingToken } = build(rng);
          return { label: name, settings: doc, tokens: [offendingToken] };
        },
      })),
      ...UNPARSEABLE_YAML.map((raw, i) => ({
        name: `raw-unparseable-${i}`,
        spec: (): RejectionSpec => ({
          label: `raw-unparseable-${i}`,
          settingsRaw: raw,
          tokens: ["cannot read settings", "valid YAML"],
        }),
      })),
      ...NON_MAPPING_YAML.map((raw, i) => ({
        name: `raw-non-mapping-${i}`,
        spec: (): RejectionSpec => ({
          label: `raw-non-mapping-${i}`,
          settingsRaw: raw,
          tokens: ["must be a YAML mapping"],
        }),
      })),
    ];
    for (const [index, { name, spec }] of inputSpecs.entries()) {
      const seed = iterationSeed(master, 0x200000 + index);
      // Alternate the run mode by index parity, so a mode-specific validation
      // regression (e.g. an early exit only one mode takes) cannot escape the
      // battery. Deterministic: a given entry always runs the same mode.
      const mode = index % 2 === 0 ? ("apply" as const) : ("check" as const);
      const result = await rejectionIteration(seed, { ...spec(new Rng(seed)), mode });
      if (result.ok) {
        if (result.artifactDir) {
          rmSync(result.artifactDir, { recursive: true, force: true });
        }
        console.log(`  ${name} [${mode}] ok`);
        continue;
      }
      batteryFailures++;
      console.log(`  ${name} [${mode}] seed ${seed} FAIL: ${result.failure}`);
      console.log(`    replay: bun test/e2e/fuzz.ts --seed ${master} --iterations 0`);
      if (result.artifactDir) {
        console.log(`    artifact: ${result.artifactDir}`);
      }
    }
  }

  console.log("\ncoverage (sections exercised):");
  for (const key of [...coverage.keys()].sort()) {
    console.log(`  ${key}: ${coverage.get(key)}`);
  }
  // The mutation-class guard: over the whole run (random stream + battery),
  // labels must provably reach an update write, a delete write, and a clean
  // verdict; milestones an update write and a clean verdict (delete is
  // labels-only by design - milestones keep undeclared entries). "create" is
  // tracked in the histogram but not required: it needs absent live state,
  // which the battery deliberately never seeds.
  const REQUIRED_CLASSES: Record<WitnessSection, MutationClass[]> = {
    labels: ["update", "delete", "clean"],
    milestones: ["update", "clean"],
  };
  console.log("\nmutation-class coverage (successful writes from the mock's request log):");
  let coverageFailures = 0;
  for (const key of WITNESS_SECTIONS) {
    const counts = mutationHistogram.get(key) ?? new Map<MutationClass, number>();
    const rendered =
      [...counts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([cls, count]) => `${cls}=${count}`)
        .join(" ") || "(none)";
    console.log(`  ${key}: ${rendered}`);
    if (replayOne) {
      continue;
    }
    const missing = REQUIRED_CLASSES[key].filter((cls) => !counts.has(cls));
    if (missing.length > 0) {
      coverageFailures++;
      console.log(
        `  ${key}: MISSING required class(es) ${missing.join(", ")} - the witness generator or the engine stopped producing real mutations`,
      );
    }
  }

  console.log(`\n${flags.iterations - failures}/${flags.iterations} iterations ok`);
  if (batteryFailures > 0) {
    console.log(`directed battery failures (witness + input): ${batteryFailures}`);
  }
  if (failingSeeds.length > 0) {
    console.log(`failing seeds: ${failingSeeds.join(", ")}`);
    console.log(
      "replay one with the per-failure `replay:` line above (it carries --sections when set)",
    );
  }
  return failures + batteryFailures + coverageFailures > 0 ? 1 : 0;
}

try {
  process.exit(await main());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
