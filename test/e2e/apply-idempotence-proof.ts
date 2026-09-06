/**
 * The apply-idempotence proof engine: the state snapshots, the write classifiers over recurrence()
 * (apply-idempotence.ts), the corpus-level witness, and assertApplyIdempotent, the re-run driver
 * runScenario invokes for expect.fixpoint: "apply_idempotent" through the runner's ChildInvoker.
 */

import { isIssueChannel } from "../../src/action/redact.js";
import {
  ALWAYS_REWRITE_STATE_FAMILIES,
  recurrence,
  recurringEndpointKeys,
} from "./apply-idempotence.js";
import { type LoggedRequest, renderRequest } from "./mock/contract.js";
import { endpointForRequest, isWriteRequest, sectionForRequest } from "./mock/dispatch.js";
import type { MockHandle } from "./mock/server.js";
import type { MockState } from "./mock/state.js";
import type { Scenario } from "./schema.js";

/** The result of one child process invocation against a running mock. */
export interface Invocation {
  exitCode: number;
  outputs: Record<string, string>;
  summary: string;
  stdout: string;
  stderr: string;
  /** True when the harness's kill timer terminated the child. */
  killedByHarness: boolean;
}

/**
 * One INTERNAL re-run's captured output surfaces: the convergence check, or
 * apply_idempotent's second apply and its final check. Shape-compatible with
 * checkLeaks' observed argument, so an invariant sweeps a re-run exactly the
 * way it sweeps the primary invocation - a leak conditional on check mode or
 * on converged state only ever appears here.
 */
export interface RerunCapture {
  /** Which re-run produced this (e.g. "converges check"). */
  label: string;
  stdout: string;
  stderr: string;
  summary: string;
  outputs: Record<string, string>;
}

/** Capture an internal re-run's surfaces for the report (see RerunCapture). */
export function captureRerun(label: string, run: Invocation): RerunCapture {
  return {
    label,
    stdout: run.stdout,
    stderr: run.stderr,
    summary: run.summary,
    outputs: run.outputs,
  };
}

/**
 * The runner-owned spawn seam the proof engine drives re-runs through:
 * `invoke` runs one child against the SAME mock and temp dir the primary
 * invocation used, and `killNote` renders the harness-kill suffix for an
 * exit-code failure line (the kill cap is the runner's own constant).
 */
export interface ChildInvoker {
  invoke(scenario: Scenario): Promise<Invocation>;
  killNote(run: Invocation): string;
}

/**
 * One labeled entry per mutable state the mock holds: the single-repo state,
 * or every per-slug repo state plus the shared org state in multi mode. The
 * multi settings/permissions maps and the discovery pool are run CONFIG the
 * pipeline never mutates, so they are not part of the stability snapshot.
 */
function mutableStates(handle: MockHandle): Array<[string, MockState]> {
  const working = handle.working;
  switch (working.mode) {
    case "single":
      return [["state", working.state]];
    case "multi":
      return [...working.multi.repos, ["(org)", working.multi.orgState]];
  }
}

/** An always-rewrite family entry with its server-managed updated_at dropped. */
function dropUpdatedAt(entry: unknown): unknown {
  return typeof entry === "object" && entry !== null
    ? { ...(entry as Record<string, unknown>), updated_at: undefined }
    : entry;
}

/**
 * Project one always-rewrite family for the stability snapshot: updated_at is
 * dropped from every item, since these sections legitimately move it on every
 * apply; created_at stays IN, so a delete-and-recreate on the second apply
 * still reads as churn. The repository-level families store a flat item list;
 * environment_secrets nests one list per environment name.
 */
function projectAlwaysRewrite(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(dropUpdatedAt);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        Array.isArray(nested) ? nested.map(dropUpdatedAt) : nested,
      ]),
    );
  }
  return value;
}

/**
 * Serialize every mutable state family to a "label.family" -> JSON map, so a
 * before/after comparison can name exactly which repo and family moved instead
 * of reporting one opaque inequality. Underscore-prefixed families are mock
 * bookkeeping (e.g. the secret write counter), not repo state. The
 * always-rewrite families (ALWAYS_REWRITE_STATE_FAMILIES, the explicit list
 * in apply-idempotence.ts) drop updated_at via projectAlwaysRewrite.
 */
function snapshotFamilies(handle: MockHandle): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const [label, state] of mutableStates(handle)) {
    for (const [family, value] of Object.entries(state)) {
      if (family.startsWith("_")) {
        continue;
      }
      const projected = ALWAYS_REWRITE_STATE_FAMILIES.has(family)
        ? projectAlwaysRewrite(value)
        : value;
      snapshot.set(`${label}.${family}`, JSON.stringify(projected));
    }
  }
  return snapshot;
}

/**
 * The "label.family" keys whose serialized state differs between two
 * snapshots, including keys present on only one side. Exported for direct
 * testing, so the state-stability assertion is provably able to fire.
 */
export function changedFamilies(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((key) => before.get(key) !== after.get(key))
    .sort();
}

/**
 * One failure per second-apply write that is outside every section endpoint or on an endpoint whose
 * recurrence is "never": every section compares before writing, so only an alwaysRewrite endpoint
 * or one carrying an unverifiable value may be written again over converged state.
 */
export function secondApplyWriteFailures(writes: LoggedRequest[]): string[] {
  const failures: string[] = [];
  for (const write of writes) {
    const section = sectionForRequest(write.method, write.pathname, write.body);
    if (section === null) {
      failures.push(
        `apply-idempotence: second apply wrote outside any section endpoint: ${renderRequest(write, false)}`,
      );
      continue;
    }
    const endpoint = endpointForRequest(write.method, write.pathname);
    if (endpoint !== null && recurrence(endpoint) !== "never") {
      continue;
    }
    failures.push(
      `apply-idempotence: second apply wrote to "${section}" (${renderRequest(write, false)}), but the live state already matched and only an alwaysRewrite endpoint or an unverifiable write may recur`,
    );
  }
  return failures;
}

/**
 * Per exempt endpoint ("section.role", recurrence "always" or "may"), how many writes the corpus's
 * first and second applies issued to it. Corpus-level on purpose: one scenario can legitimately go
 * second-apply-quiet on an exempt endpoint, but across the corpus each exemption must be witnessed.
 */
export type ExemptWriteWitness = Map<string, { first: number; second: number }>;

/** The witness map THIS process's idempotence re-runs accumulate into. */
const corpusWriteWitness: ExemptWriteWitness = new Map();

/** Accumulate one idempotence re-run's exempt writes; pure over its arguments so the verdict is testable. */
export function recordExemptWrites(
  witness: ExemptWriteWitness,
  firstWrites: LoggedRequest[],
  secondWrites: LoggedRequest[],
): void {
  const bump = (writes: LoggedRequest[], side: "first" | "second"): void => {
    for (const write of writes) {
      const endpoint = endpointForRequest(write.method, write.pathname);
      if (endpoint === null || recurrence(endpoint) === "never") {
        continue;
      }
      const key = `${endpoint.section}.${endpoint.role}`;
      const counts = witness.get(key) ?? { first: 0, second: 0 };
      counts[side]++;
      witness.set(key, counts);
    }
  };
  bump(firstWrites, "first");
  bump(secondWrites, "second");
}

/**
 * The corpus-level verdict: every exempt endpoint is written by some first apply (a wrong flag or
 * exemption would otherwise go uncontradicted), and every section exempting unverifiable writes
 * has some second apply re-issue one of them (the "may" recurrence is live, not a stale exemption).
 */
export function unwitnessedExemptEndpoints(witness: ExemptWriteWitness): string[] {
  const failures: string[] = [];
  const unwitnessed = (key: string, how: string): void => {
    failures.push(
      `apply-idempotence corpus: "${key}" is ${how} but NO apply_idempotent scenario writes to ` +
        `it on a first apply, so a wrong exemption would go uncontradicted - declare its section ` +
        `in an apply_idempotent scenario (e.g. apply-idempotent-unconditional.yml)`,
    );
  };
  for (const key of recurringEndpointKeys("always")) {
    if ((witness.get(key)?.first ?? 0) === 0) {
      unwitnessed(key, "alwaysRewrite by declaration");
    }
  }
  const bySection = new Map<string, { keys: string[]; first: number; second: number }>();
  for (const key of recurringEndpointKeys("may")) {
    const counts = witness.get(key) ?? { first: 0, second: 0 };
    if (counts.first === 0) {
      unwitnessed(key, "exempt as an unverifiable write");
    }
    const section = key.slice(0, key.indexOf("."));
    const group = bySection.get(section) ?? { keys: [], first: 0, second: 0 };
    group.keys.push(key);
    group.first += counts.first;
    group.second += counts.second;
    bySection.set(section, group);
  }
  for (const [section, group] of bySection) {
    if (group.first > 0 && group.second === 0) {
      failures.push(
        `apply-idempotence corpus: "${section}" exempts [${group.keys.join(", ")}] as ` +
          `unverifiable writes, but no second apply in the corpus re-issued any of them - either ` +
          `the section now compares before writing (drop the exemption) or the corpus lost its ` +
          `witness`,
      );
    }
  }
  return failures.sort();
}

/**
 * The verdict over the writes this process recorded. run.ts consults it after the FULL corpus only:
 * a --sections or --scenario slice legitimately starves endpoints.
 */
export function corpusUnwitnessedExemptEndpoints(): string[] {
  return unwitnessedExemptEndpoints(corpusWriteWitness);
}

/**
 * The always-rewrite half of the idempotence proof: every write the first
 * apply issued on an `alwaysRewrite` endpoint (resolved per logged request)
 * must recur on the second, request line for request line and count for count.
 */
export function missingSecondApplyRewrites(
  firstWrites: LoggedRequest[],
  secondWrites: LoggedRequest[],
): string[] {
  // The request line (method, path, query) and its count are the identity:
  // a same-path DELETE is not a re-issued PUT, and N writes must recur N
  // times. The body is excluded: a sealed ciphertext differs per seal.
  const isAlwaysRewrite = (request: LoggedRequest): boolean =>
    endpointForRequest(request.method, request.pathname)?.alwaysRewrite === true;
  const counts = (writes: LoggedRequest[]): Map<string, number> => {
    const tally = new Map<string, number>();
    for (const request of writes.filter(isAlwaysRewrite)) {
      const key = renderRequest(request, true);
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    return tally;
  };
  const first = counts(firstWrites);
  const second = counts(secondWrites);
  return [...new Set([...first.keys(), ...second.keys()])]
    .filter((request) => (first.get(request) ?? 0) !== (second.get(request) ?? 0))
    .sort()
    .map(
      (request) =>
        `apply-idempotence: the first apply wrote ${request} ${first.get(request) ?? 0} ` +
        `time(s) and the second ${second.get(request) ?? 0}; an alwaysRewrite endpoint is ` +
        `re-issued on EVERY apply by declaration (a sealed secret cannot be read back, a ` +
        `self-expiring limit is re-armed, an unreadable toggle is re-asserted)`,
    );
}

/**
 * The apply-idempotence proof (expect.fixpoint: "apply_idempotent"): the second apply exits 0, writes
 * only where recurrence() allows, leaves every state family byte-stable, and a final check run reads
 * back clean. Issue report channels are rejected: their report moves state and the marker label every run.
 */
export async function assertApplyIdempotent(
  scenario: Scenario,
  handle: MockHandle,
  child: ChildInvoker,
): Promise<{ failures: string[]; reruns: RerunCapture[] }> {
  if (scenario.inputs?.mode === "check") {
    return { failures: ["apply_idempotent requires an apply-mode scenario"], reruns: [] };
  }
  const channel = scenario.inputs?.private_report;
  if (channel !== undefined && isIssueChannel(channel)) {
    return {
      failures: [
        `apply_idempotent cannot run under private_report: ${channel} - the report issue embeds a fresh timestamp (state moves every run) and the injected marker label ties the labels declaration to the channel; use private_report: none or artifact`,
      ],
      reruns: [],
    };
  }
  const failures: string[] = [];
  const reruns: RerunCapture[] = [];
  const rerun: Scenario = { ...scenario, inputs: { ...scenario.inputs, mode: "apply" } };
  const before = snapshotFamilies(handle);
  const requestsBefore = handle.requests.length;
  const violationsBefore = handle.violations.length;

  const second = await child.invoke(rerun);
  reruns.push(captureRerun("apply-idempotence second apply", second));
  if (second.exitCode !== 0) {
    failures.push(
      `apply-idempotence: second apply exited ${second.exitCode}, expected 0${child.killNote(second)}`,
    );
  }
  const secondViolations = handle.violations.slice(violationsBefore);
  if (secondViolations.length > 0) {
    failures.push(`apply-idempotence: mock violations:\n  ${secondViolations.join("\n  ")}`);
  }
  const writes = handle.requests.slice(requestsBefore).filter(isWriteRequest);
  failures.push(...secondApplyWriteFailures(writes));
  const firstWrites = handle.requests.slice(0, requestsBefore).filter(isWriteRequest);
  failures.push(...missingSecondApplyRewrites(firstWrites, writes));
  recordExemptWrites(corpusWriteWitness, firstWrites, writes);
  const changed = changedFamilies(before, snapshotFamilies(handle));
  if (changed.length > 0) {
    failures.push(`apply-idempotence: second apply changed mock state: ${changed.join(", ")}`);
  }

  // A converged apply must read back clean: check mode, exit 0, zero writes.
  const checkRequestsBefore = handle.requests.length;
  const checkViolationsBefore = handle.violations.length;
  handle.enterCheckMode();
  const check = await child.invoke({ ...rerun, inputs: { ...rerun.inputs, mode: "check" } });
  reruns.push(captureRerun("apply-idempotence check", check));
  if (check.exitCode !== 0) {
    failures.push(
      `apply-idempotence: the check run after the second apply exited ${check.exitCode}, expected 0${child.killNote(check)}`,
    );
  }
  const checkWrites = handle.requests.slice(checkRequestsBefore).filter(isWriteRequest);
  if (checkWrites.length > 0) {
    failures.push(
      `apply-idempotence: the check run wrote ${checkWrites.length} time(s): ${checkWrites.map((r) => renderRequest(r, false)).join(", ")}`,
    );
  }
  const checkViolations = handle.violations.slice(checkViolationsBefore);
  if (checkViolations.length > 0) {
    failures.push(
      `apply-idempotence: check-run mock violations:\n  ${checkViolations.join("\n  ")}`,
    );
  }
  return { failures, reruns };
}
