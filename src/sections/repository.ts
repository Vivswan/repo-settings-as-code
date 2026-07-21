/**
 * `repository:` section - PATCH passthrough for repo fields, plus the
 * settings that live on their own endpoints in the REST API even though
 * the Probot schema nests them here: topics and the security toggles.
 */

import { subsetDiff } from "../diff.js";
import {
  anyRecord,
  call,
  emptyResult,
  probeAbsent,
  type SectionModule,
  type SectionResult,
  tryCall,
} from "./contract.js";

/** Topics: accept a comma-separated string or an array; lowercase, dedupe. */
export function normalizeTopics(raw: unknown): string[] {
  const values = Array.isArray(raw)
    ? raw.map(String)
    : String(raw ?? "")
        .split(",")
        .map((t) => t.trim());
  return [...new Set(values.map((t) => t.toLowerCase()).filter(Boolean))];
}

interface SecurityToggle {
  key: string;
  path: string;
  label: string;
  /** GET statuses meaning "not enabled" rather than a failure. */
  tolerate: number[];
  /** Read the enabled state from a successful GET. */
  isEnabled: (data: unknown) => boolean;
  /** DELETE statuses meaning "already off or not applicable here". */
  tolerateOnDisable: number[];
}

const SECURITY_TOGGLES: SecurityToggle[] = [
  {
    key: "enable_vulnerability_alerts",
    path: "vulnerability-alerts",
    label: "vulnerability alerts",
    tolerate: [404],
    // A 204 empty body means enabled.
    isEnabled: () => true,
    tolerateOnDisable: [],
  },
  {
    key: "enable_automated_security_fixes",
    path: "automated-security-fixes",
    label: "automated security fixes",
    tolerate: [404],
    // A 204 empty body means enabled; a JSON body carries {enabled}.
    isEnabled: (data) => data === null || (data as { enabled?: boolean })?.enabled !== false,
    tolerateOnDisable: [],
  },
  {
    key: "enable_private_vulnerability_reporting",
    path: "private-vulnerability-reporting",
    label: "private vulnerability reporting",
    // Repositories where the feature does not apply (observed: private
    // repos) answer 404 or 422 instead of 200 + {enabled}.
    tolerate: [404, 422],
    isEnabled: (data) => (data as { enabled?: boolean } | null)?.enabled === true,
    tolerateOnDisable: [404, 422],
  },
];

const SPECIAL_KEYS = new Set(["topics", ...SECURITY_TOGGLES.map((toggle) => toggle.key)]);

export const repositorySection: SectionModule<"repository"> = {
  key: "repository",
  grant: `grant "Administration" (read and write) under the PAT's Repository permissions`,
  shape: anyRecord,
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const desired = desiredRaw as Record<string, unknown>;
    for (const toggle of SECURITY_TOGGLES) {
      if (toggle.key in desired && typeof desired[toggle.key] !== "boolean") {
        throw new Error(
          `repository.${toggle.key} is ${JSON.stringify(desired[toggle.key])}, which is not a boolean, so the toggle direction is ambiguous. Use unquoted true or false (YAML parses "no"/"off"/"yes" as strings, not booleans)`,
        );
      }
    }
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(desired)) {
      if (!SPECIAL_KEYS.has(key)) {
        patch[key] = value;
      }
    }

    if (ctx.check) {
      const live = (await call(ctx, this, "GET", `/repos/${ctx.repo}`)) as Record<string, unknown>;
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
      for (const toggle of SECURITY_TOGGLES) {
        if (!(toggle.key in desired)) {
          continue;
        }
        const probe = await probeAbsent(ctx, this, `/repos/${ctx.repo}/${toggle.path}`, {
          tolerate: toggle.tolerate,
        });
        const enabled = "missing" in probe ? false : toggle.isEnabled(probe.data);
        if (enabled !== desired[toggle.key]) {
          result.drift.push(
            `repository.${toggle.key}: declared ${desired[toggle.key]} != live ${enabled}; apply will set the declared value`,
          );
        }
      }
      return result;
    }

    if (Object.keys(patch).length > 0) {
      await call(ctx, this, "PATCH", `/repos/${ctx.repo}`, patch);
      result.changes.push(`patched repository fields: ${Object.keys(patch).join(", ")}`);
    }
    if ("topics" in desired) {
      const names = normalizeTopics(desired.topics);
      await call(ctx, this, "PUT", `/repos/${ctx.repo}/topics`, { names });
      result.changes.push(`set topics: ${names.join(", ") || "(none)"}`);
    }
    for (const toggle of SECURITY_TOGGLES) {
      if (!(toggle.key in desired)) {
        continue;
      }
      const path = `/repos/${ctx.repo}/${toggle.path}`;
      if (desired[toggle.key]) {
        await call(ctx, this, "PUT", path);
      } else if (toggle.tolerateOnDisable.length === 0) {
        await call(ctx, this, "DELETE", path);
      } else {
        // Disabling where the feature does not apply is already the
        // declared state; anything else is a real failure.
        await tryCall(ctx, this, "DELETE", path, { tolerate: toggle.tolerateOnDisable });
      }
      result.changes.push(`${toggle.label}: ${desired[toggle.key] ? "enabled" : "disabled"}`);
    }
    return result;
  },
};
