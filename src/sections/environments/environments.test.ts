import { describe, expect, test } from "bun:test";
import { matchEndpoint, paramAccessor } from "../../../test/e2e/mock/dispatch.js";
import {
  MOCK_SECRETS_PUBLIC_KEY,
  mockSodiumReady,
  unsealSecretValue,
} from "../../../test/e2e/mock/secrets.js";
import { buildState, type LiveState } from "../../../test/e2e/mock/state.js";
import {
  FIXTURE_ENV_NAME,
  FLAG_PAIRING_FIXTURES,
} from "../../../test/fixtures/environment-flag-pairing.js";
import { MockApi } from "../../../test/mock-api.js";
import { provePlanIdempotent } from "../../../test/sections/plan-idempotence.js";
import {
  NO_SECRETS,
  REPO,
  secretTools,
  sectionRunners,
} from "../../../test/sections/section-run.js";
import { executePlan } from "../../engine/execute.js";
import type { GithubClient } from "../../github/api.js";
import { type PlannedOp, planContext, planDrift } from "../contract/plan.js";
import { allGraphqlOps, type SectionEndpointKey, type SectionGraphqlKey } from "../registry.js";
import { environmentsSection, flattenEnvironment } from "./index.js";
import { environmentsMockGraphqlHandlers, environmentsMockHandlers } from "./mock.js";
import { GRAPHQL_OPS } from "./pins.js";
import type {
  DeploymentBranchPolicyConfig,
  EnvironmentConfig,
  EnvironmentVariableConfig,
} from "./schema.js";

const { plan, check, apply } = sectionRunners(environmentsSection);

/** A live environment body with no protection rules (the converged base). */
function liveEnv(name: string, extra: Record<string, unknown> = {}) {
  return { data: { name, protection_rules: [], ...extra } };
}

const VARIABLES_LIST = "GET /repos/o/r/environments/prod/variables?per_page=30&page=1";

/** A spec-shaped variables list body. */
function variablesBody(variables: Array<{ name: string; value: string }>) {
  return { data: { total_count: variables.length, variables } };
}

describe("environments plan", () => {
  test("the PUT carries the settings alone, and every nested write follows it in wire order", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnv("prod"),
      "PUT /repos/o/r/environments/prod": { data: { name: "prod" } },
      [VARIABLES_LIST]: variablesBody([
        { name: "UPD", value: "old" },
        { name: "GONE", value: "x" },
      ]),
    }).allowMutations(
      "POST /repos/o/r/environments/prod/variables",
      "PATCH /repos/o/r/environments/prod/variables/UPD",
      "DELETE /repos/o/r/environments/prod/variables/GONE",
    );
    const declared = [
      {
        name: "prod",
        wait_timer: 5,
        variables: [
          { name: "NEW", value: "v1" },
          { name: "UPD", value: "v2" },
        ],
      },
    ];
    const planned = await plan(api, declared);
    // Planning reads and never writes, whatever the fake would accept.
    expect(api.mutations()).toEqual([]);
    expect(planned.ops.map((op) => op.role)).toEqual([
      "update",
      "createVariable",
      "updateVariable",
      "removeVariable",
    ]);
    const result = await apply(api, declared);
    const put = api.calls.find((c) => c.method === "PUT");
    expect(put?.payload).toEqual({ wait_timer: 5 });
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "PUT /repos/o/r/environments/prod",
      "POST /repos/o/r/environments/prod/variables",
      "PATCH /repos/o/r/environments/prod/variables/UPD",
      "DELETE /repos/o/r/environments/prod/variables/GONE",
    ]);
    expect(api.calls.find((c) => c.method === "POST")?.payload).toEqual({
      name: "NEW",
      value: "v1",
    });
    expect(api.calls.find((c) => c.method === "PATCH")?.payload).toEqual({ value: "v2" });
    expect(result.changes).toEqual([
      'applied environment "prod"',
      'created variable "NEW" in environment "prod"',
      'updated variable "UPD" in environment "prod"',
      'DELETED undeclared variable "GONE" from environment "prod"',
    ]);
    // The strip builds a fresh object: the caller's entry keeps its
    // variables, so the duplicate pre-pass (which reads env.variables
    // across all entries) can never observe a mutated declaration.
    expect(declared[0]?.variables).toEqual([
      { name: "NEW", value: "v1" },
      { name: "UPD", value: "v2" },
    ]);
  });

  test("a converged environment plans nothing: no PUT, no nested traffic", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnv("prod", {
        protection_rules: [{ id: 1, type: "wait_timer", wait_timer: 5 }],
      }),
    });
    const planned = await plan(api, [{ name: "prod", wait_timer: 5 }]);
    expect(planned).toEqual({ ops: [], notes: [], drift: [] });
    // The variables endpoints are never contacted, not even the list read.
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /repos/o/r/environments/prod",
    ]);
  });

  test("a missing environment plans its PUT with the missing line, in both modes", async () => {
    const api = new MockApi({ "PUT /repos/o/r/environments/prod": { data: { name: "prod" } } });
    const planned = await plan(api, [{ name: "prod", wait_timer: 5 }]);
    expect(planned.ops).toEqual([
      {
        role: "update",
        params: { environment_name: "prod" },
        payload: { wait_timer: 5 },
        drift: [
          "environments[prod]: missing - declared in the settings file but not on the repo; apply will create it",
        ],
        change: 'applied environment "prod"',
        describe: 'upserting environment "prod"',
        capture: undefined,
      },
    ]);
    expect((await apply(api, [{ name: "prod", wait_timer: 5 }])).changes).toEqual([
      'applied environment "prod"',
    ]);
  });

  test("the read port exposes exactly the GET roles and the pins query, the probe in its absent posture", () => {
    const ctx = planContext(environmentsSection, new MockApi({}), REPO);
    expect(Object.keys(ctx.read).sort()).toEqual([
      "listPolicies",
      "listProtectionRuleApps",
      "listProtectionRules",
      "listSecrets",
      "listVariables",
      "pins",
      "probe",
      "secretsPublicKey",
    ]);
    // @ts-expect-error a write role is not a read: the port has no `update`
    ctx.read.update;
    // @ts-expect-error nor a secret PUT
    ctx.read.putSecret;
    // @ts-expect-error nor a pin mutation
    ctx.read.pin;
    // @ts-expect-error nor the raw client
    ctx.api;
    // @ts-expect-error an "absent" primary read offers no throwing helper
    ctx.read.probe.call;
    // @ts-expect-error nor a list
    ctx.read.probe.listAll;
  });

  test("a planned operation can only name a declared write role, and must justify itself", () => {
    // Compile-time only: the plans are never executed.
    type Op = PlannedOp<typeof environmentsSection.endpoints, typeof GRAPHQL_OPS>;
    const pin: Op = {
      role: "pin",
      variables: { environmentId: "EN_x", pinned: true },
      drift: ["pinning"],
      change: "",
    };
    expect(pin.role).toBe("pin");
    const sealed: Op = {
      role: "putSecret",
      params: { environment_name: "prod", secret_name: "S" },
      payload: async () => ({ encrypted_value: "x", key_id: "k" }),
      // An alwaysRewrite endpoint may plan without drift.
      drift: [],
      change: "",
    };
    expect(sealed.role).toBe("putSecret");
    const read = { role: "probe", params: { environment_name: "p" }, drift: ["x"], change: "" };
    // @ts-expect-error the probe is a read, not a plannable write
    const _read: Op = read;
    const query = { role: "pins", variables: {}, drift: ["x"], change: "" } as const;
    // @ts-expect-error the pins query is a read, not a plannable mutation
    const _query: Op = query;
    const silent = { role: "update", params: { environment_name: "p" }, drift: [], change: "" };
    // @ts-expect-error the environment PUT must carry drift
    const _silent: Op = silent;
    const paramless = { role: "update", drift: ["x"], change: "" } as const;
    // @ts-expect-error the route's environment_name param is required
    const _paramless: Op = paramless;
  });
});

describe("environments variables check mode", () => {
  const liveProd = liveEnv("prod", {
    protection_rules: [{ id: 1, type: "wait_timer", wait_timer: 5 }],
  });

  test("value drift and undeclared variables report drift; the environment diff excludes variables", async () => {
    const api = new MockApi(
      {
        "GET /repos/o/r/environments/prod": liveProd,
        [VARIABLES_LIST]: variablesBody([
          { name: "A", value: "2" },
          { name: "B", value: "x" },
        ]),
      },
      // A fake that would accept any write: planning must still issue none.
      { unroutedMutations: "succeed" },
    );
    const result = await check(api, [
      { name: "prod", wait_timer: 5, variables: [{ name: "A", value: "1" }] },
    ]);
    // Exactly the nested lines: a variables key leaking into subsetDiff would
    // add an "environments[prod].variables: declared ..." line here.
    expect(result.drift).toEqual([
      'environments[prod].variables[A].value: declared "1" != live "2"; apply will set the declared value',
      "environments[prod].variables[B]: undeclared - not in the settings file, so apply will DELETE it; add it to the settings file to keep it",
    ]);
    expect(api.mutations()).toEqual([]);
  });

  test("a missing declared variable is drift", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveProd,
      [VARIABLES_LIST]: variablesBody([]),
    });
    const result = await check(api, [{ name: "prod", variables: [{ name: "A", value: "1" }] }]);
    expect(result.drift).toEqual([
      "environments[prod].variables[A]: missing - declared in the settings file but not on the environment; apply will create it",
    ]);
  });
});

describe("environments variables case-insensitive matching", () => {
  test("a case-differing live name matches and only the value is compared", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnv("prod"),
      [VARIABLES_LIST]: variablesBody([{ name: "DEPLOY_REGION", value: "same" }]),
    });
    const result = await apply(api, [
      { name: "prod", variables: [{ name: "deploy_region", value: "same" }] },
    ]);
    // Matched despite the case difference: no create, no update, no delete.
    expect(result.changes).toEqual([]);
  });

  test("an update addresses the PATCH at the LIVE name", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnv("prod"),
      [VARIABLES_LIST]: variablesBody([{ name: "DEPLOY_REGION", value: "old" }]),
    }).allowMutations("PATCH /repos/o/r/environments/prod/variables/DEPLOY_REGION");
    await apply(api, [{ name: "prod", variables: [{ name: "deploy_region", value: "new" }] }]);
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect(patch?.path).toBe("/repos/o/r/environments/prod/variables/DEPLOY_REGION");
    expect(patch?.payload).toEqual({ value: "new" });
  });

  test("two declared names that collapse case-insensitively are rejected before any request", async () => {
    const api = new MockApi({});
    await expect(
      plan(api, [
        {
          name: "prod",
          variables: [
            { name: "Region", value: "a" },
            { name: "REGION", value: "b" },
          ],
        },
      ]),
    ).rejects.toThrow(
      'environments: the "prod" entry declares variables that GitHub treats as the same variable (names are case-insensitive): "Region" and "REGION". Keep exactly one entry per variable',
    );
    expect(api.calls).toEqual([]);
  });
});

describe("environments variables undeclared policy", () => {
  test("the wrapped undeclared:keep form keeps the live variable as a note", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnv("prod"),
      [VARIABLES_LIST]: variablesBody([{ name: "LEGACY", value: "x" }]),
    });
    const result = await apply(api, [
      { name: "prod", variables: { undeclared: "keep", entries: [] } },
    ]);
    expect(result.notes).toEqual([
      'variable "LEGACY" exists on environment "prod" but is not declared in the settings file; kept under "undeclared: keep" - add it to the settings file to manage it, or set "undeclared: delete" to have apply DELETE it',
    ]);
    expect(api.mutations()).toEqual([]);
  });

  test("the plain array form deletes undeclared variables by default", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnv("prod"),
      [VARIABLES_LIST]: variablesBody([{ name: "LEGACY", value: "x" }]),
    }).allowMutations("DELETE /repos/o/r/environments/prod/variables/LEGACY");
    const result = await apply(api, [{ name: "prod", variables: [] }]);
    expect(result.changes).toEqual([
      'DELETED undeclared variable "LEGACY" from environment "prod"',
    ]);
  });

  test("check mode under undeclared:keep converges (note, not drift)", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnv("prod"),
      [VARIABLES_LIST]: variablesBody([{ name: "LEGACY", value: "x" }]),
    });
    const result = await check(api, [
      { name: "prod", variables: { undeclared: "keep", entries: [] } },
    ]);
    expect(result.drift).toEqual([]);
    expect(result.notes).toHaveLength(1);
  });
});

describe("environments variables shape", () => {
  test("both declared forms parse; extra entry fields pass through", () => {
    const shape = environmentsSection.shape;
    expect(
      shape.safeParse([{ name: "prod", variables: [{ name: "A", value: "1" }] }]).success,
    ).toBe(true);
    expect(
      shape.safeParse([
        {
          name: "prod",
          variables: { undeclared: "keep", entries: [{ name: "A", value: "1" }] },
        },
      ]).success,
    ).toBe(true);
    // Loose like the repository actions_variables entries: an extra field
    // rides the POST/PATCH verbatim, so a field GitHub ships tomorrow can
    // be declared the day it appears (the passthrough-first tenet).
    expect(
      shape.safeParse([{ name: "prod", variables: [{ name: "A", value: "1", future: "x" }] }])
        .success,
    ).toBe(true);
    // The WRAPPER stays strict: its keys are this action's own vocabulary.
    expect(
      shape.safeParse([{ name: "prod", variables: { entires: [], entries: [] } }]).success,
    ).toBe(false);
  });

  test("an extra entry field rides the POST and PATCH verbatim, with a phantom note", async () => {
    // The passthrough is behavioral, not just a parse rule: the field
    // reaches the wire on create AND update, and a field GitHub does not
    // echo back earns the phantom note instead of eternal silent drift.
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnv("prod"),
      [VARIABLES_LIST]: variablesBody([{ name: "UPD", value: "old" }]),
    }).allowMutations(
      "POST /repos/o/r/environments/prod/variables",
      "PATCH /repos/o/r/environments/prod/variables/UPD",
    );
    const result = await apply(api, [
      {
        name: "prod",
        variables: [
          { name: "NEW", value: "v1", extra_field: "x" } as EnvironmentVariableConfig,
          { name: "UPD", value: "new", extra_field: "y" } as EnvironmentVariableConfig,
        ],
      },
    ]);
    expect(api.calls.find((c) => c.method === "POST")?.payload).toEqual({
      name: "NEW",
      value: "v1",
      extra_field: "x",
    } as EnvironmentVariableConfig);
    expect(api.calls.find((c) => c.method === "PATCH")?.payload).toEqual({
      value: "new",
      extra_field: "y",
    });
    // The fake echoes no extra_field back, so the update notes the phantom
    // rather than pretending it converged - in check mode too, beside the
    // drift line that names the field the response lacks.
    const phantom =
      'environments[prod].variables[UPD]: declared key(s) "extra_field" do not exist on the live variable, so if GitHub ignores them this update will re-run on every apply without converging. Fix the key name, or remove it from the settings file';
    expect(result.notes).toEqual([phantom]);
    const checked = await check(api, [
      {
        name: "prod",
        variables: [{ name: "UPD", value: "old", extra_field: "y" } as EnvironmentVariableConfig],
      },
    ]);
    expect(checked.drift).toEqual([
      'environments[prod].variables[UPD].extra_field: declared "y" but the API response has no such field (new or write-only field?)',
    ]);
    expect(checked.notes).toEqual([phantom]);
  });
});

// --- Nested per-environment secrets -----------------------------------------

const PROD_SECRETS_LIST = "GET /repos/o/r/environments/prod/secrets?per_page=100&page=1";
const STAGING_KEY = "GET /repos/o/r/environments/staging/secrets/public-key";
const PROD_KEY = "GET /repos/o/r/environments/prod/secrets/public-key";

/** A spec-shaped environment secrets list body (names + timestamps only). */
function secretsBody(names: string[]) {
  return {
    data: {
      total_count: names.length,
      secrets: names.map((name) => ({
        name,
        created_at: "2020-01-15T00:00:00Z",
        updated_at: "2020-01-15T00:00:00Z",
      })),
    },
  };
}

describe("environments nested secrets apply mode", () => {
  test("same-named secrets in sibling environments seal each environment's OWN value, with the key read after the PUT", async () => {
    // A lookup keyed by secret name alone would seal one value into both
    // scopes; staging's key is readable only after its PUT, so the thunk reads
    // it then, never at plan time.
    await mockSodiumReady();
    const api = new MockApi({
      "PUT /repos/o/r/environments/staging": { data: { name: "staging" } },
      "GET /repos/o/r/environments/prod": liveEnv("prod"),
      [PROD_SECRETS_LIST]: secretsBody(["DEPLOY_TOKEN"]),
      [STAGING_KEY]: { data: { key_id: "k-stg", key: MOCK_SECRETS_PUBLIC_KEY } },
      [PROD_KEY]: { data: { key_id: "k-prod", key: MOCK_SECRETS_PUBLIC_KEY } },
    }).allowMutations(
      "PUT /repos/o/r/environments/staging/secrets/DEPLOY_TOKEN",
      "PUT /repos/o/r/environments/prod/secrets/DEPLOY_TOKEN",
    );
    const declared = [
      { name: "staging", secrets: [{ name: "DEPLOY_TOKEN", value: "$STG" }] },
      { name: "prod", secrets: [{ name: "DEPLOY_TOKEN", value: "$PRD" }] },
    ];
    const planned = await plan(api, declared);
    // Check mode never touches the sealing key (nor the missing environment's secrets list).
    expect(api.calls.some((c) => c.path.endsWith("/public-key"))).toBe(false);
    expect(api.calls.some((c) => c.path.startsWith("/repos/o/r/environments/staging/"))).toBe(
      false,
    );
    expect(planned.ops.map((op) => `${op.role} ${JSON.stringify(op.params)}`)).toEqual([
      'update {"environment_name":"staging"}',
      'putSecret {"environment_name":"staging","secret_name":"DEPLOY_TOKEN"}',
      'putSecret {"environment_name":"prod","secret_name":"DEPLOY_TOKEN"}',
    ]);
    const result = await apply(
      api,
      declared,
      secretTools({ $STG: "staging-plaintext", $PRD: "prod-plaintext" }),
    );
    const order = api.calls.map((c) => `${c.method} ${c.path}`);
    expect(order.indexOf("PUT /repos/o/r/environments/staging")).toBeLessThan(
      order.indexOf(STAGING_KEY),
    );
    const puts = api.mutations().filter((c) => c.method === "PUT" && c.path.includes("/secrets/"));
    expect(puts.map((c) => c.path)).toEqual([
      "/repos/o/r/environments/staging/secrets/DEPLOY_TOKEN",
      "/repos/o/r/environments/prod/secrets/DEPLOY_TOKEN",
    ]);
    const unsealed = puts.map((c) =>
      unsealSecretValue((c.payload as { encrypted_value: string }).encrypted_value),
    );
    expect(unsealed).toEqual(["staging-plaintext", "prod-plaintext"]);
    // Each scope sealed against ITS environment's key_id.
    expect(puts.map((c) => (c.payload as { key_id: string }).key_id)).toEqual(["k-stg", "k-prod"]);
    // Change lines place every write in its environment (verb from the
    // per-environment listing: staging creates, prod updates).
    expect(result.changes).toEqual([
      'applied environment "staging"',
      'created secret "DEPLOY_TOKEN" in environment "staging"',
      'updated secret "DEPLOY_TOKEN" in environment "prod"',
    ]);
  });

  test("the secrets key never reaches the environment PUT body", async () => {
    await mockSodiumReady();
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": { data: { name: "prod" } },
      [PROD_KEY]: { data: { key_id: "k", key: MOCK_SECRETS_PUBLIC_KEY } },
    }).allowMutations("PUT /repos/o/r/environments/prod/secrets/S");
    await apply(
      api,
      [{ name: "prod", wait_timer: 5, secrets: [{ name: "S", value: "$S" }] }],
      secretTools({ $S: "v" }),
    );
    const envPut = api.calls.find((c) => c.method === "PUT" && !c.path.includes("/secrets/"));
    expect(envPut?.payload).toEqual({ wait_timer: 5 });
  });

  test("undeclared live secrets: kept with a note by default, DELETED under the knob", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnv("prod"),
      [PROD_SECRETS_LIST]: secretsBody(["LEGACY"]),
    });
    const kept = await apply(api, [{ name: "prod", secrets: [] }]);
    expect(kept.notes.join("\n")).toContain(
      'prod environment secret "LEGACY" exists on the environment but is not declared',
    );
    expect(api.calls.filter((c) => c.path.includes("/secrets/"))).toEqual([]);

    const api2 = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnv("prod"),
      [PROD_SECRETS_LIST]: secretsBody(["LEGACY"]),
    }).allowMutations("DELETE /repos/o/r/environments/prod/secrets/LEGACY");
    const deleted = await apply(api2, [
      { name: "prod", secrets: { undeclared: "delete", entries: [] } },
    ]);
    expect(deleted.changes).toEqual(['DELETED undeclared secret "LEGACY" in environment "prod"']);
    // Nothing declared, so no resolver was needed and no public key fetched.
    expect(api2.calls.some((c) => c.path.endsWith("/public-key"))).toBe(false);
  });

  test.each([
    ["a missing key_id", { key: MOCK_SECRETS_PUBLIC_KEY }, /pair \(key_id is missing\)/],
    ["a key that is not base64", { key_id: "k", key: "not base64!" }, /is not valid base64/],
    [
      "a key of the wrong length",
      { key_id: "k", key: Buffer.from("short").toString("base64") },
      /decodes to 5 bytes where an X25519 public key has 32/,
    ],
    [
      "a right-sized key that is not a usable point",
      { key_id: "k", key: Buffer.alloc(32).toString("base64") },
      /is not a usable X25519 public key/,
    ],
  ])(
    "a sealing key the endpoint cannot supply (%s) fails the secret PUT loudly, naming the scope",
    async (_what, body, defect) => {
      const api = new MockApi({
        "GET /repos/o/r/environments/prod": liveEnv("prod"),
        [PROD_SECRETS_LIST]: secretsBody([]),
        [PROD_KEY]: { data: body },
      }).allowMutations("PUT /repos/o/r/environments/prod/secrets/S");
      const attempt = apply(
        api,
        [{ name: "prod", secrets: [{ name: "S", value: "$S" }] }],
        secretTools({ $S: "v" }),
      );
      await expect(attempt).rejects.toThrow(
        /^environments: GET \/repos\/\{owner\}\/\{repo\}\/environments\/\{environment_name\}\/secrets\/public-key \(the environments\[prod\]\.secrets sealing key\) returned /,
      );
      await expect(attempt).rejects.toThrow(defect);
      expect(api.mutations()).toEqual([]);
    },
  );
});

describe("environments nested secrets check mode", () => {
  test("declared-but-missing is drift with the per-environment label; the note names the environment", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnv("prod"),
      [PROD_SECRETS_LIST]: secretsBody(["LEGACY"]),
    });
    const result = await check(api, [
      { name: "prod", secrets: [{ name: "DEPLOY_TOKEN", value: "$D" }] },
    ]);
    expect(result.drift).toEqual([
      "environments[prod].secrets[DEPLOY_TOKEN]: missing - declared in the settings file but not on the environment; apply will create it",
    ]);
    const cannotVerify = result.notes.filter((n) => n.includes("cannot be read back"));
    expect(cannotVerify).toHaveLength(1);
    expect(cannotVerify[0]).toContain("prod environment secret values");
    expect(api.mutations()).toEqual([]);
    // Check mode never touches the sealing key.
    expect(api.calls.some((c) => c.path.endsWith("/public-key"))).toBe(false);
  });
});

describe("environments nested secrets validation and shape", () => {
  test("case-insensitive duplicate names are rejected upfront, naming the environment", async () => {
    const api = new MockApi({});
    await expect(
      plan(api, [
        {
          name: "prod",
          secrets: [
            { name: "token", value: "$A" },
            { name: "TOKEN", value: "$B" },
          ],
        },
      ]),
    ).rejects.toThrow(/"prod" entry declares secrets .*"token" and "TOKEN"/);
    expect(api.calls).toEqual([]);
  });

  test("secret entries are strict; the singular entry-level `secret` key is rejected by name", () => {
    const shape = environmentsSection.shape;
    expect(shape.safeParse([{ name: "prod", secrets: [{ name: "A", value: "$A" }] }]).success).toBe(
      true,
    );
    expect(
      shape.safeParse([
        { name: "prod", secrets: { undeclared: "delete", entries: [{ name: "A", value: "$A" }] } },
      ]).success,
    ).toBe(true);
    // An extra entry key has no destination (the PUT body is the sealed
    // value alone), so it is rejected rather than silently doing nothing.
    expect(
      shape.safeParse([{ name: "prod", secrets: [{ name: "A", value: "$A", typo: 1 }] }]).success,
    ).toBe(false);
    // The misplacement pin: a singular `secret` would ride the environment
    // PUT verbatim and configure nothing.
    const misplaced = shape.safeParse([{ name: "prod", secret: [{ name: "A", value: "$A" }] }]);
    expect(misplaced.success).toBe(false);
    expect(JSON.stringify(misplaced.error?.issues)).toContain(
      "belong under the entry's `secrets` list",
    );
  });

  test("secretValues walks every entry's secrets list and survives malformed containers", () => {
    // The double cast feeds secretValues a PRE-VALIDATION document slice on
    // purpose: its contract is defensiveness against any merged value.
    const values = environmentsSection.secretValues?.([
      { name: "a", secrets: [{ name: "X", value: "$X" }] },
      { name: "b", secrets: { entries: [{ name: "Y", value: "$Y" }] } },
      { name: "c" },
      { name: "d", secrets: "garbage" },
      "not-an-entry",
    ] as unknown as EnvironmentConfig[]);
    expect(values).toEqual([
      { label: 'the secret entry "X" of environment "a"', value: "$X" },
      { label: 'the secret entry "Y" of environment "b"', value: "$Y" },
    ]);
    // A non-list section value contributes nothing (validation reports it).
    expect(
      environmentsSection.secretValues?.({ not: "a list" } as unknown as EnvironmentConfig[]),
    ).toEqual([]);
  });
});

// --- Nested deployment branch policies ---------------------------------------

const POLICIES_LIST =
  "GET /repos/o/r/environments/prod/deployment-branch-policies?per_page=100&page=1";

/** A spec-shaped branch-policy list body. */
function policiesBody(policies: Array<{ id?: number; name?: string; type?: string }>) {
  return { data: { total_count: policies.length, branch_policies: policies } };
}

/** A declared entry with the flag pairing validation requires. */
function envWithPolicies(
  policies: EnvironmentConfig["deployment_branch_policies"],
): EnvironmentConfig {
  return {
    name: "prod",
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    deployment_branch_policies: policies,
  };
}

/** A live prod environment with the custom-branch-policies flag set as given. */
function liveProdWithFlag(custom: boolean) {
  return liveEnv("prod", {
    deployment_branch_policy: { protected_branches: !custom, custom_branch_policies: custom },
  });
}

describe("environments deployment branch policies apply mode", () => {
  test("creates missing, replaces a type flip (delete + recreate), deletes undeclared", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveProdWithFlag(true),
      [POLICIES_LIST]: policiesBody([
        { id: 41, name: "v*", type: "branch" },
        { id: 42, name: "legacy/*", type: "branch" },
      ]),
    }).allowMutations(
      "POST /repos/o/r/environments/prod/deployment-branch-policies",
      "DELETE /repos/o/r/environments/prod/deployment-branch-policies/41",
      "DELETE /repos/o/r/environments/prod/deployment-branch-policies/42",
    );
    const result = await apply(api, [
      envWithPolicies([{ name: "release/*" }, { name: "v*", type: "tag" }]),
    ]);
    // The flag object matches live, so the environment itself plans no PUT.
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "POST /repos/o/r/environments/prod/deployment-branch-policies",
      "DELETE /repos/o/r/environments/prod/deployment-branch-policies/41",
      "POST /repos/o/r/environments/prod/deployment-branch-policies",
      "DELETE /repos/o/r/environments/prod/deployment-branch-policies/42",
    ]);
    // The recreate carries the declared type; the plain create omits it (the
    // upstream default "branch" applies).
    const posts = api.calls.filter((c) => c.method === "POST");
    expect(posts[0]?.payload).toEqual({ name: "release/*" });
    expect(posts[1]?.payload).toEqual({ name: "v*", type: "tag" });
    expect(result.changes).toEqual([
      'created deployment branch policy "release/*" in environment "prod"',
      'deleted deployment branch policy "v*" in environment "prod" to change its immutable type (branch -> tag)',
      'recreated deployment branch policy "v*" in environment "prod" as type tag',
      'DELETED undeclared deployment branch policy "legacy/*" from environment "prod"',
    ]);
  });

  test("a missing environment plans its patterns as creates without listing them", async () => {
    // The pattern routes 404 until the PUT lands, so the plan reads nothing
    // and the declared patterns follow the PUT as creates.
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": { data: { name: "prod" } },
    }).allowMutations("POST /repos/o/r/environments/prod/deployment-branch-policies");
    const result = await apply(api, [envWithPolicies([{ name: "release/*" }])]);
    expect(api.calls.some((c) => c.method === "GET" && c.path.includes("/deployment-branch"))).toBe(
      false,
    );
    expect(result.changes).toEqual([
      'applied environment "prod"',
      'created deployment branch policy "release/*" in environment "prod"',
    ]);
  });

  test("a matching live pattern (type defaulted to branch) is a no-op", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveProdWithFlag(true),
      // The spec marks every field optional; a live policy without a type
      // reads as the upstream default "branch".
      [POLICIES_LIST]: policiesBody([{ id: 41, name: "release/*" }]),
    });
    const result = await apply(api, [envWithPolicies([{ name: "release/*" }])]);
    expect(result.changes).toEqual([]);
  });

  test("a live policy without a name fails loudly instead of being silently skipped", async () => {
    // A nameless policy has no identity to reconcile by; dropping it would
    // let the default delete policy neither remove nor note it, and check
    // could report falsely clean. The spec marks the field optional, so the
    // extraction fails as a contract violation naming the endpoint.
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveProdWithFlag(true),
      [POLICIES_LIST]: policiesBody([{ id: 41, type: "branch" }]),
    });
    await expect(plan(api, [envWithPolicies([{ name: "release/*" }])])).rejects.toThrow(
      /returned a policy without a name/,
    );
  });

  test("the wrapped undeclared:keep form keeps the live pattern as a note", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveProdWithFlag(true),
      [POLICIES_LIST]: policiesBody([{ id: 41, name: "legacy/*", type: "branch" }]),
    });
    const result = await apply(api, [envWithPolicies({ undeclared: "keep", entries: [] })]);
    expect(result.notes.join("\n")).toContain(
      'deployment branch policy "legacy/*" exists on environment "prod" but is not declared',
    );
    expect(api.mutations()).toEqual([]);
  });
});

describe("environments deployment branch policies check mode", () => {
  test("missing, type-flip, and undeclared patterns report drift without writing", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveProdWithFlag(true),
      [POLICIES_LIST]: policiesBody([
        { id: 41, name: "v*", type: "branch" },
        { id: 42, name: "legacy/*", type: "branch" },
      ]),
    });
    const result = await check(api, [
      envWithPolicies([{ name: "release/*" }, { name: "v*", type: "tag" }]),
    ]);
    expect(result.drift).toEqual([
      "environments[prod].deployment_branch_policies[release/*]: missing - declared in the settings file but not on the environment; apply will create it",
      "environments[prod].deployment_branch_policies[v*]: the declared type differs from the live pattern's, and a policy's type is immutable; apply will delete and recreate it",
      'environments[prod].deployment_branch_policies[v*].type: "tag" != "branch"',
      "environments[prod].deployment_branch_policies[legacy/*]: undeclared - not in the settings file, so apply will DELETE it; add it to the settings file to keep it",
    ]);
    expect(api.mutations()).toEqual([]);
  });

  test("a live environment with the flag off earns a note, never lists patterns, and plans the declared ones as unverified creates", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveProdWithFlag(false),
    });
    const result = await check(api, [envWithPolicies([{ name: "release/*" }])]);
    // The flag drift itself comes from the environment subsetDiff; the
    // pattern follows as a create whose line claims nothing about what the
    // flag hides.
    expect(result.drift).toEqual([
      "environments[prod].deployment_branch_policy.protected_branches: false != true",
      "environments[prod].deployment_branch_policy.custom_branch_policies: true != false",
      "environments[prod].deployment_branch_policies[release/*]: not verifiable until custom_branch_policies is true; apply will create it once the flag is set",
    ]);
    expect(result.notes).toEqual([
      "environments[prod].deployment_branch_policies: patterns are not verifiable until custom_branch_policies is true; apply will set the flag and create the declared patterns, and any pattern already behind the flag reconciles on the next run",
    ]);
    expect(api.calls.some((c) => c.path.includes("/deployment-branch-policies"))).toBe(false);
  });
});

describe("environments deployment branch policies validation and shape", () => {
  test("the flag pairing is a SHAPE rule: declaring the list without custom_branch_policies: true fails validation", () => {
    // In the shape, not the plan() hook, on purpose: upfront document
    // validation rejects the document in both modes before ANY section
    // writes (the apply-mode preflight swallows non-permission hook errors,
    // so a hook check would fire only after earlier sections wrote). The
    // fixtures are the SHARED set the published-schema test also runs, so
    // the zod refinement and the schema's if/then face the same cases.
    const shape = environmentsSection.shape;
    for (const { name, entry, valid } of FLAG_PAIRING_FIXTURES) {
      const parsed = shape.safeParse([entry]);
      expect(parsed.success, name).toBe(valid);
      if (valid) {
        continue;
      }
      const messages = (parsed.error?.issues ?? []).map((issue) => issue.message).join("\n");
      expect(messages).toContain(
        `the "${FIXTURE_ENV_NAME}" entry declares deployment_branch_policies`,
      );
      expect(messages).toContain("custom_branch_policies: true");
      // The issue points at the offending key, so the document-validation
      // error names environments[N].deployment_branch_policies.
      const paths = (parsed.error?.issues ?? []).map((issue) => issue.path.join("."));
      expect(paths).toContain("0.deployment_branch_policies");
    }
  });

  test("duplicate patterns are rejected upfront, naming the environment", async () => {
    const api = new MockApi({});
    await expect(
      plan(api, [envWithPolicies([{ name: "release/*" }, { name: "release/*", type: "tag" }])]),
    ).rejects.toThrow(
      'environments: the "prod" entry declares deployment branch policy "release/*" more than once. Keep exactly one entry per pattern',
    );
    expect(api.calls).toEqual([]);
  });

  test("both declared forms parse; entries stay loose and the wrapper strict", () => {
    const shape = environmentsSection.shape;
    expect(shape.safeParse([envWithPolicies([{ name: "release/*", type: "tag" }])]).success).toBe(
      true,
    );
    expect(
      shape.safeParse([envWithPolicies({ undeclared: "keep", entries: [{ name: "v*" }] })]).success,
    ).toBe(true);
    // Loose entries: a field GitHub ships tomorrow rides the create verbatim.
    expect(
      shape.safeParse([
        envWithPolicies([{ name: "release/*", future: "x" } as DeploymentBranchPolicyConfig]),
      ]).success,
    ).toBe(true);
    // The wrapper stays strict: its keys are this action's own vocabulary.
    expect(
      shape.safeParse([
        envWithPolicies({ entires: [], entries: [] } as unknown as DeploymentBranchPolicyConfig[]),
      ]).success,
    ).toBe(false);
  });
});

// --- Nested deployment protection rules --------------------------------------

const RULES_LIST = "GET /repos/o/r/environments/prod/deployment_protection_rules";
const RULE_APPS_LIST =
  "GET /repos/o/r/environments/prod/deployment_protection_rules/apps?per_page=100&page=1";
const RULE_CREATE = "POST /repos/o/r/environments/prod/deployment_protection_rules";

/** A spec-shaped enabled-rules list body. */
function rulesBody(rules: Array<Record<string, unknown>>) {
  return { data: { total_count: rules.length, custom_deployment_protection_rules: rules } };
}

/** A live enabled rule for a fixture app. */
function liveRule(id: number, slug: string): Record<string, unknown> {
  return {
    id,
    node_id: `DPR_${id}`,
    enabled: true,
    app: {
      id: id + 500,
      slug,
      integration_url: `https://api.github.com/apps/${slug}`,
      node_id: "n",
    },
  };
}

/** A spec-shaped available-Apps list body. */
function ruleAppsBody(apps: Array<{ id: number; slug: string }>) {
  return {
    data: {
      total_count: apps.length,
      available_custom_deployment_protection_rule_integrations: apps,
    },
  };
}

describe("environments deployment protection rules apply mode", () => {
  test("enables a missing rule via ONE apps fetch after the PUT, keeps an undeclared one by default", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnv("prod"),
      "PUT /repos/o/r/environments/prod": { data: { name: "prod" } },
      [RULES_LIST]: rulesBody([liveRule(41, "region-guard"), liveRule(42, "change-window")]),
      [RULE_APPS_LIST]: ruleAppsBody([
        { id: 3515, slug: "deploy-gate" },
        { id: 3516, slug: "region-guard" },
      ]),
    }).allowMutations(RULE_CREATE);
    const declared = [
      {
        name: "prod",
        wait_timer: 5,
        deployment_protection_rules: [{ app: "deploy-gate" }, { app: "region-guard" }],
      },
    ];
    await plan(api, declared);
    // The apps listing is an apply-time resolver; planning never reads it.
    expect(api.calls.some((c) => c.path.includes("/apps"))).toBe(false);
    const result = await apply(api, declared);
    // The nested key never reaches the PUT body.
    expect(api.calls.find((c) => c.method === "PUT")?.payload).toEqual({ wait_timer: 5 });
    // One apps fetch, after the environment PUT; one create, resolved to the
    // App's integration id; region-guard already enabled, so no second POST.
    const order = api.calls.map((c) => `${c.method} ${c.path}`);
    expect(order.filter((c) => c.includes("/apps"))).toHaveLength(1);
    expect(order.indexOf("PUT /repos/o/r/environments/prod")).toBeLessThan(
      order.indexOf(RULE_APPS_LIST),
    );
    const posts = api.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.payload).toEqual({ integration_id: 3515 });
    // The undeclared change-window rule is KEPT (the default): a note, no DELETE.
    expect(api.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(result.notes.join("\n")).toContain(
      'deployment protection rule "change-window" is enabled on environment "prod" but is not declared',
    );
    expect(result.changes).toEqual([
      'applied environment "prod"',
      'enabled deployment protection rule "deploy-gate" in environment "prod"',
    ]);
  });

  test("nothing missing: the apps listing is never fetched", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnv("prod"),
      [RULES_LIST]: rulesBody([liveRule(41, "deploy-gate")]),
    });
    const result = await apply(api, [
      { name: "prod", deployment_protection_rules: [{ app: "deploy-gate" }] },
    ]);
    expect(api.calls.some((c) => c.path.includes("/apps"))).toBe(false);
    expect(result.changes).toEqual([]);
  });

  test("the wrapped undeclared:delete form DISABLES a live undeclared rule by id", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnv("prod"),
      [RULES_LIST]: rulesBody([liveRule(41, "change-window")]),
    }).allowMutations("DELETE /repos/o/r/environments/prod/deployment_protection_rules/41");
    const result = await apply(api, [
      { name: "prod", deployment_protection_rules: { undeclared: "delete", entries: [] } },
    ]);
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "DELETE /repos/o/r/environments/prod/deployment_protection_rules/41",
    ]);
    expect(result.changes).toEqual([
      'DISABLED undeclared deployment protection rule "change-window" in environment "prod"',
    ]);
  });

  test("a declared slug the apps listing does not carry fails loudly, naming the available slugs", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnv("prod"),
      [RULES_LIST]: rulesBody([]),
      [RULE_APPS_LIST]: ruleAppsBody([
        { id: 3515, slug: "deploy-gate" },
        { id: 3516, slug: "region-guard" },
      ]),
    }).allowMutations(RULE_CREATE);
    await expect(
      apply(api, [
        {
          name: "prod",
          // The resolvable deploy-gate entry comes FIRST: every missing slug
          // resolves before the first POST, so the unknown sibling aborts the
          // whole list and the environment is never half-reconciled.
          deployment_protection_rules: [{ app: "deploy-gate" }, { app: "not-installed" }],
        },
      ]),
    ).rejects.toThrow(
      'environments: the deployment protection rule App "not-installed" is not available to ' +
        'environment "prod" (the available Apps are "deploy-gate", "region-guard"). Install the ' +
        "GitHub App providing the rule on this repository, or declare one of the available slugs",
    );
    // Nothing was enabled, not even the resolvable entry.
    expect(api.calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("an EMPTY apps listing says no Apps are available at all", async () => {
    // A real user state, not a contract break: no protection-rule App is
    // installed on the repository, so there is nothing to list in the error.
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnv("prod"),
      [RULES_LIST]: rulesBody([]),
      [RULE_APPS_LIST]: ruleAppsBody([]),
    }).allowMutations(RULE_CREATE);
    await expect(
      apply(api, [{ name: "prod", deployment_protection_rules: [{ app: "deploy-gate" }] }]),
    ).rejects.toThrow(
      'environments: the deployment protection rule App "deploy-gate" is not available to ' +
        'environment "prod" (no protection-rule Apps are available to it). Install the GitHub ' +
        "App providing the rule on this repository, or declare one of the available slugs",
    );
    expect(api.calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("a live rule without an app slug fails loudly instead of being silently skipped", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnv("prod"),
      [RULES_LIST]: rulesBody([{ id: 41, node_id: "n", enabled: true, app: {} }]),
    });
    await expect(
      plan(api, [{ name: "prod", deployment_protection_rules: [{ app: "deploy-gate" }] }]),
    ).rejects.toThrow(/returned a rule without an app slug/);
  });

  test("absent envelope keys read as an empty list (the spec marks both optional)", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnv("prod"),
      [RULES_LIST]: { data: { total_count: 0 } },
      [RULE_APPS_LIST]: ruleAppsBody([{ id: 3515, slug: "deploy-gate" }]),
    }).allowMutations(RULE_CREATE);
    const result = await apply(api, [
      { name: "prod", deployment_protection_rules: [{ app: "deploy-gate" }] },
    ]);
    expect(result.changes).toEqual([
      'enabled deployment protection rule "deploy-gate" in environment "prod"',
    ]);
  });

  test("a PRESENT non-array envelope value is a loud contract violation, never an empty list", async () => {
    // null is present-but-not-a-list too: the spec types the key as a plain
    // array, so only a genuinely ABSENT key may read as empty.
    for (const garbage of ["garbage", null]) {
      const api = new MockApi({
        "GET /repos/o/r/environments/prod": liveEnv("prod"),
        [RULES_LIST]: { data: { custom_deployment_protection_rules: garbage } },
      });
      await expect(
        plan(api, [{ name: "prod", deployment_protection_rules: [{ app: "deploy-gate" }] }]),
      ).rejects.toThrow(
        /returned a body outside the documented shape - custom_deployment_protection_rules/,
      );
    }
  });

  test("a live rule with a non-numeric id fails loudly before any disable", async () => {
    // A null or string id would otherwise serialize into the DELETE path
    // (".../deployment_protection_rules/null") and address nothing.
    for (const id of [null, "41"]) {
      const api = new MockApi({
        "GET /repos/o/r/environments/prod": liveEnv("prod"),
        [RULES_LIST]: rulesBody([{ ...liveRule(41, "change-window"), id }]),
      });
      await expect(
        plan(api, [
          { name: "prod", deployment_protection_rules: { undeclared: "delete", entries: [] } },
        ]),
      ).rejects.toThrow(
        /returned a body outside the documented shape - custom_deployment_protection_rules\[0\]\.id/,
      );
      expect(api.mutations()).toEqual([]);
    }
  });

  test("a live rule reported as disabled does not satisfy its declared gate", async () => {
    // The endpoint documents enabled rules only, so this is a belt over the
    // contract: a declared gate whose live rule says enabled: false must be
    // re-enabled, never read as clean.
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnv("prod"),
      [RULES_LIST]: rulesBody([{ ...liveRule(41, "deploy-gate"), enabled: false }]),
      [RULE_APPS_LIST]: ruleAppsBody([{ id: 3515, slug: "deploy-gate" }]),
    }).allowMutations(RULE_CREATE);
    const result = await apply(api, [
      { name: "prod", deployment_protection_rules: [{ app: "deploy-gate" }] },
    ]);
    expect(result.changes).toEqual([
      'enabled deployment protection rule "deploy-gate" in environment "prod"',
    ]);
  });

  test("a disabled undeclared rule is not an active gate: neither noted nor disabled", async () => {
    // The other half of the enabled-false skip: under undeclared: delete the
    // goal is "no undeclared gate is on", which a disabled rule already
    // satisfies - and a DELETE aimed at a disabled id would likely 404
    // mid-apply for a no-op.
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnv("prod"),
      [RULES_LIST]: rulesBody([{ ...liveRule(41, "change-window"), enabled: false }]),
    });
    const planned = await plan(api, [
      { name: "prod", deployment_protection_rules: { undeclared: "delete", entries: [] } },
    ]);
    expect(planned).toEqual({ ops: [], notes: [], drift: [] });
  });
});

describe("environments deployment protection rules check mode", () => {
  test("missing declared rules are drift; undeclared ones split by policy; nothing written", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnv("prod"),
      [RULES_LIST]: rulesBody([liveRule(41, "change-window")]),
    });
    const kept = await check(api, [
      { name: "prod", deployment_protection_rules: [{ app: "deploy-gate" }] },
    ]);
    expect(kept.drift).toEqual([
      "environments[prod].deployment_protection_rules[deploy-gate]: missing - declared in the settings file but not enabled on the environment; apply will enable it if the App is available to this environment",
    ]);
    expect(kept.notes.join("\n")).toContain('deployment protection rule "change-window"');
    // The apps listing is an apply-time resolver; check mode never reads it.
    expect(api.calls.some((c) => c.path.includes("/apps"))).toBe(false);
    expect(api.mutations()).toEqual([]);

    const api2 = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnv("prod"),
      [RULES_LIST]: rulesBody([liveRule(41, "change-window")]),
    });
    const deleted = await check(api2, [
      { name: "prod", deployment_protection_rules: { undeclared: "delete", entries: [] } },
    ]);
    expect(deleted.drift).toEqual([
      'environments[prod].deployment_protection_rules[change-window]: undeclared - not in the settings file and "undeclared: delete" is set, so apply will DISABLE it; add it to the settings file to keep it',
    ]);
  });
});

describe("environments missing-environment planning across the nested families", () => {
  // One skeleton for the four families: the missingNote, the sub-resource
  // path, and the create's drift line vary. The empty MockApi 404s the
  // environment GET, so every family plans creates without a sub-resource read.
  test.each([
    [
      "variables",
      { name: "prod", variables: [{ name: "A", value: "1" }] },
      "environments[prod].variables: not verifiable while the environment is missing; apply will create the environment and reconcile the declared variables",
      "/variables",
      "environments[prod].variables[A]: missing - declared in the settings file but not on the environment; apply will create it",
    ],
    [
      "secrets",
      { name: "prod", secrets: [{ name: "S", value: "$S" }] },
      "environments[prod].secrets: not verifiable while the environment is missing; apply will create the environment and reconcile the declared secrets",
      "/secrets",
      "environments[prod].secrets[S]: missing - declared in the settings file but not on the environment; apply will create it",
    ],
    [
      "deployment_branch_policies",
      envWithPolicies([{ name: "release/*" }]),
      "environments[prod].deployment_branch_policies: not verifiable while the environment is missing; apply will create the environment and reconcile the declared patterns",
      "/deployment-branch-policies",
      "environments[prod].deployment_branch_policies[release/*]: missing - declared in the settings file but not on the environment; apply will create it",
    ],
    [
      "deployment_protection_rules",
      { name: "prod", deployment_protection_rules: [{ app: "deploy-gate" }] },
      "environments[prod].deployment_protection_rules: not verifiable while the environment is missing; apply will create the environment and reconcile the declared protection rules",
      "/deployment_protection_rules",
      "environments[prod].deployment_protection_rules[deploy-gate]: missing - declared in the settings file but not enabled on the environment; apply will enable it if the App is available to this environment",
    ],
  ] as Array<[string, EnvironmentConfig, string, string, string]>)(
    "%s: the sub-resource read is skipped, the note says it is unverifiable, and the create is planned",
    async (_key, entry, expectedNote, subResourcePath, createDrift) => {
      const api = new MockApi({});
      const result = await check(api, [entry]);
      expect(result.drift).toEqual([
        "environments[prod]: missing - declared in the settings file but not on the repo; apply will create it",
        createDrift,
      ]);
      expect(result.notes).toEqual([expectedNote]);
      expect(api.calls.filter((c) => c.path.includes(subResourcePath))).toEqual([]);
    },
  );
});

describe("environments deployment protection rules validation and shape", () => {
  test("duplicate App slugs are rejected upfront, naming the environment", async () => {
    const api = new MockApi({});
    await expect(
      plan(api, [
        {
          name: "prod",
          deployment_protection_rules: [{ app: "deploy-gate" }, { app: "deploy-gate" }],
        },
      ]),
    ).rejects.toThrow(
      'environments: the "prod" entry declares the deployment protection rule App "deploy-gate" more than once. Keep exactly one entry per App',
    );
    expect(api.calls).toEqual([]);
  });

  test("both declared forms parse; entries are STRICT (the POST carries only the resolved id)", () => {
    const shape = environmentsSection.shape;
    expect(
      shape.safeParse([{ name: "prod", deployment_protection_rules: [{ app: "deploy-gate" }] }])
        .success,
    ).toBe(true);
    expect(
      shape.safeParse([
        {
          name: "prod",
          deployment_protection_rules: {
            undeclared: "delete",
            entries: [{ app: "deploy-gate" }],
          },
        },
      ]).success,
    ).toBe(true);
    // An extra entry key has no destination (the enable POST sends only the
    // resolved integration_id), so it is rejected rather than silently doing
    // nothing.
    expect(
      shape.safeParse([
        { name: "prod", deployment_protection_rules: [{ app: "deploy-gate", typo: 1 }] },
      ]).success,
    ).toBe(false);
    // The wrapper stays strict: its keys are this action's own vocabulary.
    expect(
      shape.safeParse([{ name: "prod", deployment_protection_rules: { entires: [], entries: [] } }])
        .success,
    ).toBe(false);
  });

  test("a custom-rule protection_rules entry flattens without leaking keys", () => {
    // The environment GET surfaces an enabled custom rule as the spec's third
    // protection_rules variant ({id, node_id, type}); flattenEnvironment's
    // generic branch filters exactly those keys, so the entry adds nothing to
    // the flattened object and can never produce false environment drift.
    const flattened = flattenEnvironment({
      name: "prod",
      protection_rules: [{ id: 41, node_id: "DPR_41", type: "deploy-gate" }],
    });
    expect(Object.keys(flattened).sort()).toEqual(["name", "protection_rules"]);
  });
});

// --- Convergence over the e2e mock's own handlers ------------------------------

/**
 * A stateful GithubClient over the section's e2e mock fragment and seeded
 * MockState, so the idempotence proof runs against the scenarios' own model.
 */
function liveRepo(liveState: LiveState): GithubClient & { writes: string[] } {
  const state = buildState(liveState, "org", REPO.slug);
  const graphqlRoles = Object.entries(GRAPHQL_OPS);
  return {
    writes: [],
    async tryRequest(method, path, payload) {
      const [pathname = "", search = ""] = path.split("?");
      const matched = matchEndpoint(method, pathname);
      if (matched === null || !matched.key.startsWith("environments.")) {
        throw new Error(`liveRepo: the environments section issued ${method} ${path}`);
      }
      const response = environmentsMockHandlers[matched.key as SectionEndpointKey<"environments">]({
        state,
        endpoint: matched.endpoint,
        param: paramAccessor(matched.key, matched.endpoint, matched.params),
        query: Object.fromEntries(new URLSearchParams(search)),
        body: payload,
      });
      if (response.status >= 400) {
        const message = (response.body as { message?: unknown } | null)?.message;
        return { error: { status: response.status, message: String(message ?? ""), body: "" } };
      }
      if (method !== "GET") {
        this.writes.push(`${method} ${pathname}`);
      }
      return { data: response.body };
    },
    async tryGraphql(op, variables) {
      const role = graphqlRoles.find(([, declaration]) => declaration.name === op.name)?.[0];
      if (role === undefined) {
        throw new Error(`liveRepo: the environments section issued GRAPHQL ${op.name}`);
      }
      const key = `environments.${role}` as SectionGraphqlKey<"environments">;
      const reply = environmentsMockGraphqlHandlers[key]({
        state,
        op: allGraphqlOps()[key],
        variables: { ...variables },
      });
      if (reply.errors !== undefined) {
        const [first] = reply.errors;
        return {
          error: {
            status: first?.type === "NOT_FOUND" ? 404 : 422,
            message: first?.message ?? "",
            body: "",
            graphqlTypes: reply.errors.map((error) => error.type),
          },
        };
      }
      if (op.kind === "write") {
        this.writes.push(`GRAPHQL ${op.name}`);
      }
      return { data: reply.data };
    },
  };
}

describe("environments convergence", () => {
  const secretEnv = { $PRD: "prod-plaintext", $NEW: "new-plaintext" };

  test("executing the plan converges: the re-plan over applied state carries only the sealed secret PUTs", async () => {
    // Every family at once, against the mock's own state: an existing
    // environment with settings drift and every nested knob diverging, plus
    // a missing pinned environment whose node id must come from its PUT.
    await mockSodiumReady();
    const api = liveRepo({
      environments: {
        prod: {
          name: "prod",
          protection_rules: [{ id: 1, type: "wait_timer", wait_timer: 15 }],
          deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
        },
        legacy: { name: "legacy", protection_rules: [] },
      },
      environment_variables: {
        prod: [
          {
            name: "LOG_LEVEL",
            value: "info",
            created_at: "2026-06-01T00:00:00Z",
            updated_at: "2026-06-01T00:00:00Z",
          },
          {
            name: "GONE",
            value: "x",
            created_at: "2026-06-01T00:00:00Z",
            updated_at: "2026-06-01T00:00:00Z",
          },
        ],
      },
      environment_secrets: {
        prod: [
          {
            name: "DEPLOY_TOKEN",
            created_at: "2019-08-10T14:59:22Z",
            updated_at: "2019-08-10T14:59:22Z",
          },
          { name: "KEPT", created_at: "2019-08-10T14:59:22Z", updated_at: "2019-08-10T14:59:22Z" },
        ],
      },
      environment_branch_policies: {
        prod: [
          { id: 4001, name: "v*", type: "branch" },
          { id: 4002, name: "legacy/*", type: "branch" },
        ],
      },
      environment_protection_rules: {
        prod: [
          {
            id: 7101,
            node_id: "DPR_7101",
            enabled: true,
            app: { id: 3517, slug: "change-window", integration_url: "u", node_id: "n" },
          },
        ],
      },
      pinned_environments: ["legacy"],
    });
    const { first, second, changes } = await provePlanIdempotent(
      environmentsSection,
      api,
      [
        {
          name: "prod",
          wait_timer: 30,
          deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
          variables: [
            { name: "DEPLOY_REGION", value: "eu-west-1" },
            { name: "log_level", value: "debug" },
          ],
          secrets: [{ name: "DEPLOY_TOKEN", value: "$PRD" }],
          deployment_branch_policies: [{ name: "release/*" }, { name: "v*", type: "tag" }],
          deployment_protection_rules: [{ app: "deploy-gate" }],
          pinned: true,
        },
        { name: "staging", pinned: true },
        { name: "legacy", pinned: false },
      ],
      secretTools(secretEnv),
    );
    expect(changes).toEqual([
      'applied environment "prod"',
      'created variable "DEPLOY_REGION" in environment "prod"',
      'updated variable "log_level" in environment "prod"',
      'DELETED undeclared variable "GONE" from environment "prod"',
      'updated secret "DEPLOY_TOKEN" in environment "prod"',
      'created deployment branch policy "release/*" in environment "prod"',
      'deleted deployment branch policy "v*" in environment "prod" to change its immutable type (branch -> tag)',
      'recreated deployment branch policy "v*" in environment "prod" as type tag',
      'DELETED undeclared deployment branch policy "legacy/*" from environment "prod"',
      'enabled deployment protection rule "deploy-gate" in environment "prod"',
      'applied environment "staging"',
      'unpinned environment "legacy"',
      'pinned environment "prod"',
      'pinned environment "staging"',
    ]);
    expect(api.writes).toEqual([
      "PUT /repos/o/r/environments/prod",
      "POST /repos/o/r/environments/prod/variables",
      "PATCH /repos/o/r/environments/prod/variables/LOG_LEVEL",
      "DELETE /repos/o/r/environments/prod/variables/GONE",
      "PUT /repos/o/r/environments/prod/secrets/DEPLOY_TOKEN",
      "POST /repos/o/r/environments/prod/deployment-branch-policies",
      "DELETE /repos/o/r/environments/prod/deployment-branch-policies/4001",
      "POST /repos/o/r/environments/prod/deployment-branch-policies",
      "DELETE /repos/o/r/environments/prod/deployment-branch-policies/4002",
      "POST /repos/o/r/environments/prod/deployment_protection_rules",
      "PUT /repos/o/r/environments/staging",
      "GRAPHQL PinEnvironment",
      "GRAPHQL PinEnvironment",
      "GRAPHQL PinEnvironment",
      // The second pass: the sealed PUT recurs by contract, nothing else.
      "PUT /repos/o/r/environments/prod/secrets/DEPLOY_TOKEN",
    ]);
    expect(first.notes).toEqual([
      "prod environment secret values cannot be read back from GitHub, so check mode verifies only that each declared secret exists; apply re-seals and rewrites every declared value on each run",
      'prod environment secret "KEPT" exists on the environment but is not declared in the ' +
        'settings file; kept under "undeclared: keep" - add it to the settings file to manage ' +
        'it, or set "undeclared: delete" to have apply DELETE it (a deleted secret\'s value is ' +
        "unrecoverable)",
      'deployment protection rule "change-window" is enabled on environment "prod" but is not declared in the settings file; kept under "undeclared: keep" - add it to the settings file to manage it, or set "undeclared: delete" to have apply DISABLE it',
    ]);
    expect(second.ops.map((op) => `${op.role} ${op.change}`)).toEqual([
      'putSecret updated secret "DEPLOY_TOKEN" in environment "prod"',
    ]);
  });

  test("patterns hidden behind a flag that is off reconcile on the run after the one that sets it", async () => {
    // The mock keeps patterns behind an off flag (the list route 404s): the
    // first apply sets the flag and creates the declared ones (the hidden
    // same-name answers 303), the next apply converges on what was revealed.
    const api = liveRepo({
      environments: {
        prod: {
          name: "prod",
          protection_rules: [],
          deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
        },
      },
      environment_branch_policies: {
        prod: [
          { id: 4001, name: "v*", type: "branch" },
          { id: 4002, name: "legacy/*", type: "branch" },
        ],
      },
    });
    const desired = [envWithPolicies([{ name: "release/*" }, { name: "v*", type: "tag" }])];
    const first = await plan(api, desired);
    expect(planDrift(first)).toEqual([
      "environments[prod].deployment_branch_policy.protected_branches: false != true",
      "environments[prod].deployment_branch_policy.custom_branch_policies: true != false",
      "environments[prod].deployment_branch_policies[release/*]: not verifiable until custom_branch_policies is true; apply will create it once the flag is set",
      "environments[prod].deployment_branch_policies[v*]: not verifiable until custom_branch_policies is true; apply will create it once the flag is set",
    ]);
    const applied = await executePlan(first, environmentsSection, api, REPO, NO_SECRETS);
    expect(applied.status).toBe("applied");
    expect(api.writes).toEqual([
      "PUT /repos/o/r/environments/prod",
      "POST /repos/o/r/environments/prod/deployment-branch-policies",
      "POST /repos/o/r/environments/prod/deployment-branch-policies",
    ]);
    const second = await plan(api, desired);
    expect(planDrift(second)).toEqual([
      "environments[prod].deployment_branch_policies[v*]: the declared type differs from the live pattern's, and a policy's type is immutable; apply will delete and recreate it",
      'environments[prod].deployment_branch_policies[v*].type: "tag" != "branch"',
      "environments[prod].deployment_branch_policies[legacy/*]: undeclared - not in the settings file, so apply will DELETE it; add it to the settings file to keep it",
    ]);
    await executePlan(second, environmentsSection, api, REPO, NO_SECRETS);
    expect(await plan(api, desired)).toEqual({ ops: [], notes: [], drift: [] });
  });

  test("a secret created alongside its environment is rewritten as an update by the next plan", async () => {
    // The first pass creates the environment and its secret (key read after
    // the PUT); the second plans exactly the recurring PUT, now an update
    // with no drift.
    await mockSodiumReady();
    const api = liveRepo({});
    const desired = [{ name: "staging", secrets: [{ name: "NEW", value: "$NEW" }] }];
    const first = await plan(api, desired);
    expect(planDrift(first)).toEqual([
      "environments[staging]: missing - declared in the settings file but not on the repo; apply will create it",
      "environments[staging].secrets[NEW]: missing - declared in the settings file but not on the environment; apply will create it",
    ]);
    const execution = await executePlan(
      first,
      environmentsSection,
      api,
      REPO,
      secretTools(secretEnv),
    );
    expect(execution).toEqual({
      status: "applied",
      changes: ['applied environment "staging"', 'created secret "NEW" in environment "staging"'],
      notes: [],
      landed: 2,
    });
    const second = await plan(api, desired);
    expect(second.ops.map((op) => ({ role: op.role, drift: op.drift, change: op.change }))).toEqual(
      [{ role: "putSecret", drift: [], change: 'updated secret "NEW" in environment "staging"' }],
    );
    expect(second.notes).toEqual([
      "staging environment secret values cannot be read back from GitHub, so check mode verifies only that each declared secret exists; apply re-seals and rewrites every declared value on each run",
    ]);
  });
});
