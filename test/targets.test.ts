import { describe, expect, test } from "bun:test";
import type { GithubApi } from "../src/api.js";
import {
  DEFAULT_DISCOVERY_FILTERS,
  type DiscoveryFilters,
  dedupeTargets,
  discoverRepos,
  excludeMatches,
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

describe("excludeMatches", () => {
  test("* spans any characters, anchored at both ends", () => {
    expect(excludeMatches("tmp-*", "o/tmp-x")).toBe(true);
    expect(excludeMatches("tmp", "o/tmp-x")).toBe(false);
    expect(excludeMatches("*-archive", "o/old-archive")).toBe(true);
  });

  test("regex metacharacters are literal", () => {
    expect(excludeMatches("a.b", "o/a.b")).toBe(true);
    expect(excludeMatches("a.b", "o/axb")).toBe(false);
  });

  test("matching is case-insensitive", () => {
    expect(excludeMatches("TMP-*", "o/tmp-x")).toBe(true);
  });

  test("a pattern with a slash matches the full slug, otherwise the name", () => {
    expect(excludeMatches("octo/*", "octo/anything")).toBe(true);
    expect(excludeMatches("octo/*", "viv/anything")).toBe(false);
    expect(excludeMatches("web*", "weborg/api")).toBe(false);
    expect(excludeMatches("web*", "anyowner/web-x")).toBe(true);
  });
});

describe("discoverRepos", () => {
  const filters = (overrides: Partial<DiscoveryFilters>): DiscoveryFilters => ({
    ...DEFAULT_DISCOVERY_FILTERS,
    ...overrides,
  });
  const discover = async (
    routes: ConstructorParameters<typeof MockApi>[0],
    overrides: Partial<DiscoveryFilters> = {},
  ) => {
    const discovered = await discoverRepos(
      new MockApi(routes) as unknown as GithubApi,
      filters(overrides),
    );
    if ("error" in discovered) {
      throw new Error(discovered.error);
    }
    return discovered;
  };
  const OWNED = "GET /user/repos?affiliation=owner&per_page=100&page=1";

  test("default filters list owned repos, skipping archived ones", async () => {
    const discovered = await discover({
      [OWNED]: { data: [{ full_name: "o/x" }, { full_name: "o/y", archived: true }] },
    });
    expect(discovered.slugs).toEqual(["o/x"]);
    expect(discovered.filtered).toEqual([{ reason: "archived", slugs: ["o/y"] }]);
  });

  test("archived: include keeps them; only inverts the skip", async () => {
    const data = [{ full_name: "o/x" }, { full_name: "o/y", archived: true }];
    const both = await discover({ [OWNED]: { data } }, { archived: "include" });
    expect(both.slugs).toEqual(["o/x", "o/y"]);
    expect(both.filtered).toEqual([]);
    const only = await discover({ [OWNED]: { data } }, { archived: "only" });
    expect(only.slugs).toEqual(["o/y"]);
    expect(only.filtered).toEqual([{ reason: "archived=only", slugs: ["o/x"] }]);
  });

  test("forks: exclude and only split on the fork field", async () => {
    const data = [{ full_name: "o/src" }, { full_name: "o/copy", fork: true }];
    const noForks = await discover({ [OWNED]: { data } }, { forks: "exclude" });
    expect(noForks.slugs).toEqual(["o/src"]);
    expect(noForks.filtered).toEqual([{ reason: "forks=exclude", slugs: ["o/copy"] }]);
    const onlyForks = await discover({ [OWNED]: { data } }, { forks: "only" });
    expect(onlyForks.slugs).toEqual(["o/copy"]);
  });

  test("visibility: public and private go into the query string", async () => {
    const discovered = await discover(
      {
        "GET /user/repos?affiliation=owner&visibility=public&per_page=100&page=1": {
          data: [{ full_name: "o/pub" }],
        },
      },
      { visibility: "public" },
    );
    expect(discovered.slugs).toEqual(["o/pub"]);
  });

  test("visibility: private drops internal repos client-side", async () => {
    const discovered = await discover(
      {
        "GET /user/repos?affiliation=owner&visibility=private&per_page=100&page=1": {
          data: [{ full_name: "o/priv" }, { full_name: "o/int", visibility: "internal" }],
        },
      },
      { visibility: "private" },
    );
    expect(discovered.slugs).toEqual(["o/priv"]);
    expect(discovered.filtered).toEqual([{ reason: "visibility=private", slugs: ["o/int"] }]);
  });

  test("visibility: internal filters client-side with no server param", async () => {
    const discovered = await discover(
      {
        [OWNED]: {
          data: [{ full_name: "o/pub" }, { full_name: "o/int", visibility: "internal" }],
        },
      },
      { visibility: "internal" },
    );
    expect(discovered.slugs).toEqual(["o/int"]);
    expect(discovered.filtered).toEqual([{ reason: "visibility=internal", slugs: ["o/pub"] }]);
  });

  test("topics keep repos carrying at least one listed topic, case-insensitively", async () => {
    const discovered = await discover(
      {
        [OWNED]: {
          data: [
            { full_name: "o/a", topics: ["Team-B", "misc"] },
            { full_name: "o/b", topics: ["other"] },
            { full_name: "o/c" },
          ],
        },
      },
      { topics: ["team-a", "team-b"] },
    );
    expect(discovered.slugs).toEqual(["o/a"]);
    expect(discovered.filtered).toEqual([
      { reason: "topics (has none of: team-a, team-b)", slugs: ["o/b", "o/c"] },
    ]);
  });

  test("exclude patterns name the specific glob that fired", async () => {
    const discovered = await discover(
      {
        [OWNED]: {
          data: [{ full_name: "o/keep" }, { full_name: "o/tmp-1" }, { full_name: "octo/keep" }],
        },
      },
      { exclude: ["tmp-*", "octo/*"] },
    );
    expect(discovered.slugs).toEqual(["o/keep"]);
    expect(discovered.filtered).toEqual([
      { reason: 'exclude pattern "tmp-*"', slugs: ["o/tmp-1"] },
      { reason: 'exclude pattern "octo/*"', slugs: ["octo/keep"] },
    ]);
  });

  test("a repo is attributed to the first filter that drops it", async () => {
    const discovered = await discover(
      {
        [OWNED]: { data: [{ full_name: "o/tmp-fork", archived: true, fork: true }] },
      },
      { forks: "exclude", exclude: ["tmp-*"] },
    );
    expect(discovered.slugs).toEqual([]);
    expect(discovered.filtered).toEqual([{ reason: "archived", slugs: ["o/tmp-fork"] }]);
  });

  test("affiliation list lands in the query string", async () => {
    const discovered = await discover(
      {
        "GET /user/repos?affiliation=owner,collaborator&per_page=100&page=1": {
          data: [{ full_name: "o/x" }],
        },
      },
      { affiliation: ["owner", "collaborator"] },
    );
    expect(discovered.slugs).toEqual(["o/x"]);
  });

  test("a denied listing explains the PAT requirement", async () => {
    const api = new MockApi({
      "GET /user/repos?affiliation=owner&per_page=100&page=1": {
        error: { status: 403, message: "Resource not accessible", body: "" },
      },
    });
    const discovered = await discoverRepos(api as unknown as GithubApi, DEFAULT_DISCOVERY_FILTERS);
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
