/**
 * Which sections are COMPARE-BEFORE-WRITE: their apply path reads the live
 * resource and skips the write when it already matches the declaration, so a
 * SECOND apply over just-applied state must issue ZERO writes for them. The
 * rest write unconditionally in apply mode (one PUT/PATCH is their cheapest
 * way to converge), so a second apply legitimately writes again - for those,
 * the apply-idempotence proof is state STABILITY, not write silence.
 *
 * Every entry is verified against the section's apply-mode write decision in
 * src/sections/:
 * - labels (true): the update is skipped when name, color, description, and
 *   the extra keys all match the live label.
 * - autolinks (true): a live autolink whose declared fields subsetDiff clean
 *   is left alone; only a mismatch triggers the delete-and-recreate.
 * - workflows (true): enable/disable fires only when the live state differs
 *   from the declared one.
 * - collaborators (true): the PUT is skipped when the live role_name already
 *   equals the declared role.
 * - milestones (true): the PATCH is skipped when the declared fields
 *   subsetDiff clean against the live milestone.
 * - repository (false): the base PATCH, the topics PUT, and each security
 *   toggle's PUT/DELETE run unconditionally.
 * - rulesets (false): an existing ruleset is PUT unconditionally (the GET +
 *   diff runs only in check mode).
 * - branches (false): declared protection is PUT unconditionally (only the
 *   protection: null removal probes first).
 * - environments (false): every declared environment is PUT unconditionally.
 * - actions (false): every declared endpoint group is PUT unconditionally.
 * - pages (false): an existing site is PUT unconditionally.
 * - code_scanning_default_setup (false): the PATCH runs unconditionally.
 * - teams (false): team access is granted (PUT) unconditionally.
 *
 * This table lives in the harness (like DENIAL_SEMANTICS): the engine has no
 * use for it, and the apply-idempotence re-run is its contradiction path - a
 * wrong `true` fails the first idempotent run that touches the section, and a
 * wrong `false` weakens the proof without breaking it. The Record type gives
 * compile-time completeness (a missing or unknown key fails tsc).
 */

import type { SectionKey } from "../../src/schema.js";

export const COMPARE_BEFORE_WRITE: Record<SectionKey, boolean> = {
  repository: false,
  labels: true,
  rulesets: false,
  branches: false,
  environments: false,
  autolinks: true,
  actions: false,
  workflows: true,
  pages: false,
  code_scanning_default_setup: false,
  collaborators: true,
  teams: false,
  milestones: true,
};
