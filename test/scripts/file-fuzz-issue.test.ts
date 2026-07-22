/**
 * Unit test for the nightly issue-filing script's pure helpers: line
 * truncation, seed extraction, the replay-command chooser, the run-link
 * builder, and the body assembly over failing-scenario directories (built in a
 * temp dir), including the corpus-vs-fuzz replay distinction and the body cap.
 * The gh calls are not tested here (they need a live GitHub).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBody,
  capChars,
  failureDirs,
  fileIssue,
  type GhRunner,
  head,
  issueNumberFromUrl,
  replayCommand,
  runUrl,
  seedFrom,
} from "../../.github/scripts/file-fuzz-issue.js";

describe("head", () => {
  test("returns the text unchanged when under the limit", () => {
    expect(head("a\nb\nc", 5)).toBe("a\nb\nc");
  });

  test("truncates and names how many lines were cut", () => {
    expect(head(["1", "2", "3", "4", "5"].join("\n"), 2)).toBe("1\n2\n... (3 more lines)");
  });

  test("trims trailing whitespace when under the limit", () => {
    expect(head("a\n\n", 5)).toBe("a");
  });

  test("a single trailing newline is not counted as an extra line", () => {
    // Exactly `limit` lines plus a trailing newline must return whole, not
    // report "1 more lines" for the empty trailing split element.
    const text = `${["1", "2", "3"].join("\n")}\n`;
    expect(head(text, 3)).toBe("1\n2\n3");
  });
});

describe("capChars", () => {
  test("returns the text unchanged when within the cap", () => {
    expect(capChars("short", 100)).toBe("short");
  });

  test("truncates a long single line to at most `max` characters", () => {
    const out = capChars("x".repeat(1000), 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.endsWith("... (truncated)")).toBe(true);
  });
});

describe("seedFrom", () => {
  test("reads the seed from a fuzz-<seed> scenario name", () => {
    expect(seedFrom("fuzz-998877")).toBe("998877");
  });

  test("reads the seed from a fuzz-multi-<seed> scenario name", () => {
    expect(seedFrom("fuzz-multi-4242")).toBe("4242");
  });

  test("returns undefined for a corpus name even if its report mentions a seed", () => {
    // Detection is name-only: a corpus scenario is never mislabeled a fuzz
    // failure just because its report text contains the word "seed".
    expect(seedFrom("labels-drift")).toBeUndefined();
    expect(seedFrom("seed-rotation-check")).toBeUndefined();
  });
});

describe("replayCommand", () => {
  test("a fuzz seed replays the exact iteration", () => {
    expect(replayCommand("whatever", "998877")).toBe(
      "bun test/e2e/fuzz.ts --iterations 1 --seed 998877",
    );
  });

  test("a corpus failure (no seed) replays by scenario name", () => {
    expect(replayCommand("labels-drift", undefined)).toBe(
      "bun test/e2e/run.ts --scenario labels-drift",
    );
  });
});

describe("runUrl", () => {
  test("builds the Actions run URL from the standard env vars", () => {
    expect(
      runUrl({
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "o/r",
        GITHUB_RUN_ID: "12345",
      } as NodeJS.ProcessEnv),
    ).toBe("https://github.com/o/r/actions/runs/12345");
  });

  test("returns empty when any component is missing", () => {
    expect(runUrl({ GITHUB_SERVER_URL: "https://github.com" } as NodeJS.ProcessEnv)).toBe("");
  });
});

describe("buildBody", () => {
  let root: string;
  const env = {
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "o/r",
    GITHUB_RUN_ID: "42",
  } as NodeJS.ProcessEnv;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "artifacts-"));
    // A corpus failure: report has no seed, so the replay is a run.ts command.
    const corpus = join(root, "labels-drift-100-0");
    mkdirSync(corpus, { recursive: true });
    writeFileSync(
      join(corpus, "report.md"),
      "# labels-drift\n\n## Failures\n\n- exit code 1 != 0\n",
    );
    writeFileSync(join(corpus, "scenario.yml"), "name: labels-drift\nsettings:\n  labels: []\n");
    // A fuzz failure: the report heading is the fuzz-<seed> scenario name, so
    // the replay is a seeded fuzz command detected from the name prefix.
    const fuzz = join(root, "fuzz-314159-0");
    mkdirSync(fuzz, { recursive: true });
    writeFileSync(join(fuzz, "report.md"), "# fuzz-314159\n\niter 7 FAIL\n");
    writeFileSync(join(fuzz, "scenario.yml"), "name: fuzz-314159\nsettings: {}\n");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("a corpus failure gets a run.ts replay, not an empty-seed fuzz command", () => {
    const body = buildBody(failureDirs(root), env);
    expect(body).toContain("## labels-drift");
    expect(body).toContain("bun test/e2e/run.ts --scenario labels-drift");
    expect(body).not.toContain("--seed undefined");
    expect(body).not.toContain("--seed \n");
  });

  test("a fuzz failure gets a seeded fuzz replay", () => {
    const body = buildBody(failureDirs(root), env);
    expect(body).toContain("bun test/e2e/fuzz.ts --iterations 1 --seed 314159");
  });

  test("includes the report, scenario, run link, and artifacts note", () => {
    const body = buildBody(failureDirs(root), env);
    expect(body).toContain("2 failure artifact(s)");
    expect(body).toContain("- exit code 1 != 0");
    expect(body).toContain("```yaml");
    expect(body).toContain("Run: https://github.com/o/r/actions/runs/42");
    expect(body).toContain("e2e-artifacts");
  });

  test("counts artifact directories, phrased as artifacts not scenarios", () => {
    // The header counts the artifact directories under .artifacts and phrases
    // that as "failure artifact(s)", the honest name for what is counted.
    const body = buildBody(failureDirs(root), env);
    expect(body).toContain("failure artifact(s)");
    expect(body).not.toContain("failing scenario(s)");
  });

  test("caps the body under the GitHub limit and says how many were omitted", () => {
    // Many large failure dirs: the body must stay well under 65,536 chars and
    // name the omitted scenarios.
    const bigRoot = mkdtempSync(join(tmpdir(), "big-"));
    const filler = "x".repeat(5000);
    for (let i = 0; i < 40; i++) {
      const dir = join(bigRoot, `scenario-${i}-0`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "report.md"), `# scenario-${i}\n\n${filler}\n`);
      writeFileSync(join(dir, "scenario.yml"), `name: scenario-${i}\nbody: ${filler}\n`);
    }
    const body = buildBody(failureDirs(bigRoot), env);
    expect(body.length).toBeLessThan(65_536);
    expect(body).toContain("omitted to stay under the GitHub body limit");
    rmSync(bigRoot, { recursive: true, force: true });
  });

  test("a single giant single-line artifact still produces a body under the limit", () => {
    // The pathological case: one artifact whose report and scenario are each a
    // single 70,000-char line, which line truncation cannot shorten. The
    // character cap must keep the whole body under GitHub's 65,536 limit so the
    // filing itself does not fail.
    const giantRoot = mkdtempSync(join(tmpdir(), "giant-"));
    const dir = join(giantRoot, "labels-drift-9-0");
    mkdirSync(dir, { recursive: true });
    const giant = "x".repeat(70_000);
    writeFileSync(join(dir, "report.md"), `# labels-drift\n${giant}`);
    writeFileSync(join(dir, "scenario.yml"), `name: labels-drift\nbody: ${giant}`);
    const body = buildBody(failureDirs(giantRoot), env);
    expect(body.length).toBeLessThan(65_536);
    expect(body).toContain("## labels-drift");
    expect(body).toContain("Run: https://github.com/o/r/actions/runs/42");
    rmSync(giantRoot, { recursive: true, force: true });
  });

  test("files a bare notice when there are no failing-scenario dirs", () => {
    const body = buildBody([], env);
    expect(body).toContain("no failing-scenario artifact");
    expect(body).toContain("Run: https://github.com/o/r/actions/runs/42");
  });
});

describe("fileIssue", () => {
  /**
   * A recording gh runner: captures every command and answers the issue-list
   * query from `openNumber` (a number opens the comment path, undefined the
   * create path).
   */
  function fakeGh(openNumber?: number): { run: GhRunner; calls: string[][] } {
    const calls: string[][] = [];
    const run: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify(openNumber === undefined ? [] : [{ number: openNumber }]);
      }
      if (args[0] === "issue" && args[1] === "create") {
        return "https://github.com/o/r/issues/7\n";
      }
      return "";
    };
    return { run, calls };
  }

  test("create path opens a labeled issue with the body", async () => {
    const { run, calls } = fakeGh(undefined);
    await fileIssue(run, "body");
    const create = calls.find((c) => c[0] === "issue" && c[1] === "create");
    expect(create).toBeDefined();
    expect(create).toContain("--label");
    expect(create?.[create.indexOf("--label") + 1]).toBe("e2e-fuzz");
    expect(create?.[create.indexOf("--body") + 1]).toBe("body");
  });

  test("comment path comments on the existing issue, does not create a new one", async () => {
    const { run, calls } = fakeGh(3);
    await fileIssue(run, "body");
    expect(calls.some((c) => c[0] === "issue" && c[1] === "comment" && c[2] === "3")).toBe(true);
    expect(calls.some((c) => c[0] === "issue" && c[1] === "create")).toBe(false);
  });

  test("the filer performs no assignment on either path", async () => {
    // Assignment policy lives in the auto-assign workflow, which the nightly
    // dispatches after filing; the filer must never touch assignees.
    for (const openNumber of [undefined, 3]) {
      const { run, calls } = fakeGh(openNumber);
      await fileIssue(run, "body");
      const flat = calls.flat();
      expect(flat).not.toContain("--assignee");
      expect(flat).not.toContain("--add-assignee");
      expect(calls.some((c) => c[0] === "issue" && c[1] === "edit")).toBe(false);
    }
  });

  test("returns the created issue number (parsed from gh's create URL)", async () => {
    const { run } = fakeGh(undefined); // fakeGh's create returns .../issues/7
    expect(await fileIssue(run, "body")).toBe(7);
  });

  test("returns the existing issue number on the comment path", async () => {
    const { run } = fakeGh(3);
    expect(await fileIssue(run, "body")).toBe(3);
  });
});

describe("issueNumberFromUrl", () => {
  test("parses the trailing number from a gh issue URL", () => {
    expect(issueNumberFromUrl("https://github.com/o/r/issues/42\n")).toBe(42);
  });

  test("returns undefined when the URL has no trailing number", () => {
    expect(issueNumberFromUrl("not a url")).toBeUndefined();
  });
});
