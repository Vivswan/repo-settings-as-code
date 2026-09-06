/** The `secret_scanning_custom_patterns:` section's schema slice; root src/schema.ts composes the SettingsFile property from it. */

import { z } from "zod";

const DELIMITER_CLEAR_ERROR =
  "a delimiter cannot be cleared with an empty string; remove the pattern and redeclare it without the field instead";

export const SecretScanningPatternConfig = z
  .object({
    name: z.string(),
    pattern: z.string(),
    // min(1): "" cannot mean "clear the delimiter" - the PATCH updates
    // provided fields only - so the spelling fails at document validation,
    // before any repository is touched.
    start_delimiter: z.string().min(1, DELIMITER_CLEAR_ERROR).optional(),
    end_delimiter: z.string().min(1, DELIMITER_CLEAR_ERROR).optional(),
    must_match: z.array(z.string()).optional(),
    must_not_match: z.array(z.string()).optional(),
  })
  .meta({ id: "SecretScanningPatternConfig" });
export type SecretScanningPatternConfig = z.infer<typeof SecretScanningPatternConfig>;
