import { describe, expect, test } from "bun:test";
import { executePlan } from "../../../src/engine/execute.js";
import {
  type PlannedOp,
  planContext,
  type SectionPlan,
} from "../../../src/sections/contract/plan.js";
import { MockApi } from "../../../test/mock-api.js";
import { provePlanIdempotent } from "../../../test/sections/plan-idempotence.js";
import { REPO } from "../../../test/sections/section-run.js";
import { checkSuitePreferencesSection } from "./index.js";

describe("check_suite_preferences", () => {
  const path = "/repos/o/r/check-suites/preferences";
  const declared = {
    auto_trigger_checks: [
      { app_id: 15368, setting: false },
      { app_id: 29310, setting: true },
    ],
  };
  const note =
    "check_suite_preferences: GitHub exposes no read endpoint for check suite preferences, so check mode cannot verify them; apply re-asserts the declared preferences on every run";
  const plan = (api: MockApi, desired: Parameters<typeof checkSuitePreferencesSection.plan>[1]) =>
    checkSuitePreferencesSection.plan(
      planContext(checkSuitePreferencesSection, api, REPO),
      desired,
    );
  /** The change line the plan's one operation renders for a PATCH response. */
  const rendered = (of: SectionPlan, response: unknown): string => {
    const change = of.ops[0]?.change;
    if (typeof change !== "function") {
      throw new Error("the plan carries no change thunk to render");
    }
    return String(change(response));
  };

  test("the plan is one driftless PATCH of the declared payload plus the cannot-verify note, and issues no request", async () => {
    // The fake would accept the PATCH; planning must not reach for it.
    const api = new MockApi({}).allowMutations(`PATCH ${path}`);
    const result = await plan(api, declared);
    expect(result).toEqual({
      ops: [
        {
          role: "update",
          payload: declared,
          describe: "setting check suite preferences",
          drift: [],
          change: expect.any(Function),
        },
      ],
      notes: [note],
      drift: [],
    });
    expect(api.calls).toEqual([]);
    // The change line counts the ECHOED entries: three against two declared
    // can only come from GitHub's post-state, so the fallback cannot be what
    // rendered it. A shapeless echo falls back to the declared list.
    expect(
      rendered(result, {
        preferences: { auto_trigger_checks: [...declared.auto_trigger_checks, { app_id: 1 }] },
        repository: { full_name: "o/r" },
      }),
    ).toBe("applied check suite preferences (3 auto_trigger_checks entries)");
    expect(rendered(result, null)).toBe(
      "applied check suite preferences (2 auto_trigger_checks entries)",
    );
    const single = await plan(api, { auto_trigger_checks: [{ app_id: 15368, setting: true }] });
    expect(rendered(single, {})).toBe(
      "applied check suite preferences (1 auto_trigger_checks entry)",
    );
  });

  test("executing the plan PATCHes the payload verbatim, and the write recurs on every pass", async () => {
    const api = new MockApi({
      [`PATCH ${path}`]: {
        data: { preferences: declared, repository: { full_name: "o/r" } },
      },
    });
    const { first, second, changes, notes } = await provePlanIdempotent(
      checkSuitePreferencesSection,
      api,
      declared,
    );
    expect(changes).toEqual(["applied check suite preferences (2 auto_trigger_checks entries)"]);
    expect(notes).toEqual([]);
    expect(second.ops.map((op) => op.role)).toEqual(["update"]);
    expect(second.notes).toEqual(first.notes);
    // Both executions (the proof also runs the converged plan) sent the
    // declaration verbatim; nothing was ever read.
    expect(api.calls).toEqual([
      { method: "PATCH", path, payload: declared },
      { method: "PATCH", path, payload: declared },
    ]);
  });

  test("a denied PATCH names the Checks grant and the repo-admin caveat", async () => {
    const denied = new MockApi({
      [`PATCH ${path}`]: { error: { status: 403, message: "Forbidden", body: "" } },
    });
    const planned = await plan(denied, declared);
    const execution = await executePlan(planned, checkSuitePreferencesSection, denied, REPO, {
      resolveSecret: () => {
        throw new Error("the section declares no secret values");
      },
    });
    expect(execution.status).toBe("failed");
    const message = execution.status === "failed" ? (execution.error as Error).message : "";
    expect(message).toMatch(/"Checks" \(read and write\)/);
    expect(message).toMatch(/repository administrator/);
    expect(execution.landed).toBe(0);
  });

  test("the read port is empty, and only the PATCH is plannable - driftless by declaration", () => {
    const ctx = planContext(checkSuitePreferencesSection, new MockApi({}), REPO);
    expect(Object.keys(ctx.read)).toEqual([]);
    // @ts-expect-error a write role is not a read: the port has no `update`
    ctx.read.update;
    // @ts-expect-error nor the raw client
    ctx.api;
    // Compile-time only: the operations are never executed. Each rejected
    // shape is built first and assigned on one line, so the directive
    // anchors to the assignment whichever property the compiler blames.
    type Op = PlannedOp<typeof checkSuitePreferencesSection.endpoints>;
    const rewrite: Op = { role: "update", payload: declared, drift: [], change: "" };
    expect(rewrite.drift).toEqual([]);
    const undeclared = { role: "typo", drift: ["x"], change: "" } as const;
    // @ts-expect-error an undeclared role is not plannable
    const _undeclared: Op = undeclared;
    const parametrized = { role: "update", params: { name: "x" }, drift: [], change: "" } as const;
    // @ts-expect-error the route has no path params beyond owner/repo
    const _parametrized: Op = parametrized;
  });
});
