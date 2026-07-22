import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as core from "@actions/core";
import {
  isPermissionError,
  isRateLimitError,
  redactingOctokitLog,
  registerRedactedSlug,
  unregisterRedactedSlug,
} from "../../src/github/api.js";
import { api, restoreFetch, stubFetch } from "./stub.js";

afterEach(restoreFetch);

const okJson = () =>
  new Response('{"ok":true}', { headers: { "content-type": "application/json" } });

const rateLimited = () =>
  new Response('{"message":"rate limited"}', {
    status: 429,
    headers: { "retry-after": "0", "x-ratelimit-remaining": "0" },
  });

describe("retry and throttling", () => {
  test("429 rate limits are retried until they succeed", async () => {
    const state = stubFetch([rateLimited, rateLimited, okJson]);
    const result = await api().tryRequest("GET", "/rate-limited");
    expect(state.calls).toBe(3);
    expect("data" in result && result.data).toEqual({ ok: true });
  });

  test("5xx is retried; success on a later attempt", async () => {
    const state = stubFetch([() => new Response("bad gateway", { status: 502 }), okJson]);
    const result = await api().tryRequest("GET", "/flaky");
    expect(state.calls).toBe(2);
    expect("data" in result && result.data).toEqual({ ok: true });
  }, 10_000); // The retry plugin's backoff is a fixed ~1s for the first retry.

  test("permission 403 (rate limit not exhausted) is NOT retried", async () => {
    const state = stubFetch([
      () =>
        new Response('{"message":"Forbidden"}', {
          status: 403,
          headers: { "x-ratelimit-remaining": "42" },
        }),
    ]);
    const result = await api().tryRequest("GET", "/denied");
    expect(state.calls).toBe(1);
    expect("error" in result && result.error.status).toBe(403);
  });

  test("4xx client errors are never retried", async () => {
    const state = stubFetch([
      () => new Response('{"message":"Validation Failed"}', { status: 422 }),
    ]);
    const result = await api().tryRequest("PUT", "/bad-payload", { nope: true });
    expect(state.calls).toBe(1);
    expect("error" in result && result.error.status).toBe(422);
  });

  test("exhausted rate-limit retries surface the API message", async () => {
    const state = stubFetch([rateLimited]);
    const result = await api().tryRequest("GET", "/hopeless");
    expect(state.calls).toBe(3); // 1 + MAX_RETRIES
    expect("error" in result && result.error.status).toBe(429);
    expect("error" in result && result.error.message).toContain("rate limited");
  });

  test("a rate-limit reset beyond the 60s cap fails now instead of stalling", async () => {
    // The throttling plugin derives the wait from x-ratelimit-reset for
    // primary limits; an hour-away reset must fail loudly, not stall.
    const reset = String(Math.floor(Date.now() / 1000) + 3600);
    const state = stubFetch([
      () =>
        new Response('{"message":"rate limited"}', {
          status: 429,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset },
        }),
    ]);
    const result = await api().tryRequest("GET", "/long-reset");
    expect(state.calls).toBe(1);
    expect("error" in result && result.error.status).toBe(429);
  });

  test("network failure exhausts retries, then explains connectivity", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(api().tryRequest("GET", "/down")).rejects.toThrow("Check network connectivity");
  }, 20_000); // Two fixed-backoff retries (~1s + ~4s) before the final failure.
});

describe("response shaping", () => {
  test("204/empty bodies come back as null", async () => {
    stubFetch([() => new Response(null, { status: 204 })]);
    const result = await api().tryRequest("DELETE", "/gone");
    expect("data" in result && result.data).toBeNull();
  });

  test("raw option returns the body text untouched", async () => {
    stubFetch([() => new Response("repository:\n  has_wiki: false\n")]);
    const result = await api().tryRequest("GET", "/repos/o/r/contents/x.yml", undefined, {
      accept: "application/vnd.github.raw+json",
      raw: true,
    });
    expect("data" in result && result.data).toBe("repository:\n  has_wiki: false\n");
  });
});

describe("error classification", () => {
  test("rate-limit 403s are rate limits, not permission errors", () => {
    const limited = { status: 403, message: "API rate limit exceeded for user", body: "" };
    expect(isRateLimitError(limited)).toBe(true);
    expect(isPermissionError(limited)).toBe(false);
    const denied = { status: 403, message: "Resource not accessible", body: "" };
    expect(isRateLimitError(denied)).toBe(false);
    expect(isPermissionError(denied)).toBe(true);
  });
});

describe("debug-trace hardening for redacted slugs", () => {
  /**
   * Observe what the client hands to core.debug - the single sink every trace
   * and the octokit `log` route through. Spying the sink directly (rather than
   * intercepting the global process.stdout/stderr streams) keeps the assertion
   * immune to any other test writing concurrently under the parallel runner:
   * we read exactly the messages this client produced, nothing else.
   */
  function captureDebug(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const spy = spyOn(core, "debug").mockImplementation((message?: string) => {
      lines.push(String(message));
    });
    // `lines` is a plain array the mock pushes into, so the recorded messages
    // survive restore() (callers read them after restoring the spy).
    return { lines, restore: () => spy.mockRestore() };
  }

  test("a registered slug's trace collapses the whole path and drops the payload", async () => {
    registerRedactedSlug("o/secretrepo");
    stubFetch([() => new Response(null, { status: 204 })]);
    const dbg = captureDebug();
    try {
      await api().tryRequest("PATCH", "/repos/o/secretrepo", { description: "CANARY-live" });
    } finally {
      dbg.restore();
      unregisterRedactedSlug("o/secretrepo");
    }
    const trace = dbg.lines.join("");
    // whole path collapses to the constant, no /repos/ prefix, no tail
    expect(trace).toContain("PATCH <redacted> ->");
    expect(trace).not.toContain("o/secretrepo");
    expect(trace).not.toContain("CANARY-live");
    expect(trace).not.toContain("payload:");
  });

  test("a team-repo route redacts its PREFIX too (no team slug leak)", async () => {
    // /orgs/{org}/teams/{team}/repos/{owner}/{repo} - the team slug rides in the
    // prefix before /repos/, so truncating to /repos/<redacted> would leak it.
    // The whole path must collapse to the constant.
    registerRedactedSlug("acme/private");
    stubFetch([() => new Response(null, { status: 204 })]);
    const dbg = captureDebug();
    try {
      await api().tryRequest("PUT", "/orgs/acme/teams/secret-team/repos/acme/private", {
        permission: "push",
      });
    } finally {
      dbg.restore();
      unregisterRedactedSlug("acme/private");
    }
    const trace = dbg.lines.join("");
    expect(trace).toContain("PUT <redacted> ->");
    expect(trace).not.toContain("secret-team");
    expect(trace).not.toContain("acme/private");
  });

  test("an unregistered slug traces normally, with its payload", async () => {
    stubFetch([() => new Response(null, { status: 204 })]);
    const dbg = captureDebug();
    try {
      await api().tryRequest("PATCH", "/repos/o/publicrepo", { description: "open" });
    } finally {
      dbg.restore();
    }
    const trace = dbg.lines.join("");
    expect(trace).toContain("/repos/o/publicrepo");
    expect(trace).toContain("payload:");
  });

  test("unregisterRedactedSlug restores a slug to legible tracing (probe-public undo)", async () => {
    registerRedactedSlug("o/wasprobed");
    unregisterRedactedSlug("o/wasprobed");
    stubFetch([() => new Response(null, { status: 204 })]);
    const dbg = captureDebug();
    try {
      await api().tryRequest("GET", "/repos/o/wasprobed");
    } finally {
      dbg.restore();
    }
    const trace = dbg.lines.join("");
    expect(trace).toContain("/repos/o/wasprobed");
  });

  test("holds are counted: releasing the probe's hold never clears a permanent one", async () => {
    registerRedactedSlug("o/held-twice"); // probe pre-registration
    registerRedactedSlug("o/held-twice"); // run flow's permanent registration
    unregisterRedactedSlug("o/held-twice"); // probe releases only its own hold
    stubFetch([() => new Response(null, { status: 204 })]);
    const dbg = captureDebug();
    try {
      await api().tryRequest("GET", "/repos/o/held-twice");
    } finally {
      dbg.restore();
    }
    const trace = dbg.lines.join("");
    expect(trace).not.toContain("o/held-twice");
    expect(trace).toContain("<redacted>");
    unregisterRedactedSlug("o/held-twice");
  });

  test("redactingOctokitLog routes redacted content to core.debug and never to stderr", () => {
    // The exact leak class from the fuzz stderr scan: octokit's plugins log a
    // request line like "GET /repos/owner/repo - 404 ..." (and worse, live-state
    // segments like branch names) to stderr via the default console logger.
    // redactingOctokitLog must collapse any registered slug's line to <redacted>
    // and hand it to core.debug ONLY. Both facts are asserted by spying the two
    // sinks directly - no global stream interception, so a concurrent test's
    // write cannot pollute this observation.
    registerRedactedSlug("e2e-owner/repo-1");
    const debugged: string[] = [];
    let stderrWrites = 0;
    const debugSpy = spyOn(core, "debug").mockImplementation((m?: string) => {
      debugged.push(String(m));
    });
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => {
      stderrWrites += 1;
      return true;
    });
    try {
      for (const level of ["debug", "info", "warn", "error"] as const) {
        redactingOctokitLog[level](
          "PUT /repos/e2e-owner/repo-1/branches/dev-secret/protection - 403 in 3ms",
        );
      }
      // The gap a path-only redactor misses: the slug NOT in /repos/ position.
      // Octokit's retry/throttle plugins emit free-text prose like this.
      redactingOctokitLog.warn("retrying request to e2e-owner/repo-1 after 429");
      // And octokit's own request-tracking format, slug followed by prose.
      redactingOctokitLog.debug("GET /repos/e2e-owner/repo-1 - 200 with id undefined in 3ms");
    } finally {
      debugSpy.mockRestore();
      stderrSpy.mockRestore();
      unregisterRedactedSlug("e2e-owner/repo-1");
    }
    // Every routed message went to core.debug, redacted; none of the six calls
    // reached stderr.
    expect(debugged).toHaveLength(6);
    expect(stderrWrites).toBe(0);
    const joined = debugged.join("\n");
    for (const secret of ["e2e-owner/repo-1", "dev-secret", "after 429"]) {
      expect(joined).not.toContain(secret);
    }
    expect(debugged.every((line) => line === "<redacted>")).toBe(true);
  });

  test("redactingOctokitLog leaves an unregistered slug's line intact", () => {
    const dbg = captureDebug();
    try {
      redactingOctokitLog.warn("GET /repos/o/publicrepo - 200 in 1ms");
    } finally {
      dbg.restore();
    }
    expect(dbg.lines.join("")).toContain("/repos/o/publicrepo");
  });

  test("redactingOctokitLog redacts a MIXED-CASE octokit line, slug outside /repos/ position", () => {
    // Octokit logs free-text prose and does not normalize case; the message
    // scan is case-insensitive and position-independent, so a slug written in a
    // different case, and sitting mid-sentence rather than in a /repos/ path,
    // still collapses the whole line.
    registerRedactedSlug("e2e-owner/svc-private");
    const dbg = captureDebug();
    try {
      redactingOctokitLog.warn("retrying E2E-Owner/SVC-Private after 429 (attempt 2)");
      redactingOctokitLog.debug("GET /REPOS/E2E-OWNER/SVC-PRIVATE - 200 with id undefined in 3ms");
    } finally {
      dbg.restore();
      unregisterRedactedSlug("e2e-owner/svc-private");
    }
    const trace = dbg.lines.join("");
    // no casing of the slug survives, and neither does the surrounding prose
    expect(trace.toLowerCase()).not.toContain("svc-private");
    expect(trace).not.toContain("after 429");
    expect(trace).toContain("<redacted>");
  });

  test("during the probe window an octokit line is redacted; after unregister-on-public it is legible", async () => {
    // The probe pre-registers its slug BEFORE the request, so any octokit line
    // emitted while the probe holds the slug is redacted. When the probe
    // resolves PUBLIC it releases its hold, and a later octokit line for the
    // same slug is legible again. The two observable end states are asserted.
    const { createVisibilityResolver } = await import("../../src/github/repo-visibility.js");
    // 1) A slug the probe leaves registered (private) redacts an octokit line.
    stubFetch([
      () => new Response('{"private":true}', { headers: { "content-type": "application/json" } }),
    ]);
    expect(await createVisibilityResolver(api())("owner/still-private")).toBe("private");
    let dbg = captureDebug();
    try {
      redactingOctokitLog.warn("retrying owner/still-private after 429");
    } finally {
      dbg.restore();
    }
    expect(dbg.lines.join("")).toContain("<redacted>");
    expect(dbg.lines.join("")).not.toContain("still-private");
    unregisterRedactedSlug("owner/still-private"); // release the probe's hold

    // 2) A slug the probe resolves PUBLIC is unregistered, so its line is legible.
    stubFetch([
      () => new Response('{"private":false}', { headers: { "content-type": "application/json" } }),
    ]);
    expect(await createVisibilityResolver(api())("owner/went-public")).toBe("public");
    dbg = captureDebug();
    try {
      redactingOctokitLog.warn("GET /repos/owner/went-public - 200 in 1ms");
    } finally {
      dbg.restore();
    }
    expect(dbg.lines.join("")).toContain("owner/went-public");
  });

  test("a rate-limited visibility probe leaks no raw slug in any trace", async () => {
    // Finding A: the probe pre-registers its slug as redacted, so even the
    // throttle-callback trace fired on the 429 retry - which runs before the
    // probe result would otherwise register the slug - must be redacted. The
    // probe resolves private, so the slug stays registered afterward.
    const { createVisibilityResolver } = await import("../../src/github/repo-visibility.js");
    stubFetch([
      rateLimited,
      () => new Response('{"private":true}', { headers: { "content-type": "application/json" } }),
    ]);
    const dbg = captureDebug();
    let visibility: string;
    try {
      visibility = await createVisibilityResolver(api())("secret-owner/secret-repo");
    } finally {
      dbg.restore();
      unregisterRedactedSlug("secret-owner/secret-repo");
    }
    expect(visibility).toBe("private");
    const trace = dbg.lines.join("");
    // neither the direct trace nor the throttle "rate limit on ..." line names it
    expect(trace).not.toContain("secret-owner/secret-repo");
    expect(trace).not.toContain("secret-repo");
    expect(trace).toContain("rate limit on GET <redacted>");
  });
});
