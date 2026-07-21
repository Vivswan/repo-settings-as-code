/**
 * repo-settings-as-code: apply a declarative .github/settings.yml to the repo.
 *
 * Policy model:
 * - mode: apply (default) mutates; check reports drift and exits 1 on any.
 * - on-missing-permission: fail (default) | warn. Under warn, a section the
 *   token cannot touch is skipped with a warning and the run stays green
 *   (partial success) - unless the section is listed in required-sections.
 * - Non-permission errors always fail, loudly, with the API message.
 *
 * Multi-repo mode (repos / repos-dir / defaults-file inputs): one run in an
 * admin repo applies settings to many repositories - from per-repo files
 * checked into the admin repo (central), or from each target's own
 * .github/settings.yml (remote), with an optional defaults layer merged
 * under every target. Targets run independently; the run fails at the end
 * if any target failed.
 */

import { appendFileSync, readFileSync } from "node:fs";
import * as core from "@actions/core";
import { parse as parseYaml } from "yaml";
import { GithubApi, isPermissionError } from "./api.js";
import { applyDefaults } from "./merge.js";
import {
  type Io,
  type RepoResult,
  runForRepo,
  type SectionOutcome,
  validateSettingsDoc,
  worstOf,
} from "./orchestrate.js";
import type { SettingsFile } from "./schema.js";
import { SECTION_KEYS } from "./schema.js";
import {
  AFFILIATIONS,
  ARCHIVED_FILTERS,
  type DiscoveryFilters,
  dedupeTargets,
  discoverRepos,
  FORKS_FILTERS,
  parseReposInput,
  resolveCentralTargets,
  SLUG_RE,
  type Target,
  VISIBILITY_FILTERS,
} from "./targets.js";

function input(name: string): string {
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

function annotate(level: "notice" | "warning" | "error", message: string): void {
  // @actions/core owns workflow-command escaping (%, CR, LF).
  core[level](message);
}

function setOutput(name: string, value: string): void {
  // Guarded: the runner always sets GITHUB_OUTPUT; local/test runs may not.
  if (process.env.GITHUB_OUTPUT) {
    core.setOutput(name, value);
  }
}

// Typed over every status both summary writers can meet, so a new status
// value fails compilation here instead of rendering ":undefined:".
const STATUS_ICON: Record<SectionOutcome["status"] | RepoResult, string> = {
  applied: "white_check_mark",
  clean: "white_check_mark",
  drift: "warning",
  partial: "warning",
  skipped: "fast_forward",
  excluded: "fast_forward",
  failed: "x",
};

function summaryCell(text: string): string {
  // Escape the escape character first, then the table delimiter.
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function outcomeRows(outcomes: SectionOutcome[]): string[] {
  const rows = ["| Section | Status | Detail |", "|---|---|---|"];
  for (const outcome of outcomes) {
    const detail = outcome.detail.map(summaryCell).join("<br>") || "-";
    rows.push(
      `| ${outcome.key} | :${STATUS_ICON[outcome.status]}: ${outcome.status} | ${detail} |`,
    );
  }
  return rows;
}

function writeSummary(outcomes: SectionOutcome[], mode: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) {
    return;
  }
  const lines = [`## repo-settings-as-code (${mode})`, "", ...outcomeRows(outcomes)];
  appendFileSync(file, `${lines.join("\n")}\n`);
}

/** One multi-repo target's end state, for the summary and outputs. */
interface TargetOutcome {
  slug: string;
  source: "central" | "remote";
  origin: string;
  result: RepoResult;
  outcomes: SectionOutcome[];
  skippedSections: string[];
  /** Human line for skips/failures that produced no section outcomes. */
  note?: string;
}

function writeMultiSummary(targets: TargetOutcome[], mode: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) {
    return;
  }
  const lines = [
    `## repo-settings-as-code (${mode}, ${targets.length} repositories)`,
    "",
    "| Repository | Source | Result |",
    "|---|---|---|",
  ];
  for (const target of targets) {
    lines.push(
      `| ${target.slug} | ${target.source} | :${STATUS_ICON[target.result]}: ${target.result} |`,
    );
  }
  for (const target of targets) {
    lines.push("", `### ${target.slug} (${target.result})`, "");
    if (target.note) {
      lines.push(summaryCell(target.note), "");
    }
    if (target.outcomes.length > 0) {
      lines.push(...outcomeRows(target.outcomes));
    }
  }
  appendFileSync(file, `${lines.join("\n")}\n`);
}

function quoteList(names: string[]): string {
  return names.map((name) => `"${name}"`).join(", ");
}

/**
 * One aggregate notice per filter reason: with "*" fleets, per-repo notices
 * would flood the annotations UI (GitHub caps annotations per step).
 */
function formatSkipNotice(group: { reason: string; slugs: string[] }): string {
  const shown = group.slugs.slice(0, 20).join(", ");
  const more = group.slugs.length > 20 ? `, and ${group.slugs.length - 20} more` : "";
  const count = `${group.slugs.length} ${group.slugs.length === 1 ? "repository" : "repositories"}`;
  if (group.reason === "archived") {
    return `repos: "*" discovery skipped ${count} because settings writes fail on archived repositories; unarchive them to manage them: ${shown}${more}`;
  }
  return `repos: "*" discovery skipped ${count} by ${group.reason}: ${shown}${more}`;
}

export interface MultiConfig {
  reposDir: string;
  reposInput: string;
  defaultsFile: string;
  adminOwner: string;
  mode: "apply" | "check";
  onMissingPermission: "fail" | "warn";
  requiredSections: Set<string>;
  onlySections: Set<string>;
  discoveryFilters: DiscoveryFilters;
  /** Filter inputs the user explicitly set, for the misuse rejections. */
  discoveryFiltersSet: string[];
}

/**
 * Multi-repo orchestration. Config-level problems (bad defaults file, no
 * targets, duplicate definitions, discovery failure) return `fatal` before
 * any target executes; per-target problems mark that target failed or
 * skipped and never stop the others.
 */
export async function runMulti(
  api: GithubApi,
  cfg: MultiConfig,
  io: Io,
): Promise<{ fatal: string | null; targets: TargetOutcome[] }> {
  const none: TargetOutcome[] = [];

  let defaults: SettingsFile = {};
  if (cfg.defaultsFile) {
    try {
      defaults = (parseYaml(readFileSync(cfg.defaultsFile, "utf8")) ?? {}) as SettingsFile;
    } catch (error) {
      return {
        fatal: `cannot read the defaults file ${cfg.defaultsFile}: ${String(error)}. Check the "defaults-file" path and that the file is valid YAML`,
        targets: none,
      };
    }
    const err = validateSettingsDoc(defaults, cfg.defaultsFile, cfg.onlySections, io);
    if (err) {
      return { fatal: err, targets: none };
    }
  }

  let central: Target[] = [];
  if (cfg.reposDir) {
    const resolved = resolveCentralTargets(cfg.reposDir, cfg.adminOwner);
    if ("error" in resolved) {
      return { fatal: resolved.error, targets: none };
    }
    for (const warning of resolved.warnings) {
      io.annotate("warning", warning);
    }
    central = resolved.targets;
  }

  let remote: Target[] = [];
  let filteredOutCount = 0;
  if (cfg.reposInput) {
    const parsed = parseReposInput(cfg.reposInput);
    if ("error" in parsed) {
      return { fatal: parsed.error, targets: none };
    }
    let slugs = parsed.slugs;
    let origin = 'the "repos" input';
    if (parsed.discover) {
      const discovered = await discoverRepos(api, cfg.discoveryFilters);
      if ("error" in discovered) {
        return { fatal: discovered.error, targets: none };
      }
      for (const group of discovered.filtered) {
        io.annotate("notice", formatSkipNotice(group));
        filteredOutCount += group.slugs.length;
      }
      slugs = discovered.slugs;
      origin = 'repos: "*" discovery';
    } else if (cfg.discoveryFiltersSet.length > 0) {
      return {
        fatal: `the discovery filter input(s) ${quoteList(cfg.discoveryFiltersSet)} only apply when repos is "*", but the "repos" input lists explicit repositories. Set repos: "*", or remove the filter input(s)`,
        targets: none,
      };
    }
    remote = slugs.map((slug) => ({ slug, source: "remote" as const, origin }));
  } else if (cfg.discoveryFiltersSet.length > 0) {
    return {
      fatal: `the discovery filter input(s) ${quoteList(cfg.discoveryFiltersSet)} only apply to repos: "*" discovery, but targets come only from repos-dir files. Set repos: "*", or remove the filter input(s)`,
      targets: none,
    };
  }

  const targets = dedupeTargets(central, remote, (message) => io.annotate("notice", message));
  if (targets.length === 0) {
    if (filteredOutCount > 0) {
      return {
        fatal: `multi-repo mode found no targets: repos: "*" discovery found ${filteredOutCount} ${filteredOutCount === 1 ? "repository" : "repositories"}, but the discovery filters removed all of them (see the notices above). Relax the filter inputs, or add per-repo files to the repos-dir`,
        targets: none,
      };
    }
    return {
      fatal: `multi-repo mode found no targets: repos-dir yielded no settings files and the "repos" input resolved to no repositories. Add per-repo files to the repos-dir, or list repositories in the "repos" input`,
      targets: none,
    };
  }

  const results: TargetOutcome[] = [];
  for (const target of targets) {
    const failTarget = (message: string, note?: string): void => {
      io.annotate("error", `${target.slug}: ${message}`);
      results.push({
        slug: target.slug,
        source: target.source,
        origin: target.origin,
        result: "failed",
        outcomes: [],
        skippedSections: [],
        note: note ?? message,
      });
    };
    try {
      let raw: string;
      let sourceLabel: string;
      if (target.source === "central") {
        sourceLabel = target.filePath ?? target.origin;
        try {
          raw = readFileSync(target.filePath ?? "", "utf8");
        } catch (error) {
          failTarget(
            `cannot read settings from ${sourceLabel}: ${String(error)}. Fix the file, or delete it to stop managing this repository`,
          );
          continue;
        }
      } else {
        sourceLabel = `${target.slug}:.github/settings.yml`;
        const file = await api.getRepoFile(target.slug, ".github/settings.yml");
        if ("missing" in file) {
          io.annotate(
            "notice",
            `${target.slug}: skipped - the repository has no .github/settings.yml on its default branch. Add the file to manage it, or remove ${target.slug} from the "repos" input`,
          );
          results.push({
            slug: target.slug,
            source: target.source,
            origin: target.origin,
            result: "skipped",
            outcomes: [],
            skippedSections: [],
            note: "no .github/settings.yml on the default branch",
          });
          continue;
        }
        if ("error" in file) {
          failTarget(
            isPermissionError(file.error)
              ? `the token was denied reading ${sourceLabel}: ${file.error.status} ${file.error.message}. Grant the PAT access to this repository (Contents: read), or remove it from the "repos" input`
              : `reading ${sourceLabel} failed: ${file.error.status} ${file.error.message}. This is not a permission problem; re-run the workflow, and retry later if it persists`,
          );
          continue;
        }
        raw = file.content;
      }

      let parsed: SettingsFile;
      try {
        parsed = (parseYaml(raw) ?? {}) as SettingsFile;
      } catch (error) {
        failTarget(`cannot parse ${sourceLabel}: ${String(error)}. Fix the YAML in that file`);
        continue;
      }

      const { settings, disabled } = applyDefaults(defaults, parsed);
      for (const key of disabled) {
        io.annotate(
          "notice",
          `${target.slug}: section "${key}" is set to null in ${sourceLabel}, which opts this repository out of that defaults-file section`,
        );
      }
      const invalid = validateSettingsDoc(settings, sourceLabel, cfg.onlySections, io);
      if (invalid) {
        failTarget(invalid);
        continue;
      }

      const run = await runForRepo(
        api,
        {
          repo: target.slug,
          settings,
          mode: cfg.mode,
          onMissingPermission: cfg.onMissingPermission,
          requiredSections: cfg.requiredSections,
          onlySections: cfg.onlySections,
          label: `${target.slug}: `,
        },
        io,
      );
      let note: string | undefined;
      if (run.preflightDenied.length > 0) {
        note = `preflight denied ${run.preflightDenied.length} section(s); nothing was applied to this repository`;
        io.annotate(
          "error",
          `${target.slug}: preflight failed: the token cannot access ${run.preflightDenied.length} section(s), so nothing was applied to this repository. Grant the permissions named above, or set on-missing-permission: warn`,
        );
      }
      results.push({
        slug: target.slug,
        source: target.source,
        origin: target.origin,
        result: run.result,
        outcomes: run.outcomes,
        skippedSections: run.skippedSections,
        note,
      });
    } catch (error) {
      // One repo's unexpected crash never stops the rest of the fleet.
      const message = error instanceof Error ? error.message : String(error);
      failTarget(message);
    }
  }
  return { fatal: null, targets: results };
}

export async function run(overrides?: { api?: GithubApi }): Promise<number> {
  const fail = (message: string): number => {
    annotate("error", message);
    setOutput("result", "failed");
    return 1;
  };
  const io: Io = { annotate, log: (line) => console.log(line) };

  const token = input("token") || process.env.GITHUB_TOKEN || "";
  if (!token) {
    return fail(
      'cannot call the GitHub API: no token was provided. Set the "token" input on the action step (or export GITHUB_TOKEN)',
    );
  }
  const mode = input("mode") || "apply";
  if (mode !== "apply" && mode !== "check") {
    return fail(
      `the "mode" input is "${mode}", which is not a supported mode. Set it to "apply" (mutate settings) or "check" (report drift only)`,
    );
  }
  const onMissingPermission = readEnum(
    "on-missing-permission",
    ["fail", "warn"] as const,
    "fail",
    "policy",
  );
  if (typeof onMissingPermission !== "string") {
    return fail(onMissingPermission.error);
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
      return fail(
        `unknown section "${name}" in the "sections" or "required-sections" input; it matches none of: ${SECTION_KEYS.join(", ")}. Fix the name in the workflow's input list`,
      );
    }
  }
  const apiVersion = input("api-version") || "2022-11-28";
  const api = overrides?.api ?? new GithubApi(token, undefined, apiVersion);

  const FILTER_INPUTS = ["visibility", "archived", "forks", "exclude", "topics", "affiliation"];
  const discoveryFiltersSet = FILTER_INPUTS.filter((name) => input(name) !== "");
  const list = (name: string): string[] =>
    input(name)
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
  const visibility = readEnum("visibility", VISIBILITY_FILTERS, "all", "discovery filter");
  if (typeof visibility !== "string") {
    return fail(visibility.error);
  }
  const archived = readEnum("archived", ARCHIVED_FILTERS, "skip", "archived-repository policy");
  if (typeof archived !== "string") {
    return fail(archived.error);
  }
  const forks = readEnum("forks", FORKS_FILTERS, "include", "fork policy");
  if (typeof forks !== "string") {
    return fail(forks.error);
  }
  const affiliation = [...new Set(list("affiliation"))];
  for (const entry of affiliation) {
    if (!(AFFILIATIONS as readonly string[]).includes(entry)) {
      return fail(
        `the "affiliation" input entry "${entry}" is not a supported affiliation, so discovery cannot build the /user/repos query. Use a comma-separated list of ${AFFILIATIONS.map((a) => `"${a}"`).join(", ")}`,
      );
    }
  }
  const exclude = list("exclude");
  for (const pattern of exclude) {
    const parts = pattern.split("/");
    if (parts.length > 2 || (parts.length === 2 && (!parts[0] || !parts[1]))) {
      return fail(
        `the "exclude" input pattern "${pattern}" can never match an owner/name repository: a pattern takes at most one "/", with a non-empty glob on each side of it. Use "<name-glob>" or "<owner-glob>/<name-glob>", where "*" matches any characters`,
      );
    }
  }
  const discoveryFilters: DiscoveryFilters = {
    visibility,
    archived,
    forks,
    affiliation: affiliation.length > 0 ? affiliation : ["owner"],
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
      return fail(
        'the "repository" input cannot be combined with "repos" or "repos-dir"; multi-repo targets come from those inputs. Remove "repository", or remove the multi-repo inputs to stay in single-repo mode',
      );
    }
    if (settingsFile !== ".github/settings.yml") {
      return fail(
        'the "settings-file" input cannot be combined with "repos" or "repos-dir": central targets are read from repos-dir files and remote targets from each repository\'s own .github/settings.yml. Remove the settings-file override',
      );
    }
    const adminOwner = (process.env.GITHUB_REPOSITORY ?? "").split("/")[0] ?? "";
    const { fatal, targets } = await runMulti(
      api,
      {
        reposDir,
        reposInput,
        defaultsFile,
        adminOwner,
        mode,
        onMissingPermission,
        requiredSections,
        onlySections,
        discoveryFilters,
        discoveryFiltersSet,
      },
      io,
    );
    if (fatal) {
      return fail(fatal);
    }
    writeMultiSummary(targets, mode);
    setOutput(
      "repos-result",
      JSON.stringify(
        Object.fromEntries(
          targets.map((t) => [
            t.slug,
            { result: t.result, source: t.source, skippedSections: t.skippedSections },
          ]),
        ),
      ),
    );
    setOutput(
      "skipped-sections",
      [...new Set(targets.flatMap((t) => t.skippedSections))].join(","),
    );
    const overall = worstOf(targets, mode === "check");
    setOutput("result", overall);
    console.log(`result: ${overall}`);
    // The exit code follows the same worst-of ranking the output reports.
    return overall === "failed" || (mode === "check" && overall === "drift") ? 1 : 0;
  }

  // Single-repo mode (unchanged legacy behavior).
  if (discoveryFiltersSet.length > 0) {
    return fail(
      `the discovery filter input(s) ${quoteList(discoveryFiltersSet)} only apply to repos: "*" discovery, but this run is in single-repo mode. Set repos: "*" to discover repositories, or remove the filter input(s)`,
    );
  }
  if (defaultsFile) {
    return fail(
      'the "defaults-file" input only applies to multi-repo mode, but this run is in single-repo mode, so the defaults would never be merged. Remove the input, or add "repos" or "repos-dir" to switch to multi-repo mode',
    );
  }
  const repo = input("repository") || process.env.GITHUB_REPOSITORY || "";
  if (!SLUG_RE.test(repo)) {
    return fail(
      `cannot target a repository: "${repo}" is not an owner/name slug. Set the "repository" input (or GITHUB_REPOSITORY) to a value like "octocat/hello-world"`,
    );
  }
  let settings: SettingsFile;
  try {
    settings = (parseYaml(readFileSync(settingsFile, "utf8")) ?? {}) as SettingsFile;
  } catch (error) {
    return fail(
      `cannot read settings from ${settingsFile}: ${String(error)}. Check that the file exists at that path (set the "settings-file" input if it lives elsewhere) and is valid YAML`,
    );
  }
  const invalid = validateSettingsDoc(settings, settingsFile, onlySections, io);
  if (invalid) {
    return fail(invalid);
  }

  const result = await runForRepo(
    api,
    { repo, settings, mode, onMissingPermission, requiredSections, onlySections, label: "" },
    io,
  );
  if (result.preflightDenied.length > 0) {
    return fail(
      `preflight failed: the token cannot access ${result.preflightDenied.length} section(s), so nothing was applied. Grant the permissions named above, or set on-missing-permission: warn to skip those sections`,
    );
  }

  writeSummary(result.outcomes, mode);
  setOutput("skipped-sections", result.skippedSections.join(","));

  if (result.result === "failed") {
    setOutput("result", "failed");
    return 1;
  }
  setOutput("result", result.result);
  console.log(`result: ${result.result}`);
  return result.result === "drift" ? 1 : 0;
}

const invokedDirectly =
  process.argv[1]?.endsWith("main.ts") || process.argv[1]?.endsWith("index.js");
if (invokedDirectly) {
  run().then(
    (code) => process.exit(code),
    (error) => {
      annotate(
        "error",
        `repo-settings-as-code stopped unexpectedly: ${String(error)}. Re-run the workflow; if it recurs, report a bug with this log attached`,
      );
      process.exit(1);
    },
  );
}
