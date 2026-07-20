/**
 * `labels:` section - Probot parity: upsert declared labels by
 * case-insensitive name (with `new_name` rename support) and DELETE
 * undeclared labels, loudly.
 */

import { subsetDiff } from "../diff.js";
import { nameKey, normalizeColor } from "../normalize.js";
import type { LabelConfig } from "../schema.js";
import { call, emptyResult, listAll, type Section, type SectionResult } from "./section.js";

interface LiveLabel {
  name: string;
  color: string;
  description: string | null;
}

export const labelsSection: Section = {
  key: "labels",
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const desired = desiredRaw as LabelConfig[];
    const live = (await listAll(ctx, this.key, `/repos/${ctx.repo}/labels`)) as LiveLabel[];
    const liveByKey = new Map<string, LiveLabel>();
    for (const label of live) {
      liveByKey.set(nameKey(label.name), label);
    }

    const declaredKeys = new Set<string>();
    for (const label of desired) {
      const finalName = label.new_name ?? label.name;
      declaredKeys.add(nameKey(finalName));
      declaredKeys.add(nameKey(label.name));
      const bySource = liveByKey.get(nameKey(label.name));
      const byTarget = liveByKey.get(nameKey(finalName));
      if (label.new_name && bySource && byTarget && bySource !== byTarget) {
        throw new Error(
          `labels: cannot rename "${label.name}" to "${finalName}" - both exist as separate labels; delete one first`,
        );
      }
      const existing = bySource ?? byTarget;
      const wantColor = label.color === undefined ? undefined : normalizeColor(label.color);
      const wantDescription = label.description ?? "";

      const { new_name: _newName, name: _name, ...extraKeys } = label;
      delete (extraKeys as Record<string, unknown>).color;
      delete (extraKeys as Record<string, unknown>).description;
      if (!existing) {
        if (ctx.check) {
          result.drift.push(`labels[${finalName}]: missing`);
        } else {
          await call(ctx, this.key, "POST", `/repos/${ctx.repo}/labels`, {
            name: finalName,
            ...(wantColor === undefined ? {} : { color: wantColor }),
            description: wantDescription,
            ...extraKeys, // future label fields pass through verbatim
          });
          result.changes.push(`created label "${finalName}"`);
        }
        continue;
      }

      const colorDrift = wantColor !== undefined && normalizeColor(existing.color) !== wantColor;
      const descriptionDrift =
        label.description !== undefined && (existing.description ?? "") !== wantDescription;
      const renameDrift = existing.name !== finalName;
      const extraDrift = subsetDiff(extraKeys, existing, `labels[${finalName}]`);
      if (colorDrift || descriptionDrift || renameDrift || extraDrift.length > 0) {
        if (ctx.check) {
          if (renameDrift) {
            result.drift.push(`labels[${existing.name}]: should be named "${finalName}"`);
          }
          if (colorDrift) {
            result.drift.push(
              `labels[${finalName}].color: "${wantColor}" != "${normalizeColor(existing.color)}"`,
            );
          }
          if (descriptionDrift) {
            result.drift.push(
              `labels[${finalName}].description: ${JSON.stringify(wantDescription)} != ${JSON.stringify(existing.description ?? "")}`,
            );
          }
          result.drift.push(...extraDrift);
        } else {
          await call(
            ctx,
            this.key,
            "PATCH",
            `/repos/${ctx.repo}/labels/${encodeURIComponent(existing.name)}`,
            {
              new_name: finalName,
              ...(wantColor === undefined ? {} : { color: wantColor }),
              ...(label.description === undefined ? {} : { description: wantDescription }),
              ...extraKeys, // future label fields pass through verbatim
            },
          );
          result.changes.push(`updated label "${finalName}"`);
        }
      }
    }

    // Probot parity: undeclared labels are deleted. Loud on purpose.
    for (const label of liveByKey.values()) {
      if (!declaredKeys.has(nameKey(label.name))) {
        if (ctx.check) {
          result.drift.push(`labels[${label.name}]: undeclared, would be DELETED`);
        } else {
          await call(
            ctx,
            this.key,
            "DELETE",
            `/repos/${ctx.repo}/labels/${encodeURIComponent(label.name)}`,
          );
          result.changes.push(`DELETED undeclared label "${label.name}"`);
        }
      }
    }
    return result;
  },
};
