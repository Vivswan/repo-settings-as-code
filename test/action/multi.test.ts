import { describe, expect, test } from "bun:test";
import {
  applyMarkerInjection,
  redactOutcomes,
  runMulti,
  toPublicView,
} from "../../src/action/multi.js";
import { DEFAULT_DISCOVERY_FILTERS } from "../../src/discovery/discover.js";
import type { Io } from "../../src/io.js";
import { MockApi } from "../mock-api.js";

function captureIo(): {
  io: Io;
  annotations: string[];
  logs: string[];
  masks: string[];
  events: string[];
} {
  const annotations: string[] = [];
  const logs: string[] = [];
  const masks: string[] = [];
  const events: string[] = [];
  return {
    io: {
      annotate: (level, message) => {
        annotations.push(`${level}: ${message}`);
        events.push(`annotate ${level}: ${message}`);
      },
      log: (line) => {
        logs.push(line);
        events.push(`log: ${line}`);
      },
      mask: (value) => {
        masks.push(value);
        events.push(`mask: ${value}`);
      },
    },
    annotations,
    logs,
    masks,
    events,
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
    // Existing scenarios predate redaction and assert on raw slugs; default
    // to "show" so they stay byte-identical. Redaction tests override this.
    privateRepos: "show" as const,
    privateReport: "none" as const,
    selfSlug: "",
    runUrl: "",
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
    }).allowMutations("PATCH /repos/o/a");
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

  test("engine emissions carry the slug prefix; validation warnings stay unprefixed", async () => {
    const api = new MockApi({
      "GET /repos/o/a": { data: { has_wiki: true } },
      "GET /repos/o/a/contents/.github/settings.yml": {
        data: "repository:\n  has_wiki: false\nfrobnicate: {}\n",
      },
      "PATCH /repos/o/a": { error: { status: 500, message: "boom", body: "" } },
    });
    const { io, annotations } = captureIo();
    const { targets } = await runMulti(
      api,
      cfg({ reposInput: "o/a", onlySections: new Set(["repository"]) }),
      io,
    );
    expect(targets[0]?.result).toBe("failed");
    // validateSettingsDoc runs on the plain sink, before prefixedIo wraps it.
    const validation = annotations.find((a) => a.includes("unknown top-level section"));
    expect(validation).toStartWith("warning: ignoring unknown top-level section(s)");
    // The section failure is emitted by the engine through the wrapped sink.
    expect(annotations.some((a) => a.startsWith("error: o/a: repository:"))).toBe(true);
  });

  test("defaults-file merges under a central per-repo file", async () => {
    const api = new MockApi({}).allowMutations("PATCH /repos/viv/api", "PATCH /repos/octo/web");
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
    const { io, annotations } = captureIo();
    const { fatal } = await runMulti(
      api,
      cfg({ reposDir: "test/fixtures/repos", adminOwner: "viv", discoveryFiltersSet: ["forks"] }),
      io,
    );
    expect(fatal).toContain("repos-dir");
    expect(fatal).toContain('"forks"');
    // Finding D: central-resolution warnings buffered before this fatal return
    // must still be emitted, not silently swallowed. The fixture's README.md
    // (non-yaml) and octo/deep/ (too deep) each produce an "ignoring" warning.
    expect(annotations.some((a) => a.startsWith("warning: ignoring "))).toBe(true);
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
    }).allowMutations("PATCH /repos/o/a");
    const { io, annotations } = captureIo();
    const { fatal, targets } = await runMulti(api, cfg({ reposInput: "o/a, o/d" }), io);
    expect(fatal).toBeNull();
    const bySlug = Object.fromEntries(targets.map((t) => [t.slug, t.result]));
    expect(bySlug).toEqual({ "o/a": "applied", "o/d": "failed" });
    expect(api.mutations().every((m) => m.path.startsWith("/repos/o/a"))).toBe(true);
    expect(annotations.some((a) => a.includes("o/d: preflight failed"))).toBe(true);
  });
});

describe("runMulti redaction (private-repos: redact)", () => {
  /** A drifting private target plus a healthy public one, under redact. */
  function mixApi() {
    return new MockApi({
      // o/pub: public, drifts on has_wiki
      "GET /repos/o/pub": { data: { has_wiki: true, private: false } },
      "GET /repos/o/pub/contents/.github/settings.yml": {
        data: "repository:\n  has_wiki: false\n",
      },
      // o/priv: private, its live description drifts (a private live value)
      "GET /repos/o/priv": { data: { description: "SECRET-live-desc", private: true } },
      "GET /repos/o/priv/contents/.github/settings.yml": {
        data: 'repository:\n  description: "SECRET-want-desc"\n',
      },
    });
  }

  test("a private target is masked before the first emission, and never leaks its slug", async () => {
    const api = mixApi();
    const { io, annotations, logs, masks, events } = captureIo();
    const { targets } = await runMulti(
      api,
      cfg({ reposInput: "o/pub, o/priv", mode: "check", privateRepos: "redact" }),
      io,
    );
    // the private slug is masked, and the mask is recorded before any emission
    expect(masks).toContain("o/priv");
    const firstMask = events.indexOf("mask: o/priv");
    const firstEmit = events.findIndex((e) => e.startsWith("annotate") || e.startsWith("log"));
    expect(firstMask).toBeGreaterThanOrEqual(0);
    expect(firstMask).toBeLessThan(firstEmit);
    // no annotation or log carries the private slug or its live values
    const all = [...annotations, ...logs].join("\n");
    expect(all).not.toContain("o/priv");
    expect(all).not.toContain("SECRET-live-desc");
    expect(all).not.toContain("SECRET-want-desc");
    // the placeholder is what surfaces instead
    expect(annotations.some((a) => a.includes("private repository #1"))).toBe(true);
    // the public target is untouched
    expect(all).toContain("o/pub");
    // internally the full outcome is kept
    const priv = targets.find((t) => t.slug === "o/priv");
    expect(priv?.redacted).toBe(true);
    expect(priv?.display).toBe("private repository #1");
    expect(priv?.result).toBe("drift");
  });

  test("show is byte-identical to today: no mask, raw slug and live values surface", async () => {
    const api = mixApi();
    const redactRun = captureIo();
    await runMulti(
      api,
      cfg({ reposInput: "o/pub, o/priv", mode: "check", privateRepos: "redact" }),
      redactRun.io,
    );
    const showApi = mixApi();
    const showRun = captureIo();
    await runMulti(
      showApi,
      cfg({ reposInput: "o/pub, o/priv", mode: "check", privateRepos: "show" }),
      showRun.io,
    );
    // under show, nothing is masked and the private slug appears verbatim
    expect(showRun.masks).toEqual([]);
    const all = [...showRun.annotations, ...showRun.logs].join("\n");
    expect(all).toContain("o/priv");
    // and no visibility probe was issued (the o/priv GET happens once, in the engine)
    const privGets = showApi.calls.filter((c) => c.method === "GET" && c.path === "/repos/o/priv");
    expect(privGets).toHaveLength(1);
  });

  test("the self slug is never redacted (carve-out), even when private", async () => {
    const api = new MockApi({
      "GET /repos/o/self": { data: { has_wiki: true, private: true } },
      "GET /repos/o/self/contents/.github/settings.yml": {
        data: "repository:\n  has_wiki: false\n",
      },
    });
    const { io, annotations, masks } = captureIo();
    const { targets } = await runMulti(
      api,
      cfg({ reposInput: "o/self", mode: "check", privateRepos: "redact", selfSlug: "o/self" }),
      io,
    );
    expect(masks).toEqual([]);
    expect(targets[0]?.redacted).toBe(false);
    expect(targets[0]?.display).toBe("o/self");
    expect(annotations.join("\n")).not.toContain("private repository");
    // no separate visibility probe for the self slug (only the engine's GET)
    const gets = api.calls.filter((c) => c.method === "GET" && c.path === "/repos/o/self");
    expect(gets).toHaveLength(1);
  });

  test("discovery-supplied visibility skips the probe; a private discovered repo is redacted", async () => {
    const api = new MockApi({
      "GET /user/repos?affiliation=owner&per_page=100&page=1": {
        data: [
          { full_name: "o/pub", private: false },
          { full_name: "o/priv", private: true },
        ],
      },
      "GET /repos/o/pub": { data: { has_wiki: false, private: false } },
      "GET /repos/o/pub/contents/.github/settings.yml": {
        data: "repository:\n  has_wiki: false\n",
      },
      "GET /repos/o/priv": { data: { has_wiki: false, private: true } },
      "GET /repos/o/priv/contents/.github/settings.yml": {
        data: "repository:\n  has_wiki: false\n",
      },
    });
    const { io, annotations } = captureIo();
    const { targets } = await runMulti(
      api,
      cfg({ reposInput: "*", mode: "check", privateRepos: "redact" }),
      io,
    );
    // o/priv is redacted from the discovery-supplied visibility, with no extra
    // probe: its only GET is the engine's repository read.
    const privGets = api.calls.filter((c) => c.method === "GET" && c.path === "/repos/o/priv");
    expect(privGets).toHaveLength(1);
    expect(targets.find((t) => t.slug === "o/priv")?.redacted).toBe(true);
    expect(annotations.join("\n")).not.toContain("o/priv");
  });

  test("a probe error fails closed: an unknown-visibility target is redacted", async () => {
    // The repo probe 404s (no route), so visibility is unknown -> redacted.
    // The contents read then also 404s, so the target fails; the failure line
    // must be generic, never naming the slug.
    const api = new MockApi({});
    const { io, annotations } = captureIo();
    const { targets } = await runMulti(
      api,
      cfg({ reposInput: "o/mystery", privateRepos: "redact" }),
      io,
    );
    expect(targets[0]?.redacted).toBe(true);
    expect(targets[0]?.display).toBe("private repository #1");
    const all = annotations.join("\n");
    expect(all).not.toContain("o/mystery");
    expect(all).toContain("private repository #1: failed");
  });

  test("placeholders number private targets 1-based in target order", async () => {
    const api = new MockApi({
      "GET /repos/o/pub": { data: { private: false } },
      "GET /repos/o/pub/contents/.github/settings.yml": {
        data: "repository:\n  has_wiki: false\n",
      },
      "GET /repos/o/p1": { data: { private: true } },
      "GET /repos/o/p1/contents/.github/settings.yml": { data: "repository:\n  has_wiki: false\n" },
      "GET /repos/o/p2": { data: { private: true } },
      "GET /repos/o/p2/contents/.github/settings.yml": { data: "repository:\n  has_wiki: false\n" },
    });
    const { io } = captureIo();
    const { targets } = await runMulti(
      api,
      cfg({ reposInput: "o/p1, o/pub, o/p2", mode: "check", privateRepos: "redact" }),
      io,
    );
    const display = Object.fromEntries(targets.map((t) => [t.slug, t.display]));
    expect(display).toEqual({
      "o/p1": "private repository #1",
      "o/pub": "o/pub",
      "o/p2": "private repository #2",
    });
  });
});

describe("toPublicView", () => {
  test("a plain target passes through byte-identical, keyed by slug", () => {
    const view = toPublicView({
      slug: "o/pub",
      source: "remote",
      origin: 'the "repos" input',
      result: "drift",
      outcomes: [{ key: "repository", status: "drift", detail: ["has_wiki: true != false"] }],
      skippedSections: [],
      display: "o/pub",
      redacted: false,
    });
    expect(view.display).toBe("o/pub");
    expect(view.outcomes[0]?.detail).toEqual(["has_wiki: true != false"]);
  });

  test("a redacted target hides every detail, keeps statuses, adds HTTP codes on failures", () => {
    const view = toPublicView({
      slug: "o/priv",
      source: "remote",
      origin: 'the "repos" input',
      result: "failed",
      outcomes: [
        { key: "repository", status: "applied", detail: ["changed description to SECRET"] },
        { key: "labels", status: "failed", detail: ["denied SECRET"], httpStatus: 403 },
      ],
      skippedSections: [],
      note: "boom SECRET",
      display: "private repository #2",
      redacted: true,
    });
    expect(view.display).toBe("private repository #2");
    const flat = JSON.stringify(view);
    expect(flat).not.toContain("SECRET");
    expect(view.outcomes[0]?.detail).toEqual(["hidden (private repository)"]);
    expect(view.outcomes[1]?.detail).toEqual(["hidden (private repository), HTTP 403"]);
    expect(view.outcomes[1]?.status).toBe("failed");
    expect(view.note).toContain("details hidden");
  });
});

describe("redactOutcomes (shared by the multi view and the single-repo summary)", () => {
  test("keeps key+status, hides detail, and appends HTTP code only on failed/skipped", () => {
    const redacted = redactOutcomes([
      { key: "repository", status: "applied", detail: ["set has_wiki=false SECRET"] },
      { key: "labels", status: "skipped", detail: ["denied SECRET"], httpStatus: 404 },
      { key: "rulesets", status: "failed", detail: ["boom SECRET"], httpStatus: 403 },
      { key: "teams", status: "clean", detail: ["no changes SECRET"] },
    ]);
    expect(JSON.stringify(redacted)).not.toContain("SECRET");
    expect(redacted).toEqual([
      { key: "repository", status: "applied", detail: ["hidden (private repository)"] },
      { key: "labels", status: "skipped", detail: ["hidden (private repository), HTTP 404"] },
      { key: "rulesets", status: "failed", detail: ["hidden (private repository), HTTP 403"] },
      { key: "teams", status: "clean", detail: ["hidden (private repository)"] },
    ]);
  });
});

describe("runMulti private-report: issue wiring", () => {
  const MARKER = "settings-as-code-report";
  const ISSUE_TITLE = "[automated] settings-as-code: private settings report";
  const listPath = (slug: string) =>
    `GET /repos/${slug}/issues?state=all&labels=${MARKER}&per_page=100`;

  /**
   * A private drifting target whose report issue already exists (found by the
   * marker-label list), so delivery is a single PATCH we can inspect. The
   * settings.yml drift carries a CANARY the report body must contain and the
   * public surfaces must not.
   */
  function reportApi(
    overrides: Record<
      string,
      { data?: unknown; error?: { status: number; message: string; body: string } }
    > = {},
  ) {
    return new MockApi({
      "GET /repos/o/priv": { data: { description: "CANARY-live", private: true } },
      "GET /repos/o/priv/contents/.github/settings.yml": {
        data: 'repository:\n  description: "CANARY-want"\n',
      },
      "POST /repos/o/priv/labels": { error: { status: 422, message: "exists", body: "" } },
      [listPath("o/priv")]: {
        data: [{ number: 7, title: ISSUE_TITLE, html_url: "https://github.com/o/priv/issues/7" }],
      },
      "PATCH /repos/o/priv/issues/7": { data: { number: 7 } },
      ...overrides,
    });
  }

  test("delivers the full report to the target issue; body has detail+transcript, public surfaces do not", async () => {
    const api = reportApi();
    const { io, annotations, logs } = captureIo();
    const { targets } = await runMulti(
      api,
      cfg({
        reposInput: "o/priv",
        mode: "check",
        privateRepos: "redact",
        privateReport: "issue",
        selfSlug: "admin/repo",
        runUrl: "https://example.com/run/1",
      }),
      io,
    );
    expect(targets[0]?.result).toBe("drift");
    // the report issue was PATCHed (found by marker label -> one request)
    const patch = api.calls.find(
      (c) => c.method === "PATCH" && c.path === "/repos/o/priv/issues/7",
    );
    const payload = (patch?.payload ?? {}) as { body?: unknown; state?: unknown };
    const body = String(payload.body ?? "");
    // the report body carries the full unredacted detail and the transcript
    expect(body).toContain("CANARY-live");
    expect(body).toContain("o/priv");
    expect(body).toContain("## Transcript");
    // a check-mode drift needs attention -> the issue is opened
    expect(payload.state).toBe("open");
    // and NONE of that leaks to the public surfaces
    const publicText = [...annotations, ...logs].join("\n");
    expect(publicText).not.toContain("CANARY-live");
    expect(publicText).not.toContain("o/priv");
  });

  test("marker label is injected when a labels section is declared, notice lands in the report only", async () => {
    const api = reportApi({
      "GET /repos/o/priv/contents/.github/settings.yml": {
        data: 'labels:\n  - name: bug\n    color: "d73a4a"\n',
      },
      "GET /repos/o/priv/labels?per_page=100&page=1": { data: [] },
    }).allowMutations("POST /repos/o/priv/labels", "PATCH /repos/o/priv/labels/bug");
    const { io, annotations } = captureIo();
    await runMulti(
      api,
      cfg({
        reposInput: "o/priv",
        mode: "apply",
        privateRepos: "redact",
        privateReport: "issue",
        selfSlug: "admin/repo",
      }),
      io,
    );
    const patch = api.calls.find(
      (c) => c.method === "PATCH" && c.path === "/repos/o/priv/issues/7",
    );
    const body = String(((patch?.payload ?? {}) as { body?: unknown }).body ?? "");
    // the injection notice is in the report transcript, not the public log
    expect(body).toContain(`added the "${MARKER}" marker label`);
    expect(annotations.some((a) => a.includes(MARKER))).toBe(false);
  });

  test("delivery failure warns safely and never changes the target result", async () => {
    const api = reportApi({
      "PATCH /repos/o/priv/issues/7": {
        error: { status: 403, message: "Resource not accessible", body: "" },
      },
    });
    const { io, annotations } = captureIo();
    const { targets } = await runMulti(
      api,
      cfg({
        reposInput: "o/priv",
        mode: "check",
        privateRepos: "redact",
        privateReport: "issue",
        selfSlug: "admin/repo",
      }),
      io,
    );
    // the target result is unchanged by the delivery failure
    expect(targets[0]?.result).toBe("drift");
    // one safe warning: placeholder + HTTP status only, no slug, no message
    const warning = annotations.find((a) => a.includes("could not deliver the private report"));
    expect(warning).toBeDefined();
    expect(warning).toContain("private repository #1");
    expect(warning).toContain("HTTP 403");
    expect(warning).not.toContain("o/priv");
    expect(warning).not.toContain("Resource not accessible");
  });

  test("no report is delivered under channel none, policy show, or for a non-redacted target", async () => {
    // channel none: even a redacted target gets no issue traffic
    const none = reportApi();
    await runMulti(
      none,
      cfg({ reposInput: "o/priv", mode: "check", privateRepos: "redact", privateReport: "none" }),
      captureIo().io,
    );
    expect(none.calls.some((c) => c.path.includes("/issues"))).toBe(false);
    expect(none.calls.some((c) => c.method === "POST" && c.path.endsWith("/labels"))).toBe(false);

    // policy show: nothing is redacted, so the report never runs (config would
    // reject this combo at parse; runMulti itself must also stay inert)
    const shown = reportApi();
    await runMulti(
      shown,
      cfg({ reposInput: "o/priv", mode: "check", privateRepos: "show", privateReport: "issue" }),
      captureIo().io,
    );
    expect(shown.calls.some((c) => c.path.includes("/issues"))).toBe(false);
  });

  test("unknown visibility redacts publicly but does NOT deliver the report (fail closed)", async () => {
    // The repo probe answers a body with neither `private` nor `visibility`, so
    // visibility resolves "unknown". Redaction still hides the target (fail
    // closed for the public view), but delivery must NOT post the private report
    // to a repo that could actually be public.
    const api = new MockApi({
      "GET /repos/o/maybe": { data: { description: "SECRET" } },
      "GET /repos/o/maybe/contents/.github/settings.yml": {
        data: 'repository:\n  description: "SECRET-want"\n',
      },
      "POST /repos/o/maybe/labels": { error: { status: 422, message: "exists", body: "" } },
    });
    const { io, annotations } = captureIo();
    const { targets } = await runMulti(
      api,
      cfg({ reposInput: "o/maybe", mode: "check", privateRepos: "redact", privateReport: "issue" }),
      io,
    );
    // redacted in the public view
    expect(targets[0]?.redacted).toBe(true);
    // but NO issue/label traffic - the report was withheld
    expect(api.calls.some((c) => c.path.includes("/issues"))).toBe(false);
    expect(api.calls.some((c) => c.method === "POST" && c.path.endsWith("/labels"))).toBe(false);
    // one safe notice explains the withholding; no slug leaks
    const withheld = annotations.find((a) => a.includes("visibility could not be verified"));
    expect(withheld).toBeDefined();
    expect(withheld).toContain("private repository #1");
    expect(annotations.join("\n")).not.toContain("o/maybe");
  });

  test("an internal target IS deliverable (proven private/internal)", async () => {
    const api = reportApi({
      "GET /repos/o/priv": { data: { description: "CANARY-live", visibility: "internal" } },
    });
    const { io } = captureIo();
    await runMulti(
      api,
      cfg({ reposInput: "o/priv", mode: "check", privateRepos: "redact", privateReport: "issue" }),
      io,
    );
    // internal is deliverable: the issue was upserted
    expect(api.calls.some((c) => c.method === "PATCH" && c.path === "/repos/o/priv/issues/7")).toBe(
      true,
    );
  });

  test("a settings-read failure still delivers a report (whole lifecycle covered)", async () => {
    // The remote settings.yml is unparseable YAML - a pre-engine failure. The
    // target fails, but the private report must STILL be delivered (and opened),
    // so a previously-created issue never keeps a stale body. Finding R3.
    const api = reportApi({
      "GET /repos/o/priv/contents/.github/settings.yml": { data: "repository: [oops\n" },
    });
    const { io, annotations } = captureIo();
    const { targets } = await runMulti(
      api,
      cfg({ reposInput: "o/priv", mode: "apply", privateRepos: "redact", privateReport: "issue" }),
      io,
    );
    expect(targets[0]?.result).toBe("failed");
    // the report issue was still PATCHed and OPENED (a failure needs attention)
    const patch = api.calls.find(
      (c) => c.method === "PATCH" && c.path === "/repos/o/priv/issues/7",
    );
    const payload = (patch?.payload ?? {}) as { body?: unknown; state?: unknown };
    expect(patch).toBeDefined();
    expect(payload.state).toBe("open");
    // the parse-failure detail is in the private report body, not the public log
    expect(String(payload.body ?? "")).toContain("failed");
    expect(annotations.join("\n")).not.toContain("oops");
  });
});

describe("applyMarkerInjection", () => {
  const MARKER = "settings-as-code-report";

  test("off: settings pass through untouched with no notice", () => {
    const settings = { labels: [{ name: "bug", color: "d73a4a" }] };
    const result = applyMarkerInjection(settings, false);
    expect(result.settings).toBe(settings);
    expect(result.notice).toBeUndefined();
  });

  test("on but no labels section: no injection, no notice", () => {
    const settings = { repository: { has_wiki: false } };
    const result = applyMarkerInjection(settings, true);
    expect(result.settings).toEqual(settings);
    expect(result.notice).toBeUndefined();
  });

  test("on with a labels section lacking the marker: appends it and returns a notice", () => {
    const settings = { labels: [{ name: "bug", color: "d73a4a" }] };
    const result = applyMarkerInjection(settings, true);
    expect(result.notice).toContain(MARKER);
    const names = (result.settings.labels ?? []).map((l) => l.name);
    expect(names).toContain(MARKER);
    expect(names).toContain("bug");
  });

  test("on with the marker already declared: no duplicate, no notice", () => {
    const settings = { labels: [{ name: MARKER, color: "0e2a47" }] };
    const result = applyMarkerInjection(settings, true);
    expect(result.notice).toBeUndefined();
    expect(result.settings.labels).toHaveLength(1);
  });
});
