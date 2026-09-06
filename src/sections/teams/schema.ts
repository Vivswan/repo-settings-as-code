/** The `teams:` section's entry-config declaration (see src/schema.ts). */

import { z } from "zod";

const TeamConfig = z
  .object({
    name: z.string(),
    permission: z.string().optional(),
  })
  .meta({ id: "TeamConfig" });

/** The `teams:` document slice: the entry list the document composes from. */
export const TeamsConfig = z.array(TeamConfig);
