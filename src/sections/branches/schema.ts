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
      .optional()
      .describe(
        "Require signed commits on the branch. On a literal branch this is a routed key the " +
          "protection PUT silently drops, so it is applied through the POST/DELETE " +
          ".../protection/required_signatures sub-endpoint: when it drifts, and again after any " +
          "protection PUT (GitHub does not document whether the PUT preserves an existing " +
          "requirement), so declare the toggle on any branch that carries one - a declared value " +
          "is pinned either way. On a wildcard rule it rides the GraphQL rule mutation like " +
          "every other key.",
      ),
    force_push_bypassers: z
      .array(
        z.string().refine((raw) => parseBypassActor(raw) !== null, { error: ACTOR_FORM_ERROR }),
      )
      .optional()
      .describe(
        'Who may force-push to the branch when "allow force pushes" is in its "specify who" ' +
          'mode. Each actor is one string: a bare login is a user ("octocat"), "org/team-slug" ' +
          'is a team, and "app/slug" is a GitHub App. A REST-invisible surface: on a literal ' +
          "branch this routed key is stripped from the protection PUT and applied through the " +
          "updateBranchProtectionRule GraphQL mutation when it drifts, and again after any " +
          "protection PUT; on a wildcard rule it rides the create or update mutation with the " +
          "rest of the rule. The live list is read back through GraphQL. An empty list clears " +
          "every allowance; an absent key leaves the live list untouched.",
      ),
    required_deployments: z
      .strictObject({ environments: z.array(z.string()) })
      .nullable()
      .optional()
      .describe(
        "Require deployments to succeed before merging (the checkbox and its environment " +
          "list). REST-invisible like force_push_bypassers, so the routed key rides the same " +
          "GraphQL mutation. Declaring `null` turns the requirement OFF; an absent key leaves " +
          "the live state untouched. GitHub SILENTLY drops environment names that do not exist " +
          "on the repository, so apply verifies the mutation's read-back and fails loudly naming " +
          "any dropped name; the environments section runs before branches, so environments " +
          "declared in the same settings file exist by the time this key applies.",
      ),
  })
  .describe("The protection PUT payload, passed through verbatim except its routed keys.")
  .meta({ id: "BranchProtectionConfig" });
export type BranchProtectionConfig = z.infer<typeof BranchProtectionConfig>;

export const BranchConfig = z
  .object({
    name: z
      .string()
      .describe(
        "The branch name, or a wildcard pattern (any name containing `*`, `?`, or `[`, e.g. " +
          '"release/*"). A literal name applies through the REST protection endpoints; a ' +
          "wildcard rule is REST-invisible, so it applies entirely through the GraphQL " +
          "branch-protection-rule mutations and its protection accepts only the keys this action " +
          "can round-trip through that surface (the validator names them; prefer rulesets for " +
          "new pattern-based configuration).",
      ),
    protection: BranchProtectionConfig.nullable().describe(
      "PUT .../protection payload; null removes protection (Probot parity).",
    ),
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
  .describe("Classic protection for one branch name or wildcard pattern.")
  .meta({ id: "BranchConfig" });
export type BranchConfig = z.infer<typeof BranchConfig>;

/** The `branches:` document slice: the entry list the document composes from. */
export const BranchesConfig = z.array(BranchConfig);
