import { describe, expect, test } from "bun:test";
import { validateSectionShapes } from "../../../src/engine/validate.js";
import type { GithubClient } from "../../../src/github/api.js";
import { driftOf, type PlannedOp, planContext } from "../../../src/sections/contract/plan.js";
import { MockApi } from "../../../test/mock-api.js";
import { provePlanIdempotent } from "../../../test/sections/plan-idempotence.js";
import { REPO } from "../../../test/sections/section-run.js";
import { PermissionDenied } from "../contract/errors.js";
import { grantFor } from "../contract/permissions.js";
import { actionsSection, endpointRouted } from "./index.js";
// The casts on some plan() inputs below simulate keys GitHub adds: the
// shape passes unknown keys through verbatim, which the static config type
// cannot spell without giving up typo-checking on the known keys.
import type { ActionsConfig } from "./schema.js";

/** The verdict's error prose, or null when the document validated. */
function shapeError(doc: Record<string, unknown>, sourceLabel: string): string | null {
  const verdict = validateSectionShapes(doc, sourceLabel);
  return "error" in verdict ? verdict.error : null;
}

const BASE = "/repos/o/r/actions/permissions";
const PERMISSIONS = `GET ${BASE}`;
const SELECTED = `GET ${BASE}/selected-actions`;
const WORKFLOW = `GET ${BASE}/workflow`;
const ACCESS = `GET ${BASE}/access`;
const RETENTION = `GET ${BASE}/artifact-and-log-retention`;
const CACHE_RETENTION = "GET /repos/o/r/actions/cache/retention-limit";
const CACHE_STORAGE = "GET /repos/o/r/actions/cache/storage-limit";
const OIDC = "GET /repos/o/r/actions/oidc/customization/sub";
const FORK_APPROVAL = `GET ${BASE}/fork-pr-contributor-approval`;
const FORK_PRIVATE = `GET ${BASE}/fork-pr-workflows-private-repos`;

/**
 * A stateful fake of the Actions settings API: each GET serves the body its
 * PUT last stored, and the selected-actions GET answers 409 while the stored
 * policy is not "selected", as GitHub does.
 */
function liveActions(seed: Record<string, unknown>): GithubClient & { writes: string[] } {
  const stored = new Map(Object.entries(seed));
  return {
    writes: [],
    async tryRequest(method, path, payload) {
      if (method === "GET") {
        if (path === `${BASE}/selected-actions`) {
          const policy = (stored.get(BASE) as { allowed_actions?: string } | undefined)
            ?.allowed_actions;
          if (policy !== "selected") {
            return { error: { status: 409, message: "Conflict", body: "" } };
          }
        }
        const body = stored.get(path);
        return body === undefined
          ? { error: { status: 404, message: "Not Found", body: "" } }
          : { data: body };
      }
      this.writes.push(`${method} ${path}`);
      stored.set(path, payload);
      return { data: null };
    },
    async tryGraphql() {
      throw new Error("the actions section issues no GraphQL");
    },
  };
}

describe("actions", () => {
  const plan = (api: MockApi, desired: Parameters<typeof actionsSection.plan>[1]) =>
    actionsSection.plan(planContext(actionsSection, api, REPO), desired);
  const roles = (api: MockApi) => api.calls.map((c) => `${c.method} ${c.path}`);

  test("routes every divergent key to its own PUT: base, workflow, then the routed table", async () => {
    const api = new MockApi({
      [PERMISSIONS]: { data: { enabled: true, allowed_actions: "all" } },
      [SELECTED]: { error: { status: 409, message: "Conflict", body: "" } },
      [WORKFLOW]: { data: { default_workflow_permissions: "write" } },
      [ACCESS]: { data: { access_level: "none" } },
    });
    const result = await plan(api, {
      enabled: true,
      allowed_actions: "selected",
      selected_actions: { github_owned_allowed: true },
      default_workflow_permissions: "read",
      access_level: "organization",
    });
    expect(result).toEqual({
      ops: [
        {
          role: "putPermissions",
          payload: { enabled: true, allowed_actions: "selected" },
          drift: ['actions.permissions.allowed_actions: "selected" != "all"'],
          change: "applied actions permissions",
        },
        {
          role: "putWorkflow",
          payload: { default_workflow_permissions: "read" },
          drift: ['actions.workflow.default_workflow_permissions: "read" != "write"'],
          change: "applied workflow token permissions",
        },
        {
          role: "putSelected",
          payload: { github_owned_allowed: true },
          drift: [
            'actions.selected: no selected-actions allowlist is readable (the live allowed_actions policy is not "selected", or no allowlist has been set); apply will set the declared allowlist',
          ],
          change: "applied selected-actions policy",
        },
        {
          role: "putAccess",
          payload: { access_level: "organization" },
          describe: undefined,
          drift: ['actions.access.access_level: "organization" != "none"'],
          change: "applied workflows access level",
        },
      ],
      notes: [],
      drift: [],
    });
    // Planning reads each declared key's own endpoint and never writes.
    expect(roles(api)).toEqual([PERMISSIONS, WORKFLOW, SELECTED, ACCESS]);
  });

  test("a selected policy already live with no allowlist plans only the allowlist PUT", async () => {
    // The base permissions match, so no policy PUT is due; the allowlist GET
    // still 404s (none exists yet) and only putSelected is planned - which
    // is exactly what its drift line promises.
    const api = new MockApi({
      [PERMISSIONS]: { data: { enabled: true, allowed_actions: "selected" } },
    });
    const result = await plan(api, { selected_actions: { github_owned_allowed: true } });
    expect(result.ops.map((op) => [op.role, op.drift])).toEqual([
      [
        "putSelected",
        [
          'actions.selected: no selected-actions allowlist is readable (the live allowed_actions policy is not "selected", or no allowlist has been set); apply will set the declared allowlist',
        ],
      ],
    ]);
  });

  test("a matching live state plans nothing", async () => {
    const api = new MockApi({
      [PERMISSIONS]: { data: { enabled: true, allowed_actions: "all" } },
      [ACCESS]: { data: { access_level: "organization" } },
    });
    const result = await plan(api, { allowed_actions: "all", access_level: "organization" });
    expect(result).toEqual({ ops: [], notes: [], drift: [] });
  });

  test("any base-permissions key implies enabled: true in the PUT body", async () => {
    const api = new MockApi({ [PERMISSIONS]: { data: {} } });
    const result = await plan(api, { allowed_actions: "all" });
    expect(result.ops[0]?.payload).toEqual({ allowed_actions: "all", enabled: true });
    const added = await plan(api, { some_added_key: "x" } as ActionsConfig);
    expect(added.ops[0]?.payload).toEqual({ some_added_key: "x", enabled: true });
  });

  test("the unrecognized-key note reports the enabled value in both modes' terms", async () => {
    const api = new MockApi({ [PERMISSIONS]: { data: { enabled: true } } });
    const result = await plan(api, { some_added_key: "x" } as ActionsConfig);
    expect(result.notes).toEqual([
      "key(s) [some_added_key] are not recognized by this action; they ride verbatim in PUT " +
        "/actions/permissions (a body that also sets enabled: true), where GitHub may ignore " +
        'them - a "no such field" drift line for a key means GitHub does not return it, so it ' +
        "can never be proven to have taken and apply would re-send the body on every run; remove " +
        "it from the actions section of the settings file",
    ]);
    expect(result.ops.flatMap(driftOf)).toEqual([
      'actions.permissions.some_added_key: declared "x" but the API response has no such field (new or write-only field?)',
    ]);
    const off = await plan(api, { enabled: false, some_added_key: "x" } as ActionsConfig);
    expect(off.notes[0]).toContain("enabled: false");
  });

  test("selected_actions implies allowed_actions: selected; a contradiction fails upfront shape validation", async () => {
    const api = new MockApi({
      [PERMISSIONS]: { data: { enabled: true, allowed_actions: "all" } },
      [SELECTED]: { error: { status: 409, message: "Conflict", body: "" } },
    });
    const result = await plan(api, { selected_actions: { github_owned_allowed: true } });
    expect(result.ops[0]?.payload).toEqual({ allowed_actions: "selected", enabled: true });
    // The contradiction is a shape rejection (both modes, before any section
    // writes), not a plan()-time throw.
    const error = shapeError(
      { actions: { allowed_actions: "all", selected_actions: { github_owned_allowed: true } } },
      "f.yml",
    );
    expect(error).toContain("actions.selected_actions");
    expect(error).toContain('an allowlist only applies under allowed_actions: "selected"');
    // The valid pairing and the inferred form both pass validation.
    expect(
      shapeError(
        {
          actions: {
            allowed_actions: "selected",
            selected_actions: { github_owned_allowed: true },
          },
        },
        "f.yml",
      ),
    ).toBeNull();
    expect(
      shapeError({ actions: { selected_actions: { github_owned_allowed: true } } }, "f.yml"),
    ).toBeNull();
  });

  test("retention and cache route to their endpoints, never the base PUT", async () => {
    const api = new MockApi({
      [RETENTION]: { data: { days: 90 } },
      [CACHE_RETENTION]: { data: { max_cache_retention_days: 7 } },
      [CACHE_STORAGE]: { data: { max_cache_size_gb: 10 } },
    });
    const result = await plan(api, {
      artifact_and_log_retention: { days: 30 },
      cache: { max_cache_retention_days: 3, max_cache_size_gb: 25 },
    });
    // Deterministic: one table pass, so retention precedes both cache PUTs
    // and the two cache limits go in CACHE_ENDPOINT_BY_KEY order.
    expect(result.ops).toEqual([
      {
        role: "putRetention",
        payload: { days: 30 },
        describe: "setting the artifact and log retention window",
        drift: ["actions.artifact_and_log_retention.days: 30 != 90"],
        change: "applied artifact and log retention",
      },
      {
        role: "putCacheRetention",
        payload: { max_cache_retention_days: 3 },
        describe: "setting the cache retention limit",
        drift: ["actions.cache.max_cache_retention_days: 3 != 7"],
        change: "applied cache retention limit",
      },
      {
        role: "putCacheStorage",
        payload: { max_cache_size_gb: 25 },
        describe: "setting the cache storage limit",
        drift: ["actions.cache.max_cache_size_gb: 25 != 10"],
        change: "applied cache storage limit",
      },
    ]);
    // No base-permissions read or PUT: these keys alone must not imply enabled: true.
    expect(roles(api)).toEqual([RETENTION, CACHE_RETENTION, CACHE_STORAGE]);
    expect(result.notes).toEqual([]);
  });

  test("a lone cache key touches only its own endpoint", async () => {
    const api = new MockApi({ [CACHE_STORAGE]: { data: { max_cache_size_gb: 10 } } });
    const result = await plan(api, { cache: { max_cache_size_gb: 25 } });
    expect(result.ops.map((op) => op.role)).toEqual(["putCacheStorage"]);
    expect(roles(api)).toEqual([CACHE_STORAGE]);
  });

  test("the shape rejects unrecognized, null, and scalar cache declarations upfront", () => {
    // Inherited names like "constructor" must be caught too: an `in`-based
    // check would walk the prototype chain and let them silently no-op. An
    // own "__proto__" key (JSON.parse creates one) is unrecognized as well.
    for (const cache of [
      { max_cache_size: 25 },
      { constructor: 5 },
      JSON.parse('{"__proto__": 5}'),
      null,
      5,
    ]) {
      const parsed = actionsSection.shape.safeParse({ cache });
      expect(parsed.success).toBe(false);
    }
    expect(
      actionsSection.shape.safeParse({
        cache: { max_cache_retention_days: 3, max_cache_size_gb: 25 },
        some_added_key: "passes through",
      }).success,
    ).toBe(true);
  });

  test("the OIDC template is planned verbatim to its own endpoint on any divergence", async () => {
    const api = new MockApi({ [OIDC]: { data: { use_default: true } } });
    const declared = { use_default: false, include_claim_keys: ["repo", "context"] };
    const result = await plan(api, { oidc_customization_sub: declared });
    expect(result.ops).toEqual([
      {
        role: "putOidcSub",
        payload: declared,
        describe: "customizing the OIDC subject claim",
        drift: [
          "actions.oidc_customization_sub.use_default: false != true",
          'actions.oidc_customization_sub.include_claim_keys: declared ["repo","context"] != live [] (claim-key order defines the subject format, so order counts); apply will set the declared value',
        ],
        change: "applied the OIDC subject claim template",
      },
    ]);
  });

  test("include_claim_keys compares positionally: a reordered live value is drift", async () => {
    const reordered = new MockApi({
      [OIDC]: { data: { use_default: false, include_claim_keys: ["context", "repo"] } },
    });
    const result = await plan(reordered, {
      oidc_customization_sub: { use_default: false, include_claim_keys: ["repo", "context"] },
    });
    expect(result.ops).toHaveLength(1);
    expect(result.ops[0]?.drift).toEqual([
      'actions.oidc_customization_sub.include_claim_keys: declared ["repo","context"] != live ["context","repo"] (claim-key order defines the subject format, so order counts); apply will set the declared value',
    ]);
    const matching = new MockApi({
      [OIDC]: { data: { use_default: false, include_claim_keys: ["repo", "context"] } },
    });
    const clean = await plan(matching, {
      oidc_customization_sub: { use_default: false, include_claim_keys: ["repo", "context"] },
    });
    expect(clean.ops).toEqual([]);
  });

  test("an omitted claim-key list on a custom template, and any list on the default one, are not compared", async () => {
    // {use_default: false} with no list is the documented opt-in to the
    // ORGANIZATION template, whose keys then appear live; comparing the
    // omitted list against them would be permanent false drift. And GitHub
    // ignores include_claim_keys under use_default: true.
    const custom = new MockApi({
      [OIDC]: { data: { use_default: false, include_claim_keys: ["repo", "context"] } },
    });
    expect((await plan(custom, { oidc_customization_sub: { use_default: false } })).ops).toEqual(
      [],
    );
    const standard = new MockApi({
      [OIDC]: { data: { use_default: true, include_claim_keys: ["job_workflow_ref"] } },
    });
    expect(
      (
        await plan(standard, {
          oidc_customization_sub: { use_default: true, include_claim_keys: ["repo"] },
        })
      ).ops,
    ).toEqual([]);
  });

  test("a declared use_immutable_subject rides the remainder diff", async () => {
    // The flag flips the whole subject format, so a declared false against
    // a live true must drift; undeclared, the inherited org/date default
    // stays uncompared like every other undeclared key.
    const api = new MockApi({
      [OIDC]: {
        data: { use_default: false, include_claim_keys: ["repo"], use_immutable_subject: true },
      },
    });
    const result = await plan(api, {
      oidc_customization_sub: {
        use_default: false,
        include_claim_keys: ["repo"],
        use_immutable_subject: false,
      },
    });
    expect(result.ops[0]?.drift).toEqual([
      "actions.oidc_customization_sub.use_immutable_subject: false != true",
    ]);
  });

  test("the oidc shape rejects quoted booleans upfront", () => {
    // A YAML '"false"' is truthy on the wire; both boolean fields must
    // fail validation before any section writes.
    for (const bad of [
      { use_default: "false" },
      { use_default: true, use_immutable_subject: "false" },
    ]) {
      expect(actionsSection.shape.safeParse({ oidc_customization_sub: bad }).success).toBe(false);
    }
  });

  test("a denied fork-pr-private read renders the ambiguity denialHint", async () => {
    // If GitHub denies this pair on a public repository, this one sentence
    // is the whole mitigation - and the mechanism (denialHint on the
    // permission branch) has silently broken once before, so pin that a
    // denial actually renders it.
    const api = new MockApi({
      [FORK_PRIVATE]: { error: { status: 403, message: "Forbidden", body: "" } },
    });
    let thrown: unknown;
    try {
      await plan(api, {
        fork_pr_workflows_private_repos: {
          run_workflows_from_fork_pull_requests: true,
          send_write_tokens_to_workflows: false,
          send_secrets_and_variables: false,
          require_approval_for_fork_pr_workflows: true,
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PermissionDenied);
    expect((thrown as PermissionDenied).detail).toContain("can also mean the repository is public");
  });

  test("a denied OIDC read renders the Actions grant, not the section's Administration", async () => {
    const api = new MockApi({
      [OIDC]: { error: { status: 403, message: "Resource not accessible", body: "" } },
    });
    let thrown: unknown;
    try {
      await plan(api, { oidc_customization_sub: { use_default: true } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PermissionDenied);
    const denied = thrown as PermissionDenied;
    // The failing call is a GET, but the advice grades by the SECTION's need
    // on the override permission: the OIDC PUT sibling writes with the same
    // Actions permission, so read-only advice would cost a second round trip
    // (grant read, pass preflight, fail on the write).
    expect(denied.detail).toContain(grantFor({ repo: ["actions"] }));
    expect(denied.detail).not.toContain('"Administration"');
  });

  test("each fork PR policy object is planned verbatim to its own endpoint, every toggle compared", async () => {
    const api = new MockApi({
      [FORK_APPROVAL]: { data: { approval_policy: "first_time_contributors_new_to_github" } },
      [FORK_PRIVATE]: {
        data: {
          run_workflows_from_fork_pull_requests: false,
          send_write_tokens_to_workflows: true,
          send_secrets_and_variables: true,
          require_approval_for_fork_pr_workflows: false,
        },
      },
    });
    const approval = { approval_policy: "first_time_contributors" };
    const privateRepos = {
      run_workflows_from_fork_pull_requests: true,
      send_write_tokens_to_workflows: false,
      send_secrets_and_variables: false,
      require_approval_for_fork_pr_workflows: true,
      extra_field: "rides along",
    };
    const result = await plan(api, {
      fork_pr_contributor_approval: approval,
      fork_pr_workflows_private_repos: privateRepos,
    });
    // Deterministic: both keys sit in the routed table, visited in its order.
    expect(result.ops.map((op) => [op.role, op.payload, op.change])).toEqual([
      ["putForkPrApproval", approval, "applied the fork PR contributor approval policy"],
      ["putForkPrPrivate", privateRepos, "applied the private-repo fork PR workflow settings"],
    ]);
    // The shape requires all four toggles and every one is compared: with
    // every live value flipped, all four must drift - an omitted comparison
    // cannot pass here; the passthrough field drifts as unknown to GitHub.
    expect(result.ops[1]?.drift).toEqual([
      "actions.fork_pr_workflows_private_repos.run_workflows_from_fork_pull_requests: true != false",
      "actions.fork_pr_workflows_private_repos.send_write_tokens_to_workflows: false != true",
      "actions.fork_pr_workflows_private_repos.send_secrets_and_variables: false != true",
      "actions.fork_pr_workflows_private_repos.require_approval_for_fork_pr_workflows: true != false",
      'actions.fork_pr_workflows_private_repos.extra_field: declared "rides along" but the API response has no such field (new or write-only field?)',
    ]);
    // No base-permissions read: these keys alone must not imply enabled: true.
    expect(roles(api)).toEqual([FORK_APPROVAL, FORK_PRIVATE]);
    expect(result.notes).toEqual([]);
  });

  test("the private-repos shape requires the complete policy and stays loose otherwise", () => {
    // GitHub does not document whether an omitted toggle is preserved or
    // reset by the PUT, so the shape demands all four booleans (a YAML-quoted
    // "true" included) before any section writes.
    for (const bad of [
      { send_secrets_and_variables: false },
      {
        run_workflows_from_fork_pull_requests: "true",
        send_write_tokens_to_workflows: false,
        send_secrets_and_variables: false,
        require_approval_for_fork_pr_workflows: true,
      },
      {
        run_workflows_from_fork_pull_requests: true,
        send_write_tokens_to_workflows: false,
        send_secrets_and_variables: false,
      },
    ]) {
      expect(actionsSection.shape.safeParse({ fork_pr_workflows_private_repos: bad }).success).toBe(
        false,
      );
    }
    expect(
      actionsSection.shape.safeParse({
        fork_pr_contributor_approval: { approval_policy: "first_time_contributors" },
        fork_pr_workflows_private_repos: {
          run_workflows_from_fork_pull_requests: true,
          send_write_tokens_to_workflows: false,
          send_secrets_and_variables: false,
          require_approval_for_fork_pr_workflows: true,
          extra_field: "passes through",
        },
      }).success,
    ).toBe(true);
    // The approval object requires its policy string the same way.
    expect(actionsSection.shape.safeParse({ fork_pr_contributor_approval: {} }).success).toBe(
      false,
    );
  });

  test("executing the plan converges: every routed PUT lands once, then nothing", async () => {
    const api = liveActions({
      [BASE]: { enabled: true, allowed_actions: "all" },
      [`${BASE}/workflow`]: { default_workflow_permissions: "write" },
      [`${BASE}/access`]: { access_level: "none" },
      [`${BASE}/artifact-and-log-retention`]: { days: 90 },
      "/repos/o/r/actions/cache/storage-limit": { max_cache_size_gb: 10 },
      "/repos/o/r/actions/oidc/customization/sub": { use_default: true },
    });
    const { second, changes } = await provePlanIdempotent(actionsSection, api, {
      selected_actions: { github_owned_allowed: true, patterns_allowed: ["docker/*"] },
      default_workflow_permissions: "read",
      access_level: "organization",
      artifact_and_log_retention: { days: 30 },
      cache: { max_cache_size_gb: 25 },
      oidc_customization_sub: { use_default: false, include_claim_keys: ["repo", "context"] },
    });
    expect(changes).toEqual([
      "applied actions permissions",
      "applied workflow token permissions",
      "applied selected-actions policy",
      "applied workflows access level",
      "applied artifact and log retention",
      "applied cache storage limit",
      "applied the OIDC subject claim template",
    ]);
    expect(api.writes).toEqual([
      `PUT ${BASE}`,
      `PUT ${BASE}/workflow`,
      `PUT ${BASE}/selected-actions`,
      `PUT ${BASE}/access`,
      `PUT ${BASE}/artifact-and-log-retention`,
      "PUT /repos/o/r/actions/cache/storage-limit",
      "PUT /repos/o/r/actions/oidc/customization/sub",
    ]);
    expect(second).toEqual({ ops: [], notes: [], drift: [] });
  });

  test("the read port exposes exactly the GET roles; the primary read keeps its denied posture", () => {
    const ctx = planContext(actionsSection, new MockApi({}), REPO);
    expect(Object.keys(ctx.read)).toEqual([
      "getPermissions",
      "getSelected",
      "getWorkflow",
      "getAccess",
      "getRetention",
      "getCacheRetention",
      "getCacheStorage",
      "getOidcSub",
      "getForkPrApproval",
      "getForkPrPrivate",
    ]);
    // @ts-expect-error a write role is not a read: the port has no `putPermissions`
    ctx.read.putPermissions;
    // @ts-expect-error nor a `putSelected`
    ctx.read.putSelected;
    // @ts-expect-error nor the raw client
    ctx.api;
    // @ts-expect-error a "denied" primary read offers no 404-tolerant helper
    ctx.read.getPermissions.probeAbsent;
    // The allowlist probe keeps every helper: its 404/409 mean "no allowlist".
    expect(typeof ctx.read.getSelected.probeAbsent).toBe("function");
  });

  test("a routed key's endpoint pair must share a name, and a scalar key must say how it becomes a body", () => {
    // Compile-time only: the table wiring is checked at the call, so a GET
    // paired with another key's PUT, or an enum-valued key PUT bare, never
    // reaches the routing table.
    const paired: ReturnType<typeof endpointRouted<"access_level", "Access">> = endpointRouted<
      "access_level",
      "Access"
    >({
      get: "getAccess",
      put: "putAccess",
      label: "actions.access",
      applied: "applied",
      body: (value) => ({ access_level: value }),
    });
    expect(typeof paired.plan).toBe("function");
    endpointRouted<"access_level", "Access">({
      get: "getAccess",
      // @ts-expect-error the PUT must carry the GET's name
      put: "putRetention",
      label: "actions.access",
      applied: "applied",
      body: (value) => ({ access_level: value }),
    });
    // @ts-expect-error an enum-valued key cannot be PUT bare: body is required
    endpointRouted<"access_level", "Access">({
      get: "getAccess",
      put: "putAccess",
      label: "actions.access",
      applied: "applied",
    });
  });

  test("a planned operation can only name a declared write role, and must justify itself", () => {
    type Op = PlannedOp<typeof actionsSection.endpoints>;
    const read = { role: "getPermissions", drift: ["x"], change: "" } as const;
    // @ts-expect-error a GET role is a read, not a plannable write
    const _read: Op = read;
    const silent = { role: "putPermissions", drift: [], change: "" } as const;
    // @ts-expect-error a write on a non-alwaysRewrite endpoint must carry drift
    const _silent: Op = silent;
  });
});
