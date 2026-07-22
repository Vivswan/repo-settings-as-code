import { describe, expect, test } from "bun:test";
import {
  normalizeRefName,
  normalizeRuleset,
  rulesetsSection,
} from "../../src/sections/rulesets.js";
import { MockApi } from "../mock-api.js";
import { ctx } from "./context.js";

describe("normalizeRefName", () => {
  test("branch short name", () => {
    expect(normalizeRefName("staging", "branch")).toBe("refs/heads/staging");
  });
  test("tag pattern", () => {
    expect(normalizeRefName("templates/*", "tag")).toBe("refs/tags/templates/*");
  });
  test("~DEFAULT_BRANCH passthrough", () => {
    expect(normalizeRefName("~DEFAULT_BRANCH", "branch")).toBe("~DEFAULT_BRANCH");
  });
  test("qualified ref passthrough", () => {
    expect(normalizeRefName("refs/heads/main", "branch")).toBe("refs/heads/main");
  });
});

describe("normalizeRuleset", () => {
  test("normalizes includes without mutating input", () => {
    const input = {
      name: "build-tags",
      target: "tag" as const,
      conditions: { ref_name: { include: ["templates/*", "v*"], exclude: [] } },
    };
    const out = normalizeRuleset(input);
    expect(out.conditions?.ref_name?.include).toEqual(["refs/tags/templates/*", "refs/tags/v*"]);
    expect(input.conditions.ref_name.include).toEqual(["templates/*", "v*"]);
  });
});

describe("rulesets", () => {
  test("creates missing with normalized refs, never deletes undeclared", async () => {
    const api = new MockApi({
      "GET /repos/o/r/rulesets?per_page=100&page=1": {
        data: [{ id: 7, name: "legacy", source_type: "Repository" }],
      },
    }).allowMutations("POST /repos/o/r/rulesets");
    const result = await rulesetsSection.run(ctx(api), [
      {
        name: "build-tags",
        target: "tag",
        enforcement: "active",
        conditions: { ref_name: { include: ["templates/*"], exclude: [] } },
        rules: [{ type: "deletion" }],
      },
    ]);
    expect(result.changes).toEqual(['created ruleset "build-tags"']);
    expect(result.notes).toEqual([
      'ruleset "legacy" exists on the repo but is not declared in the settings file; left untouched - add it to the settings file to manage it, or delete it in the repo\'s GitHub settings',
    ]);
    const post = api.mutations()[0];
    expect(post?.method).toBe("POST");
    const payload = post?.payload as { conditions: { ref_name: { include: string[] } } };
    expect(payload.conditions.ref_name.include).toEqual(["refs/tags/templates/*"]);
  });

  test("updates by name with full payload", async () => {
    const api = new MockApi({
      "GET /repos/o/r/rulesets?per_page=100&page=1": {
        data: [{ id: 9, name: "main", source_type: "Repository" }],
      },
    }).allowMutations("PUT /repos/o/r/rulesets/*");
    const result = await rulesetsSection.run(ctx(api), [
      { name: "main", target: "branch", rules: [{ type: "deletion" }] },
    ]);
    expect(result.changes).toEqual(['updated ruleset "main" (id 9)']);
    expect(api.mutations()[0]?.path).toBe("/repos/o/r/rulesets/9");
  });

  test("ruleset create defaults enforcement", async () => {
    const api = new MockApi({
      "GET /repos/o/r/rulesets?per_page=100&page=1": { data: [] },
    }).allowMutations("POST /repos/o/r/rulesets");
    await rulesetsSection.run(ctx(api), [{ name: "x", target: "branch" }]);
    const payload = api.mutations()[0]?.payload as { enforcement?: string };
    expect(payload.enforcement).toBe("active");
  });

  test("duplicate ruleset names are rejected before any API call", async () => {
    const api = new MockApi({});
    await expect(
      rulesetsSection.run(ctx(api), [
        { name: "main", target: "branch" },
        { name: "main", target: "tag" },
      ]),
    ).rejects.toThrow(/same rulesets entry/);
    expect(api.calls).toHaveLength(0);
  });
});
