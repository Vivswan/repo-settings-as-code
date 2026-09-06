/** The `repository:` section's entry-config declaration (see src/schema.ts). */

import { z } from "zod";

/**
 * Cycle-safe description of a rejected toggle value for shape errors:
 * scalars verbatim (strings quoted, so a YAML "no" stays visibly a string),
 * containers by kind only - JSON.stringify on an arbitrary YAML value would
 * throw on a cyclic alias and kill the run before the normal failure path.
 */
function describeToggleValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "a list";
  }
  if (typeof value === "object") {
    return "a mapping";
  }
  return String(value);
}

/** A boolean whose error names the YAML string-vs-boolean gotcha. */
function repositoryToggle() {
  return z
    .boolean({
      error: (issue) =>
        `${describeToggleValue(issue.input)} is not a boolean, so the toggle direction is ambiguous. Use unquoted true or false (YAML parses "no"/"off"/"yes" as strings, not booleans)`,
    })
    .optional();
}

export const RepositoryConfig = z
  .looseObject({
    topics: z.union([z.string(), z.array(z.string())]).optional(),
    enable_vulnerability_alerts: repositoryToggle(),
    enable_automated_security_fixes: repositoryToggle(),
    enable_private_vulnerability_reporting: repositoryToggle(),
    enable_git_lfs: repositoryToggle(),
    enable_immutable_releases: repositoryToggle(),
    enable_sponsorships: repositoryToggle(),
    issue_creation_policy: z
      .enum(["all", "collaborators_only"], {
        error: (issue) =>
          `${describeToggleValue(issue.input)} is not a recognized policy. Use "all" (everyone) or "collaborators_only"`,
      })
      .optional(),
  })
  .catchall(z.unknown())
  .meta({ id: "RepositoryConfig" });
export type RepositoryConfig = z.infer<typeof RepositoryConfig>;
