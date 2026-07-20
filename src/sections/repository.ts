/**
 * `repository:` section - PATCH passthrough for repo fields, plus the three
 * settings that live on their own endpoints in the REST API even though the
 * Probot schema nests them here: topics, vulnerability alerts, automated
 * security fixes.
 */

import { subsetDiff } from "../diff.js";
import { normalizeTopics } from "../normalize.js";
import { call, emptyResult, type Section, type SectionResult, throwFor } from "./section.js";

const SPECIAL_KEYS = new Set([
  "topics",
  "enable_vulnerability_alerts",
  "enable_automated_security_fixes",
]);

export const repositorySection: Section = {
  key: "repository",
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const desired = desiredRaw as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(desired)) {
      if (!SPECIAL_KEYS.has(key)) {
        patch[key] = value;
      }
    }

    if (ctx.check) {
      const live = (await call(ctx, this.key, "GET", `/repos/${ctx.repo}`)) as Record<
        string,
        unknown
      >;
      result.drift.push(...subsetDiff(patch, live, "repository"));
      if ("topics" in desired) {
        result.drift.push(
          ...subsetDiff(
            normalizeTopics(desired.topics).sort(),
            ((live.topics as string[]) ?? []).slice().sort(),
            "repository.topics",
          ),
        );
      }
      if ("enable_vulnerability_alerts" in desired) {
        const probe = await ctx.api.tryRequest("GET", `/repos/${ctx.repo}/vulnerability-alerts`);
        if ("error" in probe && probe.error.status !== 404) {
          throwFor(this.key, "GET", `/repos/${ctx.repo}/vulnerability-alerts`, probe.error);
        }
        const enabled = !("error" in probe);
        if (enabled !== Boolean(desired.enable_vulnerability_alerts)) {
          result.drift.push(
            `repository.enable_vulnerability_alerts: declared ${desired.enable_vulnerability_alerts} != live ${enabled}; apply will set the declared value`,
          );
        }
      }
      if ("enable_automated_security_fixes" in desired) {
        const probe = await ctx.api.tryRequest(
          "GET",
          `/repos/${ctx.repo}/automated-security-fixes`,
        );
        if ("error" in probe && probe.error.status !== 404) {
          throwFor(this.key, "GET", `/repos/${ctx.repo}/automated-security-fixes`, probe.error);
        }
        // A 204 empty body means enabled; a JSON body carries {enabled}.
        const enabled =
          !("error" in probe) &&
          (probe.data === null || (probe.data as { enabled?: boolean })?.enabled !== false);
        if (enabled !== Boolean(desired.enable_automated_security_fixes)) {
          result.drift.push(
            `repository.enable_automated_security_fixes: declared ${desired.enable_automated_security_fixes} != live ${enabled}; apply will set the declared value`,
          );
        }
      }
      return result;
    }

    if (Object.keys(patch).length > 0) {
      await call(ctx, this.key, "PATCH", `/repos/${ctx.repo}`, patch);
      result.changes.push(`patched repository fields: ${Object.keys(patch).join(", ")}`);
    }
    if ("topics" in desired) {
      const names = normalizeTopics(desired.topics);
      await call(ctx, this.key, "PUT", `/repos/${ctx.repo}/topics`, { names });
      result.changes.push(`set topics: ${names.join(", ") || "(none)"}`);
    }
    if ("enable_vulnerability_alerts" in desired) {
      const method = desired.enable_vulnerability_alerts ? "PUT" : "DELETE";
      await call(ctx, this.key, method, `/repos/${ctx.repo}/vulnerability-alerts`);
      result.changes.push(`vulnerability alerts: ${method === "PUT" ? "enabled" : "disabled"}`);
    }
    if ("enable_automated_security_fixes" in desired) {
      const method = desired.enable_automated_security_fixes ? "PUT" : "DELETE";
      await call(ctx, this.key, method, `/repos/${ctx.repo}/automated-security-fixes`);
      result.changes.push(`automated security fixes: ${method === "PUT" ? "enabled" : "disabled"}`);
    }
    return result;
  },
};
