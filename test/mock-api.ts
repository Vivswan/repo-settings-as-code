import type { ApiError, GithubClient } from "../src/github/api.js";

export type Route = { data?: unknown; error?: ApiError };

/** Duck-typed GithubClient over a route table; records every mutation. */
export class MockApi implements GithubClient {
  calls: Array<{ method: string; path: string; payload?: unknown }> = [];
  constructor(private routes: Record<string, Route>) {}

  async tryRequest(
    method: string,
    path: string,
    payload?: unknown,
    _options?: { accept?: string; raw?: boolean },
  ): Promise<{ data: unknown } | { error: ApiError }> {
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

  mutations() {
    return this.calls.filter((c) => c.method !== "GET");
  }
}
