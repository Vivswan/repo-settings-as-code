/** The `labels:` section's entry-config declaration (see src/schema.ts). */

import { z } from "zod";

export const LabelConfig = z
  .object({
    name: z.string(),
    color: z.string().optional(),
    description: z.string().optional(),
    new_name: z.string().optional(),
  })
  .meta({ id: "LabelConfig" });
export type LabelConfig = z.infer<typeof LabelConfig>;
