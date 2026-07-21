import { describe, expect, test } from "bun:test";
import { runMulti } from "../../src/action/multi.js";
import { DEFAULT_DISCOVERY_FILTERS } from "../../src/discovery/discover.js";
import type { Io } from "../../src/io.js";
import { MockApi } from "../mock-api.js";

function captureIo(): { io: Io; annotations: string[]; logs: string[] } {
  const annotations: string[] = [];
  const logs: string[] = [];
  return {
    io: {
      annotate: (level, message) => annotations.push(`${level}: ${message}`),
      log: (line) => logs.push(line),
    },
    annotations,
    logs,
  };
}

function cfg(overrides: Partial<Parameters<typeof runMulti>[1]> = {}) {
  return {
    reposDir: "",
    reposInput: "",
    defaultsFile: "",
    adminOwner: "o",
    mode: "apply" as const,
    onMissingPermission: "fail" as const,
    requiredSections: new Set<string>(),
    onlySections: new Set<string>(),
    discoveryFilters: DEFAULT_DISCOVERY_FILTERS,
    discoveryFiltersSet: [],
    ...overrides,
  };
}

describe("runMulti", () => {
  test("one failing repo never stops the others; worst-of is failed", async () => {
    const api = new MockApi({
      // o/a: healthy remote target
      "GET /repos/o/a": { data: { has_wiki: false } },
      "GET /repos/o/a/contents/.github/settings.yml": {
        data: "repository:\n  has_wiki: false\n",
      },
      // o/b: settings fetch ok, apply blows up with a server error
      "GET /repos/o/b": { data: {} },
      "GET /repos/o/b/contents/.github/settings.yml": {
        data: "repository:\n  has_wiki: false\n",
      },
      "PATCH /repos/o/b": { error: { status: 500, message: "boom", body: "" } },
      // o/c: repo visible with readable contents, but has no settings file
      // (contents GET unrouted -> 404; the repo probe confirms Contents access)
      "GET /repos/o/c": { data: { permissions: { pull: true } } },
    });
    const { io, annotations } = captureIo();
    const { fatal, targets } = await runMulti(
      api,
      cfg({ reposInput: "o/a, o/b, o/c", onMissingPermission: "warn" }),
      io,
    );
    expect(fatal).toBeNull();
    const bySlug = Object.fromEntries(targets.map((t) => [t.slug, t.result]));
    expect(bySlug).toEqual({ "o/a": "applied", "o/b": "failed", "o/c": "skipped" });
    expect(annotations.some((a) => a.includes("o/c: skipped - the repository has no"))).toBe(true);
  });

  test("defaults-file merges under a central per-repo file", async () => {
    const api = new MockApi({});
    const { io } = captureIo();
    const { fatal, targets } = await runMulti(
      api,
      cfg({
        reposDir: "test/fixtures/repos",
        defaultsFile: "test/fixtures/defaults.yml",
        adminOwner: "viv",
        onMissingPermission: "warn",
      }),
      io,
    );
    expect(fatal).toBeNull();
    expect(targets.map((t) => t.slug).sort()).toEqual(["octo/web", "viv/api"]);
    // viv/api declares has_wiki; defaults add has_projects; both PATCHed.
    const patch = api.calls.find((c) => c.method === "PATCH" && c.path === "/repos/viv/api");
    expect(patch?.payload).toEqual({ has_wiki: false, has_projects: false });
  });

  test("no targets at all is a fatal config error", async () => {
    const api = new MockApi({});
    const { io } = captureIo();
    const { fatal } = await runMulti(api, cfg({ reposInput: " ,  " }), io);
    expect(fatal).toContain("no targets");
  });

  test("a token-invisible repo fails loudly instead of skipping", async () => {
    // No routes at all: the contents GET 404s, and so does the repo probe,
    // which is how a fine-grained token reports lost access.
    const api = new MockApi({});
    const { io, annotations } = captureIo();
    const { fatal, targets } = await runMulti(api, cfg({ reposInput: "o/x" }), io);
    expect(fatal).toBeNull();
    expect(targets[0]?.result).toBe("failed");
    expect(annotations.some((a) => a.includes("the token was denied"))).toBe(true);
  });

  test("a visible repo without Contents access fails, never skips", async () => {
    const api = new MockApi({
      "GET /repos/o/x": { data: { permissions: { pull: false } } },
    });
    const { io, annotations } = captureIo();
    const { targets } = await runMulti(api, cfg({ reposInput: "o/x" }), io);
    expect(targets[0]?.result).toBe("failed");
    expect(annotations.some((a) => a.includes("Contents"))).toBe(true);
  });

  test("discovery filters with repos-dir-only targets are fatal", async () => {
    const api = new MockApi({});
    const { io } = captureIo();
    const { fatal } = await runMulti(
      api,
      cfg({ reposDir: "test/fixtures/repos", adminOwner: "viv", discoveryFiltersSet: ["forks"] }),
      io,
    );
    expect(fatal).toContain("repos-dir");
    expect(fatal).toContain('"forks"');
  });

  test("filters removing every discovered repo suggest relaxing them", async () => {
    const api = new MockApi({
      "GET /user/repos?affiliation=owner&per_page=100&page=1": {
        data: [
          { full_name: "o/a", fork: true },
          { full_name: "o/b", fork: true },
        ],
      },
    });
    const { io } = captureIo();
    const { fatal } = await runMulti(
      api,
      cfg({
        reposInput: "*",
        discoveryFilters: { ...DEFAULT_DISCOVERY_FILTERS, forks: "exclude" },
        discoveryFiltersSet: ["forks"],
      }),
      io,
    );
    expect(fatal).toContain("discovery filters removed all of them");
    expect(fatal).toContain("2 repositories");
  });

  test("skip notices list at most 20 slugs, then a count of the rest", async () => {
    const repos = Array.from({ length: 21 }, (_, i) => ({
      full_name: `o/fork-${String(i).padStart(2, "0")}`,
      fork: true,
    }));
    const api = new MockApi({
      "GET /user/repos?affiliation=owner&per_page=100&page=1": {
        data: [{ full_name: "o/keep" }, ...repos],
      },
      "GET /repos/o/keep": { data: { has_wiki: false } },
      "GET /repos/o/keep/contents/.github/settings.yml": {
        data: "repository:\n  has_wiki: false\n",
      },
    });
    const { io, annotations } = captureIo();
    const { fatal } = await runMulti(
      api,
      cfg({
        reposInput: "*",
        discoveryFilters: { ...DEFAULT_DISCOVERY_FILTERS, forks: "exclude" },
        discoveryFiltersSet: ["forks"],
      }),
      io,
    );
    expect(fatal).toBeNull();
    const notice = annotations.find((a) => a.includes("forks=exclude"));
    expect(notice).toContain("skipped 21 repositories");
    expect(notice).toContain("o/fork-19");
    expect(notice).not.toContain("o/fork-20");
    expect(notice).toContain(", and 1 more");
  });
});

describe("runMulti under on-missing-permission: fail", () => {
  test("preflight denial fails that repo, applies nothing to it, others proceed", async () => {
    const api = new MockApi({
      // o/a: healthy
      "GET /repos/o/a": { data: { has_wiki: false } },
      "GET /repos/o/a/contents/.github/settings.yml": {
        data: "repository:\n  has_wiki: false\n",
      },
      // o/d: settings fetch ok, but the labels probe is denied -> preflight
      "GET /repos/o/d": { data: {} },
      "GET /repos/o/d/contents/.github/settings.yml": {
        data: 'labels:\n  - name: bug\n    color: "d73a4a"\n',
      },
      "GET /repos/o/d/labels?per_page=100&page=1": {
        error: { status: 403, message: "Forbidden", body: "" },
      },
    });
    const { io, annotations } = captureIo();
    const { fatal, targets } = await runMulti(api, cfg({ reposInput: "o/a, o/d" }), io);
    expect(fatal).toBeNull();
    const bySlug = Object.fromEntries(targets.map((t) => [t.slug, t.result]));
    expect(bySlug).toEqual({ "o/a": "applied", "o/d": "failed" });
    expect(api.mutations().every((m) => m.path.startsWith("/repos/o/a"))).toBe(true);
    expect(annotations.some((a) => a.includes("o/d: preflight failed"))).toBe(true);
  });
});
