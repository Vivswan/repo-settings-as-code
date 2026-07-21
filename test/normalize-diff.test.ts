import { describe, expect, test } from "bun:test";
import { subsetDiff } from "../src/diff.js";
import { normalizeColor } from "../src/sections/labels.js";
import { normalizeTopics } from "../src/sections/repository.js";
import { normalizeRefName, normalizeRuleset } from "../src/sections/rulesets.js";

describe("normalizeTopics", () => {
  test("comma string", () => {
    expect(normalizeTopics("Copier, template , ,GitHub-Actions")).toEqual([
      "copier",
      "template",
      "github-actions",
    ]);
  });
  test("array and dedupe", () => {
    expect(normalizeTopics(["A", "a", "b"])).toEqual(["a", "b"]);
  });
});

describe("normalizeColor", () => {
  test("strips hash, lowercases", () => {
    expect(normalizeColor("#0366D6")).toBe("0366d6");
  });
});

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

describe("subsetDiff", () => {
  test("ignores undeclared live keys", () => {
    expect(subsetDiff({ a: 1 }, { a: 1, b: 2 }, "x")).toEqual([]);
  });
  test("reports scalar drift", () => {
    expect(subsetDiff({ a: 1 }, { a: 2 }, "x")).toEqual(["x.a: 1 != 2"]);
  });
  test("empty string equals live null", () => {
    expect(subsetDiff({ d: "" }, { d: null }, "x")).toEqual([]);
  });
  test("rules match by type, order-insensitive", () => {
    const desired = [{ type: "deletion" }, { type: "update" }];
    const live = [{ type: "update" }, { type: "deletion" }];
    expect(subsetDiff(desired, live, "rules")).toEqual([]);
  });
  test("undeclared live rule is drift", () => {
    const desired = [{ type: "deletion" }];
    const live = [{ type: "deletion" }, { type: "update" }];
    expect(subsetDiff(desired, live, "rules")).toEqual([
      "rules[update]: present live but not declared",
    ]);
  });
  test("scalar lists compare as sets", () => {
    expect(subsetDiff(["a", "b"], ["b", "a"], "x")).toEqual([]);
    expect(subsetDiff(["a"], ["a", "c"], "x")).toEqual(['x: unexpected "c"']);
  });
});
