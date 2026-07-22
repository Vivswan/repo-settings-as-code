import { describe, expect, test } from "bun:test";
import {
  forbiddenPresent,
  isSubsequence,
  parseGithubOutput,
  parseSummaryOutcomes,
} from "./runner.js";

describe("parseGithubOutput", () => {
  test("reads simple name=value lines", () => {
    expect(parseGithubOutput("result=applied\nskipped-sections=teams\n")).toEqual({
      result: "applied",
      "skipped-sections": "teams",
    });
  });

  test("reads the @actions/core heredoc block", () => {
    const out = parseGithubOutput(
      ["result<<ghadelimiter_abc", "line one", "line two", "ghadelimiter_abc", ""].join("\n"),
    );
    expect(out.result).toBe("line one\nline two");
  });

  test("mixes heredoc and simple forms", () => {
    const out = parseGithubOutput(
      ["result=drift", "repos-result<<ghadelimiter_x", "{}", "ghadelimiter_x"].join("\n"),
    );
    expect(out).toEqual({ result: "drift", "repos-result": "{}" });
  });

  test("ignores blank and malformed lines", () => {
    expect(parseGithubOutput("\n=orphan\nresult=clean\n")).toEqual({ result: "clean" });
  });
});

describe("parseSummaryOutcomes", () => {
  test("extracts key -> status from the section table rows", () => {
    const summary = [
      "## repo-settings-as-code (apply)",
      "",
      "| Section | Status | Detail |",
      "|---|---|---|",
      '| labels | :white_check_mark: applied | created label "bug" |',
      "| teams | :fast_forward: skipped | - |",
      "| rulesets | :warning: drift | rulesets[x]: ... |",
    ].join("\n");
    expect(parseSummaryOutcomes(summary)).toEqual({
      labels: "applied",
      teams: "skipped",
      rulesets: "drift",
    });
  });

  test("ignores the header and separator rows", () => {
    const summary = "| Section | Status | Detail |\n|---|---|---|\n";
    expect(parseSummaryOutcomes(summary)).toEqual({});
  });
});

describe("isSubsequence (mutations matcher)", () => {
  const log = [
    "PATCH /repos/o/r/labels/bug",
    "POST /repos/o/r/labels",
    "DELETE /repos/o/r/labels/wontfix",
  ];
  const cases: Array<[string, string[], string[], boolean]> = [
    ["empty patterns always match", [], log, true],
    ["exact in order", ["PATCH /repos/o/r/labels/bug", "POST /repos/o/r/labels"], log, true],
    [
      "prefix match, gaps allowed",
      ["PATCH /repos/o/r/labels/bug", "DELETE /repos/o/r/labels/wontfix"],
      log,
      true,
    ],
    ["wrong order fails", ["POST /repos/o/r/labels", "PATCH /repos/o/r/labels/bug"], log, false],
    ["a missing pattern fails", ["PUT /repos/o/r/topics"], log, false],
    [
      "more patterns than log fails",
      ["POST /repos/o/r/labels", "POST /repos/o/r/labels"],
      log,
      false,
    ],
  ];
  for (const [name, patterns, entries, want] of cases) {
    test(name, () => {
      expect(isSubsequence(patterns, entries)).toBe(want);
    });
  }
});

describe("forbiddenPresent (never matcher)", () => {
  const log = ["GET /repos/o/r/labels", "POST /repos/o/r/labels"];
  const cases: Array<[string, string[], string[]]> = [
    ["nothing forbidden present", ["DELETE /repos/o/r/labels"], []],
    ["a present prefix is reported", ["POST /repos/o/r/labels"], ["POST /repos/o/r/labels"]],
    ["a shorter prefix still matches", ["POST /repos/o/r"], ["POST /repos/o/r"]],
    ["empty patterns report nothing", [], []],
  ];
  for (const [name, patterns, want] of cases) {
    test(name, () => {
      expect(forbiddenPresent(patterns, log)).toEqual(want);
    });
  }
});
