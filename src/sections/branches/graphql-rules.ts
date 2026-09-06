/**
 * The GraphQL BranchProtectionRule surface of the `branches:` section: the
 * classic-to-GraphQL translation vocabulary, the rules read and the three
 * rule mutations, the per-run working state (live rules, actor and repository
 * node ids), and the two plan steps that ride the mutations - a wildcard
 * entry's whole reconciliation and a literal entry's routed keys
 * (force_push_bypassers, required_deployments). index.ts owns the REST
 * protection surface and decides which entries reach this module.
 */

import { subsetDiff } from "../../engine/diff.js";
import { repoVariables } from "../contract/endpoints.js";
import { type GraphqlOpDecl, graphqlOp } from "../contract/graphql.js";
import type { ExecTools, Late, PlanContext, PlannedOp, SectionPlan } from "../contract/plan.js";
import type { ENDPOINTS } from "./endpoints.js";
import { type BranchConfig, type BranchProtectionConfig, parseBypassActor } from "./schema.js";

// --- The classic-to-GraphQL vocabulary -------------------------------------
//
// A wildcard entry keeps the classic snake_case protection vocabulary; these
// tables are its EXPLICIT translation to the BranchProtectionRule mutation
// inputs, verified field for field against GitHub's published schema by
// test/sections/graphql-queries.test.ts, whose twin-superset test asserts
// the rules query below selects every twin.
// The e2e mock imports them to project stored REST state into GraphQL rule
// nodes, so the two views cannot drift.

/** Classic boolean toggles with a same-meaning GraphQL rule field. */
export const GRAPHQL_BOOLEAN_TWINS = {
  enforce_admins: "isAdminEnforced",
  required_linear_history: "requiresLinearHistory",
  allow_force_pushes: "allowsForcePushes",
  allow_deletions: "allowsDeletions",
  block_creations: "blocksCreations",
  required_conversation_resolution: "requiresConversationResolution",
  lock_branch: "lockBranch",
  allow_fork_syncing: "lockAllowsFetchAndMerge",
  required_signatures: "requiresCommitSignatures",
} as const;

/** required_pull_request_reviews sub-keys with a GraphQL twin. */
export const GRAPHQL_REVIEW_TWINS = {
  required_approving_review_count: "requiredApprovingReviewCount",
  require_code_owner_reviews: "requiresCodeOwnerReviews",
  dismiss_stale_reviews: "dismissesStaleReviews",
  require_last_push_approval: "requireLastPushApproval",
} as const;

/** required_status_checks sub-keys with a GraphQL twin. */
export const GRAPHQL_STATUS_CHECK_TWINS = {
  strict: "requiresStrictStatusChecks",
  contexts: "requiredStatusCheckContexts",
} as const;

/** Every protection key a WILDCARD entry may declare. */
export const WILDCARD_KEYS = [
  ...Object.keys(GRAPHQL_BOOLEAN_TWINS),
  "required_status_checks",
  "required_pull_request_reviews",
  "force_push_bypassers",
  "required_deployments",
] as const;

export const WILDCARD_KEY_SET: ReadonlySet<string> = new Set(WILDCARD_KEYS);

// --- GraphQL operations -------------------------------------------------------

/**
 * The one rules read: every classic rule (literal and wildcard patterns
 * alike - classic protection IS a BranchProtectionRule upstream), selecting
 * the node id, every translation-table twin, and the force-push allowance
 * actors. Fired only when an entry has a wildcard name or declares a
 * GraphQL-routed key. NOT_FOUND is a tolerated outcome so a fine-grained
 * denial reads as "no rules visible", preserving the section's
 * denial-surfaces-at-the-first-write semantics.
 */
const RULES_QUERY = graphqlOp<{ owner: string; repo: string }>()({
  name: "BranchProtectionRules",
  kind: "read",
  connection: { path: ["repository", "branchProtectionRules"] },
  outcomes: {
    ok: "the repository's classic branch protection rules",
    NOT_FOUND: "the repository is not visible to the token; read as no rules",
  },
  query: `query BranchProtectionRules($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    branchProtectionRules(first: 100, after: $cursor) {
      nodes {
        id
        pattern
        isAdminEnforced
        requiresLinearHistory
        allowsForcePushes
        allowsDeletions
        blocksCreations
        requiresConversationResolution
        lockBranch
        lockAllowsFetchAndMerge
        requiresCommitSignatures
        requiresStatusChecks
        requiresStrictStatusChecks
        requiredStatusCheckContexts
        requiresApprovingReviews
        requiredApprovingReviewCount
        requiresCodeOwnerReviews
        dismissesStaleReviews
        requireLastPushApproval
        requiresDeployments
        requiredDeploymentEnvironments
        bypassForcePushAllowances(first: 100) {
          nodes {
            actor {
              __typename
              ... on User { login }
              ... on Team { combinedSlug }
              ... on App { slug }
            }
          }
          pageInfo { hasNextPage }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`,
});

/**
 * The repository's GraphQL node id, needed only to CREATE a wildcard rule.
 * Execution-phase, like the two actor lookups: a fine-grained denial answers
 * NOT_FOUND, which none of the three tolerates, so they may only run where
 * the section's posture puts the denial - at the first write.
 */
const REPO_LOOKUP = graphqlOp<{ owner: string; repo: string }>()({
  name: "BranchProtectionRepository",
  kind: "read",
  phase: "execution",
  outcomes: { ok: "the repository's GraphQL node id" },
  query: `query BranchProtectionRepository($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) { id }
}`,
});

/**
 * A user actor's NEW-format node id. REST /users/{username} can still carry
 * a legacy node_id for old accounts (the mutation would answer a deprecation
 * warning), so users resolve through GraphQL. The repository selection also
 * routes the read (every repo-addressed read takes $owner/$repo).
 */
const ACTOR_USER = graphqlOp<{ owner: string; repo: string; login: string }>()({
  name: "BranchProtectionActorUser",
  kind: "read",
  phase: "execution",
  outcomes: {
    ok: "the user's node id",
    NOT_FOUND: "no user with this login, or the token cannot see it",
  },
  denialHint:
    "a denial here can also mean the declared force_push_bypassers actor does not exist; check the actor spelling in the settings file",
  query: `query BranchProtectionActorUser($owner: String!, $repo: String!, $login: String!) {
  repository(owner: $owner, name: $repo) { id }
  user(login: $login) { id }
}`,
});

/** A team actor's node id, addressed as organization login plus team slug. */
const ACTOR_TEAM = graphqlOp<{ owner: string; repo: string; org: string; team: string }>()({
  name: "BranchProtectionActorTeam",
  kind: "read",
  phase: "execution",
  outcomes: {
    ok: "the team's node id",
    NOT_FOUND: "no organization with this login, or the token cannot see it",
  },
  denialHint:
    "a denial here can also mean the declared force_push_bypassers actor's organization does not exist; check the actor spelling in the settings file",
  query: `query BranchProtectionActorTeam($owner: String!, $repo: String!, $org: String!, $team: String!) {
  repository(owner: $owner, name: $repo) { id }
  organization(login: $org) { team(slug: $team) { id } }
}`,
});

/**
 * The three rule mutations. Each payload re-reads the persisted rule, so
 * selecting requiredDeploymentEnvironments IS the post-mutation read-back
 * the silent-drop check needs (GitHub drops names of environments that do
 * not exist without failing the mutation).
 */
const CREATE_RULE = graphqlOp<{ input: Record<string, unknown> }>()({
  name: "CreateBranchProtectionRule",
  kind: "write",
  outcomes: {
    ok: "rule created",
    UNPROCESSABLE: "GitHub rejected the rule (e.g. a duplicate pattern)",
  },
  query: `mutation CreateBranchProtectionRule($input: CreateBranchProtectionRuleInput!) {
  createBranchProtectionRule(input: $input) {
    branchProtectionRule { id pattern requiresDeployments requiredDeploymentEnvironments }
  }
}`,
});

const UPDATE_RULE = graphqlOp<{ input: Record<string, unknown> }>()({
  name: "UpdateBranchProtectionRule",
  kind: "write",
  outcomes: {
    ok: "rule updated",
    NOT_FOUND: "no rule with this node id",
    UNPROCESSABLE: "GitHub rejected the update",
  },
  query: `mutation UpdateBranchProtectionRule($input: UpdateBranchProtectionRuleInput!) {
  updateBranchProtectionRule(input: $input) {
    branchProtectionRule { id pattern requiresDeployments requiredDeploymentEnvironments }
  }
}`,
});

const DELETE_RULE = graphqlOp<{ input: Record<string, unknown> }>()({
  name: "DeleteBranchProtectionRule",
  kind: "write",
  outcomes: { ok: "rule deleted", NOT_FOUND: "no rule with this node id" },
  query: `mutation DeleteBranchProtectionRule($input: DeleteBranchProtectionRuleInput!) {
  deleteBranchProtectionRule(input: $input) { clientMutationId }
}`,
});

export const GRAPHQL = {
  rulesQuery: RULES_QUERY,
  repoLookup: REPO_LOOKUP,
  actorUser: ACTOR_USER,
  actorTeam: ACTOR_TEAM,
  createRule: CREATE_RULE,
  updateRule: UPDATE_RULE,
  deleteRule: DELETE_RULE,
} as const satisfies Record<string, GraphqlOpDecl>;

/** True when the entry declares a key that must ride the rule mutation. */
export function hasRoutedGraphqlKeys(protection: BranchProtectionConfig | null): boolean {
  return (
    protection !== null &&
    (protection.force_push_bypassers !== undefined || protection.required_deployments !== undefined)
  );
}

/** One live rule node as the rules query returns it. */
type RuleNode = Record<string, unknown>;

/**
 * The live rules by pattern, or null when the rules query answered its
 * tolerated NOT_FOUND: the view is unreadable, which is not the same as
 * empty - a declared routed key must not read as clean against it.
 */
type LiveRules = Map<string, RuleNode> | null;

/** Per-run GraphQL working state: the rules by pattern, and the two caches. */
export interface GraphqlRun {
  rules: LiveRules;
  repoId: string | null;
  actorIds: Map<string, string>;
  /**
   * Every bypass actor a planned mutation resolves at execution, appended
   * by ruleVariables() as it seals one; plan() resolves them all ahead of
   * the FIRST write, whichever entry they belong to.
   */
  lateActors: string[];
}

/** The plan context over this section's literal dictionaries. */
export type BranchesContext = PlanContext<typeof ENDPOINTS, typeof GRAPHQL>;

/** The plan this section returns, its operations typed over its own roles. */
export type BranchesPlan = SectionPlan<PlannedOp<typeof ENDPOINTS, typeof GRAPHQL>>;

export async function fetchRules(ctx: BranchesContext): Promise<LiveRules> {
  const read = await ctx.read.rulesQuery.listConnection(repoVariables(ctx));
  if ("error" in read) {
    // The one tolerated outcome is the declared NOT_FOUND: a fine-grained
    // denial reads as "rules not visible" (the probeAbsent posture), so the
    // denial surfaces at the first write instead of here.
    return null;
  }
  const byPattern = new Map<string, RuleNode>();
  for (const node of read.items) {
    if (typeof node === "object" && node !== null) {
      const rule = node as RuleNode;
      // The nested allowance connection is read in one 100-node page; a rule
      // beyond that would silently truncate, so check would report phantom
      // drift and apply would shrink the live list. Fail loudly instead.
      const allowances = rule.bypassForcePushAllowances as
        | { pageInfo?: { hasNextPage?: unknown } }
        | undefined;
      if (allowances?.pageInfo?.hasNextPage === true) {
        throw new Error(
          `branches: the live protection rule "${String(rule.pattern)}" allows more than 100 force-push bypass actors, which this section cannot read back completely; trim the live allowance list below 100 to manage it here`,
        );
      }
      byPattern.set(String(rule.pattern), rule);
    }
  }
  return byPattern;
}

/** The live allowance actors of a rule, flattened back to the declared strings. */
export function bypassActorStrings(node: RuleNode): string[] {
  const allowances = (node.bypassForcePushAllowances as { nodes?: unknown } | undefined)?.nodes;
  if (!Array.isArray(allowances)) {
    return [];
  }
  const out: string[] = [];
  for (const allowance of allowances) {
    const actor = (allowance as { actor?: Record<string, unknown> } | null)?.actor;
    if (!actor) {
      continue;
    }
    if (typeof actor.login === "string") {
      out.push(actor.login);
    } else if (typeof actor.combinedSlug === "string") {
      out.push(actor.combinedSlug);
    } else if (typeof actor.slug === "string") {
      out.push(`app/${actor.slug}`);
    }
  }
  return out;
}

/**
 * Project a live rule node back into the classic snake_case vocabulary, the
 * inverse of translateWildcardProtection: check mode diffs declared keys
 * against this view, and the e2e state test proves the mock's projection of
 * REST state round-trips through it. The two structured keys collapse to
 * null when their umbrella boolean is off - the declared PUT vocabulary's
 * spelling of "off". The real REST GET OMITS an off control entirely
 * (probe-verified on a GraphQL-created minimal rule) rather than nulling
 * it; subsetDiff reads null, absent, and "" as the same empty value, so
 * the two spellings compare identically and null is kept here for the
 * clearer drift message.
 */
export function classicViewOfRule(node: RuleNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [classic, twin] of Object.entries(GRAPHQL_BOOLEAN_TWINS)) {
    out[classic] = node[twin];
  }
  out.required_status_checks =
    node.requiresStatusChecks === true
      ? {
          strict: node.requiresStrictStatusChecks,
          contexts: Array.isArray(node.requiredStatusCheckContexts)
            ? node.requiredStatusCheckContexts
            : [],
        }
      : null;
  if (node.requiresApprovingReviews === true) {
    const reviews: Record<string, unknown> = {};
    for (const [classic, twin] of Object.entries(GRAPHQL_REVIEW_TWINS)) {
      reviews[classic] = node[twin];
    }
    out.required_pull_request_reviews = reviews;
  } else {
    out.required_pull_request_reviews = null;
  }
  out.force_push_bypassers = [...bypassActorStrings(node)].sort();
  out.required_deployments =
    node.requiresDeployments === true
      ? {
          environments: Array.isArray(node.requiredDeploymentEnvironments)
            ? node.requiredDeploymentEnvironments
            : [],
        }
      : null;
  return out;
}

/**
 * Translate a wildcard entry's classic protection into the rule mutation's
 * input fields (minus the two routed keys, which the caller resolves). Shape
 * validation already restricted the keys, so an unknown key here is a bug.
 */
function translateWildcardProtection(protection: BranchProtectionConfig): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(protection)) {
    if (key === "force_push_bypassers" || key === "required_deployments") {
      continue;
    }
    const booleanTwin = GRAPHQL_BOOLEAN_TWINS[key as keyof typeof GRAPHQL_BOOLEAN_TWINS];
    if (booleanTwin !== undefined) {
      input[booleanTwin] = value;
      continue;
    }
    if (key === "required_status_checks") {
      if (value === null) {
        input.requiresStatusChecks = false;
      } else {
        input.requiresStatusChecks = true;
        const checks = value as Record<string, unknown>;
        for (const [classic, twin] of Object.entries(GRAPHQL_STATUS_CHECK_TWINS)) {
          if (classic in checks) {
            input[twin] = checks[classic];
          }
        }
      }
      continue;
    }
    if (key === "required_pull_request_reviews") {
      if (value === null) {
        input.requiresApprovingReviews = false;
      } else {
        input.requiresApprovingReviews = true;
        const reviews = value as Record<string, unknown>;
        for (const [classic, twin] of Object.entries(GRAPHQL_REVIEW_TWINS)) {
          if (classic in reviews) {
            input[twin] = reviews[classic];
          }
        }
      }
      continue;
    }
    throw new Error(`BUG: wildcard protection key "${key}" escaped shape validation`);
  }
  return input;
}

/** The two mutation input fields the required_deployments key declares. */
function deploymentInputFields(
  declared: NonNullable<BranchProtectionConfig["required_deployments"]> | null,
): Record<string, unknown> {
  if (declared === null) {
    return { requiresDeployments: false, requiredDeploymentEnvironments: [] };
  }
  return { requiresDeployments: true, requiredDeploymentEnvironments: [...declared.environments] };
}

/**
 * Case-insensitive set equality for the two routed-key lists: GitHub
 * canonicalizes actor and environment names, so a declared "Octocat" reads
 * back as "octocat" and must not drift. Duplicates are rejected upfront by
 * the shape, so sorted-lowercase comparison is exact.
 */
function sameNamesFold(declared: readonly string[], live: readonly string[]): boolean {
  if (declared.length !== live.length) {
    return false;
  }
  const a = declared.map((name) => name.toLowerCase()).sort();
  const b = live.map((name) => name.toLowerCase()).sort();
  return a.every((name, i) => name === b[i]);
}

/** The mutation payload field carrying the persisted rule, per mutation. */
type MutationPayloadKey = "createBranchProtectionRule" | "updateBranchProtectionRule";

/**
 * The silent-drop check and its siblings: GitHub accepts
 * requiredDeploymentEnvironments names of environments that do not exist and
 * DROPS them without failing the mutation (verified live), so the mutation
 * payload's re-read is compared against the declaration - a dropped name
 * fails the run loudly with the fix, and any other divergence (the re-read
 * is authoritative) fails with its own message rather than reporting the
 * apply as converged. Names compare case-insensitively (GitHub environment
 * names are). The environments section runs before this one, so environments
 * declared in the same settings file exist by the time this check runs.
 */
function verifyDeploymentReadback(
  entryName: string,
  declared: NonNullable<BranchProtectionConfig["required_deployments"]> | null,
  response: unknown,
  payloadKey: MutationPayloadKey,
): void {
  const payload = (response as Record<string, unknown> | null)?.[payloadKey];
  const rule = (payload as Record<string, unknown> | null | undefined)?.branchProtectionRule as
    | RuleNode
    | null
    | undefined;
  if (typeof rule !== "object" || rule === null) {
    throw new Error(
      `branches[${entryName}].protection.required_deployments: the mutation returned no rule to read back, so the applied deployment requirement cannot be verified; re-run the workflow, and retry later if it persists`,
    );
  }
  const echoed = Array.isArray(rule.requiredDeploymentEnvironments)
    ? (rule.requiredDeploymentEnvironments as unknown[]).map(String)
    : [];
  if (declared === null) {
    if (rule.requiresDeployments === true) {
      throw new Error(
        `branches[${entryName}].protection.required_deployments: declared null (not required) but the rule still requires deployments to [${echoed.join(", ")}] after the mutation; re-run the workflow, and report this if it persists`,
      );
    }
    return;
  }
  const echoedFold = new Set(echoed.map((name) => name.toLowerCase()));
  const dropped = declared.environments.filter((name) => !echoedFold.has(name.toLowerCase()));
  if (dropped.length > 0) {
    throw new Error(
      `branches[${entryName}].protection.required_deployments: GitHub silently dropped [${dropped.join(
        ", ",
      )}] from the required deployment environments because no environment with that name exists on the repository. Declare the environment in this settings file's environments: section (it applies before branches), or create it on the repository first`,
    );
  }
  if (rule.requiresDeployments !== true || !sameNamesFold(declared.environments, echoed)) {
    throw new Error(
      `branches[${entryName}].protection.required_deployments: the settings file requires deployments to [${declared.environments.join(
        ", ",
      )}] but after the mutation the rule ${rule.requiresDeployments === true ? `requires [${echoed.join(", ")}]` : "does not require deployments"}; re-run the workflow, and report this if it persists`,
    );
  }
}

/** Drift lines for the two GraphQL-routed keys, shared by both entry kinds. */
function routedKeyDrift(
  prefix: string,
  protection: BranchProtectionConfig,
  rules: LiveRules,
  pattern: string,
): string[] {
  const drift: string[] = [];
  if (rules === null) {
    // Nothing to compare against: the declared value is written as before
    // the comparison existed, so an unreadable view can never read as clean.
    for (const key of ["force_push_bypassers", "required_deployments"] as const) {
      if (protection[key] !== undefined) {
        drift.push(
          `${prefix}.${key}: the live rule cannot be read (the rules query answered not found); apply will set the declared value`,
        );
      }
    }
    return drift;
  }
  const node = rules.get(pattern);
  const declaredActors = protection.force_push_bypassers;
  if (declaredActors !== undefined) {
    const live = node ? [...bypassActorStrings(node)].sort() : [];
    if (!sameNamesFold(declaredActors, live)) {
      drift.push(
        `${prefix}.force_push_bypassers: the settings file declares [${[...declaredActors].sort().join(", ")}] but the live rule allows [${live.join(
          ", ",
        )}]; apply will replace the allowance list`,
      );
    }
  }
  const declaredDeployments = protection.required_deployments;
  if (declaredDeployments !== undefined) {
    const liveOn = node?.requiresDeployments === true;
    const liveEnvs = (
      Array.isArray(node?.requiredDeploymentEnvironments)
        ? (node.requiredDeploymentEnvironments as unknown[]).map(String)
        : []
    ).sort();
    if (declaredDeployments === null) {
      if (liveOn) {
        drift.push(
          `${prefix}.required_deployments: declared null (not required) but the live rule requires deployments to [${liveEnvs.join(
            ", ",
          )}]; apply will turn the requirement off`,
        );
      }
    } else if (!liveOn || !sameNamesFold(declaredDeployments.environments, liveEnvs)) {
      drift.push(
        `${prefix}.required_deployments: the settings file requires deployments to [${[
          ...declaredDeployments.environments,
        ]
          .sort()
          .join(
            ", ",
          )}] but the live rule ${liveOn ? `requires [${liveEnvs.join(", ")}]` : "does not require deployments"}; apply will set the declared list`,
      );
    }
  }
  return drift;
}

/**
 * Resolve one declared actor string to its GraphQL node id, cached per run
 * under the case-folded string (GitHub canonicalizes actor names, so two
 * spellings are one actor): users and teams through GraphQL (new-format
 * ids), Apps through the public REST lookup (see the appLookup declaration
 * for the legacy-id caveat). The GraphQL reads also select the repository's
 * node id - required anyway to route a repo-addressed read - so a later
 * rule CREATE can reuse it instead of a dedicated lookup.
 */
async function resolveActorId(
  ctx: BranchesContext,
  exec: ExecTools,
  graphqlRun: GraphqlRun,
  raw: string,
): Promise<string> {
  const cacheKey = raw.toLowerCase();
  const cached = graphqlRun.actorIds.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const actor = parseBypassActor(raw);
  if (actor === null) {
    throw new Error(`BUG: force_push_bypassers actor "${raw}" escaped shape validation`);
  }
  let id: unknown;
  if (actor.kind === "user") {
    const data = await ctx.read.actorUser.call(
      exec,
      { ...repoVariables(ctx), login: actor.login },
      { describe: `resolving force-push bypass user "${raw}"` },
    );
    adoptRepoId(graphqlRun, data);
    id = (data.user as Record<string, unknown> | null)?.id;
  } else if (actor.kind === "team") {
    const data = await ctx.read.actorTeam.call(
      exec,
      { ...repoVariables(ctx), org: actor.org, team: actor.team },
      { describe: `resolving force-push bypass team "${raw}"` },
    );
    adoptRepoId(graphqlRun, data);
    const team = (data.organization as Record<string, unknown> | null)?.team as Record<
      string,
      unknown
    > | null;
    if (!team) {
      throw new Error(
        `branches: force_push_bypassers actor "${raw}": the organization "${actor.org}" has no team with slug "${actor.team}" (or the token cannot see it); check the actor spelling in the settings file`,
      );
    }
    id = team.id;
  } else {
    const result = await ctx.read.appLookup.tryCall(exec, {
      params: { app_slug: actor.slug },
      describe: `resolving force-push bypass App "${raw}"`,
    });
    if ("error" in result) {
      throw new Error(
        `branches: force_push_bypassers actor "${raw}": no GitHub App with slug "${actor.slug}" exists; check the actor spelling in the settings file`,
      );
    }
    id = (result.data as Record<string, unknown> | null)?.node_id;
  }
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(
      `branches: force_push_bypassers actor "${raw}": the ${actor.kind === "app" ? "App lookup" : "GraphQL lookup"} succeeded but returned no node id, so the allowance cannot be applied; re-run the workflow, and report this if it persists`,
    );
  }
  graphqlRun.actorIds.set(cacheKey, id);
  return id;
}

/** Keep the repository node id an actor read already carried. */
function adoptRepoId(graphqlRun: GraphqlRun, data: Record<string, unknown>): void {
  const id = (data.repository as Record<string, unknown> | null)?.id;
  if (graphqlRun.repoId === null && typeof id === "string" && id.length > 0) {
    graphqlRun.repoId = id;
  }
}

/**
 * A literal branch's rule id, read at EXECUTION time when the plan-time
 * fetch did not carry it: the PUT planned before this lookup creates the
 * rule, or the fetch could not see a rule the REST view shows.
 */
async function lateRuleId(ctx: BranchesContext, pattern: string): Promise<unknown> {
  const node = (await fetchRules(ctx))?.get(pattern);
  if (node === undefined) {
    throw new Error(
      `branches[${pattern}]: the branch is protected but no branch protection rule with that ` +
        `pattern is visible through GraphQL, so its GraphQL-only fields cannot be set; check ` +
        `that the token can read branch protection rules, re-run the workflow, and report this ` +
        `if it persists`,
    );
  }
  return node.id;
}

/**
 * Resolve a declared actor list to node ids IN DECLARED ORDER, one lookup at
 * a time (the request log stays deterministic), through the per-run cache.
 */
export async function resolveActorIds(
  ctx: BranchesContext,
  exec: ExecTools,
  graphqlRun: GraphqlRun,
  actors: readonly string[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const actor of actors) {
    ids.push(await resolveActorId(ctx, exec, graphqlRun, actor));
  }
  return ids;
}

/** The mutation input fields for a wildcard entry the plan knows up front: every key but the actors. */
function wildcardInput(protection: BranchProtectionConfig): Record<string, unknown> {
  const input = translateWildcardProtection(protection);
  if (protection.required_deployments !== undefined) {
    Object.assign(input, deploymentInputFields(protection.required_deployments));
  }
  return input;
}

/** A rule mutation's variables: a value, or a thunk the executor seals right before the request. */
type RuleVariables = { input: Record<string, unknown> } | Late<{ input: Record<string, unknown> }>;

/**
 * A rule mutation's variables: the plan-time `fields` plus what only the read
 * port supplies at EXECUTION time - the bypass actors' node ids and any id
 * `late` looks up (the repository's, a rule's the PUT ahead creates). Check
 * mode must never issue those lookups: a fine-grained denial answers NOT_FOUND
 * where the section's posture promises the denial surfaces at the first write.
 * A value when nothing is late, so the idempotence proof compares it by field.
 */
function ruleVariables(
  ctx: BranchesContext,
  graphqlRun: GraphqlRun,
  fields: Record<string, unknown>,
  actors: readonly string[] | undefined,
  late?: (exec: ExecTools) => Promise<Record<string, unknown>>,
): RuleVariables {
  if (actors === undefined && late === undefined) {
    return { input: fields };
  }
  if (actors !== undefined) {
    graphqlRun.lateActors.push(...actors);
  }
  // The actors resolve first: their reads select the repository's node id
  // too, which spares a create its dedicated lookup (see adoptRepoId).
  return async (exec) => ({
    input: {
      ...fields,
      ...(actors === undefined
        ? {}
        : { bypassForcePushActorIds: await resolveActorIds(ctx, exec, graphqlRun, actors) }),
      ...(late === undefined ? {} : await late(exec)),
    },
  });
}

/** The repository's node id: one an actor read already carried, else the dedicated lookup. */
async function repositoryNodeId(
  ctx: BranchesContext,
  exec: ExecTools,
  graphqlRun: GraphqlRun,
): Promise<string> {
  if (graphqlRun.repoId === null) {
    const data = await ctx.read.repoLookup.call(exec, repoVariables(ctx), {
      describe: "resolving the repository's GraphQL node id",
    });
    const id = (data.repository as Record<string, unknown> | null)?.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(
        "branches: the repository lookup returned no GraphQL node id, so no protection rule can be created; re-run the workflow and retry if it persists",
      );
    }
    graphqlRun.repoId = id;
  }
  return graphqlRun.repoId;
}

/**
 * A drift list proven non-empty - the justification every planned write
 * carries - or null, in which case nothing is planned.
 */
export function justified(lines: readonly string[]): readonly [string, ...string[]] | null {
  const [first, ...rest] = lines;
  return first === undefined ? null : [first, ...rest];
}

/**
 * An op's change line, rendered only once the mutation's read-back agrees
 * with the declared required_deployments (a throw is the verification
 * failure); the plain line when the entry declares none.
 */
function verifiedChange(
  line: string,
  entryName: string,
  declared: BranchProtectionConfig["required_deployments"],
  payloadKey: MutationPayloadKey,
): string | ((response: unknown) => string) {
  if (declared === undefined) {
    return line;
  }
  return (response) => {
    verifyDeploymentReadback(entryName, declared, response, payloadKey);
    return line;
  };
}

/**
 * Plan a literal entry's rule mutation for its routed keys. Its bypass
 * actors, when declared, seal into the mutation's variables at execution
 * (ruleVariables), and plan() resolves them ahead of the section's first write.
 */
export function planRoutedUpdate(
  ctx: BranchesContext,
  graphqlRun: GraphqlRun,
  plan: BranchesPlan,
  entry: {
    name: string;
    protection: BranchProtectionConfig;
    prefix: string;
    putPlanned: boolean;
  },
): void {
  const { name, protection, prefix, putPlanned } = entry;
  const { force_push_bypassers: forcePushBypassers, required_deployments: requiredDeployments } =
    protection;
  const node = graphqlRun.rules?.get(name);
  const routedKeys = [
    ...(forcePushBypassers === undefined ? [] : ["force_push_bypassers"]),
    ...(requiredDeployments === undefined ? [] : ["required_deployments"]),
  ].join(" and ");
  const routedDrift = routedKeyDrift(prefix, protection, graphqlRun.rules, name);
  if (routedDrift.length === 0 && putPlanned) {
    routedDrift.push(
      `${prefix}: ${routedKeys} re-applied after the protection PUT (GitHub does not document whether the PUT preserves them)`,
    );
  }
  const drift = justified(routedDrift);
  if (drift === null) {
    return;
  }
  const deploymentFields =
    requiredDeployments === undefined ? {} : deploymentInputFields(requiredDeployments);
  plan.ops.push({
    role: "updateRule",
    describe: `setting the GraphQL-only protection fields of branch "${name}"`,
    // A rule the plan-time fetch did not carry (the PUT planned above
    // creates it) is looked up once that operation has run.
    variables:
      node !== undefined
        ? ruleVariables(
            ctx,
            graphqlRun,
            { branchProtectionRuleId: node.id, ...deploymentFields },
            forcePushBypassers,
          )
        : ruleVariables(ctx, graphqlRun, deploymentFields, forcePushBypassers, async () => ({
            branchProtectionRuleId: await lateRuleId(ctx, name),
          })),
    drift,
    change: verifiedChange(
      `set ${routedKeys} on "${name}"`,
      name,
      requiredDeployments,
      "updateBranchProtectionRule",
    ),
  });
}

/** Plan one wildcard entry, entirely through the GraphQL rule surface. */
export async function planWildcardEntry(
  ctx: BranchesContext,
  graphqlRun: GraphqlRun,
  branch: BranchConfig,
  plan: BranchesPlan,
): Promise<void> {
  const pattern = branch.name;
  const prefix = `branches[${pattern}].protection`;
  const node = graphqlRun.rules?.get(pattern);
  if (branch.protection === null) {
    if (node === undefined) {
      return;
    }
    plan.ops.push({
      role: "deleteRule",
      variables: { input: { branchProtectionRuleId: node.id } },
      describe: `deleting the protection rule "${pattern}"`,
      drift: [
        `branches[${pattern}]: a live rule matches this pattern but the settings file declares protection: null; apply will delete the rule`,
      ],
      change: `deleted protection rule "${pattern}"`,
    });
    return;
  }
  const deployments = branch.protection.required_deployments;
  const actors = branch.protection.force_push_bypassers;
  const fields = wildcardInput(branch.protection);
  if (node === undefined) {
    plan.ops.push({
      role: "createRule",
      variables: ruleVariables(ctx, graphqlRun, { pattern, ...fields }, actors, async (exec) => ({
        repositoryId: await repositoryNodeId(ctx, exec, graphqlRun),
      })),
      describe: `creating the protection rule "${pattern}"`,
      drift: [
        `branches[${pattern}]: no live rule matches this pattern but the settings file declares protection; apply will create the rule`,
      ],
      change: verifiedChange(
        `created protection rule "${pattern}"`,
        pattern,
        deployments,
        "createBranchProtectionRule",
      ),
    });
    return;
  }
  const declared: Record<string, unknown> = { ...branch.protection };
  delete declared.force_push_bypassers;
  delete declared.required_deployments;
  const drift = justified([
    ...subsetDiff(declared, classicViewOfRule(node), prefix),
    ...routedKeyDrift(prefix, branch.protection, graphqlRun.rules, pattern),
  ]);
  if (drift === null) {
    return;
  }
  plan.ops.push({
    role: "updateRule",
    variables: ruleVariables(
      ctx,
      graphqlRun,
      { branchProtectionRuleId: node.id, ...fields },
      actors,
    ),
    describe: `updating the protection rule "${pattern}"`,
    drift,
    change: verifiedChange(
      `updated protection rule "${pattern}"`,
      pattern,
      deployments,
      "updateBranchProtectionRule",
    ),
  });
}
