/**
 * Shape validation for one settings document, powered by zod. Every schema
 * is LOOSE: only the natural keys each section needs are checked, and
 * every unknown field passes through untouched, so validation can never
 * fight the passthrough-first forward-compatibility tenet.
 */

import { z } from "zod";
import { SECTION_KEYS } from "./schema.js";

const anyRecord = z.record(z.string(), z.unknown());

const SECTION_SHAPES: Record<(typeof SECTION_KEYS)[number], z.ZodType> = {
  repository: anyRecord,
  labels: z.array(z.looseObject({ name: z.string() })),
  rulesets: z.array(z.looseObject({ name: z.string() })),
  branches: z.array(z.looseObject({ name: z.string(), protection: anyRecord.nullable() })),
  environments: z.array(z.looseObject({ name: z.string() })),
  autolinks: z.array(z.looseObject({ key_prefix: z.string(), url_template: z.string() })),
  actions: anyRecord,
  pages: anyRecord,
  collaborators: z.array(z.looseObject({ username: z.string() })),
  teams: z.array(z.looseObject({ name: z.string() })),
  milestones: z.array(z.looseObject({ title: z.string() })),
};

/**
 * Validate the declared sections' shapes. Returns an error message naming
 * the source file, the exact entries, and what to fix - or null when the
 * document is well-formed. The parsed values are NOT used (zod would clone
 * them); the original document is applied verbatim.
 */
export function validateSectionShapes(
  settings: Record<string, unknown>,
  sourceLabel: string,
): string | null {
  const problems: string[] = [];
  for (const key of SECTION_KEYS) {
    const declared = settings[key];
    if (declared === undefined) {
      continue;
    }
    const parsed = SECTION_SHAPES[key].safeParse(declared);
    if (!parsed.success) {
      for (const issue of parsed.error.issues.slice(0, 5)) {
        const path = issue.path.length
          ? issue.path.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("")
          : "";
        problems.push(`${key}${path}: ${issue.message}`);
      }
    }
  }
  if (problems.length === 0) {
    return null;
  }
  return `${sourceLabel} has malformed section entries: ${problems.join("; ")}. Fix these values in the settings file (only the named keys are validated; any extra fields pass through)`;
}
