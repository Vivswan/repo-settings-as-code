/** The actions_variables entry-config declaration (see index.ts for the section). */

import { z } from "zod";

export const ActionsVariableConfig = z
  .object({
    name: z.string(),
    value: z.string(),
  })
  .meta({ id: "ActionsVariableConfig" });
export type ActionsVariableConfig = z.infer<typeof ActionsVariableConfig>;
