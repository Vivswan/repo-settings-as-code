/**
 * Private-repo redaction: the plan that decides which targets are hidden,
 * the placeholder names that replace their slugs everywhere the run is
 * publicly readable, and the capturing Io that suppresses a redacted
 * target's engine output while recording it for the private report.
 *
 * GitHub Actions has no log-level access control: run logs, summaries, and
 * outputs inherit the admin repository's visibility. When that repository is
 * public, a target's slug and its live settings would leak. Redaction is the
 * choke point that keeps private and internal targets out of the public view.
 */

import type { Io } from "../io.js";

/** The `private-repos` input values; the single source its type derives from. */
export const PRIVATE_REPOS_POLICIES = ["redact", "show"] as const;

/** Default `private-repos`, pinned against action.yml by the contract test. */
export const DEFAULT_PRIVATE_REPOS = "redact";

export type PrivateReposPolicy = (typeof PRIVATE_REPOS_POLICIES)[number];

/**
 * The `private-report` channel values. `none` delivers nothing; `issue` posts
 * the full unredacted report to the private target repo itself (the one
 * GitHub-ACL-private channel a public run has). The `artifact` channel is a
 * later slice, so the enum grows then. The single source its type derives from.
 */
export const PRIVATE_REPORT_CHANNELS = ["none", "issue"] as const;

/** Default `private-report`, pinned against action.yml by the contract test. */
export const DEFAULT_PRIVATE_REPORT = "none";

export type PrivateReportChannel = (typeof PRIVATE_REPORT_CHANNELS)[number];

/**
 * The note appended to every redacted line: it names the two escape hatches
 * (opt out, or run from a context where the target's own logs are private).
 */
export const REDACTED_NOTE =
  "details hidden: the repository is private or internal. Set private-repos: show to reveal them, or run the action inside that repository";

/** The placeholder that replaces every hidden detail value in the public view. */
export const REDACTED_DETAIL = "hidden (private repository)";

/**
 * The redaction decision for one run: which slugs are hidden, the
 * placeholder each redacted slug renders as, and the full masked set the
 * caller registers with `io.mask` and the trace hardening. All slug lookups
 * are case-insensitive; a central and a remote entry for the same repository
 * share one placeholder.
 */
export interface RedactionPlan {
  /** True when this slug must be hidden from the public view. */
  isRedacted(slug: string): boolean;
  /** The placeholder for a redacted slug, or the slug itself when not redacted. */
  display(slug: string): string;
  /** Every slug that must be masked: redacted targets plus discovery-filtered privates. */
  maskedSlugs: string[];
}

/**
 * Build the redaction plan.
 *
 * `orderedTargetSlugs` are the run's targets in final order; a private one
 * gets the placeholder `private repository #N`, numbered 1-based over the
 * redacted targets in that order. `extraPrivateSlugs` are discovery-filtered
 * private repositories - masked (their names must not surface in skip
 * notices) but never given a placeholder, because they are not targets.
 * `selfSlug` is `GITHUB_REPOSITORY`: a repository operating on itself leaks
 * nothing, so it is never redacted (matched case-insensitively).
 */
export function planRedaction(
  orderedTargetSlugs: string[],
  extraPrivateSlugs: string[],
  isPrivate: (slug: string) => boolean,
  selfSlug: string,
): RedactionPlan {
  const self = selfSlug.toLowerCase();
  const placeholders = new Map<string, string>();
  const masked = new Map<string, string>();

  let n = 0;
  for (const slug of orderedTargetSlugs) {
    const key = slug.toLowerCase();
    if (key === self || !isPrivate(slug) || placeholders.has(key)) {
      continue;
    }
    n += 1;
    placeholders.set(key, `private repository #${n}`);
    masked.set(key, slug);
  }
  for (const slug of extraPrivateSlugs) {
    const key = slug.toLowerCase();
    if (key === self || masked.has(key)) {
      continue;
    }
    // Discovery-filtered privates are masked but never placeholdered.
    masked.set(key, slug);
  }

  return {
    isRedacted: (slug) => placeholders.has(slug.toLowerCase()),
    display: (slug) => placeholders.get(slug.toLowerCase()) ?? slug,
    maskedSlugs: [...masked.values()],
  };
}

/** One recorded line from a captured Io, preserving its emission channel. */
export interface CapturedLine {
  kind: "annotate" | "log";
  level?: "notice" | "warning" | "error";
  line: string;
}

/**
 * Wrap an Io so `annotate` and `log` are SUPPRESSED from public emission and
 * recorded in order instead; `mask` still passes through (masking a value is
 * never a leak). `drain()` returns the recorded transcript for the private
 * report, which delivers the full detail through a channel whose access
 * control is not the public run.
 */
export function capturingIo(io: Io): { io: Io; drain(): CapturedLine[] } {
  const captured: CapturedLine[] = [];
  return {
    io: {
      annotate: (level, message) => captured.push({ kind: "annotate", level, line: message }),
      log: (line) => captured.push({ kind: "log", line }),
      mask: (value) => io.mask(value),
    },
    drain: () => captured,
  };
}
