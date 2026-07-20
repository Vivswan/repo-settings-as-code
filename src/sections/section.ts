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
      throw new Error(
        `${section}: GET ${path} returned a JSON value that is not a list, so the response cannot be paginated. Check the "api-version" input against the GitHub REST docs for this endpoint`,
      );
    }
    items.push(...chunk);
    if (chunk.length < 100) {
      return items;
    }
  }
}

/**
 * Fine-grained PAT permission each section most likely needs, mirrored from
 * the README's "Token permissions by section" table. Used to make
 * permission errors actionable.
 */
const SECTION_PERMISSION: Record<string, string> = {
  repository: "Administration",
  rulesets: "Administration",
  branches: "Administration",
  autolinks: "Administration",
  actions: "Administration",
  collaborators: "Administration",
  labels: "Issues",
  milestones: "Issues",
  environments: "Environments",
  pages: "Pages",
};

export function throwFor(section: string, method: string, path: string, error: ApiError): never {
  const cause = `${method} ${path}: ${error.status} ${error.message}`;
  if (isPermissionError(error)) {
    const alsoMissing =
      error.status === 404 ? " (a 404 here can also mean the resource does not exist)" : "";
    const grant =
      section === "teams"
        ? `grant "Members" (read) under the PAT's Organization permissions and "Administration" (read and write) under its Repository permissions`
        : `grant "${SECTION_PERMISSION[section] ?? "Administration"}" (read and write) under the PAT's Repository permissions`;
    throw new PermissionDenied(
      section,
      `the token was denied ${cause}${alsoMissing}. To fix, ${grant}`,
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
  if (error.status === 429) {
    throw new Error(
      `${section}: ${cause}. The API rate limit was hit; re-run the workflow after the limit resets, or use a token with a higher rate limit`,
    );
  }
  throw new Error(
    `${section}: ${cause}. The API rejected the request; fix the "${section}" values in the settings file to satisfy the message above`,
  );
}
