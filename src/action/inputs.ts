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
import { DEFAULT_API_VERSION } from "../github/api.js";
import { parseRecipient } from "../report/artifact-report.js";
import { type MustBeNever, SECTION_KEYS } from "../schema.js";
import {
  DEFAULT_PRIVATE_REPORT,
  DEFAULT_PRIVATE_REPOS,
  PRIVATE_REPORT_CHANNELS,
  PRIVATE_REPOS_POLICIES,
  type PrivateReportChannel,
  type PrivateReposPolicy,
} from "./redact.js";

/**
 * Default settings-file path, and the sentinel the multi-repo guard
 * compares against: an unchanged value means the user did not override it,
 * so combining it with repos/repos-dir is rejected. Single source for the
 * action.yml `settings-file` default, this fallback, the override check,
 * and multi.ts's remote-path prose.
 */
export const DEFAULT_SETTINGS_FILE = ".github/settings.yml";

/** Default `mode`, pinned against action.yml by the contract test. */
export const DEFAULT_MODE = "apply";

/** Default `on-missing-permission`, pinned against action.yml. */
export const DEFAULT_ON_MISSING_PERMISSION = "fail";

/**
 * Every input name parseConfig() reads, and the single source the
 * action.yml `inputs` block is pinned against (both directions). Keep this
 * in sync when adding or removing an input; the action-yml contract test
 * fails loudly on drift.
 */
export const INPUT_NAMES = [
  "token",
  "repository",
  "settings-file",
  "mode",
  "on-missing-permission",
  "required-sections",
  "sections",
  "api-version",
  "repos",
  "visibility",
  "archived",
  "forks",
  "exclude",
  "topics",
  "affiliation",
  "repos-dir",
  "defaults-file",
  "private-repos",
  "private-report",
  "report-public-key",
] as const;

export function input(name: (typeof INPUT_NAMES)[number]): string {
  // @actions/core reads INPUT_<NAME> (uppercased, spaces to underscores -
  // dashes survive, e.g. `settings-file` -> INPUT_SETTINGS-FILE) and trims.
  return core.getInput(name);
}

/**
 * Every discovery-filter input name, the single source both the FilterInput
 * type and the discoveryFiltersSet scan derive from. `satisfies readonly
 * (keyof DiscoveryFilters)[]` pins each entry to a real filter field, and the
 * MustBeNever check below fails compilation if a DiscoveryFilters field is
 * ever added without a matching input name here - the same exhaustiveness
 * idiom SECTION_KEYS uses in schema.ts.
 */
export const FILTER_INPUTS = [
  "visibility",
  "archived",
  "forks",
  "exclude",
  "topics",
  "affiliation",
] as const satisfies readonly (keyof DiscoveryFilters)[];

/** Read a discovery filter input, whose names are a subset of INPUT_NAMES. */
type FilterInput = (typeof FILTER_INPUTS)[number];

/** Compile-time lockstep: a DiscoveryFilters field missing from FILTER_INPUTS fails here. */
type _UnlistedFilter = MustBeNever<Exclude<keyof DiscoveryFilters, FilterInput>>;

/**
 * Read an enum-valued input against the allowed list its type derives
 * from, so the type, the check, and the error message cannot drift apart.
 */
function readEnum<T extends string>(
  name: (typeof INPUT_NAMES)[number],
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

/**
 * Resolve and validate the `report-public-key` input against the chosen
 * channel. The key is the age recipient the `artifact` channel encrypts to, so
 * it is required exactly when the channel is `artifact` and rejected otherwise
 * (a key set for `none`/`issue` would silently do nothing). A supplied key is
 * validated through the age library at parse time, so a malformed recipient
 * fails the run before any API work rather than at upload. Returns the trimmed
 * key (empty for the non-artifact channels) or a loud error.
 */
function resolveReportPublicKey(channel: PrivateReportChannel): string | { error: string } {
  const key = input("report-public-key");
  if (channel !== "artifact") {
    if (key) {
      return {
        error: `the "report-public-key" input only applies to private-report: artifact, but the channel is "${channel}", so the key would never be used. Remove report-public-key, or set private-report: artifact`,
      };
    }
    return "";
  }
  if (!key) {
    return {
      error:
        'private-report: artifact needs a "report-public-key" input: the age recipient every report is encrypted to. Generate a keypair with "age-keygen -o key.txt", keep key.txt secret, and set report-public-key to the printed "age1..." recipient (safe to commit)',
    };
  }
  const parsed = parseRecipient(key);
  if (!parsed.ok) {
    return {
      error: `the "report-public-key" input is not a valid age recipient: ${parsed.error}. It must be an "age1..." public key from "age-keygen" (the recipient line, not the AGE-SECRET-KEY identity)`,
    };
  }
  return key;
}

/** The inputs shared by both modes. */
export interface CommonConfig {
  token: string;
  mode: "apply" | "check";
  onMissingPermission: "fail" | "warn";
  requiredSections: Set<string>;
  onlySections: Set<string>;
  apiVersion: string;
  /** Whether to hide private/internal targets from the public view. */
  privateRepos: PrivateReposPolicy;
  /** Where the full unredacted report for a redacted target is delivered. */
  privateReport: PrivateReportChannel;
  /**
   * The age recipient the `artifact` channel encrypts every report to. Empty
   * for the other channels (parse rejects a value supplied without the artifact
   * channel), a validated `age1...` recipient when the channel is `artifact`.
   */
  reportPublicKey: string;
  /**
   * The workflow's own repository (GITHUB_REPOSITORY), read once here so the
   * run flows stay env-free. A target equal to this slug is never redacted:
   * a repository operating on itself leaks nothing.
   */
  selfSlug: string;
  /**
   * Link to the workflow run, for the private report metadata. Built once here
   * from GITHUB_SERVER_URL/GITHUB_REPOSITORY/GITHUB_RUN_ID so the run flows stay
   * env-free; empty when those are unset (local runs), which the report tolerates.
   */
  runUrl: string;
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
  // The workflow's own repository, read once and reused for the self slug, the
  // run URL, the central-mode admin owner, and the single-repo fallback target.
  const githubRepository = process.env.GITHUB_REPOSITORY ?? "";
  const mode = input("mode") || DEFAULT_MODE;
  if (mode !== "apply" && mode !== "check") {
    return {
      error: `the "mode" input is "${mode}", which is not a supported mode. Set it to "apply" (mutate settings) or "check" (report drift only)`,
    };
  }
  const onMissingPermission = readEnum(
    "on-missing-permission",
    ["fail", "warn"] as const,
    DEFAULT_ON_MISSING_PERMISSION,
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
  const apiVersion = input("api-version") || DEFAULT_API_VERSION;
  const privateRepos = readEnum(
    "private-repos",
    PRIVATE_REPOS_POLICIES,
    DEFAULT_PRIVATE_REPOS,
    "private-repository policy",
  );
  if (typeof privateRepos !== "string") {
    return { error: privateRepos.error };
  }
  const privateReport = readEnum(
    "private-report",
    PRIVATE_REPORT_CHANNELS,
    DEFAULT_PRIVATE_REPORT,
    "private-report channel",
  );
  if (typeof privateReport !== "string") {
    return { error: privateReport.error };
  }
  // A report channel only ever runs for a REDACTED target, so combining it with
  // private-repos: show (which redacts nothing) would silently deliver no
  // report - a silent no-op violates the loud-failure promise, so reject it.
  if (privateReport !== "none" && privateRepos === "show") {
    return {
      error:
        'the "private-report" input delivers reports only for redacted targets, but "private-repos" is "show", so nothing is redacted and no report would ever be sent. Set private-repos: redact, or set private-report: none',
    };
  }
  const reportPublicKey = resolveReportPublicKey(privateReport);
  if (typeof reportPublicKey !== "string") {
    return { error: reportPublicKey.error };
  }
  const serverUrl = process.env.GITHUB_SERVER_URL ?? "";
  const runId = process.env.GITHUB_RUN_ID ?? "";
  const runUrl =
    serverUrl && githubRepository && runId
      ? `${serverUrl}/${githubRepository}/actions/runs/${runId}`
      : "";
  const common: CommonConfig = {
    token,
    mode,
    onMissingPermission,
    requiredSections,
    onlySections,
    apiVersion,
    privateRepos,
    privateReport,
    reportPublicKey,
    selfSlug: githubRepository,
    runUrl,
  };

  const discoveryFiltersSet = FILTER_INPUTS.filter((name) => input(name) !== "");
  const list = (name: FilterInput): string[] =>
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
  const settingsFile = input("settings-file") || DEFAULT_SETTINGS_FILE;

  if (reposInput || reposDir) {
    // Multi-repo mode: the single-repo inputs make no sense here.
    if (input("repository")) {
      return {
        error:
          'the "repository" input cannot be combined with "repos" or "repos-dir"; multi-repo targets come from those inputs. Remove "repository", or remove the multi-repo inputs to stay in single-repo mode',
      };
    }
    if (settingsFile !== DEFAULT_SETTINGS_FILE) {
      return {
        error:
          'the "settings-file" input cannot be combined with "repos" or "repos-dir": central targets are read from repos-dir files and remote targets from each repository\'s own .github/settings.yml. Remove the settings-file override',
      };
    }
    const adminOwner = githubRepository.split("/")[0] ?? "";
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
  const repo = input("repository") || githubRepository;
  if (!SLUG_RE.test(repo)) {
    return {
      error: `cannot target a repository: "${repo}" is not an owner/name slug. Set the "repository" input (or GITHUB_REPOSITORY) to a value like "octocat/hello-world"`,
    };
  }
  return { config: { ...common, kind: "single", repo, settingsFile } };
}
