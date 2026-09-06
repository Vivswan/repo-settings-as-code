/** The `secret_scanning_custom_patterns:` section's schema slice; root src/schema.ts composes the SettingsFile property from it. */

import { z } from "zod";

const DELIMITER_CLEAR_ERROR =
  "a delimiter cannot be cleared with an empty string; remove the pattern and redeclare it without the field instead";

export const SecretScanningPatternConfig = z
  .object({
    name: z
      .string()
      .describe(
        "The pattern name, the natural key; immutable upstream, so a rename creates the new name (the old one follows the undeclared policy).",
      ),
    pattern: z.string().describe("The regular expression the secret format must match."),
    // min(1): "" cannot mean "clear the delimiter" - the PATCH updates
    // provided fields only - so the spelling fails at document validation,
    // before any repository is touched.
    start_delimiter: z
      .string()
      .min(1, DELIMITER_CLEAR_ERROR)
      .optional()
      .describe(
        "Regular expression for the characters that must come before the secret. An empty string is rejected: a delimiter cannot be cleared through the update call - remove the pattern and redeclare it without the field instead.",
      ),
    end_delimiter: z
      .string()
      .min(1, DELIMITER_CLEAR_ERROR)
      .optional()
      .describe(
        "Regular expression for the characters that must come after the secret. An empty string is rejected, like start_delimiter.",
      ),
    must_match: z
      .array(z.string())
      .optional()
      .describe("Additional regular expressions a match must also satisfy, compared in order."),
    must_not_match: z
      .array(z.string())
      .optional()
      .describe("Regular expressions a match must NOT satisfy, compared in order."),
  })
  .describe(
    "One secret scanning custom pattern, matched by exact name. Only the fields below are " +
      "accepted: `state` and `push_protection_enabled` are readable but NOT writable through the " +
      "custom-pattern endpoints, so they cannot be declared. A delimiter, once set, cannot be " +
      "cleared back to GitHub's default through the update PATCH (the endpoint updates provided " +
      "fields only); remove the pattern and redeclare it without the field instead.",
  )
  .meta({ id: "SecretScanningPatternConfig" });
export type SecretScanningPatternConfig = z.infer<typeof SecretScanningPatternConfig>;
