import { describe, expect, test } from "bun:test";
import { actionsSection } from "../../src/sections/actions.js";
import { MockApi } from "../mock-api.js";
import { ctx } from "./context.js";

const ACTIONS_WRITES = [
  "PUT /repos/o/r/actions/permissions",
  "PUT /repos/o/r/actions/permissions/*",
];

describe("actions", () => {
  test("routes every key to its endpoint, access_level included", async () => {
    const api = new MockApi({}).allowMutations(...ACTIONS_WRITES);
    const result = await actionsSection.run(ctx(api), {
      enabled: true,
      allowed_actions: "selected",
      selected_actions: { github_owned_allowed: true },
      default_workflow_permissions: "read",
      access_level: "organization",
    });
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "PUT /repos/o/r/actions/permissions",
      "PUT /repos/o/r/actions/permissions/selected-actions",
      "PUT /repos/o/r/actions/permissions/workflow",
      "PUT /repos/o/r/actions/permissions/access",
    ]);
    const base = api.mutations()[0]?.payload as Record<string, unknown>;
    expect("access_level" in base).toBe(false);
    expect(api.mutations()[3]?.payload).toEqual({ access_level: "organization" });
    expect(result.notes).toEqual([]);
  });

  test("check compares access_level against its own endpoint", async () => {
    const api = new MockApi({
      "GET /repos/o/r/actions/permissions/access": { data: { access_level: "none" } },
    });
    const result = await actionsSection.run(ctx(api, true), { access_level: "organization" });
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]).toContain("actions.access.access_level");
    expect(api.mutations()).toEqual([]);
  });

  test("any base-permissions key implies enabled: true in the PUT body", async () => {
    const api = new MockApi({}).allowMutations(...ACTIONS_WRITES);
    await actionsSection.run(ctx(api), { allowed_actions: "all" });
    expect(api.mutations()[0]?.payload).toEqual({ allowed_actions: "all", enabled: true });
    const future = new MockApi({}).allowMutations(...ACTIONS_WRITES);
    await actionsSection.run(ctx(future), { some_future_key: "x" });
    const payload = future.mutations()[0]?.payload as Record<string, unknown>;
    expect(payload.enabled).toBe(true);
  });

  test("the unrecognized-key note reports the enabled value and matches the mode", async () => {
    const apply = new MockApi({}).allowMutations(...ACTIONS_WRITES);
    const applied = await actionsSection.run(ctx(apply), { some_future_key: "x" });
    expect(applied.notes).toHaveLength(1);
    expect(applied.notes[0]).toContain("enabled: true");
    expect(applied.notes[0]).toContain("were sent verbatim");
    const explicitOff = new MockApi({}).allowMutations(...ACTIONS_WRITES);
    const off = await actionsSection.run(ctx(explicitOff), {
      enabled: false,
      some_future_key: "x",
    });
    expect(off.notes[0]).toContain("enabled: false");
    const check = new MockApi({
      "GET /repos/o/r/actions/permissions": { data: { enabled: true } },
    });
    const checked = await actionsSection.run(ctx(check, true), { some_future_key: "x" });
    expect(checked.notes).toHaveLength(1);
    expect(checked.notes[0]).toContain("enabled: true");
    expect(checked.notes[0]).toContain("would send");
    expect(check.mutations()).toEqual([]);
  });

  test("selected-actions check treats a 409 as drift, not failure", async () => {
    const api = new MockApi({
      "GET /repos/o/r/actions/permissions": { data: { enabled: true, allowed_actions: "all" } },
      "GET /repos/o/r/actions/permissions/selected-actions": {
        error: { status: 409, message: "Conflict", body: "" },
      },
    });
    const result = await actionsSection.run(ctx(api, true), {
      allowed_actions: "selected",
      selected_actions: { github_owned_allowed: true },
    });
    expect(result.drift.some((d) => d.includes('not "selected"'))).toBe(true);
    expect(api.mutations()).toEqual([]);
  });

  test("selected_actions implies allowed_actions: selected and rejects contradictions", async () => {
    const api = new MockApi({}).allowMutations(...ACTIONS_WRITES);
    await actionsSection.run(ctx(api), { selected_actions: { github_owned_allowed: true } });
    const base = api.mutations()[0]?.payload as Record<string, unknown>;
    expect(base.allowed_actions).toBe("selected");
    await expect(
      actionsSection.run(ctx(new MockApi({}).allowMutations(...ACTIONS_WRITES)), {
        allowed_actions: "all",
        selected_actions: { github_owned_allowed: true },
      }),
    ).rejects.toThrow(/allowed_actions/);
  });
});
