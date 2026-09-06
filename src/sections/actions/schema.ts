/** The `actions:` section's schema slice; root src/schema.ts composes the SettingsFile property from it. */

import { z } from "zod";

export const ActionsConfig = z
  .object({
    enabled: z.boolean().optional(),
    allowed_actions: z.enum(["all", "local_only", "selected"]).optional(),
    selected_actions: z.record(z.string(), z.unknown()).optional(),
    default_workflow_permissions: z.enum(["read", "write"]).optional(),
    can_approve_pull_request_reviews: z.boolean().optional(),
    access_level: z.enum(["none", "user", "organization"]).optional(),
    artifact_and_log_retention: z.object({ days: z.number() }).optional(),
    // STRICT, unlike its siblings: each cache limit is the entire body of
    // its own endpoint, so an unrecognized cache key has no passthrough
    // destination and can only be a typo.
    cache: z
      .strictObject({
        max_cache_retention_days: z.number().optional(),
        max_cache_size_gb: z.number().optional(),
      })
      .optional(),
    oidc_customization_sub: z
      .object({
        use_default: z.boolean(),
        include_claim_keys: z.array(z.string()).optional(),
        use_immutable_subject: z.boolean().optional(),
      })
      .optional(),
    fork_pr_contributor_approval: z.object({ approval_policy: z.string() }).optional(),
    fork_pr_workflows_private_repos: z
      .object({
        run_workflows_from_fork_pull_requests: z.boolean(),
        send_write_tokens_to_workflows: z.boolean(),
        send_secrets_and_variables: z.boolean(),
        require_approval_for_fork_pr_workflows: z.boolean(),
      })
      .optional(),
  })
  .superRefine((declared, refineCtx) => {
    // The policy-allowlist contradiction lives HERE, in the shape, not in plan(): upfront
    // document validation rejects the document in BOTH modes before ANY section writes, where a
    // plan-time throw would fire after earlier sections already wrote (the environments precedent).
    if (declared.selected_actions === undefined || declared.allowed_actions === undefined) {
      return;
    }
    if (declared.allowed_actions !== "selected") {
      refineCtx.addIssue({
        code: "custom",
        path: ["selected_actions"],
        message: `selected_actions is declared together with allowed_actions: "${declared.allowed_actions}", but an allowlist only applies under allowed_actions: "selected". Set allowed_actions to "selected", or remove selected_actions`,
      });
    }
  })
  .meta({ id: "ActionsConfig" });
export type ActionsConfig = z.infer<typeof ActionsConfig>;
