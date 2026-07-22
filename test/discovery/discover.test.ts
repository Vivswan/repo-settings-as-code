import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DISCOVERY_FILTERS,
  type DiscoveredRepoRef,
  type DiscoveryFilters,
  discoverRepos,
  excludeMatches,
  formatSkipNotice,
} from "../../src/discovery/discover.js";
import { MockApi } from "../mock-api.js";

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
    const discovered = await discoverRepos(new MockApi(routes), filters(overrides));
    if ("error" in discovered) {
      throw new Error(discovered.error);
    }
    return discovered;
  };
  const slugs = (repos: DiscoveredRepoRef[]) => repos.map((repo) => repo.slug);
  const filteredSlugs = (filtered: Array<{ reason: string; repos: DiscoveredRepoRef[] }>) =>
    filtered.map((group) => ({ reason: group.reason, slugs: slugs(group.repos) }));
  const OWNED = "GET /user/repos?affiliation=owner&per_page=100&page=1";

  test("default filters list owned repos, skipping archived ones", async () => {
    const discovered = await discover({
      [OWNED]: { data: [{ full_name: "o/x" }, { full_name: "o/y", archived: true }] },
    });
    expect(slugs(discovered.repos)).toEqual(["o/x"]);
    expect(filteredSlugs(discovered.filtered)).toEqual([{ reason: "archived", slugs: ["o/y"] }]);
  });

  test("visibility normalization fails closed: private wins, both-missing is private", async () => {
    const discovered = await discover({
      [OWNED]: {
        data: [
          { full_name: "o/int", visibility: "internal" },
          { full_name: "o/priv", private: true },
          // explicit public: private === false with no visibility -> public
          { full_name: "o/pub", private: false },
          // BOTH fields missing: an unknown repo is hidden, never exposed
          { full_name: "o/unknown" },
          // forged visibility: private === true overrides a bogus "public"
          { full_name: "o/liar", visibility: "public", private: true },
          { full_name: "o/old", visibility: "private", archived: true },
        ],
      },
    });
    expect(discovered.repos).toEqual([
      { slug: "o/int", visibility: "internal" },
      { slug: "o/priv", visibility: "private" },
      { slug: "o/pub", visibility: "public" },
      { slug: "o/unknown", visibility: "private" },
      { slug: "o/liar", visibility: "private" },
    ]);
    expect(discovered.filtered).toEqual([
      { reason: "archived", repos: [{ slug: "o/old", visibility: "private" }] },
    ]);
  });

  test("archived: include keeps them; only inverts the skip", async () => {
    const data = [{ full_name: "o/x" }, { full_name: "o/y", archived: true }];
    const both = await discover({ [OWNED]: { data } }, { archived: "include" });
    expect(slugs(both.repos)).toEqual(["o/x", "o/y"]);
    expect(both.filtered).toEqual([]);
    const only = await discover({ [OWNED]: { data } }, { archived: "only" });
    expect(slugs(only.repos)).toEqual(["o/y"]);
    expect(filteredSlugs(only.filtered)).toEqual([{ reason: "archived=only", slugs: ["o/x"] }]);
  });

  test("forks: exclude and only split on the fork field", async () => {
    const data = [{ full_name: "o/src" }, { full_name: "o/copy", fork: true }];
    const noForks = await discover({ [OWNED]: { data } }, { forks: "exclude" });
    expect(slugs(noForks.repos)).toEqual(["o/src"]);
    expect(filteredSlugs(noForks.filtered)).toEqual([
      { reason: "forks=exclude", slugs: ["o/copy"] },
    ]);
    const onlyForks = await discover({ [OWNED]: { data } }, { forks: "only" });
    expect(slugs(onlyForks.repos)).toEqual(["o/copy"]);
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
    expect(slugs(discovered.repos)).toEqual(["o/pub"]);
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
    expect(slugs(discovered.repos)).toEqual(["o/priv"]);
    expect(filteredSlugs(discovered.filtered)).toEqual([
      { reason: "visibility=private", slugs: ["o/int"] },
    ]);
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
    expect(slugs(discovered.repos)).toEqual(["o/int"]);
    expect(filteredSlugs(discovered.filtered)).toEqual([
      { reason: "visibility=internal", slugs: ["o/pub"] },
    ]);
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
    expect(slugs(discovered.repos)).toEqual(["o/a"]);
    expect(filteredSlugs(discovered.filtered)).toEqual([
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
    expect(slugs(discovered.repos)).toEqual(["o/keep"]);
    expect(filteredSlugs(discovered.filtered)).toEqual([
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
    expect(discovered.repos).toEqual([]);
    expect(filteredSlugs(discovered.filtered)).toEqual([
      { reason: "archived", slugs: ["o/tmp-fork"] },
    ]);
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
    expect(slugs(discovered.repos)).toEqual(["o/x"]);
  });

  test("a denied listing explains the PAT requirement", async () => {
    const api = new MockApi({
      "GET /user/repos?affiliation=owner&per_page=100&page=1": {
        error: { status: 403, message: "Resource not accessible", body: "" },
      },
    });
    const discovered = await discoverRepos(api, DEFAULT_DISCOVERY_FILTERS);
    expect("error" in discovered && discovered.error).toContain("Discovery needs a user PAT");
  });

  test("a rate-limit 403 gets re-run advice, not PAT advice", async () => {
    // A primary rate limit arrives as a 403 whose message mentions the rate
    // limit; isPermissionError excludes it, so discovery must NOT tell the
    // operator to swap tokens and abandon "*" for a transient throttle.
    const api = new MockApi({
      "GET /user/repos?affiliation=owner&per_page=100&page=1": {
        error: { status: 403, message: "API rate limit exceeded for user", body: "" },
      },
    });
    const discovered = await discoverRepos(api, DEFAULT_DISCOVERY_FILTERS);
    expect("error" in discovered && discovered.error).toContain("re-run the workflow");
    expect("error" in discovered && discovered.error).not.toContain("Discovery needs a user PAT");
  });

  test("an expired-token 401 explains the PAT requirement", async () => {
    const api = new MockApi({
      "GET /user/repos?affiliation=owner&per_page=100&page=1": {
        error: { status: 401, message: "Bad credentials", body: "" },
      },
    });
    const discovered = await discoverRepos(api, DEFAULT_DISCOVERY_FILTERS);
    expect("error" in discovered && discovered.error).toContain("Discovery needs a user PAT");
  });

  test("a server error gets re-run advice, not PAT advice", async () => {
    const api = new MockApi({
      "GET /user/repos?affiliation=owner&per_page=100&page=1": {
        error: { status: 500, message: "boom", body: "" },
      },
    });
    const discovered = await discoverRepos(api, DEFAULT_DISCOVERY_FILTERS);
    expect("error" in discovered && discovered.error).toContain("re-run the workflow");
    expect("error" in discovered && discovered.error).not.toContain("Discovery needs a user PAT");
  });
});

describe("formatSkipNotice", () => {
  const ref = (
    slug: string,
    visibility: DiscoveredRepoRef["visibility"] = "public",
  ): DiscoveredRepoRef => ({ slug, visibility });

  test("without redaction, every slug is listed regardless of visibility", () => {
    const group = {
      reason: "forks=exclude",
      repos: [ref("o/a"), ref("o/b", "private"), ref("o/c", "internal")],
    };
    expect(formatSkipNotice(group, false)).toBe(
      'repos: "*" discovery skipped 3 repositories by forks=exclude: o/a, o/b, o/c',
    );
  });

  test("without redaction, only the first 20 slugs are listed", () => {
    const repos = Array.from({ length: 23 }, (_, i) => ref(`o/r${i}`));
    const notice = formatSkipNotice({ reason: "forks=exclude", repos }, false);
    expect(notice).toContain("o/r19, and 3 more");
    expect(notice).not.toContain("o/r20");
  });

  test("redaction lists public slugs and counts the rest", () => {
    const group = {
      reason: "forks=exclude",
      repos: [ref("o/a"), ref("o/b", "private"), ref("o/c"), ref("o/d", "internal")],
    };
    expect(formatSkipNotice(group, true)).toBe(
      'repos: "*" discovery skipped 4 repositories by forks=exclude: o/a, o/c, and 2 private or internal repositories',
    );
  });

  test("a single hidden repo gets the singular count", () => {
    const group = { reason: "forks=exclude", repos: [ref("o/a"), ref("o/b", "private")] };
    expect(formatSkipNotice(group, true)).toBe(
      'repos: "*" discovery skipped 2 repositories by forks=exclude: o/a, and 1 private or internal repository',
    );
  });

  test("an all-private group renders the count only, with no names", () => {
    const group = {
      reason: "forks=exclude",
      repos: [ref("o/a", "private"), ref("o/b", "internal")],
    };
    expect(formatSkipNotice(group, true)).toBe(
      'repos: "*" discovery skipped 2 private or internal repositories by forks=exclude',
    );
  });

  test("the archived prose survives every redaction form", () => {
    const mixed = { reason: "archived", repos: [ref("o/a"), ref("o/b", "private")] };
    expect(formatSkipNotice(mixed, false)).toBe(
      'repos: "*" discovery skipped 2 repositories because settings writes fail on archived repositories; unarchive them to manage them: o/a, o/b',
    );
    expect(formatSkipNotice(mixed, true)).toBe(
      'repos: "*" discovery skipped 2 repositories because settings writes fail on archived repositories; unarchive them to manage them: o/a, and 1 private or internal repository',
    );
    const allPrivate = { reason: "archived", repos: [ref("o/b", "private")] };
    expect(formatSkipNotice(allPrivate, true)).toBe(
      'repos: "*" discovery skipped 1 private or internal repository because settings writes fail on archived repositories; unarchive them to manage them',
    );
  });

  test("redaction caps the public list at 20 before counting the hidden", () => {
    const repos = [
      ...Array.from({ length: 22 }, (_, i) => ref(`o/pub${i}`)),
      ref("o/secret", "private"),
    ];
    const notice = formatSkipNotice({ reason: "forks=exclude", repos }, true);
    expect(notice).toBe(
      `repos: "*" discovery skipped 23 repositories by forks=exclude: ${Array.from(
        { length: 20 },
        (_, i) => `o/pub${i}`,
      ).join(", ")}, and 2 more, and 1 private or internal repository`,
    );
    expect(notice).not.toContain("o/secret");
  });
});
