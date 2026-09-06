/**
 * The mock GitHub server's state layer: the sparse per-scenario overlay
 * (`LiveState`), the materialized in-memory working state (`MockState`), and
 * the pure write-to-read transformers that turn a mutation payload into the
 * GET shape a section will later read back.
 *
 * The transformers are the crux of round-trip fidelity: a section flattens the
 * GET shape (branches' `flattenProtection`, environments' `flattenEnvironment`,
 * collaborators/teams' `roleForPermission`) before diffing, so the mock must
 * produce a GET shape those flatteners invert back to the payload. The
 * transformers here are the inverse of those flatteners, and the state test
 * proves the round trip.
 */

import { AUTOLINKS_MOCK } from "../../../src/sections/autolinks/mock.js";
import {
  GRAPHQL_BOOLEAN_TWINS,
  GRAPHQL_REVIEW_TWINS,
  GRAPHQL_STATUS_CHECK_TWINS,
} from "../../../src/sections/branches/graphql-rules.js";
import { parseBypassActor } from "../../../src/sections/branches/schema.js";
import { DEPLOY_KEYS_MOCK } from "../../../src/sections/deploy_keys/mock.js";
import { LABELS_MOCK } from "../../../src/sections/labels/mock.js";
import type { ListSectionKey } from "../../../src/sections/shared/list-section.js";
import { INVITATION_ROLES, roleForPermission } from "../../../src/sections/shared/roles.js";
import type { MustBeNever } from "../../../src/types.js";
import { ADMIN_OWNER } from "../constants.js";
import orgFixture from "../fixtures/org.json" with { type: "json" };
import repoFixture from "../fixtures/repo.json" with { type: "json" };
import type { OwnerKind, PermissionMask } from "../schema.js";
import type { ListMockSpec } from "./list-fragment.js";
import { decodeNodeId, mintNodeId } from "./node-id.js";

/** A plain JSON object body, the currency of every fixture and overlay. */
type Json = Record<string, unknown>;

/**
 * The `labels.generate` sugar: instead of listing N label bodies, a scenario
 * declares a count and the mock synthesizes "<prefix>-1".."<prefix>-N", all in
 * the same color. Mirrors LabelsGenerateSchema in ../schema.ts.
 */
interface LabelsGenerate {
  count: number;
  prefix: string;
  color: string;
}

/**
 * A scenario's sparse starting state. Every family is optional; an absent
 * family starts from its baseline fixture (or empty, for list families). Each
 * key names one endpoint family the mock serves; the shapes are the GET-side
 * bodies the mock returns, NOT the section's declared/PUT shapes.
 */
export interface LiveState {
  /** Partial repo object merged (deep) over repo.json. */
  repo?: Json;
  /**
   * Either an explicit list of label seeds (replaces the baseline) or the generate sugar. A
   * scenario picks exactly one form; seeds may be sparse ({name, color}), buildState completes them.
   */
  labels?: Json[] | { generate: LabelsGenerate };
  /** Repository rulesets (summary + full bodies), replaces the baseline. */
  rulesets?: Json[];
  /** Branch protection keyed by branch name; null means "unprotected". */
  branch_protection?: Record<string, Json | null>;
  /**
   * The GraphQL-only classic-protection fields of LITERAL rules, keyed by
   * branch name (the REST GET shape cannot carry them): bypassForcePushActors
   * (actor strings in the declared vocabulary), requiresDeployments, and
   * requiredDeploymentEnvironments. Served merged into the rule node the
   * rules query projects from branch_protection.
   */
  branch_protection_graphql?: Record<string, Json>;
  /**
   * WILDCARD-pattern classic protection rules, invisible to every REST
   * protection endpoint (like GitHub), served only by the GraphQL rules
   * query. Stored in the internal rule shape: GraphQL field names plus
   * bypassForcePushActors as actor strings; buildState completes each seed
   * to the full field set (completeRule) and stampNodeIds mints the ids.
   */
  branch_protection_rules?: Json[];
  /** Branch names that exist on the repo (drives the advisory branch probe). */
  branches?: string[];
  /** Deployment environments keyed by name (GET shape). */
  environments?: Record<string, Json>;
  /** Per-environment Actions variables (GET shape), keyed by environment name. */
  environment_variables?: Record<string, Json[]>;
  /**
   * Per-environment deployment branch-policy patterns (GET shape:
   * {id, name, type}), keyed by environment name. Served only while the
   * environment's stored deployment_branch_policy enables
   * custom_branch_policies (the endpoints 404 otherwise, like GitHub).
   */
  environment_branch_policies?: Record<string, Json[]>;
  /**
   * Per-environment enabled custom deployment protection rules (GET shape:
   * {id, node_id, enabled, app: {id, slug, integration_url, node_id}}),
   * keyed by environment name. Seeded apps should come from
   * PROTECTION_RULE_APPS so the available-Apps listing agrees with them.
   */
  environment_protection_rules?: Record<string, Json[]>;
  /**
   * The repository's pinned environments, served by the EnvironmentPins
   * GraphQL connection and mutated by the pin/reorder mutations. A plain
   * string is sugar for the next contiguous position; the object form seeds
   * an explicit (possibly HOLE-Y) position, mirroring live GitHub, where
   * unpinning does not renumber. Seeded names should name environments that
   * exist in `environments` (a pin's target is always a real environment).
   */
  pinned_environments?: Array<string | { name: string; position: number }>;
  /** Autolinks, replaces the baseline; a sparse seed is completed like a label. */
  autolinks?: Json[];
  /** GET /actions/permissions body. */
  actions_permissions?: Json;
  /** GET /actions/permissions/selected-actions body. */
  selected_actions?: Json;
  /** GET /actions/permissions/workflow body. */
  workflow_permissions?: Json;
  /** GET /actions/permissions/access body. */
  actions_access?: Json;
  /** GET /actions/permissions/artifact-and-log-retention body. */
  actions_retention?: Json;
  /** GET /actions/cache/retention-limit body. */
  cache_retention_limit?: Json;
  /** GET /actions/cache/storage-limit body. */
  cache_storage_limit?: Json;
  /** GET /actions/oidc/customization/sub body. */
  oidc_customization_sub?: Json;
  /** GET /actions/permissions/fork-pr-contributor-approval body. */
  fork_pr_contributor_approval?: Json;
  /** GET /actions/permissions/fork-pr-workflows-private-repos body. */
  fork_pr_workflows_private_repos?: Json;
  /**
   * Actions secrets list items (GET shape: {name, created_at, updated_at}),
   * replaces the (empty) baseline. Values are never part of the GET shape;
   * the mock tracks a digest of each uploaded value separately.
   */
  actions_secrets?: Json[];
  /** Dependabot secrets list items, same GET shape as actions_secrets. */
  dependabot_secrets?: Json[];
  /** Codespaces secrets list items, same GET shape as actions_secrets. */
  codespaces_secrets?: Json[];
  /** Copilot agents secrets list items, same GET shape as actions_secrets. */
  agents_secrets?: Json[];
  /**
   * Per-environment Actions secrets (GET shape: {name, created_at,
   * updated_at}), keyed by environment name. Values are never part of the
   * GET shape; the mock tracks digests separately, per environment.
   */
  environment_secrets?: Record<string, Json[]>;
  /** Workflows list items ({id, name, path, state}), replaces the baseline. */
  workflows?: Json[];
  /** GET /pages body, or null for "Pages not enabled". */
  pages?: Json | null;
  /** GET /code-scanning/default-setup body. */
  code_scanning?: Json;
  /** GET /code-quality/setup body. */
  code_quality?: Json;
  /**
   * The stored check suite preferences ({auto_trigger_checks}). Write-only
   * on the real API (no GET exists); the PATCH echoes this back under a
   * `preferences` wrapper.
   */
  check_suite_preferences?: Json;
  /** Direct collaborators (GET shape with role_name), replaces the baseline. */
  collaborators?: Json[];
  /**
   * Pending repository invitations (repository-invitation GET shape),
   * replaces the (empty) baseline. A seed may be sparse: buildState
   * completes each invitation to the spec's required shape (id, repository,
   * inviter, urls); typically only {invitee: {login}, permissions, expired}
   * is seeded.
   */
  invitations?: Json[];
  /** Team access keyed by team slug; null means "no access". */
  teams?: Record<string, { role_name: string } | null>;
  /** Milestones (GET shape), replaces the baseline. */
  milestones?: Json[];
  /** GET /interaction-limits body ({limit, origin, expires_at}); default none. */
  interaction_limits?: Json;
  /**
   * GET /interaction-limits/pulls/creation-cap body ({enabled,
   * max_open_pull_requests}); the default mirrors an unconfigured repo
   * (disabled). The spec requires both fields in every response.
   */
  pull_creation_cap?: Json;
  /**
   * When true, the pull request creation cap endpoints answer 405 (the cap
   * is not available on this repository), matching GitHub's documented
   * Method Not Allowed on both the GET and the PATCH.
   */
  pull_creation_cap_unavailable?: boolean;
  /**
   * The pull request creation cap bypass list (GET shape: simple-user
   * objects), replaces the (empty) baseline. A seed may be sparse (just a
   * login); buildState completes each user via bypassUser, the same
   * completion the PUT handler applies.
   */
  pull_bypass_list?: Json[];
  /**
   * Actions repository variables (GET shape: name, value, created_at,
   * updated_at), replaces the baseline. GitHub stores names uppercased, so
   * seeded names should be uppercase to mirror the live service.
   */
  actions_variables?: Json[];
  /**
   * Copilot agents repository variables (GET shape: name, value, created_at,
   * updated_at), replaces the baseline. GitHub stores names uppercased, so
   * seeded names should be uppercase to mirror the live service.
   */
  agents_variables?: Json[];
  /**
   * When true, an organization- or user-level interaction limit is in
   * effect: repo-level PUT/DELETE answer 409, matching GitHub.
   */
  interaction_limits_org_override?: boolean;
  /**
   * Repository webhooks (GET shape), replaces the baseline. A seed may be
   * sparse: buildState completes each hook to the spec's required shape (id,
   * name "web", timestamps, urls, last_response). A seeded config.secret is
   * STORED verbatim but every GET echoes it as "********", matching GitHub.
   */
  hooks?: Json[];
  /**
   * Deploy keys (GET shape), replaces the (empty) baseline; a sparse seed is completed like a label,
   * its key material stored comment-free the way GitHub normalizes a created key.
   */
  deploy_keys?: Json[];
  /**
   * Issues the repo already has (GET shape: number, title, body, state, labels,
   * html_url, pull_request?), replaces the baseline. The private-report issue
   * channel lists, creates, and patches these; a scenario seeds a pre-existing
   * report issue here to exercise the reuse (update-in-place) path.
   */
  issues?: Json[];
  /**
   * Custom property values set on the repo (GET shape:
   * {property_name, value: string | string[] | null}), replaces the (empty)
   * baseline. Seeded names should come from CUSTOM_PROPERTY_DEFINITIONS so
   * the PATCH handler's defined-property check agrees with them.
   */
  custom_property_values?: Json[];
  /**
   * Secret scanning custom patterns (GET shape: id, name, slug, pattern,
   * state, push_protection_enabled, custom_pattern_version and the optional
   * delimiter/must_match fields), replaces the (empty) baseline.
   */
  secret_scanning_patterns?: Json[];
}

/**
 * Every LiveState family key, as the runtime enum the scenario schema keys
 * `live_state` records off (test/e2e/schema.ts): a typo'd family name then
 * fails scenario LOAD instead of being accepted and silently unseeded.
 * Pinned to the interface in both directions - the `satisfies` rejects a
 * listed key the interface lacks, and the MustBeNever pin fails to compile
 * when a new family is added to LiveState without being listed here.
 */
export const LIVE_STATE_KEYS = [
  "repo",
  "labels",
  "rulesets",
  "branch_protection",
  "branch_protection_graphql",
  "branch_protection_rules",
  "branches",
  "environments",
  "environment_variables",
  "environment_branch_policies",
  "environment_protection_rules",
  "pinned_environments",
  "autolinks",
  "actions_permissions",
  "selected_actions",
  "workflow_permissions",
  "actions_access",
  "actions_retention",
  "cache_retention_limit",
  "cache_storage_limit",
  "oidc_customization_sub",
  "fork_pr_contributor_approval",
  "fork_pr_workflows_private_repos",
  "actions_secrets",
  "dependabot_secrets",
  "codespaces_secrets",
  "agents_secrets",
  "environment_secrets",
  "workflows",
  "pages",
  "code_scanning",
  "code_quality",
  "check_suite_preferences",
  "collaborators",
  "invitations",
  "teams",
  "milestones",
  "interaction_limits",
  "pull_creation_cap",
  "pull_creation_cap_unavailable",
  "pull_bypass_list",
  "actions_variables",
  "agents_variables",
  "interaction_limits_org_override",
  "hooks",
  "deploy_keys",
  "issues",
  "custom_property_values",
  "secret_scanning_patterns",
] as const satisfies readonly (keyof LiveState)[];
type _LiveStateKeysComplete = MustBeNever<
  Exclude<keyof LiveState, (typeof LIVE_STATE_KEYS)[number]>
>;

/**
 * The materialized working state the mock server mutates in place: every
 * family resolved to a concrete value (fixture baseline with the LiveState
 * overlay applied), plus a monotonic id source for created resources and the
 * owner kind (which flips the org endpoint to 404 for a personal account).
 */
export interface MockState {
  /**
   * The "owner/name" slug this state serves, fixed at construction (buildState
   * re-slugs the repo body first, so the two always agree at birth). Node ids
   * and per-slug routing key off THIS field, never the mutable repo body: a
   * PATCH that writes `full_name` must not move the identity minted ids carry.
   */
  readonly slug: string;
  ownerKind: OwnerKind;
  /** The org body, or null when the owner is a personal account. */
  org: Json | null;
  repo: Json;
  labels: Json[];
  rulesets: Json[];
  branch_protection: Record<string, Json | null>;
  /** GraphQL-only fields of literal rules, keyed by branch name. */
  branch_protection_graphql: Record<string, Json>;
  /** Wildcard classic rules in the internal rule shape (see LiveState). */
  branch_protection_rules: Json[];
  branches: string[];
  environments: Record<string, Json>;
  environment_variables: Record<string, Json[]>;
  /** Per-environment deployment branch-policy patterns, keyed by environment name. */
  environment_branch_policies: Record<string, Json[]>;
  /** Per-environment enabled custom deployment protection rules, keyed by environment name. */
  environment_protection_rules: Record<string, Json[]>;
  /**
   * The pinned environments with their live position numbers, kept in rank
   * order. Positions mirror verified GitHub behavior: a new pin appends at
   * _pinned_position_counter + 1 (monotonic), an unpin leaves a HOLE (no
   * renumbering), and only the reorder mutation renormalizes to contiguous
   * 1..N.
   */
  pinned_environments: Array<{ name: string; position: number }>;
  /**
   * The monotonic position source for new pins (starts at the seeded
   * maximum). Underscore prefix: mock bookkeeping, excluded from the
   * idempotence snapshot (see snapshotFamilies in apply-idempotence-proof.ts).
   */
  _pinned_position_counter: number;
  autolinks: Json[];
  actions_permissions: Json;
  selected_actions: Json;
  workflow_permissions: Json;
  actions_access: Json;
  actions_retention: Json;
  cache_retention_limit: Json;
  cache_storage_limit: Json;
  oidc_customization_sub: Json;
  fork_pr_contributor_approval: Json;
  fork_pr_workflows_private_repos: Json;
  /** Actions secrets in GET shape ({name, created_at, updated_at}). */
  actions_secrets: Json[];
  /** Dependabot secrets, same GET shape as actions_secrets. */
  dependabot_secrets: Json[];
  /** Codespaces secrets, same GET shape as actions_secrets. */
  codespaces_secrets: Json[];
  /** Copilot agents secrets, same GET shape as actions_secrets. */
  agents_secrets: Json[];
  /** Per-environment Actions secrets (GET shape), keyed by environment name. */
  environment_secrets: Record<string, Json[]>;
  /**
   * Monotonic count of secret PUTs against this state - EVERY family shares
   * it - feeding each write's deterministic updated_at. Underscore prefix:
   * mock bookkeeping, excluded from the idempotence snapshot (see
   * snapshotFamilies in apply-idempotence-proof.ts).
   */
  _secret_write_counter: number;
  /**
   * sha256 digest of each uploaded secret's UNSEALED value, keyed by secret
   * name (one map per repository-level family; environment secrets nest one
   * map per environment). Never the plaintext, and never served: it exists
   * so the state snapshot can prove a second apply re-wrote the same value
   * (a re-seal produces different ciphertext for the same plaintext by
   * design).
   */
  actions_secret_digests: Record<string, string>;
  dependabot_secret_digests: Record<string, string>;
  codespaces_secret_digests: Record<string, string>;
  agents_secret_digests: Record<string, string>;
  environment_secret_digests: Record<string, Record<string, string>>;
  workflows: Json[];
  pages: Json | null;
  code_scanning: Json;
  code_quality: Json;
  /** Stored check suite preferences; the PATCH merges and echoes them. */
  check_suite_preferences: Json;
  collaborators: Json[];
  /** Pending repository invitations in the repository-invitation GET shape. */
  invitations: Json[];
  teams: Record<string, { role_name: string } | null>;
  milestones: Json[];
  /** The active interaction limit, or null when none is set. */
  interaction_limits: Json | null;
  interaction_limits_org_override: boolean;
  /** The pull request creation cap ({enabled, max_open_pull_requests}). */
  pull_creation_cap: Json;
  pull_creation_cap_unavailable: boolean;
  /** The creation-cap bypass list, simple-user objects in GET shape. */
  pull_bypass_list: Json[];
  actions_variables: Json[];
  /** Copilot agents repository variables, same GET shape as actions_variables. */
  agents_variables: Json[];
  /** Repository webhooks; config.secret is stored real, GETs echo "********". */
  hooks: Json[];
  /** Deploy keys in GET shape; stored key material carries no comment. */
  deploy_keys: Json[];
  /** Report issues the private-report issue channel lists/creates/patches. */
  issues: Json[];
  /** Custom property values set on the repo ({property_name, value}). */
  custom_property_values: Json[];
  /** Secret scanning custom patterns in GET shape. */
  secret_scanning_patterns: Json[];
  /**
   * Monotonic count of custom-pattern mutations against this state, feeding
   * each write's fresh custom_pattern_version - deterministic, never a
   * clock. Underscore prefix: mock bookkeeping, excluded from the
   * idempotence snapshot (see snapshotFamilies in apply-idempotence-proof.ts).
   */
  _secret_scanning_version_counter: number;
  /** Next id handed to a created resource (label, ruleset, autolink, ...). */
  nextId: number;
}

/**
 * Normalize a pinned-environments seed into rank-ordered {name, position}
 * entries: a plain string takes the next contiguous position after the
 * largest seen so far, an object keeps its explicit (possibly hole-y)
 * position. Exported for the state test.
 */
export function normalizePinnedSeed(
  seed: ReadonlyArray<string | { name: string; position: number }>,
): Array<{ name: string; position: number }> {
  let max = 0;
  const pins = seed.map((entry) => {
    if (typeof entry === "string") {
      max += 1;
      return { name: entry, position: max };
    }
    max = Math.max(max, entry.position);
    return { name: entry.name, position: entry.position };
  });
  return pins.sort((a, b) => a.position - b.position);
}

/** True for a plain (non-array, non-null) object we can deep-merge into. */
function isPlainObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Stamp the node ids of everything a state serves that GraphQL can address:
 * the repo object, each environment body, and each wildcard protection rule.
 * Runs at the end of buildState, after the repo body is re-slugged and
 * `state.slug` is fixed (the slug is part of every id), so the ids a section
 * reads always name the repository they belong to. Write handlers mint ids
 * for resources they create with the same codec (mock/node-id.ts).
 */
function stampNodeIds(state: MockState): void {
  state.repo.node_id = mintNodeId("repo", state.slug, "");
  for (const [name, environment] of Object.entries(state.environments)) {
    environment.node_id = mintNodeId("environment", state.slug, name);
  }
  for (const rule of state.branch_protection_rules) {
    rule.id = mintNodeId("rule", state.slug, String(rule.pattern));
  }
}

/**
 * The repo fields only GraphQL serves, mirroring the real API: the issue
 * creation policy is live-verified REST-blind in both directions (the repo
 * PATCH answers 200 and silently ignores such a field, no GET returns one),
 * and the sponsor button has no REST field at all. They live on state.repo
 * like every repo field (live_state.repo seeds them, the snapshot layer
 * sees them), but every REST-served or REST-accepted repo body goes through
 * restRepoSurface, which strips them - so only the GraphQL handlers can
 * read or write them.
 */
const GRAPHQL_ONLY_REPO_FIELDS = ["has_sponsorships_enabled", "issue_creation_policy"] as const;

/** The REST-visible projection of a repo body (see GRAPHQL_ONLY_REPO_FIELDS). */
export function restRepoSurface(repo: Json): Json {
  const view = { ...repo };
  for (const field of GRAPHQL_ONLY_REPO_FIELDS) {
    delete view[field];
  }
  return view;
}

/**
 * Deep-merge `overlay` onto `base`, recursing into plain objects and replacing
 * arrays and scalars wholesale. Neither input is mutated. Used for the repo
 * object, where a scenario overrides individual fields but keeps the rest of
 * the fixture.
 */
function deepMerge(base: Json, overlay: Json): Json {
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const prev = out[key];
    out[key] = isPlainObject(prev) && isPlainObject(value) ? deepMerge(prev, value) : value;
  }
  return out;
}

/** Clone a JSON fixture so callers can mutate the state without touching it. */
function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Expand the labels.generate sugar into sparse seeds, completed like any seeded label. */
function generateLabels(gen: LabelsGenerate): Json[] {
  return Array.from({ length: gen.count }, (_, i) => ({
    name: `${gen.prefix}-${i + 1}`,
    color: gen.color,
  }));
}

/**
 * The list collections buildState completes from the same spec their handlers create with, so a
 * seed is served exactly as a created item would be: the spec's defaults under the seed and the
 * server-owned fields minted over it (a seed may pin only its id). The state test pins the key set.
 */
export const LIST_MOCKS = {
  labels: LABELS_MOCK,
  autolinks: AUTOLINKS_MOCK,
  deploy_keys: DEPLOY_KEYS_MOCK,
} as const satisfies Partial<Record<ListSectionKey, ListMockSpec>>;

function completeListItem(spec: ListMockSpec, seed: Json, id: number, slug: string): Json {
  const item = { ...spec.defaults, ...seed };
  return { ...item, ...spec.owned(id, slug, item) };
}

/** Every numeric `id` any object in the overlay pins, at any depth. */
function seededIds(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.flatMap(seededIds);
  }
  if (!isPlainObject(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, nested]) =>
    key === "id" && typeof nested === "number" ? [nested] : seededIds(nested),
  );
}

/** Complete every list collection's seeds in place; a seed keeps a pinned id, buildState reserved it. */
function completeListCollections(state: MockState): void {
  for (const spec of Object.values(LIST_MOCKS)) {
    const items = spec.collection(state);
    const completed = items.map((seed) =>
      completeListItem(
        spec,
        seed,
        typeof seed.id === "number" ? seed.id : state.nextId++,
        state.slug,
      ),
    );
    items.splice(0, items.length, ...completed);
  }
}

/**
 * Complete a (possibly sparse) webhook body to the spec's required GET shape,
 * so scenario seeds stay terse and every served hook validates: the seed's
 * own fields win, `id` comes from the caller unless the seed carries one, and
 * the server-owned scaffold (type, timestamps, urls, last_response) fills the
 * rest. The urls derive from `slug` (the owning state's fixed identity), so a
 * multi-repo target's hooks name the target. Timestamps are FIXED so a repeat
 * apply leaves the state byte-stable for the idempotence proof.
 */
export function completeHook(seed: Json, id: number, slug: string): Json {
  const hookId = Number(seed.id ?? id);
  return {
    type: "Repository",
    name: "web",
    active: true,
    events: ["push"],
    config: {},
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    url: `https://api.github.com/repos/${slug}/hooks/${hookId}`,
    test_url: `https://api.github.com/repos/${slug}/hooks/${hookId}/test`,
    ping_url: `https://api.github.com/repos/${slug}/hooks/${hookId}/pings`,
    deliveries_url: `https://api.github.com/repos/${slug}/hooks/${hookId}/deliveries`,
    last_response: { code: null, status: "unused", message: null },
    id: hookId,
    ...seed,
  };
}

/**
 * Complete a (possibly sparse) bypass-list user to the simple-user GET shape,
 * so scenario seeds stay terse (just a login) and the PUT handler stores the
 * same shape it will later serve. The seed's own fields win; the id comes
 * from the caller unless the seed carries one. Deterministic (no clocks, no
 * randomness) so repeat applies leave the state byte-stable.
 */
export function bypassUser(seed: Json, id: number): Json {
  const login = String(seed.login ?? "");
  const userId = Number(seed.id ?? id);
  return {
    id: userId,
    node_id: `MDQ6VXNlcj${userId}`,
    avatar_url: `https://avatars.githubusercontent.com/u/${userId}?v=4`,
    gravatar_id: "",
    url: `https://api.github.com/users/${login}`,
    html_url: `https://github.com/${login}`,
    type: "User",
    site_admin: false,
    ...seed,
    login,
  };
}

/**
 * Complete a (possibly sparse) repository-invitation body to the spec's
 * required GET shape, so scenario seeds stay terse: typically only
 * {invitee: {login}, permissions, expired}. The seed's own fields win, `id`
 * comes from the caller unless the seed carries one, and the server-owned
 * scaffold (repository, inviter, urls, timestamp) derives from `repo` and the
 * state's fixed `slug`, so the body stays internally consistent with the
 * target (re-slugged in multi mode). The timestamp is FIXED for the
 * idempotence proof.
 */
export function completeInvitation(seed: Json, id: number, repo: Json, slug: string): Json {
  const invitationId = Number(seed.id ?? id);
  const ownerLogin = String((repo.owner as Json | undefined)?.login ?? slug.split("/")[0]);
  // An explicit `invitee: null` seeds an EMAIL invitation (the spec's invitee
  // is nullable); only an absent invitee gets the default user scaffold.
  const invitee =
    seed.invitee === null
      ? null
      : {
          login: "invitee",
          id: 0,
          type: "User",
          site_admin: false,
          ...((seed.invitee as Json | undefined) ?? {}),
        };
  const completed: Json = {
    node_id: `MDEwOlJlcG9JbnZpdGF0aW9u${invitationId}`,
    // A CLONE, not the live reference: stored invitations must not mirror
    // later repo mutations, or the snapshot layer (snapshotFamilies in
    // apply-idempotence-proof.ts) would misattribute a repo-family change to
    // invitations.
    repository: clone(repo),
    inviter: { login: ownerLogin, id: 0, type: "User", site_admin: false },
    permissions: "write",
    expired: false,
    created_at: "2026-07-01T00:00:00Z",
    url: `https://api.github.com/repos/${slug}/invitations/${invitationId}`,
    html_url: `https://github.com/${slug}/invitations`,
    ...seed,
    invitee,
    id: invitationId,
  };
  // AFTER the seed spread, so a seeded repository object is projected too:
  // the invitation body is a REST surface like any other.
  completed.repository = restRepoSurface(completed.repository as Json);
  return completed;
}

/**
 * The GitHub Apps the mock offers as custom deployment protection rule
 * providers, served by the available-Apps endpoint. The ONE source of
 * available slugs: the mock's create handler resolves integration_id against
 * it, and the fuzz generator draws declared App slugs from it, so a
 * generated rule can always be enabled.
 */
export const PROTECTION_RULE_APPS: readonly Json[] = [
  {
    id: 3515,
    slug: "deploy-gate",
    integration_url: "https://api.github.com/apps/deploy-gate",
    node_id: "MDQ6R2F0ZTM1MTU=",
  },
  {
    id: 3516,
    slug: "region-guard",
    integration_url: "https://api.github.com/apps/region-guard",
    node_id: "MDQ6R2F0ZTM1MTY=",
  },
  {
    id: 3517,
    slug: "change-window",
    integration_url: "https://api.github.com/apps/change-window",
    node_id: "MDQ6R2F0ZTM1MTc=",
  },
];

/**
 * The organization-level custom property DEFINITIONS the mock's org is
 * assumed to carry (names + value_type; one of each shape). The ONE source of
 * defined names: the values PATCH handler answers 422 for a property_name
 * outside it, and the fuzz generator draws declared names (with
 * type-appropriate values) from it, so a generated declaration can never
 * trip the undefined-property rejection.
 */
export const CUSTOM_PROPERTY_DEFINITIONS: ReadonlyArray<{
  property_name: string;
  value_type: "string" | "true_false" | "multi_select";
  allowed_values?: readonly string[];
}> = [
  { property_name: "team", value_type: "string" },
  // A second string property, so a scenario can seed an UNDECLARED live
  // value on a defined name without colliding with the declared ones.
  { property_name: "tier", value_type: "string" },
  { property_name: "pilot", value_type: "true_false" },
  { property_name: "compliance", value_type: "multi_select", allowed_values: ["soc2", "hipaa"] },
];

/**
 * Materialize a MockState from a scenario's (possibly undefined) LiveState.
 * List families default to empty; the repo defaults to the fixture (deep-merged
 * with any overlay); the single-object families default to their fixtures.
 * `ownerKind: "user"` marks the org absent so the teams section no-ops.
 * `slug`, when given (multi-repo targets), re-slugs the repo BEFORE any
 * family completion runs, so bodies derived from the repo (the invitation
 * scaffold's urls and inviter) name the target, not the fixture.
 */
export function buildState(
  liveState: LiveState | undefined,
  ownerKind: OwnerKind,
  slug?: string,
): MockState {
  const ls = liveState ?? {};
  // Every minted id starts past every id a seed pins, so a pinned id can never collide with one.
  let nextId = Math.max(90_000_000, ...seededIds(ls).map((id) => id + 1));
  const takeId = (): number => nextId++;

  // deepMerge shallow-copies the base top level and assigns OVERLAY values by
  // reference, so both sides must be cloned: the base clone keeps the module
  // fixture singleton private (a later reslugRepo mutating owner.login would
  // otherwise contaminate every scenario), and the overlay clone keeps the
  // scenario's live_state.repo object private (an in-place handler mutation
  // would otherwise write back into the scenario). Cloning both makes the
  // resulting repo fully owned by this state.
  const repo = ls.repo
    ? deepMerge(clone(repoFixture as Json), clone(ls.repo))
    : clone(repoFixture as Json);
  if (slug !== undefined) {
    reslugRepo(repo, slug);
  }
  // The state's identity, fixed here for good: the slug param (multi-repo
  // targets) or the repo body's name at construction. Later repo mutations
  // (a PATCH writing full_name) cannot move it. A seed that blanks full_name
  // has no identity to fix, so it fails loudly at build instead of minting
  // ids under a garbage slug. Fixed BEFORE any family completion runs, so
  // bodies that mint identity from the slug (generated labels, hook urls,
  // the invitation scaffold) name the target, not the fixture.
  const fullName = repo.full_name;
  if (slug === undefined && (typeof fullName !== "string" || fullName === "")) {
    throw new Error(
      `buildState: live_state.repo.full_name must be a non-empty string when no slug is given, got ${JSON.stringify(fullName)}`,
    );
  }
  const stateSlug = slug ?? String(fullName);

  const labels =
    ls.labels === undefined
      ? []
      : Array.isArray(ls.labels)
        ? clone(ls.labels)
        : generateLabels(ls.labels.generate);

  const pinnedSeed = normalizePinnedSeed(ls.pinned_environments ?? []);

  const state: MockState = {
    slug: stateSlug,
    ownerKind,
    org: ownerKind === "user" ? null : clone(orgFixture as Json),
    repo,
    labels,
    rulesets: ls.rulesets ? clone(ls.rulesets) : [],
    branch_protection: ls.branch_protection ? clone(ls.branch_protection) : {},
    branch_protection_graphql: ls.branch_protection_graphql
      ? clone(ls.branch_protection_graphql)
      : {},
    branch_protection_rules: (ls.branch_protection_rules ?? []).map((rule) =>
      completeRule(clone(rule)),
    ),
    branches: ls.branches ? clone(ls.branches) : [],
    environments: ls.environments ? clone(ls.environments) : {},
    environment_variables: ls.environment_variables ? clone(ls.environment_variables) : {},
    environment_branch_policies: ls.environment_branch_policies
      ? clone(ls.environment_branch_policies)
      : {},
    environment_protection_rules: ls.environment_protection_rules
      ? clone(ls.environment_protection_rules)
      : {},
    pinned_environments: pinnedSeed,
    _pinned_position_counter: Math.max(0, ...pinnedSeed.map((pin) => pin.position)),
    autolinks: ls.autolinks ? clone(ls.autolinks) : [],
    actions_permissions: ls.actions_permissions ? clone(ls.actions_permissions) : {},
    selected_actions: ls.selected_actions ? clone(ls.selected_actions) : {},
    workflow_permissions: ls.workflow_permissions ? clone(ls.workflow_permissions) : {},
    actions_access: ls.actions_access ? clone(ls.actions_access) : {},
    // GitHub's real defaults, not {}: each body carries required fields, so
    // an unseeded GET must still answer a spec-valid shape.
    actions_retention: ls.actions_retention
      ? clone(ls.actions_retention)
      : { days: 90, maximum_allowed_days: 400 },
    cache_retention_limit: ls.cache_retention_limit
      ? clone(ls.cache_retention_limit)
      : { max_cache_retention_days: 7 },
    cache_storage_limit: ls.cache_storage_limit
      ? clone(ls.cache_storage_limit)
      : { max_cache_size_gb: 10 },
    oidc_customization_sub: ls.oidc_customization_sub
      ? clone(ls.oidc_customization_sub)
      : { use_default: true },
    fork_pr_contributor_approval: ls.fork_pr_contributor_approval
      ? clone(ls.fork_pr_contributor_approval)
      : { approval_policy: "first_time_contributors_new_to_github" },
    fork_pr_workflows_private_repos: ls.fork_pr_workflows_private_repos
      ? clone(ls.fork_pr_workflows_private_repos)
      : {
          run_workflows_from_fork_pull_requests: false,
          send_write_tokens_to_workflows: false,
          send_secrets_and_variables: false,
          require_approval_for_fork_pr_workflows: true,
        },
    actions_secrets: ls.actions_secrets ? clone(ls.actions_secrets) : [],
    dependabot_secrets: ls.dependabot_secrets ? clone(ls.dependabot_secrets) : [],
    codespaces_secrets: ls.codespaces_secrets ? clone(ls.codespaces_secrets) : [],
    agents_secrets: ls.agents_secrets ? clone(ls.agents_secrets) : [],
    environment_secrets: ls.environment_secrets ? clone(ls.environment_secrets) : {},
    _secret_write_counter: 0,
    actions_secret_digests: {},
    dependabot_secret_digests: {},
    codespaces_secret_digests: {},
    agents_secret_digests: {},
    environment_secret_digests: {},
    workflows: ls.workflows ? clone(ls.workflows) : [],
    pages: ls.pages !== undefined ? clone(ls.pages) : null,
    code_scanning: ls.code_scanning ? clone(ls.code_scanning) : {},
    // GitHub's fresh-repo default, not {}: the GET body's nullable fields
    // are spelled out so an unseeded read answers a realistic shape.
    code_quality: ls.code_quality
      ? clone(ls.code_quality)
      : {
          state: "not-configured",
          languages: [],
          runner_type: null,
          runner_label: null,
          updated_at: null,
          schedule: null,
          ai_findings_option: null,
        },
    check_suite_preferences: ls.check_suite_preferences
      ? clone(ls.check_suite_preferences)
      : { auto_trigger_checks: [] },
    collaborators: ls.collaborators ? clone(ls.collaborators) : [],
    invitations: (ls.invitations ?? []).map((invitation) =>
      completeInvitation(clone(invitation), takeId(), repo, stateSlug),
    ),
    teams: ls.teams ? clone(ls.teams) : {},
    milestones: ls.milestones ? clone(ls.milestones) : [],
    interaction_limits: ls.interaction_limits ? clone(ls.interaction_limits) : null,
    interaction_limits_org_override: ls.interaction_limits_org_override ?? false,
    // An unconfigured repo's cap is disabled; the spec requires
    // max_open_pull_requests in every response, so the default carries one.
    pull_creation_cap: ls.pull_creation_cap
      ? clone(ls.pull_creation_cap)
      : { enabled: false, max_open_pull_requests: 1 },
    pull_creation_cap_unavailable: ls.pull_creation_cap_unavailable ?? false,
    pull_bypass_list: (ls.pull_bypass_list ?? []).map((user) => bypassUser(clone(user), takeId())),
    actions_variables: ls.actions_variables ? clone(ls.actions_variables) : [],
    agents_variables: ls.agents_variables ? clone(ls.agents_variables) : [],
    hooks: (ls.hooks ?? []).map((hook) => completeHook(clone(hook), takeId(), stateSlug)),
    deploy_keys: ls.deploy_keys ? clone(ls.deploy_keys) : [],
    issues: ls.issues ? clone(ls.issues) : [],
    custom_property_values: ls.custom_property_values ? clone(ls.custom_property_values) : [],
    secret_scanning_patterns: ls.secret_scanning_patterns ? clone(ls.secret_scanning_patterns) : [],
    _secret_scanning_version_counter: 0,
    nextId,
  };
  completeListCollections(state);
  stampNodeIds(state);
  return state;
}

// --- Multi-repo layer -----------------------------------------------------
//
// Multi-repo mode runs one admin repo (e2e-owner/e2e-repo) against many target
// slugs. Rather than re-key the single-repo MockState (which every handler and
// the round-trip tests depend on), a MultiMockState wraps a Map<slug,
// MockState> plus the discovery pool the `/user/repos` endpoint serves. The
// single-repo server path is unchanged; the multi-repo pipeline resolves the
// slug from the request path and dispatches into the matching per-slug state.

/** One repo's slice of a multi-repo scenario: its data, settings file, mask. */
export interface MultiRepoSpec {
  /**
   * The raw settings.yml body the contents endpoint serves for this slug, or
   * null when the repo has NO settings file (the contents 404 -> skipped path).
   */
  settingsYaml: string | null;
  /** Starting live state for this slug's section endpoints. */
  liveState?: LiveState;
  /** Per-slug token permission mask (denials scoped to one target). */
  permissions?: PermissionMask;
}

/**
 * A discovery-pool repo, as `/user/repos` returns it: the slug plus the
 * client-side-filterable attributes the discovery engine reads (archived, fork,
 * visibility, topics). The mock serves these verbatim; the action applies the
 * filters, so the mock never pre-filters.
 */
export interface DiscoveryRepoSpec {
  slug: string;
  archived?: boolean;
  fork?: boolean;
  visibility?: string;
  topics?: string[];
}

/** The materialized multi-repo working state the mock server mutates. */
export interface MultiMockState {
  /** Per-target working state, keyed by "owner/name" slug. */
  repos: Map<string, MockState>;
  /** The raw settings.yml each slug serves (null = no file), keyed by slug. */
  settings: Map<string, string | null>;
  /** Per-slug permission mask, keyed by slug (empty = default write). */
  permissions: Map<string, PermissionMask>;
  /** The repo objects `/user/repos` enumerates (discovery pool). */
  discoveryPool: Json[];
  /**
   * A shared MockState for the org-level endpoints (the teams section's
   * `GET /orgs/{org}` probe), which are NOT repo-scoped. It carries the org
   * fixture (or null org when owner_kind is "user"); only its `org` field is
   * read. Team-repo routes (`/orgs/{org}/teams/.../repos/{owner}/{repo}`) still
   * resolve to the addressed repo's state via their {owner}/{repo} tail.
   */
  orgState: MockState;
}

/**
 * Rewrite a MockState's repo object so its identity names `slug` instead of
 * the fixture's: the explicit identity fields (full_name, name, owner.login)
 * AND every url-keyed string carrying the old slug or owner - the fixture's
 * ~15 url/template fields (html_url, hooks_url, labels_url, clone_url, ...)
 * and the owner's own urls all name the repository, so leaving them on the
 * fixture identity would serve a target whose body points at another repo.
 * Only `url`/`*_url` fields are rewritten (a seeded description mentioning
 * the fixture owner is content, not identity), and the substitution is
 * two-phase through placeholder tokens so overlapping identities cannot
 * corrupt: a target owner CONTAINING the old owner (e2e-owner-fork) or a
 * target name containing it (my-e2e-owner-repo) would otherwise be re-matched
 * by the sequential owner pass. The disambiguation probe and every section
 * read then see a coherent repo for this target.
 */
function reslugRepo(repo: Json, slug: string): void {
  const [owner, name] = slug.split("/");
  const oldSlug = typeof repo.full_name === "string" ? repo.full_name : "";
  const ownerObj = repo.owner;
  const oldOwner =
    isPlainObject(ownerObj) && typeof ownerObj.login === "string" ? ownerObj.login : "";
  // NUL-delimited tokens: a url string can never legitimately contain NUL,
  // so the tokens cannot collide with real content.
  const SLUG_TOKEN = "\u0000slug\u0000";
  const OWNER_TOKEN = "\u0000owner\u0000";
  const rewriteUrl = (value: string): string => {
    // Tokenize every OLD occurrence first (longest match first: the combined
    // slug, then the bare owner the owner's own urls carry), then fill the
    // tokens with the new identity - the new values are never re-scanned.
    let out = value;
    if (oldSlug !== "") {
      out = out.replaceAll(oldSlug, SLUG_TOKEN);
    }
    if (oldOwner !== "") {
      out = out.replaceAll(oldOwner, OWNER_TOKEN);
    }
    return out.replaceAll(SLUG_TOKEN, slug).replaceAll(OWNER_TOKEN, owner ?? "");
  };
  const rewriteUrlFields = (obj: Json): void => {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === "string" && (key === "url" || key.endsWith("_url"))) {
        obj[key] = rewriteUrl(value);
      } else if (isPlainObject(value)) {
        rewriteUrlFields(value);
      }
    }
  };
  rewriteUrlFields(repo);
  repo.full_name = slug;
  repo.name = name ?? slug;
  if (isPlainObject(ownerObj)) {
    ownerObj.login = owner ?? "";
  }
}

/** Build one target's MockState from its spec, stamped with its slug. */
export function buildStateForSlug(
  slug: string,
  spec: MultiRepoSpec,
  ownerKind: OwnerKind,
): MockState {
  // buildState reslugs and then stamps the node ids (they carry the slug),
  // so nothing further is minted here.
  return buildState(spec.liveState, ownerKind, slug);
}

/**
 * A discovery-pool repo body: the fixture repo re-slugged, with the four
 * filterable attributes overlaid so the action's discovery filters can act on
 * them. Only the fields discovery reads need be realistic; the node id is
 * still minted so any id that leaves the mock decodes.
 */
function discoveryRepoBody(spec: DiscoveryRepoSpec): Json {
  const body = restRepoSurface(clone(repoFixture as Json));
  reslugRepo(body, spec.slug);
  body.node_id = mintNodeId("repo", spec.slug, "");
  if (spec.archived !== undefined) {
    body.archived = spec.archived;
  }
  if (spec.fork !== undefined) {
    body.fork = spec.fork;
  }
  if (spec.visibility !== undefined) {
    body.visibility = spec.visibility;
  }
  if (spec.topics !== undefined) {
    body.topics = spec.topics;
  }
  return body;
}

/**
 * Materialize a MultiMockState. `repos` maps each target slug to its spec;
 * `discoveryPool` (optional) is the `/user/repos` enumeration for repos: "*"
 * scenarios. A discovery-pool slug that also has a repos spec shares that
 * spec's per-slug state and settings; a pool slug WITHOUT a spec still gets a
 * default state and a null settings file (so an unconfigured discovered repo
 * reads as "no settings", the skipped path).
 */
export function buildMultiState(
  repos: Record<string, MultiRepoSpec>,
  discoveryPool: DiscoveryRepoSpec[] | undefined,
  ownerKind: OwnerKind,
): MultiMockState {
  const state: MultiMockState = {
    repos: new Map(),
    settings: new Map(),
    permissions: new Map(),
    discoveryPool: (discoveryPool ?? []).map(discoveryRepoBody),
    // The org-level endpoints read only `org`; a default MockState carries the
    // org fixture (or null org for a personal account) with the admin owner.
    orgState: buildState(undefined, ownerKind),
  };
  const ensure = (slug: string, spec: MultiRepoSpec): void => {
    state.repos.set(slug, buildStateForSlug(slug, spec, ownerKind));
    state.settings.set(slug, spec.settingsYaml);
    state.permissions.set(slug, spec.permissions ?? {});
  };
  for (const [slug, spec] of Object.entries(repos)) {
    ensure(slug, spec);
  }
  // Discovered slugs with no explicit spec: default state seeded with the pool's
  // visibility, no settings file. Seeding the visibility matters for the report
  // channel: a discovered PRIVATE repo needs no probe (its visibility came from
  // /user/repos), so it is deliverable - but the mock's delivery gate reads the
  // per-slug repo state's visibility, which would otherwise default to public and
  // wrongly reject the legitimate delivery. Carrying the discovery visibility
  // into the state keeps fixture and discovery-supplied visibility in agreement.
  for (const pool of discoveryPool ?? []) {
    if (state.repos.has(pool.slug)) {
      continue;
    }
    const liveState =
      pool.visibility === undefined
        ? undefined
        : { repo: { visibility: pool.visibility, private: pool.visibility !== "public" } };
    ensure(pool.slug, { settingsYaml: null, liveState });
  }
  return state;
}

// --- Write-to-read transformers ------------------------------------------
//
// Each turns a section's mutation payload (the PUT/POST body the handler sends)
// into the GET-shape body the mock stores and later serves. They invert the
// section flatteners exactly, so a check run over freshly-applied state reports
// no drift. All are pure and side-effect free.

/** A branch-protection actor list ({login}/{slug} objects) built from names. */
function expandActors(value: unknown, nameKey: "login" | "slug"): Json[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((name) => ({ [nameKey]: String(name) }));
}

/** Wrap a boolean into the GET-shape `{enabled}` object the flattener collapses. */
function enabledObject(value: unknown): Json {
  return { enabled: value === true };
}

/**
 * Turn a branch-protection PUT body into the GET shape. Booleans become
 * `{enabled}` objects; required_status_checks and required_pull_request_reviews
 * nest; the restriction/dismissal/bypass string arrays expand into
 * `{login}`/`{slug}` objects. The inverse of branches' `flattenProtection`:
 * feeding this output through that flattener reproduces the payload's declared
 * keys. Only keys present in the payload are emitted, so the section's
 * declared-keys-only diff sees no phantom fields. The one dropped key is
 * required_signatures: GitHub's PUT silently discards it (its own
 * sub-endpoint sets it), and the mock mirrors that.
 */
export function protectionFromPut(payload: Json): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === null) {
      // A null core key (e.g. restrictions: null) reads back as absent in the
      // GET shape; the flattener would surface null either way, so drop it.
      continue;
    }
    switch (key) {
      case "required_signatures":
        // GitHub's protection PUT silently drops this toggle - only the
        // dedicated sub-endpoint (branches.sigPost/sigDelete) may set it -
        // so the stored GET shape must not gain it from a PUT body.
        break;
      case "enforce_admins":
      case "required_linear_history":
      case "allow_force_pushes":
      case "allow_deletions":
      case "block_creations":
      case "required_conversation_resolution":
      case "lock_branch":
      case "allow_fork_syncing":
        out[key] = enabledObject(value);
        break;
      case "restrictions": {
        const r = value as Json;
        out.restrictions = {
          users: expandActors(r.users, "login"),
          teams: expandActors(r.teams, "slug"),
          apps: expandActors(r.apps, "slug"),
        };
        break;
      }
      case "required_pull_request_reviews": {
        const rpr = value as Json;
        const nested: Json = { ...rpr };
        const dr = rpr.dismissal_restrictions;
        if (isPlainObject(dr)) {
          nested.dismissal_restrictions = {
            users: expandActors(dr.users, "login"),
            teams: expandActors(dr.teams, "slug"),
            apps: expandActors(dr.apps, "slug"),
          };
        }
        const bp = rpr.bypass_pull_request_allowances;
        if (isPlainObject(bp)) {
          nested.bypass_pull_request_allowances = {
            users: expandActors(bp.users, "login"),
            teams: expandActors(bp.teams, "slug"),
            apps: expandActors(bp.apps, "slug"),
          };
        }
        out.required_pull_request_reviews = nested;
        break;
      }
      default:
        // required_status_checks and any future scalar/object keys pass
        // through verbatim; the flattener leaves non-{enabled} objects alone.
        out[key] = value;
    }
  }
  return out;
}

// --- Branch protection rules (the GraphQL surface) --------------------------
//
// The rules query serves the UNION of literal rules (branch_protection
// projected into GraphQL rule nodes) and wildcard rules (the
// branch_protection_rules family). The projection imports the branches
// section's own translation tables, and the state test proves the section's
// classicViewOfRule inverts it, the protectionFromPut round-trip precedent.

/**
 * The users a force_push_bypassers entry can name in scenarios and fuzz
 * draws; the actor-user lookup answers NOT_FOUND for anything else.
 */
export const BYPASS_ACTOR_USERS: readonly string[] = ["octocat", "release-bot"];

/**
 * The org teams ("org/team-slug") the actor-team lookup resolves; an unknown
 * org answers NOT_FOUND, a known org with an unknown team answers team: null
 * (GitHub's nullable-field shape).
 */
export const BYPASS_ACTOR_TEAMS: readonly string[] = [
  `${ADMIN_OWNER}/platform`,
  `${ADMIN_OWNER}/release-guild`,
];

/**
 * Complete a (possibly sparse) internal rule seed to the full field set the
 * wire node needs (the GraphQL type's booleans are non-null), with GitHub's
 * fresh-rule defaults. The seed's own fields win; the id is stamped later
 * (stampNodeIds) or minted by the create handler.
 */
export function completeRule(seed: Json): Json {
  return {
    pattern: "*",
    isAdminEnforced: false,
    requiresLinearHistory: false,
    allowsForcePushes: false,
    allowsDeletions: false,
    blocksCreations: false,
    requiresConversationResolution: false,
    lockBranch: false,
    lockAllowsFetchAndMerge: false,
    requiresCommitSignatures: false,
    requiresStatusChecks: false,
    requiresStrictStatusChecks: false,
    requiredStatusCheckContexts: [],
    requiresApprovingReviews: false,
    requiredApprovingReviewCount: null,
    requiresCodeOwnerReviews: false,
    dismissesStaleReviews: false,
    requireLastPushApproval: false,
    requiresDeployments: false,
    requiredDeploymentEnvironments: [],
    bypassForcePushActors: [],
    ...seed,
  };
}

/** Expand internal actor strings into the query's allowance-node selection. */
function bypassAllowanceNodes(actors: unknown): Json {
  const list = Array.isArray(actors) ? actors.map(String) : [];
  return {
    nodes: list.map((raw) => {
      const actor = parseBypassActor(raw);
      if (actor === null) {
        return { actor: null };
      }
      if (actor.kind === "user") {
        return { actor: { __typename: "User", login: actor.login } };
      }
      if (actor.kind === "team") {
        return { actor: { __typename: "Team", combinedSlug: raw } };
      }
      return { actor: { __typename: "App", slug: actor.slug } };
    }),
    // The section reads one 100-node page and fails loudly on a truncation
    // signal; the mock's lists never exceed that, so this is always false.
    pageInfo: { hasNextPage: false },
  };
}

/** Project one stored internal rule into the wire node the query serves. */
export function ruleWireNode(stored: Json): Json {
  const { bypassForcePushActors, ...fields } = stored;
  return { ...fields, bypassForcePushAllowances: bypassAllowanceNodes(bypassForcePushActors) };
}

/** Unwrap a GET-shape `{enabled}` boolean (or a bare boolean seed). */
function enabledOf(value: unknown): boolean {
  return isPlainObject(value) ? value.enabled === true : value === true;
}

/**
 * Project one LITERAL rule into the wire node: the stored REST GET shape
 * translated through the section's own twin tables, plus the GraphQL-only
 * extras family. The inverse of the section's classicViewOfRule, proven by
 * the state test.
 */
export function ruleFromProtection(
  pattern: string,
  protection: Json,
  extras: Json | undefined,
  slug: string,
): Json {
  const stored = completeRule({ pattern });
  stored.id = mintNodeId("rule", slug, pattern);
  for (const [classic, twin] of Object.entries(GRAPHQL_BOOLEAN_TWINS)) {
    if (classic in protection) {
      stored[twin] = enabledOf(protection[classic]);
    }
  }
  const checks = protection.required_status_checks;
  if (isPlainObject(checks)) {
    stored.requiresStatusChecks = true;
    if ("strict" in checks) {
      stored.requiresStrictStatusChecks = checks.strict === true;
    }
    if (Array.isArray(checks.contexts)) {
      stored.requiredStatusCheckContexts = [...checks.contexts];
    }
  }
  const reviews = protection.required_pull_request_reviews;
  if (isPlainObject(reviews)) {
    stored.requiresApprovingReviews = true;
    for (const [classic, twin] of Object.entries(GRAPHQL_REVIEW_TWINS)) {
      if (classic in reviews) {
        stored[twin] = reviews[classic];
      }
    }
  }
  if (extras) {
    Object.assign(stored, extras);
  }
  return ruleWireNode(stored);
}

/**
 * Every rule node the rules query serves, deterministically ordered: the
 * literal projections plus the wildcard family. REST GETs never see the
 * wildcard family, mirroring GitHub (a glob rule is REST-invisible).
 */
export function allRuleNodes(state: MockState): Json[] {
  const slug = state.slug;
  const nodes: Json[] = [];
  for (const [branch, protection] of Object.entries(state.branch_protection)) {
    if (protection) {
      nodes.push(
        ruleFromProtection(branch, protection, state.branch_protection_graphql[branch], slug),
      );
    }
  }
  for (const rule of state.branch_protection_rules) {
    nodes.push(ruleWireNode(rule));
  }
  nodes.sort((a, b) => String(a.pattern).localeCompare(String(b.pattern)));
  return nodes;
}

/**
 * GitHub's verified silent-drop behavior, mimicked: the mutation keeps only
 * requiredDeploymentEnvironments names that exist as deployment environments
 * and succeeds regardless, so the section's read-back check is what has to
 * catch a dropped name. Environment names are case-insensitive on GitHub
 * and stored canonically, so a kept name echoes the STORED spelling.
 */
function dropMissingEnvironments(names: unknown, state: MockState): string[] {
  const canonical = new Map(
    Object.keys(state.environments).map((name) => [name.toLowerCase(), name]),
  );
  const out: string[] = [];
  for (const name of Array.isArray(names) ? names.map(String) : []) {
    const stored = canonical.get(name.toLowerCase());
    if (stored !== undefined) {
      out.push(stored);
    }
  }
  return out;
}

/** Decode minted actor node ids back to the declared string vocabulary. */
function actorStringsFromIds(ids: unknown): { actors: string[] } | { bad: string } {
  const out: string[] = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const decoded = decodeNodeId(String(id));
    if (decoded === null) {
      return { bad: String(id) };
    }
    if (decoded.family === "user" || decoded.family === "team") {
      out.push(decoded.key);
    } else if (decoded.family === "app") {
      out.push(`app/${decoded.key}`);
    } else {
      return { bad: String(id) };
    }
  }
  return { actors: out };
}

/**
 * Apply a rule mutation's input fields onto a stored internal rule: the
 * target/bookkeeping ids are skipped, actor ids decode back to strings,
 * the deployment environment list passes through the silent drop, and every
 * other field is a GraphQL-named twin stored verbatim.
 */
export function applyRuleInput(
  stored: Json,
  input: Json,
  state: MockState,
): { ok: true } | { bad: string } {
  for (const [key, value] of Object.entries(input)) {
    switch (key) {
      case "branchProtectionRuleId":
      case "repositoryId":
      case "clientMutationId":
        break;
      case "pattern":
        stored.pattern = String(value);
        break;
      case "bypassForcePushActorIds": {
        const decoded = actorStringsFromIds(value);
        if ("bad" in decoded) {
          return decoded;
        }
        stored.bypassForcePushActors = decoded.actors;
        break;
      }
      case "requiredDeploymentEnvironments":
        stored.requiredDeploymentEnvironments = dropMissingEnvironments(value, state);
        break;
      default:
        stored[key] = value;
    }
  }
  return { ok: true };
}

/** The classic GET-shape key of each GraphQL boolean twin, for the inverse map. */
const CLASSIC_BY_TWIN: Record<string, string> = Object.fromEntries(
  Object.entries(GRAPHQL_BOOLEAN_TWINS).map(([classic, twin]) => [twin, classic]),
);

const REVIEW_CLASSIC_BY_TWIN: Record<string, string> = Object.fromEntries(
  Object.entries(GRAPHQL_REVIEW_TWINS).map(([classic, twin]) => [twin, classic]),
);

const STATUS_CLASSIC_BY_TWIN: Record<string, string> = Object.fromEntries(
  Object.entries(GRAPHQL_STATUS_CHECK_TWINS).map(([classic, twin]) => [twin, classic]),
);

/**
 * Apply a rule mutation's input onto a LITERAL rule: the GraphQL-only
 * fields land in the extras family, and every translated twin lands back on
 * the stored REST GET shape (the classic key, {enabled}-wrapped for the
 * booleans) so both views keep agreeing - GitHub's one underlying rule.
 */
export function applyRuleInputToLiteral(
  state: MockState,
  branch: string,
  input: Json,
): { ok: true } | { bad: string } {
  const protection = state.branch_protection[branch] as Json;
  if (state.branch_protection_graphql[branch] === undefined) {
    state.branch_protection_graphql[branch] = {};
  }
  const extras = state.branch_protection_graphql[branch] as Json;
  for (const [key, value] of Object.entries(input)) {
    switch (key) {
      case "branchProtectionRuleId":
      case "clientMutationId":
        break;
      case "bypassForcePushActorIds": {
        const decoded = actorStringsFromIds(value);
        if ("bad" in decoded) {
          return decoded;
        }
        extras.bypassForcePushActors = decoded.actors;
        break;
      }
      case "requiresDeployments":
        extras.requiresDeployments = value === true;
        break;
      case "requiredDeploymentEnvironments":
        extras.requiredDeploymentEnvironments = dropMissingEnvironments(value, state);
        break;
      case "requiresStatusChecks":
        if (value !== true) {
          delete protection.required_status_checks;
        } else if (!isPlainObject(protection.required_status_checks)) {
          protection.required_status_checks = { strict: false, contexts: [] };
        }
        break;
      case "requiresApprovingReviews":
        if (value !== true) {
          delete protection.required_pull_request_reviews;
        } else if (!isPlainObject(protection.required_pull_request_reviews)) {
          protection.required_pull_request_reviews = {};
        }
        break;
      default: {
        const classicBoolean = CLASSIC_BY_TWIN[key];
        if (classicBoolean !== undefined) {
          protection[classicBoolean] = { enabled: value === true };
          break;
        }
        const classicReview = REVIEW_CLASSIC_BY_TWIN[key];
        if (classicReview !== undefined) {
          if (!isPlainObject(protection.required_pull_request_reviews)) {
            protection.required_pull_request_reviews = {};
          }
          (protection.required_pull_request_reviews as Json)[classicReview] = value;
          break;
        }
        const classicStatus = STATUS_CLASSIC_BY_TWIN[key];
        if (classicStatus !== undefined) {
          if (!isPlainObject(protection.required_status_checks)) {
            protection.required_status_checks = { strict: false, contexts: [] };
          }
          (protection.required_status_checks as Json)[classicStatus] = value;
          break;
        }
        // A field with no classic destination (a future twin): keep it on
        // the extras so a read-back still echoes what was stored.
        extras[key] = value;
      }
    }
  }
  return { ok: true };
}

/**
 * Turn an environments PUT body into the GET shape: wait_timer,
 * prevent_self_review, and reviewers move into `protection_rules[]` the way
 * environments' `flattenEnvironment` reads them back; deployment_branch_policy
 * passes through unchanged. Reviewers keep their {type, id} pair wrapped in a
 * `reviewer` object carrying the id, matching the flattener's extraction.
 */
export function environmentFromPut(payload: Json): Json {
  const { wait_timer, prevent_self_review, reviewers, ...rest } = payload;
  const rules: Json[] = [];
  if (wait_timer !== undefined) {
    rules.push({ type: "wait_timer", wait_timer });
  }
  if (prevent_self_review !== undefined || reviewers !== undefined) {
    const rule: Json = { type: "required_reviewers" };
    if (prevent_self_review !== undefined) {
      rule.prevent_self_review = prevent_self_review;
    }
    if (Array.isArray(reviewers)) {
      rule.reviewers = reviewers.map((r) => {
        const reviewer = r as { type?: unknown; id?: unknown };
        return { type: reviewer.type, reviewer: { id: reviewer.id } };
      });
    }
    rules.push(rule);
  }
  return { ...rest, protection_rules: rules };
}

/**
 * Turn a collaborator PUT body for an EXISTING collaborator into the
 * GET-shape collaborator object the list endpoint returns: the declared
 * `permission` (pull/push/...) becomes `role_name` via the shared
 * `roleForPermission`, so a check run compares like with like. A PUT for a
 * non-collaborator creates a pending invitation instead (invitationFromPut).
 */
export function collaboratorFromPut(username: string, payload: Json): Json {
  const permission = String(payload.permission ?? "push");
  return {
    login: username,
    id: 0,
    type: "User",
    site_admin: false,
    role_name: roleForPermission(permission),
  };
}

/**
 * The spec-enum `permissions` string a collaborator PUT payload maps to on
 * the invitation it creates: the declared permission (pull/push/...) through
 * the shared `roleForPermission`, clamped into INVITATION_ROLES - GitHub
 * never reports a custom role name on an invitation, only its base grant,
 * modeled here as "write".
 */
export function invitationPermissionFromPut(payload: Json): string {
  const role = roleForPermission(String(payload.permission ?? "push"));
  return INVITATION_ROLES.has(role) ? role : "write";
}

/**
 * Turn a collaborator PUT body for a NON-collaborator into the stored
 * repository-invitation object, with `permissions` mapped via
 * invitationPermissionFromPut so a freshly-invited user reads back exactly
 * what the section compares pending invitations with.
 */
export function invitationFromPut(
  username: string,
  payload: Json,
  id: number,
  repo: Json,
  slug: string,
): Json {
  return completeInvitation(
    { invitee: { login: username }, permissions: invitationPermissionFromPut(payload) },
    id,
    repo,
    slug,
  );
}

/**
 * Turn a team-repo PUT body into the repository-media-type GET shape the teams
 * probe reads: only `role_name` matters to the section, mapped from the
 * declared `permission` via `roleForPermission`.
 */
export function teamRepoFromPut(payload: Json): { role_name: string } {
  const permission = String(payload.permission ?? "push");
  return { role_name: roleForPermission(permission) };
}
