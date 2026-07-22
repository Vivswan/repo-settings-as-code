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
        onRateLimit: (retryAfter, options, _octokit, retryCount) => {
          debugLog(
            `rate limit on ${options.method} ${options.url}; retry ${retryCount + 1}/${MAX_RETRIES} after ${retryAfter}s`,
          );
          return retryAfter <= MAX_RETRY_WAIT_S && retryCount < MAX_RETRIES;
        },
        onSecondaryRateLimit: (retryAfter, options, _octokit, retryCount) => {
          debugLog(
            `secondary rate limit on ${options.method} ${options.url}; retry ${retryCount + 1}/${MAX_RETRIES} after ${retryAfter}s`,
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
      debugLog(
        `${method} ${path} -> ${status} (${Date.now() - started}ms)` +
          (payload === undefined ? "" : ` payload: ${JSON.stringify(payload)}`),
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
