/** Shared section-handler contract and error classification. */

import type { ApiError, GithubApi } from "../api.js";
import { isPermissionError, isRateLimitError } from "../api.js";
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
  key: SectionKey;
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
  section: SectionKey,
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
 * GET a resource whose absence is a normal state: the statuses in
 * `tolerate` (default 404) come back as { missing: true }, every other
 * error classifies through throwFor. The shared idiom behind "does this
 * branch/site/environment/toggle exist" probes.
 */
export async function probeAbsent(
  ctx: SectionContext,
  section: SectionKey,
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
 * One page loop for every list endpoint; `extract` adapts the response
 * shape (bare array, or a {total_count, <key>: []} envelope).
 */
async function listPages(
  ctx: SectionContext,
  section: SectionKey,
  path: string,
  extract: (data: unknown) => unknown[] | null,
  shape: string,
): Promise<unknown[]> {
  const items: unknown[] = [];
  const separator = path.includes("?") ? "&" : "?";
  for (let page = 1; ; page++) {
    const result = await ctx.api.tryRequest("GET", `${path}${separator}per_page=100&page=${page}`);
    if ("error" in result) {
      throwFor(section, "GET", path, result.error);
    }
    const chunk = extract(result.data);
    if (chunk === null) {
      throw new Error(
        `${section}: GET ${path} returned a JSON value without ${shape}, so the response cannot be paginated. Check the "api-version" input against the GitHub REST docs for this endpoint`,
      );
    }
    items.push(...chunk);
    if (chunk.length < 100) {
      return items;
    }
  }
}

/** GET every page of a bare-array list endpoint. */
export async function listAll(
  ctx: SectionContext,
  section: SectionKey,
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
  section: SectionKey,
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
  section: SectionKey,
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
        `${section}: the settings file declares both "${first}" and "${describe(item)}", which name the same ${section} entry. Keep exactly one entry per resource`,
      );
    }
    seen.set(key, describe(item));
  }
}

/**
 * The full fine-grained-PAT grant advice per section. A total Record over
 * SectionKey, so adding a section without deciding its advice is a
 * compile error, and the README's "Token permissions by section" table
 * has a single code-side source to mirror.
 */
const SECTION_GRANT: Record<SectionKey, string> = {
  repository: `grant "Administration" (read and write) under the PAT's Repository permissions`,
  labels: `grant "Issues" (read and write) under the PAT's Repository permissions`,
  rulesets: `grant "Administration" (read and write) under the PAT's Repository permissions`,
  branches: `grant "Administration" (read and write) under the PAT's Repository permissions`,
  environments: `grant "Environments" (read and write) under the PAT's Repository permissions`,
  autolinks: `grant "Administration" (read and write) under the PAT's Repository permissions`,
  actions: `grant "Administration" (read and write) under the PAT's Repository permissions`,
  workflows: `grant "Actions" (read and write) under the PAT's Repository permissions`,
  pages: `grant "Pages" (read and write) under the PAT's Repository permissions`,
  code_scanning_default_setup: `grant "Administration" or "Code scanning alerts" (read and write) under the PAT's Repository permissions; a 403 on this endpoint can also mean GitHub Advanced Security (code security) is not enabled on the repository, or the repository is archived`,
  collaborators: `grant "Administration" (read and write) under the PAT's Repository permissions`,
  teams: `grant "Members" (read) under the PAT's Organization permissions and "Administration" (read and write) under its Repository permissions`,
  milestones: `grant "Issues" (read and write) under the PAT's Repository permissions`,
};

export function throwFor(
  section: SectionKey,
  method: string,
  path: string,
  error: ApiError,
): never {
  const cause = `${method} ${path}: ${error.status} ${error.message}`;
  if (isRateLimitError(error)) {
    // Includes primary and secondary rate limits delivered as 403; those
    // must not be mistaken for missing permissions.
    throw new Error(
      `${section}: ${cause}. The API rate limit was hit; re-run the workflow after the limit resets, or use a token with a higher rate limit`,
    );
  }
  if (isPermissionError(error)) {
    const alsoMissing =
      error.status === 404 ? " (a 404 here can also mean the resource does not exist)" : "";
    throw new PermissionDenied(
      section,
      `the token was denied ${cause}${alsoMissing}. To fix, ${SECTION_GRANT[section]}`,
    );
  }
  if (error.status >= 500) {
    throw new Error(
      `${section}: ${cause}. GitHub returned a server error; re-run the workflow, and retry later if it persists`,
    );
  }
  if (error.status === 401) {
    throw new Error(
      `${section}: ${cause}. The token was rejected as invalid or expired; update the token input (or the secret it reads) with a valid, unexpired PAT`,
    );
  }
  throw new Error(
    `${section}: ${cause}. The API rejected the request; fix the "${section}" values in the settings file to satisfy the message above`,
  );
}
