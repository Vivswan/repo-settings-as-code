/** Shared fetch stubbing for the github/ client tests. */

import { GithubApi } from "../../src/github/api.js";

const realFetch = globalThis.fetch;

export function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

/** Stub fetch with a fixed response sequence (last one repeats); count calls. */
export function stubFetch(responses: Array<() => Response>): { calls: number } {
  const state = { calls: 0 };
  globalThis.fetch = (async () => {
    const make = responses[Math.min(state.calls, responses.length - 1)];
    state.calls++;
    if (!make) {
      throw new Error("no stubbed response");
    }
    return make();
  }) as unknown as typeof fetch;
  return state;
}

// retryAfterBaseValue: 1 turns every plugin wait into milliseconds.
export const api = () => new GithubApi("t", "https://api.test", "2022-11-28", 1);
