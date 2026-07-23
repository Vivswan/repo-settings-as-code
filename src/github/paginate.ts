/**
 * The single per_page=100 page loop behind every list endpoint: the
 * sections' listAll/listAllEnveloped helpers and multi-repo discovery all
 * share it, so pagination behavior can never drift between callers.
 * `extract` adapts the response shape (bare array by default, or an
 * envelope key's list).
 */

import type { ApiError, GithubClient } from "./api.js";

export type PageResult = { items: unknown[] } | { error: ApiError } | { malformed: true };

/**
 * `stop`, when given, is consulted after every page with everything collected
 * so far; returning true ends the walk early with those items. Lookups that
 * only need the first match use it to avoid fetching pages past the answer.
 */
export async function paginate(
  api: GithubClient,
  path: string,
  extract: (data: unknown) => unknown[] | null = (data) => (Array.isArray(data) ? data : null),
  stop?: (items: unknown[]) => boolean,
): Promise<PageResult> {
  const items: unknown[] = [];
  const separator = path.includes("?") ? "&" : "?";
  for (let page = 1; ; page++) {
    const result = await api.tryRequest("GET", `${path}${separator}per_page=100&page=${page}`);
    if ("error" in result) {
      return { error: result.error };
    }
    const chunk = extract(result.data);
    if (chunk === null) {
      return { malformed: true };
    }
    items.push(...chunk);
    if (stop?.(items) || chunk.length < 100) {
      return { items };
    }
  }
}
