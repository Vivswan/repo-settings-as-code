import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints:
      "classic branch protection + required-signatures sub-endpoint + app-by-slug actor lookup " +
      "+ GraphQL BranchProtectionRules + BranchProtectionRepository + " +
      "BranchProtectionActorUser + BranchProtectionActorTeam + CreateBranchProtectionRule + " +
      "UpdateBranchProtectionRule + DeleteBranchProtectionRule",
    notes:
      "`protection: null` removes protection; the protection PUT drops `required_signatures`, " +
      "so declare it on any branch already carrying it; `force_push_bypassers` (users, " +
      "`org/team`, `app/slug`) and `required_deployments` ride the GraphQL rule mutation; " +
      "wildcard entries (`release/*`) reconcile entirely through GraphQL with a fixed key set; " +
      "add Contents: read so check mode can tell a missing branch from an unprotected one",
  },
  coverage: [
    {
      area: "[Classic branch protection](https://docs.github.com/en/rest/branches/branch-protection) (literal branches, wildcard patterns, force-push bypass actors, required deployments)",
      notes:
        "PUT /repos/{owner}/{repo}/branches/{branch}/protection passthrough; the four required " +
        "keys are null-filled; protection: null issues DELETE (deleteBranchProtectionRule for " +
        "a wildcard entry). Check mode flattens the GET shape ({enabled} wrappers, actor " +
        "objects -> login/slug strings, *_url dropped) to compare like with like " +
        "(src/sections/branches/index.ts flattenProtection). Every write is drift-gated: the " +
        "PUT is planned when a declared key diverges or when the replacing PUT would remove a " +
        "live setting the file omits, and a converged branch plans nothing. Three routed keys " +
        "never ride the PUT: required_signatures (the PUT silently drops it) goes through its " +
        "own POST/DELETE .../protection/required_signatures sub-endpoint when it drifts and " +
        "again after any planned PUT (declared true POSTs, false DELETEs, undeclared " +
        "untouched; a GET that omits the field reads as false; GitHub does not document " +
        "whether the PUT preserves an existing requirement, so declare the toggle on any " +
        "branch that carries one), while force_push_bypassers and required_deployments are " +
        "REST-invisible entirely and ride ONE updateBranchProtectionRule GraphQL mutation on " +
        "the same terms. force_push_bypassers is a list of actor strings - a bare login is a " +
        'user, "org/team-slug" a team, "app/slug" a GitHub App - resolved to node ids when ' +
        "apply executes, ahead of the section's first write, so a misspelled actor fails " +
        "before any write lands (check mode issues no lookup and reports the drift): users and " +
        "teams through GraphQL (the BranchProtectionActorUser and BranchProtectionActorTeam " +
        "lookups, new-format ids), Apps through the public GET /apps/{app_slug} REST lookup, " +
        "whose node_id can still be the legacy format for old Apps (GitHub accepts it with a " +
        "deprecation warning). required_deployments takes {environments: [...]}; declaring " +
        "null turns the requirement off, an absent key leaves the live state untouched. CAVEAT " +
        "(verified live): GitHub SILENTLY drops required-deployment environment names that do " +
        "not exist while the mutation succeeds, so apply verifies the mutation's read-back " +
        "and fails loudly naming any dropped name - the environments section runs before " +
        "branches, so environments declared in the same file exist by then. WILDCARD entries " +
        "(a name containing `*`, `?`, or `[`, e.g. release/*) are invisible to the REST " +
        "endpoints (their docs point wildcard use at the GraphQL API), so they reconcile " +
        "entirely through the " +
        "createBranchProtectionRule/updateBranchProtectionRule/deleteBranchProtectionRule " +
        "mutations (a create addresses the repository node id the BranchProtectionRepository " +
        "query fetches) against the Repository.branchProtectionRules read; a wildcard " +
        "protection accepts exactly the keys this section can round-trip through the GraphQL " +
        "rule surface - enforce_admins (its isAdminEnforced twin live-verified bidirectionally " +
        "against the REST view of the same rule), required_linear_history, allow_force_pushes, " +
        "allow_deletions, block_creations, required_conversation_resolution, lock_branch, " +
        "allow_fork_syncing, required_signatures, required_status_checks (strict, contexts), " +
        "required_pull_request_reviews (required_approving_review_count, " +
        "require_code_owner_reviews, dismiss_stale_reviews, require_last_push_approval), " +
        "force_push_bypassers, required_deployments - and rejects anything else upfront (the " +
        "actor-list controls have GraphQL fields but their REST vocabulary of database ids " +
        "does not round-trip through node-id-based reads, so this section does not manage them " +
        "on wildcard rules), pointing at rulesets as the recommended path for new " +
        "configuration. The rules query fires only when an entry has a wildcard name or " +
        "declares a GraphQL-routed key (a pure-REST declaration issues no GraphQL request), " +
        "which also scopes the undeclared-rule NOTE: only a run whose declaration fires the " +
        "query reports a live wildcard rule the file does not declare, as a note and never a " +
        "deletion; wildcard updates have PATCH semantics (an omitted key keeps its live value, " +
        "unlike the literal PUT's replace). Actor and environment names compare " +
        "case-insensitively (GitHub canonicalizes them), and the routed lists reject duplicate " +
        "names upfront.",
    },
  ],
};
