import { describe, expect, test } from "bun:test";
import { parseReposInput } from "../../src/discovery/repos-input.js";

describe("parseReposInput", () => {
  test("splits on commas and newlines", () => {
    const parsed = parseReposInput("o/a, o/b\no/c");
    expect("slugs" in parsed && parsed.slugs).toEqual(["o/a", "o/b", "o/c"]);
  });

  test("* alone switches to discovery", () => {
    const parsed = parseReposInput("*");
    expect("discover" in parsed && parsed.discover).toBe(true);
  });

  test("* mixed with slugs is an error", () => {
    const parsed = parseReposInput("*, o/a");
    expect("error" in parsed && parsed.error).toContain('"*" alone');
  });

  test("bad slug and duplicates are errors", () => {
    expect("error" in parseReposInput("not-a-slug")).toBe(true);
    const dup = parseReposInput("o/a, O/A");
    expect("error" in dup && dup.error).toContain("more than once");
  });
});
