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

  test("the fields handlers dereference are shape-checked, naming the key path", () => {
    // A missing "-" makes include a string; the handler would call .map on it.
    const include = validateSectionShapes(
      { rulesets: [{ name: "protect-main", conditions: { ref_name: { include: "main" } } }] },
      "f.yml",
    );
    expect(include).toContain("rulesets[0].conditions.ref_name.include");
    // YAML parses new_name: 2.0 as a number; the handler lowercases it.
    const rename = validateSectionShapes({ labels: [{ name: "v2", new_name: 2 }] }, "f.yml");
    expect(rename).toContain("labels[0].new_name");
    // The handler reads source.path, which throws on source: null.
    const source = validateSectionShapes({ pages: { source: null } }, "f.yml");
    expect(source).toContain("pages.source");
    // The happy shapes still pass, unknown keys still flow through.
    expect(
      validateSectionShapes(
        {
          rulesets: [{ name: "r", conditions: { ref_name: { include: ["main"] } }, future: 1 }],
          labels: [{ name: "v2", new_name: "2.0" }],
          pages: { source: { branch: "main" }, future_field: true },
        },
        "f.yml",
      ),
    ).toBeNull();
  });
});
