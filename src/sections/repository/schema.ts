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
function repositoryToggle(description: string) {
  return z
    .boolean({
      error: (issue) =>
        `${describeToggleValue(issue.input)} is not a boolean, so the toggle direction is ambiguous. Use unquoted true or false (YAML parses "no"/"off"/"yes" as strings, not booleans)`,
    })
    .optional()
    .describe(description);
}

export const RepositoryConfig = z
  .looseObject({
    topics: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        "Repository topics, replaced wholesale via PUT /repos/{r}/topics; a comma-separated string or a list, lowercased and deduped.",
      ),
    enable_vulnerability_alerts: repositoryToggle(
      "Dependabot alerts, via PUT/DELETE /repos/{r}/vulnerability-alerts. On read, 404 means off.",
    ),
    enable_automated_security_fixes: repositoryToggle(
      "Dependabot security updates, via PUT/DELETE /repos/{r}/automated-security-fixes. On read, 404 means off, as does a 200 body with enabled: false.",
    ),
    enable_private_vulnerability_reporting: repositoryToggle(
      "Private vulnerability reporting, via PUT/DELETE /repos/{r}/private-vulnerability-reporting. Repositories where the feature does not apply (observed: private repos) read as off.",
    ),
    enable_git_lfs: repositoryToggle(
      "Git LFS, via PUT/DELETE /repos/{r}/lfs. Write-only upstream: check mode cannot verify it, and apply re-asserts it on every run.",
    ),
    enable_immutable_releases: repositoryToggle(
      "Immutable releases, via PUT/DELETE /repos/{r}/immutable-releases. On read, 404 means " +
        "off. When the repository owner enforces immutable releases (enforced_by_owner in the " +
        "GET body), writes answer 409 and the setting cannot be changed from the repository; " +
        "apply reports that as a note instead of a change.",
    ),
    enable_sponsorships: repositoryToggle(
      "Display a Sponsor button on the repository, via the GraphQL updateRepository mutation " +
        "(hasSponsorshipsEnabled) - GraphQL is the setting's only read and write surface (the " +
        "REST repo PATCH and GET carry no such field). A stored repository toggle independent of " +
        "any FUNDING.yml content.",
    ),
    issue_creation_policy: z
      .enum(["all", "collaborators_only"], {
        error: (issue) =>
          `${describeToggleValue(issue.input)} is not a recognized policy. Use "all" (everyone) or "collaborators_only"`,
      })
      .optional()
      .describe(
        'Who may create issues: "all" (everyone) or "collaborators_only", mapped to GitHub\'s ' +
          "ALL/COLLABORATORS_ONLY GraphQL enum at the API boundary. GraphQL-only upstream " +
          "(Repository.issueCreationPolicy and the updateRepository mutation): the REST repo " +
          "PATCH accepts an issue_creation_policy field and silently ignores it, and no REST GET " +
          "returns it.",
      ),
  })
  .catchall(z.unknown().describe("Everything else passes through to PATCH /repos/{r} verbatim."))
  .describe(
    "The `repository:` section. Every field not documented here is sent verbatim to PATCH " +
      "/repos/{r} (Probot parity), so current and future repo fields work unchanged; the keys " +
      "below route to their own endpoints instead. Only declared keys are ever applied or " +
      "compared.",
  )
  .meta({ id: "RepositoryConfig" });
export type RepositoryConfig = z.infer<typeof RepositoryConfig>;
