/**
 * The shared private-report composer: one markdown document per redacted
 * target, rendered identically for both delivery channels (the report
 * issue's body, the encrypted artifact). Pure - every value, including the
 * timestamp, is passed in. The parameter types are structural on purpose,
 * so this module depends on no action-layer types.
 */

/** One captured Io line: annotations carry a level, plain log lines do not. */
export interface TranscriptLine {
  level?: "notice" | "warning" | "error";
  line: string;
}

/** One per-section outcome row, unredacted. */
export interface OutcomeRow {
  key: string;
  status: string;
  detail: string[];
}

export interface ReportInput {
  /** The target's owner/name slug, unredacted - this document is private. */
  target: string;
  /** The admin repository the workflow ran in. */
  adminRepo: string;
  /** Link to the workflow run that produced this report. */
  runUrl: string;
  /** "apply" or "check". */
  mode: string;
  /** The target's overall result (applied, clean, drift, failed, ...). */
  result: string;
  /** ISO timestamp of the run. */
  timestamp: string;
  /** Per-section outcomes with full detail. */
  outcomes: OutcomeRow[];
  /** Every log line and annotation the run captured for this target. */
  transcript: TranscriptLine[];
}

/** Escape the one character that would break a markdown table cell. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/**
 * A code fence guaranteed longer than any backtick run inside the content,
 * so a transcript line can never terminate the transcript block early.
 */
function fenceFor(content: string): string {
  const longest = content.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
  return "`".repeat(Math.max(3, longest + 1));
}

/** Render one transcript line: annotations keep their level as a prefix. */
function transcriptLine(entry: TranscriptLine): string {
  return entry.level === undefined ? entry.line : `[${entry.level}] ${entry.line}`;
}

/** Render the full, unredacted per-target report document. */
export function composeReport(input: ReportInput): string {
  const lines: string[] = [
    `# settings-as-code private report: ${input.target}`,
    "",
    "Full, unredacted report for this target. The public run redacts it; this document is its private mirror.",
    "",
    "| | |",
    "|---|---|",
    `| Target | ${cell(input.target)} |`,
    `| Admin repository | ${cell(input.adminRepo)} |`,
    `| Run | ${cell(input.runUrl)} |`,
    `| Mode | ${cell(input.mode)} |`,
    `| Result | ${cell(input.result)} |`,
    `| Generated | ${cell(input.timestamp)} |`,
    "",
    "## Sections",
    "",
  ];
  if (input.outcomes.length === 0) {
    lines.push("No sections ran for this target.");
  } else {
    lines.push("| Section | Status | Detail |", "|---|---|---|");
    for (const outcome of input.outcomes) {
      const detail = outcome.detail.map(cell).join("<br>");
      lines.push(`| ${cell(outcome.key)} | ${cell(outcome.status)} | ${detail} |`);
    }
  }
  lines.push("", "## Transcript", "");
  if (input.transcript.length === 0) {
    lines.push("No output was captured for this target.");
  } else {
    const body = input.transcript.map(transcriptLine).join("\n");
    const fence = fenceFor(body);
    lines.push(fence, body, fence);
  }
  lines.push("");
  return lines.join("\n");
}
