import { describe, expect, test } from "bun:test";
import { executePlan } from "../../../src/engine/execute.js";
import type { GithubClient } from "../../../src/github/api.js";
import { MockApi } from "../../../test/mock-api.js";
import { provePlanIdempotent } from "../../../test/sections/plan-idempotence.js";
import { REPO } from "../../../test/sections/section-run.js";
import { type PlannedOp, planContext } from "../contract/plan.js";
import { variableKey } from "../shared/variables-engine.js";
import { actionsVariablesSection } from "./index.js";

describe("variableKey", () => {
  test("uppercases (GitHub stores variable names uppercased)", () => {
    expect(variableKey("deploy_region")).toBe("DEPLOY_REGION");
  });
});

type Declared = Parameters<typeof actionsVariablesSection.plan>[1];

/** The enveloped list body the mock serves for a live variable set. */
function listRoute(variables: Array<{ name: string; value: string }>) {
  return {
    "GET /repos/o/r/actions/variables?per_page=30&page=1": {
      data: { total_count: variables.length, variables },
    },
  };
}

const plan = (api: GithubClient, declared: Declared) =>
  actionsVariablesSection.plan(planContext(actionsVariablesSection, api, REPO), declared);

/** Plan, then execute against the same client; a failed execution rethrows its error. */
async function apply(api: GithubClient, declared: Declared) {
  const planned = await plan(api, declared);
  const execution = await executePlan(planned, actionsVariablesSection, api, REPO, {
    resolveSecret: () => {
      throw new Error("variables carry no secrets");
    },
  });
  if (execution.status === "failed") {
    throw execution.error;
  }
  return { plan: planned, changes: execution.changes };
}

/** A stateful fake: the list reflects every write, so a re-plan sees converged state. */
function liveRepo(
  variables: Array<{ name: string; value: string }>,
): GithubClient & { writes: string[] } {
  return {
    writes: [],
    async tryRequest(method, path, payload) {
      if (method === "GET") {
        return { data: { total_count: variables.length, variables } };
      }
      const body = payload as { name?: string; value: string };
      const name = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
      if (method === "POST") {
        variables.push({ name: variableKey(body.name ?? ""), value: body.value });
      } else if (method === "PATCH") {
        const target = variables.find((v) => v.name === name);
        if (target === undefined) {
          return { error: { status: 404, message: "Not Found", body: "" } };
        }
        target.value = body.value;
      } else {
        variables.splice(
          variables.findIndex((v) => v.name === name),
          1,
        );
      }
      this.writes.push(`${method} ${path}`);
      return { data: null };
    },
    async tryGraphql() {
      throw new Error("the actions_variables section issues no GraphQL");
    },
  };
}

describe("actions_variables", () => {
  const liveVariables = [
    { name: "DEPLOY_REGION", value: "us-east-1" },
    { name: "RETIRED_FLAG", value: "off" },
  ];

  test("plans an update for a drifted value, a create for a missing one, a delete for an undeclared one", async () => {
    const api = new MockApi(listRoute(liveVariables));
    const result = await plan(api, [
      { name: "DEPLOY_REGION", value: "eu-west-1" },
      { name: "BUILD_MODE", value: "release" },
    ]);
    expect(result).toEqual({
      ops: [
        {
          role: "update",
          params: { name: "DEPLOY_REGION" },
          // The update sends the value only.
          payload: { value: "eu-west-1" },
          drift: [
            'actions_variables[DEPLOY_REGION].value: declared "eu-west-1" != live "us-east-1"; apply will set the declared value',
          ],
          change: 'updated Actions variable "DEPLOY_REGION"',
        },
        {
          role: "create",
          // The create sends name + value.
          payload: { name: "BUILD_MODE", value: "release" },
          drift: [
            "actions_variables[BUILD_MODE]: missing - declared in the settings file but not on the repo; apply will create it",
          ],
          change: 'created Actions variable "BUILD_MODE"',
        },
        {
          role: "remove",
          params: { name: "RETIRED_FLAG" },
          drift: [
            "actions_variables[RETIRED_FLAG]: undeclared - not in the settings file, so apply will DELETE it; add it to the settings file to keep it",
          ],
          change: 'DELETED undeclared Actions variable "RETIRED_FLAG"',
        },
      ],
      notes: [],
      drift: [],
    });
    // Planning reads and never writes.
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /repos/o/r/actions/variables?per_page=30&page=1",
    ]);
  });

  test("executing the plan converges: the re-plan over applied state is empty", async () => {
    const api = liveRepo([
      { name: "DEPLOY_REGION", value: "us-east-1" },
      { name: "RETIRED_FLAG", value: "off" },
    ]);
    const { second, changes } = await provePlanIdempotent(actionsVariablesSection, api, [
      { name: "deploy_region", value: "eu-west-1" },
      { name: "BUILD_MODE", value: "release" },
    ]);
    expect(changes).toEqual([
      'updated Actions variable "deploy_region"',
      'created Actions variable "BUILD_MODE"',
      'DELETED undeclared Actions variable "RETIRED_FLAG"',
    ]);
    // The update PATCHes the LIVE (uppercase) name even when declared lowercase.
    expect(api.writes).toEqual([
      "PATCH /repos/o/r/actions/variables/DEPLOY_REGION",
      "POST /repos/o/r/actions/variables",
      "DELETE /repos/o/r/actions/variables/RETIRED_FLAG",
    ]);
    expect(second).toEqual({ ops: [], notes: [], drift: [] });
  });

  test("matches names case-insensitively: a lowercase declaration converges against the uppercase live name", async () => {
    const api = new MockApi(listRoute(liveVariables));
    const result = await plan(api, [
      { name: "deploy_region", value: "us-east-1" },
      { name: "Retired_Flag", value: "off" },
    ]);
    expect(result).toEqual({ ops: [], notes: [], drift: [] });
  });

  test("two entries differing only in case are rejected before any API call", async () => {
    const api = new MockApi({});
    await expect(
      plan(api, [
        { name: "deploy_region", value: "a" },
        { name: "DEPLOY_REGION", value: "b" },
      ]),
    ).rejects.toThrow(/same actions_variables entry/);
    expect(api.calls).toHaveLength(0);
  });

  test("wrapped undeclared:keep leaves the undeclared variable as a note, never a DELETE", async () => {
    const api = new MockApi(listRoute(liveVariables));
    const result = await plan(api, {
      undeclared: "keep",
      entries: [{ name: "DEPLOY_REGION", value: "us-east-1" }],
    });
    expect(result).toEqual({
      ops: [],
      notes: [
        'Actions variable "RETIRED_FLAG" exists on the repo but is not declared in the settings file; kept under "undeclared: keep" - add it to the settings file to manage it, or set "undeclared: delete" to have apply DELETE it',
      ],
      drift: [],
    });
  });

  test("the wrapper without a policy keeps the delete default; an explicit delete says the same", async () => {
    const entries = [{ name: "DEPLOY_REGION", value: "us-east-1" }];
    const implicit = await plan(new MockApi(listRoute(liveVariables)), { entries });
    const explicit = await plan(new MockApi(listRoute(liveVariables)), {
      undeclared: "delete",
      entries,
    });
    expect(implicit.ops.map((op) => [op.role, op.change])).toEqual([
      ["remove", 'DELETED undeclared Actions variable "RETIRED_FLAG"'],
    ]);
    expect(explicit).toEqual(implicit);
  });

  test("url-encodes tricky live names in the request path", async () => {
    const api = new MockApi(listRoute([{ name: "ODD NAME", value: "x" }])).allowMutations(
      "PATCH /repos/o/r/actions/variables/*",
    );
    const { changes } = await apply(api, [{ name: "ODD NAME", value: "y" }]);
    expect(changes).toEqual(['updated Actions variable "ODD NAME"']);
    expect(api.mutations()[0]?.path).toBe("/repos/o/r/actions/variables/ODD%20NAME");
  });

  test("the list request asks for the endpoint's 30-per-page cap", async () => {
    // The variables list caps per_page at 30; a 100 would be silently clamped
    // and a 30-item first page would wrongly end the walk. The second page
    // proves the loop continues past a FULL page of 30.
    const page1 = Array.from({ length: 30 }, (_, i) => ({ name: `VAR_${i}`, value: "x" }));
    const api = new MockApi({
      "GET /repos/o/r/actions/variables?per_page=30&page=1": {
        data: { total_count: 31, variables: page1 },
      },
      "GET /repos/o/r/actions/variables?per_page=30&page=2": {
        data: { total_count: 31, variables: [{ name: "VAR_30", value: "x" }] },
      },
    });
    const result = await plan(api, page1.concat([{ name: "VAR_30", value: "x" }]));
    expect(result).toEqual({ ops: [], notes: [], drift: [] });
    expect(api.calls.map((c) => c.path)).toEqual([
      "/repos/o/r/actions/variables?per_page=30&page=1",
      "/repos/o/r/actions/variables?per_page=30&page=2",
    ]);
  });

  test("a declared key the live variable does not carry drifts, and its update carries the phantom note", async () => {
    const api = new MockApi(listRoute([{ name: "DEPLOY_REGION", value: "us-east-1" }]));
    const result = await plan(api, [
      { name: "DEPLOY_REGION", value: "us-east-1", vaule: "typo" } as never,
    ]);
    expect(result.ops.map((op) => [op.role, op.payload, op.drift])).toEqual([
      [
        "update",
        { value: "us-east-1", vaule: "typo" },
        [
          'actions_variables[DEPLOY_REGION].vaule: declared "typo" but the API response has no such field (new or write-only field?)',
        ],
      ],
    ]);
    expect(result.notes).toEqual([
      expect.stringMatching(
        /actions_variables\[DEPLOY_REGION\]: declared key\(s\) "vaule" do not exist on the live variable.*without converging/,
      ),
    ]);
  });

  test("the read port exposes exactly the list role, narrowed to its denied posture", () => {
    const ctx = planContext(actionsVariablesSection, new MockApi({}), REPO);
    expect(Object.keys(ctx.read)).toEqual(["list"]);
    // @ts-expect-error a write role is not a read: the port has no `create`
    ctx.read.create;
    // @ts-expect-error nor an `update`
    ctx.read.update;
    // @ts-expect-error nor a `remove`
    ctx.read.remove;
    // @ts-expect-error nor the raw client
    ctx.api;
    // @ts-expect-error a "denied" primary read offers no 404-tolerant helper
    ctx.read.list.probeAbsent;
  });

  test("a planned operation can only name a declared write role, and must justify itself", () => {
    // Compile-time only: the plans are never executed.
    type Op = PlannedOp<typeof actionsVariablesSection.endpoints>;
    const create: Op = {
      role: "create",
      payload: { name: "A", value: "1" },
      drift: ["x"],
      change: "",
    };
    expect(create.role).toBe("create");
    const read = { role: "list", drift: ["x"], change: "" } as const;
    // @ts-expect-error the list role is a read, not a plannable write
    const _read: Op = read;
    const silent = {
      role: "update",
      params: { name: "A" },
      payload: {},
      drift: [],
      change: "",
    } as const;
    // @ts-expect-error no variable write is alwaysRewrite, so every one must carry drift
    const _silent: Op = silent;
    const nameless = { role: "remove", params: {}, drift: ["x"], change: "" } as const;
    // @ts-expect-error the route's {name} param is required
    const _nameless: Op = nameless;
  });
});
