/**
 * The complete set of REST path templates the action can reach, derived from
 * the section endpoint dictionary, the private-report issue-channel endpoint
 * dictionary, plus the handful of non-section "core" calls (repo probe,
 * settings-file fetch, multi-repo discovery). A later phase's OpenAPI trim
 * script imports USED_PATHS to slice the published spec down to exactly what the
 * mock must model, so this stays dependency-light: it pulls from the endpoint
 * declarations only, and re-derives nothing they already declare.
 */

import { ISSUE_REPORT_ENDPOINTS } from "../../../src/report/issue-report.js";
import { endpointPath } from "../../../src/sections/contract.js";
import { allEndpoints } from "../../../src/sections/registry.js";

/**
 * Path templates the action calls outside any section: the repository probe
 * that opens every run, the Contents fetch that reads settings.yml, and the
 * discovery listing that expands a multi-repo target. Kept here because no
 * SectionModule owns them. The private-report issue-channel paths are NOT hand
 * listed here - they derive from ISSUE_REPORT_ENDPOINTS below, single-sourced
 * from the report module (its marker-label create reuses the labels section's
 * path, so that one collapses into the section paths on dedup).
 */
export const CORE_PATHS: readonly string[] = [
  "/repos/{owner}/{repo}",
  "/repos/{owner}/{repo}/contents/{path}",
  "/user/repos",
];

/**
 * Every distinct path half of every section endpoint AND every issue-report
 * endpoint, unioned with CORE_PATHS and deduped. Method is intentionally
 * dropped: two routes that share a path (e.g. GET and PUT on the same resource)
 * collapse to one entry, which is what the OpenAPI trim wants (paths are keyed
 * by path, not by method).
 */
export const USED_PATHS: readonly string[] = (() => {
  const paths = new Set<string>(CORE_PATHS);
  for (const endpoint of Object.values(allEndpoints())) {
    paths.add(endpointPath(endpoint.route));
  }
  for (const endpoint of Object.values(ISSUE_REPORT_ENDPOINTS)) {
    paths.add(endpointPath(endpoint.route));
  }
  return [...paths].sort();
})();
