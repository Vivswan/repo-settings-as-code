/**
 * Step-summary rendering: the per-section table (single-repo) and the
 * per-repository overview plus per-target tables (multi-repo).
 */

import { appendFileSync } from "node:fs";
import type { RepoResult, SectionOutcome } from "../engine/orchestrate.js";
import type { TargetOutcome } from "./multi.js";

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

export function writeSummary(outcomes: SectionOutcome[], mode: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) {
    return;
  }
  const lines = [`## repo-settings-as-code (${mode})`, "", ...outcomeRows(outcomes)];
  appendFileSync(file, `${lines.join("\n")}\n`);
}

export function writeMultiSummary(targets: TargetOutcome[], mode: string): void {
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
