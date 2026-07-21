import { describe, expect, test } from "bun:test";
import { resolveCentralTargets } from "../../src/discovery/central.js";

describe("resolveCentralTargets", () => {
  test("reads owner-shorthand and owner/name files, warns on strays", () => {
    const resolved = resolveCentralTargets("test/fixtures/repos", "viv");
    if ("error" in resolved) {
      throw new Error(resolved.error);
    }
    expect(resolved.targets.map((t) => t.slug).sort()).toEqual(["octo/web", "viv/api"]);
    expect(resolved.warnings.some((w) => w.includes("README.md"))).toBe(true);
    expect(resolved.warnings.some((w) => w.includes("deep"))).toBe(true);
  });

  test("shorthand without a known admin owner is an error", () => {
    const resolved = resolveCentralTargets("test/fixtures/repos", "");
    expect("error" in resolved && resolved.error).toContain("<owner>/<name>.yml");
  });

  test("the same repo defined twice is an error", () => {
    const resolved = resolveCentralTargets("test/fixtures/repos-dup", "viv");
    expect("error" in resolved && resolved.error).toContain("duplicate target viv/x");
  });

  test("missing dir errors with a checkout hint", () => {
    const resolved = resolveCentralTargets("test/fixtures/nope", "viv");
    expect("error" in resolved && resolved.error).toContain("actions/checkout");
  });
});
