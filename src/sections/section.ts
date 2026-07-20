/** Shared section-handler contract and error classification. */

import type { ApiError, GithubApi } from "../api.js";
import { isPermissionError } from "../api.js";

export class PermissionDenied extends Error {
  constructor(
    readonly section: string,
    readonly detail: string,
  ) {
    super(`${section}: ${detail}`);
  }
}

export interface SectionContext {
  api: GithubApi;
  repo: string; // owner/name
  owner: string;
  check: boolean;
}

export interface SectionResult {
  /** Mutations performed (apply mode) or that WOULD be performed. */
  changes: string[];
  /** Drift lines (check mode). */
  drift: string[];
  /** Informational notes (unmanaged resources left alone, skips). */
  notes: string[];
}

export interface Section {
  key: string;
  run(ctx: SectionContext, desired: unknown): Promise<SectionResult>;
}

export function emptyResult(): SectionResult {
  return { changes: [], drift: [], notes: [] };
}

/**
 * Call the API; convert permission failures into PermissionDenied (handled
 * by the orchestrator's partial-success policy), everything else into a
 * hard error carrying the API's message verbatim.
 */
export async function call(
  ctx: SectionContext,
  section: string,
  method: string,
  path: string,
  payload?: unknown,
): Promise<unknown> {
  const result = await ctx.api.tryRequest(method, path, payload);
  if ("error" in result) {
    throwFor(section, method, path, result.error);
  }
  return result.data;
}

/** GET every page of a list endpoint with section error classification. */
export async function listAll(
  ctx: SectionContext,
  section: string,
  path: string,
): Promise<unknown[]> {
  const items: unknown[] = [];
  const separator = path.includes("?") ? "&" : "?";
  for (let page = 1; ; page++) {
    const result = await ctx.api.tryRequest("GET", `${path}${separator}per_page=100&page=${page}`);
    if ("error" in result) {
      throwFor(section, "GET", path, result.error);
    }
    const chunk = result.data as unknown[];
    if (!Array.isArray(chunk)) {
      throw new Error(`${section}: GET ${path} did not return a list`);
    }
    items.push(...chunk);
    if (chunk.length < 100) {
      return items;
    }
  }
}

export function throwFor(section: string, method: string, path: string, error: ApiError): never {
  const detail = `${method} ${path}: ${error.status} ${error.message}`;
  if (isPermissionError(error)) {
    throw new PermissionDenied(section, detail);
  }
  throw new Error(`${section}: ${detail}`);
}
