/**
 * Workflow contract for the fetched, gitignored test artifacts: one composite owns both caches
 * and miss-gated fetches, no workflow caches one inline, every loading job runs the composite
 * first, and the drift-tripwire nightlies fetch the spec fresh instead.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  reverseImportGraph,
  sourceFilesUnder,
  transitiveDependents,
} from "../../.github/scripts/changed-sections.js";
import { RELEASE_PR_BRANCH_PREFIX } from "../../.github/scripts/release-pipeline.js";
import { headRefPrefixes, headRefPrefixesIn } from "./head-ref.js";

const ROOT = join(import.meta.dir, "..", "..");
const WORKFLOWS_DIR = join(ROOT, ".github", "workflows");
const COMPOSITE_DIR = ".github/actions/fetch-test-artifacts";
const COMPOSITE_USES = `./${COMPOSITE_DIR}`;
const PATHS_TS = "test/e2e/openapi/paths.ts";

interface FetchedArtifact {
  label: string;
  path: string;
  fetchScript: string;
  /** The complete cache key, byte for byte: the cache identity, so a reworded key is a cold cache. */
  key: string;
  /** Every source the fetched output depends on; the cache key must hash each. */
  hashInputs: () => string[];
}
const FETCHED_ARTIFACTS: readonly FetchedArtifact[] = [
  {
    label: "trimmed OpenAPI spec",
    path: "test/e2e/openapi/github-openapi.trimmed.json",
    fetchScript: ".github/scripts/trim-openapi.ts",
    key: `openapi-trimmed-\${{ hashFiles('.github/scripts/trim-openapi.ts', 'test/e2e/openapi/paths.ts', 'src/report/issue-report.ts', 'src/sections/**', 'src/upstream-gaps/**', 'src/schema.ts', 'src/github/api.ts') }}`,
    hashInputs: () => [".github/scripts/trim-openapi.ts", PATHS_TS, ...routeDataImports()],
  },
  {
    // The fetch script carries the pinned UPSTREAM_REF, the sole input that changes the output.
    label: "GraphQL schema",
    path: "test/e2e/graphql/schema.docs.graphql",
    fetchScript: ".github/scripts/fetch-graphql-schema.ts",
    key: `graphql-schema-\${{ hashFiles('.github/scripts/fetch-graphql-schema.ts') }}`,
    hashInputs: () => [".github/scripts/fetch-graphql-schema.ts"],
  },
];
const [OPENAPI, GRAPHQL] = FETCHED_ARTIFACTS as [FetchedArtifact, FetchedArtifact];

/**
 * Jobs whose spec fetch IS the upstream-drift tripwire: they call the script
 * directly and never restore a cache; every other loading job uses the composite.
 */
const UNCACHED_FETCH_JOBS: ReadonlySet<string> = new Set([
  "e2e-nightly.yml#nightly",
  "nightly-fuzz.yml#fuzz",
]);

const PACKAGE_SCRIPTS = (
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts;

/** Ends a `bun ...` token: `bun test/e2e/run.ts` and `test:e2e` continue past `bun test`. */
const TOKEN_END = "(?![\\w/:.-])";
/** The unit-suite runner itself, anywhere in the step; a file filter after it still loads what it names. */
const BUN_TEST = new RegExp(`\\bbun test${TOKEN_END}`);
/** Never matches: the alternative for an empty script set. */
const NOTHING = /(?!)/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The scripts that spawn the bundle against the spec-validating mock: every
 * non-test file that imports the e2e runner, directly or through another.
 */
function harnessEntrypoints(): string[] {
  const files = ["test/e2e", ".github/scripts"].flatMap((dir) => sourceFilesUnder(join(ROOT, dir)));
  return [...transitiveDependents(reverseImportGraph(files), join(ROOT, "test/e2e/runner.ts"))]
    .map((file) => relative(ROOT, file))
    .sort();
}

const BUN_HARNESS = new RegExp(
  `\\bbun (?:${harnessEntrypoints().map(escapeRegExp).join("|")})${TOKEN_END}`,
);

function runsScript(names: readonly string[]): RegExp {
  if (names.length === 0) {
    return NOTHING;
  }
  return new RegExp(`\\bbun run (?:${names.map(escapeRegExp).join("|")})${TOKEN_END}`);
}

/** The whole run scalar is the plain fetch command; anything wrapping, quoting, or commenting it is not a fetch. */
function isFetchCommand(run: string | undefined, fetchScript: string): boolean {
  return (run ?? "").trim() === `bun ${fetchScript}`;
}

/** package.json scripts matching `command`, directly or via `bun run <such script>`; a new alias needs no edit here. */
function scriptsRunning(command: RegExp): string[] {
  const names: string[] = [];
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, script] of Object.entries(PACKAGE_SCRIPTS)) {
      if (names.includes(name)) {
        continue;
      }
      if (command.test(script) || runsScript(names).test(script)) {
        names.push(name);
        grew = true;
      }
    }
  }
  return names;
}

/** A run step executing `command`, directly or through a package script. */
function runStep(command: RegExp): RegExp {
  return new RegExp(`${command.source}|${runsScript(scriptsRunning(command)).source}`);
}

/** A kind of step that loads fetched artifacts, and which ones it needs on disk. */
interface Loader {
  label: string;
  runs: RegExp;
  needs: readonly FetchedArtifact[];
}
const LOADERS: readonly Loader[] = [
  { label: "unit suite", runs: runStep(BUN_TEST), needs: FETCHED_ARTIFACTS },
  { label: "e2e harness", runs: runStep(BUN_HARNESS), needs: [OPENAPI] },
];
const [SUITE, HARNESS] = LOADERS as [Loader, Loader];

interface Step {
  id?: string;
  uses?: string;
  run?: string;
  shell?: string;
  if?: string;
  "continue-on-error"?: boolean;
  with?: Record<string, unknown>;
}
interface Workflow {
  jobs: Record<string, { if?: string; steps?: Step[] }>;
}
interface CompositeAction {
  runs: { using?: string; steps?: Step[] };
}

/** True when a cache `path` entry (a file, a directory, or a glob) takes in `file`. */
function pathEntryCovers(entry: string, file: string): boolean {
  return (
    entry === file ||
    file.startsWith(`${entry.replace(/\/$/, "")}/`) ||
    new Bun.Glob(entry).match(file)
  );
}

/** An actions/cache step whose `path` (one entry per line, `!` negating) takes in the artifact; found by path, so a renamed key stays visible. */
function cachesArtifact(step: Step, path: string): boolean {
  const entries = String(step.with?.path ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const covering = (negated: boolean) =>
    entries.some(
      (entry) =>
        entry.startsWith("!") === negated && pathEntryCovers(entry.replace(/^!/, ""), path),
    );
  return (step.uses ?? "").startsWith("actions/cache@") && covering(false) && !covering(true);
}

/** The key of an artifact cache step; anything but a string key is a broken cache, never a skip. */
function cacheKeyOf(step: Step, path: string): string {
  const key = step.with?.key;
  expect(
    typeof key,
    `the cache step for ${path} has a non-string key: ${JSON.stringify(key)}`,
  ).toBe("string");
  return key as string;
}

function readWorkflow(file: string): Workflow {
  return parseYaml(readFileSync(join(WORKFLOWS_DIR, file), "utf8")) as Workflow;
}

function readComposite(): CompositeAction {
  return parseYaml(
    readFileSync(join(ROOT, COMPOSITE_DIR, "action.yml"), "utf8"),
  ) as CompositeAction;
}

/** The quoted file patterns inside the key's hashFiles(...) call. */
function hashFilesPatterns(key: string): string[] {
  const match = key.match(/hashFiles\(([^)]*)\)/);
  expect(match, `cache key has no hashFiles call: ${key}`).not.toBeNull();
  return (match?.[1] ?? "")
    .split(",")
    .map((arg) => arg.trim().replace(/^'|'$/g, ""))
    .filter(Boolean);
}

/**
 * The repo-relative .ts files paths.ts imports route data from (compiled .js specifiers mapped
 * back to source). Only single-line static imports are recognized; any other import-ish line
 * fails the assertion below, so an unsupported form extends this parser instead of being skipped.
 */
function routeDataImports(): string[] {
  const source = readFileSync(join(ROOT, PATHS_TS), "utf8");
  const specifiers: string[] = [];
  for (const line of source.split("\n")) {
    if (!/\bimport\b|\brequire\(/.test(line)) {
      continue;
    }
    const match = line.match(/^import [^"]*from "([^"]+)";$/);
    expect(
      match,
      `unrecognized import form in ${PATHS_TS}: "${line.trim()}" - teach routeDataImports() to parse it`,
    ).not.toBeNull();
    specifiers.push(match?.[1] ?? "");
  }
  return specifiers
    .filter((spec) => spec.startsWith("."))
    .map((spec) =>
      relative(ROOT, resolve(ROOT, PATHS_TS, "..", spec))
        .split("\\")
        .join("/")
        .replace(/\.js$/, ".ts"),
    );
}

/** True when a file is named by the pattern list, directly or via a ** glob. */
function covered(patterns: string[], file: string): boolean {
  if (patterns.includes(file)) {
    return true;
  }
  return patterns.some(
    (pattern) => pattern.endsWith("/**") && file.startsWith(pattern.slice(0, -2)),
  );
}

/** The one step of `steps` satisfying `matches`; zero or several is the failure `what` names. */
function theOne(steps: Step[], matches: (step: Step) => boolean, what: string): number {
  const found = steps.flatMap((step, index) => (matches(step) ? [index] : []));
  expect(
    found.length,
    `${COMPOSITE_DIR} must have exactly one ${what}, found ${found.length}`,
  ).toBe(1);
  return found[0] as number;
}

/** Per artifact: exactly one cache of its path under a string key, then exactly one fetch gated on that cache's miss, failure-propagating, under the shell a composite run step must declare. */
function expectCompositeShape(action: CompositeAction): void {
  expect(action.runs.using, `${COMPOSITE_DIR} must be a composite action`).toBe("composite");
  const steps = action.runs.steps ?? [];
  const ids = steps.map((step) => step.id).filter((id) => id !== undefined);
  expect(new Set(ids).size, `${COMPOSITE_DIR} has duplicate step ids: ${ids.join(", ")}`).toBe(
    ids.length,
  );
  for (const { label, path, fetchScript } of FETCHED_ARTIFACTS) {
    const cacheIdx = theOne(
      steps,
      (step) => cachesArtifact(step, path),
      `actions/cache step for the ${label} (path ${path})`,
    );
    const fetchIdx = theOne(
      steps,
      (step) => isFetchCommand(step.run, fetchScript),
      `plain, failure-propagating fetch of the ${label} (bun ${fetchScript})`,
    );
    expect(
      fetchIdx,
      `${COMPOSITE_DIR}: the ${label} fetch must follow its cache restore`,
    ).toBeGreaterThan(cacheIdx);
    const cache = steps[cacheIdx] as Step;
    const fetch = steps[fetchIdx] as Step;
    cacheKeyOf(cache, path);
    expect(
      cache.with?.path,
      `${COMPOSITE_DIR}: the ${label} cache must restore exactly ${path}, not a directory or glob`,
    ).toBe(path);
    expect(
      cache["continue-on-error"],
      `${COMPOSITE_DIR}: a failed ${label} cache restore must fail the job`,
    ).toBeUndefined();
    for (const option of ["lookup-only", "fail-on-cache-miss"]) {
      // Either turns a miss into something other than "restore nothing, then fetch".
      expect(
        cache.with?.[option],
        `${COMPOSITE_DIR}: the ${label} cache must not set ${option}; a miss has to fall through to the fetch`,
      ).toBeUndefined();
    }
    expect(
      typeof cache.id === "string" && /\S/.test(cache.id),
      `${COMPOSITE_DIR}: the ${label} cache step needs an id`,
    ).toBe(true);
    expect(
      fetch.if,
      `${COMPOSITE_DIR}: the ${label} fetch must run exactly on a miss of its cache step`,
    ).toBe(`steps.${cache.id}.outputs.cache-hit != 'true'`);
    expect(
      fetch["continue-on-error"],
      `${COMPOSITE_DIR}: a failed ${label} fetch must fail the job`,
    ).toBeUndefined();
    // A composite run step without shell: is rejected by the runner at job start.
    expect(fetch.shell, `${COMPOSITE_DIR}: the ${label} fetch needs shell: bash`).toBe("bash");
  }
}

/** A step the provider relies on: it cannot be allowed to fail, and it cannot be skipped when the provider runs. */
function supports(step: Step, provider: Step): boolean {
  return (
    step["continue-on-error"] === undefined && (step.if === undefined || step.if === provider.if)
  );
}

/** The run scalar's lines with every heredoc body (`<<TAG` through its terminator) removed: what the shell executes. */
function executedLines(run: string): string[] {
  const lines: string[] = [];
  let terminator: string | undefined;
  for (const line of run.split("\n")) {
    if (terminator !== undefined) {
      if (line.trim() === terminator) {
        terminator = undefined;
      }
      continue;
    }
    lines.push(line);
    terminator = line
      .match(/<<-?\s*(?:'([^']+)'|"([^"]+)"|(\w+))/)
      ?.slice(1)
      .find(Boolean);
  }
  return lines;
}

/** A run scalar executing a `bun install` command: at the start of a line, outside heredocs, not commented out, echoed, or quoted. */
function installs(run: string | undefined): boolean {
  return executedLines(run ?? "").some(
    (line) => /^\s*bun install(?:\s|$)/.test(line) && !line.includes("||"),
  );
}

/** A run scalar executing `bun <script>` anywhere the shell would run it: as a command token on an executed line, however wrapped, but not quoted or commented. */
function runsFetch(run: string | undefined, fetchScript: string): boolean {
  const token = new RegExp(`(?:^|[\\s!(;&|])bun ${escapeRegExp(fetchScript)}(?=[\\s;)&|]|$)`);
  return executedLines(run ?? "").some((line) => !line.trim().startsWith("#") && token.test(line));
}

/** Every artifact the job's loaders need is put on disk earlier by the job's one sanctioned provider, after setup-bun and an install, and skipped only when the loader is too. */
function expectArtifactsProvided(where: string, steps: Step[]): void {
  const uncached = UNCACHED_FETCH_JOBS.has(where);
  const provides = (step: Step, artifact: FetchedArtifact) =>
    step["continue-on-error"] === undefined &&
    (uncached ? isFetchCommand(step.run, artifact.fetchScript) : step.uses === COMPOSITE_USES);
  if (uncached) {
    expect(
      steps.some((step) => step.uses === COMPOSITE_USES),
      `${where} is a drift tripwire: it must fetch the spec fresh, not restore it through ${COMPOSITE_USES}`,
    ).toBe(false);
  }
  /** [loader, index of a step running it], every occurrence. */
  const loaderSteps = LOADERS.flatMap((loader) =>
    steps.flatMap(
      (step, index): Array<[Loader, number]> =>
        loader.runs.test(step.run ?? "") ? [[loader, index]] : [],
    ),
  );
  if (!uncached && loaderSteps.length > 0) {
    for (const { label, fetchScript } of FETCHED_ARTIFACTS) {
      expect(
        steps.some((step) => runsFetch(step.run, fetchScript)),
        `${where} fetches the ${label} directly; a cached loading job restores it through ${COMPOSITE_USES} only`,
      ).toBe(false);
    }
  }
  for (const artifact of FETCHED_ARTIFACTS) {
    const consumers = loaderSteps.filter(([loader]) => loader.needs.includes(artifact));
    if (consumers.length === 0) {
      continue;
    }
    const providerIdxs = steps.flatMap((step, index) => (provides(step, artifact) ? [index] : []));
    const loaders = [...new Set(consumers.map(([loader]) => loader.label))].join(" and ");
    expect(
      providerIdxs.length,
      providerIdxs.length === 0
        ? uncached
          ? `${where} runs the ${loaders} without a plain, failure-propagating fetch of the ${artifact.label} (bun ${artifact.fetchScript})`
          : `${where} runs the ${loaders} without ${COMPOSITE_USES}, which every cached loading job must go through`
        : `${where} provides the ${artifact.label} ${providerIdxs.length} times; once is the whole job`,
    ).toBe(1);
    const providerIdx = providerIdxs[0] as number;
    const provider = steps[providerIdx] as Step;
    const before = steps.slice(0, providerIdx);
    expect(
      before.some(
        (step) => (step.uses ?? "").startsWith("oven-sh/setup-bun@") && supports(step, provider),
      ),
      `${where}: a reliable oven-sh/setup-bun must precede the ${artifact.label} provider (its fetch runs under bun)`,
    ).toBe(true);
    expect(
      before.some((step) => installs(step.run) && supports(step, provider)),
      `${where}: a reliable bun install must precede the ${artifact.label} provider (its fetch imports installed packages)`,
    ).toBe(true);
    for (const [loader, loaderIdx] of consumers) {
      expect(
        providerIdx,
        `${where}: the ${artifact.label} must be provided before the ${loader.label}`,
      ).toBeLessThan(loaderIdx);
      expect(
        provider.if,
        `${where}: the ${artifact.label} provider and the ${loader.label} must run under one condition (${provider.if ?? "none"} vs ${steps[loaderIdx]?.if ?? "none"})`,
      ).toBe(steps[loaderIdx]?.if);
    }
  }
}

/** `<workflow file>#<job id>` for every job with a step matching `loader`. */
function jobsRunning(file: string, wf: Workflow, loader: Loader): string[] {
  return Object.entries(wf.jobs)
    .filter(([, job]) => (job.steps ?? []).some((step) => loader.runs.test(step.run ?? "")))
    .map(([id]) => `${file}#${id}`);
}

/** `<workflow file>#<job id>` for every job caching an artifact path itself instead of through the composite. */
function inlineArtifactCaches(workflows: ReadonlyArray<{ file: string; wf: Workflow }>): string[] {
  return workflows.flatMap(({ file, wf }) =>
    Object.entries(wf.jobs)
      .filter(([, job]) =>
        (job.steps ?? []).some((step) =>
          FETCHED_ARTIFACTS.some(({ path }) => cachesArtifact(step, path)),
        ),
      )
      .map(([id]) => `${file}#${id}`),
  );
}

/** The key's hashFiles list names at least one pattern and covers every input the artifact depends on. */
function expectKeyHashesInputs(key: string, artifact: FetchedArtifact): void {
  const patterns = hashFilesPatterns(key);
  expect(patterns.length, `the ${artifact.label} cache key hashes nothing: ${key}`).toBeGreaterThan(
    0,
  );
  for (const file of artifact.hashInputs()) {
    expect(
      covered(patterns, file),
      `${file} changes the ${artifact.label} but its cache key does not hash it`,
    ).toBe(true);
  }
}

/** The key is the pinned literal: any rewording, reordering, or added input is a different cache. */
function expectKeyPinned(key: string, artifact: FetchedArtifact): void {
  expect(
    key,
    `the ${artifact.label} cache key changed; update the pin only with the cache identity`,
  ).toBe(artifact.key);
}

describe("the fetch-test-artifacts composite", () => {
  const action = readComposite();
  const steps = () => readComposite().runs.steps ?? [];
  const cacheOf = (artifact: FetchedArtifact) =>
    steps().find((step) => cachesArtifact(step, artifact.path)) as Step;
  const keyOf = (artifact: FetchedArtifact) => cacheKeyOf(cacheOf(artifact), artifact.path);
  const onCache = (steps: Step[], { path }: FetchedArtifact, patch: (step: Step) => Step) =>
    steps.map((step) => (cachesArtifact(step, path) ? patch(step) : step));
  const onFetch = (steps: Step[], { fetchScript }: FetchedArtifact, patch: (step: Step) => Step) =>
    steps.map((step) => (isFetchCommand(step.run, fetchScript) ? patch(step) : step));
  const withSteps = (steps: Step[]): CompositeAction => ({ runs: { ...action.runs, steps } });

  test("caches each artifact once and fetches it exactly on a miss, in that order", () => {
    expectCompositeShape(action);
  });

  test.each<[string, (steps: Step[]) => CompositeAction, RegExp]>([
    [
      "an action that is not a composite",
      (steps) => ({ runs: { using: "node24", steps } }),
      /must be a composite action/,
    ],
    [
      "a dropped fetch step",
      (steps) => withSteps(steps.filter((step) => !isFetchCommand(step.run, GRAPHQL.fetchScript))),
      /exactly one plain, failure-propagating fetch of the GraphQL schema \(bun \.github\/scripts\/fetch-graphql-schema\.ts\), found 0/,
    ],
    [
      "a duplicated fetch step",
      (steps) =>
        withSteps([
          ...steps,
          steps.find((step) => isFetchCommand(step.run, GRAPHQL.fetchScript)) as Step,
        ]),
      /exactly one plain, failure-propagating fetch of the GraphQL schema .*, found 2/,
    ],
    [
      "a dropped cache step",
      (steps) => withSteps(steps.filter((step) => !cachesArtifact(step, OPENAPI.path))),
      /exactly one actions\/cache step for the trimmed OpenAPI spec .*, found 0/,
    ],
    [
      "a duplicated cache step",
      (steps) =>
        withSteps([
          { ...(steps.find((step) => cachesArtifact(step, OPENAPI.path)) as Step), id: "twin" },
          ...steps,
        ]),
      /exactly one actions\/cache step for the trimmed OpenAPI spec .*, found 2/,
    ],
    [
      "a fetch moved before its cache",
      (steps) => {
        const [fetch] = steps.splice(
          steps.findIndex((step) => isFetchCommand(step.run, OPENAPI.fetchScript)),
          1,
        );
        return withSteps([fetch as Step, ...steps]);
      },
      /fetch must follow its cache restore/,
    ],
    [
      "a non-string key under the right path",
      (steps) =>
        withSteps(
          onCache(steps, GRAPHQL, (step) => ({ ...step, with: { ...step.with, key: 42 } })),
        ),
      /cache step for test\/e2e\/graphql\/schema\.docs\.graphql has a non-string key: 42/,
    ],
    ...["lookup-only", "fail-on-cache-miss"].map(
      (option): [string, (steps: Step[]) => CompositeAction, RegExp] => [
        `a cache with ${option}`,
        (steps) =>
          withSteps(
            onCache(steps, OPENAPI, (step) => ({
              ...step,
              with: { ...step.with, [option]: true },
            })),
          ),
        new RegExp(`trimmed OpenAPI spec cache must not set ${option}`),
      ],
    ),
    [
      "a cache of the artifact's directory",
      (steps) =>
        withSteps(
          onCache(steps, OPENAPI, (step) => ({
            ...step,
            with: { ...step.with, path: "test/e2e/openapi" },
          })),
        ),
      /trimmed OpenAPI spec cache must restore exactly test\/e2e\/openapi\/github-openapi\.trimmed\.json/,
    ],
    [
      "a cache allowed to fail",
      (steps) =>
        withSteps(onCache(steps, OPENAPI, (step) => ({ ...step, "continue-on-error": true }))),
      /a failed trimmed OpenAPI spec cache restore must fail the job/,
    ],
    [
      "a cache step without an id",
      (steps) => withSteps(onCache(steps, GRAPHQL, ({ id: _, ...step }) => step)),
      /GraphQL schema cache step needs an id/,
    ],
    [
      "two cache steps sharing an id (the fetch gate following it)",
      (steps) =>
        withSteps(
          onFetch(
            onCache(steps, GRAPHQL, (step) => ({ ...step, id: "openapi-cache" })),
            GRAPHQL,
            (step) => ({ ...step, if: "steps.openapi-cache.outputs.cache-hit != 'true'" }),
          ),
        ),
      /duplicate step ids/,
    ],
    [
      "a fetch switched off",
      (steps) => withSteps(onFetch(steps, OPENAPI, (step) => ({ ...step, if: "false" }))),
      /fetch must run exactly on a miss of its cache step/,
    ],
    [
      "a fetch allowed to fail",
      (steps) =>
        withSteps(onFetch(steps, GRAPHQL, (step) => ({ ...step, "continue-on-error": true }))),
      /a failed GraphQL schema fetch must fail the job/,
    ],
    [
      "a fetch without a shell",
      (steps) => withSteps(onFetch(steps, GRAPHQL, ({ shell: _, ...step }) => step)),
      /GraphQL schema fetch needs shell: bash/,
    ],
  ])("%s fails the guard (negative control)", (_, mutate, message) => {
    expect(() => expectCompositeShape(mutate(steps()))).toThrow(message);
  });

  test("each cache key is the pinned literal and hashes every input its artifact depends on", () => {
    expect(OPENAPI.hashInputs()).toContain("src/report/issue-report.ts");
    expect(hashFilesPatterns(keyOf(OPENAPI))).toContain("src/sections/**");
    for (const artifact of FETCHED_ARTIFACTS) {
      expectKeyPinned(keyOf(artifact), artifact);
      expectKeyHashesInputs(keyOf(artifact), artifact);
    }
  });

  test.each([
    [
      "an added input",
      OPENAPI.key.replace("'src/github/api.ts'", "'src/github/api.ts', 'package.json'"),
    ],
    ["a changed prefix", OPENAPI.key.replace("openapi-trimmed-", "openapi-spec-")],
    [
      "reordered inputs",
      OPENAPI.key.replace(
        "'.github/scripts/trim-openapi.ts', 'test/e2e/openapi/paths.ts'",
        "'test/e2e/openapi/paths.ts', '.github/scripts/trim-openapi.ts'",
      ),
    ],
  ])("a key with %s fails the pin (negative control)", (_, key) => {
    expect(key).not.toBe(OPENAPI.key);
    expect(() => expectKeyPinned(key, OPENAPI)).toThrow(/trimmed OpenAPI spec cache key changed/);
  });

  /** A GraphQL schema key whose expression is `call`. */
  const keyed = (call: string) => `graphql-schema-\${{ ${call} }}`;

  test.each<[string, string, RegExp]>([
    ["a key hashing nothing", keyed("hashFiles()"), /GraphQL schema cache key hashes nothing/],
    [
      "a key hashing an unrelated file",
      keyed("hashFiles('package.json')"),
      /fetch-graphql-schema\.ts changes the GraphQL schema but its cache key does not hash it/,
    ],
    ["a key without hashFiles", "graphql-schema-v1", /cache key has no hashFiles call/],
  ])("%s fails the guard (negative control)", (_, key, message) => {
    expect(() => expectKeyHashesInputs(key, GRAPHQL)).toThrow(message);
  });

  test("every hashFiles pattern of every key matches at least one file on disk", () => {
    // hashFiles() silently skips a pattern that matches nothing (a moved or
    // renamed input), so the key would stop changing with that input while
    // the coverage test above still sees the stale pattern string.
    for (const artifact of FETCHED_ARTIFACTS) {
      for (const pattern of hashFilesPatterns(keyOf(artifact))) {
        // dot: true because the scripts live under .github/, which the glob
        // scanner skips by default (hashFiles itself does not).
        const matches = [...new Bun.Glob(pattern).scanSync({ cwd: ROOT, dot: true })];
        expect(
          matches.length,
          `hashFiles pattern '${pattern}' matches no file on disk, so it contributes nothing to the cache key`,
        ).toBeGreaterThan(0);
      }
    }
  });
});

describe("fetched test artifacts across workflows", () => {
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f));
  const workflows = files.map((file) => ({ file, wf: readWorkflow(file) }));

  // Pinned: a derivation that silently found nothing would pass every guard below vacuously.
  test.each<[string, () => string[], string[]]>([
    ["the unit-suite scripts", () => scriptsRunning(BUN_TEST).sort(), ["check", "test"]],
    ["the harness scripts", () => scriptsRunning(BUN_HARNESS).sort(), ["fuzz", "test:e2e"]],
    [
      "the harness entrypoints",
      harnessEntrypoints,
      [".github/scripts/check-endpoint-coverage.ts", "test/e2e/fuzz.ts", "test/e2e/run.ts"],
    ],
  ])("%s derive to exactly %p", (_, derive, expected) => {
    expect(derive()).toEqual(expected);
  });

  test.each<[string, Loader | undefined]>([
    ["bun test", SUITE],
    ["bun run test", SUITE],
    ["bun run check", SUITE],
    ["bun test test/docs/checks-workflow.test.ts", SUITE],
    ["bun test/e2e/run.ts", HARNESS],
    ["bun test/e2e/run.ts --sections labels", HARNESS],
    ["bun run test:e2e", HARNESS],
    ["timeout 50m bun test/e2e/fuzz.ts --seed 1", HARNESS],
    ["bun .github/scripts/check-endpoint-coverage.ts", HARNESS],
    ["bun run typecheck --pretty false", undefined],
    ["bun run build:check", undefined],
    ["bun .github/scripts/trim-openapi.ts", undefined],
  ])("%j loads through %p", (command, loader) => {
    expect(LOADERS.filter((candidate) => candidate.runs.test(command))).toEqual(
      loader ? [loader] : [],
    );
  });

  test("exactly the pinned jobs run the unit suite and the e2e harness", () => {
    const found = (loader: Loader) =>
      workflows.flatMap(({ file, wf }) => jobsRunning(file, wf, loader)).sort();
    expect(found(SUITE)).toEqual(["checks.yml#check", "nightly.yml#float-canary"]);
    expect(found(HARNESS)).toEqual(
      ["checks.yml#e2e-smoke", "checks.yml#endpoint-coverage", ...UNCACHED_FETCH_JOBS].sort(),
    );
  });

  test("every loading job is handed its artifacts first, and none caches one inline", () => {
    for (const { file, wf } of workflows) {
      for (const [id, job] of Object.entries(wf.jobs)) {
        expectArtifactsProvided(`${file}#${id}`, job.steps ?? []);
      }
    }
    const inline = inlineArtifactCaches(workflows);
    expect(
      inline,
      `these jobs cache an artifact inline instead of through ${COMPOSITE_USES}: ${inline.join(", ")}`,
    ).toEqual([]);
  });

  const CANARY = "nightly.yml#float-canary";
  const E2E_NIGHTLY = "e2e-nightly.yml#nightly";
  const COVERAGE = "checks.yml#endpoint-coverage";
  const canary = () => readWorkflow("nightly.yml").jobs["float-canary"]?.steps ?? [];
  const coverage = () => readWorkflow("checks.yml").jobs["endpoint-coverage"]?.steps ?? [];
  const ungated = ({ if: _, ...step }: Step): Step => step;
  const e2eNightly = () => readWorkflow("e2e-nightly.yml").jobs.nightly?.steps ?? [];
  const isComposite = (step: Step) => step.uses === COMPOSITE_USES;
  const isPlainFetch = (step: Step) => isFetchCommand(step.run, OPENAPI.fetchScript);
  const onComposite = (steps: Step[], patch: (step: Step) => Step) =>
    steps.map((step) => (isComposite(step) ? patch(step) : step));
  const onPlainFetch = (steps: Step[], patch: (step: Step) => Step) =>
    steps.map((step) => (isPlainFetch(step) ? patch(step) : step));
  const isInstall = (step: Step) => installs(step.run);
  const onInstall = (steps: Step[], patch: (step: Step) => Step) =>
    steps.map((step) => (isInstall(step) ? patch(step) : step));
  const onSetupBun = (steps: Step[], patch: (step: Step) => Step) =>
    steps.map((step) => ((step.uses ?? "").startsWith("oven-sh/setup-bun@") ? patch(step) : step));
  const moved = (steps: Step[], matches: (step: Step) => boolean, to: "first" | "last") => {
    const [step] = steps.splice(steps.findIndex(matches), 1);
    return to === "first" ? [step as Step, ...steps] : [...steps, step as Step];
  };

  test("an inline artifact cache is reported by job (negative control)", () => {
    const wf = readWorkflow("checks.yml");
    wf.jobs.check?.steps?.push({
      uses: "actions/cache@v6",
      with: { path: GRAPHQL.path, key: "anything" },
    });
    expect(inlineArtifactCaches([{ file: "checks.yml", wf }])).toEqual(["checks.yml#check"]);
  });

  test.each<[string, string, () => Step[], RegExp]>([
    [
      "a dropped composite step",
      CANARY,
      () => canary().filter((step) => !isComposite(step)),
      /nightly\.yml#float-canary runs the unit suite without \.\/\.github\/actions\/fetch-test-artifacts, which every cached loading job must go through/,
    ],
    [
      "a composite step moved after the suite",
      CANARY,
      () => moved(canary(), isComposite, "last"),
      /trimmed OpenAPI spec must be provided before the unit suite/,
    ],
    [
      "a composite step allowed to fail",
      CANARY,
      () => onComposite(canary(), (step) => ({ ...step, "continue-on-error": true })),
      /runs the unit suite without/,
    ],
    [
      "a second suite step outside the composite's condition",
      CANARY,
      () => [
        ...canary().map((step) =>
          isComposite(step) || SUITE.runs.test(step.run ?? "")
            ? { ...step, if: "github.event_name == 'schedule'" }
            : step,
        ),
        { run: "bun test test/docs" },
      ],
      /trimmed OpenAPI spec provider and the unit suite must run under one condition \(github\.event_name == 'schedule' vs none\)/,
    ],
    [
      "a gated harness step with an ungated composite",
      COVERAGE,
      () => onComposite(coverage(), ungated),
      /checks\.yml#endpoint-coverage: the trimmed OpenAPI spec provider and the e2e harness must run under one condition \(none vs steps\.select/,
    ],
    [
      "an ungated harness step with a gated composite",
      COVERAGE,
      () => coverage().map((step) => (HARNESS.runs.test(step.run ?? "") ? ungated(step) : step)),
      /provider and the e2e harness must run under one condition \(steps\.select\.outputs\.sections != 'none' vs none\)/,
    ],
    [
      "a plain fetch added beside the composite",
      CANARY,
      () => [...canary(), { run: `bun ${GRAPHQL.fetchScript}` }],
      /nightly\.yml#float-canary fetches the GraphQL schema directly; a cached loading job restores it through/,
    ],
    [
      "a composite step before setup-bun",
      CANARY,
      () => moved(canary(), isComposite, "first"),
      /reliable oven-sh\/setup-bun must precede the trimmed OpenAPI spec provider/,
    ],
    [
      "a setup-bun allowed to fail",
      CANARY,
      () => onSetupBun(canary(), (step) => ({ ...step, "continue-on-error": true })),
      /reliable oven-sh\/setup-bun must precede/,
    ],
    [
      "a composite step before the install",
      CANARY,
      () => moved(canary(), isInstall, "last"),
      /reliable bun install must precede the trimmed OpenAPI spec provider/,
    ],
    [
      "a duplicated composite step",
      CANARY,
      () => canary().flatMap((step) => (isComposite(step) ? [step, step] : [step])),
      /nightly\.yml#float-canary provides the trimmed OpenAPI spec 2 times; once is the whole job/,
    ],
    [
      "an install skipped under a condition the composite lacks",
      CANARY,
      () => onInstall(canary(), (step) => ({ ...step, if: "github.event_name == 'schedule'" })),
      /reliable bun install must precede/,
    ],
    [
      "a drift tripwire restoring the cache instead",
      E2E_NIGHTLY,
      () => onPlainFetch(e2eNightly(), () => ({ uses: COMPOSITE_USES })),
      /e2e-nightly\.yml#nightly is a drift tripwire: it must fetch the spec fresh/,
    ],
    [
      "a plain fetch allowed to fail",
      E2E_NIGHTLY,
      () => onPlainFetch(e2eNightly(), (step) => ({ ...step, "continue-on-error": true })),
      /e2e-nightly\.yml#nightly runs the e2e harness without a plain, failure-propagating fetch/,
    ],
    [
      "a plain fetch moved after the second harness step",
      E2E_NIGHTLY,
      () => moved(e2eNightly(), isPlainFetch, "last"),
      /trimmed OpenAPI spec must be provided before the e2e harness/,
    ],
  ])("%s fails the guard naming the job (negative control)", (_, where, mutate, message) => {
    expect(() => expectArtifactsProvided(where, mutate())).toThrow(message);
  });
});

/** The step predicates the guards above are built from, each proven on the forms it must accept and reject. */
describe("step predicates", () => {
  const cache = (path: string, uses = "actions/cache@v6"): Step => ({ uses, with: { path } });

  test.each([
    ["the exact path", true, cache(OPENAPI.path)],
    ["a multiline list containing it", true, cache(`node_modules\n${OPENAPI.path}\n`)],
    ["its directory", true, cache("test/e2e/openapi")],
    ["a parent directory with a trailing slash", true, cache("test/e2e/")],
    ["a glob over it", true, cache("test/e2e/**/*.json")],
    ["a directory with it negated out", false, cache(`test/e2e/openapi\n!${OPENAPI.path}`)],
    ["a glob with it negated out by glob", false, cache("test/e2e/**\n!test/e2e/openapi/*.json")],
    ["an unrelated path list", false, cache("~/.bun/install/cache\ntest/e2e/openapi/other.json")],
    ["the other artifact", false, cache(GRAPHQL.path)],
    ["a different action", false, cache(OPENAPI.path, "actions/cache-restore@v6")],
    ["a run step", false, { run: `cat ${OPENAPI.path}` }],
  ])("cachesArtifact(): %s -> %p", (_, expected, step) => {
    expect(cachesArtifact(step, OPENAPI.path)).toBe(expected);
  });

  const fetch = `bun ${OPENAPI.fetchScript}`;
  test.each([
    ["the plain command", true, fetch],
    ["the command with surrounding whitespace", true, `  ${fetch}\n`],
    ["a commented command", false, `# ${fetch}`],
    ["a command short-circuited behind a separator", false, `true || ${fetch}`],
    ["a command quoted in an echo", false, `echo "; ${fetch}"`],
    ["a command inside a heredoc body", false, `cat <<'EOF'\n${fetch}\nEOF`],
    ["a command with its failure masked", false, `${fetch} || true`],
    ["the other artifact's fetch", false, `bun ${GRAPHQL.fetchScript}`],
  ])("isFetchCommand(): %s -> %p", (_, expected, run) => {
    expect(isFetchCommand(run, OPENAPI.fetchScript)).toBe(expected);
  });

  test.each([
    ["the whole scalar", true, fetch],
    ["a line of a script", true, `bun run lint\n${fetch}\nbun test`],
    ["a negated condition", true, `if ! ${fetch} >log 2>&1; then exit 1; fi`],
    ["a masked command", true, `${fetch} || true`],
    ["a subshell", true, `(${fetch})`],
    ["an echoed command", false, `echo "${fetch}"`],
    ["a commented command", false, `# ${fetch}`],
    ["a heredoc body", false, `cat <<EOF\n${fetch}\nEOF`],
    ["the other artifact's fetch", false, `bun ${GRAPHQL.fetchScript}`],
  ])("runsFetch(): %s -> %p", (_, expected, run) => {
    expect(runsFetch(run, OPENAPI.fetchScript)).toBe(expected);
  });

  test.each([
    ["a command inside a script", true, "rm bun.lock\nbun install --ignore-scripts\ngit diff"],
    ["a command after a heredoc", true, "cat <<EOF\nnoise\nEOF\nbun install --frozen-lockfile"],
    ["a heredoc body", false, "cat <<EOF\nbun install\nEOF"],
    ["a quoted heredoc body", false, "cat <<'EOF'\n  bun install\nEOF\necho done"],
    ["an echoed command", false, 'echo "bun install"'],
    ["a commented command", false, "# bun install"],
    ["a command with its failure masked", false, "bun install || true"],
    ["a different subcommand", false, "bun install-nope"],
  ])("installs(): %s -> %p", (_, expected, run) => {
    expect(installs(run)).toBe(expected);
  });
});

/** The guard: one anchor-check step gated on the constant, and no job or step condition spelling it otherwise. */
function expectReleasePrefixes(wf: Workflow): void {
  const anchorSteps = Object.values(wf.jobs)
    .flatMap((job) => job.steps ?? [])
    .filter((step) => (step.run ?? "").includes("release-pipeline.ts anchor-check"));
  expect(anchorSteps.length, "checks.yml lost its anchor-check step").toBe(1);
  expect(headRefPrefixesIn(anchorSteps[0]?.if)).toEqual([RELEASE_PR_BRANCH_PREFIX]);
  for (const literal of headRefPrefixes(wf)) {
    expect(literal).toBe(RELEASE_PR_BRANCH_PREFIX);
  }
}

describe("checks.yml release PR branch spelling", () => {
  const text = readFileSync(join(WORKFLOWS_DIR, "checks.yml"), "utf8");

  // Workflows cannot import the constant, so the head_ref conditions spell
  // it by hand; a drifted spelling skips the anchor-check on every release
  // PR instead of failing there.
  test("the anchor-check step is gated on RELEASE_PR_BRANCH_PREFIX and nothing spells it otherwise", () => {
    expectReleasePrefixes(parseYaml(text) as Workflow);
  });

  test("a drifted spelling fails the guard (negative control)", () => {
    const drifted = text.replaceAll(`'${RELEASE_PR_BRANCH_PREFIX}'`, "'release-pls--'");
    expect(() => expectReleasePrefixes(parseYaml(drifted) as Workflow)).toThrow();
  });

  test("a missing anchor-check step fails the guard (negative control)", () => {
    const wf = parseYaml(text) as Workflow;
    for (const job of Object.values(wf.jobs)) {
      job.steps = job.steps?.filter((step) => !(step.run ?? "").includes("anchor-check"));
    }
    expect(() => expectReleasePrefixes(wf)).toThrow();
  });
});
