import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DISCOVERY_FILTERS,
  type DiscoveryFilters,
  discoverRepos,
  excludeMatches,
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
