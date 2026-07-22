/**
 * The mock GitHub API server: one fresh Bun.serve per scenario, listening on an
 * ephemeral port. All request logic lives in routes.ts (the pure pipeline);
 * this file is the transport shell that parses the incoming Request, hands it
 * to the pipeline, records the log/violation, and serializes the response.
 *
 * The MockHandle a caller receives exposes the base URL to point the action's
 * client at, the live MockState (to seed or assert against), and the request
 * and violation logs the runner checks after the run.
 */

import type { Scenario } from "../schema.js";
import {
  assertHandlerCompleteness,
  type CorruptOption,
  type LoggedRequest,
  runPipeline,
} from "./routes.js";
import { buildState, type MockState } from "./state.js";

/** Extra knobs beyond the scenario: the GHES prefix and the chaos directive. */
export interface ServerOptions {
  /** GHES-style path prefix every request must carry (e.g. "/api/v3"). */
  basePrefix?: string;
  /** Corrupt the first response of one endpoint, to prove loud client failure. */
  corrupt?: CorruptOption;
}

/** The live server: where to reach it, its state, its logs, and how to stop. */
export interface MockHandle {
  url: string;
  state: MockState;
  requests: LoggedRequest[];
  violations: string[];
  stop(): Promise<void>;
}

/**
 * Start a mock server for one scenario. The state is materialized from the
 * scenario's live_state overlay; the server listens on port 0 (an OS-assigned
 * free port) so many scenarios can run concurrently without contention. The
 * returned `url` is the FULL base the runner points GITHUB_API_URL at,
 * including the GHES prefix when the scenario opts into one - the runner
 * appends nothing. Async so a future tier (a real subprocess-backed server)
 * can await readiness without changing the signature.
 */
export async function startMockServer(
  scenario: Scenario,
  options: ServerOptions = {},
): Promise<MockHandle> {
  // Fail loudly at construction if the handler table has drifted from the
  // section endpoint dictionary, before any request is served.
  assertHandlerCompleteness();

  const state = buildState(scenario.live_state, scenario.owner_kind);
  const requests: LoggedRequest[] = [];
  const violations: string[] = [];
  const corruptedKeys = new Set<string>();

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const query: Record<string, string> = {};
      for (const [k, v] of url.searchParams) {
        query[k] = v;
      }
      const body = await readBody(request);

      const result = runPipeline(
        {
          method: request.method,
          rawPath: url.pathname,
          query,
          rawQuery: url.search.replace(/^\?/, ""),
          headers: request.headers,
          body,
        },
        {
          scenario,
          state,
          basePrefix: options.basePrefix,
          corrupt: options.corrupt,
          corruptedKeys,
        },
      );

      requests.push(result.log);
      if (result.violation) {
        violations.push(result.violation);
      }

      const status = result.response.status;
      if (result.raw !== undefined) {
        // Chaos invalid_json: send the raw unparseable text verbatim.
        return new Response(result.raw, {
          status,
          headers: { "content-type": "application/json" },
        });
      }
      if (result.response.body === null || result.response.body === undefined) {
        return new Response(null, { status });
      }
      return Response.json(result.response.body, { status });
    },
  });

  // The prefix is part of the base URL the client is pointed at, so every
  // request the client makes carries it (which is exactly what the pipeline's
  // prefix check expects).
  const base = `http://localhost:${server.port}`;
  return {
    url: options.basePrefix ? `${base}${options.basePrefix}` : base,
    state,
    requests,
    violations,
    async stop() {
      await server.stop(true);
    },
  };
}

/**
 * Parse the request body: JSON when the method carries one and the body is
 * non-empty, otherwise undefined. A malformed JSON body from the CLIENT (not
 * the chaos hook, which corrupts the SERVER side) is surfaced as the raw text
 * so a handler/pipeline can still log it rather than throwing here.
 */
async function readBody(request: Request): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD") {
    return undefined;
  }
  const text = await request.text();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
