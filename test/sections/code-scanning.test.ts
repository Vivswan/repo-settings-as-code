import { describe, expect, test } from "bun:test";
import { codeScanningDefaultSetupSection } from "../../src/sections/code-scanning.js";
import { MockApi } from "../mock-api.js";
import { ctx } from "./context.js";

describe("code_scanning_default_setup", () => {
  const path = "/repos/o/r/code-scanning/default-setup";
  const live = {
    state: "configured",
    query_suite: "default",
    languages: ["javascript-typescript", "python"],
  };

  test("check compares declared keys only, languages as a set", async () => {
    const api = new MockApi({ [`GET ${path}`]: { data: live } });
    const drifted = await codeScanningDefaultSetupSection.run(ctx(api, true), {
      state: "configured",
      query_suite: "extended",
    });
    expect(drifted.drift).toHaveLength(1);
    expect(drifted.drift[0]).toContain("query_suite");
    const reordered = await codeScanningDefaultSetupSection.run(ctx(api, true), {
      languages: ["python", "javascript-typescript"],
    });
    expect(reordered.drift).toEqual([]);
    expect(api.mutations()).toEqual([]);
  });

  test("apply PATCHes the declared payload verbatim", async () => {
    const api = new MockApi({}).allowMutations(`PATCH ${path}`);
    const result = await codeScanningDefaultSetupSection.run(ctx(api), {
      state: "configured",
      query_suite: "extended",
    });
    expect(result.changes).toEqual(["applied code scanning default setup"]);
    expect(api.mutations()).toEqual([
      {
        method: "PATCH",
        path,
        payload: { state: "configured", query_suite: "extended" },
      },
    ]);
  });

  test("a 202 configuration run is named in the change line", async () => {
    const api = new MockApi({
      [`PATCH ${path}`]: { data: { run_id: 42, run_url: "https://example.test/runs/42" } },
    });
    const result = await codeScanningDefaultSetupSection.run(ctx(api), { state: "configured" });
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toContain("configuration run 42");
  });

  test("409 gets wait-and-retry advice; 403 mentions Advanced Security", async () => {
    const busy = new MockApi({
      [`PATCH ${path}`]: { error: { status: 409, message: "Conflict", body: "" } },
    });
    await expect(
      codeScanningDefaultSetupSection.run(ctx(busy), { state: "configured" }),
    ).rejects.toThrow(/already in progress/);
    const denied = new MockApi({
      [`PATCH ${path}`]: { error: { status: 403, message: "Forbidden", body: "" } },
    });
    await expect(
      codeScanningDefaultSetupSection.run(ctx(denied), { state: "configured" }),
    ).rejects.toThrow(/Advanced Security/);
  });
});
