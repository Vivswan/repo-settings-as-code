/**
 * `branches:` section - classic branch protection, Probot schema:
 * [{name, protection: {...} | null}]. The protection PUT requires the four
 * core keys to be present (null is a valid value); protection: null removes
 * protection entirely.
 */

import { z } from "zod";
import { subsetDiff } from "../engine/diff.js";
import type { BranchConfig } from "../schema.js";
import {
  anyRecord,
  call,
  type EndpointDecl,
  emptyResult,
  expand,
  grantFor,
  probeAbsent,
  rejectDuplicates,
  type SectionModule,
  type SectionPermission,
  type SectionResult,
} from "./contract.js";

const REQUIRED_PROTECTION_KEYS = [
  "required_status_checks",
  "enforce_admins",
  "required_pull_request_reviews",
  "restrictions",
] as const;

const permission: SectionPermission = { repo: ["administration"] };

const ENDPOINTS = {
  getProtection: {
    route: "GET /repos/{owner}/{repo}/branches/{branch}/protection",
    statuses: { 200: "the branch protection", 404: "the branch is unprotected or does not exist" },
  },
  putProtection: {
    route: "PUT /repos/{owner}/{repo}/branches/{branch}/protection",
    statuses: { 200: "protection replaced" },
  },
  removeProtection: {
    route: "DELETE /repos/{owner}/{repo}/branches/{branch}/protection",
    statuses: { 204: "protection removed" },
  },
  // Advisory branch-existence probe: called directly via tryRequest (not
  // through the enforced helpers), declared here so the dictionary is
  // complete for downstream mock-route and USED_PATHS derivation. It is
  // Contents-gated in reality, but that requirement stays OUT of the
  // section's grant prose because the probe is optional (a token without
  // Contents just skips the advisory branch-does-not-exist wording).
  branchProbe: {
    route: "GET /repos/{owner}/{repo}/branches/{branch}",
    statuses: { 200: "the branch exists", 404: "no such branch" },
    permission: { repo: ["contents"] },
  },
} as const satisfies Record<string, EndpointDecl>;

export const branchesSection: SectionModule<"branches"> = {
  key: "branches",
  permission,
  grant: grantFor(permission),
  endpoints: ENDPOINTS,
  shape: z.array(z.looseObject({ name: z.string(), protection: anyRecord.nullable() })),
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const desired = desiredRaw as BranchConfig[];
    // Protection is keyed by exact branch name; two entries for the same
    // branch would overwrite each other's PUT on every run.
    rejectDuplicates(
      this,
      desired,
      (b) => b.name,
      (b) => b.name,
    );
    for (const branch of desired) {
      if (branch.protection === null) {
        const probe = await probeAbsent(ctx, this, ENDPOINTS.getProtection, {
          params: { branch: branch.name },
        });
        const isProtected = !("missing" in probe);
        if (ctx.check) {
          if (isProtected) {
            result.drift.push(
              `branches[${branch.name}]: protected live but the settings file declares protection: null; apply will remove the protection`,
            );
          }
        } else if (isProtected) {
          await call(ctx, this, ENDPOINTS.removeProtection, { params: { branch: branch.name } });
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
        const probe = await probeAbsent(ctx, this, ENDPOINTS.getProtection, {
          params: { branch: branch.name },
        });
        if ("missing" in probe) {
          // Protection 404s for a missing BRANCH too. The branch probe is
          // advisory: only a definitive 404 flips the message (other errors,
          // e.g. a token without Contents read, fall back to the plain
          // unprotected reading rather than misreporting or failing).
          const branchProbe = await ctx.api.tryRequest(
            "GET",
            expand(ENDPOINTS.branchProbe, ctx, { branch: branch.name }),
          );
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
        await call(ctx, this, ENDPOINTS.putProtection, {
          params: { branch: branch.name },
          payload,
        });
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
 * Unwrap both so check mode compares like with like. Exported so the e2e
 * state tests assert their protectionFromPut transformer inverts this exact
 * function (not a lookalike copy).
 */
export function flattenProtection(live: Record<string, unknown>): Record<string, unknown> {
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
