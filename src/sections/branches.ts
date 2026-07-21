/**
 * `branches:` section - classic branch protection, Probot schema:
 * [{name, protection: {...} | null}]. The protection PUT requires the four
 * core keys to be present (null is a valid value); protection: null removes
 * protection entirely.
 */

import { z } from "zod";
import { subsetDiff } from "../diff.js";
import type { BranchConfig } from "../schema.js";
import {
  anyRecord,
  call,
  emptyResult,
  type SectionModule,
  type SectionResult,
  throwFor,
} from "./contract.js";

const REQUIRED_PROTECTION_KEYS = [
  "required_status_checks",
  "enforce_admins",
  "required_pull_request_reviews",
  "restrictions",
] as const;

export const branchesSection: SectionModule<"branches"> = {
  key: "branches",
  grant: `grant "Administration" (read and write) under the PAT's Repository permissions`,
  shape: z.array(z.looseObject({ name: z.string(), protection: anyRecord.nullable() })),
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    for (const branch of desiredRaw as BranchConfig[]) {
      const path = `/repos/${ctx.repo}/branches/${encodeURIComponent(branch.name)}/protection`;
      if (branch.protection === null) {
        const probe = await ctx.api.tryRequest("GET", path);
        if ("error" in probe && probe.error.status !== 404) {
          throwFor(this, "GET", path, probe.error);
        }
        const isProtected = !("error" in probe);
        if (ctx.check) {
          if (isProtected) {
            result.drift.push(
              `branches[${branch.name}]: protected live but the settings file declares protection: null; apply will remove the protection`,
            );
          }
        } else if (isProtected) {
          await call(ctx, this, "DELETE", path);
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
          throwFor(this, "GET", path, probe.error);
        }
        if ("error" in probe) {
          // Protection 404s for a missing BRANCH too. The branch probe is
          // advisory: only a definitive 404 flips the message (other errors,
          // e.g. a token without Contents read, fall back to the plain
          // unprotected reading rather than misreporting or failing).
          const branchProbe = await ctx.api.tryRequest("GET", path.replace(/\/protection$/, ""));
          if ("error" in branchProbe && branchProbe.error.status === 404) {
            result.drift.push(
              `branches[${branch.name}]: declared in the settings file but the branch does not exist on the repo, so apply cannot protect it; create the branch, or remove it from the settings file`,
            );
          } else {
            result.drift.push(
              `branches[${branch.name}]: unprotected live but the settings file declares protection; apply will protect it`,
            );
          }
        } else {
          // GET shapes booleans as {enabled: bool}; compare declared keys
          // against a flattened view.
          const live = flattenProtection(probe.data as Record<string, unknown>);
          result.drift.push(
            ...subsetDiff(branch.protection, live, `branches[${branch.name}].protection`),
          );
          // Apply null-fills the four required keys, REMOVING live settings
          // the declaration omits - surface that as drift, not silence.
          for (const key of REQUIRED_PROTECTION_KEYS) {
            if (!(key in branch.protection) && live[key] != null && live[key] !== false) {
              result.drift.push(
                `branches[${branch.name}].protection.${key}: set live but omitted from the settings file, so apply would REMOVE it; add ${key} to the branch's protection in the settings file to keep it`,
              );
            }
          }
        }
      } else {
        await call(ctx, this, "PUT", path, payload);
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
  if (
    "enabled" in record &&
    typeof record.enabled === "boolean" &&
    keys.every((k) => k === "enabled" || k === "url" || k.endsWith("_url"))
  ) {
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
