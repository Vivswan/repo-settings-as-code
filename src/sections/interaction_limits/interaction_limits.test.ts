import { describe, expect, test } from "bun:test";
import { executePlan } from "../../../src/engine/execute.js";
import type { GithubClient } from "../../../src/github/api.js";
import { type PlannedOp, planContext } from "../../../src/sections/contract/plan.js";
import { MockApi } from "../../../test/mock-api.js";
import { provePlanIdempotent } from "../../../test/sections/plan-idempotence.js";
import { REPO } from "../../../test/sections/section-run.js";
import { PermissionDenied } from "../contract/errors.js";
import { grantFor } from "../contract/permissions.js";
import { interactionLimitsSection } from "./index.js";
import type { InteractionLimitsConfig } from "./schema.js";

const BASE = "/repos/o/r/interaction-limits";
const GET = `GET ${BASE}`;
const CAP_GET = `GET ${BASE}/pulls/creation-cap`;
const BYPASS_GET = `GET ${BASE}/pulls/bypass-list`;
const LIVE = { limit: "existing_users", origin: "repository", expires_at: "2026-01-02T00:00:00Z" };
const CAP_LIVE = { enabled: false, max_open_pull_requests: 1 };
const CAP_405 = { error: { status: 405, message: "Method Not Allowed", body: "" } } as const;
const CONFLICT = { error: { status: 409, message: "Conflict", body: "" } } as const;
const TOOLS = { resolveSecret: () => "" };

type Desired = Parameters<typeof interactionLimitsSection.plan>[1];

const plan = (api: GithubClient, desired: Desired) =>
  interactionLimitsSection.plan(planContext(interactionLimitsSection, api, REPO), desired);

/** Plan against `api`, then execute the plan against it: what apply would do. */
async function apply(api: GithubClient, desired: Desired) {
  return executePlan(await plan(api, desired), interactionLimitsSection, api, REPO, TOOLS);
}

/**
 * A stateful fake of the interaction-limits API: the base PUT stores a
 * repository-origin limit with a fixed expires_at (a byte-stable re-arm),
 * the cap PATCH merges, and the bypass PUT/DELETE reconcile the login list.
 */
function liveRepo(seed: {
  limit?: Record<string, unknown> | null;
  cap?: Record<string, unknown>;
  bypass?: string[];
}): GithubClient & { writes: string[] } {
  let limit = seed.limit ?? null;
  let cap = seed.cap ?? CAP_LIVE;
  let bypass = seed.bypass ?? [];
  return {
    writes: [],
    async tryRequest(method, path, payload) {
      const body = payload as Record<string, unknown>;
      if (method !== "GET") {
        this.writes.push(`${method} ${path}`);
      }
      switch (`${method} ${path}`) {
        case GET:
          return { data: limit ?? {} };
        case `PUT ${BASE}`:
          limit = { limit: body.limit, origin: "repository", expires_at: "2027-01-01T00:00:00Z" };
          return { data: limit };
        case `DELETE ${BASE}`:
          limit = null;
          return { data: null };
        case CAP_GET:
          return { data: cap };
        case `PATCH ${BASE}/pulls/creation-cap`:
          cap = { ...cap, ...body };
          return { data: cap };
        case BYPASS_GET:
          return { data: bypass.map((login) => ({ login })) };
        case `PUT ${BASE}/pulls/bypass-list`:
          bypass = [...bypass, ...(body.users as string[])];
          return { data: null };
        case `DELETE ${BASE}/pulls/bypass-list`:
          bypass = bypass.filter((login) => !(body.users as string[]).includes(login));
          return { data: null };
        default:
          return { error: { status: 404, message: "Not Found", body: "" } };
      }
    },
    async tryGraphql() {
      throw new Error("the interaction_limits section issues no GraphQL");
    },
  };
}

describe("interaction_limits", () => {
  test("no live limit (never set, or expired) is drift the re-arm resolves", async () => {
    const api = new MockApi({ [GET]: { data: {} } });
    const result = await plan(api, { limit: "contributors_only", expiry: "one_week" });
    expect(result.ops.map((op) => [op.role, op.payload, op.drift, op.change])).toEqual([
      [
        "put",
        { limit: "contributors_only", expiry: "one_week" },
        [
          'interaction_limits: no live limit (never set, or it expired); apply will (re-)arm the declared "contributors_only" limit',
        ],
        'armed the "contributors_only" interaction limit (expiry: one_week)',
      ],
    ]);
    // The declared expiry produces the cannot-verify note.
    expect(result.notes).toEqual([
      "interaction_limits.expiry: GitHub reports only the computed expires_at, so the declared duration cannot be verified; apply re-arms it on every run",
    ]);
    expect(api.mutations()).toEqual([]);
  });

  test("the limit value is diffed but never the write-only expiry; a match still re-arms driftlessly", async () => {
    const api = new MockApi({ [GET]: { data: LIVE } });
    const drifted = await plan(api, { limit: "contributors_only", expiry: "one_week" });
    expect(drifted.ops[0]?.drift).toEqual([
      'interaction_limits.limit: "contributors_only" != "existing_users"',
    ]);
    const matching = await plan(api, { limit: "existing_users" });
    // alwaysRewrite by declaration: the op stands with no drift to report,
    // so check reads clean while apply re-arms the ticking limit.
    expect(matching.ops.map((op) => [op.role, op.drift, op.change])).toEqual([
      [
        "put",
        [],
        'armed the "existing_users" interaction limit (expiry: one_day (GitHub default))',
      ],
    ]);
    expect(matching.notes).toEqual([]);
  });

  test("an org-origin live limit adds the cannot-change note; declared != org-set stays drift", async () => {
    const api = new MockApi({ [GET]: { data: { ...LIVE, origin: "organization" } } });
    const result = await plan(api, { limit: "collaborators_only" });
    expect(result.ops[0]?.drift).toEqual([
      'interaction_limits.limit: "collaborators_only" != "existing_users"',
    ]);
    expect(result.notes).toEqual([
      "interaction_limits: an organization- or user-level interaction limit overrides this repository's (origin: organization); apply cannot change it from the repository",
    ]);
  });

  test("declared null: nothing when live is empty, the DELETE when a limit is live, cannot-remove prose when inherited", async () => {
    expect(await plan(new MockApi({ [GET]: { data: {} } }), null)).toEqual({
      ops: [],
      notes: [],
      drift: [],
    });
    const repo = await plan(new MockApi({ [GET]: { data: LIVE } }), null);
    expect(repo.ops.map((op) => [op.role, op.drift, op.change])).toEqual([
      [
        "remove",
        [
          'interaction_limits: declared null but a live "existing_users" limit is set; apply will remove it',
        ],
        "cleared the interaction limit",
      ],
    ]);
    const inherited = await plan(
      new MockApi({ [GET]: { data: { ...LIVE, origin: "organization" } } }),
      null,
    );
    expect(inherited.ops[0]?.drift).toEqual([
      'interaction_limits: declared null but a live "existing_users" limit is set at the organization level; apply cannot remove it from the repository',
    ]);
  });

  test("a 409 on the PUT or the DELETE becomes a note, not a failure, and the plan goes on", async () => {
    const armed = new MockApi({
      [GET]: { data: {} },
      [`PUT ${BASE}`]: CONFLICT,
      [CAP_GET]: { data: CAP_LIVE },
    }).allowMutations(`PATCH ${BASE}/pulls/creation-cap`);
    const execution = await apply(armed, {
      limit: "existing_users",
      pull_request_creation_cap: { enabled: true },
    });
    expect(execution).toEqual({
      status: "applied",
      changes: ["set the pull request creation cap (enabled: true)"],
      notes: [
        "interaction_limits: an organization- or user-level interaction limit overrides this repository's, so the repository-level limit was not applied (409)",
      ],
      landed: 1,
    });
    const cleared = new MockApi({ [GET]: { data: LIVE }, [`DELETE ${BASE}`]: CONFLICT });
    expect(await apply(cleared, null)).toEqual({
      status: "applied",
      changes: [],
      notes: [
        "interaction_limits: an organization- or user-level interaction limit overrides this repository's, so the repository-level clear was not applied (409)",
      ],
      landed: 0,
    });
  });

  test.each([null, [], "none"])(
    "a malformed live body (%p) is a loud failure, never an absent limit",
    async (body) => {
      // An empty object is GitHub's "no limit"; anything else that is not a
      // limit object must not read as absence and plan a re-arm over it.
      const api = new MockApi({ [GET]: { data: body } });
      await expect(plan(api, { limit: "existing_users" })).rejects.toThrow(
        /interaction_limits: GET .*interaction-limits returned a body outside the documented shape/,
      );
    },
  );

  test("a denied GET classifies as PermissionDenied carrying the status and the Administration grant", async () => {
    const api = new MockApi({ [GET]: { error: { status: 404, message: "Not Found", body: "" } } });
    let thrown: unknown;
    try {
      await plan(api, { limit: "existing_users" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PermissionDenied);
    const denied = thrown as PermissionDenied;
    expect(denied.section).toBe("interaction_limits");
    expect(denied.status).toBe(404);
    expect(denied.detail).toContain(grantFor({ repo: ["administration"] }));
  });

  test("executing the plan converges: the base limit re-arms on every apply, nothing else recurs", async () => {
    const api = liveRepo({ limit: null, bypass: ["keeper", "goner"] });
    const { first, second, changes } = await provePlanIdempotent(interactionLimitsSection, api, {
      limit: "collaborators_only",
      expiry: "one_week",
      pull_request_creation_cap: { enabled: true, max_open_pull_requests: 5 },
      pull_request_creation_bypass: ["Keeper", "newcomer"],
    });
    expect(changes).toEqual([
      'armed the "collaborators_only" interaction limit (expiry: one_week)',
      "set the pull request creation cap (enabled: true, max_open_pull_requests: 5)",
      "removed [goner] from the pull request creation cap bypass list",
      "added [newcomer] to the pull request creation cap bypass list",
    ]);
    expect(first.ops.map((op) => op.role)).toEqual([
      "put",
      "capPatch",
      "bypassRemove",
      "bypassAdd",
    ]);
    expect(second.ops.map((op) => [op.role, op.drift])).toEqual([["put", []]]);
    // Two executions (the proof also runs the converged plan): the re-arm
    // each time, the cap and bypass writes once.
    expect(api.writes.filter((w) => w === `PUT ${BASE}`)).toHaveLength(2);
    expect(api.writes.filter((w) => w !== `PUT ${BASE}`)).toEqual([
      `PATCH ${BASE}/pulls/creation-cap`,
      `DELETE ${BASE}/pulls/bypass-list`,
      `PUT ${BASE}/pulls/bypass-list`,
    ]);
  });

  test("executing null converges: one DELETE, then nothing", async () => {
    const api = liveRepo({ limit: LIVE });
    const { second, changes } = await provePlanIdempotent(interactionLimitsSection, api, null);
    expect(changes).toEqual(["cleared the interaction limit"]);
    expect(api.writes).toEqual([`DELETE ${BASE}`]);
    expect(second).toEqual({ ops: [], notes: [], drift: [] });
  });

  test("the read port exposes the three GETs; the primary read keeps its denied posture", () => {
    const ctx = planContext(interactionLimitsSection, new MockApi({}), REPO);
    expect(Object.keys(ctx.read)).toEqual(["get", "capGet", "bypassList"]);
    // @ts-expect-error a write role is not a read: the port has no `put`
    ctx.read.put;
    // @ts-expect-error nor a `remove`
    ctx.read.remove;
    // @ts-expect-error nor the raw client
    ctx.api;
    // @ts-expect-error a "denied" primary read offers no 404-tolerant helper
    ctx.read.get.probeAbsent;
    // The cap read keeps tryCall: its declared 405 is a tolerated outcome.
    expect(typeof ctx.read.capGet.tryCall).toBe("function");
  });

  test("a planned operation can only name a declared write role, tolerating only declared statuses", () => {
    type Op = PlannedOp<typeof interactionLimitsSection.endpoints>;
    const read = { role: "get", drift: ["x"], change: "" } as const;
    // @ts-expect-error the get role is a read, not a plannable write
    const _read: Op = read;
    const silent = { role: "remove", drift: [], change: "" } as const;
    // @ts-expect-error the DELETE is not alwaysRewrite, so it must carry drift
    const _silent: Op = silent;
    const rearm: Op = { role: "put", drift: [], change: "re-armed" };
    expect(rearm.drift).toEqual([]);
    const undeclared = {
      role: "remove",
      drift: ["x"],
      change: "",
      tolerate: { statuses: [404], outcome: () => ({ note: "" }) },
    } as const;
    // @ts-expect-error 404 is not a declared status of the DELETE, so it cannot be tolerated
    const _undeclared: Op = undeclared;
  });
});

describe("interaction_limits pull request creation cap", () => {
  test("the declared cap is diffed exactly against the live one; only the cap GET runs", async () => {
    const api = new MockApi({ [CAP_GET]: { data: CAP_LIVE } });
    const result = await plan(api, {
      pull_request_creation_cap: { enabled: true, max_open_pull_requests: 5 },
    });
    expect(result.ops.map((op) => [op.role, op.payload, op.drift])).toEqual([
      [
        "capPatch",
        { enabled: true, max_open_pull_requests: 5 },
        [
          "interaction_limits.pull_request_creation_cap.enabled: true != false",
          "interaction_limits.pull_request_creation_cap.max_open_pull_requests: 5 != 1",
        ],
      ],
    ]);
    // No base key is declared, so the base-limit GET never runs.
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([CAP_GET]);
    const matching = await plan(api, { pull_request_creation_cap: CAP_LIVE });
    expect(matching.ops).toEqual([]);
  });

  test("a 405 (cap unavailable) is op-less drift: check reports it, apply cannot fix it", async () => {
    const api = new MockApi({ [CAP_GET]: CAP_405 });
    const result = await plan(api, { pull_request_creation_cap: { enabled: true } });
    expect(result).toEqual({
      ops: [],
      notes: [],
      drift: [
        "interaction_limits.pull_request_creation_cap: declared but the pull request creation cap is not available on this repository (405); apply cannot set it",
      ],
    });
  });

  test("a declared cap key absent from the live cap is noted as a phantom key", async () => {
    const api = new MockApi({ [CAP_GET]: { data: CAP_LIVE } });
    const result = await plan(api, {
      // The cast simulates a future/mistyped cap key riding through the
      // passthrough shape; the note under test is how plan() surfaces it.
      pull_request_creation_cap: { enabled: true, max_open_prs: 5 },
    } as InteractionLimitsConfig);
    expect(result.notes).toEqual([
      'interaction_limits.pull_request_creation_cap: declared key(s) "max_open_prs" do not ' +
        "exist on the live creation cap, so if GitHub ignores them this PATCH will re-run on " +
        "every apply without converging. Fix the key name, or remove it from the settings file",
    ]);
  });

  test("a 405 on the PATCH itself becomes a note", async () => {
    const api = new MockApi({
      [CAP_GET]: { data: CAP_LIVE },
      [`PATCH ${BASE}/pulls/creation-cap`]: CAP_405,
    });
    const execution = await apply(api, { pull_request_creation_cap: { enabled: true } });
    expect(execution).toEqual({
      status: "applied",
      changes: [],
      notes: [
        "interaction_limits.pull_request_creation_cap: the pull request creation cap is not available on this repository, so the declared cap was not applied (405)",
      ],
      landed: 0,
    });
  });
});

describe("interaction_limits pull request creation bypass list", () => {
  const liveUsers = [{ login: "keeper" }, { login: "goner" }];

  test("the undeclared logins are removed FIRST, then the missing ones added, case-insensitively", async () => {
    const api = new MockApi({ [BYPASS_GET]: { data: liveUsers } });
    const result = await plan(api, { pull_request_creation_bypass: ["Keeper", "newcomer"] });
    // Removal first: the list holds at most 100 users, so adding before
    // removing could transiently overflow it. "Keeper" matches the live
    // "keeper" case-insensitively: neither written.
    expect(result.ops).toEqual([
      {
        role: "bypassRemove",
        payload: { users: ["goner"] },
        describe: "removing users from the pull request creation cap bypass list",
        drift: [
          "interaction_limits.pull_request_creation_bypass: live login(s) [goner] are not declared; apply will remove them",
        ],
        change: "removed [goner] from the pull request creation cap bypass list",
      },
      {
        role: "bypassAdd",
        payload: { users: ["newcomer"] },
        describe: "adding users to the pull request creation cap bypass list",
        drift: [
          "interaction_limits.pull_request_creation_bypass: declared login(s) [newcomer] are not on the live bypass list; apply will add them",
        ],
        change: "added [newcomer] to the pull request creation cap bypass list",
      },
    ]);
    const matching = await plan(api, { pull_request_creation_bypass: ["KEEPER", "Goner"] });
    expect(matching.ops).toEqual([]);
  });

  test("a declared empty list removes everyone", async () => {
    const api = new MockApi({ [BYPASS_GET]: { data: liveUsers } });
    const result = await plan(api, { pull_request_creation_bypass: [] });
    expect(result.ops.map((op) => [op.role, op.payload])).toEqual([
      ["bypassRemove", { users: ["keeper", "goner"] }],
    ]);
  });

  test("null reads the base limit only and never touches the cap or bypass list", async () => {
    const api = new MockApi({ [GET]: { data: LIVE } });
    await plan(api, null);
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([GET]);
  });
});

describe("interaction_limits shape", () => {
  const shape = interactionLimitsSection.shape;

  test("an object declaring none of the three groups is rejected upfront", () => {
    const parsed = shape.safeParse({});
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("declare at least one of");
  });

  test("a base key without limit is rejected (it would ride a PUT that never fires)", () => {
    const parsed = shape.safeParse({
      expiry: "one_week",
      pull_request_creation_cap: { enabled: true },
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("requires a limit");
  });

  test("a bypass list over GitHub's 100-user cap is rejected", () => {
    const parsed = shape.safeParse({
      pull_request_creation_bypass: Array.from({ length: 101 }, (_, i) => `user-${i}`),
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("caps the bypass list at 100");
  });

  test("two case-variant spellings of one login are rejected as duplicates", () => {
    const parsed = shape.safeParse({ pull_request_creation_bypass: ["octocat", "Octocat"] });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("name the same login");
  });

  test('a YAML-quoted "true" cap flag fails with the boolean-gotcha message', () => {
    const parsed = shape.safeParse({ pull_request_creation_cap: { enabled: "true" } });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("unquoted true or false");
  });

  test("the three groups each stand alone, and null still parses", () => {
    expect(shape.safeParse({ limit: "existing_users" }).success).toBe(true);
    expect(shape.safeParse({ pull_request_creation_cap: { enabled: false } }).success).toBe(true);
    expect(shape.safeParse({ pull_request_creation_bypass: [] }).success).toBe(true);
    expect(shape.safeParse(null).success).toBe(true);
  });
});
