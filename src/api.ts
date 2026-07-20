/**
 * Thin typed GitHub REST client on node's global fetch. No SDK dependency:
 * the action bundles to a single file and the API surface we need is small.
 */

export interface ApiError {
  status: number;
  message: string;
  body: string;
}

/**
 * Trace line for every API call. ::debug:: output appears only when the run
 * has step debug logging enabled (re-run with debug logging, or set the
 * ACTIONS_STEP_DEBUG secret to true), so normal runs stay quiet while a
 * debugging user sees every request, its payload, status, and timing.
 */
function debugLog(message: string): void {
  const escaped = message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  console.log(`::debug::${escaped}`);
}

export class GithubApi {
  constructor(
    private readonly token: string,
    private readonly baseUrl = process.env.GITHUB_API_URL ?? "https://api.github.com",
    private readonly apiVersion = "2022-11-28",
  ) {}

  /** Raw request. Returns parsed JSON (or null for 204/empty bodies). */
  async request(method: string, path: string, payload?: unknown): Promise<unknown> {
    const result = await this.tryRequest(method, path, payload);
    if ("error" in result) {
      const { status, message } = result.error;
      throw new Error(
        `${method} ${path} failed: ${status} ${message}. Check the token's permissions and the request payload against the GitHub REST docs for this endpoint`,
      );
    }
    return result.data;
  }

  /** Like request(), but surfaces the error for callers that classify it. */
  async tryRequest(
    method: string,
    path: string,
    payload?: unknown,
    options?: { accept?: string; raw?: boolean },
  ): Promise<{ data: unknown } | { error: ApiError }> {
    const started = Date.now();
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Accept: options?.accept ?? "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": this.apiVersion,
        ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const text = await response.text();
    debugLog(
      `${method} ${path} -> ${response.status} (${Date.now() - started}ms)` +
        (payload === undefined ? "" : ` payload: ${JSON.stringify(payload)}`),
    );
    if (!response.ok) {
      let message = text;
      try {
        const parsed = JSON.parse(text) as { message?: string; errors?: unknown };
        message = parsed.message ?? text;
        if (parsed.errors) {
          message += ` (${JSON.stringify(parsed.errors)})`;
        }
      } catch {
        // non-JSON error body; keep raw text
      }
      return { error: { status: response.status, message, body: text } };
    }
    if (!text) {
      return { data: null };
    }
    // raw: the caller asked for a non-JSON media type (e.g. raw file
    // contents); hand the body back as text.
    if (options?.raw) {
      return { data: text };
    }
    return { data: JSON.parse(text) };
  }

  /**
   * Fetch one file's raw content from a repository's default branch.
   * `missing` is a FILE-level 404, distinct from a repo-level permission
   * 404 - callers must gate repo visibility first (GET /repos/{slug}) so
   * the two cannot be confused.
   */
  async getRepoFile(
    slug: string,
    filePath: string,
  ): Promise<{ content: string } | { missing: true } | { error: ApiError }> {
    const result = await this.tryRequest("GET", `/repos/${slug}/contents/${filePath}`, undefined, {
      accept: "application/vnd.github.raw+json",
      raw: true,
    });
    if ("error" in result) {
      if (result.error.status === 404) {
        return { missing: true };
      }
      return { error: result.error };
    }
    return { content: String(result.data ?? "") };
  }

  /** GET every page of a list endpoint. */
  async list(path: string): Promise<unknown[]> {
    const items: unknown[] = [];
    const separator = path.includes("?") ? "&" : "?";
    for (let page = 1; ; page++) {
      const data = await this.request("GET", `${path}${separator}per_page=100&page=${page}`);
      const chunk = data as unknown[];
      if (!Array.isArray(chunk)) {
        throw new Error(
          `GET ${path} returned a JSON value that is not a list, so the response cannot be paginated. Check that the path is a list endpoint and the API version header matches the GitHub REST docs`,
        );
      }
      items.push(...chunk);
      if (chunk.length < 100) {
        return items;
      }
    }
  }
}

/** True when an error means the token lacks access, as opposed to a bad payload. */
export function isPermissionError(error: ApiError): boolean {
  // 403 = classic missing scope; fine-grained tokens surface missing
  // permissions as 404 on admin endpoints ("Not Found" hides the resource).
  return error.status === 403 || error.status === 404;
}
