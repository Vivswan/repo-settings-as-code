/**
 * The one place YAML settings documents are read and parsed. Callers
 * compose their own advice around the returned raw error string, because
 * the right fix differs per source (defaults file, central file, single
 * settings file, remote file).
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { SettingsFile } from "../schema.js";

/** Parse one YAML settings document; empty/null documents become {}. */
export function parseSettingsDoc(raw: string): { settings: SettingsFile } | { error: string } {
  try {
    return { settings: (parseYaml(raw) ?? {}) as SettingsFile };
  } catch (error) {
    return { error: String(error) };
  }
}

/** Read and parse one settings file; the error covers both steps. */
export function readSettingsFile(path: string): { settings: SettingsFile } | { error: string } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return { error: String(error) };
  }
  return parseSettingsDoc(raw);
}
