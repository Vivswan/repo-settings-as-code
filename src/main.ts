/**
 * repo-settings-as-code: apply a declarative .github/settings.yml to the repo.
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
    `## repo-settings-as-code (${mode})`,
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
    return fail(
      'cannot call the GitHub API: no token was provided. Set the "token" input on the action step (or export GITHUB_TOKEN)',
    );
  }
  const repo = input("repository") || process.env.GITHUB_REPOSITORY || "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return fail(
      `cannot target a repository: "${repo}" is not an owner/name slug. Set the "repository" input (or GITHUB_REPOSITORY) to a value like "octocat/hello-world"`,
    );
  }
  const settingsFile = input("settings-file") || ".github/settings.yml";
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

  let settings: SettingsFile;
  try {
    settings = (parseYaml(readFileSync(settingsFile, "utf8")) ?? {}) as SettingsFile;
  } catch (error) {
    return fail(
      `cannot read settings from ${settingsFile}: ${String(error)}. Check that the file exists at that path (set the "settings-file" input if it lives elsewhere) and is valid YAML`,
    );
  }
  if (typeof settings !== "object" || Array.isArray(settings)) {
    return fail(
      `${settingsFile} must be a YAML mapping of section names to settings, but its top level parsed as ${Array.isArray(settings) ? "a list" : `a ${typeof settings}`}. Rewrite the top level as "section: ..." keys`,
    );
  }
  // A misspelled section silently doing nothing would violate the loud-
  // failure promise; unknown top-level keys are hard errors (prefix custom
  // keys with underscore to keep private notes in the file).
  const unknownKeys = Object.keys(settings).filter(
    (key) => !knownSections.has(key) && !key.startsWith("_"),
  );
  if (unknownKeys.length > 0) {
    if (onlySections.size > 0 && unknownKeys.every((key) => !onlySections.has(key))) {
      // A `sections` allowlist lets an older action version coexist with a
      // config written for a newer one: unknown keys OUTSIDE the allowlist
      // are warnings, not errors.
      annotate(
        "warning",
        `ignoring unknown top-level section(s) outside the "sections" allowlist: ${unknownKeys.join(", ")}. Upgrade the action to a version that knows them, or remove them from ${settingsFile}`,
      );
    } else {
      return fail(
        `unknown top-level section(s) in ${settingsFile}: ${unknownKeys.join(", ")} (known: ${SECTION_KEYS.join(", ")}). Fix the typo, or prefix private keys with "_", or set the "sections" input to limit processing`,
      );
    }
  }

  const apiVersion = input("api-version") || "2022-11-28";
  const [owner] = repo.split("/");
  const ctx: SectionContext = {
    api: new GithubApi(token, undefined, apiVersion),
    repo,
    owner: owner ?? "",
    check: mode === "check",
  };

  const active = SECTIONS.filter((section) => {
    if (settings[section.key as keyof SettingsFile] === undefined) {
      return false;
    }
    return onlySections.size === 0 || onlySections.has(section.key);
  });

  // Preflight barrier: the API has no transactions, so a mid-apply
  // permission failure would leave settings half-applied. Under the strict
  // policy, probe every declared section read-only FIRST and refuse to
  // write anything when any of them is inaccessible. (A token with read
  // but not write access can still fail mid-apply; the engine is
  // idempotent, so re-running after fixing the token converges.)
  if (!ctx.check && onMissingPermission === "fail") {
    const denied: string[] = [];
    for (const section of active) {
      try {
        await section.run({ ...ctx, check: true }, settings[section.key as keyof SettingsFile]);
      } catch (error) {
        if (error instanceof PermissionDenied) {
          denied.push(`${section.key}: ${error.detail}`);
        }
        // Non-permission preflight errors are ignored here; the apply pass
        // will surface them with full context.
      }
    }
    if (denied.length > 0) {
      for (const line of denied) {
        annotate("error", `preflight: ${line}`);
      }
      return fail(
        `preflight failed: the token cannot access ${denied.length} section(s), so nothing was applied. Grant the permissions named above, or set on-missing-permission: warn to skip those sections`,
      );
    }
  }

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
        annotate(
          "error",
          `${section.key}: not applied${required ? " (listed in required-sections, so this fails the run)" : ""} - ${error.detail}`,
        );
        outcomes.push({ key: section.key, status: "failed", detail: [error.detail] });
        failed = true;
        continue;
      }
      // throwFor()-raised errors already carry section, cause, and fix;
      // prefix anything else so the failing section is still named.
      const message = error instanceof Error ? error.message : String(error);
      const annotated = message.startsWith(`${section.key}:`)
        ? message
        : `${section.key}: ${message}`;
      annotate("error", annotated);
      outcomes.push({ key: section.key, status: "failed", detail: [annotated] });
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
      annotate(
        "error",
        `repo-settings-as-code stopped unexpectedly: ${String(error)}. Re-run the workflow; if it recurs, report a bug with this log attached`,
      );
      process.exit(1);
    },
  );
}
