/**
 * Deep merge for the defaults-file layer: defaults sit UNDER a target's
 * settings, target keys win. Plain objects merge recursively; arrays,
 * scalars, and null REPLACE - arrays are full payloads everywhere else in
 * this action (subsetDiff, ruleset PUTs), so concatenation would produce a
 * document nobody declared. Inputs are never mutated.
 */

import type { SettingsFile } from "./schema.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMerge(base: unknown, override: unknown): unknown {
  if (override === undefined) {
    return structuredClone(base);
  }
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return structuredClone(override);
  }
  const out: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(override)])) {
    out[key] = key in override ? deepMerge(base[key], override[key]) : structuredClone(base[key]);
  }
  return out;
}

/**
 * Merge the central defaults document under one target's settings. A
 * TOP-LEVEL section whose merged value is null is the target's explicit
 * opt-out of that defaults section: it is stripped from the result and
 * reported in `disabled` so the caller can say so out loud.
 */
export function applyDefaults(
  defaults: SettingsFile,
  repoSettings: SettingsFile,
): { settings: SettingsFile; disabled: string[] } {
  const merged = deepMerge(defaults, repoSettings) as Record<string, unknown>;
  const disabled: string[] = [];
  for (const [key, value] of Object.entries(merged)) {
    if (value === null) {
      delete merged[key];
      disabled.push(key);
    }
  }
  return { settings: merged as SettingsFile, disabled };
}
