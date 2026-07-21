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
 * opt-out of that defaults section, but only when the defaults file
 * declares that section: it is stripped from the result and reported in
 * `disabled` so the caller can say so out loud. A null section the
 * defaults do not declare passes through to the engine, where null can
 * carry meaning of its own (pages: null disables GitHub Pages).
 */
export function applyDefaults(
  defaults: SettingsFile,
  repoSettings: SettingsFile,
): { settings: SettingsFile; disabled: string[] } {
  const merged = deepMerge(defaults, repoSettings) as Record<string, unknown>;
  const disabled: string[] = [];
  for (const [key, value] of Object.entries(merged)) {
    if (value === null && (defaults as Record<string, unknown>)[key] != null) {
      delete merged[key];
      disabled.push(key);
    }
  }
  return { settings: merged as SettingsFile, disabled };
}
