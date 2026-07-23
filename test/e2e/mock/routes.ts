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

import { ISSUE_REPORT_PERMISSION, MARKER_LABEL } from "../../../src/report/issue-report.js";
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
  /**
   * The response body the mock sent, captured by server.ts once the pipeline
   * has decided. The OpenAPI validator checks it against responses[status];
   * undefined for an empty (204) body. Not set by the pipeline itself - the
   * transport shell attaches it from result.response.body after logging.
   */
  responseBody?: unknown;
  /**
   * True when this whole response is deliberately off the OpenAPI contract -
   * a raw media type (the settings-file fetch returns file text), a synthetic
   * transport fault (rate-limit 403 / 429 / connection drop), or a chaos-corrupt
   * body. The validator skips such entries entirely (status AND body): the spec
   * documents neither the status nor the shape, by design. Set by server.ts.
   */
  offSpec?: boolean;
}

/** The reply a handler (or the pipeline) produces: a status and a JSON body. */
export interface MockResponse {
  status: number;
  body: unknown;
  /** Extra response headers (e.g. Retry-After on the 429 fault). */
  headers?: Record<string, string>;
}

/**
 * Everything a handler needs to serve one request: the mutable state, the
 * matched endpoint, the concrete path (so id/name params can be parsed out),
 * the parsed query, and the request body. The chaos-corruption directive is
 * applied by the pipeline AFTER the handler returns, so it is not passed here.
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
      // The spec documents this 404 (feature not enabled) with NO content.
      return { status: 404, body: null };
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
  "repository.privateVulnerabilityReportingGet": ({ state }) => {
    // When the feature is not applicable to this repository (observed on
    // private repos), the GET answers 404 - one of its declared statuses. The
    // section reads that as "not enabled". Flag set via live_state.repo.
    if (state.repo.private_vulnerability_reporting_not_applicable === true) {
      return { status: 404, body: { message: "Not Found" } };
    }
    return ok({ enabled: state.repo.private_vulnerability_reporting_enabled === true });
  },
  "repository.privateVulnerabilityReportingPut": ({ state }) => {
    state.repo.private_vulnerability_reporting_enabled = true;
    return noContent();
  },
  "repository.privateVulnerabilityReportingRemove": ({ state }) => {
    // Disabling where the feature does not apply is already the declared state;
    // the DELETE answers 404 (a declared "already off / not applicable" status)
    // rather than 204, which the section tolerates.
    if (state.repo.private_vulnerability_reporting_not_applicable === true) {
      return { status: 404, body: { message: "Not Found" } };
    }
    state.repo.private_vulnerability_reporting_enabled = false;
    return noContent();
  },

  // labels -----------------------------------------------------------------
  "labels.list": ({ state, query }) => ok(slicePage(state.labels, query)),
  "labels.create": ({ state, body }) => {
    const payload = asObject(body);
    // A duplicate name answers 422, matching GitHub. The labels SECTION never
    // POSTs a duplicate (it PATCHes an existing label), so this only fires for
    // the private-report marker-label ensure-create, which tolerates the 422.
    if (findLabel(state, String(payload.name))) {
      return { status: 422, body: { message: "Validation Failed" } };
    }
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
    // GitHub's PUT environment returns 200 on BOTH create and update (never
    // 201), matching the section's declared status and the OpenAPI spec.
    state.environments[name] = { name, ...environmentFromPut(asObject(body)) };
    return ok(state.environments[name]);
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
    // A configuration validation run already in progress: the PATCH answers 409
    // (a declared status the section tolerates and gives its own advice for),
    // and no change is applied. Flag set via live_state.code_scanning. This is
    // checked before the language/200-vs-202 rule so it can be triggered
    // independently.
    if (state.code_scanning.configuration_run_in_progress === true) {
      return { status: 409, body: { message: "A configuration run is already in progress" } };
    }
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
    // The spec's 200 response is an EMPTY object (additionalProperties: false):
    // a synchronous apply returns no body content. The 202 path (below) carries
    // {run_id, run_url}. State is still updated above; only the wire body is {}.
    return ok({});
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
    // 201 returns a repository-invitation object; its `permissions` is a STRING
    // (read/write/admin/...), not the collaborator role object. The section does
    // not read this body, but the OpenAPI validator checks its shape. Derive all
    // identity fields from state.repo (re-slugged per target in multi mode) so
    // the invitee/inviter/urls stay internally consistent with the target repo.
    const permission = String(asObject(body).permission ?? "push");
    const invitationPermission =
      permission === "pull" ? "read" : permission === "push" ? "write" : permission;
    const id = state.nextId++;
    const slug = String(state.repo.full_name ?? "e2e-owner/e2e-repo");
    const ownerLogin = String((state.repo.owner as Json | undefined)?.login ?? slug.split("/")[0]);
    return {
      status: 201,
      body: {
        id,
        node_id: `MDEwOlJlcG9JbnZpdGF0aW9u${id}`,
        repository: state.repo,
        invitee: { login: username, id: 0, type: "User", site_admin: false },
        inviter: { login: ownerLogin, id: 0, type: "User", site_admin: false },
        permissions: invitationPermission,
        created_at: "2026-07-01T00:00:00Z",
        url: `https://api.github.com/repos/${slug}/invitations/${id}`,
        html_url: `https://github.com/${slug}/invitations`,
      },
    };
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
      // The spec documents this 404 ("team does not have permission for the
      // repository") with NO response content, so the body is empty.
      return { status: 404, body: null };
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
    const number = nextNumber(state.milestones);
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

/**
 * A GET on a 204/404 boolean toggle (vulnerability-alerts): 204 when enabled,
 * 404 when not. The spec documents this 404 with NO content, so the body is
 * empty.
 */
function booleanToggleGet(enabled: boolean): MockResponse {
  return enabled ? noContent() : { status: 404, body: null };
}

function labelName(label: Json): string {
  return String(label.name).toLowerCase();
}

function findLabel(state: MockState, name: string): Json | undefined {
  return state.labels.find((l) => labelName(l) === name.toLowerCase());
}

/** The next 1-based `number` for a list keyed by a numeric `number` field. */
function nextNumber(items: Json[]): number {
  const max = items.reduce((acc, item) => Math.max(acc, Number(item.number) || 0), 0);
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
 * Reject fault/corrupt directives that name an unknown endpoint or duplicate a
 * fault. Keys are free-form strings, so a typo would silently never fire and a
 * duplicate fault would silently take first-match; validating at server
 * construction (the same loud-at-startup pattern as assertHandlerCompleteness)
 * turns both into an immediate throw. Exported for direct testing.
 */
export function assertFaultKeys(
  faults: FaultOption[] | undefined,
  corrupt: CorruptOption | undefined,
): void {
  const known = new Set(Object.keys(allEndpoints()));
  const seen = new Set<string>();
  for (const fault of faults ?? []) {
    if (!known.has(fault.key)) {
      throw new Error(
        `E2E MOCK: fault names unknown endpoint "${fault.key}" (not in allEndpoints())`,
      );
    }
    if (seen.has(fault.key)) {
      throw new Error(
        `E2E MOCK: duplicate fault for endpoint "${fault.key}"; keep one entry per endpoint`,
      );
    }
    seen.add(fault.key);
  }
  if (corrupt && !known.has(corrupt.key)) {
    throw new Error(
      `E2E MOCK: corrupt names unknown endpoint "${corrupt.key}" (not in allEndpoints())`,
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
 *
 * This rule governs HANDLER responses only. Transport-level faults (the fault
 * barrier's rate-limit 403 / 429, and the connection_drop status 0) fire BEFORE
 * any handler and deliberately bypass this invariant: they model wire failures
 * GitHub returns on any endpoint regardless of its declared statuses.
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

/**
 * A corruption directive for a named endpoint's responses. `times` (default 1)
 * is how many matching responses to corrupt: 1 (the default) corrupts only the
 * first, which octokit's retry plugin transparently retries away (a parse/shape
 * fault is not a 4xx, so it is retried; MAX_RETRIES=2) - a retry-resilience
 * test. A persistent count (>= 3, more than 1 + MAX_RETRIES) or "always"
 * defeats the retries so the client fails loudly.
 */
export interface CorruptOption {
  key: string;
  mode: "invalid_json" | "wrong_shape" | "missing_envelope";
  times?: number | "always";
}

/**
 * A transport-level fault applied to the first `times` (default 1) requests
 * matching `key` (a "section.role" endpoint). Mirrors the Fault schema; the
 * fault barrier in runPipeline turns each kind into its wire behavior.
 */
export interface FaultOption {
  key: string;
  kind: "rate_limit_403" | "429_then_200" | "connection_drop";
  times?: number;
}

/**
 * The mutable per-run state the pipeline threads through every request: the
 * chaos/fault fire counts and the two denial-barrier bookkeeping structures.
 * Grouped into one type with a single factory (`newPipelineRunState`) so a new
 * field cannot be forgotten at the construction site - adding one here without
 * adding it to the factory fails to compile, and the server spreads the factory
 * result wholesale rather than listing fields by hand.
 */
export interface PipelineRunState {
  /** Per-endpoint chaos-corruption counts, mutated in place so `times` is honored. */
  corruptCounts: Map<string, number>;
  /** Per-endpoint fault fire counts, mutated in place so `times` is honored. */
  faultCounts: Map<string, number>;
  /**
   * Target+section keys (`${slug}:${section}`, empty slug in single-repo mode)
   * whose READ was permission-denied (fatally, not tolerated) earlier this run;
   * mutated in place. The engine aborts a section at its first fatal denied
   * read, so a write arriving for the same target+section afterwards proves
   * broken sequencing (see the denial barrier). Keyed per target so one repo's
   * denied read never arms the barrier for another repo's legitimate write.
   */
  deniedReadSections: Set<string>;
  /**
   * The redaction visibility probe's window, per slug, so its denial never arms
   * the repository-section barrier while a LATER repository.get still does. The
   * probe is a `repository.get` issued during visibility resolution, before the
   * target loop. Two facts bound its window (both mutated in place):
   *   - `probeGetFaults`: how many of a slug's repository.get attempts FAULTED at
   *     the transport barrier. The probe retries a fault up to the client's
   *     budget (1 + MAX_RETRIES); once that many faults have fired, the probe has
   *     given up, so the next repository.get is a section read, not a retry.
   *   - `probeGetDelivered`: whether a repository.get for the slug has already
   *     DELIVERED a real response (granted or denied). The probe delivers at most
   *     once; any repository.get after that is the section's own check-mode read.
   * A repository.get is the probe iff a probe is expected for the slug, none has
   * delivered yet, and the fault budget is not spent - so an all-faulting probe
   * cannot keep the exemption open past its retries.
   */
  probeGetFaults: Map<string, number>;
  probeGetDelivered: Set<string>;
}

/** Fresh per-run state with every field initialized - the single construction point. */
export function newPipelineRunState(): PipelineRunState {
  return {
    corruptCounts: new Map(),
    faultCounts: new Map(),
    deniedReadSections: new Set(),
    probeGetFaults: new Map(),
    probeGetDelivered: new Set(),
  };
}

/** Options the server passes into the pipeline for each request. */
export interface PipelineOptions extends PipelineRunState {
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
  /** Transport-level faults to inject on matching requests (see fault barrier). */
  faults?: FaultOption[];
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
  /**
   * When true, the server drops the connection MID-RESPONSE (an erroring body
   * stream; Bun.serve cannot abort before the status line) - the
   * connection_drop fault, modeling a network failure the client surfaces after
   * its retries are spent. The log entry still records the attempt (status 0).
   */
  drop?: boolean;
  /**
   * When true, this response is a DELIBERATE off-contract body the validator
   * must skip, else it re-reports a corruption/fault the test already asserts.
   * Set for: synthetic transport faults (rate-limit 403 / 429 - GitHub returns
   * these on ANY endpoint, off any per-endpoint spec), the chaos corruptions
   * (wrong_shape / missing_envelope; invalid_json uses `raw`), and the
   * connection_drop status-0 log. (Raw-MEDIA-TYPE bodies are exempted separately
   * in server.ts, keyed on the request's raw Accept header, not this flag.)
   */
  offSpecBody?: boolean;
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

// --- Private-report issue channel (core paths, not a section) --------------
//
// The issue channel delivers the full unredacted report as an issue on the
// target repo. Its routes are NOT section endpoints (report delivery is
// infrastructure that writes even in check mode); they are served inline before
// section matching, exactly like the contents fetch, and gated on the Issues
// permission per ISSUE_REPORT_PERMISSION. GET /user is the fallback creator
// scan and is a user-level call, so it is ungated. The marker-label POST goes
// through the existing labels.create section route (Issues-gated, 422 on
// duplicate), so it is not modeled here.

/** The token user GET /user reports; the report module reads only `login`. */
const TOKEN_USER_LOGIN = "e2e-token-user";

/** A repo's proven visibility from its mock state (defaults public via the fixture). */
function visibilityOfState(state: MockState | undefined): string {
  const repo = state?.repo ?? {};
  if (typeof repo.visibility === "string") {
    return repo.visibility;
  }
  return repo.private === true ? "private" : "public";
}

/**
 * Whether the action could PROVE this slug's visibility - the precondition for
 * report delivery. Discovery-supplied slugs need no probe (their visibility came
 * from /user/repos), so they are always provable. An explicit target is probed
 * with one administration-gated repository.get; the probe fails to "unknown"
 * (and delivery is skipped) when administration is denied, or when a fault on
 * repository.get exhausts the probe's retry budget. Modeling this - rather than
 * reading the fixture visibility alone - is what lets the mock reject a delivery
 * the action could never have made.
 */
function probeCanProveVisibility(
  slug: string,
  scenario: Scenario,
  multi: MultiMockState | undefined,
  faults: FaultOption[] | undefined,
): boolean {
  const discovered = (multi?.discoveryPool ?? []).some(
    (repo) => String(repo.full_name).toLowerCase() === slug.toLowerCase(),
  );
  if (discovered) {
    return true;
  }
  const mask = effectiveMask(scenario.token_permissions ?? {}, multi?.permissions.get(slug));
  if (!grantsAtLeast(mask, "administration", "read")) {
    return false;
  }
  const probeFault = faults?.find((f) => f.key === "repository.get");
  if (probeFault && (probeFault.times ?? 1) >= PROBE_RETRY_BUDGET) {
    return false;
  }
  return true;
}

/**
 * Whether a slug is a report-DELIVERY target this run: the report channel is
 * `issue`, redaction is on, the slug is not the admin repo, its FIXTURE
 * visibility is private or internal, AND the action could actually PROVE that
 * visibility (see probeCanProveVisibility). This mirrors the action's delivery
 * rule exactly - deliver only when PROVEN private/internal, so a probe the
 * scenario denies or faults resolves "unknown" and delivery is skipped. The mock
 * serves the issue-channel routes for a slug only when this holds; report
 * traffic to any other slug (public, non-redacted, OR unknown-because-unprovable)
 * falls through to the normal barrier and section matching, so an accidental or
 * regressed delivery is caught loudly.
 */
function isReportDeliveryTarget(
  slug: string,
  scenario: Scenario,
  multi: MultiMockState | undefined,
  faults: FaultOption[] | undefined,
): boolean {
  if (scenario.inputs?.private_report !== "issue") {
    return false;
  }
  if ((scenario.inputs?.private_repos ?? "redact") !== "redact") {
    return false;
  }
  if (slug.toLowerCase() === ADMIN_SLUG) {
    return false;
  }
  const visibility = visibilityOfState(multi ? multi.repos.get(slug) : undefined);
  if (visibility !== "private" && visibility !== "internal") {
    return false;
  }
  return probeCanProveVisibility(slug, scenario, multi, faults);
}

/** The report issue's html_url, so the run summary can link it. */
function issueUrl(slug: string, number: number): string {
  return `https://github.com/${slug}/issues/${number}`;
}

/** True when this issue object matches the list query's labels/creator/state filters. */
function issueMatchesQuery(issue: Json, query: Record<string, string>): boolean {
  if (query.state && query.state !== "all" && String(issue.state) !== query.state) {
    return false;
  }
  if (query.creator) {
    const login = (issue.user as { login?: unknown } | undefined)?.login;
    if (login !== query.creator) {
      return false;
    }
  }
  if (query.labels) {
    const wanted = query.labels.split(",");
    const have = Array.isArray(issue.labels)
      ? (issue.labels as Json[]).map((l) => String((l as { name?: unknown }).name ?? l))
      : [];
    if (!wanted.every((w) => have.includes(w))) {
      return false;
    }
  }
  return true;
}

/** Expand a label name into the object shape the issues list returns. */
function labelObject(name: string): Json {
  return { name, color: "0e2a47", default: false };
}

/**
 * Resolve and Issues-gate an issue-channel request for a slug. Returns the
 * granted repo state on success, or a ready-to-send response (unknown-slug
 * violation or permission denial) the caller returns early. Shared by the
 * marker-label and issue routes so the resolve-then-grade guard is written once.
 */
type IssueTargetResult =
  | { state: MockState }
  | { response: MockResponse; deniedBy?: MaskKey; violation?: string };

function gradeIssueTarget(
  method: string,
  pathname: string,
  slug: string,
  level: "read" | "write",
  scenario: Scenario,
  multi: MultiMockState | undefined,
  singleState: MockState | undefined,
): IssueTargetResult {
  const repoState = multi ? multi.repos.get(slug) : singleState;
  if (!repoState) {
    const message = `issue-report request ${method} ${pathname} names no known target slug`;
    return { response: violationResponse(message), violation: message };
  }
  const mask = effectiveMask(scenario.token_permissions ?? {}, multi?.permissions.get(slug));
  // Grade against the report module's DECLARED permission (single-sourced),
  // not a hard-coded "issues", so a change to ISSUE_REPORT_PERMISSION flows here.
  const grading = gradeRequirement(mask, { permission: ISSUE_REPORT_PERMISSION, kind: level });
  if (!grading.allowed) {
    return { response: denialResponse(scenario.denial_style, level), deniedBy: grading.deniedBy };
  }
  return { state: repoState };
}

/**
 * Serve the private-report issue routes against a repo's `issues` state:
 *   - GET /user                                      -> the token user (ungated)
 *   - GET  /repos/{o}/{r}/issues                      -> list (Issues: read)
 *   - POST /repos/{o}/{r}/issues                      -> create (Issues: write)
 *   - PATCH /repos/{o}/{r}/issues/{issue_number}      -> update (Issues: write)
 * Returns null when the path is not an issue-channel route, so the caller falls
 * through to section matching. Permission denials set `deniedBy` (so the
 * OpenAPI validator skips them and the runner sees the denial).
 */
function handleIssueReport(
  method: string,
  pathname: string,
  query: Record<string, string>,
  body: unknown,
  scenario: Scenario,
  multi: MultiMockState | undefined,
  state: MockState | undefined,
  faults: FaultOption[] | undefined,
): { response: MockResponse; deniedBy?: MaskKey; violation?: string } | null {
  // GET /user is the fallback creator scan - served only when the run enables
  // the issue channel at all (otherwise it is not report traffic and falls
  // through to a loud no-route violation).
  if (matchesTemplate("/user", pathname)) {
    if (method !== "GET" || scenario.inputs?.private_report !== "issue") {
      return null;
    }
    return { response: ok({ login: TOKEN_USER_LOGIN, id: 1, type: "User" }) };
  }
  // The marker-label ensure-create is report infrastructure (it writes even in
  // check mode), so it is served here - BEFORE the check-mode barrier - rather
  // than through the labels.create section route. The bypass is SCOPED: it fires
  // only for the marker label name AND only for a slug that is a report-delivery
  // target this run. A marker POST to any other slug (e.g. a buggy labels-section
  // write of the injected marker in check mode) falls through to the section
  // route and hits the normal check-mode barrier / gating.
  const labelsMatch = pathname.match(/^\/repos\/([^/]+\/[^/]+)\/labels$/);
  if (labelsMatch && method === "POST" && asObject(body).name === MARKER_LABEL) {
    const slug = decodeURIComponent(labelsMatch[1] ?? "");
    if (!isReportDeliveryTarget(slug, scenario, multi, faults)) {
      return null;
    }
    const target = gradeIssueTarget(method, pathname, slug, "write", scenario, multi, state);
    if (!("state" in target)) {
      return target;
    }
    if (findLabel(target.state, MARKER_LABEL)) {
      return { response: { status: 422, body: { message: "Validation Failed" } } };
    }
    const payload = asObject(body);
    const label: Json = {
      id: target.state.nextId++,
      name: MARKER_LABEL,
      color: payload.color ?? "ededed",
      default: false,
      description: payload.description ?? null,
    };
    target.state.labels.push(label);
    return { response: { status: 201, body: label } };
  }
  const issuesMatch = pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues(?:\/(\d+))?$/);
  if (!issuesMatch) {
    return null;
  }
  const slug = decodeURIComponent(issuesMatch[1] ?? "");
  // Scope the issue-route bypass to a report-delivery target: issue traffic to a
  // public/non-redacted slug (accidental delivery) is not served here and falls
  // through to a loud no-route violation at section matching.
  if (!isReportDeliveryTarget(slug, scenario, multi, faults)) {
    return null;
  }
  const issueNumber = issuesMatch[2] ? Number(issuesMatch[2]) : undefined;
  const level: "read" | "write" = method === "GET" ? "read" : "write";
  const target = gradeIssueTarget(method, pathname, slug, level, scenario, multi, state);
  if (!("state" in target)) {
    return target;
  }
  const repoState = target.state;
  if (method === "GET" && issueNumber === undefined) {
    const matched = repoState.issues.filter((issue) => issueMatchesQuery(issue, query));
    return { response: ok(slicePage(matched, query)) };
  }
  if (method === "POST" && issueNumber === undefined) {
    const payload = asObject(body);
    const number = nextNumber(repoState.issues);
    const labels = Array.isArray(payload.labels)
      ? payload.labels.map((l) => labelObject(String(l)))
      : [];
    const issue: Json = {
      number,
      title: payload.title ?? "",
      body: payload.body ?? "",
      state: "open",
      labels,
      user: { login: TOKEN_USER_LOGIN, id: 1, type: "User" },
      html_url: issueUrl(slug, number),
    };
    repoState.issues.push(issue);
    return { response: { status: 201, body: issue } };
  }
  if (method === "PATCH" && issueNumber !== undefined) {
    const issue = repoState.issues.find((i) => Number(i.number) === issueNumber);
    if (!issue) {
      return { response: { status: 404, body: { message: "Not Found" } } };
    }
    const payload = asObject(body);
    if (payload.body !== undefined) {
      issue.body = payload.body;
    }
    if (payload.state !== undefined) {
      issue.state = payload.state;
    }
    return { response: ok(issue) };
  }
  const message = `unexpected ${method} on ${pathname}`;
  return { response: violationResponse(message), violation: message };
}

/**
 * The admin repo the e2e runner runs as (its GITHUB_REPOSITORY). Kept in sync
 * with runner.ts's REPO_SLUG. The redaction self carve-out never probes this
 * slug, so a repository.get for it is always a section read, never the probe.
 */
const ADMIN_SLUG = "e2e-owner/e2e-repo";

/**
 * How many wire attempts the visibility probe can make: one plus the client's
 * retry budget (MAX_RETRIES = 2 in src/github/api.ts). Once a slug's
 * repository.get has faulted this many times the probe has exhausted its
 * retries and given up, so the next repository.get is a section read - not a
 * probe retry - and the exemption expires.
 */
const PROBE_RETRY_BUDGET = 3;

/**
 * Whether the redaction visibility probe is EXPECTED to issue a
 * `GET /repos/{slug}` for this target, so its denial may be exempted from the
 * denial barrier. The action probes a slug's visibility (one repository.get,
 * outside the section loop) only when ALL hold:
 *   - the run is multi-repo (the single-repo harness path always targets the
 *     admin repo itself, which the self carve-out never probes);
 *   - the effective policy is redact (the default; `show` never probes);
 *   - the slug is not the admin repo (the self carve-out skips the probe);
 *   - the slug's visibility did not already come from a `/user/repos` discovery
 *     response this run (a discovered slug's visibility is known, so no probe).
 * When a probe is NOT expected, the first (and only) repository.get is the
 * repository section's own check-mode read and MUST arm the barrier.
 */
function probeExpected(
  slug: string,
  scenario: Scenario,
  multi: MultiMockState | undefined,
): boolean {
  if (!multi) {
    return false;
  }
  if ((scenario.inputs?.private_repos ?? "redact") !== "redact") {
    return false;
  }
  if (slug.toLowerCase() === ADMIN_SLUG) {
    return false;
  }
  const discovered = multi.discoveryPool.some(
    (repo) => String(repo.full_name).toLowerCase() === slug.toLowerCase(),
  );
  return !discovered;
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
 * check-mode barrier, target/state resolution, fault barrier, permission gate,
 * denial barrier, then the handler.
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
    // The raw settings-file body skips response-body validation, but that is
    // decided by the request's raw Accept media type in server.ts (so every
    // raw endpoint inherits it), not marked here per-endpoint.
    return { response, log: { ...baseLog, status: response.status } };
  }

  // 3b2. Private-report issue channel (GET /user, the issues list/create/patch).
  // Served inline, before section matching, because report delivery is
  // infrastructure that writes even in check mode - so it must NOT pass through
  // the check-mode write barrier below. Gated on the Issues permission.
  const issueReport = handleIssueReport(
    request.method,
    pathname,
    request.query,
    request.body,
    scenario,
    options.multi,
    options.state,
    options.faults,
  );
  if (issueReport) {
    return {
      response: issueReport.response,
      log: {
        ...baseLog,
        status: issueReport.response.status,
        ...(issueReport.deniedBy ? { deniedBy: issueReport.deniedBy } : {}),
      },
      ...(issueReport.violation ? { violation: issueReport.violation } : {}),
    };
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

  // Check-mode barrier: no writes may leave the client in check mode. This runs
  // BEFORE the fault barrier so a faulted write in check mode is still caught as
  // a violation - the engine must never send a write in check mode, which is
  // the exact case this barrier exists to catch, and a synthetic fault must not
  // mask it. The flag is the scenario's mode ORed with the server's one-way
  // override, so a convergence re-run against the same server arms it too.
  if (options.checkMode && request.method !== "GET") {
    const message = "write in check mode";
    return {
      response: violationResponse(message),
      log: { ...baseLog, status: 400 },
      violation: message,
    };
  }

  // Resolve the working state and permission mask for this request. In
  // single-repo mode both come from the one MockState and the scenario mask; in
  // multi-repo mode the routing depends on whether the endpoint is repo-scoped:
  //   - a repo endpoint (path starts /repos/) selects the target slug's
  //     MockState and grades against that slug's per-slug mask overlaid on the
  //     global mask (a denial can be scoped to one repository);
  //   - an org endpoint (the teams /orgs/{org} probe) is NOT per-slug: it reads
  //     the shared org state and grades against the GLOBAL mask. A team-repo
  //     route (/orgs/{org}/teams/.../repos/{owner}/{repo}) still carries a repo
  //     tail, so it resolves to the addressed slug's state, but org endpoints
  //     never get a per-slug mask.
  let state = options.state;
  let mask: PermissionMask = scenario.token_permissions ?? {};
  // The target slug for keying the per-target denied-read barrier ("" in
  // single-repo mode). Set inside the multi block below.
  let targetSlug = "";
  if (options.multi) {
    const repoScoped = endpointPath(endpoint.route).startsWith("/repos/");
    const slug = slugFromPath(pathname);
    const repoState = slug ? options.multi.repos.get(slug) : undefined;
    if (repoScoped) {
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
      targetSlug = slug;
    } else {
      // Org endpoint. A team-repo route carries a {owner}/{repo} tail: it MUST
      // resolve to that slug's state, so an unknown slug is the same violation
      // the repo-scoped branch raises (falling back to orgState would let a
      // buggy write silently mutate shared org state). Only the BARE org probe
      // (no slug in the path, e.g. GET /orgs/{org}) uses orgState.
      if (slug && !repoState) {
        const message = `multi-repo request ${request.method} ${pathname} names no known target slug`;
        return {
          response: violationResponse(message),
          log: { ...baseLog, status: 400 },
          violation: message,
        };
      }
      state = repoState ?? options.multi.orgState;
      targetSlug = slug ?? "";
      // HYBRID grading for a team-repo route: real GitHub treats administration
      // as a REPOSITORY permission on the ADDRESSED repo (fine-grained PATs
      // grant it per selected repo - adding a repo to a team needs admin on
      // that repo), while org_members is org-wide. So the repo resources grade
      // against the addressed slug's effective per-slug mask and org_members
      // against the GLOBAL mask. This matches the oracle's orgMask model by
      // construction. The bare org probe (no slug) has no repo resources and is
      // permission-none anyway, so the global mask stands.
      const global = scenario.token_permissions ?? {};
      if (slug) {
        mask = {
          ...effectiveMask(global, options.multi.permissions.get(slug)),
          org_members: global.org_members,
        };
      } else {
        mask = global;
      }
    }
  }
  if (!state) {
    const message = `no working state for ${request.method} ${pathname}`;
    return {
      response: violationResponse(message),
      log: { ...baseLog, status: 400 },
      violation: message,
    };
  }

  // Identify the redaction visibility probe so its denial never arms the
  // repository-section barrier. The exemption is bounded to the probe's window
  // (see probeGetFaults/probeGetDelivered): a repository.get is the probe iff a
  // probe is EXPECTED for the slug, no repository.get has DELIVERED yet, and the
  // probe's fault-retry budget is not spent. This is computed after the fault
  // barrier (below) against the pre-delivery state, so an all-faulting probe
  // cannot keep the exemption open past its retries.

  // Fault barrier: transport-level failures fire before the permission gate and
  // handler (a rate limit / drop happens at the wire regardless of permissions),
  // but AFTER target/state resolution so a fault can never mask the
  // unknown-target violation - that check is a harness-integrity invariant and
  // must be unmaskable. Each fault applies to the first `times` (default 1)
  // requests matching its endpoint key.
  const fault = options.faults?.find((f) => f.key === key);
  if (fault) {
    const fired = options.faultCounts.get(key) ?? 0;
    if (fired < (fault.times ?? 1)) {
      options.faultCounts.set(key, fired + 1);
      // A faulted probe attempt counts toward its retry budget so the exemption
      // cannot outlast the probe's own retries (an all-faulting probe gives up,
      // and the next repository.get is a section read that must arm).
      if (key === "repository.get") {
        options.probeGetFaults.set(targetSlug, (options.probeGetFaults.get(targetSlug) ?? 0) + 1);
      }
      return applyFault(fault.kind, { ...baseLog });
    }
  }

  // Past the fault barrier a real response WILL be delivered. Decide whether this
  // repository.get is the probe (against the pre-delivery state), THEN record the
  // delivery so any later repository.get for the slug is a section read.
  const isVisibilityProbe =
    key === "repository.get" &&
    probeExpected(targetSlug, scenario, options.multi) &&
    !options.probeGetDelivered.has(targetSlug) &&
    (options.probeGetFaults.get(targetSlug) ?? 0) < PROBE_RETRY_BUDGET;
  if (key === "repository.get") {
    options.probeGetDelivered.add(targetSlug);
  }

  // 4. Permission gate.
  const requirement = endpointRequirement(endpoint);
  const grading = gradeRequirement(mask, requirement);
  if (!grading.allowed) {
    const response = denialResponse(scenario.denial_style, requirement.kind);
    const log: LoggedRequest = { ...baseLog, status: response.status, deniedBy: grading.deniedBy };
    // 5. Denial barrier. A denied write is a hard VIOLATION only when a fatal
    // denied READ in the SAME target+section already happened this run: the
    // engine reads a section before diffing/writing, so once its read is denied
    // and classified as fatal, the section loop aborts - a later write reaching
    // the server proves broken sequencing. This is the ONLY signal. Preflight is
    // deliberately NOT used as a separate guarantee: preflight (fail policy)
    // only proves READS work - the engine's probe wrapper stops writes
    // client-side - so a mask graded READ (write denied) on a "denied"-semantics
    // section PASSES preflight, and the engine then legitimately sends the first
    // write. That write is denied but is NOT a violation; the old
    // "denied-semantics && fail => violation" branch false-flagged exactly this
    // case. When the read grade is `none` the denied read always precedes the
    // write and arms the set, so no coverage is lost by relying on it alone.
    //
    // The set is keyed per TARGET (`${slug}:${section}`, empty slug single-repo)
    // so one repo's denied read never arms the barrier for another repo's
    // legitimate write.
    const barrierKey = `${targetSlug}:${endpoint.section}`;
    let violation: string | undefined;
    if (requirement.kind === "read") {
      // Track the denied read ONLY when the engine perceives it as a failure:
      // a denial status the endpoint tolerates (a fine_grained 404 on a
      // probeAbsent-tolerant endpoint) reads as "resource absent" and the
      // section legitimately proceeds, so it must not arm the barrier.
      //
      // Two categories are EXEMPT because their denied read is not a
      // section-abort read:
      //   - the redaction visibility probe (isVisibilityProbe): the FIRST
      //     repository.get for a repo, issued before the target loop to decide
      //     redaction. A LATER repository.get (the section's check-mode read) is
      //     not the probe and arms like any other section read.
      //   - an ADVISORY read (endpoint.advisory, single-sourced from the endpoint
      //     declaration, e.g. branches.branchProbe): the engine ignores any
      //     non-404 status and proceeds to its write anyway, so a denied advisory
      //     read does not mean the section should have aborted.
      // Genuine denied-read-then-write coverage is preserved: every non-advisory
      // section read still arms.
      const exempt = isVisibilityProbe || endpoint.advisory === true;
      if (!exempt && !toleratedStatuses(endpoint).includes(response.status)) {
        options.deniedReadSections.add(barrierKey);
      }
    }
    if (requirement.kind === "write" && options.deniedReadSections.has(barrierKey)) {
      const semantics = DENIAL_SEMANTICS[endpoint.section];
      violation = `write to ${request.method} ${pathname} reached the server after a fatal denied read in the same target+section; the engine's section loop should have aborted at that read (section "${endpoint.section}" has "${semantics}" denial semantics, style ${String(scenario.denial_style)})`;
    }
    return { response, log, violation };
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

  // Structural status-subset guard: a handler may only answer a status the
  // endpoint declares or an undeclared error (>= 400); an undeclared 2xx/3xx is
  // a mock design bug (see statusAllowed). Asserting it here - right after the
  // handler, before the chaos hook (which deliberately produces off-contract
  // responses) - makes the invariant hold on EVERY request, not just the ones a
  // curated test happens to drive.
  if (!statusAllowed(key, response.status)) {
    const message = `handler "${key}" returned status ${response.status}, which is neither declared [${[...declaredStatuses(key)].join(", ")}] nor a >= 400 error`;
    return {
      response: violationResponse(message),
      log: { ...baseLog, status: 400 },
      violation: message,
    };
  }

  // 9. Chaos hook: corrupt the response of the named endpoint for its first
  // `times` matches ("always" = every match). Default 1 preserves the one-shot
  // behavior octokit's retry plugin transparently recovers from.
  if (options.corrupt && options.corrupt.key === key) {
    const done = options.corruptCounts.get(key) ?? 0;
    const limit = options.corrupt.times ?? 1;
    if (limit === "always" || done < limit) {
      options.corruptCounts.set(key, done + 1);
      return applyCorruption(options.corrupt.mode, response, {
        ...baseLog,
        status: response.status,
      });
    }
  }

  return { response, log: { ...baseLog, status: response.status } };
}

/**
 * Turn a fault kind into its wire behavior:
 *   - rate_limit_403: 403 with "rate limit" in the message, so the client's
 *     classifier reads it as throttling (isRateLimitError), NOT a permission
 *     denial. This is the one place a 403 body is ALLOWED to say "rate limit".
 *   - 429_then_200: 429 with Retry-After: 0 so the throttling plugin retries
 *     immediately (fast under RETRY_BASE_MS=1); the retried request then runs
 *     the handler normally.
 *   - connection_drop: signal the server to drop the connection mid-response
 *     (an erroring body stream), which undici surfaces as a network failure.
 * The log records the attempt; the fault status (403/429) or 0 (drop) is set.
 */
function applyFault(kind: FaultOption["kind"], log: LoggedRequest): PipelineResult {
  if (kind === "rate_limit_403") {
    const response: MockResponse = {
      status: 403,
      body: { message: "API rate limit exceeded for this token" },
    };
    return { response, log: { ...log, status: 403 }, offSpecBody: true };
  }
  if (kind === "429_then_200") {
    const response: MockResponse = {
      status: 429,
      body: { message: "Too Many Requests" },
      headers: { "retry-after": "0" },
    };
    return { response, log: { ...log, status: 429 }, offSpecBody: true };
  }
  // connection_drop
  return {
    response: { status: 0, body: null },
    log: { ...log, status: 0 },
    drop: true,
    offSpecBody: true,
  };
}

/**
 * Corrupt a response per the chaos mode: invalid_json emits an unparseable
 * body (raw), wrong_shape replaces a list/object body with a scalar, and
 * missing_envelope strips the wrapper key from an enveloped list. All three are
 * DELIBERATE off-contract bodies, so each marks offSpecBody (invalid_json via
 * the `raw` path, the others explicitly) - the validator must skip them, else
 * it re-reports the corruption the chaos test already asserts. The mock's own
 * status-subset invariant still guards real handler statuses.
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
    return { response: { status: response.status, body: 42 }, log, offSpecBody: true };
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
    return { response: { status: response.status, body: stripped }, log, offSpecBody: true };
  }
  return { response: { status: response.status, body: {} }, log, offSpecBody: true };
}

export { VIOLATION_PREFIX };
