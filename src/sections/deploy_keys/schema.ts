/** The `deploy_keys:` section's schema slice; root src/schema.ts composes the SettingsFile property from it. */

import { z } from "zod";

export const DeployKeyConfig = z
  .object({
    title: z.string(),
    key: z.string(),
    read_only: z.boolean().optional(),
  })
  .meta({ id: "DeployKeyConfig" });
export type DeployKeyConfig = z.infer<typeof DeployKeyConfig>;
