/**
 * GitHub Actions input reading and validation. parseConfig() reads every
 * input in a stable order, validates it (each error names the input and
 * the fix), and returns the typed RunConfig run() executes - so the
 * execution code never touches raw inputs.
 */

import * as core from "@actions/core";
import {
  AFFILIATIONS,
  ARCHIVED_FILTERS,
  DEFAULT_DISCOVERY_FILTERS,
  type DiscoveryFilters,
  FORKS_FILTERS,
  VISIBILITY_FILTERS,
} from "../discovery/discover.js";
import { SLUG_RE } from "../discovery/targets.js";
import { SECTION_KEYS } from "../schema.js";

export function input(name: string): string {
  // @actions/core reads INPUT_<NAME> (uppercased, spaces to underscores -
  // dashes survive, e.g. `settings-file` -> INPUT_SETTINGS-FILE) and trims.
  return core.getInput(name);
}

/**
 * Read an enum-valued input against the allowed list its type derives
 * from, so the type, the check, and the error message cannot drift apart.
 */
function readEnum<T extends string>(
  name: string,
  allowed: readonly T[],
  fallback: T,
  noun: string,
): T | { error: string } {
  const value = input(name) || fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    const values = allowed.map((v) => (v === fallback ? `"${v}" (default)` : `"${v}"`));
    return {
      error: `the "${name}" input is "${value}", which is not a supported ${noun}. Set it to ${values.join(", ")}`,
    };
  }
  return value as T;
}

export function quoteList(names: string[]): string {
  return names.map((name) => `"${name}"`).join(", ");
}

/** The inputs shared by both modes. */
export interface CommonConfig {
  token: string;
  mode: "apply" | "check";
  onMissingPermission: "fail" | "warn";
  requiredSections: Set<string>;
  onlySections: Set<string>;
  apiVersion: string;
}

/** Everything run() needs, already validated; `kind` picks the mode. */
export type RunConfig = CommonConfig &
  (
    | { kind: "single"; repo: string; settingsFile: string }
    | {
        kind: "multi";
        reposDir: string;
        reposInput: string;
        defaultsFile: string;
        adminOwner: string;
        discoveryFilters: DiscoveryFilters;
        /** Filter inputs the user explicitly set, for the misuse rejections. */
        discoveryFiltersSet: string[];
      }
  );

/** Read and validate every input; the first problem wins. */
export function parseConfig(): { config: RunConfig } | { error: string } {
  const token = input("token") || process.env.GITHUB_TOKEN || "";
  if (!token) {
    return {
      error:
        'cannot call the GitHub API: no token was provided. Set the "token" input on the action step (or export GITHUB_TOKEN)',
    };
  }
  const mode = input("mode") || "apply";
  if (mode !== "apply" && mode !== "check") {
    return {
      error: `the "mode" input is "${mode}", which is not a supported mode. Set it to "apply" (mutate settings) or "check" (report drift only)`,
    };
  }
  const onMissingPermission = readEnum(
    "on-missing-permission",
    ["fail", "warn"] as const,
    "fail",
    "policy",
  );
  if (typeof onMissingPermission !== "string") {
    return { error: onMissingPermission.error };
  }
  const requiredSections = new Set(
    input("required-sections")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const onlySections = new Set(
    input("sections")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const knownSections = new Set<string>(SECTION_KEYS);
  for (const name of [...requiredSections, ...onlySections]) {
    if (!knownSections.has(name)) {
      return {
        error: `unknown section "${name}" in the "sections" or "required-sections" input; it matches none of: ${SECTION_KEYS.join(", ")}. Fix the name in the workflow's input list`,
      };
    }
  }
  const apiVersion = input("api-version") || "2022-11-28";
  const common: CommonConfig = {
    token,
    mode,
    onMissingPermission,
    requiredSections,
    onlySections,
    apiVersion,
  };

  const FILTER_INPUTS = ["visibility", "archived", "forks", "exclude", "topics", "affiliation"];
  const discoveryFiltersSet = FILTER_INPUTS.filter((name) => input(name) !== "");
  const list = (name: string): string[] =>
    input(name)
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
  const visibility = readEnum(
    "visibility",
    VISIBILITY_FILTERS,
    DEFAULT_DISCOVERY_FILTERS.visibility,
    "discovery filter",
  );
  if (typeof visibility !== "string") {
    return { error: visibility.error };
  }
  const archived = readEnum(
    "archived",
    ARCHIVED_FILTERS,
    DEFAULT_DISCOVERY_FILTERS.archived,
    "archived-repository policy",
  );
  if (typeof archived !== "string") {
    return { error: archived.error };
  }
  const forks = readEnum("forks", FORKS_FILTERS, DEFAULT_DISCOVERY_FILTERS.forks, "fork policy");
  if (typeof forks !== "string") {
    return { error: forks.error };
  }
  const affiliation = [...new Set(list("affiliation"))];
  for (const entry of affiliation) {
    if (!(AFFILIATIONS as readonly string[]).includes(entry)) {
      return {
        error: `the "affiliation" input entry "${entry}" is not a supported affiliation, so discovery cannot build the /user/repos query. Use a comma-separated list of ${AFFILIATIONS.map((a) => `"${a}"`).join(", ")}`,
      };
    }
  }
  const exclude = list("exclude");
  for (const pattern of exclude) {
    const parts = pattern.split("/");
    if (parts.length > 2 || (parts.length === 2 && (!parts[0] || !parts[1]))) {
      return {
        error: `the "exclude" input pattern "${pattern}" can never match an owner/name repository: a pattern takes at most one "/", with a non-empty glob on each side of it. Use "<name-glob>" or "<owner-glob>/<name-glob>", where "*" matches any characters`,
      };
    }
  }
  const discoveryFilters: DiscoveryFilters = {
    visibility,
    archived,
    forks,
    affiliation: affiliation.length > 0 ? affiliation : DEFAULT_DISCOVERY_FILTERS.affiliation,
    topics: list("topics").map((topic) => topic.toLowerCase()),
    exclude,
  };

  const reposInput = input("repos");
  const reposDir = input("repos-dir");
  const defaultsFile = input("defaults-file");
  const settingsFile = input("settings-file") || ".github/settings.yml";

  if (reposInput || reposDir) {
    // Multi-repo mode: the single-repo inputs make no sense here.
    if (input("repository")) {
      return {
        error:
          'the "repository" input cannot be combined with "repos" or "repos-dir"; multi-repo targets come from those inputs. Remove "repository", or remove the multi-repo inputs to stay in single-repo mode',
      };
    }
    if (settingsFile !== ".github/settings.yml") {
      return {
        error:
          'the "settings-file" input cannot be combined with "repos" or "repos-dir": central targets are read from repos-dir files and remote targets from each repository\'s own .github/settings.yml. Remove the settings-file override',
      };
    }
    const adminOwner = (process.env.GITHUB_REPOSITORY ?? "").split("/")[0] ?? "";
    return {
      config: {
        ...common,
        kind: "multi",
        reposDir,
        reposInput,
        defaultsFile,
        adminOwner,
        discoveryFilters,
        discoveryFiltersSet,
      },
    };
  }

  // Single-repo mode (unchanged legacy behavior).
  if (discoveryFiltersSet.length > 0) {
    return {
      error: `the discovery filter input(s) ${quoteList(discoveryFiltersSet)} only apply to repos: "*" discovery, but this run is in single-repo mode. Set repos: "*" to discover repositories, or remove the filter input(s)`,
    };
  }
  if (defaultsFile) {
    return {
      error:
        'the "defaults-file" input only applies to multi-repo mode, but this run is in single-repo mode, so the defaults would never be merged. Remove the input, or add "repos" or "repos-dir" to switch to multi-repo mode',
    };
  }
  const repo = input("repository") || process.env.GITHUB_REPOSITORY || "";
  if (!SLUG_RE.test(repo)) {
    return {
      error: `cannot target a repository: "${repo}" is not an owner/name slug. Set the "repository" input (or GITHUB_REPOSITORY) to a value like "octocat/hello-world"`,
    };
  }
  return { config: { ...common, kind: "single", repo, settingsFile } };
}
