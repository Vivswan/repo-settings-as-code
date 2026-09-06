/** The `branches:` section's entry-config declaration (see src/schema.ts). */

import { z } from "zod";

// --- Actor vocabulary (branches force_push_bypassers) ------------------------

/** A parsed force_push_bypassers actor string. */
export type BypassActor =
  | { kind: "user"; login: string }
  | { kind: "team"; org: string; team: string }
  | { kind: "app"; slug: string };

const NAME_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*)$/;

/**
 * Parse one declared actor string, or null when it fits no form: a bare
 * login is a user, "org/team-slug" is a team, and "app/slug" is a GitHub
 * App (the "app" head is reserved; an organization named "app" cannot be
 * addressed as a team holder here).
 */
export function parseBypassActor(raw: string): BypassActor | null {
  const parts = raw.split("/");
  if (parts.length === 1) {
    const login = parts[0] as string;
    return NAME_SEGMENT.test(login) ? { kind: "user", login } : null;
  }
  if (parts.length !== 2) {
    return null;
  }
  const [head, tail] = parts as [string, string];
  if (!NAME_SEGMENT.test(head) || !NAME_SEGMENT.test(tail)) {
    return null;
  }
  return head === "app" ? { kind: "app", slug: tail } : { kind: "team", org: head, team: tail };
}

const ACTOR_FORM_ERROR =
  'each force_push_bypassers actor must be a bare user login ("octocat"), "org/team-slug" for a team, or "app/slug" for a GitHub App';

/** The first duplicate under case-insensitive comparison, or null. */
function duplicateIn(list: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const item of list) {
    const key = item.toLowerCase();
    if (seen.has(key)) {
      return item;
    }
    seen.add(key);
  }
  return null;
}

export const BranchProtectionConfig = z
  .looseObject({
    required_signatures: z
      .boolean({
        error:
          'required_signatures must be an unquoted true or false (YAML parses "no"/"off"/"yes" as strings, not booleans), so the toggle direction is unambiguous',
      })
      .optional(),
    force_push_bypassers: z
      .array(
        z.string().refine((raw) => parseBypassActor(raw) !== null, { error: ACTOR_FORM_ERROR }),
      )
      .optional(),
    required_deployments: z
      .strictObject({ environments: z.array(z.string()) })
      .nullable()
      .optional(),
  })
  .meta({ id: "BranchProtectionConfig" });
export type BranchProtectionConfig = z.infer<typeof BranchProtectionConfig>;

export const BranchConfig = z
  .object({
    name: z.string(),
    protection: BranchProtectionConfig.nullable(),
  })
  .superRefine((entry, refineCtx) => {
    // The routed lists are replace-wholesale semantics keyed by actor or
    // environment identity, which GitHub canonicalizes case-insensitively:
    // a duplicate would apply "successfully" and then drift forever
    // against the deduplicated read-back, so both lists reject them
    // upfront (rejectDuplicates' precedent, at the field level).
    const routed = entry.protection;
    if (routed !== null) {
      const duplicateActor = duplicateIn(routed.force_push_bypassers ?? []);
      if (duplicateActor !== null) {
        refineCtx.addIssue({
          code: "custom",
          path: ["protection", "force_push_bypassers"],
          message: `force_push_bypassers lists "${duplicateActor}" more than once (actor names are case-insensitive); keep one entry per actor`,
        });
      }
      const duplicateEnv = duplicateIn(
        routed.required_deployments === null
          ? []
          : (routed.required_deployments?.environments ?? []),
      );
      if (duplicateEnv !== null) {
        refineCtx.addIssue({
          code: "custom",
          path: ["protection", "required_deployments", "environments"],
          message: `required_deployments.environments lists "${duplicateEnv}" more than once (environment names are case-insensitive); keep one entry per environment`,
        });
      }
    }
  })
  .meta({ id: "BranchConfig" });
export type BranchConfig = z.infer<typeof BranchConfig>;

/** The `branches:` document slice: the entry list the document composes from. */
export const BranchesConfig = z.array(BranchConfig);
