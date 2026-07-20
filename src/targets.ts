/**
 * Multi-repo target resolution: central per-repo files in the admin repo
 * (repos-dir), the repos input (explicit list or "*" discovery), and the
 * dedup between them. Central files WIN over repos-input entries for the
 * same repository: the checked-in file is a curated, code-reviewed
 * artifact; the remote file is self-service.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { components } from "@octokit/openapi-types";
import type { GithubApi } from "./api.js";

export interface Target {
  slug: string; // owner/name, original casing
  source: "central" | "remote";
  /** Where this target came from, for messages: a file path or the input name. */
  origin: string;
  /** Central targets only: the settings file to read. */
  filePath?: string;
}

export const SLUG_RE = /^[\w.-]+\/[\w.-]+$/;

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

  try {
    for (const entry of readdirSync(reposDir).sort()) {
      const entryPath = join(reposDir, entry);
      if (statSync(entryPath).isDirectory()) {
        for (const inner of readdirSync(entryPath).sort()) {
          const innerPath = join(entryPath, inner);
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
          const slug = `${entry}/${inner.replace(YAML_EXT, "")}`;
          const bad = addTarget(slug, innerPath);
          if (bad) {
            return { error: bad };
          }
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

/** Parse the repos input: comma/newline-separated slugs, or exactly "*". */
export function parseReposInput(
  raw: string,
): { slugs: string[]; discover: boolean } | { error: string } {
  const items = raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.includes("*")) {
    if (items.length > 1) {
      return {
        error: `the "repos" input mixes "*" with explicit repositories. Use "*" alone to discover every repository the token owns, or list the repositories without it`,
      };
    }
    return { slugs: [], discover: true };
  }
  const seen = new Map<string, string>();
  for (const item of items) {
    if (!SLUG_RE.test(item)) {
      return {
        error: `the "repos" input entry "${item}" is not an owner/name slug. Fix it to a value like "octocat/hello-world" (comma- or newline-separated), or use "*" alone to discover repositories`,
      };
    }
    const key = item.toLowerCase();
    if (seen.has(key)) {
      return {
        error: `the "repos" input lists ${item} more than once. Keep exactly one entry per repository`,
      };
    }
    seen.set(key, item);
  }
  return { slugs: items, discover: false };
}

type DiscoveredRepo = Pick<components["schemas"]["repository"], "full_name" | "archived">;

/** Discover every non-archived repository the token's user owns. */
export async function discoverRepos(
  api: GithubApi,
): Promise<{ slugs: string[]; archivedSkipped: string[] } | { error: string }> {
  let repos: DiscoveredRepo[];
  try {
    repos = (await api.list("/user/repos?affiliation=owner")) as DiscoveredRepo[];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      error: `cannot discover repositories for repos: "*": ${message}. Discovery needs a user PAT; the workflow GITHUB_TOKEN and GitHub App installation tokens cannot enumerate a user's repositories. List the target repositories explicitly in the "repos" input`,
    };
  }
  const slugs: string[] = [];
  const archivedSkipped: string[] = [];
  for (const repo of repos) {
    if (repo.archived) {
      archivedSkipped.push(repo.full_name);
    } else {
      slugs.push(repo.full_name);
    }
  }
  return { slugs, archivedSkipped };
}

/**
 * Merge central and remote target lists. A central file wins over a
 * repos-input entry for the same repository (noticed, not an error).
 */
export function dedupeTargets(
  central: Target[],
  remote: Target[],
  notice: (message: string) => void,
): Target[] {
  const centralKeys = new Set(central.map((t) => t.slug.toLowerCase()));
  const out = [...central];
  for (const target of remote) {
    const winner = central.find((c) => c.slug.toLowerCase() === target.slug.toLowerCase());
    if (centralKeys.has(target.slug.toLowerCase())) {
      notice(
        `${target.slug}: using the central file ${winner?.origin}; the ${target.origin} entry for the same repository is ignored`,
      );
      continue;
    }
    out.push(target);
  }
  return out;
}
