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

import { roleForPermission } from "../../../src/sections/roles.js";
import orgFixture from "../fixtures/org.json" with { type: "json" };
import repoFixture from "../fixtures/repo.json" with { type: "json" };
import type { OwnerKind } from "../schema.js";

/** A plain JSON object body, the currency of every fixture and overlay. */
type Json = Record<string, unknown>;

/**
 * The `labels.generate` sugar: instead of listing N label bodies, a scenario
 * declares a count and the mock synthesizes "<prefix>-1".."<prefix>-N", all in
 * the same color. Mirrors LabelsGenerateSchema in ../schema.ts.
 */
export interface LabelsGenerate {
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
   * Either an explicit list of label bodies (replaces the baseline) or the
   * generate sugar. A scenario picks exactly one form.
   */
  labels?: Json[] | { generate: LabelsGenerate };
  /** Repository rulesets (summary + full bodies), replaces the baseline. */
  rulesets?: Json[];
  /** Branch protection keyed by branch name; null means "unprotected". */
  branch_protection?: Record<string, Json | null>;
  /** Branch names that exist on the repo (drives the advisory branch probe). */
  branches?: string[];
  /** Deployment environments keyed by name (GET shape). */
  environments?: Record<string, Json>;
  /** Autolinks, replaces the baseline. */
  autolinks?: Json[];
  /** GET /actions/permissions body. */
  actions_permissions?: Json;
  /** GET /actions/permissions/selected-actions body. */
  selected_actions?: Json;
  /** GET /actions/permissions/workflow body. */
  workflow_permissions?: Json;
  /** GET /actions/permissions/access body. */
  actions_access?: Json;
  /** Workflows list items ({id, name, path, state}), replaces the baseline. */
  workflows?: Json[];
  /** GET /pages body, or null for "Pages not enabled". */
  pages?: Json | null;
  /** GET /code-scanning/default-setup body. */
  code_scanning?: Json;
  /** Direct collaborators (GET shape with role_name), replaces the baseline. */
  collaborators?: Json[];
  /** Team access keyed by team slug; null means "no access". */
  teams?: Record<string, { role_name: string } | null>;
  /** Milestones (GET shape), replaces the baseline. */
  milestones?: Json[];
}

/**
 * The materialized working state the mock server mutates in place: every
 * family resolved to a concrete value (fixture baseline with the LiveState
 * overlay applied), plus a monotonic id source for created resources and the
 * owner kind (which flips the org endpoint to 404 for a personal account).
 */
export interface MockState {
  ownerKind: OwnerKind;
  /** The org body, or null when the owner is a personal account. */
  org: Json | null;
  repo: Json;
  labels: Json[];
  rulesets: Json[];
  branch_protection: Record<string, Json | null>;
  branches: string[];
  environments: Record<string, Json>;
  autolinks: Json[];
  actions_permissions: Json;
  selected_actions: Json;
  workflow_permissions: Json;
  actions_access: Json;
  workflows: Json[];
  pages: Json | null;
  code_scanning: Json;
  collaborators: Json[];
  teams: Record<string, { role_name: string } | null>;
  milestones: Json[];
  /** Next id handed to a created resource (label, ruleset, autolink, ...). */
  nextId: number;
}

/** True for a plain (non-array, non-null) object we can deep-merge into. */
function isPlainObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

/** Expand the labels.generate sugar into concrete GET-shape label bodies. */
function generateLabels(gen: LabelsGenerate, startId: number): Json[] {
  const out: Json[] = [];
  for (let i = 0; i < gen.count; i++) {
    const name = `${gen.prefix}-${i + 1}`;
    out.push({
      id: startId + i,
      node_id: `MDU6TGFiZWw${startId + i}`,
      url: `https://api.github.com/repos/e2e-owner/e2e-repo/labels/${name}`,
      name,
      color: gen.color,
      default: false,
      description: null,
    });
  }
  return out;
}

/**
 * Materialize a MockState from a scenario's (possibly undefined) LiveState.
 * List families default to empty; the repo defaults to the fixture (deep-merged
 * with any overlay); the single-object families default to their fixtures.
 * `ownerKind: "user"` marks the org absent so the teams section no-ops.
 */
export function buildState(liveState: LiveState | undefined, ownerKind: OwnerKind): MockState {
  const ls = liveState ?? {};
  let nextId = 90_000_000;
  const takeId = (): number => nextId++;

  let labels: Json[];
  if (ls.labels === undefined) {
    labels = [];
  } else if (Array.isArray(ls.labels)) {
    labels = clone(ls.labels);
  } else {
    labels = generateLabels(ls.labels.generate, takeId());
    nextId += ls.labels.generate.count;
  }

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

  return {
    ownerKind,
    org: ownerKind === "user" ? null : clone(orgFixture as Json),
    repo,
    labels,
    rulesets: ls.rulesets ? clone(ls.rulesets) : [],
    branch_protection: ls.branch_protection ? clone(ls.branch_protection) : {},
    branches: ls.branches ? clone(ls.branches) : [],
    environments: ls.environments ? clone(ls.environments) : {},
    autolinks: ls.autolinks ? clone(ls.autolinks) : [],
    actions_permissions: ls.actions_permissions ? clone(ls.actions_permissions) : {},
    selected_actions: ls.selected_actions ? clone(ls.selected_actions) : {},
    workflow_permissions: ls.workflow_permissions ? clone(ls.workflow_permissions) : {},
    actions_access: ls.actions_access ? clone(ls.actions_access) : {},
    workflows: ls.workflows ? clone(ls.workflows) : [],
    pages: ls.pages !== undefined ? clone(ls.pages) : null,
    code_scanning: ls.code_scanning ? clone(ls.code_scanning) : {},
    collaborators: ls.collaborators ? clone(ls.collaborators) : [],
    teams: ls.teams ? clone(ls.teams) : {},
    milestones: ls.milestones ? clone(ls.milestones) : [],
    nextId,
  };
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
  permissions?: Record<string, string>;
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
  permissions: Map<string, Record<string, string>>;
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
 * Rewrite a MockState's repo object so its identity fields name `slug` instead
 * of the fixture's e2e-owner/e2e-repo. The disambiguation probe and every
 * section read then see a coherent repo for this target.
 */
function reslugRepo(repo: Json, slug: string): void {
  const [owner, name] = slug.split("/");
  repo.full_name = slug;
  repo.name = name ?? slug;
  const ownerObj = repo.owner;
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
  const state = buildState(spec.liveState, ownerKind);
  reslugRepo(state.repo, slug);
  return state;
}

/**
 * A discovery-pool repo body: the fixture repo re-slugged, with the four
 * filterable attributes overlaid so the action's discovery filters can act on
 * them. Only the fields discovery reads need be realistic.
 */
function discoveryRepoBody(spec: DiscoveryRepoSpec): Json {
  const body = clone(repoFixture as Json);
  reslugRepo(body, spec.slug);
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
  // Discovered slugs with no explicit spec: default state, no settings file.
  for (const pool of discoveryPool ?? []) {
    if (!state.repos.has(pool.slug)) {
      ensure(pool.slug, { settingsYaml: null });
    }
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
 * declared-keys-only diff sees no phantom fields.
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
      case "enforce_admins":
      case "required_linear_history":
      case "allow_force_pushes":
      case "allow_deletions":
      case "block_creations":
      case "required_conversation_resolution":
      case "lock_branch":
      case "allow_fork_syncing":
      case "required_signatures":
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
 * Turn a collaborator PUT body into the GET-shape collaborator object the list
 * endpoint returns: the declared `permission` (pull/push/...) becomes
 * `role_name` via the shared `roleForPermission`, so a check run compares like
 * with like.
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
 * Turn a team-repo PUT body into the repository-media-type GET shape the teams
 * probe reads: only `role_name` matters to the section, mapped from the
 * declared `permission` via `roleForPermission`.
 */
export function teamRepoFromPut(payload: Json): { role_name: string } {
  const permission = String(payload.permission ?? "push");
  return { role_name: roleForPermission(permission) };
}
