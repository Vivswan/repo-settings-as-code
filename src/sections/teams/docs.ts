import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints: "org team repo permissions",
    notes: "org repos only, skipped with a notice on personal accounts",
  },
  coverage: [
    {
      area: "[Team repository permissions](https://docs.github.com/en/rest/teams/teams) (org repos)",
      notes:
        "PUT /orgs/{org}/teams/{slug}/repos/{owner}/{repo}; probes GET /orgs/{owner} and " +
        "no-ops with a note on personal accounts (404 only; 403/5xx still fail). Both modes " +
        "probe each team's access with the v3.repository media type to read role_name, and the " +
        "grant is issued only when the team lacks access or its live role diverges.",
    },
  ],
};
