/**
 * apply-settings.yml is the hook for ci.yml's post-green slot: its only write
 * trigger is that call, so a repository setting is never written from a commit
 * the all-green gate has not judged. The contract below is that write path.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = join(import.meta.dir, "..", "..");

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Input {
  required?: boolean;
  type?: string;
  default?: unknown;
}
interface Trigger {
  inputs?: Record<string, Input>;
}
interface Job {
  env?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on: Record<string, Trigger | null>;
  jobs: Record<string, Job>;
}

interface Contract {
  jobs: string[];
  triggers: string[];
  shaInput: { required: boolean; type: string | undefined; hasDefault: boolean } | undefined;
  dispatchInputs: string[];
  mode: string | undefined;
  /** Every checkout step: the workspace root is the tree `uses: ./` runs from. */
  checkouts: Array<{ repository: unknown; path: unknown; ref: unknown }>;
  writers: Array<{
    afterFreshness: boolean;
    if: string | undefined;
    mode: unknown;
    env: Record<string, string> | undefined;
  }>;
  ungatedBeforeWriter: string[];
}

const FRESHNESS_GATE = "steps.freshness.outputs.moved == 'false'";
const EXPECTED: Contract = {
  jobs: ["apply"],
  triggers: ["workflow_call", "workflow_dispatch"],
  shaInput: { required: true, type: "string", hasDefault: false },
  dispatchInputs: [],
  mode: `\${{ github.event_name == 'workflow_dispatch' && 'check' || 'apply' }}`,
  checkouts: [
    {
      repository: undefined,
      path: undefined,
      ref: `\${{ github.event_name == 'workflow_dispatch' && github.event.repository.default_branch || inputs.sha }}`,
    },
    {
      repository: "Vivswan/repo-platform",
      path: "platform",
      ref: `\${{ steps.scripts.outputs.ref }}`,
    },
  ],
  writers: [{ afterFreshness: true, if: FRESHNESS_GATE, mode: `\${{ env.MODE }}`, env: undefined }],
  ungatedBeforeWriter: [],
};

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`apply-settings.yml has no ${what}`);
  return value;
}

const isCheckout = (s: Step): boolean => s.uses?.startsWith("actions/checkout@") === true;
const isWriter = (s: Step): boolean => s.uses === "./";

function contractOf(wf: Workflow): Contract {
  const job = must(wf.jobs.apply, "apply job");
  const sha = wf.on.workflow_call?.inputs?.sha;
  const freshness = job.steps.findIndex((s) => s.id === "freshness");
  if (freshness < 0) throw new Error("apply-settings.yml has no freshness step");
  const writerIndexes = job.steps.flatMap((s, i) => (isWriter(s) ? [i] : []));
  const lastWriter = writerIndexes[writerIndexes.length - 1] ?? freshness;
  return {
    jobs: Object.keys(wf.jobs),
    triggers: Object.keys(wf.on).sort(),
    shaInput: sha && {
      required: sha.required === true,
      type: sha.type,
      hasDefault: "default" in sha,
    },
    dispatchInputs: Object.keys(wf.on.workflow_dispatch?.inputs ?? {}),
    mode: job.env?.MODE,
    checkouts: job.steps
      .filter(isCheckout)
      .map((s) => ({ repository: s.with?.repository, path: s.with?.path, ref: s.with?.ref })),
    writers: writerIndexes.map((i) => {
      const step = must(job.steps[i], "writer step");
      return { afterFreshness: i > freshness, if: step.if, mode: step.with?.mode, env: step.env };
    }),
    ungatedBeforeWriter: job.steps
      .slice(freshness + 1, lastWriter)
      .filter((s) => s.if !== FRESHNESS_GATE)
      .map((s) => s.name ?? s.uses ?? "<unnamed step>"),
  };
}

function expectContract(wf: Workflow): void {
  expect(contractOf(wf)).toEqual(EXPECTED);
}

describe("apply-settings.yml post-green write path", () => {
  const wf = parseYaml(
    readFileSync(join(ROOT, ".github", "workflows", "apply-settings.yml"), "utf8"),
  ) as Workflow;

  test("the hook is call-only for writes, checks out the judged sha once, and gates its one writer on freshness", () => {
    expectContract(wf);
  });

  const REGRESSIONS: Array<[string, (w: Workflow, job: Job) => void, keyof Contract]> = [
    [
      "a second job with its own checkout and writer",
      (w) => {
        w.jobs.shadow = {
          steps: [{ uses: "actions/checkout@v7" }, { uses: "./", with: { mode: "apply" } }],
        };
      },
      "jobs",
    ],
    [
      "a push trigger of its own",
      (w) => (w.on.push = { branches: ["main"] } as Trigger),
      "triggers",
    ],
    [
      "a schedule of its own",
      (w) => (w.on.schedule = [{ cron: "0 0 * * 1" }] as unknown as Trigger),
      "triggers",
    ],
    [
      "a dispatch input, the schema a mode toggle would grow from",
      (w) => (w.on.workflow_dispatch = { inputs: { check_only: { required: false } } }),
      "dispatchInputs",
    ],
    [
      "an optional judged sha",
      (w) => (must(w.on.workflow_call?.inputs?.sha, "sha input").required = false),
      "shaInput",
    ],
    [
      "a judged sha with a fallback default",
      (w) => (must(w.on.workflow_call?.inputs?.sha, "sha input").default = ""),
      "shaInput",
    ],
    [
      "a judged sha that is not a string",
      (w) => (must(w.on.workflow_call?.inputs?.sha, "sha input").type = "boolean"),
      "shaInput",
    ],
    [
      "a mode that lets a dispatch write",
      (_w, job) => (must(job.env, "job env").MODE = "apply"),
      "mode",
    ],
    [
      "a call that checks out the live default branch",
      (_w, job) => {
        const checkout = must(job.steps.find(isCheckout), "checkout step");
        checkout.with = { ...checkout.with, ref: `\${{ github.event.repository.default_branch }}` };
      },
      "checkouts",
    ],
    [
      "a second checkout that swaps the judged tree for the default branch",
      (_w, job) => {
        const writer = job.steps.findIndex(isWriter);
        job.steps.splice(writer, 0, {
          uses: "actions/checkout@v7",
          if: FRESHNESS_GATE,
          with: { ref: `\${{ github.event.repository.default_branch }}` },
        });
      },
      "checkouts",
    ],
    [
      "a second root checkout that names this repository explicitly",
      (_w, job) => {
        const writer = job.steps.findIndex(isWriter);
        job.steps.splice(writer, 0, {
          uses: "actions/checkout@v7",
          if: FRESHNESS_GATE,
          with: { repository: `\${{ github.repository }}`, path: "./" },
        });
      },
      "checkouts",
    ],
    [
      "a negative freshness test on the writer",
      (_w, job) =>
        (must(job.steps.find(isWriter), "writer step").if =
          "steps.freshness.outputs.moved != 'true'"),
      "writers",
    ],
    [
      "a writer whose mode ignores the dispatch pin",
      (_w, job) => {
        const writer = must(job.steps.find(isWriter), "writer step");
        writer.with = { ...writer.with, mode: "apply" };
      },
      "writers",
    ],
    [
      "a writer whose own env shadows the job's MODE",
      (_w, job) => (must(job.steps.find(isWriter), "writer step").env = { MODE: "apply" }),
      "writers",
    ],
    [
      "a second writer ahead of the freshness check",
      (_w, job) => job.steps.splice(1, 0, { uses: "./", with: { mode: "apply" } }),
      "writers",
    ],
    [
      "an ungated bundle build between the freshness check and the writer",
      (_w, job) => {
        const build = must(
          job.steps.find((s) => s.name === "Build the action bundle"),
          "bundle build step",
        );
        build.if = undefined;
      },
      "ungatedBeforeWriter",
    ],
  ];
  test.each(REGRESSIONS)("catches %s (negative control)", (_label, mutate, key) => {
    const drifted = structuredClone(wf);
    mutate(drifted, must(drifted.jobs.apply, "apply job"));
    expect(contractOf(drifted)[key]).not.toEqual(EXPECTED[key]);
    expect(() => expectContract(drifted)).toThrow();
  });
});
