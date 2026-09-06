import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints: "Actions variables CRUD",
    notes:
      "plain-text variables upserted by name (case-insensitive); values read back in full, so check mode diffs them exactly",
  },
  coverage: [
    {
      area: "[Actions variables](https://docs.github.com/en/rest/actions/variables)",
      notes:
        "GET/POST /repos/{owner}/{repo}/actions/variables and PATCH/DELETE " +
        "/repos/{owner}/{repo}/actions/variables/{name}: plain-text repository variables, " +
        "upserted by name. Names are case-insensitive (GitHub stores them uppercased " +
        "regardless of how they are entered), so matching and duplicate rejection compare " +
        "uppercased names. Values read back in full, which is what makes exact check-mode " +
        "diffing possible; undeclared variables are DELETED by default, kept as notes under " +
        "the wrapped `undeclared: keep` form. The list endpoint caps per_page at 30 (not the " +
        "usual 100), which the page loop honors so a large inventory is never truncated. " +
        "Secrets are write-only material and deliberately NOT this section: they live in the " +
        "`actions_secrets` section above.",
    },
  ],
};
