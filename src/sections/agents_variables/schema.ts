/** The agents_variables entry-config declaration (see index.ts for the section). */

import { z } from "zod";

export const AgentsVariableConfig = z
  .object({
    name: z.string(),
    value: z.string(),
  })
  .meta({ id: "AgentsVariableConfig" });
export type AgentsVariableConfig = z.infer<typeof AgentsVariableConfig>;
