/** Normalization helpers shared by section handlers and the diff engine. */

import type { RulesetConfig } from "./schema.js";

/** Topics: accept a comma-separated string or an array; lowercase, dedupe. */
export function normalizeTopics(raw: unknown): string[] {
  const values = Array.isArray(raw)
    ? raw.map(String)
    : String(raw ?? "")
        .split(",")
        .map((t) => t.trim());
  return [...new Set(values.map((t) => t.toLowerCase()).filter(Boolean))];
}

/** Label colors: GitHub stores them without the leading '#', lowercase. */
export function normalizeColor(color: unknown): string {
  return String(color ?? "")
    .replace(/^#/, "")
    .toLowerCase();
}

/**
 * Ruleset ref includes/excludes: the file may use short names ("staging",
 * "templates/*"); the API wants full refs. Native tokens (~DEFAULT_BRANCH,
 * ~ALL) and already-qualified refs pass through untouched.
 */
export function normalizeRefName(value: string, target: string): string {
  if (value.startsWith("~") || value.startsWith("refs/")) {
    return value;
  }
  return target === "tag" ? `refs/tags/${value}` : `refs/heads/${value}`;
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

/** Case-insensitive key for name-matched resources (labels). */
export function nameKey(name: string): string {
  return name.toLowerCase();
}
