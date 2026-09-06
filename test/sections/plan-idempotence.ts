/**
 * The unit idempotence proof for a plan section: plan against a live fake,
 * execute the plan, plan again over the state the execution left behind,
 * and require the second plan to be empty except for the writes the
 * declarations say recur (alwaysRewrite). The per-section twin of the e2e
 * apply-idempotence proof, runnable in a unit test because the plan
 * contract separates deciding from doing.
 */

import { expect } from "bun:test";
import { executePlan } from "../../src/engine/execute.js";
import type { GithubClient } from "../../src/github/api.js";
import type { SectionModule } from "../../src/sections/contract/module.js";
import { type ExecTools, planContext, type SectionPlan } from "../../src/sections/contract/plan.js";
import { NO_SECRETS, REPO } from "./section-run.js";

/** The marker a thunk folds to; a symbol, so no literal value can collide with it. */
const SEALED = Symbol("a thunk the plan builds afresh on every pass");

/**
 * One planned operation's IDENTITY, as comparing two planning passes needs
 * it: every facet but the payload and variables, which a section may build
 * as a thunk (a fresh closure per pass, unequal by reference and opaque to
 * a value comparison). A thunk's identity is that it exists - what it seals
 * is a secret the plan is not allowed to expose - so it folds to a marker,
 * as does a change thunk (it renders from a response the plan has not
 * seen). A capture hook counts by presence, as does a before hook (what it
 * reads is execution-time state), a tolerance by its statuses.
 */
export function identityOf(op: SectionPlan["ops"][number]): unknown {
  const sealed = (value: unknown): unknown => (typeof value === "function" ? SEALED : value);
  return {
    role: op.role,
    params: op.params,
    query: op.query,
    payload: sealed(op.payload),
    variables: sealed(op.variables),
    drift: op.drift,
    change: sealed(op.change),
    describe: op.describe,
    capture: op.capture !== undefined,
    before: op.before !== undefined,
    tolerate: op.tolerate === undefined ? undefined : { statuses: op.tolerate.statuses },
  };
}

/** The request half of an operation's identity: what it sends, not what it renders. */
export function requestOf(op: SectionPlan["ops"][number]): unknown {
  const {
    drift: _drift,
    change: _change,
    describe: _describe,
    capture: _capture,
    ...request
  } = identityOf(op) as Record<string, unknown>;
  return request;
}

/** A plan compared as a value: its operation identities, notes, and drift. */
function shapeOf(plan: SectionPlan): unknown {
  return { ops: plan.ops.map(identityOf), notes: plan.notes, drift: plan.drift };
}

/**
 * Plan, execute, re-plan, execute again over a STATEFUL fake. The second plan may carry only the
 * alwaysRewrite ops (all of them, request for request) and unverifiable ops whose lines converged;
 * op-less drift survives; a third plan matches the second. `tools` defaults to refusing every lookup.
 */
export async function provePlanIdempotent<M extends SectionModule>(
  section: M,
  api: GithubClient,
  desired: Parameters<M["plan"]>[1],
  tools: ExecTools = NO_SECRETS,
): Promise<{
  first: SectionPlan;
  second: SectionPlan;
  changes: readonly string[];
  notes: readonly string[];
}> {
  const plan = async (): Promise<SectionPlan> =>
    section.plan(planContext(section, api, REPO), desired);
  const execute = async (
    of: SectionPlan,
  ): Promise<{ changes: readonly string[]; notes: readonly string[] }> => {
    const execution = await executePlan(of, section, api, REPO, tools);
    if (execution.status === "failed") {
      throw execution.error;
    }
    return execution;
  };
  // An alwaysRewrite operation recurs whatever the live state, so across
  // passes its identity is the REQUEST it issues, not what it renders: the
  // first pass may render "created" where the second renders "updated".
  const rewrites = (of: SectionPlan): unknown[] =>
    of.ops.filter((op) => section.endpoints[op.role]?.alwaysRewrite === true).map(requestOf);

  const first = await plan();
  // One op per execution keeps each op's lines attributable: a tolerated op
  // renders a note and no line, a string change exactly itself (a thunk's
  // lines are the executor's contract). The executor carries no state across ops.
  const changes: string[] = [];
  const notes: string[] = [];
  for (const op of first.ops) {
    const execution = await execute({ ops: [op], notes: [], drift: [] });
    if (execution.notes.length > 0) {
      expect(
        execution.changes,
        `${section.key}: a tolerated operation rendered a change line beside its note`,
      ).toEqual([]);
    } else if (typeof op.change === "string") {
      expect(execution.changes).toEqual([op.change]);
    }
    changes.push(...execution.changes);
    notes.push(...execution.notes);
  }

  const second = await plan();
  // An unverifiable op recurs for its facet alone: any drift line it still
  // carries is state the execution should have converged.
  expect(
    second.ops
      .filter(
        (op) =>
          section.endpoints[op.role]?.alwaysRewrite !== true &&
          !("unverifiable" in op.drift && op.drift.lines.length === 0),
      )
      .map(identityOf),
    `${section.key}: the plan over just-applied state still carries operations that are neither alwaysRewrite by declaration nor unverifiable, so apply would not converge`,
  ).toEqual([]);
  expect(
    rewrites(second),
    `${section.key}: an alwaysRewrite operation the first plan issued is missing from the second - those writes recur by contract (their value cannot be read back), so a plan that drops one has started comparing state it cannot see`,
  ).toEqual(rewrites(first));
  expect(second.drift).toEqual(first.drift);

  // State stability: executing the converged plan (one op at a time, as
  // above) changes nothing a third plan can see.
  for (const op of second.ops) {
    await execute({ ops: [op], notes: [], drift: [] });
  }
  const third = await plan();
  expect(
    shapeOf(third),
    `${section.key}: re-executing the converged plan changed what the next plan sees, so the section oscillates instead of settling`,
  ).toEqual(shapeOf(second));
  return { first, second, changes, notes };
}
