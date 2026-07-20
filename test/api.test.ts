import { afterEach, describe, expect, test } from "bun:test";
import { GithubApi } from "../src/api.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub fetch with a fixed response sequence (last one repeats); count calls. */
function stubFetch(responses: Array<() => Response>): { calls: number } {
  const state = { calls: 0 };
  globalThis.fetch = (async () => {
    const make = responses[Math.min(state.calls, responses.length - 1)];
    state.calls++;
    if (!make) {
      throw new Error("no stubbed response");
    }
    return make();
  }) as unknown as typeof fetch;
  return state;
}

// retryAfterBaseValue: 1 turns every plugin wait into milliseconds.
const api = () => new GithubApi("t", "https://api.test", "2022-11-28", 1);

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
