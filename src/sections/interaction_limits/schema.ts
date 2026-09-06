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
    limit: z
      .string()
      .optional()
      .describe(
        'Who may interact: "existing_users", "contributors_only", or "collaborators_only". Optional when only the pull-request keys below are declared; an omitted limit leaves the live base limit untouched.',
      ),
    expiry: z
      .string()
      .optional()
      .describe(
        'How long the limit lasts ("one_day" through "six_months"); GitHub defaults to ' +
          "one_day. Write-only: GitHub reports back the computed expires_at, never the duration, " +
          "so check mode cannot verify this field and apply re-arms it on every run. Requires a " +
          "sibling `limit`.",
      ),
    // The cap object IS the PATCH body, open so future fields ride it; the
    // flag is typed so a YAML-quoted "true" fails upfront in document
    // validation, before any section writes (the branches precedent).
    pull_request_creation_cap: z
      .object({
        enabled: z
          .boolean({
            error:
              'enabled must be an unquoted true or false (YAML parses "no"/"off"/"yes" as strings, not booleans), so the cap direction is unambiguous',
          })
          .describe("Whether the cap is enforced."),
        max_open_pull_requests: z
          .number()
          .optional()
          .describe("The maximum number of open pull requests one user may have (1-1000)."),
      })
      .optional()
      .describe(
        "The pull request creation cap, routed to GET/PATCH " +
          "/repos/{r}/interaction-limits/pulls/creation-cap. Unlike the base limit it is " +
          "persistent desired state with no self-expiry and reads back verbatim, so check mode " +
          "diffs it exactly and apply PATCHes only on divergence. max_open_pull_requests is " +
          "1-1000. On repositories where the cap is not available, the endpoints answer 405: " +
          "apply surfaces that as a note, check mode as drift.",
      ),
    pull_request_creation_bypass: z
      .array(z.string())
      .optional()
      .describe(
        "User logins exempt from the pull request creation cap, routed to GET/PUT/DELETE " +
          "/repos/{r}/interaction-limits/pulls/bypass-list and reconciled: apply removes the " +
          "undeclared logins and then adds the missing ones (removals first - the list holds at " +
          "most 100 users); logins compare case-insensitively. An empty list removes everyone. " +
          "At most 100 logins.",
      ),
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
  .describe(
    "The `interaction_limits:` section. The base object is sent verbatim to PUT " +
      "/repos/{r}/interaction-limits minus the two routed keys below, which go to their own " +
      ".../interaction-limits/pulls sub-endpoints instead. GitHub reads the base limit back as " +
      "limit, origin, and the computed expires_at only. Declare at least one of `limit`, " +
      "`pull_request_creation_cap`, or `pull_request_creation_bypass`.",
  )
  .meta({ id: "InteractionLimitsConfig" });

/** The `interaction_limits:` whole-section config: the limits, or null to clear the base limit. */
export const InteractionLimitsConfig = InteractionLimits.nullable();
export type InteractionLimitsConfig = z.infer<typeof InteractionLimitsConfig>;

/** Compile-time pin: every routed key names a real declared-limits field. */
type _RoutedKeysReal = MustBeNever<
  Exclude<(typeof ROUTED_KEY_LIST)[number], keyof NonNullable<InteractionLimitsConfig>>
>;
