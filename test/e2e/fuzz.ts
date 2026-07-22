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

import type { SectionKey } from "../../src/schema.js";
import { genDiscoveryScenario, genMultiScenario, genScenario } from "./generators.js";
import { predictDiscovery, predictMulti, predictOutcomes } from "./oracle.js";
import { Rng } from "./prng.js";
import { parseReposResult, parseSummaryOutcomes, runScenario } from "./runner.js";
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

/** The master seed: flag, else FUZZ_SEED env, else a crypto-random 32-bit value. */
function masterSeed(flags: Flags): number {
  if (flags.seed !== undefined && Number.isFinite(flags.seed)) {
    return flags.seed >>> 0;
  }
  const env = Number(process.env.FUZZ_SEED ?? "");
  if (Number.isFinite(env) && env !== 0) {
    return env >>> 0;
  }
  return crypto.getRandomValues(new Uint32Array(1))[0] as number;
}

interface IterationResult {
  ok: boolean;
  failure?: string;
  artifactDir?: string;
  sections: SectionKey[];
}

/**
 * Run one standard (single-repo) iteration: generate, predict, execute, and
 * check the observed outcome against the oracle's allowed classes. A run that
 * is fully granted also asserts convergence (the runner's converges machinery).
 */
async function standardIteration(
  seed: number,
  opts: { sections?: SectionKey[] },
): Promise<IterationResult> {
  const { scenario, meta } = genScenario(new Rng(seed), opts);
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
  };
}

/**
 * Input fuzz: feed the action a settings file the validator must reject, and
 * assert it fails (exit 1) with an error naming the offending section BEFORE
 * making any API call. The zero-request assertion is the point: a validation
 * error must be caught at parse time, never after touching the repo.
 */
async function inputFuzzIteration(seed: number): Promise<IterationResult> {
  const rng = new Rng(seed);
  // A labels section whose value is a mapping, not the required array, is a
  // hard validation error the action names.
  const scenario: Scenario = {
    name: `fuzz-input-${seed}`,
    tiers: ["mock"],
    settings: { labels: { not: "an array" } },
    inputs: { mode: rng.pick(["apply", "check"]) },
    denial_style: "fine_grained",
    owner_kind: "org",
    expect: { exit_code: 1, stdout_contains: ["labels"] },
  };
  const report = await runScenario(scenario);
  const problems = report.ok ? [] : [...report.failures];
  // The validation error must fire before any API contact: zero requests
  // reached the mock.
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
    failure: problems.length > 0 ? problems.join("; ") : undefined,
    artifactDir: report.artifactDir,
    sections: [],
  };
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
  const results = parseReposResult(report.outputs["repos-result"]);
  for (const repo of prediction.repos) {
    const got = results[repo.slug];
    if (got === undefined) {
      problems.push(
        `${repo.slug}: predicted {${[...repo.allowedResults].join(",")}} but the repo is absent from repos-result`,
      );
      continue;
    }
    if (!repo.allowedResults.has(got)) {
      problems.push(
        `${repo.slug}: result "${got}" not in predicted {${[...repo.allowedResults].join(",")}}`,
      );
    }
  }
  // No unexpected repos in the output either: every reported slug must be one
  // the oracle predicted (a stray target is as much a bug as a missing one).
  const predictedSlugs = new Set(prediction.repos.map((r) => r.slug));
  for (const slug of Object.keys(results)) {
    if (!predictedSlugs.has(slug)) {
      problems.push(`${slug}: reported in repos-result but not predicted`);
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
 * Discovery fuzz: generate a `repos: "*"` scenario with a random pool and random
 * filters, predict the kept slug set with the INDEPENDENT predictDiscovery, and
 * assert the action discovered and processed exactly those repos (the
 * repos-result keys equal the predicted kept set). This exercises the discovery
 * filter chain end to end and cross-checks the oracle's glob mirror against the
 * engine's live filtering.
 */
async function discoveryFuzzIteration(seed: number): Promise<IterationResult> {
  const { scenario, meta } = genDiscoveryScenario(new Rng(seed));
  const kept = new Set(predictDiscovery(meta.pool, meta.filters));
  // Zero surviving repos is a fatal configuration error for the action (there
  // is nothing to apply against), so the exit prediction follows the kept set.
  // The runner's own exit-code check enforces it; no failure is filtered here.
  scenario.expect = { exit_code: kept.size === 0 ? 1 : 0 };

  const report = await runScenario(scenario);
  const problems: string[] = [...report.failures];
  const results = parseReposResult(report.outputs["repos-result"]);
  const got = new Set(Object.keys(results));
  for (const slug of kept) {
    if (!got.has(slug)) {
      problems.push(`discovery kept ${slug} but it is absent from repos-result`);
    }
  }
  for (const slug of got) {
    if (!kept.has(slug)) {
      problems.push(`discovery processed ${slug} but it was filtered out by the oracle`);
    }
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
  const master = masterSeed(flags);
  // Replay convenience: `--seed <iterSeed> --iterations 1` runs that exact
  // iteration seed, so a failing iteration reproduces directly from its
  // printed seed. Otherwise the per-iteration seed is hash(master, i).
  const replayOne = flags.iterations === 1 && flags.seed !== undefined;
  console.log(`fuzz master seed: ${master} (replay: --seed ${master})`);
  console.log(`iterations: ${flags.iterations}`);

  const coverage = new Map<SectionKey, number>();
  const failingSeeds: number[] = [];
  let failures = 0;

  for (let i = 0; i < flags.iterations; i++) {
    const seed = replayOne ? (flags.seed as number) : iterationSeed(master, i);
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
      console.log(`  iter ${i} [${mode}] seed ${seed} ok`);
    }
  }

  console.log("\ncoverage (sections exercised):");
  for (const key of [...coverage.keys()].sort()) {
    console.log(`  ${key}: ${coverage.get(key)}`);
  }
  console.log(`\n${flags.iterations - failures}/${flags.iterations} iterations ok`);
  if (failingSeeds.length > 0) {
    console.log(`failing seeds: ${failingSeeds.join(", ")}`);
    console.log(
      "replay one with the per-failure `replay:` line above (it carries --sections when set)",
    );
  }
  return failures > 0 ? 1 : 0;
}

try {
  process.exit(await main());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
