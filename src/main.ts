/**
 * repo-settings-as-code: apply a declarative .github/settings.yml to the repo.
 *
 * Policy model:
 * - mode: apply (default) mutates; check reports drift and exits 1 on any.
 * - on-missing-permission: fail (default) | warn. Under warn, a section the
 *   token cannot touch is skipped with a warning and the run stays green
 *   (partial success) - unless the section is listed in required-sections.
 * - Non-permission errors always fail, loudly, with the API message.
 *
 * Multi-repo mode (repos / repos-dir / defaults-file inputs): one run in an
 * admin repo applies settings to many repositories - from per-repo files
 * checked into the admin repo (central), or from each target's own
 * .github/settings.yml (remote), with an optional defaults layer merged
 * under every target. Targets run independently; the run fails at the end
 * if any target failed.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { GithubApi, isPermissionError } from "./api.js";
import { applyDefaults } from "./merge.js";
import {
  type Io,
  type RepoResult,
  runForRepo,
  type SectionOutcome,
  validateSettingsDoc,
  worstOf,
} from "./orchestrate.js";
import type { SettingsFile } from "./schema.js";
import { SECTION_KEYS } from "./schema.js";
import {
  dedupeTargets,
  discoverRepos,
  parseReposInput,
  resolveCentralTargets,
  SLUG_RE,
  type Target,
} from "./targets.js";

function input(name: string): string {
  // The runner exposes inputs as INPUT_<NAME> uppercased with SPACES (not
  // dashes) replaced by underscores: `settings-file` -> INPUT_SETTINGS-FILE.
  return (process.env[`INPUT_${name.toUpperCase().replace(/ /g, "_")}`] ?? "").trim();
}

function annotate(level: "notice" | "warning" | "error", message: string): void {
  // Workflow-command escaping: % first, then CR/LF.
  const escaped = message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  console.log(`::${level}::${escaped}`);
}

function setOutput(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (file) {
    appendFileSync(file, `${name}=${value}\n`);
  }
}

const STATUS_ICON: Record<string, string> = {
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

function writeSummary(outcomes: SectionOutcome[], mode: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) {
    return;
  }
  const lines = [`## repo-settings-as-code (${mode})`, "", ...outcomeRows(outcomes)];
  appendFileSync(file, `${lines.join("\n")}\n`);
}

/** One multi-repo target's end state, for the summary and outputs. */
interface TargetOutcome {
  slug: string;
  source: "central" | "remote";
  origin: string;
  result: RepoResult;
  outcomes: SectionOutcome[];
  skippedSections: string[];
  /** Human line for skips/failures that produced no section outcomes. */
  note?: string;
}

function writeMultiSummary(targets: TargetOutcome[], mode: string): void {
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

export interface MultiConfig {
  reposDir: string;
  reposInput: string;
  defaultsFile: string;
  adminOwner: string;
  mode: "apply" | "check";
  onMissingPermission: "fail" | "warn";
  requiredSections: Set<string>;
  onlySections: Set<string>;
}

/**
 * Multi-repo orchestration. Config-level problems (bad defaults file, no
 * targets, duplicate definitions, discovery failure) return `fatal` before
 * any target executes; per-target problems mark that target failed or
 * skipped and never stop the others.
 */
export async function runMulti(
  api: GithubApi,
  cfg: MultiConfig,
  io: Io,
): Promise<{ fatal: string | null; targets: TargetOutcome[] }> {
  const none: TargetOutcome[] = [];

  let defaults: SettingsFile = {};
  if (cfg.defaultsFile) {
    try {
      defaults = (parseYaml(readFileSync(cfg.defaultsFile, "utf8")) ?? {}) as SettingsFile;
    } catch (error) {
      return {
        fatal: `cannot read the defaults file ${cfg.defaultsFile}: ${String(error)}. Check the "defaults-file" path and that the file is valid YAML`,
        targets: none,
      };
    }
    const err = validateSettingsDoc(defaults, cfg.defaultsFile, cfg.onlySections, io);
    if (err) {
      return { fatal: err, targets: none };
    }
  }

  let central: Target[] = [];
  if (cfg.reposDir) {
    const resolved = resolveCentralTargets(cfg.reposDir, cfg.adminOwner);
    if ("error" in resolved) {
      return { fatal: resolved.error, targets: none };
    }
    for (const warning of resolved.warnings) {
      io.annotate("warning", warning);
    }
    central = resolved.targets;
  }

  let remote: Target[] = [];
  if (cfg.reposInput) {
    const parsed = parseReposInput(cfg.reposInput);
    if ("error" in parsed) {
      return { fatal: parsed.error, targets: none };
    }
    let slugs = parsed.slugs;
    let origin = 'the "repos" input';
    if (parsed.discover) {
      const discovered = await discoverRepos(api);
      if ("error" in discovered) {
        return { fatal: discovered.error, targets: none };
      }
      for (const archived of discovered.archivedSkipped) {
        io.annotate(
          "notice",
          `${archived}: skipped - the repository is archived, and settings writes fail on archived repositories. Unarchive it to manage it`,
        );
      }
      slugs = discovered.slugs;
      origin = 'repos: "*" discovery';
    }
    remote = slugs.map((slug) => ({ slug, source: "remote" as const, origin }));
  }

  const targets = dedupeTargets(central, remote, (message) => io.annotate("notice", message));
  if (targets.length === 0) {
    return {
      fatal: `multi-repo mode found no targets: repos-dir yielded no settings files and the "repos" input resolved to no repositories. Add per-repo files to the repos-dir, or list repositories in the "repos" input`,
      targets: none,
    };
  }

  const results: TargetOutcome[] = [];
  for (const target of targets) {
    const failTarget = (message: string, note?: string): void => {
      io.annotate("error", `${target.slug}: ${message}`);
      results.push({
        slug: target.slug,
        source: target.source,
        origin: target.origin,
        result: "failed",
        outcomes: [],
        skippedSections: [],
        note: note ?? message,
      });
    };
    try {
      let raw: string;
      let sourceLabel: string;
      if (target.source === "central") {
        sourceLabel = target.filePath ?? target.origin;
        try {
          raw = readFileSync(target.filePath ?? "", "utf8");
        } catch (error) {
          failTarget(
            `cannot read settings from ${sourceLabel}: ${String(error)}. Fix the file, or delete it to stop managing this repository`,
          );
          continue;
        }
      } else {
        sourceLabel = `${target.slug}:.github/settings.yml`;
        // Visibility gate: a repo-level 404 here is a token problem, so a
        // later missing-FILE 404 from the contents API is unambiguous.
        const gate = await api.tryRequest("GET", `/repos/${target.slug}`);
        if ("error" in gate) {
          failTarget(
            isPermissionError(gate.error)
              ? `the token was denied GET /repos/${target.slug}: ${gate.error.status} ${gate.error.message}. Grant the PAT access to this repository, or remove it from the "repos" input`
              : `GET /repos/${target.slug} failed: ${gate.error.status} ${gate.error.message}. This is not a permission problem; re-run the workflow, and retry later if it persists`,
          );
          continue;
        }
        const file = await api.getRepoFile(target.slug, ".github/settings.yml");
        if ("missing" in file) {
          io.annotate(
            "notice",
            `${target.slug}: skipped - the repository has no .github/settings.yml on its default branch. Add the file to manage it, or remove ${target.slug} from the "repos" input`,
          );
          results.push({
            slug: target.slug,
            source: target.source,
            origin: target.origin,
            result: "skipped",
            outcomes: [],
            skippedSections: [],
            note: "no .github/settings.yml on the default branch",
          });
          continue;
        }
        if ("error" in file) {
          failTarget(
            isPermissionError(file.error)
              ? `the token was denied reading ${sourceLabel}: ${file.error.status} ${file.error.message}. Grant the PAT Contents (read) on this repository, or remove it from the "repos" input`
              : `reading ${sourceLabel} failed: ${file.error.status} ${file.error.message}. This is not a permission problem; re-run the workflow, and retry later if it persists`,
          );
          continue;
        }
        raw = file.content;
      }

      let parsed: SettingsFile;
      try {
        parsed = (parseYaml(raw) ?? {}) as SettingsFile;
      } catch (error) {
        failTarget(`cannot parse ${sourceLabel}: ${String(error)}. Fix the YAML in that file`);
        continue;
      }

      const { settings, disabled } = applyDefaults(defaults, parsed);
      for (const key of disabled) {
        io.annotate(
          "notice",
          `${target.slug}: section "${key}" is set to null in ${sourceLabel}, which opts this repository out of that defaults-file section`,
        );
      }
      const invalid = validateSettingsDoc(settings, sourceLabel, cfg.onlySections, io);
      if (invalid) {
        failTarget(invalid);
        continue;
      }

      const run = await runForRepo(
        api,
        {
          repo: target.slug,
          settings,
          mode: cfg.mode,
          onMissingPermission: cfg.onMissingPermission,
          requiredSections: cfg.requiredSections,
          onlySections: cfg.onlySections,
          label: `${target.slug}: `,
        },
        io,
      );
      let note: string | undefined;
      if (run.preflightDenied.length > 0) {
        note = `preflight denied ${run.preflightDenied.length} section(s); nothing was applied to this repository`;
        io.annotate(
          "error",
          `${target.slug}: preflight failed: the token cannot access ${run.preflightDenied.length} section(s), so nothing was applied to this repository. Grant the permissions named above, or set on-missing-permission: warn`,
        );
      }
      results.push({
        slug: target.slug,
        source: target.source,
        origin: target.origin,
        result: run.result,
        outcomes: run.outcomes,
        skippedSections: run.skippedSections,
        note,
      });
    } catch (error) {
      // One repo's unexpected crash never stops the rest of the fleet.
      const message = error instanceof Error ? error.message : String(error);
      failTarget(message);
    }
  }
  return { fatal: null, targets: results };
}

export async function run(overrides?: { api?: GithubApi }): Promise<number> {
  const fail = (message: string): number => {
    annotate("error", message);
    setOutput("result", "failed");
    return 1;
  };
  const io: Io = { annotate, log: (line) => console.log(line) };

  const token = input("token") || process.env.GITHUB_TOKEN || "";
  if (!token) {
    return fail(
      'cannot call the GitHub API: no token was provided. Set the "token" input on the action step (or export GITHUB_TOKEN)',
    );
  }
  const mode = input("mode") || "apply";
  if (mode !== "apply" && mode !== "check") {
    return fail(
      `the "mode" input is "${mode}", which is not a supported mode. Set it to "apply" (mutate settings) or "check" (report drift only)`,
    );
  }
  const onMissingPermission = input("on-missing-permission") || "fail";
  if (onMissingPermission !== "fail" && onMissingPermission !== "warn") {
    return fail(
      `the "on-missing-permission" input is "${onMissingPermission}", which is not a supported policy. Set it to "fail" (default) or "warn" (skip sections the token cannot touch)`,
    );
  }
  const requiredSections = new Set(
    input("required-sections")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const onlySections = new Set(
    input("sections")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const knownSections = new Set<string>(SECTION_KEYS);
  for (const name of [...requiredSections, ...onlySections]) {
    if (!knownSections.has(name)) {
      return fail(
        `unknown section "${name}" in the "sections" or "required-sections" input; it matches none of: ${SECTION_KEYS.join(", ")}. Fix the name in the workflow's input list`,
      );
    }
  }
  const apiVersion = input("api-version") || "2022-11-28";
  const api = overrides?.api ?? new GithubApi(token, undefined, apiVersion);

  const reposInput = input("repos");
  const reposDir = input("repos-dir");
  const defaultsFile = input("defaults-file");
  const settingsFile = input("settings-file") || ".github/settings.yml";

  if (reposInput || reposDir) {
    // Multi-repo mode: the single-repo inputs make no sense here.
    if (input("repository")) {
      return fail(
        'the "repository" input cannot be combined with "repos" or "repos-dir"; multi-repo targets come from those inputs. Remove "repository", or remove the multi-repo inputs to stay in single-repo mode',
      );
    }
    if (settingsFile !== ".github/settings.yml") {
      return fail(
        'the "settings-file" input cannot be combined with "repos" or "repos-dir": central targets are read from repos-dir files and remote targets from each repository\'s own .github/settings.yml. Remove the settings-file override',
      );
    }
    const adminOwner = (process.env.GITHUB_REPOSITORY ?? "").split("/")[0] ?? "";
    const { fatal, targets } = await runMulti(
      api,
      {
        reposDir,
        reposInput,
        defaultsFile,
        adminOwner,
        mode,
        onMissingPermission,
        requiredSections,
        onlySections,
      },
      io,
    );
    if (fatal) {
      return fail(fatal);
    }
    writeMultiSummary(targets, mode);
    setOutput(
      "repos-result",
      JSON.stringify(
        Object.fromEntries(
          targets.map((t) => [
            t.slug,
            { result: t.result, source: t.source, skippedSections: t.skippedSections },
          ]),
        ),
      ),
    );
    setOutput(
      "skipped-sections",
      [...new Set(targets.flatMap((t) => t.skippedSections))].join(","),
    );
    const overall = worstOf(targets, mode === "check");
    setOutput("result", overall);
    console.log(`result: ${overall}`);
    const anyFailed = targets.some((t) => t.result === "failed");
    const anyDrift = targets.some((t) => t.result === "drift");
    return anyFailed || (mode === "check" && anyDrift) ? 1 : 0;
  }

  // Single-repo mode (unchanged legacy behavior).
  const repo = input("repository") || process.env.GITHUB_REPOSITORY || "";
  if (!SLUG_RE.test(repo)) {
    return fail(
      `cannot target a repository: "${repo}" is not an owner/name slug. Set the "repository" input (or GITHUB_REPOSITORY) to a value like "octocat/hello-world"`,
    );
  }
  let settings: SettingsFile;
  try {
    settings = (parseYaml(readFileSync(settingsFile, "utf8")) ?? {}) as SettingsFile;
  } catch (error) {
    return fail(
      `cannot read settings from ${settingsFile}: ${String(error)}. Check that the file exists at that path (set the "settings-file" input if it lives elsewhere) and is valid YAML`,
    );
  }
  const invalid = validateSettingsDoc(settings, settingsFile, onlySections, io);
  if (invalid) {
    return fail(invalid);
  }

  const result = await runForRepo(
    api,
    { repo, settings, mode, onMissingPermission, requiredSections, onlySections, label: "" },
    io,
  );
  if (result.preflightDenied.length > 0) {
    return fail(
      `preflight failed: the token cannot access ${result.preflightDenied.length} section(s), so nothing was applied. Grant the permissions named above, or set on-missing-permission: warn to skip those sections`,
    );
  }

  writeSummary(result.outcomes, mode);
  setOutput("skipped-sections", result.skippedSections.join(","));

  if (result.result === "failed") {
    setOutput("result", "failed");
    return 1;
  }
  setOutput("result", result.result);
  console.log(`result: ${result.result}`);
  return result.result === "drift" ? 1 : 0;
}

const invokedDirectly =
  process.argv[1]?.endsWith("main.ts") || process.argv[1]?.endsWith("index.js");
if (invokedDirectly) {
  run().then(
    (code) => process.exit(code),
    (error) => {
      annotate(
        "error",
        `repo-settings-as-code stopped unexpectedly: ${String(error)}. Re-run the workflow; if it recurs, report a bug with this log attached`,
      );
      process.exit(1);
    },
  );
}
