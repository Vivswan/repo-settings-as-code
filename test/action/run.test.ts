import { afterEach, describe, expect, test } from "bun:test";
import { generateX25519Identity, identityToRecipient } from "age-encryption";
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
    const api = new MockApi({ "GET /repos/o/r": { data: { has_wiki: true } } }).allowMutations(
      "PATCH /repos/o/r",
    );
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
    "INPUT_PRIVATE-REPOS",
    "INPUT_PRIVATE-REPORT",
    "INPUT_REPORT-PUBLIC-KEY",
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
      "GET /repos/o/a": { data: { has_wiki: false, private: false } },
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
        data: [
          { full_name: "o/x", private: false },
          { full_name: "o/y", fork: true, private: false },
        ],
      },
      "GET /repos/o/x": { data: { has_wiki: false, private: false } },
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
      "GET /repos/o/a": { data: { has_wiki: true, private: false } },
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
      "GET /repos/o/a": { data: { description: "live | desc", private: false } },
      "GET /repos/o/a/contents/.github/settings.yml": {
        data: 'repository:\n  description: "want | desc"\n',
      },
    });
    expect(await run({ api: api })).toBe(1);
    const summary = await Bun.file(summaryFile).text();
    expect(summary).toContain(":warning: drift");
    expect(summary).toContain("want \\| desc");
  });

  test("redact default: repos-result and summary key a private target by its placeholder", async () => {
    setDiscoveryEnv();
    process.env.INPUT_REPOS = "o/priv";
    process.env["INPUT_PRIVATE-REPOS"] = "redact";
    process.env.INPUT_MODE = "check";
    const outputFile = `${process.env.TMPDIR ?? "/tmp"}/sac-test-redact-out-${process.pid}.txt`;
    const summaryFile = `${process.env.TMPDIR ?? "/tmp"}/sac-test-redact-sum-${process.pid}.md`;
    await Bun.write(outputFile, "");
    await Bun.write(summaryFile, "");
    process.env.GITHUB_OUTPUT = outputFile;
    process.env.GITHUB_STEP_SUMMARY = summaryFile;
    const api = new MockApi({
      "GET /repos/o/priv": { data: { description: "SECRET-live", private: true } },
      "GET /repos/o/priv/contents/.github/settings.yml": {
        data: 'repository:\n  description: "SECRET-want"\n',
      },
    });
    expect(await run({ api: api })).toBe(1);
    const output = await Bun.file(outputFile).text();
    const summary = await Bun.file(summaryFile).text();
    // neither the output nor the summary carries the private slug or values
    for (const text of [output, summary]) {
      expect(text).not.toContain("o/priv");
      expect(text).not.toContain("SECRET-live");
      expect(text).not.toContain("SECRET-want");
    }
    expect(output).toContain('"private repository #1":{"result":"drift"');
    expect(summary).toContain("private repository #1");
    expect(summary).toContain("hidden (private repository)");
  });

  test("redact single-repo cross-repo target: generic summary, no slug or live values", async () => {
    setDiscoveryEnv();
    delete process.env.INPUT_REPOS;
    process.env.INPUT_REPOSITORY = "o/priv";
    process.env.GITHUB_REPOSITORY = "admin/repo";
    process.env["INPUT_SETTINGS-FILE"] = "test/fixtures/single.yml";
    process.env["INPUT_PRIVATE-REPOS"] = "redact";
    process.env.INPUT_MODE = "check";
    const summaryFile = `${process.env.TMPDIR ?? "/tmp"}/sac-test-single-redact-${process.pid}.md`;
    await Bun.write(summaryFile, "");
    process.env.GITHUB_STEP_SUMMARY = summaryFile;
    // has_wiki drifts; the live value is a boolean but the slug must not leak.
    const api = new MockApi({
      "GET /repos/o/priv": { data: { has_wiki: true, private: true } },
    });
    expect(await run({ api: api })).toBe(1);
    const summary = await Bun.file(summaryFile).text();
    expect(summary).not.toContain("o/priv");
    expect(summary).toContain("details hidden");
    // Finding F: the redacted single-repo summary renders the SAME per-section
    // table the multi path does - the section key and its status are visible
    // (the policy keeps statuses everywhere), the detail cell is hidden, and
    // the live drift value never appears.
    expect(summary).toContain("| Section | Status | Detail |");
    expect(summary).toContain("repository");
    expect(summary).toContain(":warning: drift");
    expect(summary).toContain("hidden (private repository)");
    // the live value that drifted must not leak
    expect(summary).not.toContain("has_wiki");
  });

  test("self-target single-repo run is never redacted (carve-out)", async () => {
    setDiscoveryEnv();
    delete process.env.INPUT_REPOS;
    process.env.INPUT_REPOSITORY = "o/self";
    process.env.GITHUB_REPOSITORY = "o/self";
    process.env["INPUT_SETTINGS-FILE"] = "test/fixtures/single.yml";
    process.env["INPUT_PRIVATE-REPOS"] = "redact";
    process.env.INPUT_MODE = "check";
    const summaryFile = `${process.env.TMPDIR ?? "/tmp"}/sac-test-self-${process.pid}.md`;
    await Bun.write(summaryFile, "");
    process.env.GITHUB_STEP_SUMMARY = summaryFile;
    const api = new MockApi({ "GET /repos/o/self": { data: { has_wiki: false, private: true } } });
    expect(await run({ api: api })).toBe(0);
    const summary = await Bun.file(summaryFile).text();
    // full detail: the section table renders normally, no redaction note
    expect(summary).not.toContain("details hidden");
    expect(summary).toContain("repository");
    // and no visibility probe: the self carve-out skips it (only the engine GET)
    const gets = api.calls.filter((c) => c.method === "GET" && c.path === "/repos/o/self");
    expect(gets).toHaveLength(1);
  });

  test("private-report != none combined with private-repos: show is a hard config error", async () => {
    setDiscoveryEnv();
    process.env.INPUT_REPOSITORY = "o/r";
    process.env["INPUT_SETTINGS-FILE"] = "test/fixtures/single.yml";
    process.env["INPUT_PRIVATE-REPOS"] = "show";
    process.env["INPUT_PRIVATE-REPORT"] = "issue";
    const api = new MockApi({});
    expect(await run({ api: api })).toBe(1);
    // rejected at config parse, before any API call
    expect(api.calls).toHaveLength(0);
  });

  test("single-repo cross-repo redacted target delivers a report to its own issue", async () => {
    setDiscoveryEnv();
    delete process.env.INPUT_REPOS;
    process.env.INPUT_REPOSITORY = "o/priv";
    process.env.GITHUB_REPOSITORY = "admin/repo";
    process.env["INPUT_SETTINGS-FILE"] = "test/fixtures/single.yml";
    process.env["INPUT_PRIVATE-REPOS"] = "redact";
    process.env["INPUT_PRIVATE-REPORT"] = "issue";
    process.env.INPUT_MODE = "check";
    const summaryFile = `${process.env.TMPDIR ?? "/tmp"}/sac-test-single-report-${process.pid}.md`;
    await Bun.write(summaryFile, "");
    process.env.GITHUB_STEP_SUMMARY = summaryFile;
    const ISSUE_TITLE = "[automated] settings-as-code: private settings report";
    // has_wiki drifts (single.yml wants false); the report captures that.
    const api = new MockApi({
      "GET /repos/o/priv": { data: { has_wiki: true, private: true } },
      "POST /repos/o/priv/labels": { error: { status: 422, message: "exists", body: "" } },
      "GET /repos/o/priv/issues?state=all&labels=settings-as-code-report&per_page=100": {
        data: [{ number: 3, title: ISSUE_TITLE, html_url: "https://github.com/o/priv/issues/3" }],
      },
      "PATCH /repos/o/priv/issues/3": { data: { number: 3 } },
    });
    expect(await run({ api: api })).toBe(1); // check-mode drift exits 1
    const patch = api.calls.find(
      (c) => c.method === "PATCH" && c.path === "/repos/o/priv/issues/3",
    );
    const payload = (patch?.payload ?? {}) as { body?: unknown; state?: unknown };
    const body = String(payload.body ?? "");
    expect(body).toContain("o/priv"); // the report is unredacted (it is private)
    expect(body).toContain("## Transcript");
    expect(payload.state).toBe("open"); // drift needs attention
    // the public summary stays redacted
    const summary = await Bun.file(summaryFile).text();
    expect(summary).not.toContain("o/priv");
    expect(summary).toContain("details hidden");
  });

  test("single-repo unknown visibility redacts but does NOT deliver the report", async () => {
    setDiscoveryEnv();
    delete process.env.INPUT_REPOS;
    process.env.INPUT_REPOSITORY = "o/maybe";
    process.env.GITHUB_REPOSITORY = "admin/repo";
    process.env["INPUT_SETTINGS-FILE"] = "test/fixtures/single.yml";
    process.env["INPUT_PRIVATE-REPOS"] = "redact";
    process.env["INPUT_PRIVATE-REPORT"] = "issue";
    process.env.INPUT_MODE = "check";
    delete process.env.GITHUB_STEP_SUMMARY;
    // repo GET body has neither private nor visibility -> unknown -> redact, no deliver
    const api = new MockApi({ "GET /repos/o/maybe": { data: { has_wiki: true } } });
    expect(await run({ api: api })).toBe(1); // drift exits 1
    // no issue/label traffic: the report was withheld
    expect(api.calls.some((c) => c.path.includes("/issues"))).toBe(false);
    expect(api.calls.some((c) => c.method === "POST" && c.path.endsWith("/labels"))).toBe(false);
  });

  test("private-report: artifact without report-public-key is a hard config error", async () => {
    setDiscoveryEnv();
    process.env.INPUT_REPOSITORY = "o/r";
    process.env["INPUT_SETTINGS-FILE"] = "test/fixtures/single.yml";
    process.env["INPUT_PRIVATE-REPOS"] = "redact";
    process.env["INPUT_PRIVATE-REPORT"] = "artifact";
    delete process.env["INPUT_REPORT-PUBLIC-KEY"];
    const api = new MockApi({});
    expect(await run({ api: api })).toBe(1);
    // rejected at parse, before any API call
    expect(api.calls).toHaveLength(0);
  });

  test("private-report: artifact with a malformed report-public-key is a hard config error", async () => {
    setDiscoveryEnv();
    process.env.INPUT_REPOSITORY = "o/r";
    process.env["INPUT_SETTINGS-FILE"] = "test/fixtures/single.yml";
    process.env["INPUT_PRIVATE-REPOS"] = "redact";
    process.env["INPUT_PRIVATE-REPORT"] = "artifact";
    process.env["INPUT_REPORT-PUBLIC-KEY"] = "age1notavalidkey";
    const api = new MockApi({});
    expect(await run({ api: api })).toBe(1);
    expect(api.calls).toHaveLength(0);
  });

  test("report-public-key supplied without the artifact channel is a hard config error", async () => {
    const recipient = await identityToRecipient(await generateX25519Identity());
    setDiscoveryEnv();
    process.env.INPUT_REPOSITORY = "o/r";
    process.env["INPUT_SETTINGS-FILE"] = "test/fixtures/single.yml";
    process.env["INPUT_PRIVATE-REPOS"] = "redact";
    process.env["INPUT_PRIVATE-REPORT"] = "issue";
    process.env["INPUT_REPORT-PUBLIC-KEY"] = recipient;
    const api = new MockApi({});
    expect(await run({ api: api })).toBe(1);
    expect(api.calls).toHaveLength(0);
  });

  test("private-report: artifact combined with private-repos: show is a hard config error", async () => {
    const recipient = await identityToRecipient(await generateX25519Identity());
    setDiscoveryEnv();
    process.env.INPUT_REPOSITORY = "o/r";
    process.env["INPUT_SETTINGS-FILE"] = "test/fixtures/single.yml";
    process.env["INPUT_PRIVATE-REPOS"] = "show";
    process.env["INPUT_PRIVATE-REPORT"] = "artifact";
    process.env["INPUT_REPORT-PUBLIC-KEY"] = recipient;
    const api = new MockApi({});
    expect(await run({ api: api })).toBe(1);
    expect(api.calls).toHaveLength(0);
  });

  test("single-repo artifact channel redacts and attempts delivery without changing the result", async () => {
    // The production uploader has no ACTIONS_RUNTIME_TOKEN under test, so the
    // upload attempt fails - which must degrade to a safe warning, never a crash
    // and never a changed result. The public summary stays redacted throughout.
    const recipient = await identityToRecipient(await generateX25519Identity());
    setDiscoveryEnv();
    delete process.env.INPUT_REPOS;
    process.env.INPUT_REPOSITORY = "o/priv";
    process.env.GITHUB_REPOSITORY = "admin/repo";
    process.env["INPUT_SETTINGS-FILE"] = "test/fixtures/single.yml";
    process.env["INPUT_PRIVATE-REPOS"] = "redact";
    process.env["INPUT_PRIVATE-REPORT"] = "artifact";
    process.env["INPUT_REPORT-PUBLIC-KEY"] = recipient;
    process.env.INPUT_MODE = "check";
    const summaryFile = `${process.env.TMPDIR ?? "/tmp"}/sac-test-single-artifact-${process.pid}.md`;
    await Bun.write(summaryFile, "");
    process.env.GITHUB_STEP_SUMMARY = summaryFile;
    // has_wiki drifts (single.yml wants false); the target is proven private.
    const api = new MockApi({ "GET /repos/o/priv": { data: { has_wiki: true, private: true } } });
    expect(await run({ api: api })).toBe(1); // check-mode drift exits 1, unchanged by delivery
    // no issue traffic on the artifact channel
    expect(api.calls.some((c) => c.path.includes("/issues"))).toBe(false);
    // the public summary stays redacted
    const summary = await Bun.file(summaryFile).text();
    expect(summary).not.toContain("o/priv");
    expect(summary).toContain("details hidden");
  });
});
