import { describe, expect, test } from "bun:test";
import type { GithubApi } from "../src/api.js";
import {
  dedupeTargets,
  discoverRepos,
  parseReposInput,
  resolveCentralTargets,
  type Target,
} from "../src/targets.js";
import { MockApi } from "./mock-api.js";

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

describe("discoverRepos", () => {
  test("lists owned repos, skipping archived ones", async () => {
    const api = new MockApi({
      "GET /user/repos?affiliation=owner&per_page=100&page=1": {
        data: [{ full_name: "o/x" }, { full_name: "o/y", archived: true }],
      },
    });
    const discovered = await discoverRepos(api as unknown as GithubApi);
    if ("error" in discovered) {
      throw new Error(discovered.error);
    }
    expect(discovered.slugs).toEqual(["o/x"]);
    expect(discovered.archivedSkipped).toEqual(["o/y"]);
  });

  test("a denied listing explains the PAT requirement", async () => {
    const api = new MockApi({
      "GET /user/repos?affiliation=owner&per_page=100&page=1": {
        error: { status: 403, message: "Resource not accessible", body: "" },
      },
    });
    const discovered = await discoverRepos(api as unknown as GithubApi);
    expect("error" in discovered && discovered.error).toContain("Discovery needs a user PAT");
  });
});

describe("dedupeTargets", () => {
  test("central wins over remote for the same repo, with a notice", () => {
    const central: Target[] = [
      { slug: "o/x", source: "central", origin: "repos/x.yml", filePath: "repos/x.yml" },
    ];
    const remote: Target[] = [
      { slug: "O/X", source: "remote", origin: 'the "repos" input' },
      { slug: "o/z", source: "remote", origin: 'the "repos" input' },
    ];
    const notices: string[] = [];
    const merged = dedupeTargets(central, remote, (m) => notices.push(m));
    expect(merged.map((t) => t.slug)).toEqual(["o/x", "o/z"]);
    expect(notices[0]).toContain("using the central file repos/x.yml");
  });
});
