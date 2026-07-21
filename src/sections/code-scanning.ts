/**
 * `code_scanning_default_setup:` section - PATCH the default-setup
 * configuration; a 409 (configuration run in progress) gets its own advice.
 */

import { subsetDiff } from "../diff.js";
import {
  anyRecord,
  call,
  emptyResult,
  type SectionModule,
  type SectionResult,
  throwFor,
} from "./contract.js";

export const codeScanningDefaultSetupSection: SectionModule<"code_scanning_default_setup"> = {
  key: "code_scanning_default_setup",
  grant: `grant "Administration" or "Code scanning alerts" (read and write) under the PAT's Repository permissions; a 403 on this endpoint can also mean GitHub Advanced Security (code security) is not enabled on the repository, or the repository is archived`,
  shape: anyRecord,
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const desired = desiredRaw as Record<string, unknown>;
    const path = `/repos/${ctx.repo}/code-scanning/default-setup`;

    if (ctx.check) {
      const live = await call(ctx, this, "GET", path);
      result.drift.push(...subsetDiff(desired, live, "code_scanning_default_setup"));
      return result;
    }

    // Raw tryRequest so a 409 (a configuration run is already in progress)
    // gets accurate advice instead of throwFor's generic fix-the-file text.
    const patch = await ctx.api.tryRequest("PATCH", path, desired);
    if ("error" in patch) {
      if (patch.error.status === 409) {
        throw new Error(
          `code_scanning_default_setup: PATCH ${path}: 409 ${patch.error.message}. A default-setup configuration run is already in progress on the repository; re-run the workflow after it finishes`,
        );
      }
      throwFor(this, "PATCH", path, patch.error);
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
