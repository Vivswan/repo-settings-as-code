import { afterEach, describe, expect, test } from "bun:test";
import type { GithubApi } from "../src/api.js";
import { run, runMulti } from "../src/main.js";
import type { Io } from "../src/orchestrate.js";
import { DEFAULT_DISCOVERY_FILTERS } from "../src/targets.js";
import { MockApi } from "./mock-api.js";

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
      // o/c: repo visible but has no settings file (contents GET unrouted -> 404)
      "GET /repos/o/c": { data: {} },
    });
    const { io, annotations } = captureIo();
    const { fatal, targets } = await runMulti(
      api as unknown as GithubApi,
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
      api as unknown as GithubApi,
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
    const { fatal } = await runMulti(api as unknown as GithubApi, cfg({ reposInput: " ,  " }), io);
    expect(fatal).toContain("no targets");
  });

  test("discovery filters with repos-dir-only targets are fatal", async () => {
    const api = new MockApi({});
    const { io } = captureIo();
    const { fatal } = await runMulti(
      api as unknown as GithubApi,
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
      api as unknown as GithubApi,
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
      api as unknown as GithubApi,
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

describe("run (legacy single-repo regression)", () => {
  const ENV_KEYS = [
    "INPUT_TOKEN",
    "INPUT_MODE",
    "INPUT_REPOSITORY",
    "INPUT_SETTINGS-FILE",
    "GITHUB_OUTPUT",
    "GITHUB_STEP_SUMMARY",
  ];
  const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  function setEnv() {
    process.env.INPUT_TOKEN = "t";
    process.env.INPUT_REPOSITORY = "o/r";
    process.env["INPUT_SETTINGS-FILE"] = "test/fixtures/single.yml";
    delete process.env.GITHUB_OUTPUT;
    delete process.env.GITHUB_STEP_SUMMARY;
  }

  test("check mode: clean exits 0, drift exits 1", async () => {
    setEnv();
    process.env.INPUT_MODE = "check";
    const clean = new MockApi({ "GET /repos/o/r": { data: { has_wiki: false } } });
    expect(await run({ api: clean as unknown as GithubApi })).toBe(0);
    const drifted = new MockApi({ "GET /repos/o/r": { data: { has_wiki: true } } });
    expect(await run({ api: drifted as unknown as GithubApi })).toBe(1);
  });

  test("apply mode patches the declared keys and exits 0", async () => {
    setEnv();
    process.env.INPUT_MODE = "apply";
    const api = new MockApi({ "GET /repos/o/r": { data: { has_wiki: true } } });
    expect(await run({ api: api as unknown as GithubApi })).toBe(0);
    expect(api.mutations()).toEqual([
      { method: "PATCH", path: "/repos/o/r", payload: { has_wiki: false } },
    ]);
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
    const { fatal, targets } = await runMulti(
      api as unknown as GithubApi,
      cfg({ reposInput: "o/a, o/d" }),
      io,
    );
    expect(fatal).toBeNull();
    const bySlug = Object.fromEntries(targets.map((t) => [t.slug, t.result]));
    expect(bySlug).toEqual({ "o/a": "applied", "o/d": "failed" });
    expect(api.mutations().every((m) => m.path.startsWith("/repos/o/a"))).toBe(true);
    expect(annotations.some((a) => a.includes("o/d: preflight failed"))).toBe(true);
  });
});

describe("run in multi-repo mode (env glue)", () => {
  const ENV_KEYS = [
    "INPUT_TOKEN",
    "INPUT_MODE",
    "INPUT_REPOS",
    "INPUT_REPOSITORY",
    "INPUT_VISIBILITY",
    "INPUT_ARCHIVED",
    "INPUT_FORKS",
    "INPUT_EXCLUDE",
    "INPUT_TOPICS",
    "INPUT_AFFILIATION",
    "GITHUB_OUTPUT",
    "GITHUB_STEP_SUMMARY",
    "GITHUB_REPOSITORY",
  ];
  const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test("writes repos-result to GITHUB_OUTPUT and exits by worst-of", async () => {
    process.env.INPUT_TOKEN = "t";
    process.env.INPUT_MODE = "check";
    process.env.INPUT_REPOS = "o/a";
    delete process.env.INPUT_REPOSITORY;
    delete process.env.GITHUB_STEP_SUMMARY;
    const outputFile = `${process.env.TMPDIR ?? "/tmp"}/sac-test-output-${process.pid}.txt`;
    await Bun.write(outputFile, "");
    process.env.GITHUB_OUTPUT = outputFile;
    const api = new MockApi({
      "GET /repos/o/a": { data: { has_wiki: false } },
      "GET /repos/o/a/contents/.github/settings.yml": {
        data: "repository:\n  has_wiki: false\n",
      },
    });
    expect(await run({ api: api as unknown as GithubApi })).toBe(0);
    const output = await Bun.file(outputFile).text();
    // @actions/core writes outputs in heredoc form: name<<DELIM / value / DELIM
    expect(output).toContain("repos-result<<");
    expect(output).toContain('"o/a":{"result":"clean","source":"remote"');
    expect(output).toContain("result<<");
  });

  test("repository input combined with repos is a hard error", async () => {
    process.env.INPUT_TOKEN = "t";
    process.env.INPUT_MODE = "check";
    process.env.INPUT_REPOS = "o/a";
    process.env.INPUT_REPOSITORY = "o/r";
    delete process.env.GITHUB_OUTPUT;
    delete process.env.GITHUB_STEP_SUMMARY;
    const api = new MockApi({});
    expect(await run({ api: api as unknown as GithubApi })).toBe(1);
    expect(api.calls).toHaveLength(0);
  });

  function setDiscoveryEnv() {
    process.env.INPUT_TOKEN = "t";
    process.env.INPUT_MODE = "check";
    delete process.env.INPUT_REPOS;
    delete process.env.INPUT_REPOSITORY;
    delete process.env.GITHUB_OUTPUT;
    delete process.env.GITHUB_STEP_SUMMARY;
    delete process.env.GITHUB_REPOSITORY;
  }

  test("invalid filter values are hard errors before any API call", async () => {
    const bad: Array<[string, string]> = [
      ["INPUT_VISIBILITY", "sometimes"],
      ["INPUT_ARCHIVED", "maybe"],
      ["INPUT_FORKS", "never"],
      ["INPUT_AFFILIATION", "member"],
      ["INPUT_EXCLUDE", "a/b/c"],
      ["INPUT_EXCLUDE", "octo/"],
      ["INPUT_EXCLUDE", "/repo"],
    ];
    for (const [key, value] of bad) {
      setDiscoveryEnv();
      process.env.INPUT_REPOS = "*";
      process.env[key] = value;
      const api = new MockApi({});
      expect(await run({ api: api as unknown as GithubApi })).toBe(1);
      expect(api.calls).toHaveLength(0);
      delete process.env[key];
    }
  });

  test("filters with an explicit repos list are a hard error", async () => {
    setDiscoveryEnv();
    process.env.INPUT_REPOS = "o/a";
    process.env.INPUT_FORKS = "exclude";
    const api = new MockApi({});
    expect(await run({ api: api as unknown as GithubApi })).toBe(1);
    expect(api.calls).toHaveLength(0);
  });

  test("filters in single-repo mode are a hard error", async () => {
    setDiscoveryEnv();
    process.env.INPUT_REPOSITORY = "o/r";
    process.env.INPUT_TOPICS = "team-a";
    const api = new MockApi({});
    expect(await run({ api: api as unknown as GithubApi })).toBe(1);
    expect(api.calls).toHaveLength(0);
  });

  test("discovery with forks: exclude processes only the non-fork", async () => {
    setDiscoveryEnv();
    process.env.INPUT_REPOS = "*";
    process.env.INPUT_FORKS = "exclude";
    const api = new MockApi({
      "GET /user/repos?affiliation=owner&per_page=100&page=1": {
        data: [{ full_name: "o/x" }, { full_name: "o/y", fork: true }],
      },
      "GET /repos/o/x": { data: { has_wiki: false } },
      "GET /repos/o/x/contents/.github/settings.yml": {
        data: "repository:\n  has_wiki: false\n",
      },
    });
    expect(await run({ api: api as unknown as GithubApi })).toBe(0);
    expect(api.calls.some((c) => c.path.startsWith("/repos/o/y"))).toBe(false);
  });
});
