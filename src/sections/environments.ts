/**
 * `environments:` section - upsert deployment environments by name via PUT.
 * Undeclared environments are left untouched.
 */

import { z } from "zod";
import { subsetDiff } from "../engine/diff.js";
import type { EnvironmentConfig } from "../schema.js";
import {
  call,
  type EndpointDecl,
  emptyResult,
  grantFor,
  probeAbsent,
  rejectDuplicates,
  type SectionModule,
  type SectionPermission,
  type SectionResult,
} from "./contract.js";

const permission: SectionPermission = { repo: ["environments"] };

const ENDPOINTS = {
  probe: {
    route: "GET /repos/{owner}/{repo}/environments/{environment_name}",
    statuses: { 200: "the environment", 404: "no such environment yet" },
  },
  update: {
    route: "PUT /repos/{owner}/{repo}/environments/{environment_name}",
    statuses: { 200: "environment updated", 201: "environment created" },
  },
} as const satisfies Record<string, EndpointDecl>;

export const environmentsSection: SectionModule<"environments"> = {
  key: "environments",
  permission,
  grant: grantFor(permission),
  endpoints: ENDPOINTS,
  shape: z.array(z.looseObject({ name: z.string() })),
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const desired = desiredRaw as EnvironmentConfig[];
    rejectDuplicates(
      this,
      desired,
      (env) => env.name.toLowerCase(),
      (env) => env.name,
    );
    for (const env of desired) {
      const { name, ...settings } = env;
      if (ctx.check) {
        const probe = await probeAbsent(ctx, this, ENDPOINTS.probe, {
          params: { environment_name: name },
        });
        if ("missing" in probe) {
          result.drift.push(
            `environments[${name}]: missing - declared in the settings file but not on the repo; apply will create it`,
          );
        } else {
          result.drift.push(
            ...subsetDiff(settings, flattenEnvironment(probe.data), `environments[${name}]`),
          );
        }
      } else {
        await call(ctx, this, ENDPOINTS.update, {
          params: { environment_name: name },
          payload: settings,
        });
        result.changes.push(`applied environment "${name}"`);
      }
    }
    return result;
  },
};

/**
 * GET /environments/{name} nests wait_timer / prevent_self_review / reviewers
 * inside protection_rules[]; translate back into the PUT request shape so
 * check mode compares like with like.
 */
function flattenEnvironment(live: unknown): Record<string, unknown> {
  const raw = (live ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...raw };
  const rules = (raw.protection_rules ?? []) as Array<Record<string, unknown>>;
  for (const rule of rules) {
    if (rule.type === "wait_timer") {
      out.wait_timer = rule.wait_timer;
    }
    if (rule.type === "required_reviewers") {
      if (rule.prevent_self_review !== undefined) {
        out.prevent_self_review = rule.prevent_self_review;
      }
      const reviewers = (rule.reviewers ?? []) as Array<{
        type: unknown;
        reviewer?: { id?: unknown };
      }>;
      out.reviewers = reviewers.map((r) => ({ type: r.type, id: r.reviewer?.id }));
    }
    if (rule.type !== "wait_timer" && rule.type !== "required_reviewers") {
      // Future rule types: un-nest their payload keys generically so check
      // mode can compare declared settings instead of reporting false drift.
      for (const [key, value] of Object.entries(rule)) {
        if (!["id", "node_id", "type", "url"].includes(key)) {
          out[key] = value;
        }
      }
    }
  }
  return out;
}
