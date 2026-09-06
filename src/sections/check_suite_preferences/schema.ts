/**
 * The `check_suite_preferences:` section's schema slice and its
 * AutoTriggerCheckConfig helper; root src/schema.ts composes the
 * SettingsFile property from it.
 */

import { z } from "zod";

const AutoTriggerCheckConfig = z
  .object({
    app_id: z.int(),
    setting: z.boolean(),
  })
  .meta({ id: "AutoTriggerCheckConfig" });

export const CheckSuitePreferencesConfig = z
  .looseObject({
    auto_trigger_checks: z.array(AutoTriggerCheckConfig),
  })
  .catchall(z.unknown())
  .meta({ id: "CheckSuitePreferencesConfig" });
export type CheckSuitePreferencesConfig = z.infer<typeof CheckSuitePreferencesConfig>;
