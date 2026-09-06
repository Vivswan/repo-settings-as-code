/** The `code_scanning_default_setup:` section's schema slice; root src/schema.ts composes the SettingsFile property from it. */

import { z } from "zod";

export const CodeScanningDefaultSetupConfig = z
  .object({
    state: z.enum(["configured", "not-configured"]).optional(),
    query_suite: z.enum(["default", "extended"]).optional(),
    languages: z.array(z.string()).optional(),
    runner_type: z.enum(["standard", "labeled"]).optional(),
    runner_label: z.string().nullable().optional(),
    threat_model: z.enum(["remote", "remote_and_local"]).optional(),
  })
  .meta({ id: "CodeScanningDefaultSetupConfig" });
export type CodeScanningDefaultSetupConfig = z.infer<typeof CodeScanningDefaultSetupConfig>;
