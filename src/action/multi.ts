/**
 * Multi-repo orchestration: resolve targets (central files, explicit
 * repos, "*" discovery), read each target's settings, and run every
 * target independently through the engine.
 *
 * When `private-repos: redact` (the default), private and internal targets
 * are hidden from this run's public view: their slug is masked and replaced
 * with a "private repository #N" placeholder, and their engine output is
 * captured rather than emitted. The redaction plan is built - and every
 * masked slug registered with the runner and the trace hardening - BEFORE
 * any annotation, log line, or output is produced, so nothing leaks in the
 * window before masking takes effect. The full unredacted outcomes are kept
 * internally; the public rendering is derived from them by one pure function.
 */

import { readFileSync } from "node:fs";
import { resolveCentralTargets } from "../discovery/central.js";
import { type DiscoveryFilters, discoverRepos, formatSkipNotice } from "../discovery/discover.js";
import { parseReposInput } from "../discovery/repos-input.js";
import { dedupeTargets, type Target } from "../discovery/targets.js";
import { applyDefaults } from "../engine/merge.js";
import { type RepoRunResult, runForRepo, validateSettingsDoc } from "../engine/orchestrate.js";
import {
  type GithubClient,
  isPermissionError,
  RERUN_ADVICE,
  registerRedactedSlug,
} from "../github/api.js";
import { getRepoFile } from "../github/repo-file.js";
import { createVisibilityResolver, type RepoVisibility } from "../github/repo-visibility.js";
import type { Io } from "../io.js";
import { prefixedIo } from "../io.js";
import type { SettingsFile } from "../schema.js";
import { DEFAULT_SETTINGS_FILE, quoteList } from "./inputs.js";
import {
  capturingIo,
  type PrivateReposPolicy,
  planRedaction,
  REDACTED_DETAIL,
  REDACTED_NOTE,
  type RedactionPlan,
} from "./redact.js";
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
  /** Whether to hide private/internal targets from the public view. */
  privateRepos: PrivateReposPolicy;
  /** GITHUB_REPOSITORY: a target equal to it is never redacted (carve-out). */
  selfSlug: string;
}

/**
 * One multi-repo target's full internal end state. `outcomes`, `note`, and
 * `slug` hold the UNREDACTED detail; `display` and `redacted` drive the
 * public view derived by toPublicView(). The summary and outputs render from
 * that view, never from this record directly.
 */
export type TargetOutcome = Pick<Target, "slug" | "source" | "origin"> &
  Pick<RepoRunResult, "result" | "outcomes" | "skippedSections"> & {
    /** Human line for skips/failures that produced no section outcomes. */
    note?: string;
    /** The public label: the slug, or its "private repository #N" placeholder. */
    display: string;
    /** True when this target is hidden from the public view. */
    redacted: boolean;
  };

/** A leak-free section outcome: key and status survive, detail is hidden. */
export type RedactedOutcome = {
  key: string;
  status: RepoRunResult["outcomes"][number]["status"];
  detail: string[];
};

/**
 * Strip a redacted target's section outcomes to safe values: the key and
 * status (closed enums, provably leak-free) survive, and every detail value is
 * replaced with the placeholder - plus the HTTP code on failed/skipped
 * sections, the one piece of error context that is a safe closed value. Shared
 * by the multi-repo public view and the single-repo redacted summary so both
 * render private targets through ONE definition of "hidden".
 */
export function redactOutcomes(outcomes: RepoRunResult["outcomes"]): RedactedOutcome[] {
  return outcomes.map((o) => {
    // Only failed/skipped sections carry an actionable HTTP code; showing it on
    // applied/clean rows would be noise.
    const withCode =
      o.httpStatus !== undefined && (o.status === "failed" || o.status === "skipped")
        ? `${REDACTED_DETAIL}, HTTP ${o.httpStatus}`
        : REDACTED_DETAIL;
    return { key: o.key, status: o.status, detail: [withCode] };
  });
}

/**
 * The leak-free projection of a TargetOutcome for the public view (summary,
 * outputs, annotations). For a redacted target the slug becomes its
 * placeholder, every detail value is replaced with the safe placeholder (plus
 * the HTTP code when known), and the note becomes the generic redacted note;
 * for a plain target it is byte-identical to the internal record. Deriving
 * this with a pure function makes "no private data in the public view" a
 * property of one testable function.
 */
export interface PublicTargetView {
  display: string;
  source: Target["source"];
  result: RepoRunResult["result"];
  skippedSections: string[];
  outcomes: Array<{
    key: string;
    status: RepoRunResult["outcomes"][number]["status"];
    detail: string[];
  }>;
  note?: string;
}

/** Derive the public view of a target; redacted targets are stripped to safe statuses. */
export function toPublicView(target: TargetOutcome): PublicTargetView {
  if (!target.redacted) {
    return {
      display: target.slug,
      source: target.source,
      result: target.result,
      skippedSections: target.skippedSections,
      outcomes: target.outcomes.map((o) => ({ key: o.key, status: o.status, detail: o.detail })),
      note: target.note,
    };
  }
  return {
    display: target.display,
    source: target.source,
    result: target.result,
    skippedSections: target.skippedSections,
    outcomes: redactOutcomes(target.outcomes),
    note: REDACTED_NOTE,
  };
}

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

  // Central-resolution warnings are buffered so nothing emits before the
  // redaction mask is registered. Every exit path - fatal or not - flushes
  // them through this one helper, so a fatal config error later in setup can
  // never silently swallow a warning about a repos-dir file. Central warnings
  // name repos-dir paths and slugs, which are self-disclosed (checked into the
  // public admin repo), so flushing them before masking leaks nothing.
  const bufferedWarnings: string[] = [];
  let warningsFlushed = false;
  const flushWarnings = (): void => {
    if (warningsFlushed) {
      return;
    }
    warningsFlushed = true;
    for (const warning of bufferedWarnings) {
      io.annotate("warning", warning);
    }
  };
  const fail = (message: string): { fatal: string; targets: TargetOutcome[] } => {
    flushWarnings();
    return { fatal: message, targets: none };
  };

  let defaults: SettingsFile = {};
  if (cfg.defaultsFile) {
    const read = readSettingsFile(cfg.defaultsFile);
    if ("error" in read) {
      return fail(
        `cannot read the defaults file ${cfg.defaultsFile}: ${read.error}. Check the "defaults-file" path and that the file is valid YAML`,
      );
    }
    defaults = read.settings;
    const err = validateSettingsDoc(defaults, cfg.defaultsFile, cfg.onlySections, io);
    if (err) {
      return fail(err);
    }
  }

  let central: Target[] = [];
  if (cfg.reposDir) {
    const resolved = resolveCentralTargets(cfg.reposDir, cfg.adminOwner);
    if ("error" in resolved) {
      return fail(resolved.error);
    }
    bufferedWarnings.push(...resolved.warnings);
    central = resolved.targets;
  }

  let remote: Target[] = [];
  let filteredOutCount = 0;
  const skipGroups: Array<{
    reason: string;
    repos: Parameters<typeof formatSkipNotice>[0]["repos"];
  }> = [];
  // Visibility learned from discovery (authoritative for those repos), so the
  // per-target probe is skipped for them.
  const knownVisibility = new Map<string, RepoVisibility>();
  // Private slugs that discovery filtered out: masked, never placeholdered.
  const filteredPrivateSlugs: string[] = [];
  if (cfg.reposInput) {
    const parsed = parseReposInput(cfg.reposInput);
    if ("error" in parsed) {
      return fail(parsed.error);
    }
    let slugs = parsed.slugs;
    let origin = 'the "repos" input';
    if (parsed.discover) {
      const discovered = await discoverRepos(api, cfg.discoveryFilters);
      if ("error" in discovered) {
        return fail(discovered.error);
      }
      for (const group of discovered.filtered) {
        skipGroups.push(group);
        filteredOutCount += group.repos.length;
        for (const repo of group.repos) {
          if (repo.visibility !== "public") {
            filteredPrivateSlugs.push(repo.slug);
          }
        }
      }
      for (const repo of discovered.repos) {
        knownVisibility.set(repo.slug.toLowerCase(), repo.visibility);
      }
      slugs = discovered.repos.map((repo) => repo.slug);
      origin = 'repos: "*" discovery';
    } else if (cfg.discoveryFiltersSet.length > 0) {
      return fail(
        `the discovery filter input(s) ${quoteList(cfg.discoveryFiltersSet)} only apply when repos is "*", but the "repos" input lists explicit repositories. Set repos: "*", or remove the filter input(s)`,
      );
    }
    remote = slugs.map((slug) => ({ slug, source: "remote" as const, origin }));
  } else if (cfg.discoveryFiltersSet.length > 0) {
    return fail(
      `the discovery filter input(s) ${quoteList(cfg.discoveryFiltersSet)} only apply to repos: "*" discovery, but targets come only from repos-dir files. Set repos: "*", or remove the filter input(s)`,
    );
  }

  const redact = cfg.privateRepos === "redact";
  const self = cfg.selfSlug.toLowerCase();

  // Resolve visibility for every distinct target slug before the plan: use
  // the discovery-supplied value when present, else one probe. Skipped
  // entirely under `show` and for the self slug. Fail closed: only "public"
  // avoids redaction, so an unknown (probe failed/denied) target is hidden.
  const resolveVisibility = createVisibilityResolver(api);
  const orderedSlugs = [...central, ...remote].map((t) => t.slug);
  const isPrivate = new Map<string, boolean>();
  if (redact) {
    for (const slug of orderedSlugs) {
      const key = slug.toLowerCase();
      if (isPrivate.has(key)) {
        continue;
      }
      if (key === self) {
        isPrivate.set(key, false);
        continue;
      }
      const known = knownVisibility.get(key);
      const visibility = known ?? (await resolveVisibility(slug));
      isPrivate.set(key, visibility !== "public");
    }
  }

  const plan: RedactionPlan = redact
    ? planRedaction(
        orderedSlugs,
        filteredPrivateSlugs,
        (slug) => isPrivate.get(slug.toLowerCase()) ?? false,
        cfg.selfSlug,
      )
    : { isRedacted: () => false, display: (slug) => slug, maskedSlugs: [] };

  // Mask and register every hidden slug BEFORE the first annotate/log/output.
  for (const slug of plan.maskedSlugs) {
    io.mask(slug);
    registerRedactedSlug(slug);
  }

  // Now safe to emit: buffered central warnings (flushed exactly once here on
  // the happy path; the fail() helper flushes them on every fatal path), then
  // the (redacting) skip notices.
  flushWarnings();
  for (const group of skipGroups) {
    io.annotate("notice", formatSkipNotice(group, redact));
  }

  const targets = dedupeTargets(
    central,
    remote,
    (message) => io.annotate("notice", message),
    (slug) => plan.display(slug),
    (slug) => plan.isRedacted(slug),
  );
  if (targets.length === 0) {
    if (filteredOutCount > 0) {
      return fail(
        `multi-repo mode found no targets: repos: "*" discovery found ${filteredOutCount} ${filteredOutCount === 1 ? "repository" : "repositories"}, but the discovery filters removed all of them (see the notices above). Relax the filter inputs, or add per-repo files to the repos-dir`,
      );
    }
    return fail(
      `multi-repo mode found no targets: repos-dir yielded no settings files and the "repos" input resolved to no repositories. Add per-repo files to the repos-dir, or list repositories in the "repos" input`,
    );
  }

  const results: TargetOutcome[] = [];
  for (const target of targets) {
    const redacted = plan.isRedacted(target.slug);
    const display = plan.display(target.slug);

    /**
     * Emit a target failure. A plain target keeps today's rich message
     * byte-identically; a redacted target gets a generic line naming no
     * private detail. Both push the same failed TargetOutcome shell.
     */
    const failTarget = (richMessage: string, note?: string): void => {
      if (redacted) {
        io.annotate("error", `${display}: failed. ${REDACTED_NOTE}`);
      } else {
        io.annotate("error", `${target.slug}: ${richMessage}`);
      }
      results.push({
        slug: target.slug,
        source: target.source,
        origin: target.origin,
        result: "failed",
        outcomes: [],
        skippedSections: [],
        note: redacted ? REDACTED_NOTE : (note ?? richMessage),
        display,
        redacted,
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
          const richSkip = `skipped - the repository has no ${DEFAULT_SETTINGS_FILE} on its default branch. Add the file to manage it, or remove ${target.slug} from the "repos" input`;
          io.annotate(
            "notice",
            redacted ? `${display}: skipped. ${REDACTED_NOTE}` : `${target.slug}: ${richSkip}`,
          );
          results.push({
            slug: target.slug,
            source: target.source,
            origin: target.origin,
            result: "skipped",
            outcomes: [],
            skippedSections: [],
            note: redacted ? REDACTED_NOTE : `no ${DEFAULT_SETTINGS_FILE} on the default branch`,
            display,
            redacted,
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
      // Section-level notices carry no private live values (they name the
      // section key and the source file only), but a redacted target's source
      // label is its own slug, so route them through the capturing sink too.
      const targetIo = redacted
        ? capturingIo(prefixedIo(io, `${display}: `)).io
        : prefixedIo(io, `${target.slug}: `);
      for (const key of disabled) {
        targetIo.annotate(
          "notice",
          `section "${key}" is set to null in ${sourceLabel}, which opts this repository out of that defaults-file section`,
        );
      }
      // validateSettingsDoc emits through io directly and names sourceLabel
      // (the slug for remote targets), so give it the capturing sink for a
      // redacted target and translate its error to a generic failure line.
      const invalid = validateSettingsDoc(
        settings,
        sourceLabel,
        cfg.onlySections,
        redacted ? capturingIo(io).io : io,
      );
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
        },
        targetIo,
      );
      let note: string | undefined;
      if (run.preflightDenied.length > 0) {
        if (redacted) {
          note = REDACTED_NOTE;
          io.annotate("error", `${display}: preflight failed. ${REDACTED_NOTE}`);
        } else {
          note = `preflight denied ${run.preflightDenied.length} section(s); nothing was applied to this repository`;
          io.annotate(
            "error",
            `${target.slug}: preflight failed: the token cannot access ${run.preflightDenied.length} section(s), so nothing was applied to this repository. Grant the permissions named above, or set on-missing-permission: warn`,
          );
        }
      }
      results.push({
        slug: target.slug,
        source: target.source,
        origin: target.origin,
        result: run.result,
        outcomes: run.outcomes,
        skippedSections: run.skippedSections,
        note,
        display,
        redacted,
      });
      // For a redacted target, the engine's per-section lines were captured;
      // emit ONE generic annotation summarizing the result, safe codes only.
      if (redacted) {
        emitRedactedSummary(io, display, run);
      }
    } catch (error) {
      // One repo's unexpected crash never stops the rest of the fleet.
      const message = error instanceof Error ? error.message : String(error);
      failTarget(message);
    }
  }
  return { fatal: null, targets: results };
}

/**
 * The single generic annotation a redacted target gets after its run, its
 * level chosen by result: a failed run names the failed section keys and
 * their HTTP codes (safe closed values only); a check-mode drift warns; a
 * skipped run notices; a healthy run says nothing.
 */
function emitRedactedSummary(io: Io, display: string, run: RepoRunResult): void {
  if (run.result === "failed") {
    const failed = run.outcomes
      .filter((o) => o.status === "failed")
      .map((o) => (o.httpStatus !== undefined ? `${o.key} (${o.httpStatus})` : o.key));
    const sections = failed.length > 0 ? ` - ${failed.join(", ")}` : "";
    io.annotate("error", `${display}: failed${sections}. ${REDACTED_NOTE}`);
    return;
  }
  if (run.result === "drift") {
    const drifted = run.outcomes.filter((o) => o.status === "drift").map((o) => o.key);
    const sections = drifted.length > 0 ? ` - ${drifted.join(", ")}` : "";
    io.annotate("warning", `${display}: drift${sections}. ${REDACTED_NOTE}`);
    return;
  }
  if (run.result === "skipped") {
    io.annotate("notice", `${display}: skipped. ${REDACTED_NOTE}`);
  }
}
