/**
 * File (or update) a GitHub issue when the nightly e2e run fails. The nightly
 * workflow runs this only on failure, with gh authenticated through GH_TOKEN
 * (issues: write). It walks every failing-scenario directory dumped under
 * test/e2e/.artifacts/ and builds one issue body summarizing them: the replay
 * command with each scenario's seed, its scenario.yml, the head of its report,
 * and the run link. A recurring failure comments on the existing open e2e-fuzz
 * issue instead of opening a duplicate.
 *
 * Usage: `bun .github/scripts/file-fuzz-issue.ts`. Context from the
 * environment: GH_TOKEN (gh auth), GITHUB_SERVER_URL / GITHUB_REPOSITORY /
 * GITHUB_RUN_ID (the run link), and FUZZ_SEED (the nightly master seed, used
 * when a failure directory carries no seed of its own).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const ARTIFACTS = join(ROOT, "test", "e2e", ".artifacts");
const LABEL = "e2e-fuzz";
const ISSUE_TITLE = "e2e fuzz failures (nightly)";
/** Report head shown per failing scenario; a body is a summary, not a log. */
const REPORT_LINES = 60;
/** Scenario YAML head shown per artifact; the full file is in the attachment. */
const SCENARIO_LINES = 80;
/**
 * GitHub caps an issue or comment body at 65,536 characters. Stay comfortably
 * under it and let the truncation notice and the uploaded artifacts carry the
 * rest.
 */
const MAX_BODY = 60_000;
/**
 * Hard per-block character cap after line truncation, so one very long single
 * line (which line truncation cannot shorten) cannot dominate the body. Small
 * enough that the fixed header/footer/notice plus at least one full block
 * always fit inside MAX_BODY.
 */
const MAX_BLOCK_CHARS = 8_000;

/** Run gh and return stdout; throws with gh's stderr on a non-zero exit. */
async function gh(args: string[]): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`gh ${args.join(" ")} failed (${code}): ${stderr.trim()}`);
  }
  return stdout;
}

/** The failing-scenario directories dumped under .artifacts, oldest first. */
export function failureDirs(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root)
    .map((name) => join(root, name))
    .filter((path) => statSync(path).isDirectory())
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
}

/**
 * The first `limit` lines of `text`, with a marker naming how many were cut. A
 * single trailing newline is not counted as a line, so text of exactly `limit`
 * lines plus a trailing newline is returned whole rather than reporting one
 * phantom extra line.
 */
export function head(text: string, limit: number): string {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop(); // a trailing newline splits to an empty final element; drop it
  }
  if (lines.length <= limit) {
    return text.trimEnd();
  }
  return `${lines.slice(0, limit).join("\n")}\n... (${lines.length - limit} more lines)`;
}

/**
 * Truncate `text` to at most `max` characters, appending a marker when cut, so
 * a single very long line (which line truncation cannot shorten) can never blow
 * the body budget. The marker itself is counted, so the return is always <= max.
 */
export function capChars(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const marker = "\n... (truncated)";
  const keep = Math.max(0, max - marker.length);
  return text.slice(0, keep) + marker;
}

/**
 * The fuzz seed for a failing artifact, or undefined for a corpus failure.
 * Fuzz scenarios are named `fuzz-<seed>` or `fuzz-multi-<seed>` (test/e2e/
 * generators.ts), so the seed comes ONLY from the artifact name. A corpus
 * scenario name has no such prefix, which tells the caller to emit a
 * `run.ts --scenario` replay; report text is never consulted, so a corpus
 * report that happens to contain the word "seed" cannot mislabel the replay.
 */
export function seedFrom(name: string): string | undefined {
  return name.match(/^fuzz(?:-multi)?-(\d+)$/)?.[1];
}

/**
 * The replay command for a failing artifact: a fuzz seed replays the exact
 * iteration; a corpus scenario (no seed) replays by name through run.ts.
 */
export function replayCommand(name: string, seed: string | undefined): string {
  return seed
    ? `bun test/e2e/fuzz.ts --iterations 1 --seed ${seed}`
    : `bun test/e2e/run.ts --scenario ${name}`;
}

/** The run link built from the standard Actions environment variables. */
export function runUrl(env: NodeJS.ProcessEnv): string {
  const server = env.GITHUB_SERVER_URL;
  const repo = env.GITHUB_REPOSITORY;
  const runId = env.GITHUB_RUN_ID;
  if (!server || !repo || !runId) {
    return "";
  }
  return `${server}/${repo}/actions/runs/${runId}`;
}

/** Read a named file from a dir, or "" when it is absent. */
function readIfPresent(dir: string, name: string): string {
  const path = join(dir, name);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** Build the issue/comment body from every failing-scenario directory. */
export function buildBody(dirs: string[], env: NodeJS.ProcessEnv): string {
  const date = new Date().toISOString().slice(0, 10);
  if (dirs.length === 0) {
    const parts = [
      `Nightly e2e run on ${date} failed with no failing-scenario artifact.`,
      "",
      "The failure was a non-scenario step (freshness check or coverage tripwire).",
      "See the run log for detail.",
    ];
    const bareUrl = runUrl(env);
    if (bareUrl) {
      parts.push("", `Run: ${bareUrl}`);
    }
    return parts.join("\n");
  }

  const url = runUrl(env);
  const header = `Nightly e2e run on ${date} produced ${dirs.length} failing scenario(s).\n`;
  const footer = url ? `\nRun: ${url}` : "";
  const artifactsNote =
    "\nThe full artifacts (scenario.yml, request trace, report) are attached to " +
    "the run as `e2e-artifacts`.";
  // The omission notice is only present when some blocks are dropped, but its
  // length is reserved up front so the running total stays a real character
  // budget whether or not it ends up shown. Padded for the count digits.
  const noticeReserve =
    `\n${dirs.length} more failing scenario(s) omitted to stay under the GitHub body limit; see the attached artifacts.`
      .length;

  // Append per-scenario blocks while each fits the remaining budget; then stop
  // and say how many were omitted. Every block (including the first) is both
  // character-capped and budget-checked, so no single artifact can push the
  // body past GitHub's limit and break the filing itself.
  const budget = MAX_BODY - header.length - footer.length - artifactsNote.length - noticeReserve;
  const blocks: string[] = [];
  let used = 0;
  let shown = 0;
  for (const dir of dirs) {
    const scenario = readIfPresent(dir, "scenario.yml");
    const report = readIfPresent(dir, "report.md");
    const name = report.split("\n")[0]?.replace(/^#\s*/, "").trim() || "scenario";
    const block = capChars(
      [
        `## ${name}`,
        "",
        "Replay:",
        "",
        "```bash",
        replayCommand(name, seedFrom(name)),
        "```",
        "",
        ...(report ? [head(report, REPORT_LINES), ""] : []),
        ...(scenario
          ? ["Scenario:", "", "```yaml", head(scenario, SCENARIO_LINES), "```", ""]
          : []),
      ].join("\n"),
      MAX_BLOCK_CHARS,
    );
    // +1 for the "\n" join between blocks. Stop before overflowing the budget.
    if (used + block.length + 1 > budget) {
      break;
    }
    blocks.push(block);
    used += block.length + 1;
    shown++;
  }

  const omitted = dirs.length - shown;
  const truncation =
    omitted > 0
      ? `\n${omitted} more failing scenario(s) omitted to stay under the GitHub body limit; see the attached artifacts.`
      : "";
  return `${header}\n${blocks.join("\n")}${truncation}${artifactsNote}${footer}`;
}

/** The number of the open issue carrying the label, or undefined when none. */
async function openIssueNumber(): Promise<number | undefined> {
  const json = await gh([
    "issue",
    "list",
    "--label",
    LABEL,
    "--state",
    "open",
    "--limit",
    "1",
    "--json",
    "number",
  ]);
  const issues = JSON.parse(json) as Array<{ number: number }>;
  return issues[0]?.number;
}

async function main(): Promise<number> {
  // Idempotent: --force turns an existing-label create into a no-op.
  await gh([
    "label",
    "create",
    LABEL,
    "--force",
    "--color",
    "B60205",
    "--description",
    "e2e fuzz failure",
  ]);

  const dirs = failureDirs(ARTIFACTS);
  const body = buildBody(dirs, process.env);

  const existing = await openIssueNumber();
  if (existing !== undefined) {
    await gh(["issue", "comment", String(existing), "--body", body]);
    console.log(`commented on existing #${existing}`);
    return 0;
  }
  const url = await gh([
    "issue",
    "create",
    "--label",
    LABEL,
    "--title",
    ISSUE_TITLE,
    "--body",
    body,
  ]);
  console.log(`opened ${url.trim()}`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
