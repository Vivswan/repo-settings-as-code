/**
 * `autolinks:` section - autolinks cannot be edited, so a changed one is
 * deleted and recreated. Undeclared autolinks are DELETED.
 */

import { z } from "zod";
import { subsetDiff } from "../engine/diff.js";
import type { AutolinkConfig } from "../schema.js";
import {
  call,
  type EndpointDecl,
  emptyResult,
  grantFor,
  rejectDuplicates,
  type SectionModule,
  type SectionPermission,
  type SectionResult,
} from "./contract.js";

interface LiveAutolink {
  id: number;
  key_prefix: string;
  url_template: string;
  is_alphanumeric: boolean;
}

const permission: SectionPermission = { repo: ["administration"] };

const ENDPOINTS = {
  list: { route: "GET /repos/{owner}/{repo}/autolinks", statuses: { 200: "the autolink list" } },
  create: { route: "POST /repos/{owner}/{repo}/autolinks", statuses: { 201: "autolink created" } },
  remove: {
    route: "DELETE /repos/{owner}/{repo}/autolinks/{autolink_id}",
    statuses: { 204: "autolink deleted" },
  },
} as const satisfies Record<string, EndpointDecl>;

export const autolinksSection: SectionModule<"autolinks"> = {
  key: "autolinks",
  deletesUndeclared: "deletes",
  permission,
  grant: grantFor(permission),
  endpoints: ENDPOINTS,
  shape: z.array(z.looseObject({ key_prefix: z.string(), url_template: z.string() })),
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const desired = desiredRaw as AutolinkConfig[];
    rejectDuplicates(
      this,
      desired,
      (a) => a.key_prefix,
      (a) => a.key_prefix,
    );
    // The autolinks list endpoint is not paginated; a single GET returns
    // everything, and sending page params would not advance anything.
    const live = (await call(ctx, this, ENDPOINTS.list)) as LiveAutolink[];
    const liveByPrefix = new Map(live.map((a) => [a.key_prefix, a]));
    const declared = new Set<string>();

    for (const autolink of desired) {
      declared.add(autolink.key_prefix);
      const existing = liveByPrefix.get(autolink.key_prefix);
      const { key_prefix: _kp, ...declaredFields } = autolink;
      const matches =
        existing !== undefined && subsetDiff(declaredFields, existing, "autolink").length === 0;
      if (matches) {
        continue;
      }
      if (ctx.check) {
        result.drift.push(
          existing
            ? `autolinks[${autolink.key_prefix}]: live settings differ from the settings file, and autolinks cannot be edited; apply will delete and recreate it`
            : `autolinks[${autolink.key_prefix}]: missing - declared in the settings file but not on the repo; apply will create it`,
        );
        continue;
      }
      if (existing) {
        // Autolinks have no update endpoint; replace.
        await call(ctx, this, ENDPOINTS.remove, { params: { autolink_id: String(existing.id) } });
      }
      await call(ctx, this, ENDPOINTS.create, {
        payload: {
          is_alphanumeric: true,
          ...autolink, // declared keys (including future ones) pass through
        },
      });
      result.changes.push(`${existing ? "replaced" : "created"} autolink ${autolink.key_prefix}`);
    }

    for (const autolink of live) {
      if (declared.has(autolink.key_prefix)) {
        continue;
      }
      if (ctx.check) {
        result.drift.push(
          `autolinks[${autolink.key_prefix}]: undeclared - not in the settings file, so apply will DELETE it; add it to the settings file to keep it`,
        );
      } else {
        await call(ctx, this, ENDPOINTS.remove, { params: { autolink_id: String(autolink.id) } });
        result.changes.push(`DELETED undeclared autolink ${autolink.key_prefix}`);
      }
    }
    return result;
  },
};
