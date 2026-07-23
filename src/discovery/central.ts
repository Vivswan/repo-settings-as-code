/**
 * Central-mode target resolution: per-repo settings files checked into the
 * admin repository under repos-dir.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SLUG_RE, type Target } from "./targets.js";

const YAML_EXT = /\.ya?ml$/;

/**
 * Read the repos-dir layout: `<name>.yml` (owner = the admin repo's owner)
 * at the top level, `<owner>/<name>.yml` one directory deep.
 */
export function resolveCentralTargets(
  reposDir: string,
  adminOwner: string,
): { targets: Target[]; warnings: string[] } | { error: string } {
  if (!existsSync(reposDir)) {
    return {
      error: `repos-dir "${reposDir}" does not exist in the workspace, so there are no central settings files to read. Add an actions/checkout step before this action, or fix the repos-dir path`,
    };
  }
  const targets: Target[] = [];
  const warnings: string[] = [];
  const seen = new Map<string, string>(); // lowercased slug -> origin
  const addTarget = (slug: string, filePath: string): string | null => {
    if (!SLUG_RE.test(slug)) {
      return `${filePath} resolves to the target "${slug}", which is not a valid owner/name slug. Rename the file so <owner> and <name> contain only letters, digits, dots, underscores, and dashes`;
    }
    const key = slug.toLowerCase();
    const existing = seen.get(key);
    if (existing) {
      return `duplicate target ${slug}: defined by both ${existing} and ${filePath}. Keep exactly one settings file per repository`;
    }
    seen.set(key, filePath);
    targets.push({ slug, source: "central", origin: filePath, filePath });
    return null;
  };

  const scanOwnerDir = (dirPath: string, owner: string): string | null => {
    for (const inner of readdirSync(dirPath).sort()) {
      const innerPath = join(dirPath, inner);
      if (statSync(innerPath).isDirectory()) {
        warnings.push(
          `ignoring ${innerPath}: repos-dir supports only <name>.yml and <owner>/<name>.yml, nothing deeper. Move the files up or remove the directory`,
        );
        continue;
      }
      if (!YAML_EXT.test(inner)) {
        warnings.push(
          `ignoring ${innerPath}: not a .yml/.yaml file, so it defines no target repository`,
        );
        continue;
      }
      const bad = addTarget(`${owner}/${inner.replace(YAML_EXT, "")}`, innerPath);
      if (bad) {
        return bad;
      }
    }
    return null;
  };

  try {
    for (const entry of readdirSync(reposDir).sort()) {
      const entryPath = join(reposDir, entry);
      if (statSync(entryPath).isDirectory()) {
        const bad = scanOwnerDir(entryPath, entry);
        if (bad) {
          return { error: bad };
        }
        continue;
      }
      if (!YAML_EXT.test(entry)) {
        warnings.push(
          `ignoring ${entryPath}: not a .yml/.yaml file, so it defines no target repository`,
        );
        continue;
      }
      if (!adminOwner) {
        return {
          error: `cannot resolve ${entryPath}: top-level repos-dir files use the current repository's owner, which is unknown outside GitHub Actions. Use the <owner>/<name>.yml layout instead`,
        };
      }
      const bad = addTarget(`${adminOwner}/${entry.replace(YAML_EXT, "")}`, entryPath);
      if (bad) {
        return { error: bad };
      }
    }
  } catch (error) {
    return {
      error: `cannot read repos-dir "${reposDir}": ${String(error)}. Check that it is a readable directory of settings files`,
    };
  }
  return { targets, warnings };
}
