import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints:
      "PUT environments + per-environment variables, secrets, deployment branch policies, deployment protection rules, and pins (GraphQL EnvironmentPins + PinEnvironment + ReorderEnvironment)",
    notes:
      "reviewers, wait timer, branch-policy flags; nested `variables`, `secrets`, " +
      "`deployment_branch_policies`, and `deployment_protection_rules` keys reconcile per " +
      "environment, each with its own `undeclared:` knob (within a declared key, undeclared " +
      "variables and branch-policy patterns are deleted; secrets and protection rules are " +
      "kept); a `pinned` key pins the environment on the home page's deployments sidebar over " +
      "GraphQL (declaration order sets the pin order, max 10 pins; environments without the " +
      "key are never unpinned)",
  },
  coverage: [
    {
      area:
        "[Environments](https://docs.github.com/en/rest/deployments/environments) (wait_timer, " +
        "reviewers, prevent_self_review, deployment_branch_policy " +
        "protected_branches/custom_branch_policies flags), their [Actions " +
        "variables](https://docs.github.com/en/rest/actions/variables), their [Actions " +
        "secrets](https://docs.github.com/en/rest/actions/secrets), their [deployment branch " +
        "policies](https://docs.github.com/en/rest/deployments/branch-policies) (custom " +
        "patterns), and their [custom deployment protection " +
        "rules](https://docs.github.com/en/rest/deployments/protection-rules) (GitHub App gates)",
      notes:
        "PUT /repos/{owner}/{repo}/environments/{name} passthrough; check mode flattens GET's " +
        "protection_rules[] back into the PUT shape. A declared per-environment `variables` " +
        "key reconciles that environment's Actions variables AFTER the PUT, through GET/POST " +
        "/repos/{owner}/{repo}/environments/{name}/variables and PATCH/DELETE " +
        ".../variables/{name}: create missing, update divergent values, and delete undeclared " +
        "ones by default (the wrapped `undeclared: keep` form keeps them as notes); names " +
        "match case-insensitively, values are plain text by design. A declared per-environment " +
        "`secrets` key reconciles that environment's Actions secrets the same way the shipped " +
        "secret sections do - GET .../environments/{name}/secrets (names + timestamps), GET " +
        ".../secrets/public-key, sealed PUT/DELETE .../secrets/{secret_name} - one sealing " +
        "scope per environment, so same-named secrets in sibling environments resolve " +
        "independently; undeclared secrets within a declared key are KEPT by default (values " +
        "unrecoverable; `undeclared: delete` opts in). A declared per-environment " +
        "`deployment_branch_policies` key reconciles that environment's custom branch-policy " +
        "patterns through GET/POST .../environments/{name}/deployment-branch-policies and " +
        "DELETE .../deployment-branch-policies/{branch_policy_id}: create missing patterns, " +
        "delete undeclared ones by default (`undeclared: keep` softens to notes), and replace " +
        "a matching pattern whose type differs (type is immutable upstream, so the change is " +
        "delete + recreate; the upstream PUT is deliberately unused - its body is the name " +
        "alone, and the name is the pattern's identity, so it can never help reconciliation). " +
        "Declaring the key requires the singular `deployment_branch_policy` sibling with " +
        "custom_branch_policies: true (rejected upfront otherwise, since the pattern writes " +
        "would 404 only after the environment PUT landed), and its endpoints sit outside the " +
        "Environments PAT permission: the list read needs Actions read, the writes need " +
        "Administration write. A declared per-environment `deployment_protection_rules` key " +
        "reconciles that environment's custom deployment protection rules (GitHub App gates) " +
        "through GET/POST .../environments/{name}/deployment_protection_rules (the list " +
        "documents NO pagination, so it is fetched in one call; the POST body is " +
        "{integration_id}) and DELETE .../deployment_protection_rules/{protection_rule_id}: " +
        "enable/disable ONLY, since GitHub offers no update call. Rules are declared by App " +
        "slug and resolved to the integration id at apply time via ONE GET " +
        ".../deployment_protection_rules/apps fetch (made only when a declared rule is " +
        "missing; a slug the listing does not carry is a hard error naming the available " +
        "slugs). Undeclared rules within a declared key are KEPT by default - Apps can enable " +
        "themselves as gates, and silently disabling a deployment gate is security-relevant - " +
        "with `undeclared: delete` opting into disabling; these endpoints also sit outside the " +
        "Environments PAT permission (the enabled-rules list under Actions read, the Apps read " +
        "and both writes under Administration). In check mode against a missing environment " +
        "the declared variables, secrets, patterns, and protection rules cannot be listed, so " +
        "notes say they are unverifiable until it exists; against a live environment whose " +
        "custom_branch_policies flag is off, the patterns earn the same note while the flag " +
        "drift comes from the environment diff. A declared per-environment `pinned` key " +
        "reconciles the repository's pinned deployments sidebar over POST /graphql, AFTER " +
        "every environment PUT - each mutation addresses the node_id the environment PUT/GET " +
        "bodies already carry, so no extra lookup is made. The live pins read back through the " +
        "repository's pinnedEnvironments connection (the EnvironmentPins query), where the " +
        "ordering is the 1-based `position` field ON THE PinnedEnvironment NODE (it does not " +
        "live on the Environment object) - and, verified against live GitHub, those numbers " +
        "may be NON-CONTIGUOUS: unpinning leaves a hole, a new pin appends at the tail via a " +
        "monotonic counter, and only a reorder renormalizes the list. Positions are therefore " +
        "consumed as a sort key only, and reconciliation compares RANK ORDER: the entries " +
        "declaring pinned: true must LEAD the pinned list in settings-file declaration order. " +
        "pinEnvironment ({environmentId, pinned}) pins a missing pin (tail append) and unpins " +
        "a pinned: false entry, reorderEnvironment ({environmentId, position}) pulls a " +
        "divergent pin left into its declared rank; unpins are issued before pins, so a swap " +
        "can never transiently exceed GitHub's cap of 10 pins (more than 10 declared pinned: " +
        "true entries are rejected upfront, and a final count that would overflow the cap - " +
        "live pins nobody declared count toward it - fails BEFORE the first pin mutation, " +
        "naming the cap and the way to make room; check mode surfaces the same overflow as a " +
        "note). Pins with no pinned declaration - undeclared environments, or entries without " +
        "the key - are never unpinned; one sitting among the leading ranks is moved after the " +
        "declared block, surfaced as a note in BOTH modes so check and apply agree exactly. " +
        "Everything reads back, so check mode reports exact pin membership and order drift " +
        "(the order line names both sequences). Undeclared environments are left untouched.",
    },
  ],
};
