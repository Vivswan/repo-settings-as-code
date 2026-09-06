/** The `collaborators:` section's entry-config declaration (see src/schema.ts). */

import { z } from "zod";

export const CollaboratorConfig = z
  .object({
    username: z.string(),
    permission: z.string().optional(),
  })
  .meta({ id: "CollaboratorConfig" });
export type CollaboratorConfig = z.infer<typeof CollaboratorConfig>;
