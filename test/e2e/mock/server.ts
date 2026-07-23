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

import { stringify as stringifyYaml } from "yaml";
import type { MultiRepo, Scenario } from "../schema.js";
import {
  assertFaultKeys,
  assertHandlerCompleteness,
  type CorruptOption,
  type FaultOption,
  type LoggedRequest,
  newPipelineRunState,
  runPipeline,
} from "./routes.js";
import {
  buildMultiState,
  buildState,
  type MockState,
  type MultiMockState,
  type MultiRepoSpec,
} from "./state.js";

/** Extra knobs beyond the scenario: the GHES prefix and the chaos directive. */
export interface ServerOptions {
  /** GHES-style path prefix every request must carry (e.g. "/api/v3"). */
  basePrefix?: string;
  /** Corrupt the first response of one endpoint, to prove loud client failure. */
  corrupt?: CorruptOption;
  /** Transport-level faults injected on the first matching requests. */
  faults?: FaultOption[];
}

/** The live server: where to reach it, its state, its logs, and how to stop. */
export interface MockHandle {
  url: string;
  /**
   * Single-repo working state; undefined in multi-repo mode (see `multi`).
   * Tests seed or assert against it directly.
   */
  state?: MockState;
  /** Multi-repo working state (per-slug repos + discovery pool), when set. */
  multi?: MultiMockState;
  requests: LoggedRequest[];
  violations: string[];
  /**
   * Arm the check-mode write barrier for all SUBSEQUENT requests. One-way (no
   * exit): the convergence re-run spawns a check-mode child against this same
   * already-running server, whose scenario is still apply-mode, so the runner
   * calls this before the re-run to make an unexpected write a violation.
   */
  enterCheckMode(): void;
  stop(): Promise<void>;
}

/**
 * The raw settings.yml content the contents endpoint serves for a target:
 * `settings_raw` verbatim when set (for a genuine parse failure), else the
 * settings object serialized to YAML, else null (the no-settings-file case).
 */
function settingsYamlFor(spec: MultiRepo): string | null {
  if (spec.settings_raw !== undefined) {
    return spec.settings_raw;
  }
  if (spec.settings === null || spec.settings === undefined) {
    return null;
  }
  return stringifyYaml(spec.settings);
}

/**
 * Convert a scenario's multi-repo declaration into the buildMultiState inputs:
 * each target's settings object is serialized to the raw YAML the contents
 * endpoint serves (null settings -> null, the no-file case). Discovery-pool
 * slugs and per-repo specs are unioned by buildMultiState. Returns undefined
 * for a single-repo scenario.
 */
function multiStateFor(scenario: Scenario): MultiMockState | undefined {
  if (!scenario.repos && !scenario.discovery) {
    return undefined;
  }
  const repos: Record<string, MultiRepoSpec> = {};
  for (const [slug, spec] of Object.entries(scenario.repos ?? {})) {
    repos[slug] = {
      settingsYaml: settingsYamlFor(spec),
      liveState: spec.live_state,
      permissions: spec.permissions,
    };
  }
  return buildMultiState(repos, scenario.discovery?.pool, scenario.owner_kind);
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
  // Reject fault/corrupt directives naming unknown endpoints or duplicate faults.
  assertFaultKeys(options.faults, options.corrupt);

  // Multi-repo scenarios run per-slug state; single-repo scenarios keep the one
  // MockState. Exactly one is populated, and the pipeline dispatches on which.
  const multi = multiStateFor(scenario);
  const state = multi ? undefined : buildState(scenario.live_state, scenario.owner_kind);
  const requests: LoggedRequest[] = [];
  const violations: string[] = [];
  // All mutable per-run pipeline state (chaos/fault counts + barrier bookkeeping)
  // from one factory, so a new field cannot be omitted at the call site below.
  const runState = newPipelineRunState();
  // One-way override flipped by enterCheckMode(); ORed with the scenario mode.
  let checkModeOverride = false;

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
          multi,
          basePrefix: options.basePrefix,
          corrupt: options.corrupt,
          faults: options.faults,
          ...runState,
          checkMode: scenario.inputs?.mode === "check" || checkModeOverride,
        },
      );

      // Mark responses that are deliberately off the OpenAPI contract so the
      // validator skips them ENTIRELY (status and body):
      //   - the chaos raw case (a deliberately-corrupt, non-JSON body);
      //   - synthetic transport faults (rate-limit 403 / 429 / connection drop),
      //     whose statuses no per-endpoint spec lists;
      //   - any response to a request that asked for a RAW media type: the raw
      //     Accept header (e.g. the settings-file fetch) returns file TEXT, not
      //     the JSON content-object the spec documents. Keying this on the
      //     REQUEST media type - not an endpoint name - means every future raw
      //     endpoint inherits the exemption automatically.
      const rawMediaType = (request.headers.get("accept") ?? "").includes(".raw");
      const offSpec = result.raw !== undefined || result.offSpecBody || rawMediaType;
      result.log.offSpec = offSpec;
      // SNAPSHOT the body: handlers return LIVE state objects (ok(state.repo),
      // in-place Object.assigns), and validateLog runs at scenario end, so
      // logging by reference would let a later mutation retroactively rewrite an
      // earlier logged body. structuredClone freezes what was actually sent.
      result.log.responseBody = offSpec ? undefined : structuredClone(result.response.body);
      requests.push(result.log);
      if (result.violation) {
        violations.push(result.violation);
      }

      // connection_drop: Bun.serve cannot abort before the status line, so the
      // drop happens mid-response via an erroring body stream; undici surfaces
      // that as a network read failure (a real drop can occur at any phase).
      if (result.drop) {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("connection dropped"));
            },
          }),
          { status: 500 },
        );
      }

      const status = result.response.status;
      if (result.raw !== undefined) {
        // Chaos invalid_json: send the raw unparseable text verbatim.
        return new Response(result.raw, {
          status,
          headers: { "content-type": "application/json" },
        });
      }
      const headers = result.response.headers;
      if (result.response.body === null || result.response.body === undefined) {
        return new Response(null, { status, ...(headers ? { headers } : {}) });
      }
      return Response.json(result.response.body, { status, ...(headers ? { headers } : {}) });
    },
  });

  // The prefix is part of the base URL the client is pointed at, so every
  // request the client makes carries it (which is exactly what the pipeline's
  // prefix check expects).
  const base = `http://localhost:${server.port}`;
  return {
    url: options.basePrefix ? `${base}${options.basePrefix}` : base,
    state,
    multi,
    requests,
    violations,
    enterCheckMode() {
      checkModeOverride = true;
    },
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
