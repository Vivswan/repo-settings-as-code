/** The `actions:` section's schema slice; root src/schema.ts composes the SettingsFile property from it. */

import { z } from "zod";

export const ActionsConfig = z
  .object({
    enabled: z
      .boolean()
      .optional()
      .describe("PUT /repos/{r}/actions/permissions: whether Actions runs at all."),
    allowed_actions: z
      .enum(["all", "local_only", "selected"])
      .optional()
      .describe('Which actions may run; "selected" pairs with selected_actions below.'),
    selected_actions: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("PUT /repos/{r}/actions/permissions/selected-actions (allowed_actions: selected)"),
    default_workflow_permissions: z
      .enum(["read", "write"])
      .optional()
      .describe("PUT /repos/{r}/actions/permissions/workflow: the default GITHUB_TOKEN grant."),
    can_approve_pull_request_reviews: z
      .boolean()
      .optional()
      .describe("Whether workflows may approve pull request reviews."),
    access_level: z
      .enum(["none", "user", "organization"])
      .optional()
      .describe("PUT /repos/{r}/actions/permissions/access (private repositories only)"),
    artifact_and_log_retention: z
      .object({ days: z.number() })
      .optional()
      .describe(
        "PUT /repos/{r}/actions/permissions/artifact-and-log-retention: how many days artifacts and workflow logs are kept, e.g. { days: 90 }. The body passes through verbatim, so future fields GitHub adds work unchanged.",
      ),
    // STRICT, unlike its siblings: each cache limit is the entire body of
    // its own endpoint, so an unrecognized cache key has no passthrough
    // destination and can only be a typo.
    cache: z
      .strictObject({
        max_cache_retention_days: z.number().optional(),
        max_cache_size_gb: z.number().optional(),
      })
      .optional()
      .describe(
        "Actions cache limits, each key routed to its own endpoint: max_cache_retention_days " +
          "-> PUT /repos/{r}/actions/cache/retention-limit, max_cache_size_gb -> PUT " +
          "/repos/{r}/actions/cache/storage-limit. Keys other than these two are rejected (each " +
          "limit has its own single-field endpoint, so an extra key could only be a typo).",
      ),
    oidc_customization_sub: z
      .object({
        use_default: z.boolean(),
        include_claim_keys: z.array(z.string()).optional(),
        use_immutable_subject: z.boolean().optional(),
      })
      .optional()
      .describe(
        "PUT /repos/{r}/actions/oidc/customization/sub: the OIDC subject claim template for " +
          "this repository's workflow tokens, e.g. { use_default: false, include_claim_keys: " +
          "[repo, context] } (keys must be unique). Claim-key ORDER defines the subject format, " +
          "so check mode compares a declared list positionally; an omitted list on a custom " +
          "template opts into the organization template and is not compared. " +
          "use_immutable_subject switches the whole subject to the stable repository-ID-based " +
          "format; omitted, the organization setting or the repository's creation date decides, " +
          "and only a declared value is compared. Unlike the rest of this section, these " +
          'endpoints need the "Actions" PAT permission rather than Administration.',
      ),
    fork_pr_contributor_approval: z
      .object({ approval_policy: z.string() })
      .optional()
      .describe(
        "PUT /repos/{r}/actions/permissions/fork-pr-contributor-approval: when workflows " +
          "triggered by fork pull requests need a maintainer's approval before they run, e.g. { " +
          "approval_policy: first_time_contributors }. The policies GitHub accepts today are " +
          "first_time_contributors_new_to_github, first_time_contributors, and " +
          "all_external_contributors. The body passes through verbatim, so future fields GitHub " +
          "adds work unchanged.",
      ),
    fork_pr_workflows_private_repos: z
      .object({
        run_workflows_from_fork_pull_requests: z.boolean(),
        send_write_tokens_to_workflows: z.boolean(),
        send_secrets_and_variables: z.boolean(),
        require_approval_for_fork_pr_workflows: z.boolean(),
      })
      .optional()
      .describe(
        "PUT /repos/{r}/actions/permissions/fork-pr-workflows-private-repos: whether pull " +
          "requests from forks may run workflows on this private repository, and what those " +
          "workflows receive. All four toggles are required: GitHub does not document whether " +
          "the PUT preserves or resets an omitted toggle, so the file declares the complete " +
          "policy - which is also the posture that leaves no toggle unwatched. The body passes " +
          "through verbatim, so future fields GitHub adds work unchanged.",
      ),
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
  .describe("GitHub Actions settings, routed to the right endpoint by key.")
  .meta({ id: "ActionsConfig" });
export type ActionsConfig = z.infer<typeof ActionsConfig>;
