/** The `custom_properties:` section's entry-config declaration (see src/schema.ts). */

import { z } from "zod";

export const CustomPropertyConfig = z
  .object({
    property_name: z
      .string()
      .describe("The organization-defined property's name, the natural key."),
    value: z
      .union([z.string(), z.array(z.string()), z.boolean(), z.number(), z.null()])
      .describe(
        "The value to set: a string (single_select and string properties), a list of strings " +
          "(multi_select, compared as a set - list each option once), or a boolean (true_false, " +
          'normalized to the "true"/"false" string GitHub transports). Numbers are likewise sent ' +
          "as their string form - through YAML's parsed number, so quote any numeric value you " +
          'want sent verbatim (unquoted, 1.10 arrives as "1.1" and 1e21 as "1e+21"). `null` ' +
          "unsets the property, reverting to the org default, if any.",
      ),
  })
  .describe(
    "One custom property value, matched by the API's property_name verbatim. Keys other than property_name and value are rejected: the bulk PATCH body is built from exactly these two fields, so an extra key would have no destination.",
  )
  .meta({ id: "CustomPropertyConfig" });
export type CustomPropertyConfig = z.infer<typeof CustomPropertyConfig>;
