/** The `milestones:` section's entry-config declaration (see src/schema.ts). */

import { z } from "zod";

export const MilestoneConfig = z
  .object({
    title: z.string(),
    description: z.string().optional(),
    state: z.enum(["open", "closed"]).optional(),
  })
  .meta({ id: "MilestoneConfig" });
export type MilestoneConfig = z.infer<typeof MilestoneConfig>;
