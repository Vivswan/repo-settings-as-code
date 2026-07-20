import { afterEach, describe, expect, test } from "bun:test";
import type { GithubApi } from "../src/api.js";
import { run, runMulti } from "../src/main.js";
import type { Io } from "../src/orchestrate.js";
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
    expect(output).toContain('repos-result={"o/a":{"result":"clean","source":"remote"');
    expect(output).toContain("result=clean");
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
});
