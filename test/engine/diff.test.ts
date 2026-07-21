import { describe, expect, test } from "bun:test";
import { subsetDiff } from "../../src/engine/diff.js";

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
