/**
 * settings-as-code: apply a declarative .github/settings.yml to the repo.
 *
 * Policy model:
 * - mode: apply (default) mutates; check reports drift and exits 1 on any.
 * - on-missing-permission: fail (default) | warn. Under warn, a section the
 *   token cannot touch is skipped with a warning and the run stays green
 *   (partial success) - unless the section is listed in required-sections.
 * - Non-permission errors always fail, loudly, with the API message.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { GithubApi } from "./api.js";
import { SECTION_KEYS, type SettingsFile } from "./schema.js";
import { branchesSection } from "./sections/branches.js";
import { labelsSection } from "./sections/labels.js";
import {
  actionsSection,
  autolinksSection,
  collaboratorsSection,
  environmentsSection,
  milestonesSection,
  pagesSection,
  teamsSection,
} from "./sections/misc.js";
import { repositorySection } from "./sections/repository.js";
import { rulesetsSection } from "./sections/rulesets.js";
import {
  PermissionDenied,
  type Section,
  type SectionContext,
  type SectionResult,
} from "./sections/section.js";

const SECTIONS: Section[] = [
  repositorySection,
  labelsSection,
  rulesetsSection,
  branchesSection,
  environmentsSection,
  autolinksSection,
  actionsSection,
  pagesSection,
  collaboratorsSection,
  teamsSection,
  milestonesSection,
];

interface SectionOutcome {
  key: string;
  status: "applied" | "clean" | "drift" | "skipped" | "excluded" | "failed";
  detail: string[];
}

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

function writeSummary(outcomes: SectionOutcome[], mode: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) {
    return;
  }
  const icon: Record<SectionOutcome["status"], string> = {
    applied: "white_check_mark",
    clean: "white_check_mark",
    drift: "warning",
    skipped: "fast_forward",
    excluded: "fast_forward",
    failed: "x",
  };
  const lines = [
    `## settings-as-code (${mode})`,
    "",
    "| Section | Status | Detail |",
    "|---|---|---|",
  ];
  for (const outcome of outcomes) {
    const detail =
      outcome.detail
        // Escape the escape character first, then the table delimiter.
        .map((line) => line.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " "))
        .join("<br>") || "-";
    lines.push(`| ${outcome.key} | :${icon[outcome.status]}: ${outcome.status} | ${detail} |`);
  }
  appendFileSync(file, `${lines.join("\n")}\n`);
}

export async function run(): Promise<number> {
  const fail = (message: string): number => {
    annotate("error", message);
    setOutput("result", "failed");
    return 1;
  };
  const token = input("token") || process.env.GITHUB_TOKEN || "";
  if (!token) {
    return fail("no token: set the `token` input");
  }
  const repo = input("repository") || process.env.GITHUB_REPOSITORY || "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return fail(`invalid repository "${repo}"`);
  }
  const settingsFile = input("settings-file") || ".github/settings.yml";
  const mode = input("mode") || "apply";
  if (mode !== "apply" && mode !== "check") {
    return fail(`mode must be "apply" or "check", got "${mode}"`);
  }
  const onMissingPermission = input("on-missing-permission") || "fail";
  if (onMissingPermission !== "fail" && onMissingPermission !== "warn") {
    return fail(`on-missing-permission must be "fail" or "warn"`);
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
      return fail(`unknown section "${name}" in inputs (known: ${SECTION_KEYS.join(", ")})`);
    }
  }

  let settings: SettingsFile;
  try {
    settings = (parseYaml(readFileSync(settingsFile, "utf8")) ?? {}) as SettingsFile;
  } catch (error) {
    return fail(`cannot read ${settingsFile}: ${String(error)}`);
  }
  if (typeof settings !== "object" || Array.isArray(settings)) {
    return fail(`${settingsFile} must be a YAML mapping`);
  }
  // A misspelled section silently doing nothing would violate the loud-
  // failure promise; unknown top-level keys are hard errors (prefix custom
  // keys with underscore to keep private notes in the file).
  const unknownKeys = Object.keys(settings).filter(
    (key) => !knownSections.has(key) && !key.startsWith("_"),
  );
  if (unknownKeys.length > 0) {
    return fail(
      `unknown top-level section(s) in ${settingsFile}: ${unknownKeys.join(", ")} (known: ${SECTION_KEYS.join(", ")})`,
    );
  }

  const [owner] = repo.split("/");
  const ctx: SectionContext = {
    api: new GithubApi(token),
    repo,
    owner: owner ?? "",
    check: mode === "check",
  };

  const outcomes: SectionOutcome[] = [];
  let failed = false;
  let partial = false;
  let drifted = false;

  for (const section of SECTIONS) {
    const desired = settings[section.key as keyof SettingsFile];
    if (desired === undefined) {
      continue; // declared-keys-only: absent section = untouched
    }
    if (onlySections.size > 0 && !onlySections.has(section.key)) {
      outcomes.push({ key: section.key, status: "excluded", detail: ["excluded by `sections`"] });
      continue;
    }
    let result: SectionResult;
    try {
      result = await section.run(ctx, desired);
    } catch (error) {
      if (error instanceof PermissionDenied) {
        const required = requiredSections.has(section.key);
        if (onMissingPermission === "warn" && !required) {
          annotate("warning", `${section.key}: skipped - ${error.detail}`);
          outcomes.push({ key: section.key, status: "skipped", detail: [error.detail] });
          partial = true;
          continue;
        }
        const hint = error.detail.includes(" 404 ")
          ? "token lacks permission or the resource does not exist"
          : "token lacks permission";
        annotate(
          "error",
          `${section.key}: ${hint}${required ? " (required section)" : ""} - ${error.detail}`,
        );
        outcomes.push({ key: section.key, status: "failed", detail: [error.detail] });
        failed = true;
        continue;
      }
      annotate("error", String(error));
      outcomes.push({ key: section.key, status: "failed", detail: [String(error)] });
      failed = true;
      continue;
    }
    for (const note of result.notes) {
      annotate("notice", `${section.key}: ${note}`);
    }
    if (ctx.check) {
      if (result.drift.length > 0) {
        drifted = true;
        for (const line of result.drift) {
          console.log(`drift: ${line}`);
        }
        outcomes.push({ key: section.key, status: "drift", detail: result.drift });
      } else {
        outcomes.push({ key: section.key, status: "clean", detail: result.notes });
      }
    } else {
      for (const line of result.changes) {
        console.log(`${section.key}: ${line}`);
      }
      outcomes.push({
        key: section.key,
        status: "applied",
        detail: result.changes.length > 0 ? result.changes : ["no changes needed"],
      });
    }
  }

  writeSummary(outcomes, mode);
  setOutput(
    "skipped-sections",
    outcomes
      .filter((o) => o.status === "skipped")
      .map((o) => o.key)
      .join(","),
  );

  if (failed) {
    setOutput("result", "failed");
    return 1;
  }
  if (ctx.check) {
    // A check that could not see everything is never "clean".
    const result = drifted ? "drift" : partial ? "partial" : "clean";
    setOutput("result", result);
    console.log(`result: ${result}`);
    return drifted ? 1 : 0;
  }
  const result = partial ? "partial" : "applied";
  setOutput("result", result);
  console.log(`result: ${result}`);
  return 0;
}

const invokedDirectly =
  process.argv[1]?.endsWith("main.ts") || process.argv[1]?.endsWith("index.js");
if (invokedDirectly) {
  run().then(
    (code) => process.exit(code),
    (error) => {
      annotate("error", String(error));
      process.exit(1);
    },
  );
}
