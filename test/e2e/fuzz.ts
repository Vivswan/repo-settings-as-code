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
  type FaultableSection,
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
  type MultiScenarioMeta,
  NON_MAPPING_YAML,
  presenceLiveState,
  type ScenarioMeta,
  SECTION_PRIMARY_READ,
  UNPARSEABLE_YAML,
  validateAgainstPublishedSchema,
  WITNESS_KINDS,
  WITNESS_SECTIONS,
  type WitnessSection,
} from "./generators.js";
import type { LoggedRequest } from "./mock/routes.js";
import {
  foldRepoResults,
  foldSectionOutcomes,
  predictDiscovery,
  predictMulti,
  predictOutcomes,
} from "./oracle.js";
import { Rng } from "./prng.js";
import {
  checkLeaks,
  deliveredIssueBody,
  E2E_TOKEN,
  parseReposResult,
  parseSummaryOutcomes,
  type RerunCapture,
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
  /** The fired fault's endpoint kind/verdict label, for the fault-class histogram. */
  faultClass?: string;
  /** The fixpoint re-run proof this iteration armed, for the stats counts. */
  proof?: "apply_idempotent" | "converges";
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
 * The token-leak invariant every iteration asserts: the runner's inert
 * INPUT_TOKEN (E2E_TOKEN, the same constant childEnv feeds the action) must
 * appear on NO public surface - summary, stdout, stderr (mask lines
 * stripped), or any output - of the PRIMARY invocation or any internal
 * re-run (second apply, convergence check, idempotence check; per-invocation
 * delta captures). The token is never add-mask'd, so any echo is a real
 * leak. The reruns sweep is unconditional: the array is empty when no re-run
 * was armed, and coverage holds if a future mode arms one.
 */
function assertNoTokenLeak(
  report: {
    summary: string;
    stdout: string;
    stderr: string;
    outputs: Record<string, string>;
    reruns: RerunCapture[];
  },
  problems: string[],
): void {
  problems.push(...checkLeaks(report, [E2E_TOKEN]));
  for (const rerun of report.reruns) {
    problems.push(...checkLeaks(rerun, [E2E_TOKEN]).map((f) => `${rerun.label}: ${f}`));
  }
}

/**
 * Structural validity of the summary's section table: a header row, a
 * separator row, and data rows that all carry the SAME cell-separator count,
 * with at least `expectedRows` data rows. The engine escapes cells with
 * backslash-then-pipe (summary.ts summaryCell), so a pipe is a real delimiter
 * only after an EVEN run of backslashes - under HOSTILE_NAMES a broken escape
 * changes a row's separator count, the regression class nothing else watches.
 */
function summaryTableProblems(summary: string, expectedRows: number): string[] {
  const lines = summary.split("\n").map((line) => line.trim());
  const start = lines.findIndex((line) => line.startsWith("|"));
  if (start === -1) {
    // A completed run always renders at least the header and separator, even
    // with zero data rows - absence is an error regardless of expectedRows.
    return ["summary carries no markdown table"];
  }
  const table: string[] = [];
  for (let i = start; i < lines.length && lines[i]?.startsWith("|"); i++) {
    table.push(lines[i] as string);
  }
  const separators = (row: string): number => {
    let count = 0;
    let backslashes = 0;
    for (const ch of row) {
      if (ch === "\\") {
        backslashes++;
        continue;
      }
      if (ch === "|" && backslashes % 2 === 0) {
        count++;
      }
      backslashes = 0;
    }
    return count;
  };
  const problems: string[] = [];
  if (table.length < 2 + expectedRows) {
    problems.push(
      `summary table has ${table.length} row(s), expected a header + separator + at least ${expectedRows} data row(s)`,
    );
  }
  // Every separator cell must be a dash run with optional alignment colons -
  // the loose "any of -:| whitespace" form would accept empty cells.
  const separatorCells = (table[1] ?? "").split("|").slice(1, -1);
  if (separatorCells.length === 0 || !separatorCells.every((cell) => /^\s*:?-+:?\s*$/.test(cell))) {
    problems.push(`summary table separator row is malformed: "${table[1] ?? "(absent)"}"`);
  }
  const headerCount = separators(table[0] ?? "");
  for (const [index, row] of table.entries()) {
    if (separators(row) !== headerCount) {
      problems.push(
        `summary table row ${index} has ${separators(row)} cell separator(s), the header has ${headerCount} - a broken pipe escape?`,
      );
      break;
    }
  }
  return problems;
}

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
 * The non-vacuity check every fault-carrying iteration shares: the injected
 * fault must have actually FIRED, or the iteration proved nothing about fault
 * handling. faultsFired snapshots the PRIMARY invocation only - a fault that
 * would first fire during a converges/idempotence re-run deliberately reads
 * as NOT fired - which is exactly right here: the injected budget must be
 * consumed by the run whose exit code and outcomes we asserted. Returns
 * whether the fault fired, so callers record the fault-class histogram only
 * for CONFIRMED firings.
 */
function assertFaultFired(
  faultsFired: Record<string, number>,
  key: string,
  problems: string[],
): boolean {
  const fired = (faultsFired[key] ?? 0) >= 1;
  if (!fired) {
    problems.push(`fault on ${key} never fired - the iteration is vacuous`);
  }
  return fired;
}

/**
 * Run one generated single-repo scenario against its oracle prediction: the
 * shared core of the standard random iteration and the directed witness and
 * fault batteries. A fully-granted apply also asserts convergence (the
 * runner's converges machinery); `opts.faultKey` adds the fault-fired
 * non-vacuity check.
 */
async function runPredicted(
  scenario: Scenario,
  meta: ScenarioMeta,
  opts: { faultKey?: string; faultClass?: string } = {},
): Promise<IterationResult> {
  const prediction = predictOutcomes(meta);
  // The runner requires an expect.exit_code; we assert the exit code against
  // the oracle's ALLOWED SET in fuzz.ts instead (a set cannot be expressed as
  // a single expect), so set a placeholder here and filter the runner's own
  // exit-code check out of its failures below. A fully-granted apply is a
  // FIXPOINT: prove it with the runner's apply-idempotence machinery (second
  // apply exit 0, write-quiet compare-before-write sections, byte-identical
  // state, then a clean check run - which subsumes the converges re-run).
  // Fault-carrying iterations keep the lighter converges proof: the
  // idempotence gate requires no injected faults.
  const fixpoint = prediction.fullyGranted && meta.mode === "apply";
  const idempotent = fixpoint && opts.faultKey === undefined;
  scenario.expect = {
    exit_code: 0,
    ...(idempotent ? { apply_idempotent: true } : fixpoint ? { converges: true } : {}),
  };
  const proof: IterationResult["proof"] = idempotent
    ? "apply_idempotent"
    : fixpoint
      ? "converges"
      : undefined;

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
  let faultClass: string | undefined;
  if (opts.faultKey !== undefined) {
    const fired = assertFaultFired(report.faultsFired, opts.faultKey, problems);
    faultClass = fired ? opts.faultClass : undefined;
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
    // SELF-CONSISTENCY: the `result` output must equal the engine's own fold
    // over the section outcomes it just reported (foldSectionOutcomes mirrors
    // orchestrate.ts's rollup). Guarded by preflightAborts above: an aborted
    // run reports "failed" with an EMPTY table by design, which the fold
    // cannot reproduce.
    const folded = foldSectionOutcomes(Object.values(observed), meta.mode === "check");
    if (report.outputs.result !== folded) {
      problems.push(
        `self-consistency: result output "${report.outputs.result}" != "${folded}" folded from the summary outcomes`,
      );
    }
    // The summary's section table must be structurally valid markdown: under
    // HOSTILE_NAMES a broken pipe escape breaks a row's cell count.
    problems.push(...summaryTableProblems(report.summary, prediction.sections.length));
  }
  assertNoTokenLeak(report, problems);

  return {
    ok: problems.length === 0,
    failure: problems.length > 0 ? problems.join("; ") : undefined,
    artifactDir: report.artifactDir,
    sections: meta.sections,
    coverage: witnessCoverage(report.requests, meta, observed),
    faultClass,
    proof,
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
  assertNoTokenLeak(report, problems);
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
  assertNoTokenLeak(report, problems);
  return {
    ok: problems.length === 0,
    failure: problems.length > 0 ? `[single ${mode}] ${problems.join("; ")}` : undefined,
    artifactDir: report.artifactDir,
    sections: ["labels"],
    // The scenario armed converges above; label it so the fixpoint-proof
    // stats count this real convergence proof instead of printing "(none)".
    proof: "converges",
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
  assertNoTokenLeak(report, problems);
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
  return runMultiPredicted(scenario, meta);
}

/**
 * Options steering a multi-repo run's assertions when a fault rides along:
 * `faultKey` adds the fault-fired non-vacuity check; `reportFaultDegrades`
 * replaces the report-body positive assertion with the degrade contract (the
 * safe warning fires, no issue is ever written, target results unchanged).
 */
interface MultiRunOptions {
  faultKey?: string;
  /** Histogram label recorded only when the fault provably fired. */
  faultClass?: string;
  reportFaultDegrades?: boolean;
}

/**
 * The scenario-shape half of the multi apply-idempotence gate, shared by the
 * random-stream gate (runMultiPredicted) and the fixpoint battery draw
 * (multiIdempotenceBatteryRun) so the two CANNOT diverge - one predicate, not
 * two copies with an equivalence assertion. Conditions: apply mode; a channel
 * the runner accepts (the issue channel is rejected: its delivery embeds
 * fresh timestamps and the marker-label injection ties the labels declaration
 * to the channel); no raw-invalid target (its exit 1 would fail the
 * second-apply-exit-0 property); and every normal target's mask EMPTY.
 * Empty-mask is deliberately NARROWER than true fully-granted (a mask
 * explicitly granting write everywhere would also qualify but is excluded):
 * genMultiScenario's masks are sparse random rolls, so the loss is negligible
 * and the check stays obviously sound. Fully granted is REQUIRED, not merely
 * convenient - secondApplyWriteFailures counts REQUESTS to
 * compare-before-write sections, and a warn-policy denied write would be
 * re-attempted identically in the second apply, failing the write-quiet
 * property even though nothing mutates.
 */
function multiIdempotenceEligible(meta: MultiScenarioMeta): boolean {
  return (
    meta.mode === "apply" &&
    meta.privateReport !== "issue" &&
    meta.repos.every((r) => r.target.kind !== "raw-invalid") &&
    meta.repos.every(
      (r) => r.target.kind !== "normal" || Object.keys(r.target.meta.mask).length === 0,
    )
  );
}

/**
 * The shared eligibility for the discovery convergence proof: a non-empty
 * predicted kept set (an empty one is a configuration error that exits 1 by
 * design). One predicate for both the runDiscoveryPredicted gate and the
 * fixpoint battery draw, same non-divergence reasoning as
 * multiIdempotenceEligible.
 */
function discoveryConvergeEligible(meta: ReturnType<typeof genDiscoveryScenario>["meta"]): boolean {
  return predictDiscovery(meta.pool, meta.filters).length > 0;
}

/** The shared multi-repo run + assertion core (see multiRepoFuzzIteration). */
async function runMultiPredicted(
  scenario: Scenario,
  meta: MultiScenarioMeta,
  opts: MultiRunOptions = {},
): Promise<IterationResult> {
  const prediction = predictMulti(meta);
  // Apply-idempotence gate: an ELIGIBLE scenario (multiIdempotenceEligible -
  // the single predicate the fixpoint battery draw shares, so gate and draw
  // cannot diverge) with no injected fault is a fixpoint the runner can prove
  // (second apply exit 0, write-quiet compare-before-write sections,
  // byte-identical state, clean final check). Belt: the oracle must predict
  // exit 0 exactly - if the belt ever blocks an eligible draw, the battery's
  // proof tripwire fails loudly instead of passing vacuously.
  const idempotent =
    multiIdempotenceEligible(meta) &&
    opts.faultKey === undefined &&
    meta.coreFault === undefined &&
    prediction.allowedExitCodes.size === 1 &&
    prediction.allowedExitCodes.has(0);
  scenario.expect = { exit_code: 0, ...(idempotent ? { apply_idempotent: true } : {}) };

  const report = await runScenario(scenario);
  const problems: string[] = [];
  let faultClass: string | undefined;
  if (opts.faultKey !== undefined) {
    const fired = assertFaultFired(report.faultsFired, opts.faultKey, problems);
    faultClass = fired ? opts.faultClass : undefined;
  }
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
        // Drop injected faults too: the counterfactual proves CANARY FLOW, and
        // an exhausting fault could kill the very target whose canary must
        // surface, falsely reading as vacuous.
        faults: undefined,
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
      // The counterfactual is a ScenarioReport of its own: the token-leak
      // invariant covers it too.
      assertNoTokenLeak(shown, problems);
    }
  }

  // REPORT-BODY POSITIVE ASSERTION (the plan's canary-in-report check): under
  // private-report: issue, a redacted target whose report DELIVERS (Issues
  // granted and its settings readable) must carry its canaries in ITS OWN report
  // issue body - the one private channel where the full detail legitimately
  // lands. The forced-private target is fully granted, so its report always
  // delivers; assert its canaries reached the recorded issue body. This proves
  // suppression did not eat the report. Under an injected report-route fault
  // (reportFaultDegrades) the contract flips: delivery must DEGRADE to the safe
  // warning - no issue is ever created or patched, the warning fires at least
  // once (the forced-private target always attempts delivery), and target
  // results stay whatever the oracle predicted (a report failure never fails
  // the run).
  if (meta.privateReport === "issue" && opts.reportFaultDegrades === true) {
    const issueWrites = report.requests.filter(
      (r) => r.method !== "GET" && /\/issues(\/|$|\?)/.test(r.pathname),
    );
    if (issueWrites.length > 0) {
      const sample = issueWrites.map((r) => `${r.method} ${r.pathname}`).join(", ");
      problems.push(`report fault: issue writes happened despite the faulted lookup: ${sample}`);
    }
    const degradeWarnings = report.stdout
      .split("\n")
      .filter((line) => line.includes("could not deliver the private report")).length;
    if (degradeWarnings < 1) {
      problems.push(
        "report fault: no safe degrade warning fired despite a delivering target attempting the report",
      );
    }
  } else if (meta.privateReport === "issue") {
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

  // SELF-CONSISTENCY: the `result` output must equal the engine's worst-of
  // fold over the per-target results it just emitted (foldRepoResults mirrors
  // orchestrate's REPO_RESULTS order). Folded from repos-result VALUES, not
  // summary rows - a multi summary repeats section keys per target, which
  // parseSummaryOutcomes would overwrite. Guarded on a non-empty repos-result:
  // a config-fatal run emits none by design.
  if (Object.keys(report.reposResult).length > 0) {
    const folded = foldRepoResults(Object.values(report.reposResult), meta.mode === "check");
    if (report.outputs.result !== folded) {
      problems.push(
        `self-consistency: result output "${report.outputs.result}" != "${folded}" folded from repos-result`,
      );
    }
  }
  assertNoTokenLeak(report, problems);

  return {
    ok: problems.length === 0,
    failure: problems.length > 0 ? problems.join("; ") : undefined,
    artifactDir: report.artifactDir,
    sections: [],
    faultClass,
    proof: idempotent ? "apply_idempotent" : undefined,
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
  return runDiscoveryPredicted(scenario, meta);
}

/** The shared discovery run + assertion core (see discoveryFuzzIteration). */
async function runDiscoveryPredicted(
  scenario: Scenario,
  meta: ReturnType<typeof genDiscoveryScenario>["meta"],
  opts: { faultKey?: string; faultClass?: string } = {},
): Promise<IterationResult> {
  const kept = predictDiscovery(meta.pool, meta.filters);
  // Zero surviving repos is a fatal configuration error for the action (there
  // is nothing to apply against), so the exit prediction follows the kept set.
  // The runner's own exit-code check enforces it; no failure is filtered here.
  // A non-empty kept set is an APPLY over fully-granted labels (the discovery
  // scenario pins issues: write / contents: read), so the check re-run must
  // converge - unless a fault rides along and may legitimately perturb it.
  const converges = discoveryConvergeEligible(meta) && opts.faultKey === undefined;
  scenario.expect = {
    exit_code: kept.length === 0 ? 1 : 0,
    ...(converges ? { converges: true } : {}),
  };

  const report = await runScenario(scenario);
  const problems: string[] = [...report.failures];
  let faultClass: string | undefined;
  if (opts.faultKey !== undefined) {
    const fired = assertFaultFired(report.faultsFired, opts.faultKey, problems);
    faultClass = fired ? opts.faultClass : undefined;
  }
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
    // Non-vacuity guard, mirroring the multi one: the generator forces one
    // non-public pool repo, so an empty forbidden set here is a generator
    // regression that would let the leak check pass without checking anything.
    if (forbidden.length === 0) {
      problems.push(
        "redact discovery run produced an empty forbidden set - the leak check would be vacuous",
      );
    }
    problems.push(...checkLeaks(report, forbidden));
  }
  // SELF-CONSISTENCY: discovery runs are multi-shaped, so the same worst-of
  // fold over repos-result applies (discovery is always apply mode). Guarded
  // on a non-empty repos-result: the kept-empty configuration error and the
  // discovery-fatal fault path emit none by design.
  if (Object.keys(report.reposResult).length > 0) {
    const folded = foldRepoResults(Object.values(report.reposResult), false);
    if (report.outputs.result !== folded) {
      problems.push(
        `self-consistency: result output "${report.outputs.result}" != "${folded}" folded from repos-result`,
      );
    }
  }
  assertNoTokenLeak(report, problems);
  return {
    ok: problems.length === 0,
    failure:
      problems.length > 0
        ? `filters ${JSON.stringify(meta.filters)}: ${problems.join("; ")}`
        : undefined,
    artifactDir: report.artifactDir,
    sections: [],
    faultClass,
    proof: converges ? "converges" : undefined,
  };
}

// --- Transport-fault fuzz ---------------------------------------------------

/** The four transport fault kinds the mock injects (see FaultOption). */
const FAULT_KINDS = ["rate_limit_403", "429_then_200", "connection_drop", "server_error"] as const;
type FaultKind = (typeof FAULT_KINDS)[number];

/**
 * One full round of client attempts: the first request plus MAX_RETRIES
 * retries (src/github/api.ts). A fault budget of RETRY_BUDGET outlasts the
 * retries and surfaces as a failure; a budget of 1 is a transient the retry
 * plugin absorbs (for the kinds it retries at all - see faultKills).
 */
const RETRY_BUDGET = 3;

/**
 * The histogram label for one fired fault, keyed by ENDPOINT so per-endpoint
 * starvation is visible, and classed by the VERDICT (fatal vs transient), not
 * the raw budget - a one-shot rate_limit_403 is fatal, so labeling it
 * "transient" would contradict the modeled fact.
 */
function faultClassLabel(key: string, kind: FaultKind, fatal: boolean): string {
  return `${key} ${kind}/${fatal ? "fatal" : "transient"}`;
}

/**
 * Whether a fault takes the FAILURE path - the modeled VERDICT, distinct from
 * the `exhausting` budget roll. An exhausting budget (RETRY_BUDGET firings)
 * always kills; rate_limit_403 kills on its FIRST firing regardless of
 * budget, because the client deliberately never absorbs a primary rate limit
 * - its reset typically lies far beyond MAX_RETRY_WAIT_S, so throttleCallback
 * (src/github/api.ts) surfaces it immediately with re-run advice instead of
 * stalling the job. The "transient" class does not exist for that kind.
 */
function faultKills(kind: FaultKind, exhausting: boolean): boolean {
  return exhausting || kind === "rate_limit_403";
}

/** The full plan for one section-read fault run (random stream or battery). */
interface SectionFaultPlan {
  section: FaultableSection;
  key: string;
  kind: FaultKind;
  exhausting: boolean;
  mode: "apply" | "check";
}

/**
 * Section-read fault fuzz: aim one transport fault at a section's guaranteed
 * primary read (SECTION_PRIMARY_READ). A transient fault (times 1) must be
 * retried away, leaving the run indistinguishable from a healthy one; an
 * exhausting fault (times 3 = 1 + MAX_RETRIES) must fail the section loudly.
 */
async function sectionFaultIteration(seed: number): Promise<IterationResult> {
  const rng = new Rng(seed);
  const section = rng.pick(Object.keys(SECTION_PRIMARY_READ) as FaultableSection[]);
  return faultedSectionRun(seed, {
    section,
    key: SECTION_PRIMARY_READ[section],
    kind: rng.pick([...FAULT_KINDS]),
    exhausting: rng.bool(),
    mode: rng.pick(["apply", "check"] as const),
  });
}

/** Build and run one section-fault scenario per the plan. */
async function faultedSectionRun(seed: number, plan: SectionFaultPlan): Promise<IterationResult> {
  const rng = new Rng(seed).fork("fault-scenario");
  const settings: Record<string, unknown> = {
    [plan.section]: genSettings(rng.fork("settings"), plan.section),
  };
  const liveKinds: NonNullable<ScenarioMeta["liveKinds"]> = {};
  // Presence live state first (a declared workflow whose file is absent would
  // permanently drift the converge re-run), witness state merged over it.
  const combinedLive: LiveWitness["state"] = { ...(presenceLiveState(settings) ?? {}) };
  if (plan.section === "labels" || plan.section === "milestones") {
    // A matching witness pins the no-fault prediction exactly (clean/applied),
    // so a transient fault must leave the run INDISTINGUISHABLE from a healthy
    // one - the strongest form of "retried away".
    const witness = genLiveWitness(
      rng.fork("witness"),
      plan.section,
      settings[plan.section],
      "matching",
    );
    liveKinds[plan.section] = witness.kind;
    Object.assign(combinedLive, witness.state);
  }
  const liveState = Object.keys(combinedLive).length > 0 ? combinedLive : undefined;
  const meta: ScenarioMeta = {
    sections: [plan.section],
    mask: {},
    mode: plan.mode,
    // Policy pinned to warn in the RANDOM stream (oracle generality); the
    // apply + fail preflight-budget interaction is pinned by the directed
    // preflight battery cases (preflightFaultRun).
    policy: "warn",
    ownerKind: "org",
    denialStyle: "fine_grained",
    requiredSections: [],
    liveKinds,
  };
  const scenario: Scenario = {
    name: `fuzz-fault-${plan.section}-${plan.kind}-x${plan.exhausting ? RETRY_BUDGET : 1}-${seed}`,
    tiers: ["mock"],
    settings,
    inputs: { mode: plan.mode, on_missing_permission: "warn" },
    denial_style: "fine_grained",
    owner_kind: "org",
    ...(liveState ? { live_state: liveState } : {}),
    faults: [{ endpoint: plan.key, kind: plan.kind, times: plan.exhausting ? RETRY_BUDGET : 1 }],
    expect: { exit_code: 0 },
  };
  const label = faultClassLabel(plan.key, plan.kind, faultKills(plan.kind, plan.exhausting));
  return faultKills(plan.kind, plan.exhausting)
    ? exhaustedSectionRun(scenario, plan.section, plan.key, label)
    : runPredicted(scenario, meta, { faultKey: plan.key, faultClass: label });
}

/**
 * The exhausting-fault contract for a single declared section: the run fails
 * (exit 1) with the section reported "failed" and an actionable error naming
 * it, no unhandled stack in stderr, and the fault provably fired.
 */
async function exhaustedSectionRun(
  scenario: Scenario,
  section: FaultableSection,
  faultKey: string,
  faultClass: string,
): Promise<IterationResult> {
  scenario.expect = { exit_code: 1 };
  const report = await runScenario(scenario);
  const problems = report.ok ? [] : [...report.failures];
  const fired = assertFaultFired(report.faultsFired, faultKey, problems);
  const observed = parseSummaryOutcomes(report.summary);
  if (observed[section] !== "failed") {
    problems.push(
      `${section}: observed "${observed[section] ?? "(absent)"}" under an exhausted fault, expected failed`,
    );
  }
  if (!new RegExp(`::error::[^\\n]*${section}`).test(report.stdout)) {
    problems.push(`no actionable error naming the ${section} section`);
  }
  if (/\n\s+at\s+\S+ \(/.test(report.stderr)) {
    problems.push("unhandled stack in stderr under an exhausted fault");
  }
  assertNoTokenLeak(report, problems);
  return {
    ok: problems.length === 0,
    failure: problems.length > 0 ? `[fault ${faultKey}] ${problems.join("; ")}` : undefined,
    artifactDir: report.artifactDir,
    sections: [section],
    faultClass: fired ? faultClass : undefined,
  };
}

/**
 * Multi core-path fault fuzz: aim a fault at core.contentsGet, the settings
 * fetch every target makes. An exhausting budget is eaten whole by the FIRST
 * target in generation order (fetch + retries), which then fails outright
 * (predictMulti's coreFault override); a transient one is retried away and
 * every prediction stands. Falls back to a plain multi iteration when the
 * first target is the raw-invalid one (its parse-gate wording assertion must
 * stay unconditional) or a redacted canary carrier (its report delivery and
 * counterfactual flow must stay guaranteed) - the same disjointness pattern
 * raw targets already use.
 */
async function multiContentsFaultIteration(seed: number): Promise<IterationResult> {
  const { scenario, meta } = genMultiScenario(new Rng(seed));
  const victim = meta.repos[0];
  if (victim === undefined || victim.target.kind === "raw-invalid" || victim.canaries.length > 0) {
    return runMultiPredicted(scenario, meta);
  }
  const roll = new Rng(seed ^ 0x51ed2701);
  const kind = roll.pick([...FAULT_KINDS]);
  const exhausting = roll.bool();
  const fatal = faultKills(kind, exhausting);
  // rate_limit_403 kills the fetch on its FIRST firing, so a full budget
  // would spill the remaining firings into the NEXT targets' fetches and fail
  // them too - beyond the oracle's single-victim model. One firing is exactly
  // one dead target for that kind; retried kinds need the full RETRY_BUDGET
  // to exhaust.
  const times = kind === "rate_limit_403" ? 1 : exhausting ? RETRY_BUDGET : 1;
  scenario.faults = [{ endpoint: "core.contentsGet", kind, times }];
  meta.coreFault = { key: "core.contentsGet", fatal };
  return runMultiPredicted(scenario, meta, {
    faultKey: "core.contentsGet",
    faultClass: faultClassLabel("core.contentsGet", kind, fatal),
  });
}

/**
 * Discovery core-path fault fuzz: fault the /user/repos listing itself. A
 * transient is absorbed by the retry and the normal discovery assertions
 * hold. An exhausting fault is FATAL: the run exits 1 before any target
 * executes - no pool repo is fetched and no repos-result is emitted (a silent
 * empty pool instead of a loud failure is exactly the bug this hunts).
 */
async function discoveryFaultIteration(seed: number): Promise<IterationResult> {
  const { scenario, meta } = genDiscoveryScenario(new Rng(seed));
  const roll = new Rng(seed ^ 0x2545f491);
  const kind = roll.pick([...FAULT_KINDS]);
  const exhausting = roll.bool();
  const fatal = faultKills(kind, exhausting);
  scenario.faults = [
    { endpoint: "core.discoveryList", kind, times: exhausting ? RETRY_BUDGET : 1 },
  ];
  const faultClass = faultClassLabel("core.discoveryList", kind, fatal);
  if (!fatal) {
    return runDiscoveryPredicted(scenario, meta, {
      faultKey: "core.discoveryList",
      faultClass,
    });
  }
  return fatalDiscoveryRun(scenario, meta, faultClass);
}

/**
 * The discovery-fatal contract, shared by the random stream and the battery:
 * the run exits 1 before any target executes - no pool repo is fetched and
 * repos-result is never EMITTED (parseReposResult would map absent,
 * malformed, and {} to the same empty object, hiding a stray emit).
 */
async function fatalDiscoveryRun(
  scenario: Scenario,
  meta: ReturnType<typeof genDiscoveryScenario>["meta"],
  faultClass: string,
): Promise<IterationResult> {
  scenario.expect = { exit_code: 1 };
  const report = await runScenario(scenario);
  const problems = report.ok ? [] : [...report.failures];
  const fired = assertFaultFired(report.faultsFired, "core.discoveryList", problems);
  const touched = report.requests.filter((r) =>
    meta.pool.some((p) => r.pathname.startsWith(`/repos/${p.slug}`)),
  );
  if (touched.length > 0) {
    problems.push(
      `discovery-fatal: ${touched.length} target request(s) after the failed listing, e.g. ${touched[0]?.method} ${touched[0]?.pathname}`,
    );
  }
  if (report.outputs["repos-result"] !== undefined) {
    problems.push(
      `discovery-fatal: repos-result was emitted (${report.outputs["repos-result"]}), expected no output at all`,
    );
  }
  assertNoTokenLeak(report, problems);
  return {
    ok: problems.length === 0,
    failure: problems.length > 0 ? `[fault core.discoveryList] ${problems.join("; ")}` : undefined,
    artifactDir: report.artifactDir,
    sections: [],
    faultClass: fired ? faultClass : undefined,
  };
}

/** Battery entry: the discovery-fatal contract with a pinned kind and budget. */
function discoveryFaultBatteryRun(seed: number): Promise<IterationResult> {
  const { scenario, meta } = genDiscoveryScenario(new Rng(seed));
  scenario.faults = [{ endpoint: "core.discoveryList", kind: "server_error", times: RETRY_BUDGET }];
  return fatalDiscoveryRun(
    scenario,
    meta,
    faultClassLabel("core.discoveryList", "server_error", true),
  );
}

/**
 * Battery entries pinning the apply + fail-policy PREFLIGHT interaction the
 * random stream deliberately avoids (its policy stays warn for oracle
 * generality). The preflight barrier re-runs every section read first and
 * IGNORES non-permission errors (orchestrate.ts), so the probe consumes fault
 * budget:
 * - budget = RETRY_BUDGET: the probe's read burns the whole budget, the
 *   apply-pass read then succeeds - the run must land applied, exit 0.
 * - budget = 2 x RETRY_BUDGET: the budget survives preflight, the apply-pass
 *   read dies too - the section must fail loudly, exit 1.
 */
async function preflightFaultRun(seed: number, surviving: boolean): Promise<IterationResult> {
  const rng = new Rng(seed).fork("preflight");
  const settings: Record<string, unknown> = { labels: genSettings(rng.fork("settings"), "labels") };
  const witness = genLiveWitness(rng.fork("witness"), "labels", settings.labels, "matching");
  const times = surviving ? 2 * RETRY_BUDGET : RETRY_BUDGET;
  const scenario: Scenario = {
    name: `fuzz-preflight-fault-${surviving ? "survives" : "consumed"}-${seed}`,
    tiers: ["mock"],
    settings,
    inputs: { mode: "apply", on_missing_permission: "fail" },
    denial_style: "fine_grained",
    owner_kind: "org",
    live_state: witness.state,
    faults: [{ endpoint: "labels.list", kind: "server_error", times }],
    expect: { exit_code: surviving ? 1 : 0 },
  };
  const faultClass = faultClassLabel("labels.list", "server_error", surviving);
  if (surviving) {
    return exhaustedSectionRun(scenario, "labels", "labels.list", faultClass);
  }
  const report = await runScenario(scenario);
  const problems = report.ok ? [] : [...report.failures];
  const fired = assertFaultFired(report.faultsFired, "labels.list", problems);
  const observed = parseSummaryOutcomes(report.summary);
  if (observed.labels !== "applied") {
    problems.push(
      `preflight-consumed: labels observed "${observed.labels ?? "(absent)"}", expected applied - the probe should have eaten the budget and the apply read succeeded`,
    );
  }
  assertNoTokenLeak(report, problems);
  return {
    ok: problems.length === 0,
    failure: problems.length > 0 ? `[preflight consumed] ${problems.join("; ")}` : undefined,
    artifactDir: report.artifactDir,
    sections: ["labels"],
    faultClass: fired ? faultClass : undefined,
  };
}

/**
 * Report-route fault fuzz: fault the issue channel's lookup (core.issuesList,
 * which fires for EVERY delivering target - the guaranteed fully-granted
 * forced-private one included) and require the degrade contract: the safe
 * "could not deliver the private report" warning, zero issue writes, and
 * target results exactly as the oracle predicted (a report failure never
 * fails the run). `times: 99` faults every lookup so no target's delivery
 * half-succeeds; the kind is pinned to server_error because the degrade
 * contract is the HTTP-status warning path - other kinds keep riding the
 * section and core iterations. Draws scenarios from deterministic forks until
 * one uses the issue channel (~1/6 per draw), falling back to a plain multi
 * iteration when none rolls within the attempt budget.
 */
async function reportFaultIteration(seed: number): Promise<IterationResult> {
  const drawn = drawIssueChannelScenario(new Rng(seed), 12);
  if (drawn === null) {
    return multiRepoFuzzIteration(seed);
  }
  return injectedReportFaultRun(drawn);
}

/** Deterministic forked draws until one scenario uses the issue channel. */
function drawIssueChannelScenario(
  base: Rng,
  attempts: number,
): { scenario: Scenario; meta: MultiScenarioMeta } | null {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const drawn = genMultiScenario(base.fork(`report:${attempt}`));
    if (drawn.meta.privateReport === "issue") {
      return drawn;
    }
  }
  return null;
}

/** Inject the issue-lookup fault and run the degrade contract. */
function injectedReportFaultRun(drawn: {
  scenario: Scenario;
  meta: MultiScenarioMeta;
}): Promise<IterationResult> {
  drawn.scenario.faults = [{ endpoint: "core.issuesList", kind: "server_error", times: 99 }];
  return runMultiPredicted(drawn.scenario, drawn.meta, {
    faultKey: "core.issuesList",
    faultClass: faultClassLabel("core.issuesList", "server_error", true),
    reportFaultDegrades: true,
  });
}

/**
 * Directed core-fault battery entries. The random stream reaches the
 * core-path fault iterations only ~1/80 per iteration, so a 30-iteration soak
 * exercises each with only ~25% probability - vacuous coverage the batteries
 * exist to prevent. One entry pins the fatal contentsGet victim rule, one the
 * issue-channel degrade contract. Eligibility is CONSTRUCTED via generator
 * forces - never rejection-sampled, since any fork budget has miss seeds and
 * live CI seeds turn each into a spurious failure; the inline asserts are
 * drift tripwires between each force and its consumer.
 */
async function contentsFaultBatteryRun(seed: number): Promise<IterationResult> {
  // CONSTRUCTED eligibility (no rejection sampling - a fork budget always has
  // miss seeds, and live CI seeds turn every miss into a spurious failure):
  // the "plain-first-target" force keeps the raw target off index 0 and runs
  // under show (no canaries anywhere), so the disjointness guard holds for
  // every master seed by generator structure.
  const { scenario, meta } = genMultiScenario(new Rng(seed), "plain-first-target");
  const victim = meta.repos[0];
  if (victim === undefined || victim.target.kind === "raw-invalid" || victim.canaries.length > 0) {
    return {
      ok: false,
      failure:
        "the plain-first-target force produced an ineligible first target - the force and the victim guard drifted apart",
      sections: [],
    };
  }
  scenario.faults = [{ endpoint: "core.contentsGet", kind: "server_error", times: RETRY_BUDGET }];
  meta.coreFault = { key: "core.contentsGet", fatal: true };
  return runMultiPredicted(scenario, meta, {
    faultKey: "core.contentsGet",
    faultClass: faultClassLabel("core.contentsGet", "server_error", true),
  });
}

function reportFaultBatteryRun(seed: number): Promise<IterationResult> {
  // CONSTRUCTED issue channel: the "issue-report" force pins the channel roll
  // inside generation (seed 8181 proved a 40-fork rejection draw can miss),
  // keeping the deliverable-target and canary invariants intact by
  // construction.
  const drawn = genMultiScenario(new Rng(seed), "issue-report");
  if (drawn.meta.privateReport !== "issue") {
    return Promise.resolve({
      ok: false,
      failure:
        "the issue-report force did not produce an issue-channel scenario - the force and the generator drifted apart",
      sections: [],
    });
  }
  return injectedReportFaultRun(drawn);
}

// --- Fixpoint battery --------------------------------------------------------

/**
 * Directed multi apply-idempotence entry: the random gate (fully granted +
 * apply + non-issue channel + no raw target) fires on only ~5% of multi
 * iterations, so a 30-iteration soak would exercise it with ~30% probability
 * - the same near-vacuity the other batteries exist to prevent. Eligibility
 * is CONSTRUCTED via the generator's "idempotence-eligible" force, never
 * rejection-sampled, so the entry exists for every master seed.
 */
async function multiIdempotenceBatteryRun(seed: number): Promise<IterationResult> {
  // CONSTRUCTED eligibility: the "idempotence-eligible" force pins apply
  // mode, a non-delivering channel, no raw target, and empty masks inside
  // generation, so the entry exists for EVERY master seed (the previous
  // 200-fork rejection draw had miss seeds by construction). The predicate
  // assert below is the drift tripwire between the force and the gate.
  const { scenario, meta } = genMultiScenario(new Rng(seed), "idempotence-eligible");
  if (!multiIdempotenceEligible(meta)) {
    return {
      ok: false,
      failure:
        "the idempotence-eligible force produced an ineligible scenario - the force and multiIdempotenceEligible drifted apart",
      sections: [],
    };
  }
  const result = await runMultiPredicted(scenario, meta);
  if (result.ok && result.proof !== "apply_idempotent") {
    return {
      ...result,
      ok: false,
      failure:
        "an eligible multi scenario did not arm the apply-idempotence gate - the exit-0 belt blocked it, which the shared predicate cannot express; investigate the prediction",
    };
  }
  return result;
}

/**
 * Directed discovery check-convergence entry: a CONSTRUCTED non-empty kept
 * set (the generator's "converges" force), then the apply-then-check
 * convergence proof runDiscoveryPredicted arms for fault-free non-empty runs.
 */
async function discoveryConvergesBatteryRun(seed: number): Promise<IterationResult> {
  // CONSTRUCTED non-empty kept set: the "converges" force pins pool repo 0
  // non-archived with no filters, so the kept set provably contains it -
  // no draw budget, no miss seeds.
  const { scenario, meta } = genDiscoveryScenario(new Rng(seed), "converges");
  if (!discoveryConvergeEligible(meta)) {
    return {
      ok: false,
      failure:
        "the converges force produced an empty kept set - the force and discoveryConvergeEligible drifted apart",
      sections: [],
    };
  }
  const result = await runDiscoveryPredicted(scenario, meta);
  if (result.ok && result.proof !== "converges") {
    return {
      ...result,
      ok: false,
      failure:
        "a non-empty discovery scenario did not arm the converges gate - the battery draw predicate and runDiscoveryPredicted's gate drifted apart",
    };
  }
  return result;
}
/**
 * The fault half of the transport-misbehavior slot: section reads get the
 * bulk of the stream (8 faultable reads x 4 kinds x 2 budgets), and the three
 * core paths - the contents fetch, the discovery listing, and the report
 * delivery - share the rest.
 */
async function faultFuzzIteration(seed: number): Promise<IterationResult> {
  const roll = new Rng(seed ^ 0x7f4a7c15).int(5);
  if (roll === 0) {
    return multiContentsFaultIteration(seed);
  }
  if (roll === 1) {
    return discoveryFaultIteration(seed);
  }
  if (roll === 2) {
    return reportFaultIteration(seed);
  }
  return sectionFaultIteration(seed);
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
  const faultHistogram = new Map<string, number>();
  const recordFaultClass = (cls: string | undefined): void => {
    if (cls !== undefined) {
      faultHistogram.set(cls, (faultHistogram.get(cls) ?? 0) + 1);
    }
  };
  // Random-stream fixpoint-proof counts (mode:proof), so a gate that starves
  // (e.g. multi idempotence at its measured ~5% eligibility) is VISIBLE in
  // every run instead of silently vacuous; the fixpoint battery guarantees
  // each proof once per soak regardless.
  const proofCounts = new Map<string, number>();

  for (let i = 0; i < flags.iterations; i++) {
    const seed = replayOne ? master : iterationSeed(master, i);
    // Mode selection over an 8-way roll: ~1/4 multi-repo (when enabled), 1/8
    // input fuzz, 1/8 transport misbehavior (split 50/50 between response
    // corruption and injected faults), 1/8 discovery, the rest standard
    // single-repo.
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
      if (new Rng(seed ^ 0x1b873593).bool()) {
        mode = "fault";
        result = await faultFuzzIteration(seed);
      } else {
        mode = "chaos";
        result = await chaosFuzzIteration(seed);
      }
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
    recordFaultClass(result.faultClass);
    if (result.proof !== undefined) {
      const key = `${mode}:${result.proof}`;
      proofCounts.set(key, (proofCounts.get(key) ?? 0) + 1);
    }
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

    // Directed fault battery: every fault kind x budget, with the SECTION
    // TARGET rotated across all 8 SECTION_PRIMARY_READ entries by battery
    // index (offset by the master seed, so the kind-to-section pairing varies
    // across soaks while every soak still covers every kind/budget combo AND
    // every faultable endpoint - no endpoint can starve behind a frozen CI
    // seed). Labels/milestones entries get a matching witness (exact
    // predictions); a transient combo must be indistinguishable from a
    // healthy run, a fatal one must fail loudly naming its section. Mode
    // alternates per kind so both modes appear across the battery.
    console.log("\nfault battery (directed transport faults, section rotated):");
    const faultableSections = Object.keys(SECTION_PRIMARY_READ) as FaultableSection[];
    const faultCombos: Array<[FaultKind, boolean]> = [];
    for (const kind of FAULT_KINDS) {
      faultCombos.push([kind, false], [kind, true]);
    }
    for (const [index, [kind, exhausting]] of faultCombos.entries()) {
      const seed = iterationSeed(master, 0x300000 + index);
      const mode = (index >> 1) % 2 === 0 ? ("apply" as const) : ("check" as const);
      const section = faultableSections[
        // codeql[js/biased-cryptographic-random] -- the crypto value is a fuzz seed, not key material; modulo bias is irrelevant to coverage rotation
        (index + (master % faultableSections.length)) % faultableSections.length
      ] as FaultableSection;
      const label = `${section}:${kind}/x${exhausting ? RETRY_BUDGET : 1}`;
      const result = await faultedSectionRun(seed, {
        section,
        key: SECTION_PRIMARY_READ[section],
        kind,
        exhausting,
        mode,
      });
      recordCoverage(result.coverage);
      recordFaultClass(result.faultClass);
      if (result.ok) {
        if (result.artifactDir) {
          rmSync(result.artifactDir, { recursive: true, force: true });
        }
        console.log(`  ${label} [${mode}] ok`);
        continue;
      }
      batteryFailures++;
      console.log(`  ${label} [${mode}] seed ${seed} FAIL: ${result.failure}`);
      console.log(`    replay: bun test/e2e/fuzz.ts --seed ${master} --iterations 0`);
      if (result.artifactDir) {
        console.log(`    artifact: ${result.artifactDir}`);
      }
    }

    // Directed core-fault battery: the contentsGet victim rule and the
    // issue-channel degrade contract, once per soak (see the helpers' doc for
    // why the random stream alone leaves them near-vacuous at 30 iterations).
    console.log("\ncore-fault battery (directed core-path faults):");
    const coreEntries: Array<[string, (seed: number) => Promise<IterationResult>]> = [
      ["core.contentsGet/fatal", contentsFaultBatteryRun],
      ["core.discoveryList/fatal", discoveryFaultBatteryRun],
      ["core.issuesList/degrade", reportFaultBatteryRun],
      ["preflight/budget-consumed", (seed) => preflightFaultRun(seed, false)],
      ["preflight/budget-survives", (seed) => preflightFaultRun(seed, true)],
    ];
    for (const [index, [name, run]] of coreEntries.entries()) {
      const seed = iterationSeed(master, 0x400000 + index);
      const result = await run(seed);
      recordCoverage(result.coverage);
      recordFaultClass(result.faultClass);
      if (result.ok) {
        if (result.artifactDir) {
          rmSync(result.artifactDir, { recursive: true, force: true });
        }
        console.log(`  ${name} ok`);
        continue;
      }
      batteryFailures++;
      console.log(`  ${name} seed ${seed} FAIL: ${result.failure}`);
      console.log(`    replay: bun test/e2e/fuzz.ts --seed ${master} --iterations 0`);
      if (result.artifactDir) {
        console.log(`    artifact: ${result.artifactDir}`);
      }
    }

    // Directed fixpoint battery: one multi apply-idempotence proof and one
    // discovery convergence proof per soak. The standard-mode proof needs no
    // entry - the witness battery's apply combos arm apply_idempotent
    // deterministically already.
    console.log("\nfixpoint battery (directed apply-idempotence / convergence):");
    const fixpointEntries: Array<[string, (seed: number) => Promise<IterationResult>]> = [
      ["multi/apply-idempotent", multiIdempotenceBatteryRun],
      ["discovery/converges", discoveryConvergesBatteryRun],
    ];
    for (const [index, [name, run]] of fixpointEntries.entries()) {
      const seed = iterationSeed(master, 0x500000 + index);
      const result = await run(seed);
      recordCoverage(result.coverage);
      if (result.ok) {
        if (result.artifactDir) {
          rmSync(result.artifactDir, { recursive: true, force: true });
        }
        console.log(`  ${name} ok`);
        continue;
      }
      batteryFailures++;
      console.log(`  ${name} seed ${seed} FAIL: ${result.failure}`);
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

  // Fault classes fired across the run (random stream + battery). The battery
  // guarantees every endpoint x kind x verdict each soak, so a missing class
  // here means a battery failure already counted above; this histogram is the
  // visibility.
  console.log("\nfault-class coverage (endpoint kind/verdict fired):");
  if (faultHistogram.size === 0) {
    console.log("  (none)");
  } else {
    for (const [cls, count] of [...faultHistogram.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      console.log(`  ${cls}: ${count}`);
    }
  }

  // Fixpoint proofs the RANDOM stream armed (the battery adds one multi
  // idempotence + one discovery convergence on top, printed above).
  console.log("\nfixpoint-proof coverage (random stream, mode:proof):");
  if (proofCounts.size === 0) {
    console.log("  (none)");
  } else {
    for (const [key, count] of [...proofCounts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`  ${key}: ${count}`);
    }
  }

  console.log(`\n${flags.iterations - failures}/${flags.iterations} iterations ok`);
  if (batteryFailures > 0) {
    console.log(
      `directed battery failures (witness + input + fault + fixpoint): ${batteryFailures}`,
    );
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
