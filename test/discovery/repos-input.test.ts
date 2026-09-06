import { describe, expect, test } from "bun:test";
import { parseReposInput } from "../../src/discovery/repos-input.js";

describe("parseReposInput", () => {
  test("splits on commas and newlines", () => {
    expect(parseReposInput("o/a, o/b\no/c")).toEqual({
      slugs: ["o/a", "o/b", "o/c"],
      discover: false,
    });
  });

  test("* alone switches to discovery", () => {
    expect(parseReposInput("*")).toEqual({ slugs: [], discover: true });
  });

  test("* mixed with slugs is an error", () => {
    expect(parseReposInput("*, o/a")).toEqual({
      error: expect.stringContaining('Use "*" alone to discover every repository'),
    });
  });

  test("bad slugs and duplicates are reported once, together, with counts", () => {
    expect(parseReposInput("not-a-slug")).toEqual({
      error:
        'the "repos" input has 1 invalid entry: "not-a-slug" is not an owner/name slug (use values like "octocat/hello-world", comma- or newline-separated). Or use "*" alone to discover repositories',
    });
    expect(parseReposInput("o/a, O/A, bad, bad, worse")).toEqual({
      error:
        'the "repos" input has 3 invalid entries: "bad", "worse" are not owner/name slugs (use ' +
        'values like "octocat/hello-world", comma- or newline-separated); "O/A" is listed more ' +
        'than once (keep exactly one entry per repository). Or use "*" alone to discover ' +
        "repositories",
    });
  });
});
