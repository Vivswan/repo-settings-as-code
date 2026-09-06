/**
 * A stateful GithubClient derived from a section's e2e mock fragment: requests route through the
 * pipeline's endpoint matching onto the same handlers over a seeded MockState, so a unit
 * idempotence proof runs against the mock's own transformers, not a second hand-written inverse.
 */

import type { ApiError, GithubClient } from "../../src/github/api.js";
import type { SectionMeta } from "../../src/sections/contract/module.js";
import { matchEndpoint } from "../e2e/mock/dispatch.js";
import { buildStateForSlug, type LiveState, type MockState } from "../e2e/mock/state.js";
import type { Handler } from "../e2e/mock/support.js";
import { REPO } from "./section-run.js";

export interface FragmentFake extends GithubClient {
  readonly state: MockState;
  /** Every non-GET request that reached a handler, as "METHOD /path". */
  readonly writes: string[];
}

/**
 * The fake over one section's handlers and a state seeded from `live`;
 * a request outside the section's own endpoints is refused as 404.
 */
export function fragmentFake(
  section: SectionMeta,
  handlers: Readonly<Record<string, Handler>>,
  live: LiveState,
): FragmentFake {
  const state = buildStateForSlug(REPO.slug, { settingsYaml: null, liveState: live }, "org");
  const writes: string[] = [];
  return {
    state,
    writes,
    async tryRequest(method, path, payload) {
      const url = new URL(path, "https://api.github.com");
      const matched = matchEndpoint(method, url.pathname);
      const handler = matched === null ? undefined : handlers[matched.key];
      if (matched === null || matched.endpoint.section !== section.key || handler === undefined) {
        return { error: { status: 404, message: `unexpected ${method} ${path}`, body: "" } };
      }
      if (method !== "GET") {
        writes.push(`${method} ${url.pathname}`);
      }
      const response = handler({
        state,
        endpoint: matched.endpoint,
        param: (name) => {
          const value = matched.params[name];
          if (value === undefined) {
            throw new Error(`fragmentFake: ${matched.endpoint.route} declares no "${name}" param`);
          }
          return value;
        },
        query: Object.fromEntries(url.searchParams),
        body: payload,
      });
      if (response.status >= 400) {
        const error: ApiError = {
          status: response.status,
          message: String((response.body as { message?: unknown } | null)?.message ?? ""),
          body: JSON.stringify(response.body),
        };
        return { error };
      }
      return { data: response.body };
    },
    async tryGraphql() {
      throw new Error(`${section.key} issues no GraphQL`);
    },
  };
}
