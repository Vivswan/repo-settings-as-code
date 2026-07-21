/** Shared section-handler contract and error classification. */

import { z } from "zod";
import type { ApiError, GithubClient } from "../github/api.js";
import { isPermissionError, isRateLimitError } from "../github/api.js";
import { paginate } from "../github/paginate.js";
import type { SectionKey } from "../schema.js";

export class PermissionDenied extends Error {
  constructor(
    readonly section: string,
    readonly detail: string,
  ) {
    super(`${section}: ${detail}`);
  }
}

export interface SectionContext {
  api: GithubClient;
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

/**
 * The identity every helper needs to classify an error: the section's key
 * and its fine-grained-PAT grant advice. Handlers pass `this`, so the
 * advice always travels with the section that owns it.
 */
export interface SectionMeta<K extends SectionKey = SectionKey> {
  key: K;
  /**
   * How to grant a fine-grained PAT access to this section's endpoints,
   * used verbatim in permission errors. The README's "Token permissions
   * by section" table mirrors these.
   */
  grant: string;
}

/**
 * One settings section, self-contained: identity and grant advice
 * (SectionMeta), the loose shape validation accepts for its declared
 * value, and the handler. Modules register in ./registry.ts.
 */
export interface SectionModule<K extends SectionKey = SectionKey> extends SectionMeta<K> {
  /**
   * Loose zod shape for the declared value: only the natural keys the
   * handler needs are checked; every unknown field passes through
   * untouched, so validation can never fight the passthrough-first
   * forward-compatibility tenet.
   */
  shape: z.ZodType;
  run(ctx: SectionContext, desired: unknown): Promise<SectionResult>;
}

/** The loose "any YAML mapping" shape for passthrough-heavy sections. */
export const anyRecord = z.record(z.string(), z.unknown());

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
  section: SectionMeta,
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

/**
 * Like call(), but the statuses in `tolerate` come back as { error } for
 * the caller to interpret (e.g. a 409 that means "drift" or "in
 * progress", not failure); every other error classifies through throwFor.
 */
export async function tryCall(
  ctx: SectionContext,
  section: SectionMeta,
  method: string,
  path: string,
  opts: { payload?: unknown; tolerate: number[] },
): Promise<{ data: unknown } | { error: ApiError }> {
  const result = await ctx.api.tryRequest(method, path, opts.payload);
  if ("error" in result && !opts.tolerate.includes(result.error.status)) {
    throwFor(section, method, path, result.error);
  }
  return result;
}

/**
 * GET a resource whose absence is a normal state: the statuses in
 * `tolerate` (default 404) come back as { missing: true }, every other
 * error classifies through throwFor. The shared idiom behind "does this
 * branch/site/environment/toggle exist" probes.
 */
export async function probeAbsent(
  ctx: SectionContext,
  section: SectionMeta,
  path: string,
  options?: { tolerate?: number[]; accept?: string },
): Promise<{ data: unknown } | { missing: true }> {
  const tolerate = options?.tolerate ?? [404];
  const result = await ctx.api.tryRequest("GET", path, undefined, { accept: options?.accept });
  if ("error" in result) {
    if (tolerate.includes(result.error.status)) {
      return { missing: true };
    }
    throwFor(section, "GET", path, result.error);
  }
  return { data: result.data };
}

/**
 * Section-flavored pagination: delegate the page loop to github/paginate,
 * classify errors through throwFor; `extract` adapts the response shape
 * (bare array, or a {total_count, <key>: []} envelope).
 */
async function listPages(
  ctx: SectionContext,
  section: SectionMeta,
  path: string,
  extract: (data: unknown) => unknown[] | null,
  shape: string,
): Promise<unknown[]> {
  const result = await paginate(ctx.api, path, extract);
  if ("error" in result) {
    throwFor(section, "GET", path, result.error);
  }
  if ("malformed" in result) {
    throw new Error(
      `${section.key}: GET ${path} returned a JSON value without ${shape}, so the response cannot be paginated. Check the "api-version" input against the GitHub REST docs for this endpoint`,
    );
  }
  return result.items;
}

/** GET every page of a bare-array list endpoint. */
export async function listAll(
  ctx: SectionContext,
  section: SectionMeta,
  path: string,
): Promise<unknown[]> {
  return listPages(ctx, section, path, (data) => (Array.isArray(data) ? data : null), "a list");
}

/**
 * Like listAll, for endpoints that wrap the list in an envelope object
 * (e.g. GET /actions/workflows returns {total_count, workflows: []}).
 */
export async function listAllEnveloped(
  ctx: SectionContext,
  section: SectionMeta,
  path: string,
  envelopeKey: string,
): Promise<unknown[]> {
  return listPages(
    ctx,
    section,
    path,
    (data) => {
      const chunk = (data as Record<string, unknown> | null)?.[envelopeKey];
      return Array.isArray(chunk) ? chunk : null;
    },
    `a "${envelopeKey}" list`,
  );
}

/**
 * Reject two declared entries that resolve to the same natural key; they
 * would fight each other on every run instead of converging.
 */
export function rejectDuplicates<T>(
  section: SectionMeta,
  items: T[],
  keyOf: (item: T) => string,
  describe: (item: T) => string,
): void {
  const seen = new Map<string, string>();
  for (const item of items) {
    const key = keyOf(item);
    const first = seen.get(key);
    if (first !== undefined) {
      throw new Error(
        `${section.key}: the settings file declares both "${first}" and "${describe(item)}", which name the same ${section.key} entry. Keep exactly one entry per resource`,
      );
    }
    seen.set(key, describe(item));
  }
}

export function throwFor(
  section: SectionMeta,
  method: string,
  path: string,
  error: ApiError,
): never {
  const cause = `${method} ${path}: ${error.status} ${error.message}`;
  if (isRateLimitError(error)) {
    // Includes primary and secondary rate limits delivered as 403; those
    // must not be mistaken for missing permissions.
    throw new Error(
      `${section.key}: ${cause}. The API rate limit was hit; re-run the workflow after the limit resets, or use a token with a higher rate limit`,
    );
  }
  if (isPermissionError(error)) {
    const alsoMissing =
      error.status === 404 ? " (a 404 here can also mean the resource does not exist)" : "";
    throw new PermissionDenied(
      section.key,
      `the token was denied ${cause}${alsoMissing}. To fix, ${section.grant}`,
    );
  }
  if (error.status >= 500) {
    throw new Error(
      `${section.key}: ${cause}. GitHub returned a server error; re-run the workflow, and retry later if it persists`,
    );
  }
  if (error.status === 401) {
    throw new Error(
      `${section.key}: ${cause}. The token was rejected as invalid or expired; update the token input (or the secret it reads) with a valid, unexpired PAT`,
    );
  }
  throw new Error(
    `${section.key}: ${cause}. The API rejected the request; fix the "${section.key}" values in the settings file to satisfy the message above`,
  );
}
