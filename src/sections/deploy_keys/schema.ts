/** The `deploy_keys:` section's schema slice; root src/schema.ts composes the SettingsFile property from it. */

import { z } from "zod";

export const DeployKeyConfig = z
  .object({
    title: z.string().describe("The key title shown in the settings UI, the natural key."),
    key: z
      .string()
      .describe(
        'The PUBLIC key material, e.g. "ssh-ed25519 AAAAC3... comment". Public by nature, so ' +
          "it is safe in a committed file. Compared as algorithm + blob with the trailing " +
          "comment ignored (GitHub may strip or rewrite comments on storage); keys are immutable " +
          "upstream, so a changed key is applied as delete plus recreate.",
      ),
    read_only: z
      .boolean()
      .optional()
      .describe(
        "Whether the key is restricted to read-only access; GitHub defaults to false (read/write).",
      ),
  })
  .describe(
    "One deploy key, matched by exact title (GitHub documents no case folding for titles). Extra fields pass through to the create call verbatim.",
  )
  .meta({ id: "DeployKeyConfig" });
export type DeployKeyConfig = z.infer<typeof DeployKeyConfig>;
