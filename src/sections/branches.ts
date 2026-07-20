/**
 * `branches:` section - classic branch protection, Probot schema:
 * [{name, protection: {...} | null}]. The protection PUT requires the four
 * core keys to be present (null is a valid value); protection: null removes
 * protection entirely.
 */

import { subsetDiff } from "../diff.js";
import type { BranchConfig } from "../schema.js";
import { call, emptyResult, type Section, type SectionResult, throwFor } from "./section.js";

const REQUIRED_PROTECTION_KEYS = [
  "required_status_checks",
  "enforce_admins",
  "required_pull_request_reviews",
  "restrictions",
] as const;

export const branchesSection: Section = {
  key: "branches",
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    for (const branch of desiredRaw as BranchConfig[]) {
      const path = `/repos/${ctx.repo}/branches/${encodeURIComponent(branch.name)}/protection`;
      if (branch.protection === null) {
        const probe = await ctx.api.tryRequest("GET", path);
        if ("error" in probe && probe.error.status !== 404) {
          throwFor(this.key, "GET", path, probe.error);
        }
        const isProtected = !("error" in probe);
        if (ctx.check) {
          if (isProtected) {
            result.drift.push(`branches[${branch.name}]: protected, should be unprotected`);
          }
        } else if (isProtected) {
          await call(ctx, this.key, "DELETE", path);
          result.changes.push(`removed protection from "${branch.name}"`);
        }
        continue;
      }
      // The classic API rejects payloads missing the core keys; fill nulls.
      const payload: Record<string, unknown> = { ...branch.protection };
      for (const key of REQUIRED_PROTECTION_KEYS) {
        if (!(key in payload)) {
          payload[key] = null;
        }
      }
      if (ctx.check) {
        const probe = await ctx.api.tryRequest("GET", path);
        if ("error" in probe && probe.error.status !== 404) {
          throwFor(this.key, "GET", path, probe.error);
        }
        if ("error" in probe) {
          result.drift.push(`branches[${branch.name}]: unprotected, should be protected`);
        } else {
          // GET shapes booleans as {enabled: bool}; compare declared keys
          // against a flattened view.
          const live = flattenProtection(probe.data as Record<string, unknown>);
          result.drift.push(
            ...subsetDiff(branch.protection, live, `branches[${branch.name}].protection`),
          );
        }
      } else {
        await call(ctx, this.key, "PUT", path, payload);
        result.changes.push(`applied protection to "${branch.name}"`);
      }
    }
    return result;
  },
};

/**
 * GET /protection wraps booleans as {url, enabled} and expands actor lists
 * (restrictions, dismissal_restrictions, bypass_pull_request_allowances)
 * into user/team/app OBJECTS, while the PUT shape uses login/slug strings.
 * Unwrap both so check mode compares like with like.
 */
function flattenProtection(live: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(live)) {
    out[key] = flattenValue(value);
  }
  return out;
}

const ACTOR_NAME_KEYS = ["login", "slug"] as const;
const ACTOR_LIST_KEYS = new Set(["users", "teams", "apps"]);

function flattenValue(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(flattenValue);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if ("enabled" in record && keys.every((k) => k === "enabled" || k === "url")) {
    return record.enabled;
  }
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(record)) {
    if (ACTOR_LIST_KEYS.has(key) && Array.isArray(inner)) {
      out[key] = inner.map((actor) => {
        if (typeof actor === "object" && actor !== null) {
          for (const nameKey of ACTOR_NAME_KEYS) {
            const name = (actor as Record<string, unknown>)[nameKey];
            if (typeof name === "string") {
              return name;
            }
          }
        }
        return actor;
      });
    } else if (key.endsWith("_url") || key === "url") {
      // URLs never appear in the PUT shape; drop to avoid noise.
    } else {
      out[key] = flattenValue(inner);
    }
  }
  return out;
}
