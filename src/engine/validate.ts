/**
 * Shape validation for one settings document. Each section's loose zod
 * shape lives on its module (sections/<key>.ts); this walks the declared
 * sections and reports every mismatch.
 */

import { SECTION_KEYS } from "../schema.js";
import { sectionShape } from "../sections/registry.js";

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
    const parsed = sectionShape(key).safeParse(declared);
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
