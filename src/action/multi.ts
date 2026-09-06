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
 * window before masking takes effect. Each target then reports through the
 * channel the plan opens for it, and a redacted target's end state closes
 * SEALED: the summary, outputs, and report reach it only through projections.
 */

import { readFileSync } from "node:fs";
import { resolveCentralTargets } from "../discovery/central.js";
import { type DiscoveryFilters, discoverRepos, formatSkipNotice } from "../discovery/discover.js";
import { parseReposInput } from "../discovery/repos-input.js";
import {
  type CentralTarget,
  dedupeTargets,
  parseRepoSlug,
  type RemoteTarget,
  type RepoRef,
  type Target,
} from "../discovery/targets.js";
import { applyDefaults } from "../engine/merge.js";
import { runForRepo, validateSettingsDoc } from "../engine/orchestrate.js";
import { targetSecretSource } from "../engine/secrets.js";
import { type GithubClient, isPermissionError, RERUN_ADVICE } from "../github/api.js";
import { getRepoFile } from "../github/repo-file.js";
import { createVisibilityResolver, type RepoVisibility } from "../github/repo-visibility.js";
import type { Io } from "../io.js";
import type { Private } from "../private.js";
import type { ArtifactUploader } from "../report/artifact-report.js";
import { applyMarkerInjection } from "../report/delivery.js";
import type { SectionKey, SettingsFile } from "../schema.js";
import {
  engineOutcome,
  failedTarget,
  type OpenedTarget,
  type TargetResult,
  targetFailure,
  withDelivery,
} from "./deliver.js";
import { DEFAULT_SETTINGS_FILE, quoteList } from "./inputs.js";
import {
  attempt,
  openTargetChannel,
  type PrivateReportChannel,
  type PrivateReposPolicy,
  planRedaction,
  type RedactionPlan,
  type TargetChannel,
  type TargetOutcome,
} from "./redact.js";
import { parseSettingsDoc, readSettingsFile } from "./settings-read.js";

export interface MultiConfig {
  reposDir: string;
  reposInput: string;
  defaultsFile: string;
  adminOwner: string;
  mode: "apply" | "check";
  onMissingPermission: "fail" | "warn";
  requiredSections: Set<SectionKey>;
  onlySections: Set<SectionKey>;
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
}

/**
 * Process one target end to end and return its end state; each failure (read,
 * missing file, parse, validation, preflight) returns early. The channel is the
 * only sink in scope, so a redacted target's text lands only in its report.
 */
async function processTarget(ctx: {
  api: GithubClient;
  target: Target;
  /** The target as an owner/name pair, parsed once at the caller's boundary. */
  repo: RepoRef;
  defaults: SettingsFile;
  cfg: MultiConfig;
  injectMarker: boolean;
  channel: TargetChannel;
}): Promise<TargetResult> {
  const { api, target, defaults, cfg, injectMarker, channel } = ctx;
  const fail = (richMessage: string): TargetResult => targetFailure(channel.io, richMessage);

  const read = await readTargetSettings(api, target);
  if ("error" in read) {
    return fail(read.error);
  }
  if ("missing" in read) {
    channel.io.annotate(
      "notice",
      `skipped - the repository has no ${DEFAULT_SETTINGS_FILE} on its default branch. Add the file to manage it, or remove ${target.slug} from the "repos" input`,
    );
    return {
      result: "skipped",
      outcomes: [],
      note: `no ${DEFAULT_SETTINGS_FILE} on the default branch`,
    };
  }

  const parsed = parseSettingsDoc(read.raw);
  if ("error" in parsed) {
    return fail(`cannot parse ${read.sourceLabel}: ${parsed.error}. Fix the YAML in that file`);
  }

  // Secret provenance is tagged at READ time, before the defaults merge folds
  // the documents together: a remote target's settings.yml is authored by the
  // TARGET repository, so every section it declares - and, since arrays
  // replace wholesale in the merge, every secret value that survives in such
  // a section - is sourced "target" (where a $NAME reference is refused - a
  // target must not route the operator's environment into itself). Central
  // files and the defaults file are operator-authored, so everything else
  // stays the "operator" default.
  const secretSource = target.source === "remote" ? targetSecretSource(parsed.doc) : undefined;

  const { settings: merged, disabled } = applyDefaults(defaults, parsed.doc);
  for (const key of disabled) {
    channel.io.annotate(
      "notice",
      `section "${key}" is set to null in ${read.sourceLabel}, which opts this repository out of that defaults-file section`,
    );
  }

  // validateSettingsDoc names sourceLabel (the slug for remote targets) in
  // its own warnings, so they go through the unprefixed sink. Its branded
  // return is the engine's admission ticket, so the merge-then-validate order
  // is enforced by the types.
  const validated = validateSettingsDoc(
    merged,
    read.sourceLabel,
    cfg.onlySections,
    channel.unprefixed,
  );
  if ("error" in validated) {
    return fail(validated.error);
  }

  // Marker injection is validity-preserving (it appends the constant marker
  // label config, or strips a rename), so it happens after validation and
  // keeps the brand.
  const injected = applyMarkerInjection(validated.settings, injectMarker);
  if (injected.notice) {
    channel.io.annotate("notice", injected.notice);
  }

  const run = await runForRepo(
    api,
    {
      repo: ctx.repo,
      settings: injected.settings,
      mode: cfg.mode,
      onMissingPermission: cfg.onMissingPermission,
      requiredSections: cfg.requiredSections,
      onlySections: cfg.onlySections,
      ...(secretSource === undefined ? {} : { secretSource }),
    },
    channel.io,
  );
  return engineOutcome(run, channel.io);
}

/**
 * Channel and exposure come from ONE redaction decision, so a redacted channel
 * never travels with a shown exposure. Discovery's full_name is API data, so
 * parseRepoSlug is the boundary proving every delivered target is an owner/name pair.
 */
function openTarget(
  plan: RedactionPlan,
  io: Io,
  slug: string,
  visibilityOf: (slug: string) => RepoVisibility,
): OpenedTarget {
  return {
    repo: parseRepoSlug(slug),
    channel: openTargetChannel(plan, io, slug),
    exposure: plan.isRedacted(slug)
      ? { kind: "redacted", visibility: visibilityOf(slug) }
      : { kind: "shown" },
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
    const sourceLabel = target.filePath;
    try {
      return { raw: readFileSync(target.filePath, "utf8"), sourceLabel };
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
  // The artifact upload port, injected only by tests alongside the stub api
  // and capturing io; production omits it and the real @actions/artifact
  // uploader applies.
  uploader?: ArtifactUploader,
): Promise<{ fatal: string | null; targets: TargetOutcome[] }> {
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
    const validated = validateSettingsDoc(read.doc, cfg.defaultsFile, cfg.onlySections, io);
    if ("error" in validated) {
      return fail(validated.error);
    }
    defaults = validated.settings;
  }

  let central: CentralTarget[] = [];
  if (cfg.reposDir) {
    const resolved = resolveCentralTargets(cfg.reposDir, cfg.adminOwner);
    if ("error" in resolved) {
      return fail(resolved.error);
    }
    bufferedWarnings.push(...resolved.warnings);
    central = resolved.targets;
  }

  let remote: RemoteTarget[] = [];
  let filteredOutCount = 0;
  const skipGroups: Array<{
    reason: string;
    repos: Parameters<typeof formatSkipNotice>[0]["repos"];
  }> = [];
  // Visibility learned from discovery (authoritative for those repos), so the
  // per-target probe is skipped for them.
  const knownVisibility = new Map<string, RepoVisibility>();
  // Private slugs that discovery filtered out (sealed): masked, never placeholdered.
  const filteredPrivateSlugs: Private<string>[] = [];
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
  // Under `redact` the map holds every target slug, so the fallback only
  // fires under `show` (where visibility is never consulted) - but it still
  // fails CLOSED: an unresolved slug is "unknown", which redaction treats as
  // private and delivery treats as unproven, never "public".
  const visibilityOf = (slug: string): RepoVisibility =>
    visibilityBySlug.get(slug.toLowerCase()) ?? "unknown";

  const plan = planRedaction(
    cfg.privateRepos,
    orderedSlugs,
    filteredPrivateSlugs,
    (slug) => visibilityOf(slug) !== "public",
    cfg.selfSlug,
  );

  // Mask every hidden slug BEFORE the first annotate/log/output; the API
  // trace reads the same registry.
  for (const slug of plan.maskedSlugs) {
    io.mask(slug);
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
        `multi-repo mode found no targets: repos: "*" discovery found ${filteredOutCount} ` +
          `${filteredOutCount === 1 ? "repository" : "repositories"}, but the discovery filters ` +
          `removed all of them (see the notices above). Relax the filter inputs, or add per-repo ` +
          `files to the repos-dir`,
      );
    }
    return fail(
      `multi-repo mode found no targets: repos-dir yielded no settings files and the "repos" input resolved to no repositories. Add per-repo files to the repos-dir, or list repositories in the "repos" input`,
    );
  }

  const results = await withDelivery({ api, cfg, io, uploader }, async (delivery) => {
    const delivered: TargetOutcome[] = [];
    for (const target of targets) {
      // The channel is opened BEFORE any processing so a read/parse/validation
      // failure lands in a redacted target's transcript too; it is the only sink
      // processing sees.
      const opened = openTarget(plan, io, target.slug, visibilityOf);
      const { channel, repo } = opened;
      // A crash mid-processing never stops the rest of the fleet; it becomes
      // this target's failure and still closes through the same delivery.
      const closed = await delivery.target(opened, async (injectMarker) =>
        repo === null
          ? targetFailure(
              channel.io,
              `the repository name "${target.slug}" from ${target.origin} is not an owner/name slug, so it cannot be targeted`,
            )
          : attempt(
              channel,
              () => processTarget({ api, target, repo, defaults, cfg, injectMarker, channel }),
              failedTarget,
            ),
      );
      delivered.push({ source: target.source, ...closed });
    }
    return delivered;
  });

  return { fatal: null, targets: results };
}
