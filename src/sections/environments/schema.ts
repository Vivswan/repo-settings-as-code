/**
 * The `environments:` section's schema slice; root src/schema.ts composes
 * the SettingsFile property from it. Imports only zod and the leaf shared
 * helpers - never root schema.ts (a cycle whose top-level const evaluation
 * TDZ-crashes at import time).
 */

import { z } from "zod";
import { knobbed } from "../shared/schema-helpers.js";

export const DeploymentBranchPolicyConfig = z
  .object({
    name: z.string(),
    // Checked as a plain string at runtime (the handler compares it against
    // the live pattern): GitHub stays the authority on its values, and the
    // published schema documents the upstream enum through the meta.
    type: z
      .string()
      .optional()
      .meta({ enum: ["branch", "tag"] }),
  })
  .meta({ id: "DeploymentBranchPolicyConfig" });
export type DeploymentBranchPolicyConfig = z.infer<typeof DeploymentBranchPolicyConfig>;

export const DeploymentProtectionRuleConfig = z
  .strictObject({
    app: z.string(),
  })
  .meta({ id: "DeploymentProtectionRuleConfig" });
export type DeploymentProtectionRuleConfig = z.infer<typeof DeploymentProtectionRuleConfig>;

export const EnvironmentVariableConfig = z
  .object({
    name: z.string(),
    value: z.string(),
  })
  .meta({ id: "EnvironmentVariableConfig" });
export type EnvironmentVariableConfig = z.infer<typeof EnvironmentVariableConfig>;

export const EnvironmentSecretConfig = z
  .strictObject({
    name: z.string(),
    value: z.string(),
  })
  .meta({ id: "EnvironmentSecretConfig" });
export type EnvironmentSecretConfig = z.infer<typeof EnvironmentSecretConfig>;

/**
 * GitHub's hard cap on pinned environments per repository, shared by the
 * shape's upfront cap check and the environments handler's pin planning.
 */
export const MAX_PINNED_ENVIRONMENTS = 10;

export const EnvironmentConfig = z
  .object({
    name: z.string(),
    // A ROUTED SCALAR (see EnvironmentRoutedScalars), never part of the PUT
    // body: the environments handler strips it and applies it through the
    // GraphQL pin mutations after every PUT.
    pinned: z.boolean().optional(),
    wait_timer: z.number().optional(),
    prevent_self_review: z.boolean().optional(),
    reviewers: z.array(z.object({ type: z.enum(["User", "Team"]), id: z.number() })).optional(),
    deployment_branch_policy: z
      .object({
        protected_branches: z.boolean(),
        custom_branch_policies: z.boolean(),
      })
      .nullable()
      .optional(),
    deployment_branch_policies: knobbed(DeploymentBranchPolicyConfig).optional(),
    deployment_protection_rules: knobbed(DeploymentProtectionRuleConfig).optional(),
    variables: knobbed(EnvironmentVariableConfig).optional(),
    secrets: knobbed(EnvironmentSecretConfig).optional(),
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
