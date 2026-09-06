import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints: "GET/PATCH properties/values; probes GET /orgs/{owner}",
    notes:
      "values of org-defined properties (definitions are org-scoped); org repos only, skipped with a notice on personal accounts; `value: null` unsets",
  },
  coverage: [
    {
      area: "[Custom property values](https://docs.github.com/en/rest/repos/custom-properties)",
      notes:
        "GET /repos/{owner}/{repo}/properties/values (unpaginated) and ONE bulk PATCH on the " +
        "same path carrying every divergent declared property, skipped entirely when nothing " +
        "diverges. Values of org-defined properties only: property DEFINITIONS are " +
        "/orgs/-scoped and not managed here, so the section probes GET /orgs/{owner} and " +
        "no-ops with a note on personal accounts (404 only; 403/5xx still fail), mirroring " +
        "`teams`. `value: null` unsets a property (reverting to the org default, if any); " +
        "booleans/numbers normalize to their string form (GitHub transports true_false values " +
        'as the strings "true"/"false"); multi_select lists compare order-insensitively. The ' +
        "values READ is gated by Metadata only (every fine-grained token holds it), so only " +
        'the PATCH needs the "Custom properties" grant; a 403 on it can also mean the org ' +
        "restricts a property's values to org actors (values_editable_by: org_actors), and a " +
        "422 means the property is not defined at the organization level. Undeclared live " +
        "values are KEPT by default (an unset can revert to an org default the action does not " +
        "model); the wrapped `undeclared: delete` form opts into unsetting them.",
    },
  ],
};
