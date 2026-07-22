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
import { GithubApi, type GithubClient } from "../github/api.js";
import { parseConfig } from "./inputs.js";
import { actionsIo, annotate, setOutput } from "./io.js";
import { runMulti } from "./multi.js";
import { readSettingsFile } from "./settings-read.js";
import { writeMultiSummary, writeSummary } from "./summary.js";

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
    writeMultiSummary(targets, cfg.mode);
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
    const overall = worstOf(targets, cfg.mode === "check");
    setOutput("result", overall);
    console.log(`result: ${overall}`);
    // The exit code follows the same worst-of ranking the output reports.
    return overall === "failed" || (cfg.mode === "check" && overall === "drift") ? 1 : 0;
  }

  // Single-repo mode (unchanged legacy behavior).
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
    io,
  );
  if (result.preflightDenied.length > 0) {
    return fail(
      `preflight failed: the token cannot access ${result.preflightDenied.length} section(s), so nothing was applied. Grant the permissions named above, or set on-missing-permission: warn to skip those sections`,
    );
  }

  writeSummary(result.outcomes, cfg.mode);
  setOutput("skipped-sections", result.skippedSections.join(","));

  if (result.result === "failed") {
    setOutput("result", "failed");
    return 1;
  }
  setOutput("result", result.result);
  console.log(`result: ${result.result}`);
  return result.result === "drift" ? 1 : 0;
}
