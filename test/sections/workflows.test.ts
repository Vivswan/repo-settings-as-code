import { describe, expect, test } from "bun:test";
import { workflowsSection } from "../../src/sections/workflows.js";
import { MockApi } from "../mock-api.js";
import { ctx } from "./context.js";

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

  test("enables and disables by live id, matching bare file names", async () => {
    const api = new MockApi({ [route]: { data: liveWorkflows } }).allowMutations(
      "PUT /repos/o/r/actions/workflows/*",
    );
    const result = await workflowsSection.run(ctx(api), [
      { path: "ci.yml", state: "disabled" },
      { path: ".github/workflows/old.yml", state: "active" },
    ]);
    expect(result.changes).toEqual([
      'disabled workflow ".github/workflows/ci.yml"',
      'enabled workflow ".github/workflows/old.yml"',
    ]);
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "PUT /repos/o/r/actions/workflows/1/disable",
      "PUT /repos/o/r/actions/workflows/2/enable",
    ]);
  });

  test("matching state means no mutation; undeclared workflows stay silent", async () => {
    const api = new MockApi({ [route]: { data: liveWorkflows } });
    const result = await workflowsSection.run(ctx(api), [{ path: "ci.yml", state: "active" }]);
    expect(result.changes).toEqual([]);
    expect(result.notes).toEqual([]);
    expect(api.mutations()).toEqual([]);
  });

  test("check reports drift with the raw live state", async () => {
    const api = new MockApi({ [route]: { data: liveWorkflows } });
    const result = await workflowsSection.run(ctx(api, true), [
      { path: "old.yml", state: "active" },
    ]);
    expect(result.drift).toEqual([
      'workflows[old.yml]: declared "active" != live "disabled" (disabled_inactivity); apply will enable the workflow',
    ]);
    expect(api.mutations()).toEqual([]);
  });

  test("a declared path with no live workflow drifts in check and notes in apply", async () => {
    const api = new MockApi({ [route]: { data: liveWorkflows } });
    const check = await workflowsSection.run(ctx(api, true), [
      { path: "nope.yml", state: "disabled" },
    ]);
    expect(check.drift).toHaveLength(1);
    expect(check.drift[0]).toContain("no workflow with that path exists");
    // A live "deleted" workflow counts as absent too.
    const apply = await workflowsSection.run(ctx(api), [{ path: "gone.yml", state: "active" }]);
    expect(apply.notes).toHaveLength(1);
    expect(apply.changes).toEqual([]);
    expect(api.mutations()).toEqual([]);
  });

  test("duplicate declarations for the same file are rejected before any API call", async () => {
    const api = new MockApi({});
    await expect(
      workflowsSection.run(ctx(api), [
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
    }).allowMutations("PUT /repos/o/r/actions/workflows/*");
    const result = await workflowsSection.run(ctx(api), [{ path: "tail.yml", state: "disabled" }]);
    expect(result.changes).toEqual(['disabled workflow ".github/workflows/tail.yml"']);
  });

  test("an envelope without the expected list key is an actionable error", async () => {
    const api = new MockApi({
      [route]: { data: { unexpected: true } },
    });
    await expect(
      workflowsSection.run(ctx(api), [{ path: "ci.yml", state: "active" }]),
    ).rejects.toThrow(/"workflows" list/);
  });
});
