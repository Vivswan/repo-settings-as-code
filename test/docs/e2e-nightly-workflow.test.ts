/**
 * Structural contract for the nightly e2e workflow's issue path: on failure it
 * files an issue and then dispatches auto-assign with that issue's number, so
 * assignment policy stays in auto-assign rather than the filer. Pins the filer
 * step id, the targeted dispatch, the `actions: write` permission, the graceful
 * dispatch failure, and the auto-assign caller's matching `issue` input.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = join(import.meta.dir, "..", "..");

interface Step {
  name?: string;
  id?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
}
interface Workflow {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, { steps?: Step[]; with?: Record<string, unknown> }>;
}

describe("e2e-nightly.yml issue + auto-assign path", () => {
  const wf = parseYaml(
    readFileSync(join(ROOT, ".github", "workflows", "e2e-nightly.yml"), "utf8"),
  ) as Workflow;
  const steps = wf.jobs.nightly?.steps ?? [];

  test("grants actions: write for the workflow dispatch", () => {
    expect(wf.permissions?.actions).toBe("write");
  });

  test("the filer step has an id so the dispatch can read its issue-number output", () => {
    const filer = steps.find((s) => (s.run ?? "").includes("file-fuzz-issue.ts"));
    expect(filer?.id).toBe("file-issue");
  });

  test("dispatches auto-assign.yml with the filed issue number, after filing, on failure", () => {
    const fileIdx = steps.findIndex((s) => (s.run ?? "").includes("file-fuzz-issue.ts"));
    const dispatchIdx = steps.findIndex((s) =>
      (s.run ?? "").includes("gh workflow run auto-assign.yml"),
    );
    expect(fileIdx, "no file-fuzz-issue step").toBeGreaterThanOrEqual(0);
    expect(dispatchIdx, "no auto-assign dispatch step").toBeGreaterThan(fileIdx);
    const dispatch = steps[dispatchIdx];
    // Guard: run only when the filer emitted a non-empty issue-number, so the
    // dispatch never expands to a bare `-f issue=`.
    expect(dispatch?.if).toContain("failure()");
    expect(dispatch?.if).toContain("steps.file-issue.outputs.issue-number != ''");
    // The number is passed through a quoted env var, not interpolated into run:.
    expect(dispatch?.env?.ISSUE_NUMBER).toContain("steps.file-issue.outputs.issue-number");
    expect(dispatch?.run).toContain('-f "issue=$ISSUE_NUMBER"');
    // An interpolation would embed the step-output path in run:; the env-var
    // approach keeps it out, so run: must not name the step output directly.
    expect(dispatch?.run).not.toContain("steps.file-issue.outputs");
  });

  test("tolerates a dispatch failure as a warning, not a job failure", () => {
    const dispatch = steps.find((s) => (s.run ?? "").includes("gh workflow run auto-assign.yml"));
    expect(dispatch?.run).toContain("::warning::");
    // The `|| echo` keeps a dispatch failure from failing the step.
    expect(dispatch?.run).toContain("||");
  });
});

describe("auto-assign.yml caller forwards the dispatched issue", () => {
  const wf = parseYaml(
    readFileSync(join(ROOT, ".github", "workflows", "auto-assign.yml"), "utf8"),
  ) as Workflow;

  test("workflow_dispatch declares an optional issue input", () => {
    const dispatch = wf.on?.workflow_dispatch as { inputs?: Record<string, unknown> } | undefined;
    expect(dispatch?.inputs).toHaveProperty("issue");
  });

  test("the reusable call forwards issue from inputs", () => {
    const withBlock = wf.jobs["auto-assign"]?.with ?? {};
    expect(String(withBlock.issue)).toContain("inputs.issue");
  });
});
