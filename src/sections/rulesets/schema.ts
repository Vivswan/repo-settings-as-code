/** The `rulesets:` section's entry-config declaration (see src/schema.ts). */

import { z } from "zod";

export const RulesetConfig = z
  .object({
    name: z.string(),
    target: z.enum(["branch", "tag", "push"]).optional(),
    enforcement: z.string().optional(),
    conditions: z
      .object({
        ref_name: z
          .object({
            include: z.array(z.string()).optional(),
            exclude: z.array(z.string()).optional(),
          })
          .optional(),
      })
      .optional(),
    rules: z
      .array(
        z.object({
          type: z.string(),
          parameters: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .optional(),
    bypass_actors: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .meta({ id: "RulesetConfig" });
export type RulesetConfig = z.infer<typeof RulesetConfig>;
