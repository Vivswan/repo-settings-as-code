import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints: "dependabot secrets list + public-key + sealed PUT + delete",
    notes: "as `actions_secrets`, over the Dependabot secret store",
  },
  coverage: [
    {
      area: "[Dependabot secrets](https://docs.github.com/en/rest/dependabot/secrets)",
      notes:
        "GET /repos/{owner}/{repo}/dependabot/secrets, GET .../dependabot/secrets/public-key, " +
        "sealed PUT/DELETE .../dependabot/secrets/{secret_name}. Same shape, sealing, and " +
        "existence-only semantics as `actions_secrets`, over the Dependabot secret store " +
        "(private-registry credentials Dependabot uses). Undeclared secrets kept by default; " +
        "`undeclared: delete` opts into deletion.",
    },
  ],
};
