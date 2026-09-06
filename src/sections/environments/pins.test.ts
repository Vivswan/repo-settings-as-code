/**
 * Unit tests for the routed `pinned` scalar: the GraphQL pin, unpin, and
 * reorder plans over the pins connection, check-mode drift, and the schema cap.
 */

import { describe, expect, test } from "bun:test";
import { MockApi } from "../../../test/mock-api.js";
import { NO_SECRETS, REPO, sectionRunners } from "../../../test/sections/section-run.js";
import { executePlan } from "../../engine/execute.js";
import { driftOf, planDrift } from "../contract/plan.js";
import { environmentsSection } from "./index.js";

const { plan, check, apply } = sectionRunners(environmentsSection);

/**
 * A pins-connection body. `pins` are either names (contiguous positions
 * 1..N) or {name, position} pairs for the hole-y layouts live GitHub
 * produces after an unpin.
 */
function pinsBody(pins: Array<string | { name: string; position: number }>) {
  return {
    data: {
      repository: {
        pinnedEnvironments: {
          nodes: pins.map((pin, index) =>
            typeof pin === "string"
              ? { position: index + 1, environment: { name: pin } }
              : { position: pin.position, environment: { name: pin.name } },
          ),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  };
}

/** A PUT/GET environment body carrying the node id the pin mutations address. */
function envBody(name: string) {
  return { data: { name, protection_rules: [], node_id: `EN_${name}` } };
}

/** The GraphQL writes a fake recorded, as {op, payload} pairs. */
function graphqlWrites(api: MockApi) {
  return api
    .mutations()
    .filter((c) => c.method === "GRAPHQL")
    .map((c) => ({ op: c.path, payload: c.payload }));
}

describe("environments pinned apply mode", () => {
  test("pinned never reaches the PUT body, and a created environment's pin addresses the node id its PUT answered with", async () => {
    // The environment does not exist yet, so its node id is known only once
    // the PUT has run: the PUT's capture hands it to the pin mutation.
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": envBody("prod"),
      "GRAPHQL EnvironmentPins": pinsBody([]),
    }).allowMutations("GRAPHQL PinEnvironment");
    const result = await apply(api, [{ name: "prod", wait_timer: 5, pinned: true }]);
    expect(api.calls.find((c) => c.method === "PUT")?.payload).toEqual({ wait_timer: 5 });
    const order = api.calls.map((c) => `${c.method} ${c.path}`);
    expect(order.indexOf("PUT /repos/o/r/environments/prod")).toBeLessThan(
      order.indexOf("GRAPHQL PinEnvironment"),
    );
    expect(graphqlWrites(api)).toEqual([
      { op: "PinEnvironment", payload: { environmentId: "EN_prod", pinned: true } },
    ]);
    expect(result.changes).toEqual(['applied environment "prod"', 'pinned environment "prod"']);
  });

  test("an existing environment's pin addresses the node id the probe body carried", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": envBody("prod"),
      "GRAPHQL EnvironmentPins": pinsBody([]),
    }).allowMutations("GRAPHQL PinEnvironment");
    const result = await apply(api, [{ name: "prod", pinned: true }]);
    expect(api.mutations().map((c) => `${c.method} ${c.path}`)).toEqual(["GRAPHQL PinEnvironment"]);
    expect(graphqlWrites(api)[0]?.payload).toEqual({ environmentId: "EN_prod", pinned: true });
    expect(result.changes).toEqual(['pinned environment "prod"']);
  });

  test("without any pinned key the section stays REST-only", async () => {
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": envBody("prod"),
    });
    await apply(api, [{ name: "prod", wait_timer: 5 }]);
    expect(api.calls.filter((c) => c.method === "GRAPHQL")).toEqual([]);
  });

  test("minimal mutations in cap-safe order: unpin, then pin, then leftward reorders", async () => {
    // Live [c, b]; declared order pins a then b, and c declares pinned:
    // false. The unpin runs FIRST (a swap can never transiently exceed the
    // cap), the missing a is pinned to the tail, and one reorder pulls a
    // left to position 1 - b then already sits at position 2, so no second
    // reorder is issued.
    const api = new MockApi({
      "PUT /repos/o/r/environments/a": envBody("a"),
      "GET /repos/o/r/environments/b": envBody("b"),
      "GET /repos/o/r/environments/c": envBody("c"),
      "GRAPHQL EnvironmentPins": pinsBody(["c", "b"]),
    }).allowMutations("GRAPHQL PinEnvironment", "GRAPHQL ReorderEnvironment");
    const result = await apply(api, [
      { name: "a", pinned: true },
      { name: "b", pinned: true },
      { name: "c", pinned: false },
    ]);
    expect(graphqlWrites(api)).toEqual([
      { op: "PinEnvironment", payload: { environmentId: "EN_c", pinned: false } },
      { op: "PinEnvironment", payload: { environmentId: "EN_a", pinned: true } },
      { op: "ReorderEnvironment", payload: { environmentId: "EN_a", position: 1 } },
    ]);
    expect(result.changes).toEqual([
      'applied environment "a"',
      'unpinned environment "c"',
      'pinned environment "a"',
      'moved pinned environment "a" to position 1',
    ]);
  });

  test("a converged pin state issues zero pin mutations", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/a": envBody("a"),
      "GET /repos/o/r/environments/b": envBody("b"),
      "GRAPHQL EnvironmentPins": pinsBody(["a", "b"]),
    });
    const planned = await plan(api, [
      { name: "a", pinned: true },
      { name: "b", pinned: true },
    ]);
    expect(planned).toEqual({ ops: [], notes: [], drift: [] });
  });

  test("hole-y live positions in the right order are converged: rank, not literal numbers", async () => {
    // Verified live behavior: unpinning leaves a hole (positions 1 and 3
    // with nothing at 2), and re-pins append via a monotonic counter - so a
    // list whose RANK order matches the declaration must read converged,
    // never as position drift.
    const api = new MockApi({
      "GET /repos/o/r/environments/a": envBody("a"),
      "GET /repos/o/r/environments/b": envBody("b"),
      "GRAPHQL EnvironmentPins": pinsBody([
        { name: "a", position: 1 },
        { name: "b", position: 3 },
      ]),
    });
    const planned = await plan(api, [
      { name: "a", pinned: true },
      { name: "b", pinned: true },
    ]);
    expect(planned.ops).toEqual([]);
  });

  test("two fresh pins land in declaration order with zero reorders (tail appends)", async () => {
    // Pins append at the tail (verified live behavior), so pinning a then b
    // onto an empty list already realizes the declared order - the plan
    // must not emit compensating reorders.
    const api = new MockApi({
      "PUT /repos/o/r/environments/a": envBody("a"),
      "PUT /repos/o/r/environments/b": envBody("b"),
      "GRAPHQL EnvironmentPins": pinsBody([]),
    }).allowMutations("GRAPHQL PinEnvironment");
    await apply(api, [
      { name: "a", pinned: true },
      { name: "b", pinned: true },
    ]);
    expect(graphqlWrites(api)).toEqual([
      { op: "PinEnvironment", payload: { environmentId: "EN_a", pinned: true } },
      { op: "PinEnvironment", payload: { environmentId: "EN_b", pinned: true } },
    ]);
  });

  test("live pins nobody declared count toward the cap: overflow fails BEFORE any mutation", async () => {
    // The shape's upfront cap sees only declared entries; ten live undeclared
    // pins (which the section never unpins) plus one declared pin overflow
    // GitHub's cap, and discovering that on the pin mutation would leave the
    // list half-applied. The first pin mutation's thunk refuses before its
    // request leaves; the environment PUT before it has landed.
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": envBody("prod"),
      "GRAPHQL EnvironmentPins": pinsBody([
        "u1",
        "u2",
        "u3",
        "u4",
        "u5",
        "u6",
        "u7",
        "u8",
        "u9",
        "u10",
      ]),
    }).allowMutations("GRAPHQL PinEnvironment");
    const planned = await plan(api, [{ name: "prod", pinned: true }]);
    // The note sits beside the drift in both modes (u1 also earns the
    // interleaving note: it leads the list the declared pin should lead).
    expect(planned.notes).toEqual([
      'pinned environment(s) "u1" have no pinned declaration in the settings file; they stay pinned (only a pinned: false entry unpins) and apply moves them after the declared pins',
      "apply will fail: pinning the 1 declared environment(s) not yet pinned would leave 11 environments pinned, but GitHub allows at most 10. Pins without a pinned declaration are left untouched, so declare pinned: false on entries for some of the currently pinned environments, or unpin them in the GitHub UI",
    ]);
    const execution = await executePlan(planned, environmentsSection, api, REPO, NO_SECRETS);
    expect(execution.status).toBe("failed");
    expect(execution.changes).toEqual(['applied environment "prod"']);
    expect(String((execution as { error: unknown }).error)).toMatch(
      /would leave 11 environments pinned, but GitHub allows at most 10/,
    );
    expect(api.mutations().filter((c) => c.method === "GRAPHQL")).toEqual([]);
  });

  test("a raced-full pinned list surfaces GitHub's cap rejection on the pin mutation", async () => {
    // Nine live pins pass the overflow gate (9 + 1 = 10), but a pin raced in
    // between the read and the mutation makes GitHub reject with
    // UNPROCESSABLE - the belt under the gate, classified like any other
    // rejected request and naming the operation.
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": envBody("prod"),
      "GRAPHQL EnvironmentPins": pinsBody(["u1", "u2", "u3", "u4", "u5", "u6", "u7", "u8", "u9"]),
      "GRAPHQL PinEnvironment": {
        error: {
          status: 422,
          message: "Repositories may only have 10 pinned environments",
          body: "",
          graphqlTypes: ["UNPROCESSABLE"],
        },
      },
    });
    await expect(apply(api, [{ name: "prod", pinned: true }])).rejects.toThrow(
      'environments: pinning environment "prod" failed - GRAPHQL PinEnvironment: 422 Repositories may only have 10 pinned environments',
    );
  });

  test("a PUT response without a node_id fails that operation, records no line, and fires no pin", async () => {
    // The capture extracts the id synchronously as the PUT lands, so the
    // failure is the PUT's own (no change line) and the pin never runs.
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": { data: { name: "prod" } },
      "GRAPHQL EnvironmentPins": pinsBody([]),
    }).allowMutations("GRAPHQL PinEnvironment");
    const planned = await plan(api, [{ name: "prod", pinned: true }]);
    expect(planned.ops.map((op) => op.role)).toEqual(["update", "pin"]);
    const execution = await executePlan(planned, environmentsSection, api, REPO, NO_SECRETS);
    expect(execution.status).toBe("failed");
    expect(execution.changes).toEqual([]);
    expect(String((execution as { error: unknown }).error)).toMatch(
      /the environment body for "prod" carried no node_id/,
    );
    expect(api.mutations().map((c) => `${c.method} ${c.path}`)).toEqual([
      "PUT /repos/o/r/environments/prod",
    ]);
  });

  test("EVERY planned mutation's id resolves before the FIRST one fires", async () => {
    // Two pins are planned and the SECOND environment's PUT body lacks its
    // node_id: resolve-before-write means the first pin must not have fired
    // when the resolution throws, or the list would be half-applied.
    const api = new MockApi({
      "PUT /repos/o/r/environments/a": envBody("a"),
      "PUT /repos/o/r/environments/b": { data: { name: "b" } },
      "GRAPHQL EnvironmentPins": pinsBody([]),
    }).allowMutations("GRAPHQL PinEnvironment");
    await expect(
      apply(api, [
        { name: "a", pinned: true },
        { name: "b", pinned: true },
      ]),
    ).rejects.toThrow(/the environment body for "b" carried no node_id/);
    expect(api.mutations().filter((c) => c.method === "GRAPHQL")).toEqual([]);
  });

  test("a converged run never resolves ids, so a missing node_id cannot fail it", async () => {
    // The plan carries no pin mutation, so no thunk resolves an id: an API
    // that stopped carrying node_id must not break a repository that is
    // already in the declared state.
    const api = new MockApi({
      "GET /repos/o/r/environments/a": { data: { name: "a", protection_rules: [] } },
      "GRAPHQL EnvironmentPins": pinsBody(["a"]),
    });
    const result = await apply(api, [{ name: "a", pinned: true }]);
    expect(result.changes).toEqual([]);
  });

  test("a pin node without position and name fails loudly instead of reconciling blind", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": envBody("prod"),
      "GRAPHQL EnvironmentPins": {
        data: {
          repository: {
            pinnedEnvironments: {
              nodes: [{ environment: { name: "prod" } }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    });
    await expect(plan(api, [{ name: "prod", pinned: true }])).rejects.toThrow(
      /returned a pin node this section cannot read/,
    );
  });
});

describe("environments pinned check mode", () => {
  test("rank-order drift in wire order: the unpin, the missing pin, then ONE order line; nothing written", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/a": envBody("a"),
      "GET /repos/o/r/environments/b": envBody("b"),
      "GET /repos/o/r/environments/c": envBody("c"),
      "GET /repos/o/r/environments/d": envBody("d"),
      "GRAPHQL EnvironmentPins": pinsBody(["c", "b", "a"]),
    });
    const result = await check(api, [
      { name: "a", pinned: true },
      { name: "b", pinned: true },
      { name: "c", pinned: false },
      { name: "d", pinned: true },
    ]);
    expect(result.drift).toEqual([
      "environments[c].pinned: pinned on the repo but declared pinned: false; apply will unpin it",
      "environments[d].pinned: missing - declared pinned but the environment is not pinned on the repo; apply will pin it",
      "environments.pinned: the declared pin order is [a, b, d] but the live pinned order is [c, b, a]; apply will reorder the pins so the declared ones lead in declaration order",
    ]);
    expect(api.mutations()).toEqual([]);
  });

  test("every reorder after the first is a continuation of the one order line, never per-environment pin drift", async () => {
    // Live [c, b, a], all three declared pinned: a moves to 1, then b to 2 (c
    // slid right). The order line explains the sequence once; a misplaced pin
    // never earns an environments[x].pinned line.
    const api = new MockApi({
      "GET /repos/o/r/environments/a": envBody("a"),
      "GET /repos/o/r/environments/b": envBody("b"),
      "GET /repos/o/r/environments/c": envBody("c"),
      "GRAPHQL EnvironmentPins": pinsBody(["c", "b", "a"]),
    });
    const planned = await plan(api, [
      { name: "a", pinned: true },
      { name: "b", pinned: true },
      { name: "c", pinned: true },
    ]);
    expect(planned.ops.map((op) => [op.role, op.change, ...driftOf(op)])).toEqual([
      [
        "reorder",
        'moved pinned environment "a" to position 1',
        "environments.pinned: the declared pin order is [a, b, c] but the live pinned order is [c, b, a]; apply will reorder the pins so the declared ones lead in declaration order",
      ],
      [
        "reorder",
        'moved pinned environment "b" to position 2',
        'environments.pinned: apply will also move "b" to position 2 in that reordering',
      ],
    ]);
    expect(planDrift(planned).some((line) => /environments\[[abc]\]\.pinned/.test(line))).toBe(
      false,
    );
  });

  test("clean when the declared pins lead in declaration order; trailing undeclared pins earn nothing", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/a": envBody("a"),
      "GET /repos/o/r/environments/b": envBody("b"),
      "GRAPHQL EnvironmentPins": pinsBody(["a", "b", "legacy"]),
    });
    const result = await check(api, [
      { name: "a", pinned: true },
      { name: "b", pinned: true },
    ]);
    // Also the diff-leak pin: a routed `pinned` reaching subsetDiff would
    // add an "environments[a].pinned: declared true ..." line here.
    expect(result.drift).toEqual([]);
    // legacy sits AFTER the declared block, so apply would not move it: no
    // interleaving note, check and apply agree exactly.
    expect(result.notes).toEqual([]);
  });

  test("hole-y live positions in rank order read clean, never as order drift", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/a": envBody("a"),
      "GET /repos/o/r/environments/b": envBody("b"),
      "GRAPHQL EnvironmentPins": pinsBody([
        { name: "a", position: 2 },
        { name: "b", position: 5 },
      ]),
    });
    const result = await check(api, [
      { name: "a", pinned: true },
      { name: "b", pinned: true },
    ]);
    expect(result.drift).toEqual([]);
  });

  test("an undeclared pin among the declared ranks earns the interleaving note in both modes", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/a": envBody("a"),
      "GRAPHQL EnvironmentPins": pinsBody(["legacy", "a"]),
    }).allowMutations("GRAPHQL ReorderEnvironment");
    const checked = await check(api, [{ name: "a", pinned: true }]);
    expect(checked.notes).toEqual([
      'pinned environment(s) "legacy" have no pinned declaration in the settings file; they stay pinned (only a pinned: false entry unpins) and apply moves them after the declared pins',
    ]);
    const applied = await apply(api, [{ name: "a", pinned: true }]);
    expect(applied.notes).toEqual(checked.notes);
    // Apply moves a left to rank 1; legacy is never unpinned.
    expect(graphqlWrites(api).map((c) => c.op)).toEqual(["ReorderEnvironment"]);
  });

  test("names match case-insensitively, like the section's natural key", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": envBody("PROD"),
      "GRAPHQL EnvironmentPins": pinsBody(["PROD"]),
    });
    const result = await check(api, [{ name: "prod", pinned: true }]);
    expect(result.drift).toEqual([]);
  });

  test("a tolerated NOT_FOUND on the pins read reads as no pins, never a permission error", async () => {
    // The fine-grained-denial disguise: GraphQL conceals a denied repository
    // as NOT_FOUND, which the pins read declares as an outcome - the same
    // absent posture as the section's REST probe, so check reports drift
    // and the denial surfaces on the first write in apply mode.
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": envBody("prod"),
      "GRAPHQL EnvironmentPins": {
        error: { status: 404, message: "Not Found", body: "", graphqlTypes: ["NOT_FOUND"] },
      },
    });
    const result = await check(api, [{ name: "prod", pinned: true }]);
    expect(result.drift).toEqual([
      "environments[prod].pinned: missing - declared pinned but the environment is not pinned on the repo; apply will pin it",
    ]);
  });
});

describe("environments pinned shape", () => {
  test("pinned parses as an optional boolean and rejects non-booleans", () => {
    const shape = environmentsSection.shape;
    expect(shape.safeParse([{ name: "prod", pinned: true }]).success).toBe(true);
    expect(shape.safeParse([{ name: "prod", pinned: false }]).success).toBe(true);
    expect(shape.safeParse([{ name: "prod" }]).success).toBe(true);
    expect(shape.safeParse([{ name: "prod", pinned: "yes" }]).success).toBe(false);
  });

  test("more than 10 pinned entries are rejected upfront, naming GitHub's cap", () => {
    const shape = environmentsSection.shape;
    const entries = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ name: `env-${i}`, pinned: true }));
    expect(shape.safeParse(entries(10)).success).toBe(true);
    const rejected = shape.safeParse(entries(11));
    expect(rejected.success).toBe(false);
    const issue = rejected.error?.issues[0];
    expect(issue?.message).toContain("GitHub allows at most 10 pinned environments per repository");
    // The issue points at the first entry OVER the cap.
    expect(issue?.path).toEqual([10, "pinned"]);
  });
});
