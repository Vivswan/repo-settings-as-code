/**
 * The `interaction_limits:` section's schema slice and the routed-keys set
 * its base-key sweep and the section handler share; root src/schema.ts
 * composes the SettingsFile property from it.
 */

import { z } from "zod";
import type { MustBeNever } from "../../types.js";

/**
 * The interaction_limits keys routed to their own .../interaction-limits/pulls
 * sub-endpoints instead of the base PUT body, shared by the shape's base-key
 * sweep below and the section handler's strip. The list is pinned to the
 * config type after the schema (the _RoutedKeysReal check), so a typo'd or
 * renamed key fails to compile instead of silently riding the base PUT.
 */
const ROUTED_KEY_LIST = ["pull_request_creation_cap", "pull_request_creation_bypass"] as const;
export const INTERACTION_LIMITS_ROUTED_KEYS: ReadonlySet<string> = new Set(ROUTED_KEY_LIST);

// The limits object behind the nullable section config below. Not exported:
// consumers spell it NonNullable<InteractionLimitsConfig>. The published
// definition id stays "InteractionLimitsConfig" - the id names the section's
// schema definition, and moving it onto the nullable wrapper would change
// the published schema.
const InteractionLimits = z
  .object({
    limit: z.string().optional(),
    expiry: z.string().optional(),
    // The cap object IS the PATCH body, open so future fields ride it; the
    // flag is typed so a YAML-quoted "true" fails upfront in document
    // validation, before any section writes (the branches precedent).
    pull_request_creation_cap: z
      .object({
        enabled: z.boolean({
          error:
            'enabled must be an unquoted true or false (YAML parses "no"/"off"/"yes" as strings, not booleans), so the cap direction is unambiguous',
        }),
        max_open_pull_requests: z.number().optional(),
      })
      .optional(),
    pull_request_creation_bypass: z.array(z.string()).optional(),
  })
  .superRefine((declared, refineCtx) => {
    // Rejected here, in the shape, so upfront document validation fails
    // the run in BOTH modes before ANY section writes (the actions
    // precedent). Base keys are read off the parsed record because the
    // runtime shape is loose passthrough (only the loosen()ed clone, which
    // keeps unknown keys, ever parses documents).
    const record = declared as Record<string, unknown>;
    const baseKeys = Object.keys(record).filter((key) => !INTERACTION_LIMITS_ROUTED_KEYS.has(key));
    if (
      baseKeys.length === 0 &&
      record.pull_request_creation_cap === undefined &&
      record.pull_request_creation_bypass === undefined
    ) {
      refineCtx.addIssue({
        code: "custom",
        message:
          "declare at least one of limit, pull_request_creation_cap, or pull_request_creation_bypass (or declare interaction_limits: null to clear the base limit)",
      });
    }
    if (baseKeys.length > 0 && record.limit === undefined) {
      // Base keys ride the base PUT, whose body GitHub rejects without a
      // limit - and a run that never issues the PUT would silently drop
      // them; reject the contradiction upfront instead.
      refineCtx.addIssue({
        code: "custom",
        path: ["limit"],
        message: `key(s) [${baseKeys.join(", ")}] ride the base interaction-limits PUT, which requires a limit; declare limit alongside them, or remove them`,
      });
    }
    const bypass = record.pull_request_creation_bypass;
    if (!Array.isArray(bypass)) {
      return;
    }
    if (bypass.length > 100) {
      // 100 is what makes single-request reconciliation valid (the writes
      // take at most 100 users per request), not just value validation:
      // GitHub also caps the list itself at 100.
      refineCtx.addIssue({
        code: "custom",
        path: ["pull_request_creation_bypass"],
        message: `GitHub caps the bypass list at 100 users, but ${bypass.length} logins are declared; trim the list`,
      });
    }
    // Logins are case-insensitive on GitHub, so two spellings of one login
    // would fight each other on every run instead of converging.
    const seen = new Map<string, string>();
    for (const login of bypass as string[]) {
      const key = login.toLowerCase();
      const first = seen.get(key);
      if (first === undefined) {
        seen.set(key, login);
      } else {
        refineCtx.addIssue({
          code: "custom",
          path: ["pull_request_creation_bypass"],
          message: `"${first}" and "${login}" name the same login (logins are case-insensitive); keep exactly one`,
        });
      }
    }
  })
  .meta({ id: "InteractionLimitsConfig" });

/** The `interaction_limits:` whole-section config: the limits, or null to clear the base limit. */
export const InteractionLimitsConfig = InteractionLimits.nullable();
export type InteractionLimitsConfig = z.infer<typeof InteractionLimitsConfig>;

/** Compile-time pin: every routed key names a real declared-limits field. */
type _RoutedKeysReal = MustBeNever<
  Exclude<(typeof ROUTED_KEY_LIST)[number], keyof NonNullable<InteractionLimitsConfig>>
>;
