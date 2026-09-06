/**
 * Shape validation for one settings document against each section's loose
 * zod shape (sections/<key>/index.ts); the parsed output is what the engine
 * applies. Closed sections and strict nested shapes reject unknown keys here.
 */

import { nonPlainKind } from "../plain-data.js";
import { SECTION_KEYS, type SettingsFile } from "../schema.js";
import { sectionModule, sectionShape } from "../sections/registry.js";

/**
 * The first non-plain object anywhere in a declared value, as "path (kind)"
 * prose - or null when the value is plain JSON data throughout. YAML's
 * explicit tags (!!timestamp, !!set, !!binary) parse to Date/Set/Uint8Array,
 * which zod's object schemas accept as empty mappings, so a tagged value
 * nested ANYWHERE (actions.cache, a pages mapping, a future section) would
 * otherwise validate and then silently configure nothing - or die later at
 * the request boundary with less context. One walk here covers every
 * section, present and future, instead of a per-shape guard that each new
 * mapping must remember (requirePlainMapping remains the shape-level belt
 * for the sections that wear it). `seen` breaks YAML anchor cycles: a
 * cyclic document is not endorsed, but the validator must not hang on one.
 */
function findNonPlain(value: unknown, path: string, seen: WeakSet<object>): string | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  if (seen.has(value)) {
    return null;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const hit = findNonPlain(value[index], `${path}[${index}]`, seen);
      if (hit !== null) {
        return hit;
      }
    }
    return null;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return `${path} is not plain YAML data (${nonPlainKind(value)}); replace it with a plain value`;
  }
  for (const [key, entry] of Object.entries(value)) {
    const hit = findNonPlain(entry, `${path}.${key}`, seen);
    if (hit !== null) {
      return hit;
    }
  }
  return null;
}

/**
 * Validate the declared sections' shapes. Returns the parsed document (the
 * declared sections, each as zod's output: fresh plain objects at every node
 * the shape describes) or an error naming the source file and what to fix.
 */
export function validateSectionShapes(
  settings: Record<string, unknown>,
  sourceLabel: string,
): { settings: SettingsFile } | { error: string } {
  const problems: string[] = [];
  const parsedSections: Record<string, unknown> = {};
  for (const key of SECTION_KEYS) {
    const declared = settings[key];
    if (declared === undefined) {
      continue;
    }
    // Plain-data gate first: zod object schemas accept a Date or Set as an
    // empty mapping, so the tagged-value rejection must not depend on any
    // shape.
    const nonPlain = findNonPlain(declared, key, new WeakSet());
    if (nonPlain !== null) {
      problems.push(nonPlain);
      continue;
    }
    const parsed = sectionShape(key).safeParse(declared);
    if (!parsed.success) {
      const issues = parsed.error.issues;
      for (const issue of issues.slice(0, 5)) {
        const path = issue.path
          .map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`))
          .join("");
        problems.push(`${key}${path}: ${issue.message}`);
      }
      if (issues.length > 5) {
        // The cap keeps the message readable, but a silently truncated list
        // would cost one fix-and-rerun cycle per hidden offender - say how
        // many more there are.
        problems.push(`${key}: ...and ${issues.length - 5} more issue(s) in this section`);
      }
      continue;
    }
    problems.push(...closedSurfaceProblems(key, parsed.data));
    parsedSections[key] = parsed.data;
  }
  if (problems.length === 0) {
    return { settings: parsedSections as SettingsFile };
  }
  return {
    error:
      `${sourceLabel} has malformed section entries: ${problems.join("; ")}. Fix these values in ` +
      `the settings file (only the named keys are validated; extra fields pass through, except ` +
      `in closed sections and strict nested objects like actions.cache, which reject ` +
      `unrecognized keys)`,
  };
}

/**
 * Unrecognized entry keys in a closed section, capped at 5 like the shape
 * issues above. Runs only after the shape parse succeeded; entries that are
 * not objects are skipped (for the current closed shapes the parse already
 * excludes them, so the guard is only defensive). A knobbed section's
 * wrapped `{undeclared, entries}` form is unwrapped first, so a closed
 * section that also takes the policy knob (collaborators) keeps its entry
 * checks in both forms - the wrapper's own keys are validated by the
 * strictObject in the section shape, never here.
 */
function closedSurfaceProblems(key: (typeof SECTION_KEYS)[number], declared: unknown): string[] {
  // The registry's generic view erases the per-section entry typing (the same
  // erasure sectionShape accepts), so the declaration is re-widened here.
  const closed = sectionModule(key).closedSurface as
    | {
        known: Readonly<Record<string, true>>;
        describe: (entry: Record<string, unknown>) => string;
        consequence: string;
      }
    | undefined;
  if (closed === undefined) {
    return [];
  }
  const entries = Array.isArray(declared)
    ? declared
    : typeof declared === "object" &&
        declared !== null &&
        Array.isArray((declared as Record<string, unknown>).entries)
      ? ((declared as Record<string, unknown>).entries as unknown[])
      : null;
  if (entries === null) {
    return [];
  }
  // The declaration's key order is the order the error prose lists.
  const knownKeys = Object.keys(closed.known);
  const known = new Set<string>(knownKeys);
  const problems: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const unknown = Object.keys(record).filter((k) => !known.has(k));
    if (unknown.length > 0) {
      const list = unknown.map((k) => `"${k}"`).join(", ");
      problems.push(
        `${key}[${closed.describe(record)}]: declares ${list}, which this section does not recognize (known keys: ${knownKeys.join(", ")}) - ${closed.consequence}. Fix the key name, or remove it`,
      );
    }
  }
  if (problems.length > 5) {
    // Same cap-with-a-count posture as the shape issues above: readable, but
    // never silently incomplete.
    return [
      ...problems.slice(0, 5),
      `${key}: ...and ${problems.length - 5} more entr${problems.length - 5 === 1 ? "y" : "ies"} with unrecognized keys in this section`,
    ];
  }
  return problems;
}
