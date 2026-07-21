import { describe, expect, test } from "bun:test";
import { validateSectionShapes } from "../../src/engine/validate.js";

describe("section shape validation", () => {
  test("pages: null passes; a bad workflows state fails naming the path", () => {
    expect(validateSectionShapes({ pages: null }, "f.yml")).toBeNull();
    const error = validateSectionShapes(
      { workflows: [{ path: "ci.yml", state: "paused" }] },
      "f.yml",
    );
    expect(error).toContain("workflows[0].state");
  });
});
