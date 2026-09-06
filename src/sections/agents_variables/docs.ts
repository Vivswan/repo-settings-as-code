import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints: "Copilot agents variables CRUD",
    notes: "as `actions_variables`, over the Copilot agents variable store",
  },
  coverage: [
    {
      area: "[Copilot agents variables](https://docs.github.com/en/rest/agents/variables)",
      notes:
        "GET/POST /repos/{owner}/{repo}/agents/variables and PATCH/DELETE " +
        "/repos/{owner}/{repo}/agents/variables/{name}: same upsert-by-uppercase-name " +
        "semantics, exact check-mode diffing, and 30-item per_page cap as `actions_variables`, " +
        "over the Copilot agents variable store. (GET .../agents/organization-variables is the " +
        "read-only org-inherited view, out of scope.) Undeclared variables are DELETED by " +
        "default, kept as notes under the wrapped `undeclared: keep` form. CAVEAT: GitHub " +
        "auto-migrated values from the older `copilot` Actions environment into this store, so " +
        "a repository can hold agents variables nobody created here - run `mode: check` first " +
        "(it lists them as deletion drift) before the first apply, or declare `undeclared: " +
        "keep`.",
    },
  ],
};
