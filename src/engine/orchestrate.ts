/**
 * Per-repository orchestration: the section pipeline (active-section
 * filter, preflight barrier, section loop) extracted from run() so the
 * same engine drives one repo (legacy mode) or many (multi-repo mode).
 * All output goes through the Io sink; `label` prefixes every line in
 * multi-repo mode ("" in single-repo mode keeps output byte-identical).
 */

import type { GithubClient } from "../github/api.js";
import type { Io } from "../io.js";
import { SECTION_KEYS, type SettingsFile } from "../schema.js";
import { PermissionDenied, type SectionContext, type SectionResult } from "../sections/contract.js";
import { SECTIONS } from "../sections/registry.js";
import { validateSectionShapes } from "./validate.js";

export interface SectionOutcome {
  key: string;
  status: "applied" | "clean" | "drift" | "skipped" | "excluded" | "failed";
  detail: string[];
}

export interface RepoRunOptions {
  repo: string; // owner/name
  settings: SettingsFile;
  mode: "apply" | "check";
  onMissingPermission: "fail" | "warn";
  requiredSections: Set<string>;
  onlySections: Set<string>;
  /** "" in single-repo mode; "owner/name: " in multi-repo mode. */
  label: string;
}

export type RepoResult = "applied" | "partial" | "clean" | "drift" | "failed" | "skipped";

/**
 * Every RepoResult value, in the worst-first ranking worstOf() applies.
 * The single source for the aggregate ranking and for the action.yml
 * `result` output docs (the contract test imports this). The satisfies
 * clause and the exhaustiveness check below keep it locked to RepoResult:
 * a new result value that is not listed here fails to compile.
 */
export const REPO_RESULTS = [
  "failed",
  "drift",
  "partial",
  "skipped",
  "applied",
  "clean",
] as const satisfies readonly RepoResult[];

/** Compile-time lockstep: a RepoResult value missing from REPO_RESULTS fails here. */
type MustBeNever<T extends never> = T;
type _UnlistedResult = MustBeNever<Exclude<RepoResult, (typeof REPO_RESULTS)[number]>>;

export interface RepoRunResult {
  repo: string;
  result: RepoResult;
  outcomes: SectionOutcome[];
  skippedSections: string[];
  /** Non-empty when the preflight barrier refused to write anything. */
  preflightDenied: string[];
}

/**
 * Top-level shape validation for one settings document (the unknown-key
 * policy from run()). Returns an error message (caller fails the run or
 * the repo) or null; the sections-allowlist case downgrades to a warning.
 * `sourceLabel` names the file the message points at.
 */
export function validateSettingsDoc(
  settings: unknown,
  sourceLabel: string,
  onlySections: Set<string>,
  io: Io,
): string | null {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    return `${sourceLabel} must be a YAML mapping of section names to settings, but its top level parsed as ${Array.isArray(settings) ? "a list" : `a ${settings === null ? "null" : typeof settings}`}. Rewrite the top level as "section: ..." keys`;
  }
  const knownSections = new Set<string>(SECTION_KEYS);
  // A misspelled section silently doing nothing would violate the loud-
  // failure promise; unknown top-level keys are hard errors (prefix custom
  // keys with underscore to keep private notes in the file).
  const unknownKeys = Object.keys(settings).filter(
    (key) => !knownSections.has(key) && !key.startsWith("_"),
  );
  if (unknownKeys.length === 0) {
    return validateSectionShapes(settings as Record<string, unknown>, sourceLabel);
  }
  if (onlySections.size > 0 && unknownKeys.every((key) => !onlySections.has(key))) {
    // A `sections` allowlist lets an older action version coexist with a
    // config written for a newer one: unknown keys OUTSIDE the allowlist
    // are warnings, not errors.
    io.annotate(
      "warning",
      `ignoring unknown top-level section(s) outside the "sections" allowlist: ${unknownKeys.join(", ")}. Upgrade the action to a version that knows them, or remove them from ${sourceLabel}`,
    );
    return validateSectionShapes(settings as Record<string, unknown>, sourceLabel);
  }
  return `unknown top-level section(s) in ${sourceLabel}: ${unknownKeys.join(", ")} (known: ${SECTION_KEYS.join(", ")}). Fix the typo, or prefix private keys with "_", or set the "sections" input to limit processing`;
}

/** Run the full section pipeline against one repository. */
export async function runForRepo(
  api: GithubClient,
  opts: RepoRunOptions,
  io: Io,
): Promise<RepoRunResult> {
  const [owner] = opts.repo.split("/");
  const ctx: SectionContext = {
    api,
    repo: opts.repo,
    owner: owner ?? "",
    check: opts.mode === "check",
  };
  const L = opts.label;
  const settings = opts.settings;

  const active = SECTIONS.filter((section) => {
    if (settings[section.key as keyof SettingsFile] === undefined) {
      return false;
    }
    return opts.onlySections.size === 0 || opts.onlySections.has(section.key);
  });

  // Preflight barrier: the API has no transactions, so a mid-apply
  // permission failure would leave settings half-applied. Under the strict
  // policy, probe every declared section read-only FIRST and refuse to
  // write anything when any of them is inaccessible. (A token with read
  // but not write access can still fail mid-apply; the engine is
  // idempotent, so re-running after fixing the token converges.)
  if (!ctx.check && opts.onMissingPermission === "fail") {
    // Belt over the check-is-read-only convention: the probe client refuses
    // every non-GET, so a handler that (wrongly) mutated under check cannot
    // touch the repo during preflight. The thrown error is ignored below
    // like any other non-permission error; the apply pass surfaces the bug.
    const probeApi: GithubClient = {
      tryRequest(method, path, payload, options) {
        if (method !== "GET") {
          throw new Error(
            `preflight probe attempted ${method} ${path}, but section handlers must be read-only in check mode; this is a bug in the section handler`,
          );
        }
        return api.tryRequest(method, path, payload, options);
      },
    };
    const denied: string[] = [];
    for (const section of active) {
      try {
        await section.run(
          { ...ctx, api: probeApi, check: true },
          settings[section.key as keyof SettingsFile],
        );
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
        io.annotate("error", `${L}preflight: ${line}`);
      }
      return {
        repo: opts.repo,
        result: "failed",
        outcomes: [],
        skippedSections: [],
        preflightDenied: denied,
      };
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
    if (opts.onlySections.size > 0 && !opts.onlySections.has(section.key)) {
      outcomes.push({ key: section.key, status: "excluded", detail: ["excluded by `sections`"] });
      continue;
    }
    let result: SectionResult;
    try {
      result = await section.run(ctx, desired);
    } catch (error) {
      if (error instanceof PermissionDenied) {
        const required = opts.requiredSections.has(section.key);
        if (opts.onMissingPermission === "warn" && !required) {
          io.annotate("warning", `${L}${section.key}: skipped - ${error.detail}`);
          outcomes.push({ key: section.key, status: "skipped", detail: [error.detail] });
          partial = true;
          continue;
        }
        io.annotate(
          "error",
          `${L}${section.key}: not applied${required ? " (listed in required-sections, so this fails the run)" : ""} - ${error.detail}`,
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
      io.annotate("error", `${L}${annotated}`);
      outcomes.push({ key: section.key, status: "failed", detail: [annotated] });
      failed = true;
      continue;
    }
    for (const note of result.notes) {
      io.annotate("notice", `${L}${section.key}: ${note}`);
    }
    if (ctx.check) {
      if (result.drift.length > 0) {
        drifted = true;
        for (const line of result.drift) {
          io.log(`${L}drift: ${line}`);
        }
        outcomes.push({ key: section.key, status: "drift", detail: result.drift });
      } else {
        outcomes.push({ key: section.key, status: "clean", detail: result.notes });
      }
    } else {
      for (const line of result.changes) {
        io.log(`${L}${section.key}: ${line}`);
      }
      outcomes.push({
        key: section.key,
        status: "applied",
        detail: result.changes.length > 0 ? result.changes : ["no changes needed"],
      });
    }
  }

  const result: RepoResult = failed
    ? "failed"
    : ctx.check
      ? drifted
        ? "drift"
        : partial
          ? "partial"
          : "clean"
      : partial
        ? "partial"
        : "applied";

  return {
    repo: opts.repo,
    result,
    outcomes,
    skippedSections: outcomes.filter((o) => o.status === "skipped").map((o) => o.key),
    preflightDenied: [],
  };
}

/** Aggregate result across targets: the worst outcome wins. */
export function worstOf(results: Array<{ result: RepoResult }>, check: boolean): RepoResult {
  for (const rank of REPO_RESULTS) {
    if (results.some((r) => r.result === rank)) {
      return rank;
    }
  }
  return check ? "clean" : "applied";
}
