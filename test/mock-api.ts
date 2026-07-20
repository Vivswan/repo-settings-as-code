import type { ApiError } from "../src/api.js";

export type Route = { data?: unknown; error?: ApiError };

/** Duck-typed GithubApi over a route table; records every mutation. */
export class MockApi {
  calls: Array<{ method: string; path: string; payload?: unknown }> = [];
  constructor(private routes: Record<string, Route>) {}

  async tryRequest(
    method: string,
    path: string,
    payload?: unknown,
    _options?: { accept?: string; raw?: boolean },
  ) {
    this.calls.push({ method, path, payload });
    const route = this.routes[`${method} ${path}`];
    if (!route) {
      if (method === "GET") {
        return { error: { status: 404, message: "Not Found", body: "" } };
      }
      return { data: null }; // unrouted mutations succeed silently
    }
    if (route.error) {
      return { error: route.error };
    }
    return { data: route.data ?? null };
  }

  async request(method: string, path: string, payload?: unknown) {
    const result = await this.tryRequest(method, path, payload);
    if ("error" in result && result.error) {
      throw new Error(`${method} ${path}: ${result.error.status}`);
    }
    return "data" in result ? result.data : null;
  }

  async list(path: string) {
    const items: unknown[] = [];
    for (let page = 1; ; page++) {
      const separator = path.includes("?") ? "&" : "?";
      const data = await this.request("GET", `${path}${separator}per_page=100&page=${page}`);
      const chunk = data as unknown[];
      items.push(...chunk);
      if (chunk.length < 100) {
        return items;
      }
    }
  }

  /** Same file-vs-permission 404 contract as GithubApi.getRepoFile. */
  async getRepoFile(slug: string, filePath: string) {
    const result = await this.tryRequest("GET", `/repos/${slug}/contents/${filePath}`, undefined, {
      accept: "application/vnd.github.raw+json",
      raw: true,
    });
    if ("error" in result && result.error) {
      if (result.error.status === 404) {
        return { missing: true as const };
      }
      return { error: result.error };
    }
    return { content: String(("data" in result ? result.data : "") ?? "") };
  }

  mutations() {
    return this.calls.filter((c) => c.method !== "GET");
  }
}
