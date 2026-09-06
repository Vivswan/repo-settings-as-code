/**
 * `branches:` section - classic branch protection, Probot schema:
 * [{name, protection: {...} | null}]. The protection PUT requires the four
 * core keys to be present (null is a valid value); protection: null removes
 * protection entirely. Three surfaces are REST-invisible and route through
 * GraphQL instead:
 *   - required_signatures is stripped from the PUT (GitHub silently drops
 *     it) and applied through its own POST/DELETE sub-endpoint;
 *   - force_push_bypassers and required_deployments have no REST field at
 *     all, so both are stripped from the PUT and applied through ONE
 *     updateBranchProtectionRule mutation, planned when they drift and
 *     again after any planned PUT;
 *   - a WILDCARD entry (its name contains one of the characters git
 *     refnames forbid: `*`, `?`, `[`) is invisible to every REST protection
 *     endpoint, so it reconciles entirely through the GraphQL rule
 *     mutations, its protection restricted to the keys with exact GraphQL
 *     twins (GRAPHQL_BOOLEAN_TWINS and the two structured pairs in graphql-rules.ts).
 * The one rules query behind all of this fires only when an entry needs it;
 * a pure-REST declaration issues no GraphQL request at all.
 */

import { z } from "zod";
import { subsetDiff } from "../../engine/diff.js";
import { parseLive } from "../contract/live.js";
import { loosen, type SectionMeta, type SectionModule } from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import { plainData } from "../contract/plan.js";
import { rejectDuplicates } from "../contract/requests.js";
import { ENDPOINTS } from "./endpoints.js";
import {
  type BranchesContext,
  type BranchesPlan,
  fetchRules,
  GRAPHQL,
  GRAPHQL_REVIEW_TWINS,
  GRAPHQL_STATUS_CHECK_TWINS,
  type GraphqlRun,
  hasRoutedGraphqlKeys,
  justified,
  planRoutedUpdate,
  planWildcardEntry,
  resolveActorIds,
  WILDCARD_KEY_SET,
  WILDCARD_KEYS,
} from "./graphql-rules.js";
import { type BranchConfig, BranchesConfig } from "./schema.js";

const REQUIRED_PROTECTION_KEYS = [
  "required_status_checks",
  "enforce_admins",
  "required_pull_request_reviews",
  "restrictions",
] as const;

/**
 * True for a name no literal git branch can carry (refnames forbid `*`, `?`,
 * and `[`), so a wildcard entry can never collide with a literal one.
 */
export function isWildcardPattern(name: string): boolean {
  return /[*?[]/.test(name);
}

/**
 * The one list GitHub spells two ways inside required_status_checks: the
 * GET returns both, so a declaration carrying either covers the other.
 */
const STATUS_CHECK_ALIASES: Readonly<Record<string, string>> = {
  "required_status_checks.checks": "required_status_checks.contexts",
  "required_status_checks.contexts": "required_status_checks.checks",
};

/**
 * Nothing the replacing PUT would need to preserve: a default scalar (GitHub's
 * fill under a declared block), an empty list, or an actor holder with empty
 * lists. Any other nested object is a control that is ON by its presence.
 */
function isEmptySetting(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === "" || value === 0) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (isPlainMapping(value)) {
    const keys = Object.keys(value);
    return (
      keys.length > 0 && keys.every((key) => ACTOR_LIST_KEYS.has(key) && isEmptySetting(value[key]))
    );
  }
  return false;
}

/**
 * The live settings the replacing PUT would reset because the settings file
 * omits them: every non-empty live value at a path the declaration does not
 * carry, at any depth (the PUT replaces each nested object whole).
 */
function omittedLiveDrift(
  declared: Record<string, unknown>,
  live: Record<string, unknown>,
  prefix: string,
  path = "",
): string[] {
  const drift: string[] = [];
  for (const [key, value] of Object.entries(live)) {
    const keyPath = path === "" ? key : `${path}.${key}`;
    if (Object.hasOwn(declared, key)) {
      const inner = declared[key];
      if (isPlainMapping(inner) && isPlainMapping(value)) {
        drift.push(...omittedLiveDrift(inner, value, prefix, keyPath));
      }
      continue;
    }
    const alias = STATUS_CHECK_ALIASES[keyPath];
    if (alias !== undefined && Object.hasOwn(declared, alias.slice(alias.lastIndexOf(".") + 1))) {
      continue;
    }
    if (isEmptySetting(value)) {
      continue;
    }
    drift.push(
      `${prefix}.${keyPath}: set live but omitted from the settings file, so apply would REMOVE it; add ${keyPath} to the branch's protection in the settings file to keep it`,
    );
  }
  return drift;
}

function isPlainMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const permission: SectionPermission = { repo: ["administration"] };

/**
 * The protection GET body: a mapping, of which this section reads
 * required_signatures BY NAME (its {enabled} wrapper flattens to the boolean
 * the diff compares); every other field rides through flattenProtection as
 * passthrough.
 */
const LiveProtection = z.looseObject({
  required_signatures: z.looseObject({ enabled: z.boolean() }).optional(),
});

/**
 * One declared entry paired with its GraphQL proof at classification time: a
 * wildcard entry always carries the run state (its whole reconciliation is
 * the GraphQL surface), a literal entry carries it exactly when it declares
 * a routed key. The tag is built in the ONE place that decides whether the
 * run state exists, so an entry that needs GraphQL without the state being
 * constructed is unrepresentable - no cast, no predicate re-spelling.
 */
type ClassifiedEntry =
  | { kind: "wildcard"; branch: BranchConfig; graphqlRun: GraphqlRun }
  | { kind: "literal"; branch: BranchConfig; routed: { graphqlRun: GraphqlRun } | null };

const WILDCARD_KEY_ERROR = (name: string, key: string): string =>
  `the wildcard entry "${name}" declares protection.${key}, which this section does not manage on wildcard rules; only the keys it can round-trip through the GraphQL rule mutations apply here: [${WILDCARD_KEYS.join(
    ", ",
  )}]. For actor lists and richer controls, prefer the rulesets section (the modern successor of classic protection)`;

export const branchesSection = {
  key: "branches",
  undeclaredDefault: "untouched",
  permission,
  endpoints: ENDPOINTS,
  graphql: GRAPHQL,
  // The wildcard-entry key sweep composes onto the schema-derived shape HERE,
  // not in schema.ts: it reads the GraphQL translation tables (WILDCARD_KEYS,
  // the structured twins), which are this section's own machinery. Wildcard
  // entries reject every key outside those tables, since nothing else can
  // reach a wildcard rule.
  shape: loosen(BranchesConfig).superRefine((declared, refineCtx) => {
    if (!Array.isArray(declared)) {
      return;
    }
    declared.forEach((entry: BranchConfig, index) => {
      if (!isWildcardPattern(entry.name) || entry.protection === null) {
        return;
      }
      const protection = entry.protection as Record<string, unknown>;
      for (const key of Object.keys(protection)) {
        if (!WILDCARD_KEY_SET.has(key)) {
          refineCtx.addIssue({
            code: "custom",
            path: [index, "protection", key],
            message: WILDCARD_KEY_ERROR(entry.name, key),
          });
        }
      }
      // The structured pairs translate NAMED sub-keys only, so an unknown
      // sub-key on a wildcard entry would be silently lost - reject it with
      // the same pointer. A non-object value (a scalar or an array, both of
      // which the classic REST endpoint would reject server-side) is
      // rejected here too: nothing downstream could translate it.
      const nested: Array<[string, Record<string, string>]> = [
        ["required_status_checks", GRAPHQL_STATUS_CHECK_TWINS],
        ["required_pull_request_reviews", GRAPHQL_REVIEW_TWINS],
      ];
      for (const [key, twins] of nested) {
        const value = protection[key];
        if (value === null || value === undefined) {
          continue;
        }
        if (typeof value !== "object" || Array.isArray(value)) {
          refineCtx.addIssue({
            code: "custom",
            path: [index, "protection", key],
            message: `the wildcard entry "${entry.name}" declares protection.${key} as ${Array.isArray(value) ? "a list" : JSON.stringify(value)}, but on a wildcard rule it must be a mapping of its sub-keys [${Object.keys(twins).join(", ")}], or null to turn the control off`,
          });
          continue;
        }
        for (const subKey of Object.keys(value)) {
          if (!(subKey in twins)) {
            refineCtx.addIssue({
              code: "custom",
              path: [index, "protection", key, subKey],
              message: WILDCARD_KEY_ERROR(entry.name, `${key}.${subKey}`),
            });
          }
        }
      }
    });
  }),
  async plan(ctx, desired): Promise<BranchesPlan> {
    // Protection is keyed by exact branch name or pattern; two entries for
    // the same one would overwrite each other's write on every run.
    rejectDuplicates(
      this,
      desired,
      (b) => b.name,
      (b) => b.name,
    );
    const plan: BranchesPlan = { ops: [], notes: [], drift: [] };
    // The one rules read, fired only when an entry needs the GraphQL
    // surface: a pure-REST declaration issues no GraphQL request at all.
    // The SAME predicate that gates the fetch classifies the entries, so
    // every entry that needs the run state gets it attached right here.
    const needsGraphql = (branch: BranchConfig): boolean =>
      isWildcardPattern(branch.name) || hasRoutedGraphqlKeys(branch.protection);
    let entries: ClassifiedEntry[];
    const graphqlRun: GraphqlRun | null = desired.some(needsGraphql)
      ? { rules: await fetchRules(ctx), repoId: null, actorIds: new Map(), lateActors: [] }
      : null;
    if (graphqlRun !== null) {
      const declaredPatterns = new Set(desired.map((branch) => branch.name));
      for (const pattern of [...(graphqlRun.rules?.keys() ?? [])].sort()) {
        if (isWildcardPattern(pattern) && !declaredPatterns.has(pattern)) {
          plan.notes.push(
            `undeclared classic protection rule "${pattern}" exists on the repo - declare it to manage it (this action never deletes undeclared rules)`,
          );
        }
      }
      entries = desired.map((branch) =>
        isWildcardPattern(branch.name)
          ? { kind: "wildcard", branch, graphqlRun }
          : {
              kind: "literal",
              branch,
              routed: hasRoutedGraphqlKeys(branch.protection) ? { graphqlRun } : null,
            },
      );
    } else {
      // No entry satisfies the predicate, so every entry is a plain literal.
      entries = desired.map((branch) => ({ kind: "literal", branch, routed: null }));
    }
    for (const entry of entries) {
      if (entry.kind === "wildcard") {
        await planWildcardEntry(ctx, entry.graphqlRun, entry.branch, plan);
        continue;
      }
      await planLiteralEntry(ctx, this, entry.routed, entry.branch, plan);
    }
    // Every actor a planned mutation resolves at execution resolves ahead of
    // the plan's FIRST write, whichever entry it belongs to: a misspelled
    // actor fails while every branch's live protection is still untouched,
    // and the mutations' thunks then find the ids cached.
    const [lead, ...rest] = plan.ops;
    if (graphqlRun !== null && graphqlRun.lateActors.length > 0 && lead !== undefined) {
      plan.ops = [
        {
          ...lead,
          before: async (exec) => {
            await resolveActorIds(ctx, exec, graphqlRun, graphqlRun.lateActors);
          },
        },
        ...rest,
      ];
    }
    return plan;
  },
} satisfies SectionModule<"branches", typeof ENDPOINTS, typeof GRAPHQL>;

/**
 * Plan one literal-branch entry: the protection PUT, the signature
 * sub-endpoint, and the rule mutation, each justified by its drift. `routed`
 * is non-null exactly when the entry declares a GraphQL-routed key.
 */
async function planLiteralEntry(
  ctx: BranchesContext,
  section: SectionMeta,
  routed: { graphqlRun: GraphqlRun } | null,
  branch: BranchConfig,
  plan: BranchesPlan,
): Promise<void> {
  const params = { branch: branch.name };
  const prefix = `branches[${branch.name}].protection`;
  const probe = await ctx.read.getProtection.probeAbsent({ params });
  if (branch.protection === null) {
    if ("missing" in probe) {
      return;
    }
    plan.ops.push({
      role: "removeProtection",
      params,
      drift: [
        `branches[${branch.name}]: protected live but the settings file declares protection: null; apply will remove the protection`,
      ],
      change: `removed protection from "${branch.name}"`,
    });
    return;
  }
  // The routed keys never ride the REST payload: GitHub's protection PUT
  // silently DROPS required_signatures (its sub-endpoint applies it), and
  // force_push_bypassers/required_deployments have no REST field at all
  // (one rule mutation applies both).
  const {
    required_signatures: requiredSignatures,
    force_push_bypassers: forcePushBypassers,
    required_deployments: requiredDeployments,
    ...payload
  } = branch.protection;
  // The classic API rejects payloads missing the core keys; fill nulls.
  for (const key of REQUIRED_PROTECTION_KEYS) {
    if (!(key in payload)) {
      payload[key] = null;
    }
  }
  // The flattened live protection the declared keys diff against; null for
  // an unprotected branch, which has no requirement and no allowance.
  let live: Record<string, unknown> | null = null;
  // GitHub does not document whether the PUT preserves the sub-resource and
  // the GraphQL-only fields, so a planned PUT re-applies every declared one.
  let putPlanned = false;
  if ("missing" in probe) {
    // Protection 404s for a missing BRANCH too. Only a definitive 404 on the
    // advisory probe flips the finding; any other failure (no Contents
    // grant) keeps the plain unprotected reading.
    const branchProbe = await ctx.read.branchProbe.tryCall({ params });
    if ("error" in branchProbe && branchProbe.error.status === 404) {
      // Nothing to plan: no operation can create a branch. Check reports
      // the drift; apply surfaces it as a note.
      plan.drift.push(
        `branches[${branch.name}]: declared in the settings file but the branch does not exist on the repo, so apply cannot protect it; create the branch, or remove it from the settings file`,
      );
      return;
    }
    plan.ops.push({
      role: "putProtection",
      params,
      payload: plainData(payload),
      describe: `replacing protection for branch "${branch.name}"`,
      drift: [
        `branches[${branch.name}]: unprotected live but the settings file declares protection; apply will protect it`,
      ],
      change: `applied protection to "${branch.name}"`,
    });
    putPlanned = true;
  } else {
    // The parse pins the one field read BY NAME (required_signatures'
    // {enabled} wrapper); everything else flattens generically.
    live = flattenProtection(
      parseLive(
        section,
        ENDPOINTS.getProtection,
        LiveProtection,
        probe.data,
        `branch "${branch.name}"`,
      ),
    );
    // The protection GET OMITS required_signatures entirely when signed
    // commits are not required, so an absent live field means false;
    // normalize before the diff so declared false does not read as drift.
    if (!("required_signatures" in live)) {
      live.required_signatures = false;
    }
    const declaredRest: Record<string, unknown> = { ...payload };
    for (const key of REQUIRED_PROTECTION_KEYS) {
      if (!(key in branch.protection)) {
        delete declaredRest[key];
      }
    }
    // The PUT replaces the whole protection, so live settings the
    // declaration omits are REMOVED by it - drift, not silence. The signature
    // toggle is the one live field the PUT never touches (its own sub-resource).
    const { required_signatures: _liveSignatures, ...liveRest } = live;
    const restDrift = [
      ...subsetDiff(declaredRest, live, prefix),
      ...omittedLiveDrift(declaredRest, liveRest, prefix),
    ];
    const drift = justified(restDrift);
    if (drift !== null) {
      plan.ops.push({
        role: "putProtection",
        params,
        payload: plainData(payload),
        describe: `replacing protection for branch "${branch.name}"`,
        drift,
        change: `applied protection to "${branch.name}"`,
      });
      putPlanned = true;
    }
  }
  // The declared toggle applies through its sub-endpoint once the PUT has
  // ensured the protection (and with it the sub-resource) exists; an
  // undeclared toggle leaves the live requirement alone.
  if (requiredSignatures !== undefined) {
    const sigDrift = subsetDiff(
      { required_signatures: requiredSignatures },
      { required_signatures: live?.required_signatures ?? false },
      prefix,
    );
    if (sigDrift.length === 0 && putPlanned) {
      sigDrift.push(
        `${prefix}.required_signatures: re-applied after the protection PUT (GitHub does not document whether the PUT preserves it)`,
      );
    }
    const drift = justified(sigDrift);
    if (drift !== null) {
      plan.ops.push(
        requiredSignatures
          ? {
              role: "sigPost",
              params,
              describe: `requiring signed commits on branch "${branch.name}"`,
              drift,
              change: `required signed commits on "${branch.name}"`,
            }
          : {
              role: "sigDelete",
              params,
              describe: `removing the signed-commit requirement from branch "${branch.name}"`,
              drift,
              change: `removed the signed-commit requirement from "${branch.name}"`,
            },
      );
    }
  }
  if (routed !== null) {
    planRoutedUpdate(ctx, routed.graphqlRun, plan, {
      name: branch.name,
      protection: branch.protection,
      prefix,
      putPlanned,
    });
  }
}

/**
 * GET /protection wraps booleans as {url, enabled} and expands actor lists
 * (restrictions, dismissal_restrictions, bypass_pull_request_allowances)
 * into user/team/app OBJECTS, while the PUT shape uses login/slug strings.
 * Unwrap both so check mode compares like with like. Exported so the e2e
 * state tests assert their protectionFromPut transformer inverts this exact
 * function (not a lookalike copy).
 */
export function flattenProtection(live: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(live)) {
    if (GET_ONLY_KEYS.has(key) || isUrlKey(key)) {
      continue;
    }
    out[key] = flattenValue(value);
  }
  const checks = out.required_status_checks;
  if (typeof checks === "object" && checks !== null && !Array.isArray(checks)) {
    delete (checks as Record<string, unknown>).enforcement_level;
  }
  return out;
}

/**
 * GET-only metadata the PUT vocabulary has no word for (url keys drop
 * generically; `required_status_checks.enforcement_level` drops above).
 */
const GET_ONLY_KEYS: ReadonlySet<string> = new Set(["name", "enabled"]);

const isUrlKey = (key: string): boolean => key === "url" || key.endsWith("_url");

const ACTOR_NAME_KEYS = ["login", "slug"] as const;
const ACTOR_LIST_KEYS = new Set(["users", "teams", "apps"]);

function flattenValue(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(flattenValue);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    "enabled" in record &&
    typeof record.enabled === "boolean" &&
    keys.every((k) => k === "enabled" || k === "url" || k.endsWith("_url"))
  ) {
    return record.enabled;
  }
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(record)) {
    if (ACTOR_LIST_KEYS.has(key) && Array.isArray(inner)) {
      out[key] = inner.map((actor) => {
        if (typeof actor === "object" && actor !== null) {
          for (const nameKey of ACTOR_NAME_KEYS) {
            const name = (actor as Record<string, unknown>)[nameKey];
            if (typeof name === "string") {
              return name;
            }
          }
        }
        return actor;
      });
    } else if (isUrlKey(key)) {
      // URLs never appear in the PUT shape; drop to avoid noise.
    } else {
      out[key] = flattenValue(inner);
    }
  }
  return out;
}
