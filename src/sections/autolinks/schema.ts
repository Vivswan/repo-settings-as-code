/** The `autolinks:` section's entry-config declaration (see src/schema.ts). */

import { z } from "zod";

export const AutolinkConfig = z
  .object({
    key_prefix: z.string(),
    url_template: z.string(),
    is_alphanumeric: z.boolean().optional(),
  })
  .meta({ id: "AutolinkConfig" });
export type AutolinkConfig = z.infer<typeof AutolinkConfig>;
