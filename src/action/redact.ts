/**
 * Private-repo redaction: the plan that decides which targets are hidden,
 * the placeholder names that replace their slugs everywhere the run is
 * publicly readable, the per-target channel that routes a redacted target's
 * lines into a transcript and seals its end state, and the projections that
 * open the seal into the public view.
 *
 * GitHub Actions has no log-level access control: run logs, summaries, and
 * outputs inherit the admin repository's visibility. When that repository is
 * public, a target's slug and its live settings would leak. Redaction is the
 * choke point that keeps private and internal targets out of the public view.
 */

import type { Target } from "../discovery/targets.js";
import type { RepoRunResult } from "../engine/orchestrate.js";
import type { RepoVisibility } from "../github/repo-visibility.js";
import { type AnnotationLevel, type Io, prefixedIo } from "../io.js";
import { isPrivate, markPrivate, type Private } from "../private.js";
import { revealPrivate } from "../private-open.js";
import type { SectionKey } from "../schema.js";

/** The `private-repos` input values; the single source its type derives from. */
export const PRIVATE_REPOS_POLICIES = ["redact", "show"] as const;

/** Default `private-repos`, pinned against action.yml by the contract test. */
export const DEFAULT_PRIVATE_REPOS = "redact";

export type PrivateReposPolicy = (typeof PRIVATE_REPOS_POLICIES)[number];

/**
 * The `private-report` channel values. `none` delivers nothing; `issue` posts
 * the full unredacted report to the private target repo itself (the one
 * GitHub-ACL-private channel a public run has); `issue-on-failure` is the
 * quiet variant of `issue` - it writes the issue only when the run needs
 * attention (failed, or check-mode drift) and closes it on recovery, so a
 * healthy repo never sees an issue at all; `artifact` uploads every redacted
 * target's report as one age-encrypted workflow artifact, for readers who
 * hold the key but no GitHub access to the targets. The single source its
 * type derives from.
 */
export const PRIVATE_REPORT_CHANNELS = ["none", "issue", "issue-on-failure", "artifact"] as const;

/** Default `private-report`, pinned against action.yml by the contract test. */
export const DEFAULT_PRIVATE_REPORT = "none";

export type PrivateReportChannel = (typeof PRIVATE_REPORT_CHANNELS)[number];

/** The channels that deliver through the target repo's report issue. */
export type IssueChannel = Extract<PrivateReportChannel, "issue" | "issue-on-failure">;

/** Narrow a channel to the issue-delivering pair. */
export function isIssueChannel(channel: PrivateReportChannel): channel is IssueChannel {
  return channel === "issue" || channel === "issue-on-failure";
}

/**
 * The note appended to every redacted line: it names the two escape hatches
 * (opt out, or run from a context where the target's own logs are private).
 */
export const REDACTED_NOTE =
  "details hidden: the repository is private or internal. Set private-repos: show to reveal them, or run the action inside that repository";

/** The placeholder that replaces every hidden detail value in the public view. */
export const REDACTED_DETAIL = "hidden (private repository)";

/**
 * The notice for a redacted target whose visibility could not be PROVEN
 * private or internal, so the private report was withheld (delivery fails
 * closed the opposite way from redaction). Shared verbatim by the single-
 * and multi-repo run flows - the cause and the fix are slug-free, so one
 * wording serves both without leaking anything.
 */
export const WITHHELD_REPORT_NOTICE =
  "visibility could not be verified (the repository-metadata probe failed or was inconclusive " +
  "- typically the token cannot read the target repository), so the private report was " +
  "withheld rather than risk delivering it to a public repository. Grant the token metadata " +
  "read access and re-run; a transient API failure also leaves visibility unverified";

/**
 * One target's rich end state: slug, section outcomes with live detail, and
 * the note for a skip or failure that produced no outcomes. Open in the clear;
 * sealed with the transcript when redacted.
 */
interface TargetDetail {
  slug: string;
  outcomes: RepoRunResult["outcomes"];
  note?: string;
}

/** A redacted target's detail also carries every line its run would have printed. */
export interface RedactedDetail extends TargetDetail {
  transcript: CapturedLine[];
}

/** One multi-repo target's end state: safe closed values plus the detail the public view projects from. */
export interface TargetOutcome {
  source: Target["source"];
  result: RepoRunResult["result"];
  /** The public label: the slug, or its "private repository #N" placeholder. */
  display: string;
  detail: TargetDetail | Private<RedactedDetail>;
}

/** A leak-free section outcome: key and status survive, detail is hidden. */
type RedactedOutcome = {
  key: SectionKey;
  status: RepoRunResult["outcomes"][number]["status"];
  detail: string[];
};

/**
 * Strip a redacted target's section outcomes to safe values: the key and
 * status (closed enums, provably leak-free) survive, and every detail value is
 * replaced with the placeholder - plus the HTTP code on failed/skipped
 * sections, the one piece of error context that is a safe closed value.
 */
function redactOutcomes(outcomes: RepoRunResult["outcomes"]): RedactedOutcome[] {
  return outcomes.map((o) => {
    // The SectionOutcome union proves a code exists only on failed/skipped
    // rows, so presence alone decides.
    const withCode =
      o.httpStatus !== undefined ? `${REDACTED_DETAIL}, HTTP ${o.httpStatus}` : REDACTED_DETAIL;
    return { key: o.key, status: o.status, detail: [withCode] };
  });
}

/** The public rendering of one target's detail: the section rows and the note under its heading. */
export interface PublicDetail {
  outcomes: RedactedOutcome[];
  note?: string;
}

/**
 * The leak-free projection of a target's detail: sealed detail reduces to
 * statuses (plus HTTP codes) and the generic note, open detail passes through
 * byte-identical. The one place a seal opens for a public surface.
 */
export function publicDetail(detail: TargetOutcome["detail"]): PublicDetail {
  if (isPrivate(detail)) {
    return { outcomes: redactOutcomes(revealPrivate(detail).outcomes), note: REDACTED_NOTE };
  }
  return {
    outcomes: detail.outcomes.map((o) => ({ key: o.key, status: o.status, detail: o.detail })),
    note: detail.note,
  };
}

/** The public view of one multi-repo target (summary, outputs, annotations). */
export interface PublicTargetView extends PublicDetail {
  display: string;
  source: Target["source"];
  result: RepoRunResult["result"];
}

export function toPublicView(target: TargetOutcome): PublicTargetView {
  return {
    display: target.display,
    source: target.source,
    result: target.result,
    ...publicDetail(target.detail),
  };
}

/** True when a resolved visibility PROVES the repo private or internal. */
export function isPrivateVisibility(visibility: RepoVisibility): boolean {
  return visibility === "private" || visibility === "internal";
}

/**
 * The single generic annotation a redacted target gets: a failure names the
 * failed section keys and HTTP codes, a drift its drifted keys (closed values
 * only), a skip is noticed, a healthy run says nothing.
 */
export function emitRedactedResult(
  io: Io,
  display: string,
  result: RepoRunResult["result"],
  detail: Private<RedactedDetail>,
): void {
  const { outcomes } = revealPrivate(detail);
  if (result === "failed") {
    const failed = outcomes
      .filter((o) => o.status === "failed")
      .map((o) => (o.httpStatus !== undefined ? `${o.key} (${o.httpStatus})` : o.key));
    const sections = failed.length > 0 ? ` - ${failed.join(", ")}` : "";
    io.annotate("error", `${display}: failed${sections}. ${REDACTED_NOTE}`);
    return;
  }
  if (result === "drift") {
    const drifted = outcomes.filter((o) => o.status === "drift").map((o) => o.key);
    const sections = drifted.length > 0 ? ` - ${drifted.join(", ")}` : "";
    io.annotate("warning", `${display}: drift${sections}. ${REDACTED_NOTE}`);
    return;
  }
  if (result === "skipped") {
    io.annotate("notice", `${display}: skipped. ${REDACTED_NOTE}`);
  }
}

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

/** The plan under `private-repos: show`: nothing is hidden, nothing is masked. */
const SHOW_EVERYTHING: RedactionPlan = {
  isRedacted: () => false,
  display: (slug) => slug,
  maskedSlugs: [],
};

/**
 * Build the redaction plan (the identity plan under `show`): private targets
 * get `private repository #N` in target order, discovery-filtered privates are
 * only masked (not targets), and the self slug is never redacted.
 */
export function planRedaction(
  policy: PrivateReposPolicy,
  orderedTargetSlugs: string[],
  extraPrivateSlugs: Private<string>[],
  isPrivateSlug: (slug: string) => boolean,
  selfSlug: string,
): RedactionPlan {
  if (policy === "show") {
    return SHOW_EVERYTHING;
  }
  const self = selfSlug.toLowerCase();
  const placeholders = new Map<string, string>();
  const masked = new Map<string, string>();

  let n = 0;
  for (const slug of orderedTargetSlugs) {
    const key = slug.toLowerCase();
    if (key === self || !isPrivateSlug(slug) || placeholders.has(key)) {
      continue;
    }
    n += 1;
    placeholders.set(key, `private repository #${n}`);
    masked.set(key, slug);
  }
  for (const sealed of extraPrivateSlugs) {
    const slug = revealPrivate(sealed);
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

/** One recorded line from a captured Io: annotations carry a level, log lines do not. */
export interface CapturedLine {
  level?: AnnotationLevel;
  line: string;
}

/**
 * An Io that lets nothing textual out: annotate/log are recorded for the
 * private report, debug/summary/output are dropped (those surfaces are written
 * from the public view), only the mask registry passes through.
 */
export function capturingIo(io: Io): { io: Io; drain(): CapturedLine[] } {
  const captured: CapturedLine[] = [];
  return {
    io: {
      annotate: (level, message) => captured.push({ level, line: message }),
      log: (line) => captured.push({ line }),
      debug: () => {},
      summary: () => {},
      output: () => {},
      mask: io.mask,
      masked: io.masked,
    },
    drain: () => [...captured],
  };
}

/**
 * The channel one target reports through, opened ONCE from the redaction
 * decision: in the clear it emits publicly and closes open, redacted it
 * captures every line and closes sealed. Processing code holds only this.
 */
export interface TargetChannel {
  /** The public label: the slug, or its placeholder. */
  display: string;
  /** Sink for the target's own lines, attributed to it (prefixed in the clear). */
  io: Io;
  /** Sink for lines that already name their source (validation warnings): unprefixed, or the same capture. */
  unprefixed: Io;
  /** Close the channel with the target's section outcomes and skip/failure note. */
  close(outcomes: RepoRunResult["outcomes"], note?: string): TargetOutcome["detail"];
}

/** A target in the clear; `attributed` prefixes its lines with the slug (multi-repo mode). */
export function publicChannel(io: Io, slug: string, attributed: boolean): TargetChannel {
  return {
    display: slug,
    io: prefixedIo(io, attributed ? `${slug}: ` : ""),
    unprefixed: io,
    close: (outcomes, note) => ({ slug, outcomes, note }),
  };
}

/** A redacted target: every line is captured, and the detail closes sealed with the transcript. */
export function redactedChannel(io: Io, slug: string, display: string): TargetChannel {
  const capture = capturingIo(io);
  return {
    display,
    io: capture.io,
    unprefixed: capture.io,
    close: (outcomes, note) => markPrivate({ slug, outcomes, note, transcript: capture.drain() }),
  };
}

/**
 * Run `work` through the channel: a crash (a preflight write attempt naming its
 * path, an engine bug) is the target's failure, spoken only through the
 * channel's sink, so a redacted repository's text never reaches a top-level handler.
 */
export async function attempt<T>(
  channel: TargetChannel,
  work: () => Promise<T>,
  failed: (message: string) => T,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    channel.io.annotate("error", message);
    return failed(message);
  }
}

/** Open a multi-repo target's channel from the plan; lines in the clear carry the slug prefix. */
export function openTargetChannel(plan: RedactionPlan, io: Io, slug: string): TargetChannel {
  return plan.isRedacted(slug)
    ? redactedChannel(io, slug, plan.display(slug))
    : publicChannel(io, slug, true);
}
