import { describe, expect, test } from "bun:test";
import { executePlan } from "../../../src/engine/execute.js";
import type { GithubClient } from "../../../src/github/api.js";
import { type PlannedOp, planContext } from "../../../src/sections/contract/plan.js";
import { allEndpoints, allGraphqlOps } from "../../../src/sections/registry.js";
import { buildState, type LiveState } from "../../../test/e2e/mock/state.js";
import type { Json } from "../../../test/e2e/mock/support.js";
import { MockApi } from "../../../test/mock-api.js";
import { provePlanIdempotent } from "../../../test/sections/plan-idempotence.js";
import { REPO } from "../../../test/sections/section-run.js";
import {
  endpointMethod,
  endpointPath,
  matchesTemplate,
  pathSegments,
} from "../contract/endpoints.js";
import { branchesSection } from "./index.js";
import { branchesMockGraphqlHandlers, branchesMockHandlers } from "./mock.js";

type Desired = Parameters<typeof branchesSection.plan>[1];

const plan = (api: GithubClient, desired: Desired) =>
  branchesSection.plan(planContext(branchesSection, api, REPO), desired);

/** The tools no branches plan ever needs: the section declares no secret values. */
const NO_SECRETS = {
  resolveSecret(): string {
    throw new Error("the branches section resolves no secrets");
  },
};

/** One recorded request of the stateful fake. */
interface Recorded {
  method: string;
  path: string;
  payload?: unknown;
}

/**
 * A stateful fake of the branches API served by the e2e mock's own handler
 * fragment, so a plan over executed state sees the converged repository;
 * GraphQL errors fold to the ApiError shape the real client produces.
 */
function liveRepo(live: LiveState): GithubClient & { writes: Recorded[] } {
  const state = buildState(live, "org");
  const endpoints = allEndpoints([branchesSection]);
  const graphqlOps = allGraphqlOps([branchesSection]);
  return {
    writes: [],
    async tryRequest(method, path, payload) {
      const match = Object.entries(endpoints).find(
        ([, endpoint]) =>
          endpointMethod(endpoint.route) === method &&
          matchesTemplate(endpointPath(endpoint.route), path),
      );
      if (match === undefined) {
        throw new Error(`liveRepo: no branches endpoint serves ${method} ${path}`);
      }
      const [key, endpoint] = match;
      const template = pathSegments(endpointPath(endpoint.route));
      const concrete = pathSegments(path);
      const param = (name: string): string => {
        const index = template.indexOf(`{${name}}`);
        if (index < 0) {
          throw new Error(`liveRepo: ${endpoint.route} declares no {${name}}`);
        }
        return decodeURIComponent(concrete[index] as string);
      };
      const handler = branchesMockHandlers[key as keyof typeof branchesMockHandlers];
      const response = handler({ state, endpoint, param, query: {}, body: payload });
      if (method !== "GET") {
        this.writes.push({ method, path, payload });
      }
      if (response.status >= 400) {
        const message = (response.body as { message?: unknown } | null)?.message;
        return {
          error: { status: response.status, message: String(message ?? ""), body: "" },
        };
      }
      return { data: response.body };
    },
    async tryGraphql(op, variables) {
      const match = Object.entries(graphqlOps).find(([, declared]) => declared.name === op.name);
      if (match === undefined) {
        throw new Error(`liveRepo: no branches operation is named ${op.name}`);
      }
      const [key, tagged] = match;
      const handler = branchesMockGraphqlHandlers[key as keyof typeof branchesMockGraphqlHandlers];
      const result = handler({ state, op: tagged, variables: variables as Json });
      if (op.kind === "write") {
        this.writes.push({ method: "GRAPHQL", path: op.name, payload: variables });
      }
      if (result.errors !== undefined) {
        const types = [...new Set(result.errors.map((e) => e.type))].sort();
        return {
          error: {
            status: types.includes("FORBIDDEN") ? 403 : types.includes("NOT_FOUND") ? 404 : 422,
            message: result.errors.map((e) => e.message).join("; "),
            body: JSON.stringify(result.errors),
            graphqlTypes: types,
          },
        };
      }
      return { data: result.data };
    },
  };
}

/** A rules-query response over the given nodes, MockApi-route shaped. */
function rulesData(nodes: unknown[]): { data: Record<string, unknown> } {
  return {
    data: {
      repository: {
        branchProtectionRules: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
      },
    },
  };
}

/** One live rule node with GitHub's fresh-rule defaults for selected fields. */
function ruleNode(
  pattern: string,
  fields: Record<string, unknown> = {},
  actors: unknown[] = [],
): Record<string, unknown> {
  return {
    id: `RULE:${pattern}`,
    pattern,
    requiresDeployments: false,
    requiredDeploymentEnvironments: [],
    bypassForcePushAllowances: { nodes: actors },
    ...fields,
  };
}

const PROTECTION = "GET /repos/o/r/branches/main/protection";
const PROBE = "GET /repos/o/r/branches/main";
const MAIN = { branch: "main" };
/** The classic PUT body for `{enforce_admins: true}`: the omitted core keys null-filled. */
const NULL_FILLED = {
  enforce_admins: true,
  required_status_checks: null,
  required_pull_request_reviews: null,
  restrictions: null,
};

describe("branches", () => {
  const declared: Desired = [{ name: "main", protection: { enforce_admins: true } }];

  test("an unprotected branch plans one PUT with the null-filled payload, and planning writes nothing even where a write would succeed", async () => {
    const api = new MockApi(
      { [PROBE]: { data: { name: "main" } } },
      { unroutedMutations: "succeed" },
    );
    const result = await plan(api, declared);
    expect(result).toEqual({
      ops: [
        {
          role: "putProtection",
          params: MAIN,
          payload: NULL_FILLED,
          describe: 'replacing protection for branch "main"',
          drift: [
            "branches[main]: unprotected live but the settings file declares protection; apply will protect it",
          ],
          change: 'applied protection to "main"',
        },
      ],
      notes: [],
      drift: [],
    });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([PROTECTION, PROBE]);
    expect(api.mutations()).toHaveLength(0);
  });

  test("a missing branch is op-less drift: nothing can create it, so apply notes it instead of a PUT that 404s", async () => {
    const api = new MockApi({}); // every GET 404s, the branch probe included
    const result = await plan(api, declared);
    expect(result).toEqual({
      ops: [],
      notes: [],
      drift: [
        "branches[main]: declared in the settings file but the branch does not exist on the repo, so apply cannot protect it; create the branch, or remove it from the settings file",
      ],
    });
  });

  test("an inconclusive branch probe (no Contents grant) falls back to the unprotected reading instead of failing", async () => {
    const api = new MockApi({
      [PROBE]: { error: { status: 403, message: "Forbidden", body: "" } },
    });
    const result = await plan(api, declared);
    expect(result.drift).toEqual([]);
    expect(result.ops.map((op) => op.drift)).toEqual([
      [
        "branches[main]: unprotected live but the settings file declares protection; apply will protect it",
      ],
    ]);
  });

  test("duplicate branch names are rejected before any API call", async () => {
    const api = new MockApi({});
    await expect(
      plan(api, [
        { name: "main", protection: { enforce_admins: true } },
        { name: "main", protection: null },
      ]),
    ).rejects.toThrow(/same branches entry/);
    expect(api.calls).toHaveLength(0);
  });

  test("live protection diffs the declared keys, and whatever the replacing PUT would remove or turn off is its drift too", async () => {
    const api = new MockApi({
      [PROTECTION]: {
        data: {
          enforce_admins: { enabled: false },
          restrictions: { users: [{ login: "octocat" }], teams: [], apps: [] },
          allow_deletions: { enabled: true },
          required_linear_history: { enabled: false },
          required_signatures: { enabled: false },
        },
      },
    });
    const result = await plan(api, declared);
    expect(result).toEqual({
      ops: [
        {
          role: "putProtection",
          params: MAIN,
          payload: NULL_FILLED,
          describe: 'replacing protection for branch "main"',
          drift: [
            "branches[main].protection.enforce_admins: true != false",
            "branches[main].protection.restrictions: set live but omitted from the settings file, so apply would REMOVE it; add restrictions to the branch's protection in the settings file to keep it",
            "branches[main].protection.allow_deletions: set live but omitted from the settings file, so apply would REMOVE it; add allow_deletions to the branch's protection in the settings file to keep it",
          ],
          change: 'applied protection to "main"',
        },
      ],
      notes: [],
      drift: [],
    });
  });

  test.each([
    [
      "a top-level flag",
      { enforce_admins: { enabled: true }, allow_deletions: { enabled: true } },
      { enforce_admins: true },
      "allow_deletions",
      { enforce_admins: true, allow_deletions: true },
    ],
    [
      "a nested review setting",
      {
        enforce_admins: { enabled: true },
        required_pull_request_reviews: {
          required_approving_review_count: 2,
          dismiss_stale_reviews: true,
          dismissal_restrictions: { users: [], teams: [], apps: [] },
        },
      },
      {
        enforce_admins: true,
        required_pull_request_reviews: { required_approving_review_count: 2 },
      },
      "required_pull_request_reviews.dismiss_stale_reviews",
      {
        enforce_admins: true,
        required_pull_request_reviews: {
          required_approving_review_count: 2,
          dismiss_stale_reviews: true,
        },
      },
    ],
  ] as const)(
    "%s enabled live but omitted is the replacing PUT's only justification; declared, it plans nothing",
    async (_what, liveProtection, omitting, keyPath, declaring) => {
      // The old unconditional PUT reset the setting silently; the plan resets
      // it too, and says so. Empty nested lists are nothing to preserve.
      const api = new MockApi({ [PROTECTION]: { data: liveProtection } });
      const result = await plan(api, [{ name: "main", protection: omitting }]);
      expect(result.ops.map((op) => [op.role, op.drift])).toEqual([
        [
          "putProtection",
          [
            `branches[main].protection.${keyPath}: set live but omitted from the settings file, so apply would REMOVE it; add ${keyPath} to the branch's protection in the settings file to keep it`,
          ],
        ],
      ]);
      expect(await plan(api, [{ name: "main", protection: declaring }])).toEqual({
        ops: [],
        notes: [],
        drift: [],
      });
    },
  );

  /** GitHub's expanded GET shape of a review requirement declared as the bare block. */
  const DEFAULT_REVIEWS = {
    required_approving_review_count: 0,
    dismiss_stale_reviews: false,
    require_code_owner_reviews: false,
    require_last_push_approval: false,
    dismissal_restrictions: { users: [], teams: [], apps: [] },
  };
  const liveDefaultReviews = () =>
    new MockApi({
      [PROTECTION]: {
        data: { enforce_admins: { enabled: true }, required_pull_request_reviews: DEFAULT_REVIEWS },
      },
    });

  test("a live control whose fields are all defaults is still a setting the replacing PUT would remove", async () => {
    // Presence is the setting: reviews are required even with a zero count
    // and every flag off.
    expect(
      (await plan(liveDefaultReviews(), declared)).ops.map((op) => [op.role, op.drift]),
    ).toEqual([
      [
        "putProtection",
        [
          "branches[main].protection.required_pull_request_reviews: set live but omitted from the settings file, so apply would REMOVE it; add required_pull_request_reviews to the branch's protection in the settings file to keep it",
        ],
      ],
    ]);
  });

  test.each([
    ["in full", DEFAULT_REVIEWS],
    ["as the bare block GitHub expands to those defaults", {}],
  ])(
    "the same all-default control declared %s is clean: no drift, no PUT",
    async (_how, reviews) => {
      expect(
        await plan(liveDefaultReviews(), [
          {
            name: "main",
            protection: { enforce_admins: true, required_pull_request_reviews: reviews },
          },
        ]),
      ).toEqual({ ops: [], notes: [], drift: [] });
    },
  );

  test("the GET's own metadata and its second spelling of the status-check list never read as omitted settings", async () => {
    // name, enabled, and enforcement_level exist only in the GET shape; the
    // checks list mirrors contexts. None of them is a setting the PUT would
    // reset, so a converged repository plans nothing.
    const api = new MockApi({
      [PROTECTION]: {
        data: {
          url: "https://api.github.com/repos/o/r/branches/main/protection",
          name: "main",
          enabled: true,
          enforce_admins: { enabled: true },
          required_status_checks: {
            strict: true,
            contexts: ["ci"],
            checks: [{ context: "ci", app_id: null }],
            enforcement_level: "everyone",
          },
        },
      },
    });
    expect(
      await plan(api, [
        {
          name: "main",
          protection: {
            enforce_admins: true,
            required_status_checks: { strict: true, contexts: ["ci"] },
          },
        },
      ]),
    ).toEqual({ ops: [], notes: [], drift: [] });
  });

  test("protection null removes live protection and plans nothing for an unprotected branch", async () => {
    const protectedApi = new MockApi({
      [PROTECTION]: {
        data: { enforce_admins: { enabled: true }, required_signatures: { enabled: true } },
      },
    });
    expect(await plan(protectedApi, [{ name: "main", protection: null }])).toEqual({
      ops: [
        {
          role: "removeProtection",
          params: MAIN,
          drift: [
            "branches[main]: protected live but the settings file declares protection: null; apply will remove the protection",
          ],
          change: 'removed protection from "main"',
        },
      ],
      notes: [],
      drift: [],
    });
    expect(await plan(new MockApi({}), [{ name: "main", protection: null }])).toEqual({
      ops: [],
      notes: [],
      drift: [],
    });
  });

  const sigOp = (role: "sigPost" | "sigDelete", drift: string, change: string) => ({
    role,
    params: MAIN,
    describe:
      role === "sigPost"
        ? 'requiring signed commits on branch "main"'
        : 'removing the signed-commit requirement from branch "main"',
    drift: [drift] as [string],
    change,
  });

  test.each([
    ["declared true against live {enabled: true} is clean", true, { enabled: true }, []],
    ["declared false against live {enabled: false} is clean", false, { enabled: false }, []],
    ["declared false against an ABSENT live field is clean (absent means false)", false, null, []],
    [
      "declared true against an ABSENT live field plans the POST, and nothing else",
      true,
      null,
      [
        sigOp(
          "sigPost",
          "branches[main].protection.required_signatures: true != false",
          'required signed commits on "main"',
        ),
      ],
    ],
    [
      "declared false against a live requirement plans the DELETE, and nothing else",
      false,
      { enabled: true },
      [
        sigOp(
          "sigDelete",
          "branches[main].protection.required_signatures: false != true",
          'removed the signed-commit requirement from "main"',
        ),
      ],
    ],
  ] as const)("required_signatures: %s", async (_name, declaredValue, liveField, ops) => {
    const api = new MockApi({
      [PROTECTION]: {
        data: {
          enforce_admins: { enabled: true },
          ...(liveField === null ? {} : { required_signatures: liveField }),
        },
      },
    });
    const result = await plan(api, [
      { name: "main", protection: { enforce_admins: true, required_signatures: declaredValue } },
    ]);
    expect(result).toEqual({ ops: [...ops], notes: [], drift: [] });
    // The sub-endpoint is the toggle's ONLY carrier: the PUT body never
    // smuggles the key GitHub would silently drop.
    expect(result.ops.some((op) => op.role === "putProtection")).toBe(false);
  });

  test("an unprotected branch declaring required_signatures true plans the PUT, then the POST", async () => {
    const api = new MockApi({ [PROBE]: { data: { name: "main" } } });
    const result = await plan(api, [
      { name: "main", protection: { enforce_admins: true, required_signatures: true } },
    ]);
    expect(result.ops.map((op) => [op.role, op.change])).toEqual([
      ["putProtection", 'applied protection to "main"'],
      ["sigPost", 'required signed commits on "main"'],
    ]);
    expect(Object.keys((result.ops[0] as { payload: object }).payload)).not.toContain(
      "required_signatures",
    );
  });

  test("a planned PUT re-applies a declared toggle that already matches, since GitHub does not document the PUT preserving it", async () => {
    const api = new MockApi({ [PROBE]: { data: { name: "main" } } });
    const result = await plan(api, [
      { name: "main", protection: { enforce_admins: true, required_signatures: false } },
    ]);
    expect(result.ops.map((op) => [op.role, op.drift])).toEqual([
      [
        "putProtection",
        [
          "branches[main]: unprotected live but the settings file declares protection; apply will protect it",
        ],
      ],
      [
        "sigDelete",
        [
          "branches[main].protection.required_signatures: re-applied after the protection PUT (GitHub does not document whether the PUT preserves it)",
        ],
      ],
    ]);
  });

  test('a quoted "true" fails the shape upfront, with the YAML gotcha named', () => {
    // The toggle is typed in the zod shape so document validation rejects it
    // before ANY section writes - not a plan-time throw after earlier
    // sections already applied.
    const parsed = branchesSection.shape.safeParse([
      { name: "main", protection: { enforce_admins: true, required_signatures: "true" } },
    ]);
    expect(parsed.success).toBe(false);
    const messages = parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
    expect(messages.some((m) => m.includes("unquoted true or false"))).toBe(true);
    // The passthrough survives the typed key: unknown protection fields and
    // a proper boolean both validate.
    expect(
      branchesSection.shape.safeParse([
        {
          name: "main",
          protection: { enforce_admins: true, required_signatures: true, extra_field: "x" },
        },
        { name: "legacy", protection: null },
      ]).success,
    ).toBe(true);
  });
});

/** A required-deployment list naming an environment no live state seeds. */
const GHOST = { environments: ["ghost"] };

describe("branches GraphQL-routed keys", () => {
  const routedDesired: Desired = [
    {
      name: "main",
      protection: {
        enforce_admins: true,
        force_push_bypassers: ["octocat", "e2e-owner/platform", "app/deploy-gate"],
        required_deployments: { environments: ["prod"] },
      },
    },
  ];

  test("an unprotected branch plans the PUT, then ONE rule update whose id is read once the PUT created the rule", async () => {
    const api = liveRepo({ branches: ["main"], environments: { prod: { name: "prod" } } });
    const result = await plan(api, routedDesired);
    expect(result.ops.map((op) => [op.role, op.drift])).toEqual([
      [
        "putProtection",
        [
          "branches[main]: unprotected live but the settings file declares protection; apply will protect it",
        ],
      ],
      [
        "updateRule",
        [
          "branches[main].protection.force_push_bypassers: the settings file declares [app/deploy-gate, e2e-owner/platform, octocat] but the live rule allows []; apply will replace the allowance list",
          "branches[main].protection.required_deployments: the settings file requires deployments to [prod] but the live rule does not require deployments; apply will set the declared list",
        ],
      ],
    ]);
    // The id is late (no rule exists at plan time) and the change line renders
    // from the response (the deployment read-back), so both seal at execution.
    expect(typeof result.ops[1]?.variables).toBe("function");
    expect(typeof result.ops[1]?.change).toBe("function");
    expect(api.writes).toEqual([]);

    const execution = await executePlan(result, branchesSection, api, REPO, NO_SECRETS);
    expect(execution).toEqual({
      status: "applied",
      changes: [
        'applied protection to "main"',
        'set force_push_bypassers and required_deployments on "main"',
      ],
      notes: [],
      landed: 2,
    });
    const [put, update] = api.writes;
    expect(put).toEqual({
      method: "PUT",
      path: "/repos/o/r/branches/main/protection",
      payload: NULL_FILLED,
    });
    expect(update?.path).toBe("UpdateBranchProtectionRule");
    const input = (update as { payload: { input: Record<string, unknown> } }).payload.input;
    expect(Object.keys(input).sort()).toEqual([
      "branchProtectionRuleId",
      "bypassForcePushActorIds",
      "requiredDeploymentEnvironments",
      "requiresDeployments",
    ]);
    expect(input.bypassForcePushActorIds).toHaveLength(3);
    expect(input.requiresDeployments).toBe(true);
    expect(input.requiredDeploymentEnvironments).toEqual(["prod"]);
    // Converged: the re-plan reads the rule the update wrote and finds nothing to do.
    expect(await plan(api, routedDesired)).toEqual({ ops: [], notes: [], drift: [] });
  });

  const droppedEnvironmentPaths: Array<
    [
      where: string,
      live: LiveState,
      entry: Desired[number],
      changesBefore: string[],
      writes: string[],
    ]
  > = [
    [
      "the literal-branch update, after the PUT landed",
      { branches: ["main"] },
      { name: "main", protection: { enforce_admins: true, required_deployments: GHOST } },
      ['applied protection to "main"'],
      ["PUT /repos/o/r/branches/main/protection", "GRAPHQL UpdateBranchProtectionRule"],
    ],
    [
      "the wildcard create",
      {},
      { name: "release/*", protection: { enforce_admins: true, required_deployments: GHOST } },
      [],
      ["GRAPHQL CreateBranchProtectionRule"],
    ],
    [
      "the wildcard update",
      { branch_protection_rules: [{ pattern: "release/*" }] },
      { name: "release/*", protection: { enforce_admins: true, required_deployments: GHOST } },
      [],
      ["GRAPHQL UpdateBranchProtectionRule"],
    ],
  ];
  test.each(droppedEnvironmentPaths)(
    "a dropped required-deployment environment fails %s loudly by name, recording no line for it",
    async (_where, live, entry, changesBefore, writes) => {
      // No environments seeded: the mock drops every name, as GitHub does.
      const api = liveRepo(live);
      const result = await plan(api, [entry]);
      const execution = await executePlan(result, branchesSection, api, REPO, NO_SECRETS);
      expect(execution.status).toBe("failed");
      // Every request landed (the failing one included), but only the ones
      // before the failed read-back rendered a line.
      expect([execution.changes, execution.notes, execution.landed]).toEqual([
        changesBefore,
        [],
        writes.length,
      ]);
      expect(String((execution as { error: Error }).error.message)).toMatch(
        /silently dropped \[ghost\].*environments: section/s,
      );
      expect(api.writes.map((w) => `${w.method} ${w.path}`)).toEqual(writes);
    },
  );

  test("routed-key drift compares actor strings and environment sets, and only the update is planned when the REST half is clean", async () => {
    const api = new MockApi({
      [PROTECTION]: { data: { enforce_admins: { enabled: true } } },
      "GRAPHQL BranchProtectionRules": rulesData([
        ruleNode("main", { requiresDeployments: true, requiredDeploymentEnvironments: ["qa"] }, [
          { actor: { __typename: "User", login: "octocat" } },
        ]),
      ]),
      "GRAPHQL BranchProtectionActorUser": {
        data: { repository: { id: "R_1" }, user: { id: "U_2" } },
      },
    });
    const result = await plan(api, [
      {
        name: "main",
        protection: {
          enforce_admins: true,
          force_push_bypassers: ["release-bot"],
          required_deployments: { environments: ["prod"] },
        },
      },
    ]);
    expect(result.ops).toHaveLength(1);
    expect(result.ops[0]).toMatchObject({
      role: "updateRule",
      drift: [
        "branches[main].protection.force_push_bypassers: the settings file declares [release-bot] but the live rule allows [octocat]; apply will replace the allowance list",
        "branches[main].protection.required_deployments: the settings file requires deployments to [prod] but the live rule requires [qa]; apply will set the declared list",
      ],
    });
    // The actor's node id is an execution-time input: the plan issues no
    // lookup (check mode never does), the sealed variables carry the id.
    expect(api.calls.filter((c) => c.path.startsWith("BranchProtectionActor"))).toHaveLength(0);
    const variables = result.ops[0]?.variables;
    expect(typeof variables).toBe("function");
    expect(await (variables as (exec: typeof NO_SECRETS) => unknown)(NO_SECRETS)).toEqual({
      input: {
        branchProtectionRuleId: "RULE:main",
        bypassForcePushActorIds: ["U_2"],
        requiresDeployments: true,
        requiredDeploymentEnvironments: ["prod"],
      },
    });
    expect(api.calls.filter((c) => c.path === "BranchProtectionActorUser")).toHaveLength(1);
    // The line renders from the mutation's read-back, so it is a thunk here.
    expect(typeof result.ops[0]?.change).toBe("function");
    expect(api.mutations()).toHaveLength(0);
  });

  test("matching routed keys are clean, order- and case-insensitively (GitHub canonicalizes names)", async () => {
    const api = new MockApi({
      [PROTECTION]: { data: { enforce_admins: { enabled: true } } },
      "GRAPHQL BranchProtectionRules": rulesData([
        ruleNode("main", { requiresDeployments: true, requiredDeploymentEnvironments: ["prod"] }, [
          { actor: { __typename: "App", slug: "deploy-gate" } },
          { actor: { __typename: "User", login: "octocat" } },
        ]),
      ]),
    });
    const result = await plan(api, [
      {
        name: "main",
        protection: {
          enforce_admins: true,
          force_push_bypassers: ["OctoCat", "app/deploy-gate"],
          required_deployments: { environments: ["Prod"] },
        },
      },
    ]);
    expect(result).toEqual({ ops: [], notes: [], drift: [] });
    // A clean routed half resolves no actor: the lookups exist to build a write.
    expect(api.calls.filter((c) => c.path.startsWith("BranchProtectionActor"))).toHaveLength(0);
  });

  test("a planned PUT re-applies matching routed keys through the update, with the re-apply as its drift, and resolves the actors ahead of the PUT", async () => {
    const api = new MockApi(
      {
        [PROTECTION]: { data: { enforce_admins: { enabled: false } } },
        "GRAPHQL BranchProtectionRules": rulesData([
          ruleNode("main", {}, [{ actor: { __typename: "User", login: "octocat" } }]),
        ]),
        "GRAPHQL BranchProtectionActorUser": {
          data: { repository: { id: "R_1" }, user: { id: "U_1" } },
        },
      },
      { unroutedMutations: "succeed" },
    );
    const result = await plan(api, [
      { name: "main", protection: { enforce_admins: true, force_push_bypassers: ["octocat"] } },
    ]);
    expect(result.ops.map((op) => [op.role, op.drift])).toEqual([
      ["putProtection", ["branches[main].protection.enforce_admins: true != false"]],
      [
        "updateRule",
        [
          "branches[main].protection: force_push_bypassers re-applied after the protection PUT (GitHub does not document whether the PUT preserves them)",
        ],
      ],
    ]);
    // The PUT carries the actor resolution, so a bad actor fails before the
    // live protection is replaced; the update's variables seal the ids.
    expect(typeof result.ops[0]?.before).toBe("function");
    expect(typeof result.ops[1]?.variables).toBe("function");

    const execution = await executePlan(result, branchesSection, api, REPO, NO_SECRETS);
    expect(execution.status).toBe("applied");
    // One lookup, ahead of the PUT; the update finds the id in the per-run cache.
    expect(
      api.calls
        .filter((c) => c.method === "PUT" || c.path.startsWith("BranchProtectionActor"))
        .map((c) => (c.method === "PUT" ? "PUT" : c.path)),
    ).toEqual(["BranchProtectionActorUser", "PUT"]);
    expect(api.mutations().map((m) => m.payload)).toEqual([
      NULL_FILLED,
      { input: { branchProtectionRuleId: "RULE:main", bypassForcePushActorIds: ["U_1"] } },
    ]);
  });

  test("declared null turns a live requirement off through the update, verified by the read-back", async () => {
    const api = liveRepo({
      branches: ["dev"],
      branch_protection: { dev: { enforce_admins: { enabled: true } } },
      branch_protection_graphql: {
        dev: { requiresDeployments: true, requiredDeploymentEnvironments: ["staging"] },
      },
    });
    const result = await plan(api, [
      { name: "dev", protection: { enforce_admins: true, required_deployments: null } },
    ]);
    expect(result.ops.map((op) => [op.role, op.drift])).toEqual([
      [
        "updateRule",
        [
          "branches[dev].protection.required_deployments: declared null (not required) but the live rule requires deployments to [staging]; apply will turn the requirement off",
        ],
      ],
    ]);
    expect(await executePlan(result, branchesSection, api, REPO, NO_SECRETS)).toEqual({
      status: "applied",
      changes: ['set required_deployments on "dev"'],
      notes: [],
      landed: 1,
    });
  });

  test("an unreadable rules view (the tolerated NOT_FOUND) never reads as clean: the declared routed keys are written, loudly", async () => {
    const api = new MockApi({
      [PROTECTION]: { data: { enforce_admins: { enabled: true } } },
      "GRAPHQL BranchProtectionRules": {
        error: { status: 404, message: "Not Found", body: "", graphqlTypes: ["NOT_FOUND"] },
      },
    });
    const result = await plan(api, [
      {
        name: "main",
        protection: { enforce_admins: true, force_push_bypassers: [], required_deployments: null },
      },
    ]);
    expect(result.ops.map((op) => [op.role, op.drift])).toEqual([
      [
        "updateRule",
        [
          "branches[main].protection.force_push_bypassers: the live rule cannot be read (the rules query answered not found); apply will set the declared value",
          "branches[main].protection.required_deployments: the live rule cannot be read (the rules query answered not found); apply will set the declared value",
        ],
      ],
    ]);
    // With no rule id in hand the update looks it up at execution, where the
    // still-unreadable view fails the operation by name instead of silently.
    const execution = await executePlan(result, branchesSection, api, REPO, NO_SECRETS);
    expect(execution.status).toBe("failed");
    expect(String((execution as { error: Error }).error.message)).toMatch(
      /no branch protection rule with that pattern is visible through GraphQL/,
    );
    expect(api.mutations()).toHaveLength(0);
  });

  test("an unknown team is a named config error ahead of the section's first write, not a node-id crash", async () => {
    const api = new MockApi(
      {
        [PROBE]: { data: { name: "main" } },
        "GRAPHQL BranchProtectionRules": rulesData([ruleNode("main")]),
        "GRAPHQL BranchProtectionActorTeam": {
          data: { repository: { id: "R_1" }, organization: { team: null } },
        },
      },
      { unroutedMutations: "succeed" },
    );
    const result = await plan(api, [
      {
        name: "main",
        protection: { enforce_admins: true, force_push_bypassers: ["e2e-owner/ghost-team"] },
      },
    ]);
    // The plan carries the PUT; the resolution it runs first names the error.
    expect(result.ops.map((op) => op.role)).toEqual(["putProtection", "updateRule"]);
    const execution = await executePlan(result, branchesSection, api, REPO, NO_SECRETS);
    expect(execution.status).toBe("failed");
    expect(String((execution as { error: Error }).error.message)).toMatch(
      /no team with slug "ghost-team"/,
    );
    expect(api.mutations()).toHaveLength(0);
  });

  test("a misspelled actor fails before the section's first write, so the destructive PUT is never issued", async () => {
    const api = new MockApi(
      {
        [PROBE]: { data: { name: "main" } },
        "GRAPHQL BranchProtectionRules": rulesData([ruleNode("main")]),
        "GRAPHQL BranchProtectionActorUser": { data: { repository: { id: "R_1" }, user: null } },
      },
      { unroutedMutations: "succeed" },
    );
    const result = await plan(api, [
      { name: "main", protection: { enforce_admins: true, force_push_bypassers: ["ghost"] } },
    ]);
    // Planning issues no lookup: check mode reports the drift without one.
    expect(api.calls.filter((c) => c.path.startsWith("BranchProtectionActor"))).toHaveLength(0);
    const execution = await executePlan(result, branchesSection, api, REPO, NO_SECRETS);
    expect(execution.status).toBe("failed");
    expect(String((execution as { error: Error }).error.message)).toMatch(
      /GraphQL lookup succeeded but returned no node id/,
    );
    expect(execution.landed).toBe(0);
    expect(api.mutations()).toHaveLength(0);
  });

  test("a misspelled actor on a LATER entry fails before an EARLIER entry's write lands", async () => {
    // main drifts on the REST half and carries no actors; dev declares the
    // bad actor. The section's first operation (main's PUT) resolves every
    // planned actor first, so nothing is written for either branch.
    const api = new MockApi(
      {
        [PROTECTION]: { data: { enforce_admins: { enabled: false } } },
        "GET /repos/o/r/branches/dev": { data: { name: "dev" } },
        "GRAPHQL BranchProtectionRules": rulesData([ruleNode("main")]),
        "GRAPHQL BranchProtectionActorUser": { data: { repository: { id: "R_1" }, user: null } },
      },
      { unroutedMutations: "succeed" },
    );
    const result = await plan(api, [
      { name: "main", protection: { enforce_admins: true } },
      { name: "dev", protection: { enforce_admins: true, force_push_bypassers: ["ghost"] } },
    ]);
    expect(result.ops.map((op) => [op.role, typeof op.before])).toEqual([
      ["putProtection", "function"],
      ["putProtection", "undefined"],
      ["updateRule", "undefined"],
    ]);
    const execution = await executePlan(result, branchesSection, api, REPO, NO_SECRETS);
    expect(execution).toEqual({
      status: "failed",
      changes: [],
      notes: [],
      landed: 0,
      error: expect.any(Error),
    });
    expect(String((execution as { error: Error }).error.message)).toMatch(
      /force_push_bypassers actor "ghost".*returned no node id/,
    );
    expect(api.mutations()).toHaveLength(0);
  });

  test("a mutation payload without a rule fails the read-back with its own message", async () => {
    const api = new MockApi({
      [PROBE]: { data: { name: "main" } },
      "GRAPHQL BranchProtectionRules": rulesData([ruleNode("main")]),
      "PUT /repos/o/r/branches/main/protection": { data: {} },
      "GRAPHQL UpdateBranchProtectionRule": {
        data: { updateBranchProtectionRule: { branchProtectionRule: null } },
      },
    });
    const result = await plan(api, [
      {
        name: "main",
        protection: { enforce_admins: true, required_deployments: { environments: ["prod"] } },
      },
    ]);
    const execution = await executePlan(result, branchesSection, api, REPO, NO_SECRETS);
    expect(execution.status).toBe("failed");
    expect(String((execution as { error: Error }).error.message)).toMatch(
      /returned no rule to read back/,
    );
  });

  test("a live rule with a truncated allowance page fails loudly by pattern", async () => {
    const api = new MockApi({
      "GRAPHQL BranchProtectionRules": rulesData([
        {
          ...ruleNode("release/*"),
          bypassForcePushAllowances: { nodes: [], pageInfo: { hasNextPage: true } },
        },
      ]),
    });
    await expect(
      plan(api, [{ name: "release/*", protection: { enforce_admins: true } }]),
    ).rejects.toThrow(/more than 100 force-push bypass actors/);
  });
});

describe("branches wildcard entries", () => {
  test("create, update, and delete plan entirely through GraphQL, each with its drift and change", async () => {
    const api = new MockApi({
      "GRAPHQL BranchProtectionRules": rulesData([
        ruleNode("hotfix/*", { requiresApprovingReviews: true, requiredApprovingReviewCount: 1 }),
        ruleNode("old/*"),
      ]),
      "GRAPHQL BranchProtectionRepository": { data: { repository: { id: "R_1" } } },
    });
    const result = await plan(api, [
      { name: "release/*", protection: { enforce_admins: true } },
      {
        name: "hotfix/*",
        protection: { required_pull_request_reviews: { required_approving_review_count: 2 } },
      },
      { name: "old/*", protection: null },
    ]);
    const [create, update, remove] = result.ops;
    expect([update, remove]).toEqual([
      {
        role: "updateRule",
        variables: {
          input: {
            branchProtectionRuleId: "RULE:hotfix/*",
            requiresApprovingReviews: true,
            requiredApprovingReviewCount: 2,
          },
        },
        describe: 'updating the protection rule "hotfix/*"',
        drift: [
          "branches[hotfix/*].protection.required_pull_request_reviews.required_approving_review_count: 2 != 1",
        ],
        change: 'updated protection rule "hotfix/*"',
      },
      {
        role: "deleteRule",
        variables: { input: { branchProtectionRuleId: "RULE:old/*" } },
        describe: 'deleting the protection rule "old/*"',
        drift: [
          "branches[old/*]: a live rule matches this pattern but the settings file declares protection: null; apply will delete the rule",
        ],
        change: 'deleted protection rule "old/*"',
      },
    ]);
    expect(result.notes).toEqual([]);
    expect(result.drift).toEqual([]);
    // The create needs the repository's node id, an execution-time input: the
    // plan issues no lookup for it, the sealed variables carry it.
    expect(create).toMatchObject({
      role: "createRule",
      describe: 'creating the protection rule "release/*"',
      drift: [
        "branches[release/*]: no live rule matches this pattern but the settings file declares protection; apply will create the rule",
      ],
      change: 'created protection rule "release/*"',
    });
    expect(api.calls.map((c) => c.path)).toEqual(["BranchProtectionRules"]);
    const variables = create?.variables;
    expect(typeof variables).toBe("function");
    expect(await (variables as (exec: typeof NO_SECRETS) => unknown)(NO_SECRETS)).toEqual({
      input: { repositoryId: "R_1", pattern: "release/*", isAdminEnforced: true },
    });
    expect(api.calls.map((c) => c.path)).toEqual([
      "BranchProtectionRules",
      "BranchProtectionRepository",
    ]);
  });

  test("a live wildcard rule diffs through the classic view; a matching one plans nothing", async () => {
    const api = new MockApi({
      "GRAPHQL BranchProtectionRules": rulesData([
        ruleNode("release/*", {
          isAdminEnforced: false,
          requiresStatusChecks: true,
          requiresStrictStatusChecks: true,
          requiredStatusCheckContexts: ["ci"],
        }),
      ]),
    });
    const drifted = await plan(api, [
      {
        name: "release/*",
        protection: {
          enforce_admins: true,
          required_status_checks: { strict: true, contexts: ["ci"] },
        },
      },
    ]);
    expect(drifted.ops.map((op) => op.drift)).toEqual([
      ["branches[release/*].protection.enforce_admins: true != false"],
    ]);
    const clean = await plan(api, [
      {
        name: "release/*",
        protection: { required_status_checks: { strict: true, contexts: ["ci"] } },
      },
    ]);
    expect(clean).toEqual({ ops: [], notes: [], drift: [] });
  });

  test("a live wildcard rule the file does not declare earns a note, never a delete", async () => {
    const api = new MockApi({
      [PROTECTION]: { data: { enforce_admins: { enabled: true } } },
      "GRAPHQL BranchProtectionRules": rulesData([ruleNode("legacy/*")]),
    });
    const result = await plan(api, [
      { name: "main", protection: { enforce_admins: true, force_push_bypassers: [] } },
    ]);
    expect(result).toEqual({
      ops: [],
      notes: [
        'undeclared classic protection rule "legacy/*" exists on the repo - declare it to manage it (this action never deletes undeclared rules)',
      ],
      drift: [],
    });
  });

  test("a pure-REST declaration issues no GraphQL request at all", async () => {
    const api = new MockApi({ [PROBE]: { data: { name: "main" } } });
    await plan(api, [{ name: "main", protection: { enforce_admins: true } }]);
    expect(api.calls.filter((c) => c.method === "GRAPHQL")).toHaveLength(0);
  });

  test("an untranslatable wildcard key fails the shape naming the supported set", () => {
    const parsed = branchesSection.shape.safeParse([
      {
        name: "release/*",
        protection: { enforce_admins: true, restrictions: { users: [], teams: [] } },
      },
    ]);
    expect(parsed.success).toBe(false);
    const messages = parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
    expect(
      messages.some((m) => m.includes("protection.restrictions") && m.includes("rulesets section")),
    ).toBe(true);
    // The same key on a LITERAL entry stays a passthrough.
    expect(
      branchesSection.shape.safeParse([
        { name: "main", protection: { restrictions: { users: [], teams: [] } } },
      ]).success,
    ).toBe(true);
  });

  test("an unknown wildcard sub-key and a malformed actor both fail upfront", () => {
    const nested = branchesSection.shape.safeParse([
      {
        name: "release/*",
        protection: { required_status_checks: { strict: true, checks: [] } },
      },
    ]);
    expect(nested.success).toBe(false);
    const actor = branchesSection.shape.safeParse([
      { name: "main", protection: { force_push_bypassers: ["a/b/c"] } },
    ]);
    expect(actor.success).toBe(false);
    const messages = actor.success ? [] : actor.error.issues.map((issue) => issue.message);
    expect(messages.some((m) => m.includes("bare user login"))).toBe(true);
  });

  test("a scalar structured key on a wildcard entry fails the shape, not apply", () => {
    // Without this rejection the value passes the looseObject and crashes
    // translateWildcardProtection mid-plan with a raw TypeError - a config
    // that survives check mode must never blow up on apply.
    for (const bad of [
      { required_status_checks: true },
      { required_pull_request_reviews: 5 },
      { required_status_checks: ["ci"] },
    ]) {
      const parsed = branchesSection.shape.safeParse([{ name: "release/*", protection: bad }]);
      expect(parsed.success).toBe(false);
      const messages = parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
      expect(messages.some((m) => m.includes("must be a mapping of its sub-keys"))).toBe(true);
    }
    // The same scalar on a LITERAL entry stays a passthrough (GitHub is the
    // authority on the REST payload).
    expect(
      branchesSection.shape.safeParse([
        { name: "main", protection: { required_status_checks: true } },
      ]).success,
    ).toBe(true);
  });

  test("case-insensitive duplicates in the routed lists fail upfront", () => {
    const actors = branchesSection.shape.safeParse([
      { name: "main", protection: { force_push_bypassers: ["octocat", "OctoCat"] } },
    ]);
    expect(actors.success).toBe(false);
    const envs = branchesSection.shape.safeParse([
      {
        name: "main",
        protection: { required_deployments: { environments: ["prod", "Prod"] } },
      },
    ]);
    expect(envs.success).toBe(false);
  });
});

describe("branches plan contract", () => {
  test("executing the plan converges: every kind of write in one apply, and the re-plan over applied state is empty", async () => {
    const api = liveRepo({
      branches: ["main", "sig-off", "dev", "reviews"],
      environments: { prod: { name: "prod" } },
      branch_protection: {
        "sig-off": { enforce_admins: { enabled: true }, required_signatures: { enabled: true } },
        dev: { enforce_admins: { enabled: true } },
        reviews: {
          enforce_admins: { enabled: true },
          required_pull_request_reviews: {
            required_approving_review_count: 2,
            dismiss_stale_reviews: true,
          },
        },
      },
      branch_protection_graphql: {
        dev: { requiresDeployments: true, requiredDeploymentEnvironments: ["staging"] },
      },
      branch_protection_rules: [
        { pattern: "hotfix/*", requiresApprovingReviews: true, requiredApprovingReviewCount: 1 },
        { pattern: "old/*" },
        { pattern: "legacy/*" },
      ],
    });
    const { first, second, changes } = await provePlanIdempotent(branchesSection, api, [
      {
        name: "main",
        protection: {
          enforce_admins: true,
          required_signatures: true,
          force_push_bypassers: ["octocat", "e2e-owner/platform", "app/deploy-gate"],
          required_deployments: { environments: ["prod"] },
        },
      },
      { name: "sig-off", protection: { enforce_admins: true, required_signatures: false } },
      { name: "dev", protection: { enforce_admins: true, required_deployments: null } },
      {
        name: "reviews",
        protection: {
          enforce_admins: true,
          required_pull_request_reviews: { required_approving_review_count: 2 },
        },
      },
      { name: "gone", protection: null },
      { name: "release/*", protection: { enforce_admins: true } },
      {
        name: "hotfix/*",
        protection: { required_pull_request_reviews: { required_approving_review_count: 2 } },
      },
      { name: "old/*", protection: null },
    ]);
    expect(changes).toEqual([
      'applied protection to "main"',
      'required signed commits on "main"',
      'set force_push_bypassers and required_deployments on "main"',
      'removed the signed-commit requirement from "sig-off"',
      'set required_deployments on "dev"',
      'applied protection to "reviews"',
      'created protection rule "release/*"',
      'updated protection rule "hotfix/*"',
      'deleted protection rule "old/*"',
    ]);
    expect(api.writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      "PUT /repos/o/r/branches/main/protection",
      "POST /repos/o/r/branches/main/protection/required_signatures",
      "GRAPHQL UpdateBranchProtectionRule",
      "DELETE /repos/o/r/branches/sig-off/protection/required_signatures",
      "GRAPHQL UpdateBranchProtectionRule",
      "PUT /repos/o/r/branches/reviews/protection",
      "GRAPHQL CreateBranchProtectionRule",
      "GRAPHQL UpdateBranchProtectionRule",
      "GRAPHQL DeleteBranchProtectionRule",
    ]);
    // The undeclared rule's note survives both plans; nothing else does.
    const note =
      'undeclared classic protection rule "legacy/*" exists on the repo - declare it to manage it (this action never deletes undeclared rules)';
    expect(first.notes).toEqual([note]);
    expect(second).toEqual({ ops: [], notes: [note], drift: [] });
  });

  test("the read port exposes exactly the read roles, each narrowed to its declared posture", () => {
    const ctx = planContext(branchesSection, new MockApi({}), REPO);
    expect(Object.keys(ctx.read)).toEqual([
      "getProtection",
      "branchProbe",
      "appLookup",
      "rulesQuery",
      "repoLookup",
      "actorUser",
      "actorTeam",
    ]);
    // @ts-expect-error a write role is not a read: the port has no `putProtection`
    ctx.read.putProtection;
    // @ts-expect-error nor a GraphQL mutation
    ctx.read.updateRule;
    // @ts-expect-error nor the raw client
    ctx.api;
    // @ts-expect-error an "absent" primary read offers no throwing helper
    ctx.read.getProtection.call;
    // @ts-expect-error an advisory read offers no absence probe (a 500 is not "absent")
    ctx.read.branchProbe.probeAbsent;
    // @ts-expect-error nor a must-succeed call
    ctx.read.branchProbe.call;
    expect(typeof ctx.read.branchProbe.tryCall).toBe("function");
  });

  test("a planned operation can only name a declared write role, with the facets its route demands", () => {
    // Compile-time only: the plans are never executed. Each rejected shape
    // is built first and assigned on one line, so the directive anchors to
    // the assignment whichever property the compiler blames.
    type Op = PlannedOp<typeof branchesSection.endpoints, typeof branchesSection.graphql>;
    const rest: Op = { role: "sigPost", params: MAIN, drift: ["x"], change: "" };
    const mutation: Op = { role: "deleteRule", variables: { input: {} }, drift: ["x"], change: "" };
    expect([rest.role, mutation.role]).toEqual(["sigPost", "deleteRule"]);
    const read = { role: "getProtection", params: MAIN, drift: ["x"], change: "" } as const;
    // @ts-expect-error the protection GET is a read, not a plannable write
    const _read: Op = read;
    const query = { role: "rulesQuery", variables: {}, drift: ["x"], change: "" } as const;
    // @ts-expect-error the rules query is a GraphQL read, not a plannable write
    const _query: Op = query;
    const silent = { role: "putProtection", params: MAIN, drift: [], change: "" } as const;
    // @ts-expect-error a write on a non-alwaysRewrite endpoint must carry drift
    const _silent: Op = silent;
    const paramless = { role: "removeProtection", drift: ["x"], change: "" } as const;
    // @ts-expect-error the route's {branch} param is required
    const _paramless: Op = paramless;
    const variableless = { role: "updateRule", drift: ["x"], change: "" } as const;
    // @ts-expect-error a mutation carries its declared variables
    const _variableless: Op = variableless;
  });
});
