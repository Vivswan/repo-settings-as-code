/** The `workflows:` section's schema slice; root src/schema.ts composes the SettingsFile property from it. */

import { z } from "zod";

const WorkflowConfig = z
  .object({
    path: z.string(),
    state: z.enum(["active", "disabled"]),
  })
  .meta({ id: "WorkflowConfig" });

/** The `workflows:` document slice: the entry list the document composes from. */
export const WorkflowsConfig = z.array(WorkflowConfig);
