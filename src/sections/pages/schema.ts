/** The `pages:` section's whole-section config declaration (see src/schema.ts). */

import { z } from "zod";

// The site object behind the nullable section config below. Not exported:
// consumers spell it NonNullable<PagesConfig>. The published definition id
// stays "PagesConfig" - the id names the section's schema definition, and
// moving it onto the nullable wrapper would change the published schema.
const PagesSite = z
  .object({
    build_type: z.enum(["workflow", "legacy"]).optional(),
    source: z.object({ branch: z.string(), path: z.string().optional() }).optional(),
    cname: z.string().nullable().optional(),
    https_enforced: z.boolean().optional(),
    public: z.boolean().optional(),
  })
  .meta({ id: "PagesConfig" });

/** The `pages:` whole-section config: the site config, or null to disable the site. */
export const PagesConfig = PagesSite.nullable();
export type PagesConfig = z.infer<typeof PagesConfig>;
