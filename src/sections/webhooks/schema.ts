/** The `webhooks:` section's schema slice; root src/schema.ts composes the SettingsFile property from it. */

import { z } from "zod";

const WebhookDeliveryConfig = z
  .looseObject({
    url: z
      .string()
      .describe(
        "The delivery URL, the natural key: a changed url declares a NEW hook (the old one becomes undeclared).",
      ),
    content_type: z.string().optional().describe('Payload encoding: "json" or "form".'),
    secret: z
      .string()
      .optional()
      .describe(
        "The shared delivery secret, as a whole-value `$NAME` reference to an environment " +
          "variable on the action step (never a literal: settings files are committed " +
          'plaintext). Resolved at apply time; GitHub echoes it back as "********", so check ' +
          "mode cannot verify it and apply re-sends it on every run so rotations propagate.",
      ),
    // Values pass through as-is beyond the type: GitHub is the authority on
    // what it accepts, and it stores numbers as their string form.
    insecure_ssl: z
      .union([z.string(), z.number()])
      .optional()
      .describe(
        'Whether to skip TLS verification ("0" verify / "1" skip); GitHub stores it as a string.',
      ),
  })
  .catchall(z.unknown().describe("Future config fields pass through verbatim."))
  .describe("A webhook's `config` mapping, sent to the config sub-endpoint on update.")
  .meta({ id: "WebhookDeliveryConfig" });

export const WebhookConfig = z
  .object({
    name: z
      .literal("web")
      .optional()
      .describe(
        'GitHub\'s hook name; "web" is the only value modern hooks take, so anything else is rejected.',
      ),
    config: WebhookDeliveryConfig.describe("The delivery settings; config.url is the natural key."),
    events: z
      .array(z.string())
      .optional()
      .describe(
        'Events that trigger deliveries, compared order-insensitively; GitHub defaults a new hook to ["push"].',
      ),
    active: z
      .boolean()
      .optional()
      .describe("Whether deliveries fire; GitHub defaults a new hook to true."),
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
  .describe(
    "One repository webhook, matched to the live repo by config.url. Hook URLs are configuration, not credentials: they appear in drift lines and notes on purpose. The secret never does.",
  )
  .meta({ id: "WebhookConfig" });
export type WebhookConfig = z.infer<typeof WebhookConfig>;
