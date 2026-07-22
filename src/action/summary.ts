/**
 * Step-summary rendering: the per-section table (single-repo) and the
 * per-repository overview plus per-target tables (multi-repo).
 */

import { appendFileSync } from "node:fs";
import type { RepoResult, SectionOutcome } from "../engine/orchestrate.js";
import { type PublicTargetView, redactOutcomes } from "./multi.js";
import { REDACTED_NOTE } from "./redact.js";

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

/** The fields the section table renders; both SectionOutcome and the public view meet it. */
type OutcomeRow = Pick<SectionOutcome, "key" | "status" | "detail">;

function outcomeRows(outcomes: OutcomeRow[]): string[] {
  const rows = ["| Section | Status | Detail |", "|---|---|---|"];
  for (const outcome of outcomes) {
    const detail = outcome.detail.map(summaryCell).join("<br>") || "-";
    rows.push(
      `| ${outcome.key} | :${STATUS_ICON[outcome.status]}: ${outcome.status} | ${detail} |`,
    );
  }
  return rows;
}

export function writeSummary(outcomes: SectionOutcome[], mode: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) {
    return;
  }
  const lines = [`## repo-settings-as-code (${mode})`, "", ...outcomeRows(outcomes)];
  appendFileSync(file, `${lines.join("\n")}\n`);
}

/**
 * The single-repo summary for a redacted cross-repo target. The redaction
 * policy keeps per-section STATUSES visible everywhere, so this renders the
 * same section table the multi path renders - statuses in the clear, detail
 * cells hidden - via the shared redactOutcomes() projection, not a second
 * rendering. Used when the single-repo `repository` input names a different,
 * non-public repo.
 */
export function writeRedactedSummary(
  outcomes: SectionOutcome[],
  mode: string,
  result: RepoResult,
): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) {
    return;
  }
  const lines = [
    `## repo-settings-as-code (${mode})`,
    "",
    `:${STATUS_ICON[result]}: ${result} - ${REDACTED_NOTE}`,
    "",
    ...outcomeRows(redactOutcomes(outcomes)),
  ];
  appendFileSync(file, `${lines.join("\n")}\n`);
}

export function writeMultiSummary(views: PublicTargetView[], mode: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) {
    return;
  }
  const lines = [
    `## repo-settings-as-code (${mode}, ${views.length} repositories)`,
    "",
    "| Repository | Source | Result |",
    "|---|---|---|",
  ];
  for (const view of views) {
    lines.push(
      `| ${summaryCell(view.display)} | ${view.source} | :${STATUS_ICON[view.result]}: ${view.result} |`,
    );
  }
  for (const view of views) {
    lines.push("", `### ${summaryCell(view.display)} (${view.result})`, "");
    if (view.note) {
      lines.push(summaryCell(view.note), "");
    }
    if (view.outcomes.length > 0) {
      lines.push(...outcomeRows(view.outcomes));
    }
  }
  appendFileSync(file, `${lines.join("\n")}\n`);
}
