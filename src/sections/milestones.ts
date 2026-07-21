/**
 * `milestones:` section - upsert by title. Divergence from Probot:
 * undeclared milestones are kept (they may hold issues) and surfaced as
 * notes instead of deleted.
 */

import { z } from "zod";
import { subsetDiff } from "../diff.js";
import type { MilestoneConfig } from "../schema.js";
import {
  call,
  emptyResult,
  listAll,
  rejectDuplicates,
  type SectionModule,
  type SectionResult,
} from "./contract.js";

interface LiveMilestone {
  number: number;
  title: string;
  description: string | null;
  state: string;
}

export const milestonesSection: SectionModule<"milestones"> = {
  key: "milestones",
  grant: `grant "Issues" (read and write) under the PAT's Repository permissions`,
  shape: z.array(z.looseObject({ title: z.string() })),
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const desired = desiredRaw as MilestoneConfig[];
    rejectDuplicates(
      this,
      desired,
      (m) => m.title,
      (m) => m.title,
    );
    const live = (await listAll(
      ctx,
      this,
      `/repos/${ctx.repo}/milestones?state=all`,
    )) as LiveMilestone[];
    const liveByTitle = new Map(live.map((m) => [m.title, m]));
    const declared = new Set<string>();

    for (const milestone of desired) {
      declared.add(milestone.title);
      const existing = liveByTitle.get(milestone.title);
      // Declared-keys-only AND passthrough: every declared key (including
      // future ones like due_on) is sent verbatim; undeclared keys are
      // never touched.
      const want: Record<string, unknown> = { ...milestone };
      if (!existing) {
        if (ctx.check) {
          result.drift.push(
            `milestones[${milestone.title}]: missing - declared in the settings file but not on the repo; apply will create it`,
          );
        } else {
          await call(ctx, this, "POST", `/repos/${ctx.repo}/milestones`, want);
          result.changes.push(`created milestone "${milestone.title}"`);
        }
        continue;
      }
      const { title: _t, ...declaredFields } = milestone;
      const drift = subsetDiff(declaredFields, existing, `milestones[${milestone.title}]`);
      if (drift.length > 0) {
        if (ctx.check) {
          result.drift.push(...drift);
        } else {
          await call(ctx, this, "PATCH", `/repos/${ctx.repo}/milestones/${existing.number}`, want);
          result.changes.push(`updated milestone "${milestone.title}"`);
        }
      }
    }
    // Divergence from Probot: undeclared milestones are kept (they may hold
    // issues); surfaced as notes instead.
    for (const milestone of live) {
      if (!declared.has(milestone.title)) {
        result.notes.push(
          `milestone "${milestone.title}" exists on the repo but is not declared in the settings file; left untouched - add it to the settings file to manage it, or delete it on GitHub (closing is not enough; closed milestones are still listed)`,
        );
      }
    }
    return result;
  },
};
