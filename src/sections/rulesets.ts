/**
 * `rulesets:` section - upsert by name with full-payload PUT (a partial PUT
 * silently narrows a ruleset). Undeclared rulesets are NEVER deleted; they
 * are listed as notes so removal stays an explicit human action.
 */

import { subsetDiff } from "../diff.js";
import { normalizeRuleset } from "../normalize.js";
import type { RulesetConfig } from "../schema.js";
import { call, emptyResult, listAll, type Section, type SectionResult } from "./section.js";

interface LiveRulesetSummary {
  id: number;
  name: string;
  source_type?: string;
}

export const rulesetsSection: Section = {
  key: "rulesets",
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const desired = (desiredRaw as RulesetConfig[]).map(normalizeRuleset);
    const summaries = (await listAll(
      ctx,
      this.key,
      `/repos/${ctx.repo}/rulesets`,
    )) as LiveRulesetSummary[];
    const repoRulesets = summaries.filter((r) => (r.source_type ?? "Repository") === "Repository");
    const idByName = new Map(repoRulesets.map((r) => [r.name, r.id]));

    for (const ruleset of desired) {
      const id = idByName.get(ruleset.name);
      if (id === undefined) {
        if (ctx.check) {
          result.drift.push(`rulesets[${ruleset.name}]: missing`);
        } else {
          await call(ctx, this.key, "POST", `/repos/${ctx.repo}/rulesets`, ruleset);
          result.changes.push(`created ruleset "${ruleset.name}"`);
        }
        continue;
      }
      if (ctx.check) {
        const live = await call(ctx, this.key, "GET", `/repos/${ctx.repo}/rulesets/${id}`);
        result.drift.push(...subsetDiff(ruleset, live, `rulesets[${ruleset.name}]`));
      } else {
        await call(ctx, this.key, "PUT", `/repos/${ctx.repo}/rulesets/${id}`, ruleset);
        result.changes.push(`updated ruleset "${ruleset.name}" (id ${id})`);
      }
    }

    const declaredNames = new Set(desired.map((r) => r.name));
    for (const live of repoRulesets) {
      if (!declaredNames.has(live.name)) {
        result.notes.push(`ruleset "${live.name}" is not declared; left untouched`);
      }
    }
    return result;
  },
};
