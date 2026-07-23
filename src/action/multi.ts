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
import { type ArtifactUploader, deliverArtifactReport } from "../report/artifact-report.js";
import { composeReport, type TranscriptLine } from "../report/composer.js";
import { deliverIssueReport, injectMarkerLabel, MARKER_LABEL } from "../report/issue-report.js";
import type { SettingsFile } from "../schema.js";
import { DEFAULT_SETTINGS_FILE, quoteList } from "./inputs.js";
import {
  capturingIo,
  type PrivateReportChannel,
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
  /** Where the full unredacted report for a redacted target is delivered. */
  privateReport: PrivateReportChannel;
  /** The age recipient the artifact channel encrypts to (empty otherwise). */
  reportPublicKey: string;
  /** GITHUB_REPOSITORY: a target equal to it is never redacted (carve-out). */
  selfSlug: string;
  /** Link to the workflow run, for the private report metadata (may be empty). */
  runUrl: string;
  /**
   * The artifact upload port, injected only by tests; production leaves it
   * undefined so the artifact channel uses the real @actions/artifact uploader.
   */
  uploader?: ArtifactUploader;
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

/** True when a resolved visibility PROVES the repo private or internal. */
export function isPrivateVisibility(visibility: RepoVisibility): boolean {
  return visibility === "private" || visibility === "internal";
}

/**
 * One target's normalized end state: the engine result plus the section keys a
 * redacted target's public annotation names (failed sections with codes, drift
 * sections). `note` carries a per-target message for skips/failures.
 */
interface TargetResult {
  result: RepoRunResult["result"];
  outcomes: RepoRunResult["outcomes"];
  skippedSections: string[];
  note?: string;
  /** Failed section keys with their HTTP codes, for the safe public annotation. */
  failedSections: string[];
  /** Drifted section keys, for the safe public annotation. */
  driftSections: string[];
}

/**
 * Record a processing failure that happened before the engine ran. The rich
 * message is captured for the private report (via `targetIo`, the capturing
 * sink for a redacted target - the report is safe). A PLAIN target also gets
 * the rich public annotation here; a REDACTED target's single public
 * annotation is emitted once by emitRedactedResult in the finalizer, so this
 * stays silent publicly for it.
 */
function targetFailure(
  io: Io,
  targetIo: Io,
  redacted: boolean,
  richMessage: string,
  plainLabel: string,
): TargetResult {
  if (redacted) {
    targetIo.log(`failed: ${richMessage}`);
  } else {
    io.annotate("error", `${plainLabel}${richMessage}`);
  }
  return {
    result: "failed",
    outcomes: [],
    skippedSections: [],
    note: redacted ? REDACTED_NOTE : richMessage,
    failedSections: [],
    driftSections: [],
  };
}

/**
 * Process one target end to end and return its normalized outcome. Guard-clause
 * style: each failure (read, missing file, parse, validation, preflight, crash)
 * returns early. ALL output goes through `targetIo` (the capturing sink for a
 * redacted target), so a failure's text lands in the private report too.
 */
async function processTarget(ctx: {
  api: GithubClient;
  target: Target;
  defaults: SettingsFile;
  cfg: MultiConfig;
  redacted: boolean;
  injectMarker: boolean;
  io: Io;
  targetIo: Io;
}): Promise<TargetResult> {
  const { api, target, defaults, cfg, redacted, injectMarker, targetIo } = ctx;
  // Failures render generically for a redacted target (no private detail) and
  // richly otherwise; the rich text is captured for the private report.
  const fail = (richMessage: string): TargetResult =>
    targetFailure(ctx.io, targetIo, redacted, richMessage, `${target.slug}: `);

  const read = await readTargetSettings(api, target);
  if ("error" in read) {
    return fail(read.error);
  }
  if ("missing" in read) {
    const richSkip = `skipped - the repository has no ${DEFAULT_SETTINGS_FILE} on its default branch. Add the file to manage it, or remove ${target.slug} from the "repos" input`;
    if (redacted) {
      // The generic public "skipped" line is emitted once by the finalizer;
      // capture the reason for the report.
      targetIo.log(richSkip);
    } else {
      ctx.io.annotate("notice", `${target.slug}: ${richSkip}`);
    }
    return {
      result: "skipped",
      outcomes: [],
      skippedSections: [],
      note: redacted ? REDACTED_NOTE : `no ${DEFAULT_SETTINGS_FILE} on the default branch`,
      failedSections: [],
      driftSections: [],
    };
  }

  const parsed = parseSettingsDoc(read.raw);
  if ("error" in parsed) {
    return fail(`cannot parse ${read.sourceLabel}: ${parsed.error}. Fix the YAML in that file`);
  }

  const { settings: merged, disabled } = applyDefaults(defaults, parsed.settings);
  const injected = applyMarkerInjection(merged, injectMarker);
  const settings = injected.settings;
  if (injected.notice) {
    targetIo.annotate("notice", injected.notice);
  }
  for (const key of disabled) {
    targetIo.annotate(
      "notice",
      `section "${key}" is set to null in ${read.sourceLabel}, which opts this repository out of that defaults-file section`,
    );
  }

  // validateSettingsDoc emits through its sink and names sourceLabel (the slug
  // for remote targets). A redacted target routes it through the capturing sink
  // so its warnings land in the report, not the public log; a plain target uses
  // the raw io, keeping validation warnings unprefixed as before.
  const invalid = validateSettingsDoc(
    settings,
    read.sourceLabel,
    cfg.onlySections,
    redacted ? targetIo : ctx.io,
  );
  if (invalid) {
    return fail(invalid);
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
      // The engine's preflight lines were captured; the single public
      // annotation is the finalizer's generic "failed" line.
      note = REDACTED_NOTE;
    } else {
      note = `preflight denied ${run.preflightDenied.length} section(s); nothing was applied to this repository`;
      ctx.io.annotate(
        "error",
        `${target.slug}: preflight failed: the token cannot access ${run.preflightDenied.length} section(s), so nothing was applied to this repository. Grant the permissions named above, or set on-missing-permission: warn`,
      );
    }
  }
  return {
    result: run.result,
    outcomes: run.outcomes,
    skippedSections: run.skippedSections,
    note,
    failedSections: run.outcomes
      .filter((o) => o.status === "failed")
      .map((o) => (o.httpStatus !== undefined ? `${o.key} (${o.httpStatus})` : o.key)),
    driftSections: run.outcomes.filter((o) => o.status === "drift").map((o) => o.key),
  };
}

/**
 * Read a target's raw settings: from the checked-in central file, or from the
 * target repo's own default-branch settings.yml. Returns `{raw, sourceLabel}`,
 * `{missing: true}` when a remote target has no file, or `{error}` on failure.
 */
async function readTargetSettings(
  api: GithubClient,
  target: Target,
): Promise<{ raw: string; sourceLabel: string } | { missing: true } | { error: string }> {
  if (target.source === "central") {
    const sourceLabel = target.filePath ?? target.origin;
    try {
      return { raw: readFileSync(target.filePath ?? "", "utf8"), sourceLabel };
    } catch (error) {
      return {
        error: `cannot read settings from ${sourceLabel}: ${String(error)}. Fix the file, or delete it to stop managing this repository`,
      };
    }
  }
  const sourceLabel = `${target.slug}:${DEFAULT_SETTINGS_FILE}`;
  const file = await getRepoFile(api, target.slug, DEFAULT_SETTINGS_FILE);
  if ("missing" in file) {
    return { missing: true };
  }
  if ("error" in file) {
    return {
      error: isPermissionError(file.error)
        ? `the token was denied reading ${sourceLabel}: ${file.error.status} ${file.error.message}. Grant the PAT access to this repository (Contents: read), or remove it from the "repos" input`
        : `reading ${sourceLabel} failed: ${file.error.status} ${file.error.message}. ${RERUN_ADVICE}`,
    };
  }
  return { raw: file.content, sourceLabel };
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
  // One timestamp for the whole run, so every target's report shares it and the
  // pure composer never reaches for Date.now itself.
  const timestamp = new Date().toISOString();

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
    return { fatal: message, targets: [] };
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
  // entirely under `show` and for the self slug. The resolved visibility (not
  // just a boolean) drives TWO decisions: redaction fails closed (redact unless
  // proven public), but report DELIVERY fails closed the other way (deliver only
  // when proven private or internal) - an unknown must never post a private
  // report to a repo that might be public.
  const resolveVisibility = createVisibilityResolver(api);
  const orderedSlugs = [...central, ...remote].map((t) => t.slug);
  const visibilityBySlug = new Map<string, RepoVisibility>();
  if (redact) {
    for (const slug of orderedSlugs) {
      const key = slug.toLowerCase();
      if (visibilityBySlug.has(key)) {
        continue;
      }
      if (key === self) {
        visibilityBySlug.set(key, "public");
        continue;
      }
      const known = knownVisibility.get(key);
      visibilityBySlug.set(key, known ?? (await resolveVisibility(slug)));
    }
  }
  const visibilityOf = (slug: string): RepoVisibility =>
    visibilityBySlug.get(slug.toLowerCase()) ?? "public";

  const plan: RedactionPlan = redact
    ? planRedaction(
        orderedSlugs,
        filteredPrivateSlugs,
        (slug) => visibilityOf(slug) !== "public",
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
  // The artifact channel accumulates every deliverable target's composed report
  // and encrypts/uploads them as ONE artifact after the loop; the issue channel
  // delivers per target inside the loop. `{ display }` travels alongside the
  // body only for the section heading in the concatenated document.
  const artifactReports: Array<{ display: string; body: string }> = [];
  const meta: ReportRunMeta = {
    adminRepo: cfg.selfSlug,
    runUrl: cfg.runUrl,
    mode: cfg.mode,
    timestamp,
  };
  for (const target of targets) {
    const redacted = plan.isRedacted(target.slug);
    const display = plan.display(target.slug);
    // Deliver a report ONLY when the target is PROVEN private or internal.
    // Redaction fails closed (redact on unknown), but delivery fails closed the
    // other way: posting or archiving the full private report for a repo that
    // might actually be public would leak it, so an unknown visibility redacts
    // publicly yet skips delivery. The gate is the same for both channels.
    const visibility = visibilityOf(target.slug);
    const reportOn = redacted && cfg.privateReport !== "none";
    const deliverable = reportOn && isPrivateVisibility(visibility);

    // One capture per redacted target, created BEFORE any processing so a
    // read/parse/validation failure is recorded in the report too. All target
    // output - notices, engine lines, failure text - flows through targetIo.
    const capture = redacted ? capturingIo(prefixedIo(io, `${display}: `)) : null;
    const targetIo = capture ? capture.io : prefixedIo(io, `${target.slug}: `);

    // A crash mid-processing (e.g. a network error that escaped tryRequest)
    // never stops the rest of the fleet; it becomes this target's failure and
    // still flows through the one finalizer below (so its report is delivered).
    let outcome: TargetResult;
    try {
      outcome = await processTarget({
        api,
        target,
        defaults,
        cfg,
        redacted,
        // The marker label is an issue-channel mechanism (its report reuses the
        // labelled issue); inject it only when the issue channel will deliver.
        injectMarker: deliverable && cfg.privateReport === "issue",
        io,
        targetIo,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome = targetFailure(io, targetIo, redacted, message, `${target.slug}: `);
    }

    // ONE finalization path for every target, however it exited: deliver or
    // accumulate the report (the private mirror of the whole run, failures
    // included), record the outcome, and emit the single public annotation for a
    // redacted target.
    let note = outcome.note;
    if (deliverable && capture) {
      const transcript = capture.drain();
      if (cfg.privateReport === "artifact") {
        // Accumulate now; the single encrypt+upload happens after the loop.
        const { body } = composeTargetReport(
          meta,
          target.slug,
          outcome.result,
          outcome.outcomes,
          transcript,
          cfg.mode === "check",
        );
        artifactReports.push({ display, body });
      } else {
        const reportNote = await deliverReport(
          api,
          meta,
          target.slug,
          display,
          outcome.result,
          outcome.outcomes,
          transcript,
          cfg.mode === "check",
          io,
        );
        if (reportNote) {
          note = note ? `${note}; ${reportNote}` : reportNote;
        }
      }
    } else if (reportOn && !deliverable) {
      // Redacted but not proven private: the report is withheld, said once,
      // safely (placeholder only).
      const withheld = "visibility could not be verified; the private report was not delivered";
      io.annotate("notice", `${display}: ${withheld}`);
      note = note ? `${note}; ${withheld}` : withheld;
    }

    results.push({
      slug: target.slug,
      source: target.source,
      origin: target.origin,
      result: outcome.result,
      outcomes: outcome.outcomes,
      skippedSections: outcome.skippedSections,
      note,
      display,
      redacted,
    });
    if (redacted) {
      emitRedactedResult(
        io,
        display,
        outcome.result,
        outcome.failedSections,
        outcome.driftSections,
      );
    }
  }

  // The artifact channel uploads every accumulated report as one encrypted
  // document after the loop. A failure is one safe warning (naming the artifact
  // service, never a slug) and never changes any target's result.
  await uploadArtifactReport(cfg, artifactReports, io);

  return { fatal: null, targets: results };
}

/**
 * Concatenate every accumulated per-target report into one document, encrypt it
 * to the operator's recipient, and upload it as the single workflow artifact.
 * A no-op when the channel is not `artifact` or no report was accumulated.
 * Delivery failure warns safely (the artifact service or missing runtime token,
 * never a slug or report content) and leaves the run result untouched.
 */
async function uploadArtifactReport(
  cfg: MultiConfig,
  reports: Array<{ display: string; body: string }>,
  io: Io,
): Promise<void> {
  if (cfg.privateReport !== "artifact" || reports.length === 0) {
    return;
  }
  const document = concatArtifactReports(reports);
  const delivery = await deliverArtifactReport(document, cfg.reportPublicKey, cfg.uploader);
  if ("warning" in delivery) {
    io.annotate("warning", delivery.warning);
  }
}

/**
 * Join accumulated per-target reports into one document, each under a heading
 * carrying its public placeholder (the document itself is private, but the
 * heading is the only added text and stays placeholder-keyed for consistency
 * with the public surfaces).
 */
export function concatArtifactReports(reports: Array<{ display: string; body: string }>): string {
  return reports.map((report) => `<!-- ${report.display} -->\n\n${report.body}`).join("\n\n");
}

/**
 * The single generic annotation a redacted target gets, its level chosen by
 * result: a failed run names the failed section keys and their HTTP codes (safe
 * closed values only); a check-mode drift warns; a skipped run notices; a
 * healthy run says nothing. The section lists are precomputed so no private
 * detail reaches this public surface.
 */
function emitRedactedResult(
  io: Io,
  display: string,
  result: RepoRunResult["result"],
  failedSections: string[],
  driftSections: string[],
): void {
  if (result === "failed") {
    const sections = failedSections.length > 0 ? ` - ${failedSections.join(", ")}` : "";
    io.annotate("error", `${display}: failed${sections}. ${REDACTED_NOTE}`);
    return;
  }
  if (result === "drift") {
    const sections = driftSections.length > 0 ? ` - ${driftSections.join(", ")}` : "";
    io.annotate("warning", `${display}: drift${sections}. ${REDACTED_NOTE}`);
    return;
  }
  if (result === "skipped") {
    io.annotate("notice", `${display}: skipped. ${REDACTED_NOTE}`);
  }
}

/** The run metadata a private report needs, minus the per-target fields. */
export interface ReportRunMeta {
  /** The admin repository the workflow ran in (GITHUB_REPOSITORY / selfSlug). */
  adminRepo: string;
  /** Link to the workflow run (may be empty on local runs). */
  runUrl: string;
  /** "apply" or "check". */
  mode: string;
  /** ISO timestamp captured once at the run's start, passed in (never Date.now here). */
  timestamp: string;
}

/**
 * Apply the marker-label injection for the issue report channel and describe
 * the change. When `on` is false (the channel is off, or the target is not
 * redacted) the settings pass through untouched with no notice. Otherwise
 * injectMarkerLabel appends the report's marker label if the settings declare a
 * labels section and it is absent (or refuses a rename that would move the
 * marker away). The notice is returned rather than emitted, so the caller can
 * route it through the target's capturing sink (the private report).
 */
export function applyMarkerInjection(
  settings: SettingsFile,
  on: boolean,
): { settings: SettingsFile; notice?: string } {
  if (!on) {
    return { settings };
  }
  const injection = injectMarkerLabel(settings);
  if (injection.renameRefused) {
    return {
      settings: injection.settings,
      notice: `refused to rename the "${MARKER_LABEL}" marker label: private reporting reuses its issue by that exact name, so the rename was dropped`,
    };
  }
  if (!injection.injected) {
    return { settings: injection.settings };
  }
  return {
    settings: injection.settings,
    notice: `added the "${MARKER_LABEL}" marker label to the managed labels so private reporting can reuse its issue; it is managed like any declared label`,
  };
}

/**
 * Compose the full unredacted report document for one target. Shared by both
 * delivery channels: the issue channel PATCHes it into the target's report
 * issue, the artifact channel accumulates it for the encrypted upload. The
 * `check` flag decides needsAttention alongside the result (a check-mode drift
 * needs attention; an apply-mode drift cannot occur).
 */
export function composeTargetReport(
  meta: ReportRunMeta,
  slug: string,
  result: RepoRunResult["result"],
  outcomes: RepoRunResult["outcomes"],
  transcript: TranscriptLine[],
  check: boolean,
): { body: string; needsAttention: boolean } {
  const body = composeReport({
    target: slug,
    adminRepo: meta.adminRepo,
    runUrl: meta.runUrl,
    mode: meta.mode,
    result,
    timestamp: meta.timestamp,
    outcomes: outcomes.map((o) => ({ key: o.key, status: o.status, detail: o.detail })),
    transcript,
  });
  const needsAttention = result === "failed" || (check && result === "drift");
  return { body, needsAttention };
}

/**
 * Compose the full unredacted report for a redacted target and deliver it to
 * the issue channel. Runs on EVERY result (the report is the private mirror of
 * the run log). Returns a safe summary-row note on delivery failure - and emits
 * one public-safe warning naming only the placeholder and the HTTP status - or
 * undefined on success; the target's result is never changed either way.
 */
export async function deliverReport(
  api: GithubClient,
  meta: ReportRunMeta,
  slug: string,
  display: string,
  result: RepoRunResult["result"],
  outcomes: RepoRunResult["outcomes"],
  transcript: TranscriptLine[],
  check: boolean,
  io: Io,
): Promise<string | undefined> {
  const { body, needsAttention } = composeTargetReport(
    meta,
    slug,
    result,
    outcomes,
    transcript,
    check,
  );
  const delivery = await deliverIssueReport(api, slug, body, needsAttention);
  if ("warning" in delivery) {
    io.annotate("warning", `${display}: ${delivery.warning}`);
    return delivery.warning;
  }
  return undefined;
}
