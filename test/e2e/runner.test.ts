import { describe, expect, test } from "bun:test";
import { parseRecipient } from "../../src/report/artifact-report.js";
import { ARTIFACT_TEST_RECIPIENT } from "./generators.js";
import type { LoggedRequest } from "./mock/routes.js";
import {
  changedFamilies,
  checkLeaks,
  forbiddenPresent,
  isSubsequence,
  parseGithubOutput,
  parseSummaryOutcomes,
  secondApplyWriteFailures,
  stripDebugLines,
  stripMaskLines,
} from "./runner.js";

describe("ARTIFACT_TEST_RECIPIENT", () => {
  test("is a valid age recipient the action's config validation accepts", () => {
    // The artifact scenarios pin this constant as the report-public-key; if it
    // ever stops parsing, every artifact-delivery scenario would silently fall
    // into the config-rejection path instead. Pin it against the same validator
    // the action uses at config parse.
    expect(parseRecipient(ARTIFACT_TEST_RECIPIENT)).toEqual({ ok: true });
  });
});

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

describe("stripMaskLines", () => {
  test("drops ::add-mask:: lines and keeps everything else", () => {
    const stdout = [
      "::add-mask::acme/secret-repo",
      "::error::private repository #1: failed",
      "result: failed",
    ].join("\n");
    const stripped = stripMaskLines(stdout);
    expect(stripped).not.toContain("acme/secret-repo");
    expect(stripped).toContain("private repository #1: failed");
    expect(stripped).toContain("result: failed");
  });

  test("a slug outside a mask directive survives (so a real leak is caught)", () => {
    // The mask directive is the ONLY line allowed to carry the raw slug; a slug
    // anywhere else must remain after stripping so checkLeaks can flag it.
    const stdout = ["::add-mask::acme/secret-repo", "::debug::acme/secret-repo leaked here"].join(
      "\n",
    );
    expect(stripMaskLines(stdout)).toContain("acme/secret-repo leaked here");
  });
});

describe("stripDebugLines (counterfactual rendered-surface guard)", () => {
  test("a canary only in a ::debug:: trace does NOT survive - so it cannot satisfy the counterfactual", () => {
    // The counterfactual must judge RENDERED output, not API traces. A canary
    // that appears solely in a debug request-trace line is stripped, so it would
    // NOT count as having surfaced under show - a rendered-detail suppression
    // regression is therefore still caught.
    const stdout = [
      '::debug::POST /repos/o/r/labels payload: {"name":"CANARY-42"}',
      "::debug::GET /repos/o/r/labels -> 200",
    ].join("\n");
    expect(stripDebugLines(stdout)).not.toContain("CANARY-42");
  });

  test("a canary in a rendered (non-debug) line survives", () => {
    const stdout = [
      '::debug::POST /repos/o/r/labels payload: {"name":"CANARY-42"}',
      'o/r: labels: updated label "CANARY-42"',
    ].join("\n");
    const rendered = stripDebugLines(stdout);
    expect(rendered).not.toContain("payload"); // the debug trace is gone
    expect(rendered).toContain('updated label "CANARY-42"'); // the rendered line stays
  });
});

describe("checkLeaks (redaction leak invariant)", () => {
  test("no forbidden string anywhere is clean", () => {
    const observed = {
      summary: "| private repository #1 | remote | applied |",
      stdout: "::add-mask::acme/secret\nresult: applied",
      stderr: "",
      outputs: { "repos-result": '{"private repository #1":{"result":"applied"}}' },
    };
    expect(checkLeaks(observed, ["acme/secret", "CANARY-1"])).toEqual([]);
  });

  test("a slug in the summary is a leak", () => {
    const observed = {
      summary: "| acme/secret | remote | applied |",
      stdout: "",
      stderr: "",
      outputs: {},
    };
    expect(checkLeaks(observed, ["acme/secret"])).toEqual([
      'leak: "acme/secret" present in the step summary',
    ]);
  });

  test("a canary in stdout outside the mask directive is a leak", () => {
    const observed = {
      summary: "",
      stdout: "::add-mask::acme/secret\n::debug::CANARY-1 slipped out",
      stderr: "",
      outputs: {},
    };
    expect(checkLeaks(observed, ["CANARY-1"])).toEqual([
      'leak: "CANARY-1" present in stdout (after stripping ::add-mask:: lines)',
    ]);
  });

  test("a slug on stderr is a leak (the run log captures stderr too)", () => {
    const observed = {
      summary: "",
      stdout: "",
      stderr: "::add-mask::acme/secret\nTrace: request to acme/secret failed",
      outputs: {},
    };
    expect(checkLeaks(observed, ["acme/secret"])).toEqual([
      'leak: "acme/secret" present in stderr (after stripping ::add-mask:: lines)',
    ]);
  });

  test("the mask directive itself is not a leak", () => {
    const observed = { summary: "", stdout: "::add-mask::acme/secret", stderr: "", outputs: {} };
    expect(checkLeaks(observed, ["acme/secret"])).toEqual([]);
  });

  test("a slug in an output value is a leak", () => {
    const observed = {
      summary: "",
      stdout: "",
      stderr: "",
      outputs: { "repos-result": '{"acme/secret":{"result":"applied"}}' },
    };
    expect(checkLeaks(observed, ["acme/secret"])).toEqual([
      'leak: "acme/secret" present in the "repos-result" output',
    ]);
  });
});

describe("secondApplyWriteFailures (apply-idempotence zero-write subset)", () => {
  const write = (method: string, pathname: string): LoggedRequest => ({
    method,
    pathname,
    query: "",
    status: 200,
  });

  test("a write to a compare-before-write section fires the assertion", () => {
    const failures = secondApplyWriteFailures([write("POST", "/repos/e2e-owner/e2e-repo/labels")]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('"labels"');
    expect(failures[0]).toContain("compares before writing");
  });

  test("a write to an unconditional-PUT section passes", () => {
    // Rulesets and environments PUT existing resources on every apply, so a
    // second-apply write there is legitimate; only state stability binds them.
    expect(
      secondApplyWriteFailures([
        write("PUT", "/repos/e2e-owner/e2e-repo/rulesets/90000000"),
        write("PUT", "/repos/e2e-owner/e2e-repo/environments/production"),
      ]),
    ).toEqual([]);
  });

  test("a write matching no section endpoint fires the outside-section failure", () => {
    // Report traffic (the issue channel) is the realistic offender: an
    // idempotence re-run must not deliver a report at all.
    const failures = secondApplyWriteFailures([
      write("POST", "/repos/e2e-owner/svc-private/issues"),
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("outside any section endpoint");
  });

  test("every compare-before-write section's own writes are flagged, per offender", () => {
    const failures = secondApplyWriteFailures([
      write("PATCH", "/repos/e2e-owner/e2e-repo/labels/bug"),
      write("POST", "/repos/e2e-owner/e2e-repo/milestones"),
      write("DELETE", "/repos/e2e-owner/e2e-repo/autolinks/1"),
      write("PUT", "/repos/e2e-owner/e2e-repo/collaborators/alice"),
      write("PUT", "/repos/e2e-owner/e2e-repo/actions/workflows/7/enable"),
    ]);
    expect(failures).toHaveLength(5);
  });
});

describe("changedFamilies (apply-idempotence state stability)", () => {
  test("names exactly the families whose serialized state moved", () => {
    const before = new Map([
      ["state.labels", '[{"name":"bug"}]'],
      ["state.rulesets", "[]"],
    ]);
    const after = new Map([
      ["state.labels", "[]"],
      ["state.rulesets", "[]"],
    ]);
    expect(changedFamilies(before, after)).toEqual(["state.labels"]);
  });

  test("identical snapshots report no change", () => {
    const snap = new Map([["state.repo", '{"name":"x"}']]);
    expect(changedFamilies(snap, new Map(snap))).toEqual([]);
  });

  test("a family present on only one side counts as changed", () => {
    expect(changedFamilies(new Map(), new Map([["a/b.issues", "[]"]]))).toEqual(["a/b.issues"]);
    expect(changedFamilies(new Map([["a/b.issues", "[]"]]), new Map())).toEqual(["a/b.issues"]);
  });
});
