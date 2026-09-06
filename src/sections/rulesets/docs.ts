import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints: "repo rulesets CRUD",
    notes:
      "branch, tag, and push targets; short ref names auto-prefixed (`staging` -> `refs/heads/staging`); deletion stays an explicit opt-in",
  },
  coverage: [
    {
      area: "[Rulesets](https://docs.github.com/en/rest/repos/rules) (branch, tag, and push targets; all rule types, conditions, bypass_actors)",
      notes:
        "GET/POST/PUT/DELETE /repos/{owner}/{repo}/rulesets: upsert-by-name, full-payload PUT, " +
        "verbatim passthrough except ref-name prefixing (staging -> refs/heads/staging, " +
        "~DEFAULT_BRANCH passes through). New rule types/bypass fields/condition types GitHub " +
        "ships work day one. Undeclared rulesets kept by default (notes only); the wrapped " +
        "`undeclared: delete` form deletes them. Org-sourced rulesets filtered out via " +
        "source_type.",
    },
    {
      area: "[Merge queue](https://docs.github.com/en/rest/repos/rules)",
      notes:
        "Configured as the merge_queue rule type inside a branch ruleset; passes through verbatim like every other rule type. No dedicated endpoint exists; rulesets ARE the API for merge queue.",
    },
    {
      area: "[Tag protection (modern)](https://docs.github.com/en/rest/repos/rules)",
      notes:
        "target: tag rulesets cover everything the retired legacy tag-protection API did (legacy API itself is out of scope, removed by GitHub).",
    },
  ],
};
