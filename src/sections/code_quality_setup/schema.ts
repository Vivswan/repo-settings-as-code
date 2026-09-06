/** The `code_quality_setup:` section's schema slice; root src/schema.ts composes the SettingsFile property from it. */

import { z } from "zod";

export const CodeQualitySetupConfig = z
  .object({
    state: z.enum(["configured", "not-configured"]).optional(),
    languages: z.array(z.string()).optional(),
    runner_type: z.enum(["standard", "labeled"]).optional(),
    runner_label: z.string().nullable().optional(),
    ai_findings_option: z.enum(["disabled", "on_push"]).optional(),
  })
  .meta({ id: "CodeQualitySetupConfig" });
export type CodeQualitySetupConfig = z.infer<typeof CodeQualitySetupConfig>;
