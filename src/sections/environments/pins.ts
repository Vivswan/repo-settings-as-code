/**
 * Pinned environments (the routed `pinned` scalar): the pins GraphQL
 * operations and the pin/unpin/reorder planning. plan() gates the call on a
 * declared `pinned` key, so a pin-free settings file stays REST-only and
 * never touches /graphql.
 */

import { repoVariables } from "../contract/endpoints.js";
import { type GraphqlOpDecl, graphqlOp } from "../contract/graphql.js";
import type { PlanContext, PlannedOp, SectionPlan } from "../contract/plan.js";
import type { ENDPOINTS } from "./endpoints.js";
import { MAX_PINNED_ENVIRONMENTS } from "./schema.js";

const PINS_QUERY = graphqlOp<{ owner: string; repo: string }>()({
  name: "EnvironmentPins",
  kind: "read",
  query:
    "query EnvironmentPins($owner: String!, $repo: String!, $cursor: String) { repository(owner: $owner, name: $repo) { pinnedEnvironments(first: 100, after: $cursor) { nodes { position environment { name } } pageInfo { hasNextPage endCursor } } } }",
  connection: { path: ["repository", "pinnedEnvironments"] },
  outcomes: {
    ok: "the pinned environments with their 1-based positions",
    NOT_FOUND:
      "the repository is not visible to the token; read as no pins (the denial surfaces on the first pin write)",
  },
});

/**
 * Pin or unpin one environment by the node id its REST body carries. Verified
 * live: a new pin lands at the TAIL (so appends are modelled locally), and
 * UNPROCESSABLE is GitHub's cap rejection, the belt under the plan's own gate.
 */
const PIN_ENVIRONMENT = graphqlOp<{ environmentId: string; pinned: boolean }>()({
  name: "PinEnvironment",
  kind: "write",
  query:
    "mutation PinEnvironment($environmentId: ID!, $pinned: Boolean!) { pinEnvironment(input: { environmentId: $environmentId, pinned: $pinned }) { environment { name isPinned } } }",
  outcomes: {
    ok: "the environment was pinned or unpinned",
    UNPROCESSABLE:
      `the repository already holds ${MAX_PINNED_ENVIRONMENTS} pinned environments (GitHub's ` +
      `cap), so this pin was rejected; pins without a pinned declaration are left untouched, so ` +
      `declare pinned: false on entries for some of the currently pinned environments, or unpin ` +
      `them in the GitHub UI`,
  },
});

/**
 * Move one pinned environment to a 1-based RANK; verified against live
 * GitHub, this is also the only mutation that renormalizes the position
 * numbers (the whole list reads back contiguous afterwards). The reconciler
 * only ever moves a pin LEFT (toward rank 1), where remove-and-insert
 * semantics are unambiguous.
 */
const REORDER_ENVIRONMENT = graphqlOp<{ environmentId: string; position: number }>()({
  name: "ReorderEnvironment",
  kind: "write",
  query:
    "mutation ReorderEnvironment($environmentId: ID!, $position: Int!) { reorderEnvironment(input: { environmentId: $environmentId, position: $position }) { environment { name } } }",
  outcomes: { ok: "the pinned environment moved to its declared position" },
});

export const GRAPHQL_OPS = {
  pins: PINS_QUERY,
  pin: PIN_ENVIRONMENT,
  reorder: REORDER_ENVIRONMENT,
} as const satisfies Record<string, GraphqlOpDecl>;

/** The section's full plan context: the REST read port plus the pins read. */
export type EnvironmentsPlanContext = PlanContext<typeof ENDPOINTS, typeof GRAPHQL_OPS>;

/** A planned operation of this section, REST or GraphQL. */
export type EnvironmentsOp = PlannedOp<typeof ENDPOINTS, typeof GRAPHQL_OPS>;

/** What plan() returns for this section. */
export type EnvironmentsPlan = SectionPlan<EnvironmentsOp>;

/** One entry's declared pin state, in settings-file order. */
export interface PinDeclaration {
  name: string;
  pinned: boolean;
  /**
   * The node id off the body the plan has for the environment (the probe, or a
   * created environment's PUT response once run); throws when the body lacks it.
   */
  nodeId: () => string;
}

/** The fields of one live pin this section reads off the pins connection. */
interface LivePin {
  /**
   * The ordering sort key. Verified against live GitHub as possibly
   * NON-CONTIGUOUS (unpinning leaves a hole, a new pin appends via a
   * monotonic counter; only a reorder renormalizes), so it is never compared
   * as a literal slot number - only its RANK in the sorted list matters.
   */
  position: number;
  /** The pinned environment's name. */
  name: string;
}

/**
 * One pins-connection node, with the identity fields extracted loudly (the
 * livePolicyName posture): a pin without a numeric position and a name has
 * no identity to reconcile by, and silently skipping it would let check
 * report falsely clean while apply reordered blind.
 */
function livePin(node: unknown): LivePin {
  const pin = node as { position?: unknown; environment?: { name?: unknown } } | null;
  const position = pin?.position;
  const name = pin?.environment?.name;
  if (typeof position !== "number" || typeof name !== "string") {
    throw new Error(
      `environments: the pinned-environments listing returned a pin node this section cannot ` +
        `read (${JSON.stringify(node) ?? String(node)}): it needs a numeric "position" and an ` +
        `"environment.name" string, so the declared pins cannot be reconciled. Check the ` +
        `"api-version" input against the GitHub GraphQL reference for pinnedEnvironments`,
    );
  }
  return { position, name };
}

/**
 * The live pins in rank order (sorted by their position field). A tolerated
 * NOT_FOUND - how GraphQL delivers a fine-grained denial on the repository -
 * reads as "no pins", the same absent posture as the section's REST probe,
 * so the denial surfaces on the first pin write instead of failing the read
 * pass.
 */
async function listLivePins(ctx: EnvironmentsPlanContext): Promise<LivePin[]> {
  const listed = await ctx.read.pins.listConnection(repoVariables(ctx));
  if ("error" in listed) {
    return [];
  }
  return listed.items.map(livePin).sort((a, b) => a.position - b.position);
}

/** The pin key: environment names are case-insensitive, like the natural key. */
function pinKey(name: string): string {
  return name.toLowerCase();
}

/**
 * The complete mutation plan for the declared pin states against one live
 * pinned list - a PURE computation, shared by both modes: check renders its
 * drift lines from the plan and apply executes exactly the plan's mutations,
 * so the two cannot disagree about what apply would do. Semantics: the
 * entries declaring `pinned: true` must LEAD the pinned list in declaration
 * order (compared by rank - live position numbers may carry holes);
 * `pinned: false` unpins; pins with no declared pin state are never
 * unpinned, and when one sits among the leading ranks the declared block
 * claims, apply moves it after them (`interleaved`, surfaced as a note in
 * both modes).
 *
 * The reorders are simulated here against the post-unpin, post-append order:
 * pins append at the TAIL (verified live behavior), and each reorder pulls
 * desired[i] LEFT into rank i+1 - by the time rank i is considered, ranks
 * 0..i-1 already hold desired[0..i-1], so the target can only sit further
 * right, making remove-then-insert semantics unambiguous and one mutation
 * per out-of-place pin sufficient.
 */
function planPins(
  declarations: readonly PinDeclaration[],
  live: readonly LivePin[],
): {
  /** Display names to unpin (declared pinned: false AND live-pinned). */
  unpins: string[];
  /** Display names to pin (declared pinned: true, not live), file order. */
  pins: string[];
  /** The reorder mutations, each a leftward move to a 1-based rank. */
  reorders: Array<{ name: string; rank: number }>;
  /** Live pins with no declared pin state sitting among the leading ranks. */
  interleaved: string[];
  /** The pinned count once the plan has run (never transiently exceeded). */
  finalCount: number;
  /** The live names in rank order, for the order-drift line. */
  liveOrder: string[];
} {
  const desired = declarations.filter((entry) => entry.pinned).map((entry) => entry.name);
  const desiredKeys = new Set(desired.map(pinKey));
  const unpinKeys = new Set(
    declarations.filter((entry) => !entry.pinned).map((entry) => pinKey(entry.name)),
  );
  const liveKeys = new Set(live.map((pin) => pinKey(pin.name)));

  const unpins = declarations
    .filter((entry) => !entry.pinned && liveKeys.has(pinKey(entry.name)))
    .map((entry) => entry.name);
  const pins = desired.filter((name) => !liveKeys.has(pinKey(name)));

  // The rank order once the unpins are gone and the missing pins have
  // appended at the tail - the exact state the reorder loop starts from.
  const postUnpin = live
    .filter((pin) => !unpinKeys.has(pinKey(pin.name)))
    .map((pin) => pinKey(pin.name));
  const order = [...postUnpin, ...pins.map(pinKey)];

  const interleaved = live
    .filter(
      (pin) =>
        !desiredKeys.has(pinKey(pin.name)) &&
        !unpinKeys.has(pinKey(pin.name)) &&
        postUnpin.indexOf(pinKey(pin.name)) < desired.length,
    )
    .map((pin) => pin.name);

  const reorders: Array<{ name: string; rank: number }> = [];
  desired.forEach((name, index) => {
    const key = pinKey(name);
    if (order[index] === key) {
      return;
    }
    reorders.push({ name, rank: index + 1 });
    order.splice(order.indexOf(key), 1);
    order.splice(index, 0, key);
  });

  return {
    unpins,
    pins,
    reorders,
    interleaved,
    finalCount: postUnpin.length + pins.length,
    liveOrder: live.map((pin) => pin.name),
  };
}

/**
 * The node id of every environment the plan will mutate, resolved by the
 * FIRST pin thunk (after every environment PUT): a body without node_id fails
 * with zero pins half-applied, and a converged pin state never resolves one.
 */
function resolvePinIds(
  declarations: readonly PinDeclaration[],
  names: readonly string[],
): ReadonlyMap<string, string> {
  const byKey = new Map(declarations.map((entry) => [pinKey(entry.name), entry]));
  return new Map(
    names.map((name) => {
      const declaration = byKey.get(pinKey(name));
      if (declaration === undefined) {
        throw new Error(
          `BUG: environments: a pin mutation was planned for "${name}", which no entry declares a pin state for`,
        );
      }
      return [pinKey(name), declaration.nodeId()];
    }),
  );
}

/** An environment body's `node_id` field as a string, or the loud error when it is not one. */
export function environmentNodeId(name: string, body: unknown): string {
  const nodeId = nodeIdField(body);
  if (typeof nodeId !== "string") {
    throw new Error(
      `environments: the environment body for "${name}" carried no node_id, so its pin cannot be reconciled. Check the "api-version" input against the GitHub REST docs for the environments endpoint`,
    );
  }
  return nodeId;
}

/** The `node_id` field of a body, unvalidated: the one value a plan keeps off a body. */
export function nodeIdField(body: unknown): unknown {
  return (body as { node_id?: unknown } | null | undefined)?.node_id;
}

/**
 * Plan the declared pin states from planPins in cap-safe order (unpins, pins,
 * leftward reorders); the live overflow is a note in both modes and fails the
 * first pin thunk, and order drift is one section-level line plus continuations.
 */
export async function planPinned(
  ctx: EnvironmentsPlanContext,
  declarations: readonly PinDeclaration[],
): Promise<{ ops: EnvironmentsOp[]; notes: string[] }> {
  const desired = declarations.filter((entry) => entry.pinned).map((entry) => entry.name);
  const live = await listLivePins(ctx);
  const plan = planPins(declarations, live);
  const ops: EnvironmentsOp[] = [];
  const notes: string[] = [];

  if (plan.interleaved.length > 0) {
    notes.push(
      `pinned environment(s) ${plan.interleaved.map((name) => `"${name}"`).join(", ")} have no pinned declaration in the settings file; they stay pinned (only a pinned: false entry unpins) and apply moves them after the declared pins`,
    );
  }
  const overflow =
    plan.finalCount > MAX_PINNED_ENVIRONMENTS
      ? `pinning the ${plan.pins.length} declared environment(s) not yet pinned would leave ` +
        `${plan.finalCount} environments pinned, but GitHub allows at most ` +
        `${MAX_PINNED_ENVIRONMENTS}. Pins without a pinned declaration are left untouched, so ` +
        `declare pinned: false on entries for some of the currently pinned environments, or ` +
        `unpin them in the GitHub UI`
      : undefined;
  if (overflow !== undefined) {
    notes.push(`apply will fail: ${overflow}`);
  }

  // The gate every mutation's thunk passes: the overflow refusal, then the
  // ids of EVERY planned mutation, resolved once and shared.
  let ids: ReadonlyMap<string, string> | undefined;
  const idOf = (name: string): string => {
    if (overflow !== undefined) {
      throw new Error(`environments: ${overflow}`);
    }
    ids ??= resolvePinIds(declarations, [
      ...plan.unpins,
      ...plan.pins,
      ...plan.reorders.map((reorder) => reorder.name),
    ]);
    const id = ids.get(pinKey(name));
    if (id === undefined) {
      throw new Error(
        `BUG: environments: no node id was resolved for the pin mutation of "${name}"`,
      );
    }
    return id;
  };

  for (const name of plan.unpins) {
    ops.push({
      role: "pin",
      variables: () => ({ environmentId: idOf(name), pinned: false }),
      drift: [
        `environments[${name}].pinned: pinned on the repo but declared pinned: false; apply will unpin it`,
      ],
      change: `unpinned environment "${name}"`,
      describe: `unpinning environment "${name}"`,
    });
  }
  for (const name of plan.pins) {
    ops.push({
      role: "pin",
      variables: () => ({ environmentId: idOf(name), pinned: true }),
      drift: [
        `environments[${name}].pinned: missing - declared pinned but the environment is not pinned on the repo; apply will pin it`,
      ],
      change: `pinned environment "${name}"`,
      describe: `pinning environment "${name}"`,
    });
  }
  plan.reorders.forEach(({ name, rank }, index) => {
    ops.push({
      role: "reorder",
      variables: () => ({ environmentId: idOf(name), position: rank }),
      drift: [
        index === 0
          ? `environments.pinned: the declared pin order is [${desired.join(", ")}] but the live pinned order is [${plan.liveOrder.join(", ")}]; apply will reorder the pins so the declared ones lead in declaration order`
          : `environments.pinned: apply will also move "${name}" to position ${rank} in that reordering`,
      ],
      change: `moved pinned environment "${name}" to position ${rank}`,
      describe: `moving pinned environment "${name}" to position ${rank}`,
    });
  });
  return { ops, notes };
}
