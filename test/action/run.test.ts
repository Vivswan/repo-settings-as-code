import { afterEach, describe, expect, test } from "bun:test";
import { run } from "../../src/action/run.js";
import { MockApi } from "../mock-api.js";

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
    expect(await run({ api: clean })).toBe(0);
    const drifted = new MockApi({ "GET /repos/o/r": { data: { has_wiki: true } } });
    expect(await run({ api: drifted })).toBe(1);
  });

  test("apply mode patches the declared keys and exits 0", async () => {
    setEnv();
    process.env.INPUT_MODE = "apply";
    const api = new MockApi({ "GET /repos/o/r": { data: { has_wiki: true } } });
    expect(await run({ api: api })).toBe(0);
    expect(api.mutations()).toEqual([
      { method: "PATCH", path: "/repos/o/r", payload: { has_wiki: false } },
    ]);
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
    expect(await run({ api: api })).toBe(0);
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
    expect(await run({ api: api })).toBe(1);
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
      expect(await run({ api: api })).toBe(1);
      expect(api.calls).toHaveLength(0);
      delete process.env[key];
    }
  });

  test("filters with an explicit repos list are a hard error", async () => {
    setDiscoveryEnv();
    process.env.INPUT_REPOS = "o/a";
    process.env.INPUT_FORKS = "exclude";
    const api = new MockApi({});
    expect(await run({ api: api })).toBe(1);
    expect(api.calls).toHaveLength(0);
  });

  test("filters in single-repo mode are a hard error", async () => {
    setDiscoveryEnv();
    process.env.INPUT_REPOSITORY = "o/r";
    process.env.INPUT_TOPICS = "team-a";
    const api = new MockApi({});
    expect(await run({ api: api })).toBe(1);
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
    expect(await run({ api: api })).toBe(0);
    expect(api.calls.some((c) => c.path.startsWith("/repos/o/y"))).toBe(false);
  });

  test("multi-repo check mode exits 1 on drift and on failure", async () => {
    setDiscoveryEnv();
    process.env.INPUT_REPOS = "o/a";
    const drifted = new MockApi({
      "GET /repos/o/a": { data: { has_wiki: true } },
      "GET /repos/o/a/contents/.github/settings.yml": {
        data: "repository:\n  has_wiki: false\n",
      },
    });
    expect(await run({ api: drifted })).toBe(1);
    const failing = new MockApi({
      "GET /repos/o/a": { error: { status: 500, message: "boom", body: "" } },
      "GET /repos/o/a/contents/.github/settings.yml": {
        data: "repository:\n  has_wiki: false\n",
      },
    });
    expect(await run({ api: failing })).toBe(1);
  });

  test("defaults-file in single-repo mode is a hard error", async () => {
    setDiscoveryEnv();
    process.env.INPUT_REPOSITORY = "o/r";
    process.env["INPUT_DEFAULTS-FILE"] = "test/fixtures/defaults.yml";
    const api = new MockApi({});
    expect(await run({ api: api })).toBe(1);
    expect(api.calls).toHaveLength(0);
    delete process.env["INPUT_DEFAULTS-FILE"];
  });

  test("the step summary escapes pipes and marks drift rows", async () => {
    setDiscoveryEnv();
    process.env.INPUT_REPOS = "o/a";
    const summaryFile = `${process.env.TMPDIR ?? "/tmp"}/sac-test-summary-${process.pid}.md`;
    await Bun.write(summaryFile, "");
    process.env.GITHUB_STEP_SUMMARY = summaryFile;
    const api = new MockApi({
      "GET /repos/o/a": { data: { description: "live | desc" } },
      "GET /repos/o/a/contents/.github/settings.yml": {
        data: 'repository:\n  description: "want | desc"\n',
      },
    });
    expect(await run({ api: api })).toBe(1);
    const summary = await Bun.file(summaryFile).text();
    expect(summary).toContain(":warning: drift");
    expect(summary).toContain("want \\| desc");
  });
});
