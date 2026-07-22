/**
 * `code_scanning_default_setup:` section - PATCH the default-setup
 * configuration; a 409 (configuration run in progress) gets its own advice.
 */

import { subsetDiff } from "../engine/diff.js";
import {
  anyRecord,
  call,
  type EndpointDecl,
  emptyResult,
  expand,
  grantFor,
  type SectionModule,
  type SectionPermission,
  type SectionResult,
  tryCall,
} from "./contract.js";

const permission: SectionPermission = { repo: ["administration", "code_scanning_alerts"] };

const ENDPOINTS = {
  get: {
    route: "GET /repos/{owner}/{repo}/code-scanning/default-setup",
    statuses: { 200: "the current default-setup configuration" },
  },
  update: {
    route: "PATCH /repos/{owner}/{repo}/code-scanning/default-setup",
    statuses: {
      200: "setup updated",
      202: "GitHub started an async configuration run; the body carries run_id",
      409: "a configuration validation run is already in progress",
    },
  },
} as const satisfies Record<string, EndpointDecl>;

export const codeScanningDefaultSetupSection: SectionModule<"code_scanning_default_setup"> = {
  key: "code_scanning_default_setup",
  permission,
  grant: grantFor(
    permission,
    "a 403 on this endpoint can also mean GitHub Advanced Security (code security) is not enabled on the repository, or the repository is archived",
  ),
  endpoints: ENDPOINTS,
  shape: anyRecord,
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const desired = desiredRaw as Record<string, unknown>;

    if (ctx.check) {
      const live = await call(ctx, this, ENDPOINTS.get);
      result.drift.push(...subsetDiff(desired, live, "code_scanning_default_setup"));
      return result;
    }

    // Tolerate a 409 (a configuration run is already in progress) so it
    // gets accurate advice instead of throwFor's generic fix-the-file text;
    // 409 is a declared status of this endpoint, so it is tolerated by default.
    const patch = await tryCall(ctx, this, ENDPOINTS.update, { payload: desired });
    if ("error" in patch) {
      throw new Error(
        `code_scanning_default_setup: PATCH ${expand(ENDPOINTS.update, ctx)}: 409 ${patch.error.message}. A default-setup configuration run is already in progress on the repository; re-run the workflow after it finishes`,
      );
    }
    const run = patch.data as { run_id?: number; run_url?: string } | null;
    if (run?.run_id !== undefined) {
      const url = run.run_url ? ` (${run.run_url})` : "";
      result.changes.push(
        `applied code scanning default setup; GitHub started configuration run ${run.run_id}${url} to roll it out, and the settings take effect when it finishes`,
      );
    } else {
      result.changes.push("applied code scanning default setup");
    }
    return result;
  },
};
