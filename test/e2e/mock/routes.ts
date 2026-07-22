/**
 * The mock GitHub server's route table, request pipeline, and per-endpoint
 * handlers. Everything here is pure logic over a MockState and a Scenario; the
 * transport shell (Bun.serve, per-scenario lifecycle) lives in server.ts.
 *
 * The route TABLE is not hand-written: it is derived from allEndpoints(), the
 * frozen dictionary the sections themselves declare. What IS hand-written is
 * one stateful handler per "section.role" key, plus the CORE_PATHS handlers
 * for the non-section calls. A startup assertion pins the two sets equal in
 * both directions, so adding a section endpoint without a matching mock
 * handler (or leaving a stale handler behind) fails loudly at construction.
 */

import type { SectionKey } from "../../../src/schema.js";
import {
  endpointKind,
  endpointMethod,
  endpointPath,
  endpointPermission,
  matchesTemplate,
  type SectionPermission,
  toleratedStatuses,
} from "../../../src/sections/contract.js";
import { allEndpoints, SECTIONS, type TaggedEndpoint } from "../../../src/sections/registry.js";
import { DENIAL_SEMANTICS } from "../denial-semantics.js";
import type { DenialStyle, MaskGrade, MaskKey, Scenario } from "../schema.js";
import {
  collaboratorFromPut,
  environmentFromPut,
  type MockState,
  type MultiMockState,
  protectionFromPut,
  teamRepoFromPut,
} from "./state.js";

/** A plain JSON object body. */
type Json = Record<string, unknown>;

/**
 * One logged request, the audit trail the runner asserts against. `pathname`
 * is the path only (no query string, GHES base prefix already stripped) and
 * `query` is the raw query string ("" when none), kept as separate fields: the
 * runner prefix-matches mutations/never against "METHOD pathname" and
 * substring-matches requests_contain (e.g. "page=2") against a rejoined
 * "METHOD pathname?query", so both rules hold without the mock guessing which
 * a scenario wants.
 */
export interface LoggedRequest {
  method: string;
  pathname: string;
  query: string;
  status: number;
  /** The masked resource that denied this request, when a denial fired. */
  deniedBy?: string;
  /** Parsed JSON body for writes. */
  body?: unknown;
}

/** The reply a handler (or the pipeline) produces: a status and a JSON body. */
export interface MockResponse {
  status: number;
  body: unknown;
}

/**
 * Everything a handler needs to serve one request: the mutable state, the
 * matched endpoint, the concrete path (so id/name params can be parsed out),
 * the parsed query, and the request body. `corrupt` carries the one-shot chaos
 * directive for this endpoint when the scenario armed one.
 */
export interface HandlerContext {
  state: MockState;
  endpoint: TaggedEndpoint;
  pathname: string;
  query: Record<string, string>;
  body: unknown;
}

type Handler = (ctx: HandlerContext) => MockResponse;

/** Look up a section module by key (for endpointPermission resolution). */
const SECTION_BY_KEY = new Map<SectionKey, (typeof SECTIONS)[number]>(
  SECTIONS.map((section) => [section.key, section]),
);

/**
 * The effective permission requirement of an endpoint: its resolved
 * SectionPermission (or "none") paired with whether it reads or writes. The
 * gate composes both to grade the token mask.
 */
interface Requirement {
  permission: SectionPermission | "none";
  kind: "read" | "write";
}

function endpointRequirement(endpoint: TaggedEndpoint): Requirement {
  const section = SECTION_BY_KEY.get(endpoint.section);
  if (!section) {
    throw new Error(`BUG: no section module registered for key "${endpoint.section}"`);
  }
  return { permission: endpointPermission(section, endpoint), kind: endpointKind(endpoint) };
}

// --- Permission mask grading ---------------------------------------------

const GRADE_RANK: Record<MaskGrade, number> = { none: 0, read: 1, write: 2 };

/**
 * A token permission mask: resource -> grade. Unlisted resources default to
 * write. In single-repo mode this is the scenario's token_permissions; in
 * multi-repo mode it is the target slug's per-repo mask (so a denial can be
 * scoped to one repository).
 */
export type PermissionMask = Partial<Record<MaskKey, MaskGrade>>;

/** The grade the token holds for a mask resource; unlisted resources are write. */
function maskGrade(mask: PermissionMask, resource: MaskKey): MaskGrade {
  return mask[resource] ?? "write";
}

function grantsAtLeast(mask: PermissionMask, resource: MaskKey, needed: "read" | "write"): boolean {
  return GRADE_RANK[maskGrade(mask, resource)] >= GRADE_RANK[needed];
}

/**
 * The outcome of grading a requirement against the token mask: either allowed,
 * or denied and naming the resource that failed (logged as deniedBy). A "repo"
 * permission is satisfied by ANY listed resource meeting the grade; "org:
 * members" additionally requires org_members read. When repo access fails, the
 * denying resource is the FIRST listed repo resource (deterministic).
 */
type Grading = { allowed: true } | { allowed: false; deniedBy: MaskKey };

function gradeRequirement(mask: PermissionMask, req: Requirement): Grading {
  if (req.permission === "none") {
    return { allowed: true };
  }
  const permission = req.permission;
  const repoOk = permission.repo.some((resource) => grantsAtLeast(mask, resource, req.kind));
  if (!repoOk) {
    return { allowed: false, deniedBy: permission.repo[0] };
  }
  if (permission.org === "members" && !grantsAtLeast(mask, "org_members", "read")) {
    return { allowed: false, deniedBy: "org_members" };
  }
  return { allowed: true };
}

/**
 * Grade a bare resource+level against a mask (for non-section paths like the
 * contents fetch, which has no SectionPermission). Returns the resource as
 * deniedBy on failure, matching the section-gate's shape.
 */
function gradeResource(mask: PermissionMask, resource: MaskKey, level: "read" | "write"): Grading {
  return grantsAtLeast(mask, resource, level)
    ? { allowed: true }
    : { allowed: false, deniedBy: resource };
}

/**
 * The effective permission mask for a request: the global scenario mask
 * overlaid by the per-slug mask, per resource (per-slug wins). In single-repo
 * mode `perSlug` is undefined and the global mask stands alone; in multi-repo
 * mode a repo that names only `issues` still inherits the global grades for
 * every other resource, so the global mask is never a silent no-op.
 */
function effectiveMask(
  global: PermissionMask,
  perSlug: Record<string, string> | undefined,
): PermissionMask {
  if (!perSlug) {
    return global;
  }
  return { ...global, ...(perSlug as PermissionMask) };
}

// --- Denial responses -----------------------------------------------------

/**
 * The status and body a denied request answers with, by denial style and
 * read/write kind. fine_grained mirrors real fine-grained tokens (denied read
 * -> 404 Not Found, denied write -> 403 not accessible); the numeric styles
 * answer every denial uniformly. No message ever contains "rate limit", which
 * would be mistaken for throttling by the client's classifier.
 */
function denialResponse(style: DenialStyle, kind: "read" | "write"): MockResponse {
  if (style === 403) {
    return { status: 403, body: { message: "Resource not accessible by personal access token" } };
  }
  if (style === 404) {
    return { status: 404, body: { message: "Not Found" } };
  }
  return kind === "read"
    ? { status: 404, body: { message: "Not Found" } }
    : { status: 403, body: { message: "Resource not accessible by personal access token" } };
}

// --- Pagination -----------------------------------------------------------

/**
 * Slice a full list the way src/github/paginate.ts asks for it: it always
 * sends per_page=100&page=N and stops when a chunk is shorter than per_page.
 * Mirroring that exactly here (default per_page 100, 1-based page) is what
 * makes the mock's paging indistinguishable from GitHub's to the client. A
 * page past the end yields an empty slice, which ends the client's loop.
 */
export function slicePage<T>(items: readonly T[], query: Record<string, string>): T[] {
  const perPage = clampInt(query.per_page, 100);
  const page = clampInt(query.page, 1);
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}

function clampInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

// --- Handler helpers ------------------------------------------------------

/** The last path segment, URL-decoded (parses {name}/{id}/{username} params). */
function lastSegment(pathname: string): string {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  return decodeURIComponent(segments[segments.length - 1] ?? "");
}

/**
 * The path segment at a given index from the end, URL-decoded. index 0 is the
 * last segment; higher indices walk toward the front. Used where the id/name
 * is not the final segment (e.g. .../workflows/{id}/enable).
 */
function segmentFromEnd(pathname: string, index: number): string {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  return decodeURIComponent(segments[segments.length - 1 - index] ?? "");
}

function asObject(body: unknown): Json {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Json) : {};
}

/** A 200 JSON reply. */
function ok(body: unknown): MockResponse {
  return { status: 200, body };
}

/** A 204 empty reply (the client normalizes an empty body to null). */
function noContent(): MockResponse {
  return { status: 204, body: null };
}

// --- Per-endpoint handlers ------------------------------------------------
//
// One entry per "section.role" key in allEndpoints(). Reads serve
// fixture-backed MockState; writes mutate it via the state.ts transformers and
// reply with a body/status drawn ONLY from the endpoint's declared statuses
// (a startup check proves every status a handler can return is declared).

const HANDLERS: Record<string, Handler> = {
  // repository -------------------------------------------------------------
  "repository.get": ({ state }) => ok(state.repo),
  "repository.update": ({ state, body }) => {
    Object.assign(state.repo, asObject(body));
    return ok(state.repo);
  },
  "repository.topics": ({ state, body }) => {
    const names = asObject(body).names;
    state.repo.topics = Array.isArray(names) ? names : [];
    return ok({ names: state.repo.topics });
  },
  "repository.vulnerabilityAlertsGet": ({ state }) =>
    booleanToggleGet(state.repo.vulnerability_alerts_enabled === true),
  "repository.vulnerabilityAlertsPut": ({ state }) => {
    state.repo.vulnerability_alerts_enabled = true;
    return noContent();
  },
  "repository.vulnerabilityAlertsRemove": ({ state }) => {
    state.repo.vulnerability_alerts_enabled = false;
    return noContent();
  },
  "repository.automatedSecurityFixesGet": ({ state }) => {
    if (state.repo.automated_security_fixes_enabled === undefined) {
      return { status: 404, body: { message: "Not Found" } };
    }
    return ok({ enabled: state.repo.automated_security_fixes_enabled === true, paused: false });
  },
  "repository.automatedSecurityFixesPut": ({ state }) => {
    state.repo.automated_security_fixes_enabled = true;
    return noContent();
  },
  "repository.automatedSecurityFixesRemove": ({ state }) => {
    state.repo.automated_security_fixes_enabled = false;
    return noContent();
  },
  "repository.privateVulnerabilityReportingGet": ({ state }) =>
    ok({ enabled: state.repo.private_vulnerability_reporting_enabled === true }),
  "repository.privateVulnerabilityReportingPut": ({ state }) => {
    state.repo.private_vulnerability_reporting_enabled = true;
    return noContent();
  },
  "repository.privateVulnerabilityReportingRemove": ({ state }) => {
    state.repo.private_vulnerability_reporting_enabled = false;
    return noContent();
  },

  // labels -----------------------------------------------------------------
  "labels.list": ({ state, query }) => ok(slicePage(state.labels, query)),
  "labels.create": ({ state, body }) => {
    const payload = asObject(body);
    const label: Json = {
      id: state.nextId++,
      node_id: `MDU6TGFiZWw${state.nextId}`,
      url: `https://api.github.com/repos/e2e-owner/e2e-repo/labels/${String(payload.name)}`,
      name: payload.name,
      color: payload.color ?? "ededed",
      default: false,
      description: payload.description ?? null,
    };
    state.labels.push(label);
    return { status: 201, body: label };
  },
  "labels.update": ({ state, pathname, body }) => {
    const name = lastSegment(pathname);
    const label = findLabel(state, name);
    if (!label) {
      return { status: 404, body: { message: "Not Found" } };
    }
    const payload = asObject(body);
    if (typeof payload.new_name === "string") {
      label.name = payload.new_name;
    }
    if (payload.color !== undefined) {
      label.color = payload.color;
    }
    if (payload.description !== undefined) {
      label.description = payload.description;
    }
    return ok(label);
  },
  "labels.remove": ({ state, pathname }) => {
    const name = lastSegment(pathname);
    const index = state.labels.findIndex((l) => labelName(l) === name.toLowerCase());
    if (index < 0) {
      return { status: 404, body: { message: "Not Found" } };
    }
    state.labels.splice(index, 1);
    return noContent();
  },

  // rulesets ---------------------------------------------------------------
  "rulesets.list": ({ state, query }) => ok(slicePage(state.rulesets, query)),
  "rulesets.create": ({ state, body }) => {
    const ruleset: Json = { id: state.nextId++, source_type: "Repository", ...asObject(body) };
    state.rulesets.push(ruleset);
    return { status: 201, body: ruleset };
  },
  "rulesets.get": ({ state, pathname }) => {
    const id = lastSegment(pathname);
    const ruleset = state.rulesets.find((r) => String(r.id) === id);
    if (!ruleset) {
      return { status: 404, body: { message: "Not Found" } };
    }
    return ok(ruleset);
  },
  "rulesets.update": ({ state, pathname, body }) => {
    const id = lastSegment(pathname);
    const index = state.rulesets.findIndex((r) => String(r.id) === id);
    if (index < 0) {
      return { status: 404, body: { message: "Not Found" } };
    }
    const updated: Json = { id: Number(id), source_type: "Repository", ...asObject(body) };
    state.rulesets[index] = updated;
    return ok(updated);
  },

  // branches ---------------------------------------------------------------
  "branches.getProtection": ({ state, pathname }) => {
    const branch = segmentFromEnd(pathname, 1); // .../branches/{branch}/protection
    const protection = state.branch_protection[branch];
    if (!protection) {
      return { status: 404, body: { message: "Branch not protected" } };
    }
    return ok(protection);
  },
  "branches.putProtection": ({ state, pathname, body }) => {
    const branch = segmentFromEnd(pathname, 1);
    const stored = protectionFromPut(asObject(body));
    state.branch_protection[branch] = stored;
    return ok(stored);
  },
  "branches.removeProtection": ({ state, pathname }) => {
    const branch = segmentFromEnd(pathname, 1);
    state.branch_protection[branch] = null;
    return noContent();
  },
  "branches.branchProbe": ({ state, pathname }) => {
    const branch = lastSegment(pathname);
    if (!state.branches.includes(branch)) {
      return { status: 404, body: { message: "Branch not found" } };
    }
    return ok({ name: branch });
  },

  // environments -----------------------------------------------------------
  "environments.probe": ({ state, pathname }) => {
    const name = lastSegment(pathname);
    const environment = state.environments[name];
    if (!environment) {
      return { status: 404, body: { message: "Not Found" } };
    }
    return ok(environment);
  },
  "environments.update": ({ state, pathname, body }) => {
    const name = lastSegment(pathname);
    const created = state.environments[name] === undefined;
    state.environments[name] = { name, ...environmentFromPut(asObject(body)) };
    return { status: created ? 201 : 200, body: state.environments[name] };
  },

  // autolinks --------------------------------------------------------------
  "autolinks.list": ({ state }) => ok(state.autolinks), // section GETs unpaginated
  "autolinks.create": ({ state, body }) => {
    const payload = asObject(body);
    const autolink: Json = {
      id: state.nextId++,
      is_alphanumeric: true,
      ...payload,
    };
    state.autolinks.push(autolink);
    return { status: 201, body: autolink };
  },
  "autolinks.remove": ({ state, pathname }) => {
    const id = lastSegment(pathname);
    const index = state.autolinks.findIndex((a) => String(a.id) === id);
    if (index < 0) {
      return { status: 404, body: { message: "Not Found" } };
    }
    state.autolinks.splice(index, 1);
    return noContent();
  },

  // actions ----------------------------------------------------------------
  "actions.getPermissions": ({ state }) => ok(state.actions_permissions),
  "actions.putPermissions": ({ state, body }) => {
    state.actions_permissions = asObject(body);
    return noContent();
  },
  "actions.getSelected": ({ state }) => {
    // The selected-actions allowlist only applies under an allowed_actions
    // policy of "selected"; otherwise the endpoint answers 409 (its declared
    // "policy is not selected" status), never a 200 with a stale body.
    if (state.actions_permissions.allowed_actions !== "selected") {
      return { status: 409, body: { message: "The allowed_actions policy is not 'selected'" } };
    }
    return ok(state.selected_actions);
  },
  "actions.putSelected": ({ state, body }) => {
    state.selected_actions = asObject(body);
    return noContent();
  },
  "actions.getWorkflow": ({ state }) => ok(state.workflow_permissions),
  "actions.putWorkflow": ({ state, body }) => {
    state.workflow_permissions = asObject(body);
    return noContent();
  },
  "actions.getAccess": ({ state }) => ok(state.actions_access),
  "actions.putAccess": ({ state, body }) => {
    state.actions_access = asObject(body);
    return noContent();
  },

  // workflows --------------------------------------------------------------
  "workflows.list": ({ state, query }) => {
    const page = slicePage(state.workflows, query);
    return ok({ total_count: state.workflows.length, workflows: page });
  },
  "workflows.enable": ({ state, pathname }) => {
    const id = segmentFromEnd(pathname, 1); // .../workflows/{id}/enable
    const workflow = state.workflows.find((w) => String(w.id) === id);
    if (!workflow) {
      return { status: 404, body: { message: "Not Found" } };
    }
    workflow.state = "active";
    return noContent();
  },
  "workflows.disable": ({ state, pathname }) => {
    const id = segmentFromEnd(pathname, 1);
    const workflow = state.workflows.find((w) => String(w.id) === id);
    if (!workflow) {
      return { status: 404, body: { message: "Not Found" } };
    }
    workflow.state = "disabled_manually";
    return noContent();
  },

  // pages ------------------------------------------------------------------
  "pages.get": ({ state }) => {
    if (state.pages === null) {
      return { status: 404, body: { message: "Not Found" } };
    }
    return ok(state.pages);
  },
  "pages.create": ({ state, body }) => {
    if (state.pages !== null) {
      // POST creates; an existing site is a conflict. 409 is not declared for
      // this endpoint (create only declares 201), so a real conflict here
      // would be a scenario setup error; surface it loudly as a 422 the client
      // will classify as a hard failure rather than fake a 201.
      return { status: 422, body: { message: "Pages is already enabled" } };
    }
    state.pages = { url: pagesUrl(), ...asObject(body) };
    return { status: 201, body: state.pages };
  },
  "pages.update": ({ state, body }) => {
    state.pages = { url: pagesUrl(), ...asObject(state.pages), ...asObject(body) };
    return noContent();
  },
  "pages.remove": ({ state }) => {
    state.pages = null;
    return noContent();
  },

  // code_scanning_default_setup -------------------------------------------
  "code_scanning_default_setup.get": ({ state }) => ok(state.code_scanning),
  "code_scanning_default_setup.update": ({ state, body }) => {
    // The PATCH answers 200 (synchronous) or 202 (async run started). Rule,
    // deterministic: when the payload changes `languages`, GitHub kicks off an
    // async configuration run and answers 202 with a run_id; otherwise it
    // applies synchronously and answers 200. This mirrors the real endpoint's
    // behavior (language changes trigger a rebuild) without nondeterminism.
    const payload = asObject(body);
    const changesLanguages =
      "languages" in payload &&
      JSON.stringify(payload.languages) !== JSON.stringify(state.code_scanning.languages);
    Object.assign(state.code_scanning, payload);
    if (changesLanguages) {
      return {
        status: 202,
        body: {
          run_id: state.nextId++,
          run_url:
            "https://api.github.com/repos/e2e-owner/e2e-repo/code-scanning/default-setup/runs/1",
        },
      };
    }
    return ok({ ...state.code_scanning });
  },

  // collaborators ----------------------------------------------------------
  "collaborators.list": ({ state, query }) => ok(slicePage(state.collaborators, query)),
  "collaborators.update": ({ state, pathname, body }) => {
    const username = lastSegment(pathname);
    const stored = collaboratorFromPut(username, asObject(body));
    const existing = state.collaborators.find(
      (c) => String(c.login).toLowerCase() === username.toLowerCase(),
    );
    if (existing) {
      Object.assign(existing, stored);
      return noContent(); // 204: already a collaborator, access updated
    }
    state.collaborators.push(stored);
    return { status: 201, body: { id: state.nextId++, permissions: stored } }; // invitation created
  },
  "collaborators.remove": ({ state, pathname }) => {
    const username = lastSegment(pathname);
    const index = state.collaborators.findIndex(
      (c) => String(c.login).toLowerCase() === username.toLowerCase(),
    );
    if (index >= 0) {
      state.collaborators.splice(index, 1);
    }
    return noContent();
  },

  // teams ------------------------------------------------------------------
  "teams.org": ({ state, pathname }) => {
    if (state.org === null) {
      return { status: 404, body: { message: "Not Found" } };
    }
    void pathname;
    return ok(state.org);
  },
  "teams.probe": ({ state, pathname }) => {
    const slug = segmentFromEnd(pathname, 3); // .../teams/{slug}/repos/{owner}/{repo}
    const access = state.teams[slug];
    if (!access) {
      return { status: 404, body: { message: "Not Found" } };
    }
    // The repository media type makes this return the repo object with the
    // team's role_name folded in.
    return ok({ ...state.repo, role_name: access.role_name });
  },
  "teams.grant": ({ state, pathname, body }) => {
    const slug = segmentFromEnd(pathname, 3);
    state.teams[slug] = teamRepoFromPut(asObject(body));
    return noContent();
  },

  // milestones -------------------------------------------------------------
  "milestones.list": ({ state, query }) => ok(slicePage(state.milestones, query)),
  "milestones.create": ({ state, body }) => {
    const payload = asObject(body);
    const number = nextMilestoneNumber(state);
    const milestone: Json = {
      id: state.nextId++,
      number,
      state: "open",
      description: null,
      ...payload,
    };
    state.milestones.push(milestone);
    return { status: 201, body: milestone };
  },
  "milestones.update": ({ state, pathname, body }) => {
    const number = lastSegment(pathname);
    const milestone = state.milestones.find((m) => String(m.number) === number);
    if (!milestone) {
      return { status: 404, body: { message: "Not Found" } };
    }
    Object.assign(milestone, asObject(body));
    return ok(milestone);
  },
};

// --- Handler-local helpers ------------------------------------------------

function pagesUrl(): string {
  return "https://api.github.com/repos/e2e-owner/e2e-repo/pages";
}

/** A GET on a 204/404 boolean toggle: 204 when enabled, 404 when not. */
function booleanToggleGet(enabled: boolean): MockResponse {
  return enabled ? noContent() : { status: 404, body: { message: "Not Found" } };
}

function labelName(label: Json): string {
  return String(label.name).toLowerCase();
}

function findLabel(state: MockState, name: string): Json | undefined {
  return state.labels.find((l) => labelName(l) === name.toLowerCase());
}

function nextMilestoneNumber(state: MockState): number {
  let max = 0;
  for (const milestone of state.milestones) {
    max = Math.max(max, Number(milestone.number) || 0);
  }
  return max + 1;
}

// --- Startup assertions ---------------------------------------------------

/**
 * Every allEndpoints() key MUST have a handler and every handler key MUST
 * exist in allEndpoints(), both directions. Adding a section endpoint without
 * a mock handler (or leaving a stale handler after a route is removed) fails
 * here, at server construction, instead of hiding until a scenario happens to
 * exercise that route. Exported so a unit test can assert on it directly.
 */
export function assertHandlerCompleteness(
  endpoints: Readonly<Record<string, TaggedEndpoint>> = allEndpoints(),
  handlers: Record<string, Handler> = HANDLERS,
): void {
  const endpointKeys = new Set(Object.keys(endpoints));
  const handlerKeys = new Set(Object.keys(handlers));
  const missing = [...endpointKeys].filter((key) => !handlerKeys.has(key));
  const extra = [...handlerKeys].filter((key) => !endpointKeys.has(key));
  if (missing.length > 0 || extra.length > 0) {
    const lines: string[] = [];
    if (missing.length > 0) {
      lines.push(`endpoints with no mock handler in routes.ts: [${missing.sort().join(", ")}]`);
    }
    if (extra.length > 0) {
      lines.push(`handlers naming no known endpoint: [${extra.sort().join(", ")}]`);
    }
    throw new Error(
      `E2E MOCK: handler table out of sync with allEndpoints()\n  ${lines.join("\n  ")}`,
    );
  }
}

/**
 * The status-realism rule a handler must obey, and the reason it is not simply
 * "declared statuses only": a handler may answer any status the endpoint
 * DECLARES, plus any UNdeclared error status (>= 400). GitHub itself returns
 * error statuses an endpoint's happy-path docs never enumerate (a 404 for a
 * missing label on update/remove, a 409 for a conflicting create), and every
 * such error classifies through the engine's generic throwFor path, so the
 * mock modeling them is realism, not a contract break. What a handler must
 * NEVER invent is an undeclared SUCCESS/redirect (2xx/3xx): those drive the
 * section's success branches, so an undeclared one would exercise a code path
 * the endpoint declaration says cannot happen. Declaring the error status
 * instead is deliberately avoided - a declared >= 400 status feeds
 * toleratedStatuses(), so declaring e.g. 404 on labels.update would silently
 * make that error tolerated if the call site ever moved to tryCall.
 */
export function statusAllowed(key: string, status: number): boolean {
  return declaredStatuses(key).has(status) || status >= 400;
}

/** The declared status set for an endpoint (drives statusAllowed and tests). */
export function declaredStatuses(key: string): Set<number> {
  const endpoint = allEndpoints()[key];
  if (!endpoint) {
    throw new Error(`BUG: no endpoint "${key}"`);
  }
  return new Set(Object.keys(endpoint.statuses).map(Number));
}

// --- The request pipeline -------------------------------------------------

/** A one-shot corruption directive for a named endpoint's first response. */
export interface CorruptOption {
  key: string;
  mode: "invalid_json" | "wrong_shape" | "missing_envelope";
}

/** Options the server passes into the pipeline for each request. */
export interface PipelineOptions {
  scenario: Scenario;
  /** Single-repo working state; absent in multi-repo mode (see `multi`). */
  state?: MockState;
  /**
   * Multi-repo working state (per-slug repos + discovery pool). When set, the
   * pipeline resolves the target slug from the request path, dispatches into
   * that slug's MockState, and grades against that slug's permission mask; the
   * `/user/repos` and `/repos/{slug}/contents/{path}` endpoints are served from
   * here. Absent in single-repo mode.
   */
  multi?: MultiMockState;
  basePrefix?: string;
  corrupt?: CorruptOption;
  /** Endpoint keys already corrupted (chaos fires once); mutated in place. */
  corruptedKeys: Set<string>;
  /**
   * Sections whose READ was permission-denied earlier in this run; mutated in
   * place. The engine aborts a section at its first denied read, so a write
   * arriving for one of these sections afterwards proves broken sequencing
   * regardless of policy or denial style (see the denial barrier).
   */
  deniedReadSections: Set<string>;
  /**
   * Whether the write barrier is armed for THIS request. The server passes the
   * scenario's declared mode ORed with its one-way enterCheckMode() override,
   * so the convergence re-run (same server, check-mode child) arms the barrier
   * even though the scenario the server was built with is still apply-mode.
   */
  checkMode: boolean;
}

/** The pipeline's decision for one request: a response, a log entry, a note. */
export interface PipelineResult {
  response: MockResponse;
  log: LoggedRequest;
  /** A violation message, when the request broke the wire/route contract. */
  violation?: string;
  /** When set, the response body must be sent RAW (chaos invalid_json). */
  raw?: string;
}

const VIOLATION_PREFIX = "E2E MOCK VIOLATION:";

function violationResponse(message: string): MockResponse {
  return { status: 400, body: { message: `${VIOLATION_PREFIX} ${message}` } };
}

/**
 * Find the endpoint whose method and path template match this request. Returns
 * the "section.role" key and the tagged endpoint, or null when nothing matches.
 */
function matchEndpoint(
  method: string,
  pathname: string,
): { key: string; endpoint: TaggedEndpoint } | null {
  for (const [key, endpoint] of Object.entries(allEndpoints())) {
    if (endpointMethod(endpoint.route) !== method) {
      continue;
    }
    if (matchesTemplate(endpointPath(endpoint.route), pathname)) {
      return { key, endpoint };
    }
  }
  return null;
}

/**
 * Handle GET /user/repos - multi-repo discovery. In single-repo mode this path
 * is never called, so it answers a loud violation; in multi-repo mode it
 * enumerates the discovery pool, applying the SERVER-SIDE query params the
 * action sends (affiliation always, visibility only for public/private) and
 * paginating, but NOT the client-side filters (archived/fork/topics/exclude),
 * which the action settles itself. The repository probe GET /repos/{o}/{r} is a
 * section endpoint (repository.get), matched before this is consulted.
 */
function handleUserRepos(
  method: string,
  pathname: string,
  query: Record<string, string>,
  multi: MultiMockState | undefined,
): { response: MockResponse; violation?: string } | null {
  if (!matchesTemplate("/user/repos", pathname)) {
    return null;
  }
  if (!multi) {
    const message = "multi-repo discovery (/user/repos) is not implemented in single-repo mode";
    return { response: violationResponse(message), violation: message };
  }
  if (method !== "GET") {
    const message = `unexpected ${method} on /user/repos`;
    return { response: violationResponse(message), violation: message };
  }
  const filtered = applyServerSideDiscovery(multi.discoveryPool, query);
  return { response: ok(slicePage(filtered, query)) };
}

/**
 * The discovery params GitHub filters SERVER-SIDE, mirrored from
 * src/discovery/discover.ts and its test. `visibility` is the only one the
 * fixtures model: the server-side query narrows only coarsely, and the action
 * settles the rest client-side, so the mock must match that split exactly:
 *   - visibility=public  -> the API returns only public repos.
 *   - visibility=private -> the API returns private AND internal repos (there
 *     is no server-side "internal" value); the action drops the internal ones
 *     client-side (discover.test.ts "visibility: private drops internal repos
 *     client-side"). So the mock must NOT drop internal on the private query.
 *   - visibility=internal / all / absent -> no server-side narrowing; the
 *     action filters, so the mock passes the pool through.
 * `affiliation` has no per-repo fixture attribute (every pool repo is treated
 * as owned), so it is a pass-through here. archived/fork/topics/exclude are
 * client-side and must NEVER be pre-filtered.
 */
function applyServerSideDiscovery(pool: Json[], query: Record<string, string>): Json[] {
  const visibility = query.visibility;
  if (visibility === "public") {
    return pool.filter((repo) => (repo.visibility ?? "public") === "public");
  }
  if (visibility === "private") {
    // Private AND internal survive the server-side query; the action narrows.
    return pool.filter((repo) => (repo.visibility ?? "public") !== "public");
  }
  return pool;
}

/**
 * The Accept header value the settings-file fetch sends: getRepoFile requests
 * the raw media type so the body comes back as the file text, not a JSON
 * content object. The mock requires this exact value on the contents route.
 */
const RAW_CONTENTS_ACCEPT = "application/vnd.github.raw+json";

/**
 * Serve a target slug's settings.yml over the contents endpoint, AFTER the
 * caller has graded the `contents` read permission. A configured slug returns
 * its raw YAML body (the client sent the raw accept header, so the body is the
 * file text verbatim); a slug whose settings are null - or one the multi-state
 * does not know - returns 404, which the action reads as "no settings file" and
 * disambiguates via the repo probe.
 */
function contentsResponse(multi: MultiMockState, slug: string): MockResponse {
  const yaml = multi.settings.get(slug);
  if (yaml === null || yaml === undefined) {
    return { status: 404, body: { message: "Not Found" } };
  }
  return { status: 200, body: yaml };
}

/** The target slug of a contents request, or null when the path is not one. */
function contentsSlug(pathname: string): string | null {
  const match = pathname.match(/^\/repos\/([^/]+\/[^/]+)\/contents\//);
  return match ? decodeURIComponent(match[1] ?? "") : null;
}

/**
 * The target slug a request addresses, parsed from the path. Section endpoints
 * spell it `/repos/{owner}/{repo}/...`; the team endpoints spell it as the
 * trailing `.../repos/{owner}/{repo}`; the disambiguation probe is exactly
 * `/repos/{owner}/{repo}`. Returns null when no slug is present (e.g.
 * `/orgs/{org}` alone), so the caller falls back to the admin repo's state.
 */
function slugFromPath(pathname: string): string | null {
  const segments = pathname.split("/").filter((s) => s.length > 0);
  const reposIndex = segments.lastIndexOf("repos");
  if (reposIndex >= 0 && segments.length >= reposIndex + 3) {
    const owner = segments[reposIndex + 1];
    const name = segments[reposIndex + 2];
    if (owner && name) {
      return `${decodeURIComponent(owner)}/${decodeURIComponent(name)}`;
    }
  }
  return null;
}

/**
 * Run the full request pipeline for one already-parsed request. This is pure:
 * it reads and mutates `state`, appends nothing to logs itself (the caller
 * owns the arrays), and returns the response plus the log entry and any
 * violation. The order is the contract: wire checks, prefix, route match,
 * permission gate, denial barrier, check-mode barrier, then the handler.
 */
export function runPipeline(
  request: {
    method: string;
    rawPath: string;
    query: Record<string, string>;
    rawQuery: string;
    headers: Headers;
    body: unknown;
  },
  options: PipelineOptions,
): PipelineResult {
  const { scenario } = options;
  // The logged pathname has the GHES prefix stripped when the scenario opts
  // in; when the prefix is required but missing, there is nothing to strip, so
  // the raw path is logged with the resulting violation.
  const strippedForLog =
    options.basePrefix && request.rawPath.startsWith(options.basePrefix)
      ? request.rawPath.slice(options.basePrefix.length) || "/"
      : request.rawPath;
  const baseLog: LoggedRequest = {
    method: request.method,
    pathname: strippedForLog,
    query: request.rawQuery,
    body: request.body,
    status: 0,
  };

  // 1. Wire-contract assertions on EVERY request.
  if (!request.headers.get("authorization")) {
    const message = "request is missing the Authorization header";
    return {
      response: violationResponse(message),
      log: { ...baseLog, status: 400 },
      violation: message,
    };
  }
  if (!request.headers.get("x-github-api-version")) {
    const message = "request is missing the x-github-api-version header";
    return {
      response: violationResponse(message),
      log: { ...baseLog, status: 400 },
      violation: message,
    };
  }

  // 2. Optional GHES path prefix (e.g. /api/v3): strip before matching.
  let pathname = request.rawPath;
  if (options.basePrefix) {
    if (!pathname.startsWith(options.basePrefix)) {
      const message = `request path "${pathname}" is missing the required base prefix "${options.basePrefix}"`;
      return {
        response: violationResponse(message),
        log: { ...baseLog, status: 400 },
        violation: message,
      };
    }
    pathname = pathname.slice(options.basePrefix.length) || "/";
  }

  // 3a. Multi-repo discovery: /user/repos is not a section endpoint and is not
  // per-slug permission-gated (it is a user-level call), so it is served before
  // route matching.
  const userRepos = handleUserRepos(request.method, pathname, request.query, options.multi);
  if (userRepos) {
    return {
      response: userRepos.response,
      log: { ...baseLog, status: userRepos.response.status },
      violation: userRepos.violation,
    };
  }

  // 3b. The settings-file fetch (contents). Not a section endpoint, but it IS
  // permission-gated (Contents: read) and method/Accept-constrained, so it runs
  // through the same gate as a section read: GET only, the raw Accept header
  // required, and a Contents-denied slug gets the read-denial response (which
  // drives the action's 404 disambiguation + "grant Contents: read" advice).
  const cSlug = contentsSlug(pathname);
  if (cSlug !== null) {
    if (!options.multi) {
      const message = "settings-file fetch (contents) is not implemented in single-repo mode";
      return {
        response: violationResponse(message),
        log: { ...baseLog, status: 400 },
        violation: message,
      };
    }
    if (request.method !== "GET") {
      const message = `contents fetch must be GET, got ${request.method}`;
      return {
        response: violationResponse(message),
        log: { ...baseLog, status: 400 },
        violation: message,
      };
    }
    if (request.headers.get("accept") !== RAW_CONTENTS_ACCEPT) {
      const message = `contents fetch must send Accept: ${RAW_CONTENTS_ACCEPT}, got "${request.headers.get("accept") ?? ""}"`;
      return {
        response: violationResponse(message),
        log: { ...baseLog, status: 400 },
        violation: message,
      };
    }
    const mask = effectiveMask(
      scenario.token_permissions ?? {},
      options.multi.permissions.get(cSlug),
    );
    const grading = gradeResource(mask, "contents", "read");
    if (!grading.allowed) {
      const response = denialResponse(scenario.denial_style, "read");
      return { response, log: { ...baseLog, status: response.status, deniedBy: grading.deniedBy } };
    }
    const response = contentsResponse(options.multi, cSlug);
    return { response, log: { ...baseLog, status: response.status } };
  }

  // 3c. Section endpoints.
  const matched = matchEndpoint(request.method, pathname);
  if (!matched) {
    const message = `no route in routes.ts for ${request.method} ${pathname}`;
    return {
      response: violationResponse(message),
      log: { ...baseLog, status: 400 },
      violation: message,
    };
  }
  const { key, endpoint } = matched;

  // Resolve the working state and permission mask for this request. In
  // single-repo mode both come from the one MockState and the scenario mask; in
  // multi-repo mode the target slug in the path selects a per-slug MockState and
  // its per-slug mask overlaid on the global mask (so a denial can be scoped to
  // one repository while the global grades still apply). A path with no
  // resolvable slug under multi-repo mode is a design error - every section
  // endpoint carries owner/repo.
  let state = options.state;
  let mask: PermissionMask = scenario.token_permissions ?? {};
  if (options.multi) {
    const slug = slugFromPath(pathname);
    const repoState = slug ? options.multi.repos.get(slug) : undefined;
    if (!slug || !repoState) {
      const message = `multi-repo request ${request.method} ${pathname} names no known target slug`;
      return {
        response: violationResponse(message),
        log: { ...baseLog, status: 400 },
        violation: message,
      };
    }
    state = repoState;
    mask = effectiveMask(scenario.token_permissions ?? {}, options.multi.permissions.get(slug));
  }
  if (!state) {
    const message = `no working state for ${request.method} ${pathname}`;
    return {
      response: violationResponse(message),
      log: { ...baseLog, status: 400 },
      violation: message,
    };
  }

  // 4. Permission gate.
  const requirement = endpointRequirement(endpoint);
  const grading = gradeRequirement(mask, requirement);
  if (!grading.allowed) {
    const response = denialResponse(scenario.denial_style, requirement.kind);
    const log: LoggedRequest = { ...baseLog, status: response.status, deniedBy: grading.deniedBy };
    // 5. Denial barrier: a denied WRITE that reached the server despite a
    // guarantee it should not have is a violation; otherwise it is deny-only.
    // The guarantee comes from one of two places:
    //   - a "denied"-semantics section UNDER the fail policy: its primary read
    //     goes through the classifier, and preflight (which runs only when
    //     on-missing-permission is "fail", orchestrate.ts) reads it first and
    //     refuses every write.
    //   - a READ in this section was already denied earlier in the run: the
    //     engine aborts a section at its denied read (any policy, any style),
    //     so a later write for the same section proves broken sequencing.
    // Under the WARN policy there is no preflight, so a "denied"-semantics
    // section whose FIRST apply operation is a write (a repository/actions/
    // code_scanning PATCH/PUT with no preceding read) legitimately sends that
    // write and takes the denial, in BOTH denial styles - deny it with NO
    // violation, exactly like an "absent"-semantics section. The
    // deny-and-never-mutate invariant holds in every case; only the violation
    // flag is conditional.
    let violation: string | undefined;
    if (requirement.kind === "read") {
      // Track the denied read ONLY when the engine perceives it as a failure:
      // a denial status the endpoint tolerates (a fine_grained 404 on a
      // probeAbsent-tolerant endpoint) reads as "resource absent" and the
      // section legitimately proceeds, so it must not arm the barrier.
      if (!toleratedStatuses(endpoint).includes(response.status)) {
        options.deniedReadSections.add(endpoint.section);
      }
    }
    if (requirement.kind === "write") {
      const semantics = DENIAL_SEMANTICS[endpoint.section];
      const policy = scenario.inputs?.on_missing_permission ?? "fail";
      const preflightGuaranteed = semantics === "denied" && policy === "fail";
      if (preflightGuaranteed || options.deniedReadSections.has(endpoint.section)) {
        violation = `write to ${request.method} ${pathname} reached the server despite being permission-denied; it should have been stopped first (section "${endpoint.section}" has "${semantics}" denial semantics, on-missing-permission "${policy}", style ${String(scenario.denial_style)})`;
      }
    }
    return { response, log, violation };
  }

  // 6. Check-mode barrier: no writes may leave the client in check mode. The
  // flag is the scenario's mode ORed with the server's one-way override, so a
  // convergence re-run against the same server arms the barrier too.
  if (options.checkMode && request.method !== "GET") {
    const message = "write in check mode";
    return {
      response: violationResponse(message),
      log: { ...baseLog, status: 400 },
      violation: message,
    };
  }

  // 7. Handler runs.
  const handler = HANDLERS[key];
  if (!handler) {
    // assertHandlerCompleteness runs at construction, so this is unreachable;
    // keep it a loud violation rather than a silent undefined call.
    const message = `no handler registered for matched endpoint "${key}"`;
    return {
      response: violationResponse(message),
      log: { ...baseLog, status: 400 },
      violation: message,
    };
  }
  const response = handler({
    state,
    endpoint,
    pathname,
    query: request.query,
    body: request.body,
  });

  // 9. Chaos hook: corrupt the FIRST response of the named endpoint.
  if (options.corrupt && options.corrupt.key === key && !options.corruptedKeys.has(key)) {
    options.corruptedKeys.add(key);
    return applyCorruption(options.corrupt.mode, response, { ...baseLog, status: response.status });
  }

  return { response, log: { ...baseLog, status: response.status } };
}

/**
 * Corrupt a response per the chaos mode: invalid_json emits an unparseable
 * body (raw), wrong_shape replaces a list/object body with a scalar, and
 * missing_envelope strips the wrapper key from an enveloped list. The runner
 * asserts the client fails loudly on each.
 */
function applyCorruption(
  mode: CorruptOption["mode"],
  response: MockResponse,
  log: LoggedRequest,
): PipelineResult {
  if (mode === "invalid_json") {
    return {
      response: { status: response.status, body: undefined },
      log,
      raw: "{ this is not json",
    };
  }
  if (mode === "wrong_shape") {
    return { response: { status: response.status, body: 42 }, log };
  }
  // missing_envelope: unwrap a {total_count, <key>: []} body to a bare object
  // (drops the list the client expects behind the envelope key).
  const body = response.body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const stripped: Json = {};
    for (const [entryKey, value] of Object.entries(body as Json)) {
      if (!Array.isArray(value)) {
        stripped[entryKey] = value;
      }
    }
    return { response: { status: response.status, body: stripped }, log };
  }
  return { response: { status: response.status, body: {} }, log };
}

export { VIOLATION_PREFIX };
