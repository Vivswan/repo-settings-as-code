/**
 * Multi-repo orchestration: resolve targets (central files, explicit
 * repos, "*" discovery), read each target's settings, and run every
 * target independently through the engine.
 */

import { readFileSync } from "node:fs";
import { resolveCentralTargets } from "../discovery/central.js";
import { type DiscoveryFilters, discoverRepos, formatSkipNotice } from "../discovery/discover.js";
import { parseReposInput } from "../discovery/repos-input.js";
import { dedupeTargets, type Target } from "../discovery/targets.js";
import { applyDefaults } from "../engine/merge.js";
import { type RepoRunResult, runForRepo, validateSettingsDoc } from "../engine/orchestrate.js";
import { type GithubClient, isPermissionError, RERUN_ADVICE } from "../github/api.js";
import { getRepoFile } from "../github/repo-file.js";
import type { Io } from "../io.js";
import type { SettingsFile } from "../schema.js";
import { DEFAULT_SETTINGS_FILE, quoteList } from "./inputs.js";
import { parseSettingsDoc, readSettingsFile } from "./settings-read.js";

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

/** One multi-repo target's end state, for the summary and outputs. */
export type TargetOutcome = Pick<Target, "slug" | "source" | "origin"> &
  Pick<RepoRunResult, "result" | "outcomes" | "skippedSections"> & {
    /** Human line for skips/failures that produced no section outcomes. */
    note?: string;
  };

/**
 * Multi-repo orchestration. Config-level problems (bad defaults file, no
 * targets, duplicate definitions, discovery failure) return `fatal` before
 * any target executes; per-target problems mark that target failed or
 * skipped and never stop the others.
 */
export async function runMulti(
  api: GithubClient,
  cfg: MultiConfig,
  io: Io,
): Promise<{ fatal: string | null; targets: TargetOutcome[] }> {
  const none: TargetOutcome[] = [];

  let defaults: SettingsFile = {};
  if (cfg.defaultsFile) {
    const read = readSettingsFile(cfg.defaultsFile);
    if ("error" in read) {
      return {
        fatal: `cannot read the defaults file ${cfg.defaultsFile}: ${read.error}. Check the "defaults-file" path and that the file is valid YAML`,
        targets: none,
      };
    }
    defaults = read.settings;
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
        sourceLabel = `${target.slug}:${DEFAULT_SETTINGS_FILE}`;
        const file = await getRepoFile(api, target.slug, DEFAULT_SETTINGS_FILE);
        if ("missing" in file) {
          io.annotate(
            "notice",
            `${target.slug}: skipped - the repository has no ${DEFAULT_SETTINGS_FILE} on its default branch. Add the file to manage it, or remove ${target.slug} from the "repos" input`,
          );
          results.push({
            slug: target.slug,
            source: target.source,
            origin: target.origin,
            result: "skipped",
            outcomes: [],
            skippedSections: [],
            note: `no ${DEFAULT_SETTINGS_FILE} on the default branch`,
          });
          continue;
        }
        if ("error" in file) {
          failTarget(
            isPermissionError(file.error)
              ? `the token was denied reading ${sourceLabel}: ${file.error.status} ${file.error.message}. Grant the PAT access to this repository (Contents: read), or remove it from the "repos" input`
              : `reading ${sourceLabel} failed: ${file.error.status} ${file.error.message}. ${RERUN_ADVICE}`,
          );
          continue;
        }
        raw = file.content;
      }

      const parsed = parseSettingsDoc(raw);
      if ("error" in parsed) {
        failTarget(`cannot parse ${sourceLabel}: ${parsed.error}. Fix the YAML in that file`);
        continue;
      }

      const { settings, disabled } = applyDefaults(defaults, parsed.settings);
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
