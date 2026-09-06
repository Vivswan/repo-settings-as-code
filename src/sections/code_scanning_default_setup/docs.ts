import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints: "code scanning default setup",
    notes: "`state`, `query_suite`, `languages`; needs Advanced Security on private repositories",
  },
  coverage: [
    {
      area: "[Code scanning default setup](https://docs.github.com/en/rest/code-scanning/code-scanning)",
      notes:
        "GET/PATCH /repos/{owner}/{repo}/code-scanning/default-setup, PATCH body verbatim " +
        "(state, query_suite, languages, runner_type, runner_label, threat_model). A 202 " +
        "answer means GitHub rolls the change out in a configuration run, which the log names. " +
        "Check compares declared keys only, languages as a set. Needs GitHub Advanced Security " +
        "on private repositories; a 403 can mean that (or an archived repository) rather than " +
        "a missing permission.",
    },
  ],
};
