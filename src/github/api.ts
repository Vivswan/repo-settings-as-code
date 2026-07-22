/**
 * GitHub REST client on @octokit/rest with the retry and throttling
 * plugins: rate limits (429 and secondary 403s) and transient 5xx/network
 * failures are retried with backoff automatically, honoring Retry-After.
 * Requests still pass through VERBATIM: paths are built by the sections
 * and payloads are sent as the raw JSON body (the `data` option), so no
 * endpoint typing ever drops an unknown field.
 */

import * as core from "@actions/core";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import Bottleneck from "bottleneck/light.js";

export interface ApiError {
  status: number;
  message: string;
  body: string;
}

/**
 * The advice appended to a transient (non-permission) API failure: a network
 * blip or a 5xx that survived the retries. The single source shared by the
 * three transient-error builders (discovery's paginate failure and its
 * non-permission status branch, plus multi.ts's remote-file read failure), so
 * the "not a permission problem" wording cannot drift between them.
 */
export const RERUN_ADVICE =
  "This is not a permission problem; re-run the workflow, and retry later if it persists";

/**
 * Pinned X-GitHub-Api-Version. The single source for the header default
 * here, the action.yml `api-version` default, and the inputs fallback; the
 * action-yml contract test asserts the three stay equal.
 */
export const DEFAULT_API_VERSION = "2022-11-28";

/**
 * The one capability everything downstream depends on: a verbatim request
 * that surfaces errors as values. The engine, the sections, discovery,
 * pagination, and the test mock all program against this interface, not
 * the concrete client.
 */
export interface GithubClient {
  tryRequest(
    method: string,
    path: string,
    payload?: unknown,
    options?: { accept?: string; raw?: boolean },
  ): Promise<{ data: unknown } | { error: ApiError }>;
}

/**
 * Trace line for every API call. Debug output appears only when the run
 * has step debug logging enabled (re-run with debug logging, or set the
 * ACTIONS_STEP_DEBUG secret to true), so normal runs stay quiet while a
 * debugging user sees every request, its payload, status, and timing.
 */
function debugLog(message: string): void {
  core.debug(message);
}

/**
 * Slugs whose requests must not appear verbatim in debug traces. The URL
 * mask (`core.setSecret`) covers the slug wherever it renders, but the
 * traced request PAYLOAD is the private repository's settings content, which
 * no mask covers - so a registered slug's trace collapses the whole path to
 * `<redacted>` and drops the payload entirely. Populated alongside `io.mask`
 * by the run flows once redaction is planned, and pre-populated for the
 * duration of the visibility probe (see repo-visibility.ts) so the probe's own
 * trace - and any throttle-callback trace it triggers - fails closed before the
 * slug's visibility is even known.
 */
const redactedSlugs = new Map<string, number>();

/**
 * Register a hold on a slug so its debug traces are path-redacted and
 * payload-free. Holds are counted: the probe's temporary hold and the run
 * flow's permanent one coexist, and releasing one never clears the other.
 */
export function registerRedactedSlug(slug: string): void {
  const key = slug.toLowerCase();
  redactedSlugs.set(key, (redactedSlugs.get(key) ?? 0) + 1);
}

/** Release one hold on a slug; tracing turns legible when none remain. */
export function unregisterRedactedSlug(slug: string): void {
  const key = slug.toLowerCase();
  const holds = redactedSlugs.get(key) ?? 0;
  if (holds <= 1) {
    redactedSlugs.delete(key);
  } else {
    redactedSlugs.set(key, holds - 1);
  }
}

/**
 * If `path` targets a registered redacted slug, collapse the ENTIRE path to the
 * constant `<redacted>` and flag the payload to be dropped; otherwise return
 * the path unchanged. The whole path is replaced, not just the slug segment:
 * the prefix can itself carry a private name (a team-repo route
 * `/orgs/acme/teams/secret-team/repos/acme/private` leaks the team slug), and
 * the tail and query string carry the private repo's live state (label names,
 * branches, ruleset titles) - so anything but a constant would leak exactly
 * what redaction hides. Matches a `/repos/<owner>/<name>` segment
 * case-insensitively anywhere in the string (full URLs from the throttle
 * callbacks included).
 */
function redactTracePath(path: string): { path: string; redacted: boolean } {
  // The owner/name are constrained to the slug charset (letters, digits, dots,
  // underscores, dashes) so the match stops at the segment boundary and does
  // not swallow trailing text - octokit's own log lines put status and timing
  // after the path ("PATCH /repos/o/r - 204 with id ..."), and a greedy name
  // class would fold that into the "slug" and miss the registry lookup. The `i`
  // flag matches `/REPOS/` too: a mixed-case path must not slip the redaction.
  const match = path.match(/\/repos\/([\w.-]+\/[\w.-]+)/i);
  const slug = match?.[1];
  if (slug && redactedSlugs.has(slug.toLowerCase())) {
    return { path: "<redacted>", redacted: true };
  }
  return { path, redacted: false };
}

/**
 * Message-level redactor for octokit's free-text log LINES (as opposed to the
 * bare request paths redactTracePath handles). Octokit does not hand the logger
 * a clean path - it logs sentences like
 * `GET /repos/e2e-owner/svc-private - 200 with id undefined in 3ms` or
 * `retrying request to e2e-owner/svc-private after 429`, where a registered
 * slug can sit anywhere, not just in `/repos/<slug>` position. So this scans
 * the WHOLE message for any registered slug as a case-insensitive substring and,
 * on a hit, collapses the entire line to `<redacted>` (consistent with the path
 * policy: the text around the slug can carry live-state segments like a branch
 * name, so nothing after a hit is safe to keep). Kept separate from
 * redactTracePath on purpose - teaching the path regex to parse arbitrary log
 * prose is the fragile path.
 */
function redactMessage(message: string): string {
  const lower = message.toLowerCase();
  for (const slug of redactedSlugs.keys()) {
    if (lower.includes(slug)) {
      return "<redacted>";
    }
  }
  return message;
}

/**
 * The `log` implementation passed to Octokit. Octokit-core and its retry and
 * throttling plugins log every request line - method, URL, status - through
 * this sink; the default sink is `console`, which writes those lines (carrying
 * private slugs and live-state segments like branch names and collaborator
 * logins) to stdout/stderr with no redaction. Each line is free-text prose, not
 * a bare path, so it goes through `redactMessage` (a whole-message slug scan),
 * NOT `redactTracePath` (which only finds a `/repos/<slug>` segment and would
 * miss a slug sitting elsewhere in the sentence). Every level is demoted to the
 * debug channel so octokit's chatter stays off normal runs, matching the rest
 * of the client's tracing. Exported so the redaction is unit-testable without
 * constructing the whole client.
 */
type Log = (message: string, ...rest: unknown[]) => void;

export const redactingOctokitLog: { debug: Log; info: Log; warn: Log; error: Log } = (() => {
  const redact: Log = (message) => {
    // Octokit passes a string message; any extra args are ignored rather than
    // risk logging an object that embeds an unredacted URL.
    debugLog(redactMessage(String(message)));
  };
  return { debug: redact, info: redact, warn: redact, error: redact };
})();

// Never wait out a rate-limit reset longer than this: failing loudly with
// the API message beats stalling a workflow for an hour.
const MAX_RETRY_WAIT_S = 60;
const MAX_RETRIES = 2; // total attempts = 1 + MAX_RETRIES

const ActionOctokit = Octokit.plugin(retry, throttling);

interface OctokitHttpError {
  status: number;
  response?: { data?: unknown; headers?: Record<string, unknown> };
  message: string;
}

function isHttpError(error: unknown): error is OctokitHttpError {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { status?: unknown }).status === "number" &&
    (error as { response?: unknown }).response !== undefined
  );
}

/** RETRY_BASE_MS parsed defensively: only a finite, positive number counts. */
function testRetryBaseMs(): number | undefined {
  const value = Number(process.env.RETRY_BASE_MS ?? "");
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export class GithubApi implements GithubClient {
  private readonly octokit: InstanceType<typeof ActionOctokit>;
  constructor(
    token: string,
    private readonly baseUrl = process.env.GITHUB_API_URL ?? "https://api.github.com",
    private readonly apiVersion = DEFAULT_API_VERSION,
    // Test knob for e2e retry scenarios: RETRY_BASE_MS scales the plugin
    // waits so backoff can run in milliseconds. Non-finite or non-positive
    // values fall back to the production default.
    retryBaseMs = testRetryBaseMs() ?? 1000,
  ) {
    this.octokit = new ActionOctokit({
      auth: token,
      baseUrl: this.baseUrl,
      // Octokit's default logger is `console`, which writes request lines
      // (method + URL + status, carrying private slugs and live-state segments
      // like branch names) to stdout/stderr with no redaction, bypassing our
      // trace hardening. Route them through the same collapse-to-<redacted>
      // sink; see redactingOctokitLog.
      log: redactingOctokitLog,
      // Scales plugin waits (Retry-After units, backoff steps) so tests
      // can run in milliseconds; 1000 = real seconds in production. Each
      // plugin reads the value from its own options section.
      request: { retryAfterBaseValue: retryBaseMs },
      // Client errors must never be retried (permission 403/404s, payload
      // 422s, and 429/secondary 403s belong to the throttling plugin), so
      // the retry plugin handles only 5xx, network failures, and 408.
      retry: {
        doNotRetry: Array.from({ length: 100 }, (_, i) => 400 + i).filter((s) => s !== 408),
        retries: MAX_RETRIES,
        retryAfterBaseValue: retryBaseMs,
      },
      throttle: {
        retryAfterBaseValue: retryBaseMs,
        // The plugin paces mutating requests through a "write" limiter whose
        // 1000ms gap retryAfterBaseValue does not reach; supply the same
        // limiter with the gap on the retryBaseMs scale, so every plugin
        // wait shrinks together under the test knob (1000 = real seconds).
        write: new Bottleneck.Group({
          id: "octokit-write",
          maxConcurrent: 1,
          minTime: retryBaseMs,
        }),
        onRateLimit: (retryAfter, options, _octokit, retryCount) => {
          debugLog(
            `rate limit on ${options.method} ${redactTracePath(options.url).path}; retry ${retryCount + 1}/${MAX_RETRIES} after ${retryAfter}s`,
          );
          return retryAfter <= MAX_RETRY_WAIT_S && retryCount < MAX_RETRIES;
        },
        onSecondaryRateLimit: (retryAfter, options, _octokit, retryCount) => {
          debugLog(
            `secondary rate limit on ${options.method} ${redactTracePath(options.url).path}; retry ${retryCount + 1}/${MAX_RETRIES} after ${retryAfter}s`,
          );
          return retryAfter <= MAX_RETRY_WAIT_S && retryCount < MAX_RETRIES;
        },
      },
    });
  }

  /** Verbatim request; surfaces errors as values for callers to classify. */
  async tryRequest(
    method: string,
    path: string,
    payload?: unknown,
    options?: { accept?: string; raw?: boolean },
  ): Promise<{ data: unknown } | { error: ApiError }> {
    const started = Date.now();
    const trace = (status: number): void => {
      const safe = redactTracePath(path);
      debugLog(
        `${method} ${safe.path} -> ${status} (${Date.now() - started}ms)` +
          (safe.redacted || payload === undefined ? "" : ` payload: ${JSON.stringify(payload)}`),
      );
    };
    try {
      const response = await this.octokit.request({
        method,
        url: path,
        headers: {
          accept: options?.accept ?? "application/vnd.github+json",
          "x-github-api-version": this.apiVersion,
        },
        // `data` is the request body VERBATIM (JSON-encoded as-is), which
        // keeps the passthrough tenet: octokit never reshapes the payload.
        ...(payload === undefined ? {} : { data: payload }),
      } as unknown as Parameters<InstanceType<typeof ActionOctokit>["request"]>[0]);
      trace(response.status);
      const data = response.data as unknown;
      if (options?.raw) {
        // Non-JSON media type: octokit hands the body back as text.
        return { data: typeof data === "string" ? data : "" };
      }
      // Octokit surfaces 204/empty bodies as ""; the contract is null.
      return { data: data === undefined || data === "" ? null : data };
    } catch (error) {
      if (isHttpError(error)) {
        trace(error.status);
        const body = error.response?.data;
        let message: string;
        if (typeof body === "object" && body !== null && "message" in body) {
          message = String((body as { message: unknown }).message);
          const errors = (body as { errors?: unknown }).errors;
          if (errors) {
            message += ` (${JSON.stringify(errors)})`;
          }
        } else if (typeof body === "string" && body) {
          message = body;
        } else {
          message = error.message;
        }
        return {
          error: {
            status: error.status,
            message,
            body: typeof body === "string" ? body : JSON.stringify(body ?? ""),
          },
        };
      }
      // No HTTP response at all: network-level failure after the plugins
      // exhausted their retries.
      throw new Error(
        `${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}. Check network connectivity from the runner to ${this.baseUrl}, then re-run the workflow`,
      );
    }
  }
}

/**
 * True when a response is rate limiting in a 403 costume: primary REST
 * rate-limit exhaustion and secondary (abuse) limits arrive as 403, not
 * 429, once the throttling plugin gives up retrying.
 */
export function isRateLimitError(error: ApiError): boolean {
  return error.status === 429 || (error.status === 403 && /rate limit/i.test(error.message));
}

/** True when an error means the token lacks access, as opposed to a bad payload. */
export function isPermissionError(error: ApiError): boolean {
  if (isRateLimitError(error)) {
    return false;
  }
  // 403 = classic missing scope; fine-grained tokens surface missing
  // permissions as 404 on admin endpoints ("Not Found" hides the resource).
  return error.status === 403 || error.status === 404;
}
