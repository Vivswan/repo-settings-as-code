/**
 * The `environments:` section's schema slice; root src/schema.ts composes
 * the SettingsFile property from it. Imports only zod and the leaf shared
 * helpers - never root schema.ts (a cycle whose top-level const evaluation
 * TDZ-crashes at import time).
 */

import { z } from "zod";
import { knobbed, SEALED_SECRET_VALUE_DOC, SECRET_NAME_DOC } from "../shared/schema-helpers.js";

export const DeploymentBranchPolicyConfig = z
  .object({
    name: z
      .string()
      .describe(
        'The name pattern branches or tags must match to deploy (e.g. "release/*"), the natural key.',
      ),
    // Checked as a plain string at runtime (the handler compares it against
    // the live pattern): GitHub stays the authority on its values, and the
    // published schema documents the upstream enum through the meta.
    type: z
      .string()
      .optional()
      .describe(
        'What the pattern matches: "branch" (the upstream default) or "tag". Immutable on GitHub, so changing it is applied as delete plus recreate.',
      )
      .meta({ enum: ["branch", "tag"] }),
  })
  .describe(
    "One custom deployment branch-policy pattern, matched by exact name. Extra fields pass through to the create call verbatim.",
  )
  .meta({ id: "DeploymentBranchPolicyConfig" });
export type DeploymentBranchPolicyConfig = z.infer<typeof DeploymentBranchPolicyConfig>;

export const DeploymentProtectionRuleConfig = z
  .strictObject({
    app: z
      .string()
      .describe(
        'The slug of the GitHub App providing the gate (e.g. "my-gate-app"), the natural key.',
      ),
  })
  .describe(
    "One custom deployment protection rule, matched by the slug of the GitHub App that provides it. No other key is accepted: the enable call sends only the App's resolved integration id, so an extra key would have no destination.",
  )
  .meta({ id: "DeploymentProtectionRuleConfig" });
export type DeploymentProtectionRuleConfig = z.infer<typeof DeploymentProtectionRuleConfig>;

export const EnvironmentVariableConfig = z
  .object({
    name: z.string().describe("The variable name, the natural key (case-insensitive on GitHub)."),
    value: z
      .string()
      .describe("The plain-text value; environment secrets are the place for secrets."),
  })
  .describe("One per-environment Actions variable, matched by case-insensitive name.")
  .meta({ id: "EnvironmentVariableConfig" });
export type EnvironmentVariableConfig = z.infer<typeof EnvironmentVariableConfig>;

export const EnvironmentSecretConfig = z
  .strictObject({
    name: z.string().describe(SECRET_NAME_DOC),
    value: z.string().describe(SEALED_SECRET_VALUE_DOC),
  })
  .describe(
    "One per-environment Actions secret, matched by case-insensitive name (GitHub stores secret names uppercase). Keys other than name and value are rejected: the API body is built from the sealed value alone, so an extra key would silently do nothing.",
  )
  .meta({ id: "EnvironmentSecretConfig" });
export type EnvironmentSecretConfig = z.infer<typeof EnvironmentSecretConfig>;

/**
 * GitHub's hard cap on pinned environments per repository, shared by the
 * shape's upfront cap check and the environments handler's pin planning.
 */
export const MAX_PINNED_ENVIRONMENTS = 10;

export const EnvironmentConfig = z
  .object({
    name: z.string().describe("The environment name, the natural key."),
    // A ROUTED SCALAR (see EnvironmentRoutedScalars), never part of the PUT
    // body: the environments handler strips it and applies it through the
    // GraphQL pin mutations after every PUT.
    pinned: z
      .boolean()
      .optional()
      .describe(
        "Pin this environment on the repository home page's deployments sidebar (GraphQL-only; " +
          "the REST environment PUT carries no pin field). Pin ORDER is the declaration order of " +
          "the entries with `pinned: true` - together they must LEAD the repository's pinned " +
          "list in that order, compared by rank (GitHub's live position numbers may carry holes " +
          "after an unpin and are never read literally). `pinned: false` unpins; an entry " +
          "without the key leaves its pin state untouched. Live pins on environments the " +
          "settings file does not declare are never unpinned; when they sit among the declared " +
          "ranks, apply moves them after the declared pins (surfaced as a note). GitHub allows " +
          "at most 10 pinned environments, so more than 10 `pinned: true` entries are rejected " +
          "upfront.",
      ),
    wait_timer: z.number().optional().describe("Minutes to wait before deployments proceed."),
    prevent_self_review: z
      .boolean()
      .optional()
      .describe("Whether the deployer may approve their own deployment."),
    reviewers: z
      .array(z.object({ type: z.enum(["User", "Team"]), id: z.number() }))
      .optional()
      .describe("Required reviewers by numeric user/team id."),
    deployment_branch_policy: z
      .object({
        protected_branches: z.boolean().describe("Restrict to branches with protection rules."),
        custom_branch_policies: z
          .boolean()
          .describe("Restrict to name patterns, declared under `deployment_branch_policies`."),
      })
      .nullable()
      .optional()
      .describe("Which branches may deploy; null clears the policy."),
    deployment_branch_policies: knobbed(DeploymentBranchPolicyConfig)
      .optional()
      .describe(
        "Custom deployment branch-policy patterns for this environment, reconciled only when " +
          "this key is declared (an absent key leaves the live patterns untouched). Declaring it " +
          "requires the sibling `deployment_branch_policy` to set `custom_branch_policies: " +
          "true`; without the flag GitHub rejects every pattern write. A pattern's `type` is " +
          "immutable on GitHub, so a declared type that differs from the live one is applied as " +
          "delete plus recreate. Within a declared key, live patterns the entries do not declare " +
          "are DELETED by default; the wrapped `{undeclared: keep, entries}` form keeps them as " +
          "notes.",
      ),
    deployment_protection_rules: knobbed(DeploymentProtectionRuleConfig)
      .optional()
      .describe(
        "Custom deployment protection rules for this environment, reconciled only when this " +
          "key is declared (an absent key leaves the live rules untouched). Each rule is a " +
          "GitHub App gate, declared by its App slug and resolved to the App's integration id at " +
          "apply time; GitHub offers no update call, so the model is enable/disable only. Within " +
          "a declared key, live rules the entries do not declare are KEPT by default - Apps can " +
          "enable themselves as gates, and silently removing a deployment gate is " +
          "security-relevant - and the wrapped `{undeclared: delete, entries}` form opts into " +
          "disabling them.",
      ),
    variables: knobbed(EnvironmentVariableConfig)
      .optional()
      .describe(
        "Actions variables for this environment, reconciled only when this key is declared (an " +
          "absent key leaves the live variables untouched). Values are plain text by design - " +
          "use environment secrets for anything sensitive. Within a declared `variables` key, " +
          "live variables the entries do not declare are DELETED by default; the wrapped " +
          "`{undeclared: keep, entries}` form keeps them as notes. Names match " +
          "case-insensitively, as GitHub treats them.",
      ),
    secrets: knobbed(EnvironmentSecretConfig)
      .optional()
      .describe(
        "Actions secrets for this environment, reconciled only when this key is declared (an " +
          "absent key leaves the live secrets untouched). Each value is a whole-value `$NAME` " +
          "reference to the action step's environment, never a literal, sealed client-side " +
          "against the environment's public key; GitHub cannot return a value, so check mode " +
          "verifies existence only and apply re-seals every declared value on each run. Within a " +
          "declared `secrets` key, live secrets the entries do not declare are KEPT by default " +
          "(their values are unrecoverable); the wrapped `{undeclared: delete, entries}` form " +
          "opts into deletion.",
      ),
  })
  .superRefine((entry, refineCtx) => {
    // Secrets live under the plural `secrets` list; a singular entry-level
    // `secret` would pass the loose runtime shape into the environment PUT
    // body verbatim and configure nothing, so the misplacement is rejected
    // by name (the webhooks entry-level `secret` pin precedent). Only the
    // loosen()ed runtime shape can see the undeclared key - which is the
    // only shape that ever parses documents.
    if ((entry as Record<string, unknown>).secret !== undefined) {
      refineCtx.addIssue({
        code: "custom",
        path: ["secret"],
        message:
          "environment secrets belong under the entry's `secrets` list, not a singular `secret` key; here it would pass through to the environment PUT verbatim and configure nothing",
      });
    }
    // The flag-pairing invariant lives HERE, in the shape, not in the
    // section's validate hook: upfront document validation rejects the
    // document in BOTH modes before ANY section writes. A hook-level check
    // would fire only when this section runs (the apply-mode preflight
    // ignores non-permission errors), after earlier sections already
    // wrote - and the pattern POST itself would 404 only after the
    // environment PUT landed, half-applying the run. The published schema
    // mirrors it as the if/then stamped through this schema's meta.
    if (entry.deployment_branch_policies === undefined) {
      return;
    }
    if (entry.deployment_branch_policy?.custom_branch_policies !== true) {
      refineCtx.addIssue({
        code: "custom",
        path: ["deployment_branch_policies"],
        message: `the "${entry.name}" entry declares deployment_branch_policies, so it must also declare deployment_branch_policy with custom_branch_policies: true - GitHub rejects every pattern write while the flag is off`,
      });
    }
  })
  .describe("One deployment environment, matched by name.")
  .meta({
    id: "EnvironmentConfig",
    if: { required: ["deployment_branch_policies"] },
    // biome-ignore lint/suspicious/noThenProperty: `then` is the JSON Schema conditional keyword paired with `if` above, not a thenable
    then: {
      required: ["deployment_branch_policy"],
      properties: {
        deployment_branch_policy: {
          type: "object",
          required: ["custom_branch_policies"],
          properties: { custom_branch_policies: { const: true } },
        },
      },
    },
  });
export type EnvironmentConfig = z.infer<typeof EnvironmentConfig>;

/**
 * The `environments:` document slice: the entry list plus the pinned-cap
 * invariant. The cap lives in the slice like the flag pairing above: upfront
 * document validation rejects the document in BOTH modes before ANY section
 * writes, where a hook-level check would fire only mid-run.
 */
export const EnvironmentsConfig = z.array(EnvironmentConfig).superRefine((entries, refineCtx) => {
  const pinnedIndexes = entries.flatMap((entry, index) => (entry.pinned === true ? [index] : []));
  if (pinnedIndexes.length > MAX_PINNED_ENVIRONMENTS) {
    refineCtx.addIssue({
      code: "custom",
      path: [pinnedIndexes[MAX_PINNED_ENVIRONMENTS] as number, "pinned"],
      message: `the settings file declares ${pinnedIndexes.length} environments with pinned: true, but GitHub allows at most ${MAX_PINNED_ENVIRONMENTS} pinned environments per repository. Declare pinned: true on at most ${MAX_PINNED_ENVIRONMENTS} entries`,
    });
  }
});

/**
 * The per-environment keys ROUTED to their own API operations instead of the
 * environment PUT body - each is a scalar the PUT does not accept, applied
 * through a dedicated call after the PUT. This type is where routed-ness
 * is DECLARED: environments' index.ts pins its ROUTED_SCALAR_KEYS strip list
 * to these keys in both directions (the NESTED_KEYS lockstep pattern), so a
 * key added here without strip handling - or stripped without being declared
 * here - fails to compile. A routed scalar belongs here, never among the
 * plain EnvironmentConfig fields, or it would ride the passthrough PUT
 * verbatim and configure nothing.
 */
export type EnvironmentRoutedScalars = Pick<EnvironmentConfig, "pinned">;
