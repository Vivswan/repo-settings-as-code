import { describe, expect, test } from "bun:test";
import { branchesSection } from "../../src/sections/branches.js";
import { MockApi } from "../mock-api.js";
import { ctx } from "./context.js";

describe("branches", () => {
  const declared = [{ name: "main", protection: { enforce_admins: true } }];

  test("check: existing unprotected branch reports protectable drift", async () => {
    const api = new MockApi({
      "GET /repos/o/r/branches/main": { data: { name: "main" } },
    });
    const result = await branchesSection.run(ctx(api, true), declared);
    expect(result.drift).toEqual([
      "branches[main]: unprotected live but the settings file declares protection; apply will protect it",
    ]);
  });

  test("check: missing branch is reported as nonexistent, not unprotected", async () => {
    const api = new MockApi({}); // every GET 404s, including the branch itself
    const result = await branchesSection.run(ctx(api, true), declared);
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]).toContain("does not exist");
  });

  test("check: inconclusive branch probe falls back to unprotected drift", async () => {
    const api = new MockApi({
      "GET /repos/o/r/branches/main": { error: { status: 403, message: "Forbidden", body: "" } },
    });
    const result = await branchesSection.run(ctx(api, true), declared);
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]).toContain("apply will protect it");
  });
});
