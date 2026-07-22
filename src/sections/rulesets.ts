/**
 * `rulesets:` section - upsert by name with full-payload PUT (a partial PUT
 * silently narrows a ruleset). Undeclared rulesets are NEVER deleted; they
 * are listed as notes so removal stays an explicit human action.
 */

import { z } from "zod";
import { subsetDiff } from "../engine/diff.js";
import type { RulesetConfig } from "../schema.js";
import {
  call,
  type EndpointDecl,
  emptyResult,
  grantFor,
  listAll,
  rejectDuplicates,
  type SectionModule,
  type SectionPermission,
  type SectionResult,
} from "./contract.js";

/**
 * Ruleset ref includes/excludes: the file may use short names ("staging",
 * "templates/*"); the API wants full refs. Native tokens (~DEFAULT_BRANCH,
 * ~ALL) and already-qualified refs pass through untouched.
 */
export function normalizeRefName(value: string, target: string): string {
  if (value.startsWith("~") || value.startsWith("refs/")) {
    return value;
  }
  if (target === "tag") {
    return `refs/tags/${value}`;
  }
  if (target === "branch") {
    return `refs/heads/${value}`;
  }
  // Unknown (future) targets: never guess a prefix - pass through verbatim.
  return value;
}

/** Deep-copy a ruleset with normalized ref conditions (never mutates input). */
export function normalizeRuleset(ruleset: RulesetConfig): RulesetConfig {
  const copy = structuredClone(ruleset);
  copy.target = copy.target ?? "branch";
  // The create endpoint requires enforcement; "active" is the useful default.
  copy.enforcement = copy.enforcement ?? "active";
  const target = copy.target;
  const refName = copy.conditions?.ref_name;
  if (refName && target !== "push") {
    if (refName.include) {
      refName.include = refName.include.map((v) => normalizeRefName(v, target));
    }
    if (refName.exclude) {
      refName.exclude = refName.exclude.map((v) => normalizeRefName(v, target));
    }
  }
  return copy;
}

interface LiveRulesetSummary {
  id: number;
  name: string;
  source_type?: string;
}

const permission: SectionPermission = { repo: ["administration"] };

const ENDPOINTS = {
  list: {
    route: "GET /repos/{owner}/{repo}/rulesets",
    statuses: { 200: "the repository ruleset list" },
  },
  create: { route: "POST /repos/{owner}/{repo}/rulesets", statuses: { 201: "ruleset created" } },
  get: {
    route: "GET /repos/{owner}/{repo}/rulesets/{ruleset_id}",
    statuses: { 200: "the ruleset" },
  },
  update: {
    route: "PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}",
    statuses: { 200: "ruleset updated" },
  },
} as const satisfies Record<string, EndpointDecl>;

export const rulesetsSection: SectionModule<"rulesets"> = {
  key: "rulesets",
  permission,
  grant: grantFor(permission),
  endpoints: ENDPOINTS,
  shape: z.array(
    z.looseObject({
      name: z.string(),
      // normalizeRuleset maps over these before the API can reject them, so
      // the shape must catch a non-list here (a classic missing "-" typo).
      conditions: z
        .looseObject({
          ref_name: z
            .looseObject({
              include: z.array(z.string()).optional(),
              exclude: z.array(z.string()).optional(),
            })
            .optional(),
        })
        .optional(),
    }),
  ),
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const desired = (desiredRaw as RulesetConfig[]).map(normalizeRuleset);
    // Upsert matches by exact name, so two entries with the same name would
    // fight each other (create twice, then trade updates) on every run.
    rejectDuplicates(
      this,
      desired,
      (r) => r.name,
      (r) => r.name,
    );
    const summaries = (await listAll(ctx, this, ENDPOINTS.list)) as LiveRulesetSummary[];
    const repoRulesets = summaries.filter((r) => (r.source_type ?? "Repository") === "Repository");
    const idByName = new Map(repoRulesets.map((r) => [r.name, r.id]));

    for (const ruleset of desired) {
      const id = idByName.get(ruleset.name);
      if (id === undefined) {
        if (ctx.check) {
          result.drift.push(
            `rulesets[${ruleset.name}]: missing - declared in the settings file but not on the repo; apply will create it`,
          );
        } else {
          await call(ctx, this, ENDPOINTS.create, { payload: ruleset });
          result.changes.push(`created ruleset "${ruleset.name}"`);
        }
        continue;
      }
      if (ctx.check) {
        const live = await call(ctx, this, ENDPOINTS.get, { params: { ruleset_id: String(id) } });
        result.drift.push(...subsetDiff(ruleset, live, `rulesets[${ruleset.name}]`));
      } else {
        await call(ctx, this, ENDPOINTS.update, {
          params: { ruleset_id: String(id) },
          payload: ruleset,
        });
        result.changes.push(`updated ruleset "${ruleset.name}" (id ${id})`);
      }
    }

    const declaredNames = new Set(desired.map((r) => r.name));
    for (const live of repoRulesets) {
      if (!declaredNames.has(live.name)) {
        result.notes.push(
          `ruleset "${live.name}" exists on the repo but is not declared in the settings file; left untouched - add it to the settings file to manage it, or delete it in the repo's GitHub settings`,
        );
      }
    }
    return result;
  },
};
