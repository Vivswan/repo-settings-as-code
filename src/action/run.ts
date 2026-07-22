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

import { runForRepo, validateSettingsDoc, worstOf } from "../engine/orchestrate.js";
import { GithubApi, type GithubClient, registerRedactedSlug } from "../github/api.js";
import { createVisibilityResolver } from "../github/repo-visibility.js";
import { parseConfig } from "./inputs.js";
import { actionsIo, annotate, setOutput } from "./io.js";
import { runMulti, toPublicView } from "./multi.js";
import { capturingIo, REDACTED_NOTE } from "./redact.js";
import { readSettingsFile } from "./settings-read.js";
import { writeMultiSummary, writeRedactedSummary, writeSummary } from "./summary.js";

/** Execute the action; returns the process exit code. */
export async function run(overrides?: { api?: GithubClient }): Promise<number> {
  const fail = (message: string): number => {
    annotate("error", message);
    setOutput("result", "failed");
    return 1;
  };
  const io = actionsIo;

  const parsed = parseConfig();
  if ("error" in parsed) {
    return fail(parsed.error);
  }
  const cfg = parsed.config;
  const api = overrides?.api ?? new GithubApi(cfg.token, undefined, cfg.apiVersion);

  if (cfg.kind === "multi") {
    const { fatal, targets } = await runMulti(api, cfg, io);
    if (fatal) {
      return fail(fatal);
    }
    // The public view strips private detail and keys by the display label,
    // so nothing written past this point can carry a redacted slug.
    const views = targets.map(toPublicView);
    writeMultiSummary(views, cfg.mode);
    setOutput(
      "repos-result",
      JSON.stringify(
        Object.fromEntries(
          views.map((v) => [
            v.display,
            { result: v.result, source: v.source, skippedSections: v.skippedSections },
          ]),
        ),
      ),
    );
    setOutput("skipped-sections", [...new Set(views.flatMap((v) => v.skippedSections))].join(","));
    const overall = worstOf(views, cfg.mode === "check");
    setOutput("result", overall);
    console.log(`result: ${overall}`);
    // The exit code follows the same worst-of ranking the output reports.
    return overall === "failed" || (cfg.mode === "check" && overall === "drift") ? 1 : 0;
  }

  // Single-repo mode. The settings file is local and operator-authored, so
  // read/parse/validate errors name only the local path and never redact.
  // Only the engine's live-value output and the fail/preflight annotations
  // can carry the private target's state, so those are redacted when the
  // target is a different, non-public repository.
  const read = readSettingsFile(cfg.settingsFile);
  if ("error" in read) {
    return fail(
      `cannot read settings from ${cfg.settingsFile}: ${read.error}. Check that the file exists at that path (set the "settings-file" input if it lives elsewhere) and is valid YAML`,
    );
  }
  const settings = read.settings;
  const invalid = validateSettingsDoc(settings, cfg.settingsFile, cfg.onlySections, io);
  if (invalid) {
    return fail(invalid);
  }

  const isSelf = cfg.repo.toLowerCase() === cfg.selfSlug.toLowerCase();
  let redacted = false;
  if (cfg.privateRepos === "redact" && !isSelf) {
    const visibility = await createVisibilityResolver(api)(cfg.repo);
    redacted = visibility !== "public";
    if (redacted) {
      io.mask(cfg.repo);
      registerRedactedSlug(cfg.repo);
    }
  }

  const result = await runForRepo(
    api,
    {
      repo: cfg.repo,
      settings,
      mode: cfg.mode,
      onMissingPermission: cfg.onMissingPermission,
      requiredSections: cfg.requiredSections,
      onlySections: cfg.onlySections,
    },
    redacted ? capturingIo(io).io : io,
  );
  if (result.preflightDenied.length > 0) {
    return fail(
      redacted
        ? `preflight failed. ${REDACTED_NOTE}`
        : `preflight failed: the token cannot access ${result.preflightDenied.length} section(s), so nothing was applied. Grant the permissions named above, or set on-missing-permission: warn to skip those sections`,
    );
  }

  if (redacted) {
    writeRedactedSummary(result.outcomes, cfg.mode, result.result);
  } else {
    writeSummary(result.outcomes, cfg.mode);
  }
  setOutput("skipped-sections", result.skippedSections.join(","));

  if (result.result === "failed") {
    if (redacted) {
      annotate("error", `failed. ${REDACTED_NOTE}`);
    }
    setOutput("result", "failed");
    return 1;
  }
  setOutput("result", result.result);
  console.log(`result: ${result.result}`);
  return result.result === "drift" ? 1 : 0;
}
