/** The `webhooks:` section's schema slice; root src/schema.ts composes the SettingsFile property from it. */

import { z } from "zod";

const WebhookDeliveryConfig = z
  .looseObject({
    url: z.string(),
    content_type: z.string().optional(),
    secret: z.string().optional(),
    // Values pass through as-is beyond the type: GitHub is the authority on
    // what it accepts, and it stores numbers as their string form.
    insecure_ssl: z.union([z.string(), z.number()]).optional(),
  })
  .catchall(z.unknown())
  .meta({ id: "WebhookDeliveryConfig" });

export const WebhookConfig = z
  .object({
    name: z.literal("web").optional(),
    config: WebhookDeliveryConfig,
    events: z.array(z.string()).optional(),
    active: z.boolean().optional(),
  })
  .superRefine((entry, refineCtx) => {
    // The secret lives under config; an ENTRY-level secret would pass the
    // loose runtime shape, ship the raw reference text verbatim, and create
    // a silently unauthenticated hook - the exact failure this feature
    // exists to prevent - so the misplacement is rejected by name (the
    // `name: "web"` pin precedent). Only the loosen()ed runtime shape can
    // see the undeclared key - which is the only shape that ever parses
    // documents.
    if ((entry as Record<string, unknown>).secret !== undefined) {
      refineCtx.addIssue({
        code: "custom",
        path: ["secret"],
        message:
          "a webhook secret belongs under config.secret, not at the entry level; here it would pass through verbatim and the hook would be created without a working secret",
      });
    }
  })
  .meta({ id: "WebhookConfig" });
export type WebhookConfig = z.infer<typeof WebhookConfig>;
