import { describe, expect, test } from "bun:test";
import type { GithubClient } from "../../../src/github/api.js";
import { type PlannedOp, planContext } from "../../../src/sections/contract/plan.js";
import { MockApi } from "../../../test/mock-api.js";
import { provePlanIdempotent } from "../../../test/sections/plan-idempotence.js";
import { REPO } from "../../../test/sections/section-run.js";
import { workflowsSection } from "./index.js";

/** A live workflow as the list endpoint returns it. */
interface LiveWorkflow {
  id: number;
  name: string;
  path: string;
  state: string;
}

/**
 * A stateful fake of the workflows API: the list reflects every enable and
 * disable, so a plan over executed state sees the converged repository.
 */
function liveRepo(workflows: LiveWorkflow[]): GithubClient & { writes: string[] } {
  return {
    writes: [],
    async tryRequest(method, path) {
      if (method === "GET") {
        return { data: { total_count: workflows.length, workflows } };
      }
      const toggled = path.match(/\/actions\/workflows\/(\d+)\/(enable|disable)$/);
      const target = workflows.find((w) => String(w.id) === toggled?.[1]);
      if (toggled === null || target === undefined) {
        return { error: { status: 404, message: "Not Found", body: "" } };
      }
      target.state = toggled[2] === "enable" ? "active" : "disabled_manually";
      this.writes.push(`${method} ${path}`);
      return { data: null };
    },
    async tryGraphql() {
      throw new Error("the workflows section issues no GraphQL");
    },
  };
}

describe("workflows", () => {
  const liveWorkflows = {
    total_count: 3,
    workflows: [
      { id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" },
      { id: 2, name: "Old", path: ".github/workflows/old.yml", state: "disabled_inactivity" },
      { id: 3, name: "Gone", path: ".github/workflows/gone.yml", state: "deleted" },
    ],
  };
  const route = "GET /repos/o/r/actions/workflows?per_page=100&page=1";
  const plan = (api: MockApi, desired: Parameters<typeof workflowsSection.plan>[1]) =>
    workflowsSection.plan(planContext(workflowsSection, api, REPO), desired);

  test("plans one toggle per divergent workflow by live id, matching bare file names", async () => {
    const api = new MockApi({ [route]: { data: liveWorkflows } });
    const result = await plan(api, [
      { path: "ci.yml", state: "disabled" },
      { path: ".github/workflows/old.yml", state: "active" },
    ]);
    expect(result).toEqual({
      ops: [
        {
          role: "disable",
          params: { workflow_id: "1" },
          drift: [
            'workflows[ci.yml]: declared "disabled" != live "active"; apply will disable the workflow',
          ],
          change: 'disabled workflow ".github/workflows/ci.yml"',
        },
        {
          role: "enable",
          params: { workflow_id: "2" },
          drift: [
            'workflows[.github/workflows/old.yml]: declared "active" != live "disabled" (disabled_inactivity); apply will enable the workflow',
          ],
          change: 'enabled workflow ".github/workflows/old.yml"',
        },
      ],
      notes: [],
      drift: [],
    });
    // Planning reads and never writes.
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([route]);
  });

  test("a matching state plans nothing; undeclared workflows stay silent", async () => {
    const api = new MockApi({ [route]: { data: liveWorkflows } });
    const result = await plan(api, [{ path: "ci.yml", state: "active" }]);
    expect(result).toEqual({ ops: [], notes: [], drift: [] });
  });

  test("a declared path with no live workflow is op-less drift; a deleted live state counts as absent", async () => {
    const api = new MockApi({ [route]: { data: liveWorkflows } });
    const result = await plan(api, [
      { path: "nope.yml", state: "disabled" },
      { path: "gone.yml", state: "active" },
    ]);
    expect(result.ops).toEqual([]);
    expect(result.drift).toEqual([
      "workflows[nope.yml]: declared in the settings file but no workflow with that path exists on the repo, so apply skips it - create the workflow file, or remove it from the workflows section",
      "workflows[gone.yml]: declared in the settings file but no workflow with that path exists on the repo, so apply skips it - create the workflow file, or remove it from the workflows section",
    ]);
  });

  test("duplicate declarations for the same file are rejected before any API call", async () => {
    const api = new MockApi({});
    await expect(
      plan(api, [
        { path: "ci.yml", state: "disabled" },
        { path: ".github/workflows/ci.yml", state: "active" },
      ]),
    ).rejects.toThrow(/same workflows entry/);
    expect(api.calls).toHaveLength(0);
  });

  test("the workflows envelope paginates past the first page", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      name: `w${i}`,
      path: `.github/workflows/w${i}.yml`,
      state: "active",
    }));
    const page2 = [{ id: 100, name: "tail", path: ".github/workflows/tail.yml", state: "active" }];
    const api = new MockApi({
      "GET /repos/o/r/actions/workflows?per_page=100&page=1": {
        data: { total_count: 101, workflows: page1 },
      },
      "GET /repos/o/r/actions/workflows?per_page=100&page=2": {
        data: { total_count: 101, workflows: page2 },
      },
    });
    const result = await plan(api, [{ path: "tail.yml", state: "disabled" }]);
    expect(result.ops.map((op) => op.change)).toEqual([
      'disabled workflow ".github/workflows/tail.yml"',
    ]);
  });

  test("an envelope without the expected list key is an actionable error", async () => {
    const api = new MockApi({ [route]: { data: { unexpected: true } } });
    await expect(plan(api, [{ path: "ci.yml", state: "active" }])).rejects.toThrow(
      /"workflows" list/,
    );
  });

  test("executing the plan converges: the re-plan over applied state is empty", async () => {
    const api = liveRepo([
      { id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" },
      { id: 2, name: "Old", path: ".github/workflows/old.yml", state: "disabled_inactivity" },
      { id: 3, name: "Gone", path: ".github/workflows/gone.yml", state: "deleted" },
    ]);
    const { first, second, changes } = await provePlanIdempotent(workflowsSection, api, [
      { path: "ci.yml", state: "disabled" },
      { path: "old.yml", state: "active" },
      { path: "gone.yml", state: "active" },
    ]);
    expect(changes).toEqual([
      'disabled workflow ".github/workflows/ci.yml"',
      'enabled workflow ".github/workflows/old.yml"',
    ]);
    expect(api.writes).toEqual([
      "PUT /repos/o/r/actions/workflows/1/disable",
      "PUT /repos/o/r/actions/workflows/2/enable",
    ]);
    // The unfixable finding survives both plans unchanged.
    expect(first.drift).toHaveLength(1);
    expect(second).toEqual({ ops: [], notes: [], drift: first.drift });
  });

  test("the read port exposes exactly the list role, narrowed to its denied posture", () => {
    const ctx = planContext(workflowsSection, new MockApi({}), REPO);
    expect(Object.keys(ctx.read)).toEqual(["list"]);
    // @ts-expect-error a write role is not a read: the port has no `enable`
    ctx.read.enable;
    // @ts-expect-error nor a `disable`
    ctx.read.disable;
    // @ts-expect-error nor the raw client
    ctx.api;
    // @ts-expect-error a "denied" primary read offers no 404-tolerant helper
    ctx.read.list.probeAbsent;
    // @ts-expect-error nor the tolerant tryCall
    ctx.read.list.tryCall;
  });

  test("a planned operation can only name a declared write role, and must justify itself", () => {
    // Compile-time only: the plans are never executed. Each rejected shape
    // is built first and assigned on one line, so the directive anchors to
    // the assignment whichever property the compiler blames.
    type Op = PlannedOp<typeof workflowsSection.endpoints>;
    const enable: Op = {
      role: "enable",
      params: { workflow_id: "1" },
      drift: ["enabling"],
      change: "",
    };
    expect(enable.role).toBe("enable");
    const read = { role: "list", drift: ["x"], change: "" } as const;
    // @ts-expect-error the list role is a read, not a plannable write
    const _read: Op = read;
    const undeclared = { role: "typo", variables: {}, drift: ["x"], change: "" } as const;
    // @ts-expect-error an undeclared role, even with GraphQL variables, is not plannable
    const _undeclared: Op = undeclared;
    const paramless = { role: "disable", params: {}, drift: ["x"], change: "" } as const;
    // @ts-expect-error the route's path params are required
    const _paramless: Op = paramless;
    const silent = {
      role: "disable",
      params: { workflow_id: "1" },
      drift: [],
      change: "",
    } as const;
    // @ts-expect-error a write on a non-alwaysRewrite endpoint must carry drift
    const _silent: Op = silent;
  });
});
