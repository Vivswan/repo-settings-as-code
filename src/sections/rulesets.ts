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
  emptyResult,
  listAll,
  rejectDuplicates,
  type SectionModule,
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

export const rulesetsSection: SectionModule<"rulesets"> = {
  key: "rulesets",
  grant: `grant "Administration" (read and write) under the PAT's Repository permissions`,
  shape: z.array(z.looseObject({ name: z.string() })),
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
    const summaries = (await listAll(
      ctx,
      this,
      `/repos/${ctx.repo}/rulesets`,
    )) as LiveRulesetSummary[];
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
          await call(ctx, this, "POST", `/repos/${ctx.repo}/rulesets`, ruleset);
          result.changes.push(`created ruleset "${ruleset.name}"`);
        }
        continue;
      }
      if (ctx.check) {
        const live = await call(ctx, this, "GET", `/repos/${ctx.repo}/rulesets/${id}`);
        result.drift.push(...subsetDiff(ruleset, live, `rulesets[${ruleset.name}]`));
      } else {
        await call(ctx, this, "PUT", `/repos/${ctx.repo}/rulesets/${id}`, ruleset);
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
