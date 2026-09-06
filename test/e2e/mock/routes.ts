/**
 * The mock GitHub server's request pipeline. Everything here is pure logic
 * over a MockState and a Scenario; the transport shell (node:http,
 * per-scenario lifecycle) lives in server.ts.
 *
 * The route TABLE is not hand-written: it is derived from allEndpoints(), the
 * frozen dictionary the sections themselves declare. The hand-written parts
 * live one layer down: one stateful handler per "section.role" key in the
 * section fragments (sections.ts, built on support.ts), merged and pinned
 * against the declarations in handlers.ts, plus the core-path handlers
 * (core-paths.ts) for the non-section calls. The pipeline here stitches the
 * stages in contract order: wire checks (contract.ts vocabulary), route match
 * and dispatch (dispatch.ts), the check-mode barrier, target resolution, the
 * fault barrier and chaos hook (chaos.ts), the permission gate and denial
 * responses (grading.ts), the denial barrier, the handler, and the response
 * guard.
 */

import type { SectionKey } from "../../../src/schema.js";
import { endpointPath, toleratedStatuses } from "../../../src/sections/contract/endpoints.js";
import { toleratedGraphqlErrors } from "../../../src/sections/contract/graphql.js";
import { denialPosture, endpointPermission } from "../../../src/sections/contract/module.js";
import { allGraphqlOps, type TaggedGraphqlOp } from "../../../src/sections/registry.js";
import type { PermissionMask } from "../schema.js";
import { applyFault, type CoreFaultKey, takeCorruption, takeFault } from "./chaos.js";
import {
  type LoggedRequest,
  type PipelineOptions,
  type PipelineResult,
  renderRequest,
  violationFor,
} from "./contract.js";
import {
  contentsResponse,
  contentsSlug,
  handleIssueReport,
  handleUserRepos,
  PROBE_RETRY_BUDGET,
  probeExpected,
  RAW_CONTENTS_ACCEPT,
} from "./core-paths.js";
import {
  declaredStatuses,
  graphqlOpForBody,
  matchEndpoint,
  paramAccessor,
  slugFromPath,
  statusAllowed,
} from "./dispatch.js";
import {
  denialResponse,
  effectiveMask,
  endpointRequirement,
  gradeRequirement,
  gradeResource,
  graphqlDenialErrors,
  type Requirement,
  SECTION_BY_KEY,
} from "./grading.js";
import { GRAPHQL_HANDLERS, HANDLERS } from "./handlers.js";
import { decodeNodeId, type NodeFamily } from "./node-id.js";
import type { MockState } from "./state.js";
import {
  asObject,
  type GraphqlErrorReply,
  type GraphqlHandler,
  type Json,
  type MockResponse,
} from "./support.js";

/**
 * Node-id families that are GLOBAL on GitHub (not repo-scoped): they carry
 * the GLOBAL_NODE_SLUG sentinel instead of a repository, so the mutation
 * target resolution must not read a slug off them. Apps are the one case:
 * a force-push allowance can name a GitHub App, whose id comes from the
 * repo-independent GET /apps/{app_slug} lookup.
 */
const GLOBAL_NODE_FAMILIES: ReadonlySet<NodeFamily> = new Set(["app"]);

/**
 * Every string anywhere inside a mutation's variables that decodes as a mock
 * node id, collected recursively - GraphQL mutations nest their target ids
 * under input objects, so a top-level scan would miss them. Ids of global
 * families are skipped: they name no repository.
 */
function decodedNodeIds(value: unknown, out: Array<{ slug: string }>): void {
  if (typeof value === "string") {
    const decoded = decodeNodeId(value);
    if (decoded && !GLOBAL_NODE_FAMILIES.has(decoded.family)) {
      out.push(decoded);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      decodedNodeIds(item, out);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      decodedNodeIds(item, out);
    }
  }
}

/**
 * Resolve a mutation's target slug from the self-describing node ids in its
 * variables: the ONE derivation of the write=>slug correlation, returning a
 * violation instead of a slug for zero or several addressed repositories
 * (the Grading-style discriminated result keeps the slug exactly where the
 * type says it is, so a write can never dispatch without a resolved target).
 */
function resolveMutationTarget(
  opName: string,
  variables: Json,
): { slug: string } | { violation: string } {
  const decoded: Array<{ slug: string }> = [];
  decodedNodeIds(variables, decoded);
  const slugs = [...new Set(decoded.map((id) => id.slug))];
  const first = slugs[0];
  if (first === undefined) {
    return {
      violation: `GraphQL mutation ${opName} carries no decodable mock node id; mutations must address their target through node ids the mock minted`,
    };
  }
  if (slugs.length > 1) {
    return {
      violation: `GraphQL mutation ${opName} carries node ids of several repositories [${slugs.sort().join(", ")}]; one mutation must address one target`,
    };
  }
  return { slug: first };
}

/**
 * The shared half of the denial barrier, REST and GraphQL alike: arm the
 * per-target per-section set on a fatally denied READ (`arms`), and produce
 * the ONE violation spelling for a WRITE that arrives after such a read -
 * renderRequest supplies both request spellings ("METHOD /path" and
 * "GRAPHQL <opName>"). What stays at each call site is deliberately NOT
 * shared: the tolerated/exempt predicates differ by wire (status subsets vs
 * error types, and the redaction visibility probe exemption is REST-only).
 */
function denialBarrier(
  options: PipelineOptions,
  log: LoggedRequest,
  section: SectionKey,
  targetSlug: string,
  kind: "read" | "write",
  arms: boolean,
): string | undefined {
  const barrierKey = `${targetSlug}:${section}`;
  if (kind === "read") {
    if (arms) {
      options.deniedReadSections.add(barrierKey);
    }
    return undefined;
  }
  if (!options.deniedReadSections.has(barrierKey)) {
    return undefined;
  }
  const module = SECTION_BY_KEY.get(section);
  const posture = module === undefined ? "(unregistered)" : denialPosture(module);
  return (
    `write to ${renderRequest(log, false)} reached the server after a fatal denied read in the ` +
    `same target+section; the engine's section loop should have aborted at that read (section ` +
    `"${section}" has the "${posture}" 404 posture, style ` +
    `${String(options.scenario.denial_style)})`
  );
}

/**
 * Serve one POST /graphql request: the GraphQL leg of the pipeline, mirroring
 * the REST order exactly - wire shape, dispatch, check-mode barrier, target
 * resolution, fault barrier, permission gate, denial barrier, handler,
 * response guard, chaos hook.
 *
 * Target resolution is where GraphQL differs from REST (the path carries no
 * slug): a READ resolves its slug from the $owner/$repo variables the
 * declaration contract requires, and a MUTATION resolves it from the
 * self-describing node ids the mock minted (see state.ts) - an undecodable or
 * absent id is a violation, never a guess, which keeps per-slug permission
 * masks and state routing exact. Single-repo mode dispatches into the one
 * MockState like every REST endpoint.
 *
 * `ops`/`handlers` are injectable for direct testing (the
 * assertHandlerCompleteness idiom); production takes the declared tables.
 */
export function handleGraphqlRequest(
  request: { method: string; body: unknown },
  options: PipelineOptions,
  baseLog: LoggedRequest,
  ops: Readonly<Record<string, TaggedGraphqlOp>> = allGraphqlOps(),
  handlers: Record<string, GraphqlHandler> = GRAPHQL_HANDLERS,
): PipelineResult {
  const { scenario, working } = options;
  const violation = violationFor(baseLog);

  // 1. Wire shape: GraphQL is POST-only, and the client always sends the
  // query, the operationName (the dispatch key), and a variables object.
  if (request.method !== "POST") {
    return violation(`GraphQL requests must be POST, got ${request.method}`);
  }
  const body = asObject(request.body);
  if (
    typeof body.query !== "string" ||
    typeof body.operationName !== "string" ||
    typeof body.variables !== "object" ||
    body.variables === null ||
    Array.isArray(body.variables)
  ) {
    return violation(
      "GraphQL request body must carry query (string), operationName (string), and variables (object)",
    );
  }
  const variables = body.variables as Json;

  // 2. Dispatch by operationName; an unknown name is a loud violation (the
  // no-route analog).
  const dispatched = graphqlOpForBody(body, ops);
  if (!dispatched) {
    return violation(
      `no GraphQL operation named "${String(body.operationName)}" is declared by any section`,
    );
  }
  const { key, op } = dispatched;
  const graphqlLog: LoggedRequest = {
    ...baseLog,
    graphql: { operationName: op.name, kind: op.kind },
  };

  // 3. Check-mode barrier, independent of the engine's read-only plan port: no GraphQL write may
  // leave the client in check mode. Before the fault barrier for the same reason as REST - a
  // synthetic fault must not mask the one bug this barrier exists to catch.
  if (options.checkMode && op.kind !== "read") {
    return violationFor(graphqlLog)(`GraphQL write in check mode (${op.name})`);
  }
  if (options.checkMode && op.phase === "execution") {
    return violationFor(graphqlLog)(`GraphQL execution-phase read in check mode (${op.name})`);
  }

  // 4. Target/state resolution, before the fault barrier so a fault can
  // never mask an unknown-target violation. A MUTATION resolves its target
  // from the self-describing node ids in EVERY mode - single-repo included,
  // where the decoded slug must name the one state - so a section that
  // sends a garbage or foreign id can never look green against the
  // single-repo harness and only fail once a multi scenario runs it.
  // `target` is null exactly for reads; a write either resolved its slug or
  // already returned the violation.
  const target = op.kind === "write" ? resolveMutationTarget(op.name, variables) : null;
  if (target !== null && "violation" in target) {
    return violation(target.violation);
  }
  let state: MockState;
  let mask: PermissionMask = scenario.token_permissions ?? {};
  let targetSlug = "";
  if (working.mode === "single") {
    state = working.state;
    if (target !== null && target.slug !== state.slug) {
      return violation(
        `GraphQL mutation ${op.name} carries node ids of "${target.slug}", but this single-repo run serves only "${state.slug}"`,
      );
    }
  } else {
    let slug: string;
    if (target !== null) {
      slug = target.slug;
    } else {
      const { owner, repo } = variables as { owner?: unknown; repo?: unknown };
      if (typeof owner !== "string" || typeof repo !== "string") {
        return violation(
          `GraphQL read ${op.name} carries no $owner/$repo variables to resolve its target slug`,
        );
      }
      slug = `${owner}/${repo}`;
    }
    const repoState = working.multi.repos.get(slug);
    if (!repoState) {
      return violation(`GraphQL ${op.name} names no known target slug ("${slug}")`);
    }
    state = repoState;
    mask = effectiveMask(scenario.token_permissions ?? {}, working.multi.permissions.get(slug));
    targetSlug = slug;
  }

  // 5. Fault barrier: GraphQL operations are addressable by their
  // "section.role" key exactly like REST endpoints (assertFaultKeys unions
  // the two universes).
  const taken = takeFault(key, options);
  if (taken) {
    return applyFault(taken.kind, { ...graphqlLog }, taken.fired);
  }

  // 6. Permission gate, grading the operation's DECLARED kind against the
  // same mask machinery as REST. A denial is the real wire shape: HTTP 200,
  // data:null, errors[] typed per the denial style.
  const section = SECTION_BY_KEY.get(op.section);
  if (!section) {
    return violation(`BUG: no section module registered for key "${op.section}"`);
  }
  const requirement: Requirement = {
    permission: endpointPermission(section, op),
    kind: op.kind,
  };
  const grading = gradeRequirement(mask, requirement);
  if (!grading.allowed) {
    const errors = graphqlDenialErrors(scenario.denial_style, op.kind);
    const response: MockResponse = { status: 200, body: { data: null, errors } };
    const log: LoggedRequest = { ...graphqlLog, status: 200, deniedBy: grading.deniedBy };
    // 6b. Denial barrier, SHARED with REST through denialBarrier and the same
    // per-target per-section sets: a GraphQL-read-denied section that then
    // writes (REST or GraphQL) is a violation, and vice versa. A denied read
    // whose error type the operation TOLERATES reads as "resource absent"
    // and must not arm, mirroring toleratedStatuses; advisory reads are
    // exempt for the same reason as REST.
    const arms =
      op.kind === "read" &&
      op.advisory !== true &&
      !toleratedGraphqlErrors(op).includes((errors[0] as GraphqlErrorReply).type);
    const barrierViolation = denialBarrier(options, log, op.section, targetSlug, op.kind, arms);
    return { response, log, violation: barrierViolation };
  }

  // 7. Handler runs.
  const handler = handlers[key];
  if (!handler) {
    // assertGraphqlHandlerCompleteness runs at construction, so this is
    // unreachable; keep it loud rather than a silent undefined call.
    return violation(`no GraphQL handler registered for dispatched operation "${key}"`);
  }
  const result = handler({ state, op, variables });

  // 8. Response guard, the status-subset analog: a handler may answer ONLY
  // data, or errors whose every type the operation declares as a tolerated
  // outcome. Anything else is a mock design bug.
  if (result.errors !== undefined) {
    const declared = toleratedGraphqlErrors(op);
    const undeclared = result.errors.filter((entry) => !declared.includes(entry.type));
    if (undeclared.length > 0) {
      return violation(
        `GraphQL handler "${key}" answered undeclared error type(s) [${undeclared.map((e) => `${e.type}: "${e.message}"`).join(", ")}]; the operation declares only [${declared.join(", ")}] as tolerated outcomes`,
      );
    }
  }
  const response: MockResponse = {
    status: 200,
    body:
      result.errors !== undefined ? { data: null, errors: result.errors } : { data: result.data },
  };

  // 9. Chaos hook, addressable by the same "section.role" key as the faults.
  const corrupted = takeCorruption(key, options, response, graphqlLog);
  if (corrupted) {
    return corrupted;
  }

  return { response, log: { ...graphqlLog, status: 200 } };
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
  const { scenario, working } = options;
  // The two working-state views the shared helpers below take: multi-repo
  // routing state, and the single-repo MockState (each undefined in the other
  // mode - the discriminated `working` is the source of truth).
  const multi = working.mode === "multi" ? working.multi : undefined;
  const singleState = working.mode === "single" ? working.state : undefined;
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
  const violation = violationFor(baseLog);

  // 1. Wire-contract assertions on EVERY request.
  if (!request.headers.get("authorization")) {
    return violation(
      `request ${request.method} ${strippedForLog} is missing the Authorization header`,
    );
  }
  if (!request.headers.get("x-github-api-version")) {
    return violation(
      `request ${request.method} ${strippedForLog} is missing the x-github-api-version header`,
    );
  }

  // 2. Optional GHES path prefix (e.g. /api/v3): strip before matching.
  let pathname = request.rawPath;
  if (options.basePrefix) {
    if (!pathname.startsWith(options.basePrefix)) {
      return violation(
        `request path "${pathname}" is missing the required base prefix "${options.basePrefix}"`,
      );
    }
    pathname = pathname.slice(options.basePrefix.length) || "/";
  }

  // The core-route fault hook: consume a registered core fault for this request
  // and turn it into its wire behavior. Built once here so every core handler
  // fires against the same per-run counts the section fault barrier uses.
  const takeCoreFault = (coreKey: CoreFaultKey): PipelineResult | null => {
    const taken = takeFault(coreKey, options);
    return taken ? applyFault(taken.kind, { ...baseLog }, taken.fired) : null;
  };

  // 3a. Multi-repo discovery: /user/repos is not a section endpoint and is not
  // per-slug permission-gated (it is a user-level call), so it is served before
  // route matching. Its fault/corruption hooks fire only on the legit route
  // (never masking a violation), mirroring the section pipeline's order.
  const userRepos = handleUserRepos(request.method, pathname, request.query, multi);
  if (userRepos) {
    if (!userRepos.violation) {
      const faulted = takeCoreFault("core.discoveryList");
      if (faulted) {
        return faulted;
      }
      const corrupted = takeCorruption("core.discoveryList", options, userRepos.response, baseLog);
      if (corrupted) {
        return corrupted;
      }
    }
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
    if (!multi) {
      return violation("settings-file fetch (contents) is not implemented in single-repo mode");
    }
    if (request.method !== "GET") {
      return violation(`contents fetch must be GET, got ${request.method}`);
    }
    if (request.headers.get("accept") !== RAW_CONTENTS_ACCEPT) {
      return violation(
        `contents fetch must send Accept: ${RAW_CONTENTS_ACCEPT}, got "${request.headers.get("accept") ?? ""}"`,
      );
    }
    // Resolve the target BEFORE the fault hook, the same order the section
    // barrier and the issue-report routes use: a request addressing an unknown
    // slug keeps its plain not-found answer and must never consume (steal) a
    // fault injected for the legitimate target. For a KNOWN target the fault
    // fires before the permission gate (a wire failure happens regardless of
    // permissions), and always after the mode/method/Accept violations above,
    // which stay unmaskable.
    const knownTarget = multi.repos.has(cSlug);
    if (knownTarget) {
      const contentsFault = takeCoreFault("core.contentsGet");
      if (contentsFault) {
        return contentsFault;
      }
    }
    const mask = effectiveMask(scenario.token_permissions ?? {}, multi.permissions.get(cSlug));
    const grading = gradeResource(mask, "contents", "read");
    if (!grading.allowed) {
      const response = denialResponse(scenario.denial_style, "read");
      return { response, log: { ...baseLog, status: response.status, deniedBy: grading.deniedBy } };
    }
    const response = contentsResponse(multi, cSlug);
    if (knownTarget) {
      const corrupted = takeCorruption("core.contentsGet", options, response, baseLog);
      if (corrupted) {
        return corrupted;
      }
    }
    // The raw settings-file body skips response-body validation, but that is
    // decided by the request's raw Accept media type in server.ts (so every
    // raw endpoint inherits it), not marked here per-endpoint.
    return { response, log: { ...baseLog, status: response.status } };
  }

  // 3b2. Private-report issue channel (GET /user, the issues list/create/patch).
  // Served inline, before section matching, because report delivery is
  // infrastructure that writes even in check mode - so it must NOT pass through
  // the check-mode write barrier below. Gated on the Issues permission. The
  // handler consults the core-route fault hook per route; a handler response
  // comes back tagged with its core key so the chaos hook can corrupt it.
  const issueReport = handleIssueReport(
    request.method,
    pathname,
    request.query,
    request.body,
    scenario,
    multi,
    singleState,
    options.faults,
    takeCoreFault,
  );
  if (issueReport) {
    if (issueReport.faulted) {
      return issueReport.faulted;
    }
    if (issueReport.coreKey) {
      const corrupted = takeCorruption(issueReport.coreKey, options, issueReport.response, baseLog);
      if (corrupted) {
        return corrupted;
      }
    }
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

  // 3b3. GraphQL operations: one path, dispatched by operationName, served
  // BEFORE REST endpoint matching (no path template can claim /graphql).
  if (pathname === "/graphql") {
    return handleGraphqlRequest({ method: request.method, body: request.body }, options, baseLog);
  }

  // 3c. Section endpoints.
  const matched = matchEndpoint(request.method, pathname);
  if (!matched) {
    return violation(`no route in routes.ts for ${request.method} ${pathname}`);
  }
  const { key, endpoint } = matched;

  // Check-mode barrier: no writes may leave the client in check mode. This runs
  // BEFORE the fault barrier so a faulted write in check mode is still caught as
  // a violation - the engine must never send a write in check mode, which is
  // the exact case this barrier exists to catch, and a synthetic fault must not
  // mask it. The flag is the scenario's mode ORed with the server's one-way
  // override, so a convergence re-run against the same server arms it too.
  if (options.checkMode && request.method !== "GET") {
    return violation(`write in check mode: ${request.method} ${pathname} (endpoint "${key}")`);
  }
  // Its sibling for a read a plan may issue only while executing: check mode
  // runs no thunk, so one arriving here means a plan() body called it.
  if (options.checkMode && endpoint.phase === "execution") {
    return violation(`execution-phase read in check mode: GET ${pathname} (endpoint "${key}")`);
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
  let state: MockState;
  let mask: PermissionMask = scenario.token_permissions ?? {};
  // The target slug for keying the per-target denied-read barrier ("" in
  // single-repo mode). Set inside the multi arm below.
  let targetSlug = "";
  switch (working.mode) {
    case "single": {
      state = working.state;
      break;
    }
    case "multi": {
      const repoScoped = endpointPath(endpoint.route).startsWith("/repos/");
      const slug = slugFromPath(pathname);
      const repoState = slug ? working.multi.repos.get(slug) : undefined;
      if (repoScoped) {
        if (!slug || !repoState) {
          return violation(
            `multi-repo request ${request.method} ${pathname} names no known target slug`,
          );
        }
        state = repoState;
        mask = effectiveMask(scenario.token_permissions ?? {}, working.multi.permissions.get(slug));
        targetSlug = slug;
      } else {
        // Org endpoint. A team-repo route carries a {owner}/{repo} tail: it MUST
        // resolve to that slug's state, so an unknown slug is the same violation
        // the repo-scoped branch raises (falling back to orgState would let a
        // buggy write silently mutate shared org state). Only the BARE org probe
        // (no slug in the path, e.g. GET /orgs/{org}) uses orgState.
        if (slug && !repoState) {
          return violation(
            `multi-repo request ${request.method} ${pathname} names no known target slug`,
          );
        }
        state = repoState ?? working.multi.orgState;
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
            ...effectiveMask(global, working.multi.permissions.get(slug)),
            org_members: global.org_members,
          };
        } else {
          mask = global;
        }
      }
      break;
    }
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
  const taken = takeFault(key, options);
  if (taken) {
    // A faulted probe attempt counts toward its retry budget so the exemption
    // cannot outlast the probe's own retries (an all-faulting probe gives up,
    // and the next repository.get is a section read that must arm).
    if (key === "repository.get") {
      options.probeGetFaults.set(targetSlug, (options.probeGetFaults.get(targetSlug) ?? 0) + 1);
    }
    return applyFault(taken.kind, { ...baseLog }, taken.fired);
  }

  // Past the fault barrier a real response WILL be delivered. Decide whether this
  // repository.get is the probe (against the pre-delivery state), THEN record the
  // delivery so any later repository.get for the slug is a section read.
  const isVisibilityProbe =
    key === "repository.get" &&
    probeExpected(targetSlug, scenario, multi) &&
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
    // 5. Denial barrier (denialBarrier, shared with GraphQL): a denied write is a violation only
    // after a fatal denied READ in the same target+section, where the section loop aborts. A read
    // arms only when the engine sees it fail: tolerated statuses, the visibility probe, and advisory reads do not.
    const arms =
      requirement.kind === "read" &&
      !isVisibilityProbe &&
      endpoint.advisory !== true &&
      !toleratedStatuses(endpoint).includes(response.status);
    const barrierViolation = denialBarrier(
      options,
      baseLog,
      endpoint.section,
      targetSlug,
      requirement.kind,
      arms,
    );
    return { response, log, violation: barrierViolation };
  }

  // 7. Handler runs.
  const handler = HANDLERS[key];
  if (!handler) {
    // assertHandlerCompleteness runs at construction, so this is unreachable;
    // keep it a loud violation rather than a silent undefined call.
    return violation(`no handler registered for matched endpoint "${key}"`);
  }
  const response = handler({
    state,
    endpoint,
    param: paramAccessor(key, endpoint, matched.params),
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
    return violation(
      `handler "${key}" returned status ${response.status}, which is neither declared [${[...declaredStatuses(key)].join(", ")}] nor a >= 400 error`,
    );
  }

  // 9. Chaos hook: corrupt the response of the named endpoint for its first
  // `times` matches ("always" = every match). Default 1 preserves the one-shot
  // behavior octokit's retry plugin transparently recovers from.
  const corrupted = takeCorruption(key, options, response, baseLog);
  if (corrupted) {
    return corrupted;
  }

  return {
    response,
    log: {
      ...baseLog,
      status: response.status,
      ...(response.requestOffSpec ? { requestOffSpec: true } : {}),
    },
  };
}
