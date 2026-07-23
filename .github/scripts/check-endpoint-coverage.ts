/**
 * Endpoint-coverage tripwire for the nightly e2e run. Every "section.role" key
 * in allEndpoints() must be exercised at least once by the curated corpus; a
 * cold route means the harness has a blind spot, an endpoint the action can
 * call that no scenario reaches, so a regression there would ship unnoticed.
 *
 * This runs the full corpus through runScenario and reads each report's request
 * log (ScenarioReport.requests, the snapshot the runner takes before teardown),
 * attributing every logged request to a registered route via matchesTemplate
 * (the same matcher the mock routes with). It then fails naming any route no
 * request reached.
 *
 * Usage: `bun .github/scripts/check-endpoint-coverage.ts`. Exit 0 when every
 * route was hit; exit 1 naming the cold routes otherwise.
 */

import { join } from "node:path";
import { endpointMethod, endpointPath, matchesTemplate } from "../../src/sections/contract.js";
import { allEndpoints } from "../../src/sections/registry.js";
import type { LoggedRequest } from "../../test/e2e/mock/routes.js";
import { runScenario } from "../../test/e2e/runner.js";
import { loadScenarios } from "../../test/e2e/schema.js";

const SCENARIO_DIR = join(import.meta.dir, "..", "..", "test", "e2e", "scenarios");

/** One registered route, resolved to the parts matchesTemplate needs. */
interface Route {
  key: string;
  method: string;
  path: string;
}

/** The registered routes, keyed and split into method + path template. */
export function registeredRoutes(): Route[] {
  return Object.entries(allEndpoints()).map(([key, endpoint]) => ({
    key,
    method: endpointMethod(endpoint.route),
    path: endpointPath(endpoint.route),
  }));
}

/** Record every route each request hit into `hit` (mutated in place). */
export function recordHits(
  requests: readonly LoggedRequest[],
  routes: Route[],
  hit: Set<string>,
): void {
  for (const request of requests) {
    for (const route of routes) {
      if (
        !hit.has(route.key) &&
        route.method === request.method &&
        matchesTemplate(route.path, request.pathname)
      ) {
        hit.add(route.key);
      }
    }
  }
}

/** The registered route keys no request reached, sorted. */
export function coldRoutes(hit: ReadonlySet<string>, routes: Route[]): string[] {
  return routes
    .filter((route) => !hit.has(route.key))
    .map((route) => route.key)
    .sort();
}

async function main(): Promise<number> {
  const routes = registeredRoutes();
  const hit = new Set<string>();

  const scenarios = loadScenarios(SCENARIO_DIR);
  if (scenarios.length === 0) {
    console.error(`no scenarios found under ${SCENARIO_DIR}`);
    return 1;
  }
  for (const scenario of scenarios) {
    // A scenario's own pass/fail is the corpus job's concern; here we only
    // aggregate which routes it reached, so a throw does not stop the sweep. A
    // fault-injection scenario can drop the connection mid-run and make
    // runScenario throw; runScenario snapshots its request log into the report
    // and only returns on success, so a throw yields no report and its routes
    // go unattributed. That could turn a real hit into a false cold route, so
    // NAME the scenario loudly rather than swallow the throw.
    try {
      const report = await runScenario(scenario);
      recordHits(report.requests, routes, hit);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `coverage: scenario "${scenario.name}" threw during its run, so its routes are unattributed: ${message}`,
      );
    }
  }

  const cold = coldRoutes(hit, routes);
  console.log(`endpoint coverage: ${routes.length - cold.length}/${routes.length} routes hit`);
  if (cold.length > 0) {
    console.error(
      `cold routes never exercised by the corpus (add a scenario that reaches each):\n  ${cold.join("\n  ")}`,
    );
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
