import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints: "agents secrets list + public-key + sealed PUT + delete",
    notes: "as `actions_secrets`, over the Copilot agents secret store",
  },
  coverage: [
    {
      area: "[Copilot agents secrets](https://docs.github.com/en/rest/agents/secrets)",
      notes:
        "GET /repos/{owner}/{repo}/agents/secrets, GET .../agents/secrets/public-key, sealed " +
        "PUT/DELETE .../agents/secrets/{secret_name}. Same shape, sealing, and existence-only " +
        "semantics as `actions_secrets`, over the Copilot agents secret store. (GET " +
        ".../agents/organization-secrets is a read-only view of org-inherited secrets, not a " +
        "reconciliation target.) Undeclared secrets kept by default; `undeclared: delete` opts " +
        "into deletion.",
    },
  ],
};
