/**
 * Thin typed GitHub REST client on node's global fetch. No SDK dependency:
 * the action bundles to a single file and the API surface we need is small.
 */

export interface ApiError {
  status: number;
  message: string;
  body: string;
}

export class GithubApi {
  constructor(
    private readonly token: string,
    private readonly baseUrl = process.env.GITHUB_API_URL ?? "https://api.github.com",
  ) {}

  /** Raw request. Returns parsed JSON (or null for 204/empty bodies). */
  async request(method: string, path: string, payload?: unknown): Promise<unknown> {
    const result = await this.tryRequest(method, path, payload);
    if ("error" in result) {
      const { status, message } = result.error;
      throw new Error(`${method} ${path} failed: ${status} ${message}`);
    }
    return result.data;
  }

  /** Like request(), but surfaces the error for callers that classify it. */
  async tryRequest(
    method: string,
    path: string,
    payload?: unknown,
    options?: { accept?: string },
  ): Promise<{ data: unknown } | { error: ApiError }> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Accept: options?.accept ?? "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const text = await response.text();
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
    return { data: JSON.parse(text) };
  }

  /** GET every page of a list endpoint. */
  async list(path: string): Promise<unknown[]> {
    const items: unknown[] = [];
    const separator = path.includes("?") ? "&" : "?";
    for (let page = 1; ; page++) {
      const data = await this.request("GET", `${path}${separator}per_page=100&page=${page}`);
      const chunk = data as unknown[];
      if (!Array.isArray(chunk)) {
        throw new Error(`GET ${path} did not return a list`);
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
