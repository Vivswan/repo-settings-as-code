/**
 * `repository:` section - PATCH passthrough for repo fields, plus the
 * settings that live on their own endpoints even though the settings file
 * nests them here: topics, the feature toggles, and the two GraphQL-only
 * keys (the Sponsor button and the issue creation policy).
 */

import { z } from "zod";
import { phantomKeys, phantomNote, subsetDiff } from "../../engine/diff.js";
import { type EndpointDecl, repoVariables } from "../contract/endpoints.js";
import { type GraphqlOpDecl, type GraphqlVariablesOf, graphqlOp } from "../contract/graphql.js";
import { parseLive } from "../contract/live.js";
import {
  loosen,
  requirePlainMapping,
  type SectionMeta,
  type SectionModule,
} from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import {
  hasDrift,
  type PlanContext,
  type PlannedOp,
  plainData,
  type SectionPlan,
} from "../contract/plan.js";
import { RepositoryConfig } from "./schema.js";

/** Topics: accept a comma-separated string or an array; lowercase, dedupe. */
export function normalizeTopics(raw: unknown): string[] {
  const values = Array.isArray(raw)
    ? raw.map(String)
    : String(raw ?? "")
        .split(",")
        .map((t) => t.trim());
  return [...new Set(values.map((t) => t.toLowerCase()).filter(Boolean))];
}

/**
 * A repository key the settings schema declares a type for. Typing the
 * toggle and routed-key tables with it keeps them in lockstep with
 * schema.ts, which now carries the value validation (and its YAML
 * boolean-gotcha error prose) the shape sweep here used to do: a toggle
 * added below without a schema declaration fails to compile.
 */
type DeclaredRepositoryKey = keyof typeof RepositoryConfig.shape & string;

const permission: SectionPermission = { repo: ["administration"] };

/**
 * The LFS endpoints' 403 is ambiguous three ways: LFS disabled account-wide,
 * disabled for the root of the repository network, or (on organization
 * repositories) a credential without billing access - none of which a token
 * grant fixes.
 */
const LFS_DENIAL_HINT =
  "a 403 here can also mean Git LFS is disabled account-wide or for the root of this " +
  "repository network, or that the credential lacks billing access (organization repositories " +
  "need an organization owner or billing manager), rather than a missing token grant";

/**
 * The declared meaning of the 409 both immutable-releases writes answer when
 * the repository owner enforces the feature; the apply note and the check
 * drift prose build on the same words.
 */
const OWNER_ENFORCED = "the repository owner enforces immutable releases";

// The repo-level endpoints plus each security toggle's own GET/PUT/DELETE
// triple, all in one dictionary so the mock server and USED_PATHS derivation
// see every path this section can touch. FEATURE_TOGGLES below names these
// same entries by role, so declaration and use cannot drift.
const ENDPOINTS = {
  get: {
    route: "GET /repos/{owner}/{repo}",
    statuses: { 200: "the repository" },
    primaryRead: { notFound: "denied" },
  },
  update: { route: "PATCH /repos/{owner}/{repo}", statuses: { 200: "repository fields patched" } },
  topics: { route: "PUT /repos/{owner}/{repo}/topics", statuses: { 200: "topics replaced" } },
  vulnerabilityAlertsGet: {
    route: "GET /repos/{owner}/{repo}/vulnerability-alerts",
    statuses: { 204: "vulnerability alerts are enabled", 404: "vulnerability alerts are disabled" },
  },
  vulnerabilityAlertsPut: {
    route: "PUT /repos/{owner}/{repo}/vulnerability-alerts",
    statuses: { 204: "vulnerability alerts enabled" },
  },
  vulnerabilityAlertsRemove: {
    route: "DELETE /repos/{owner}/{repo}/vulnerability-alerts",
    statuses: { 204: "vulnerability alerts disabled" },
  },
  automatedSecurityFixesGet: {
    route: "GET /repos/{owner}/{repo}/automated-security-fixes",
    statuses: { 200: "the automated security fixes state", 404: "the feature is not enabled" },
  },
  automatedSecurityFixesPut: {
    route: "PUT /repos/{owner}/{repo}/automated-security-fixes",
    statuses: { 204: "automated security fixes enabled" },
  },
  automatedSecurityFixesRemove: {
    route: "DELETE /repos/{owner}/{repo}/automated-security-fixes",
    statuses: { 204: "automated security fixes disabled" },
  },
  privateVulnerabilityReportingGet: {
    route: "GET /repos/{owner}/{repo}/private-vulnerability-reporting",
    statuses: {
      200: "the private vulnerability reporting state readable from the body",
      404: "the feature is not applicable on this repository (observed: private repos); read as not enabled",
      422: "the same condition as 404, alternate answer",
    },
  },
  privateVulnerabilityReportingPut: {
    route: "PUT /repos/{owner}/{repo}/private-vulnerability-reporting",
    statuses: { 204: "private vulnerability reporting enabled" },
  },
  privateVulnerabilityReportingRemove: {
    route: "DELETE /repos/{owner}/{repo}/private-vulnerability-reporting",
    statuses: {
      204: "private vulnerability reporting disabled",
      404: "the feature is not applicable, so it is already off",
      422: "the feature is not applicable, so it is already off",
    },
  },
  immutableReleasesGet: {
    route: "GET /repos/{owner}/{repo}/immutable-releases",
    statuses: {
      200: "the immutable releases state readable from the body",
      404: "immutable releases are not enabled",
    },
  },
  immutableReleasesPut: {
    route: "PUT /repos/{owner}/{repo}/immutable-releases",
    statuses: { 204: "immutable releases enabled", 409: OWNER_ENFORCED },
  },
  immutableReleasesRemove: {
    route: "DELETE /repos/{owner}/{repo}/immutable-releases",
    statuses: { 204: "immutable releases disabled", 409: OWNER_ENFORCED },
  },
  // Git LFS has no read endpoint, so the declared state is re-asserted on
  // every apply: alwaysRewrite by contract, like the sealed secret PUTs.
  lfsPut: {
    route: "PUT /repos/{owner}/{repo}/lfs",
    statuses: { 202: "Git LFS enabled (GitHub processes the change asynchronously)" },
    denialHint: LFS_DENIAL_HINT,
    alwaysRewrite: true,
  },
  lfsRemove: {
    route: "DELETE /repos/{owner}/{repo}/lfs",
    statuses: { 204: "Git LFS disabled" },
    denialHint: LFS_DENIAL_HINT,
    alwaysRewrite: true,
  },
} as const satisfies Record<string, EndpointDecl>;

/**
 * The repo GET fields this section reads BY NAME (the rest of the body rides
 * into subsetDiff as passthrough): topics, whose set comparison below sorts
 * a real string list; nullish absorbs an absent or null list exactly as the
 * pre-parse fallback did.
 */
const LiveRepository = z.looseObject({ topics: z.array(z.string()).nullish() });

const FEATURES_QUERY = graphqlOp<{ owner: string; repo: string }>()({
  name: "RepositoryFeatures",
  kind: "read",
  query:
    "query RepositoryFeatures($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { id hasSponsorshipsEnabled issueCreationPolicy } }",
  outcomes: {
    ok: "the sponsor-button and issue-creation-policy state, plus the node id the mutation addresses",
  },
});

/** The settings-file vocabulary for issue_creation_policy -> GitHub's enum. */
const ISSUE_CREATION_POLICIES = {
  all: "ALL",
  collaborators_only: "COLLABORATORS_ONLY",
} as const;

type IssueCreationPolicy = keyof typeof ISSUE_CREATION_POLICIES;

// The GraphQL absent-variable rule makes one mutation serve any declared
// subset: an input field fed by an unprovided variable is treated as not
// provided, so the input carries exactly the keys apply needs to move.
const UPDATE_FEATURES = graphqlOp<{
  repositoryId: string;
  hasSponsorshipsEnabled?: boolean;
  issueCreationPolicy?: (typeof ISSUE_CREATION_POLICIES)[IssueCreationPolicy];
}>()({
  name: "UpdateRepositoryFeatures",
  kind: "write",
  query: `mutation UpdateRepositoryFeatures(
    $repositoryId: ID!
    $hasSponsorshipsEnabled: Boolean
    $issueCreationPolicy: IssueCreationPolicy
  ) {
    updateRepository(
      input: {
        repositoryId: $repositoryId
        hasSponsorshipsEnabled: $hasSponsorshipsEnabled
        issueCreationPolicy: $issueCreationPolicy
      }
    ) {
      repository { hasSponsorshipsEnabled issueCreationPolicy }
    }
  }`,
  outcomes: { ok: "the carried values set; the echoed state verifies each one took" },
});

const GRAPHQL_OPS = {
  featuresQuery: FEATURES_QUERY,
  updateFeatures: UPDATE_FEATURES,
} as const satisfies Record<string, GraphqlOpDecl>;

/** This section's plan context, operations, and plan, over its literal dictionaries. */
type RepositoryContext = PlanContext<typeof ENDPOINTS, typeof GRAPHQL_OPS>;
type RepositoryOp = PlannedOp<typeof ENDPOINTS, typeof GRAPHQL_OPS>;
type RepositoryPlan = SectionPlan<RepositoryOp>;

/** The REST write roles an operation may name. */
type RestWriteRole = Extract<RepositoryOp, { variables?: never }>["role"];

/** The write roles whose declaration is alwaysRewrite: the only ones a driftless operation may name. */
type RewriteRole = {
  [R in RestWriteRole]: (typeof ENDPOINTS)[R] extends { readonly alwaysRewrite: true } ? R : never;
}[RestWriteRole];

/** The read roles bound as absence probes: a toggle's GET, whose 404 means "not enabled". */
type ProbeRole = {
  [R in keyof RepositoryContext["read"]]: RepositoryContext["read"][R] extends {
    probeAbsent: unknown;
  }
    ? R
    : never;
}[keyof RepositoryContext["read"]];

/** The mutation's variables; each routed key contributes its own field. */
type FeatureVariables = GraphqlVariablesOf<typeof UPDATE_FEATURES>;

/**
 * One boolean settings key backed by PUT/DELETE on its own sub-resource,
 * named by ROLE in ENDPOINTS so a planned operation types against the
 * declaration it executes.
 */
interface FeatureToggle {
  key: DeclaredRepositoryKey;
  label: string;
  put: RestWriteRole;
  remove: RestWriteRole;
}

/**
 * A toggle whose state can be read back: the GET's declared tolerable
 * statuses mean "not enabled", a write's mean "nothing changed here"
 * (owner-enforced, already off) and are tolerated by declaration.
 */
interface ReadableToggle extends FeatureToggle {
  get: ProbeRole;
  /**
   * The documented shape of a successful GET body, parsed at the boundary
   * (parseLive) so a body off the contract fails loudly instead of reading
   * as a definite on or off state that drives a write.
   */
  live: z.ZodType<LiveToggle>;
  /** Read the enabled state from the parsed GET body. */
  isEnabled: (live: LiveToggle) => boolean;
  /**
   * Whether the live state is enforced above the repository (immutable
   * releases' enforced_by_owner), so the drift prose says apply cannot
   * change it instead of promising to.
   */
  isEnforced?: (live: LiveToggle) => boolean;
}

/** A toggle GET's body: the 204 no-content answer, or the documented state object. */
type LiveToggle = null | { enabled: boolean; enforced_by_owner?: boolean };

/** The 204 no-content body a toggle GET answers when the feature is on. */
const LiveNoContent = z.null();

/** The `{enabled}` state object, with immutable releases' enforcement flag. */
const LiveToggleState = z.looseObject({
  enabled: z.boolean(),
  enforced_by_owner: z.boolean().optional(),
});

const READABLE_TOGGLES: readonly ReadableToggle[] = [
  {
    key: "enable_vulnerability_alerts",
    label: "vulnerability alerts",
    get: "vulnerabilityAlertsGet",
    put: "vulnerabilityAlertsPut",
    remove: "vulnerabilityAlertsRemove",
    // The declared 204 has no body: reaching it at all means enabled.
    live: LiveNoContent,
    isEnabled: () => true,
  },
  {
    key: "enable_automated_security_fixes",
    label: "automated security fixes",
    get: "automatedSecurityFixesGet",
    put: "automatedSecurityFixesPut",
    remove: "automatedSecurityFixesRemove",
    live: LiveToggleState,
    isEnabled: (live) => live?.enabled === true,
  },
  {
    key: "enable_private_vulnerability_reporting",
    label: "private vulnerability reporting",
    get: "privateVulnerabilityReportingGet",
    put: "privateVulnerabilityReportingPut",
    remove: "privateVulnerabilityReportingRemove",
    live: LiveToggleState,
    isEnabled: (live) => live?.enabled === true,
  },
  {
    key: "enable_immutable_releases",
    label: "immutable releases",
    get: "immutableReleasesGet",
    put: "immutableReleasesPut",
    remove: "immutableReleasesRemove",
    live: LiveToggleState,
    isEnabled: (live) => live?.enabled === true,
    isEnforced: (live) => live?.enforced_by_owner === true,
  },
];

/**
 * A toggle with no read endpoint: its writes must be alwaysRewrite by
 * declaration, since no drift can ever justify them.
 */
interface WriteOnlyToggle extends FeatureToggle {
  put: RewriteRole;
  remove: RewriteRole;
}

const WRITE_ONLY_TOGGLES: readonly WriteOnlyToggle[] = [
  {
    key: "enable_git_lfs",
    label: "Git LFS",
    put: "lfsPut",
    remove: "lfsRemove",
  },
];

/**
 * The GraphQL-routed keys: two repository settings whose ONLY surface is
 * GraphQL. The issue creation policy is live-verified both ways (the REST
 * repo PATCH answers 200 and silently ignores an issue_creation_policy
 * field, and no REST GET returns one); the sponsor button has no REST field
 * at all. One read serves every declared key AND supplies the node id the
 * mutation addresses, so neither mode needs an extra round trip.
 *
 * SPECIAL_KEYS, the compare, and the mutate-and-verify operation all
 * iterate GRAPHQL_ROUTED_KEYS, so a new key cannot compile into a
 * stripped-but-never-applied no-op; value validation lives in schema.ts.
 */
interface RoutedKey {
  /** The settings-file key. */
  readonly key: DeclaredRepositoryKey;
  /** The change-line label ("sponsor button: enabled"). */
  readonly label: string;
  /** The Repository read field the live value and the echo are read from. */
  readonly field: "hasSponsorshipsEnabled" | "issueCreationPolicy";
  /** The mutation variable carrying a valid declared value. */
  variables(declared: unknown): Omit<FeatureVariables, "repositoryId">;
  /**
   * Map a readback field value to the settings-file vocabulary, or
   * undefined when the value is outside the vocabulary this section reads
   * (the caller fails loudly; folding to a default could report a clean
   * check against state the section does not understand).
   */
  decode(live: unknown): unknown;
  /** Render a settings-vocabulary value for drift prose (raw, like the toggles' drift lines). */
  show(value: unknown): string;
  /** Render a settings-vocabulary value for a change line ("enabled", "collaborators_only"). */
  changeText(value: unknown): string;
  /**
   * Appended to the unreadable-value error for a vocabulary this section
   * knows can surprise (the policy's SDL-nullable read). One sentence, no
   * trailing period.
   */
  readonly unreadableHint?: string;
}

const GRAPHQL_ROUTED_KEYS = [
  {
    key: "enable_sponsorships",
    label: "sponsor button",
    field: "hasSponsorshipsEnabled",
    variables: (declared) => ({ hasSponsorshipsEnabled: declared as boolean }),
    decode: (live) => (typeof live === "boolean" ? live : undefined),
    show: (value) => String(value),
    changeText: (value) => (value ? "enabled" : "disabled"),
  },
  {
    key: "issue_creation_policy",
    label: "issue creation policy",
    field: "issueCreationPolicy",
    variables: (declared) => ({
      issueCreationPolicy: ISSUE_CREATION_POLICIES[declared as IssueCreationPolicy],
    }),
    decode: (live) =>
      live === "ALL" ? "all" : live === "COLLABORATORS_ONLY" ? "collaborators_only" : undefined,
    show: (value) => String(value),
    changeText: (value) => String(value),
    // The SDL marks Repository.issueCreationPolicy nullable, though a live
    // probe never observed null (the policy is retained even with issues
    // disabled), so a null read stays a loud failure with honest prose.
    unreadableHint:
      "a null policy means GitHub reported no issue creation policy for this repository; otherwise the field vocabulary may have changed",
  },
] as const satisfies readonly RoutedKey[];

/**
 * Decode the routed fields of a repository object for the DECLARED keys
 * only, into the settings-file vocabulary. Scoping the strictness to
 * `routed` is deliberate: an unreadable value (the SDL-nullable policy, a
 * future enum member) must fail loudly for a key the file declares, and
 * must not fail a run that never declared it.
 */
function decodeRoutedFields(
  fields: Record<string, unknown>,
  routed: readonly RoutedKey[],
  opName: string,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const entry of routed) {
    const decoded = entry.decode(fields[entry.field]);
    if (decoded === undefined) {
      const hint = entry.unreadableHint ? `; ${entry.unreadableHint}` : "";
      throw new Error(
        `repository: GRAPHQL ${opName} returned ${entry.field} ${JSON.stringify(fields[entry.field])}, which this section cannot read as a repository.${entry.key} value${hint}. Drop the key, or update the action if GitHub's vocabulary moved`,
      );
    }
    values[entry.key] = decoded;
  }
  return values;
}

/** The routed-state read: the mutation's node id plus each declared key's live value. */
interface LiveRoutedState {
  id: string;
  values: Record<string, unknown>;
}

async function fetchRoutedState(
  ctx: RepositoryContext,
  routed: readonly RoutedKey[],
): Promise<LiveRoutedState> {
  const data = await ctx.read.featuresQuery.call(repoVariables(ctx));
  const repository = (data as { repository?: Record<string, unknown> }).repository;
  if (!repository || typeof repository.id !== "string") {
    throw new Error(
      `repository: GRAPHQL ${FEATURES_QUERY.name} returned no repository object with an id, so the ${GRAPHQL_ROUTED_KEYS.map((entry) => entry.key).join("/")} state cannot be read. Check the token's repository access`,
    );
  }
  return { id: repository.id, values: decodeRoutedFields(repository, routed, FEATURES_QUERY.name) };
}

/**
 * Every feature toggle, exported for the table-driven test that pins each
 * one to its own PUT/DELETE pair, never the base PATCH.
 */
export const FEATURE_TOGGLES: readonly FeatureToggle[] = [
  ...READABLE_TOGGLES,
  ...WRITE_ONLY_TOGGLES,
];

/**
 * The keys the repository section handles specially instead of sending them
 * through the base PATCH: `topics` (its own PUT), the feature toggles
 * (each a PUT/DELETE sub-endpoint), and the GraphQL-routed keys
 * (GRAPHQL_ROUTED_KEYS). Exported as the single source the README's
 * repository special-keys documentation is pinned against.
 */
export const SPECIAL_KEYS = new Set([
  "topics",
  ...FEATURE_TOGGLES.map((toggle) => toggle.key),
  ...GRAPHQL_ROUTED_KEYS.map((routed) => routed.key),
]);

/**
 * The note a toggle write's tolerated status turns into: a 409 means owner
 * enforcement; a 404/422 on a remove means the feature does not apply here
 * and was already off.
 */
function toggleTolerated(
  section: SectionMeta,
  toggle: FeatureToggle,
  role: RestWriteRole,
  status: number,
): string {
  const meaning = section.endpoints[role]?.statuses[status];
  return status === 409
    ? `repository.${toggle.key}: ${meaning}, so apply cannot change it from the repository (${status})`
    : `repository.${toggle.key}: ${meaning}, so nothing changed (${status})`;
}

export const repositorySection = {
  key: "repository",
  undeclaredDefault: "untouched",
  permission,
  endpoints: ENDPOINTS,
  graphql: GRAPHQL_OPS,
  shape: requirePlainMapping(loosen(RepositoryConfig)),
  async plan(ctx, declared) {
    const plan: RepositoryPlan = { ops: [], notes: [], drift: [] };
    const desired: Record<string, unknown> = declared;
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(desired)) {
      if (!SPECIAL_KEYS.has(key)) {
        patch[key] = value;
      }
    }

    const live = parseLive(this, ENDPOINTS.get, LiveRepository, await ctx.read.get.call());
    if (Object.keys(patch).length > 0) {
      // The PATCH is diff-gated and the fields pass through, so a declared
      // key GitHub ignores would re-PATCH on every apply without converging;
      // say so (the labels/milestones phantom-key idiom).
      const phantom = phantomKeys(patch, live);
      if (phantom.length > 0) {
        plan.notes.push(phantomNote("repository", phantom, "repository", "this PATCH will re-run"));
      }
      const drift = subsetDiff(patch, live, "repository");
      if (hasDrift(drift)) {
        plan.ops.push({
          role: "update",
          payload: plainData(patch),
          drift,
          change: `patched repository fields: ${Object.keys(patch).join(", ")}`,
        });
      }
    }
    if ("topics" in desired) {
      const names = normalizeTopics(desired.topics);
      const drift = subsetDiff(
        [...names].sort(),
        [...(live.topics ?? [])].sort(),
        "repository.topics",
      );
      if (hasDrift(drift)) {
        plan.ops.push({
          role: "topics",
          payload: { names },
          drift,
          change: `set topics: ${names.join(", ") || "(none)"}`,
        });
      }
    }
    for (const toggle of READABLE_TOGGLES) {
      if (!(toggle.key in desired)) {
        continue;
      }
      const want = desired[toggle.key] === true;
      const probe = await ctx.read[toggle.get].probeAbsent();
      const live =
        "missing" in probe
          ? undefined
          : parseLive(this, ENDPOINTS[toggle.get], toggle.live, probe.data);
      const enabled = live === undefined ? false : toggle.isEnabled(live);
      if (enabled === want) {
        continue;
      }
      const enforced = live !== undefined && toggle.isEnforced?.(live) === true;
      const role = want ? toggle.put : toggle.remove;
      // The write's declared tolerable statuses (409 owner-enforced, 404/422
      // already off on a remove) mean nothing changed: a note, never a change
      // line. A write declaring no tolerable statuses tolerates nothing.
      plan.ops.push({
        role,
        drift: [
          enforced
            ? `repository.${toggle.key}: declared ${want} != live ${enabled}; the repository owner enforces ${toggle.label}, so apply cannot change it from the repository`
            : `repository.${toggle.key}: declared ${want} != live ${enabled}; apply will set the declared value`,
        ],
        tolerate: {
          outcome: (error) => ({ note: toggleTolerated(this, toggle, role, error.status) }),
        },
        change: `${toggle.label}: ${want ? "enabled" : "disabled"}`,
      });
    }
    for (const toggle of WRITE_ONLY_TOGGLES) {
      if (!(toggle.key in desired)) {
        continue;
      }
      const want = desired[toggle.key] === true;
      plan.notes.push(
        `repository.${toggle.key}: GitHub exposes no endpoint to read this state back, so check mode cannot verify it; apply re-asserts the declared value (${JSON.stringify(desired[toggle.key])}) on every run`,
      );
      // alwaysRewrite by declaration: no drift to report, the write recurs.
      plan.ops.push({
        role: want ? toggle.put : toggle.remove,
        drift: [],
        change: `${toggle.label}: ${want ? "enabled" : "disabled"}`,
      });
    }
    const declaredRouted = GRAPHQL_ROUTED_KEYS.filter((routed) => routed.key in desired);
    if (declaredRouted.length > 0) {
      // The routed-state read supplies the mutation's node id, so the
      // comparison is free and a converged repo issues no GraphQL write.
      const liveRouted = await fetchRoutedState(ctx, declaredRouted);
      const diverged = declaredRouted.filter(
        (routed) => desired[routed.key] !== liveRouted.values[routed.key],
      );
      const [first, ...rest] = diverged;
      if (first !== undefined) {
        const variables: FeatureVariables = Object.assign(
          { repositoryId: liveRouted.id },
          ...diverged.map((routed) => routed.variables(desired[routed.key])),
        );
        plan.ops.push({
          role: "updateFeatures",
          variables,
          drift: diverged.map(
            (routed) =>
              `repository.${routed.key}: declared ${routed.show(desired[routed.key])} != live ${routed.show(liveRouted.values[routed.key])}; apply will set the declared value`,
          ) as [string, ...string[]],
          // The mutation selects the post-state on purpose: a silently
          // ignored field is the REST failure mode that forced these keys
          // onto GraphQL, so each value is verified against the echo.
          change: (response) => {
            const echoedRepo = (
              response as { updateRepository?: { repository?: Record<string, unknown> } }
            ).updateRepository?.repository;
            if (!echoedRepo) {
              throw new Error(
                `repository: GRAPHQL ${UPDATE_FEATURES.name} returned no repository echo, so the write cannot be verified. GitHub may have changed the mutation payload; update the action`,
              );
            }
            const echoed = decodeRoutedFields(echoedRepo, diverged, UPDATE_FEATURES.name);
            const verified = (routed: RoutedKey): string => {
              if (echoed[routed.key] !== desired[routed.key]) {
                throw new Error(
                  `repository: GRAPHQL ${UPDATE_FEATURES.name} was accepted, but GitHub ` +
                    `reports repository.${routed.key} ${routed.show(echoed[routed.key])} where ` +
                    `${routed.show(desired[routed.key])} was set, so the write did not take. ` +
                    `GitHub may restrict this setting on the repository`,
                );
              }
              return `${routed.label}: ${routed.changeText(echoed[routed.key])}`;
            };
            return [verified(first), ...rest.map(verified)];
          },
        });
      }
    }
    return plan;
  },
} satisfies SectionModule<"repository", typeof ENDPOINTS, typeof GRAPHQL_OPS>;
