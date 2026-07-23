import { describe, expect, test } from "bun:test";
import { composeReport, type ReportInput } from "../../src/report/composer.js";

function input(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    target: "o/private-repo",
    adminRepo: "o/admin",
    runUrl: "https://github.com/o/admin/actions/runs/42",
    mode: "check",
    result: "drift",
    timestamp: "2026-07-22T10:00:00.000Z",
    outcomes: [
      { key: "labels", status: "drift", detail: ["labels[secret-project]: missing"] },
      { key: "repository", status: "clean", detail: [] },
    ],
    transcript: [
      { line: "labels: comparing 3 labels" },
      { level: "warning", line: "labels[secret-project]: missing" },
    ],
    ...overrides,
  };
}

describe("composeReport", () => {
  test("renders the run metadata, the outcome table, and the transcript", () => {
    const report = composeReport(input());
    expect(report).toContain("# settings-as-code private report: o/private-repo");
    expect(report).toContain("| Admin repository | o/admin |");
    expect(report).toContain("| Run | https://github.com/o/admin/actions/runs/42 |");
    expect(report).toContain("| Mode | check |");
    expect(report).toContain("| Result | drift |");
    expect(report).toContain("| Generated | 2026-07-22T10:00:00.000Z |");
    expect(report).toContain("| labels | drift | labels[secret-project]: missing |");
    expect(report).toContain("| repository | clean |  |");
    expect(report).toContain("labels: comparing 3 labels");
    expect(report).toContain("[warning] labels[secret-project]: missing");
  });

  test("joins multi-line detail with <br> and escapes table pipes", () => {
    const report = composeReport(
      input({
        outcomes: [{ key: "labels", status: "failed", detail: ["a | b", "second line"] }],
      }),
    );
    expect(report).toContain("| labels | failed | a \\| b<br>second line |");
  });

  test("backslashes are escaped BEFORE pipes, so backslash-pipe cannot split a row", () => {
    // Without the backslash escape, "a\|b" renders as an escaped backslash
    // followed by a LIVE pipe and the cell splits into two columns.
    const report = composeReport(
      input({
        outcomes: [{ key: "labels", status: "failed", detail: ["a\\|b", "line1\nline2"] }],
      }),
    );
    expect(report).toContain("| labels | failed | a\\\\\\|b<br>line1 line2 |");
  });

  test("a bare carriage return is a line ending too and is flattened", () => {
    // CommonMark treats a standalone CR as a line ending, so an unflattened
    // "\r" would still split the table row.
    const report = composeReport(
      input({ outcomes: [{ key: "labels", status: "failed", detail: ["cr\ronly"] }] }),
    );
    expect(report).toContain("| labels | failed | cr only |");
  });

  test("a transcript containing code fences cannot break out of its block", () => {
    const report = composeReport(
      input({ transcript: [{ line: "```" }, { line: "````fenced````" }] }),
    );
    const fence = "`".repeat(5);
    expect(report).toContain(`${fence}\n\`\`\`\n\`\`\`\`fenced\`\`\`\`\n${fence}`);
  });

  test("empty outcomes and transcript render placeholders, not empty tables", () => {
    const report = composeReport(input({ outcomes: [], transcript: [] }));
    expect(report).toContain("No sections ran for this target.");
    expect(report).toContain("No output was captured for this target.");
    expect(report).not.toContain("| Section |");
  });
});
