/**
 * The per-section unit-test bench: the one target every suite addresses, the
 * execution tools a section's plan runs under, and plan / check / apply bound
 * to one section.
 */

import { executePlan } from "../../src/engine/execute.js";
import type { GithubClient } from "../../src/github/api.js";
import type { SectionModule } from "../../src/sections/contract/module.js";
import { type ExecTools, planContext, planDrift } from "../../src/sections/contract/plan.js";

/** The one target every per-section unit test addresses. */
export const REPO = { owner: "o", name: "r", slug: "o/r" } as const;

/**
 * Execution tools for a section that declares no secret values: any lookup
 * is a bug, exactly as the engine's empty-map resolver treats it.
 */
export const NO_SECRETS: ExecTools = {
  resolveSecret(reference) {
    throw new Error(
      `BUG: secret reference ${reference} was not resolved up front; the engine resolves every declared secret value before any section runs`,
    );
  },
};

/** Execution tools over a fixed reference -> plaintext table, like the engine's. */
export function secretTools(resolved: Record<string, string>): ExecTools {
  return {
    resolveSecret(reference) {
      const plaintext = resolved[reference];
      if (plaintext === undefined) {
        throw new Error(`test resolver has no value for ${reference}`);
      }
      return plaintext;
    },
  };
}

/**
 * The three verbs a section suite drives against a fake client: `plan` over
 * the read port bound to `api` (reads only), `check` as check mode renders it
 * (the plan's drift lines and notes), and `apply` end to end (plan, then
 * execute; a failed operation rethrows).
 */
export function sectionRunners<M extends SectionModule>(section: M) {
  type Desired = Parameters<M["plan"]>[1];
  // Calling through the constraint would widen the plan to its erased op type;
  // the section's own plan type is what the suites assert against.
  const plan = (api: GithubClient, desired: Desired) =>
    section.plan(planContext(section, api, REPO), desired) as ReturnType<M["plan"]>;
  const check = async (api: GithubClient, desired: Desired) => {
    const planned = await plan(api, desired);
    return { drift: planDrift(planned), notes: planned.notes };
  };
  const apply = async (api: GithubClient, desired: Desired, tools: ExecTools = NO_SECRETS) => {
    const planned = await plan(api, desired);
    const execution = await executePlan(planned, section, api, REPO, tools);
    if (execution.status === "failed") {
      throw execution.error;
    }
    return { changes: execution.changes, notes: planned.notes };
  };
  return { plan, check, apply };
}
