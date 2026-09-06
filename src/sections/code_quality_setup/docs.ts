import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints: "code-quality setup",
    notes:
      "`state`, `languages`, runner and AI-findings options; a 202 means GitHub rolls the change out in a configuration run; needs code quality available on the repository",
  },
  coverage: [
    {
      area: "[Code quality setup](https://docs.github.com/en/rest/code-quality/code-quality)",
      notes:
        "GET/PATCH /repos/{owner}/{repo}/code-quality/setup, PATCH body verbatim (state, " +
        "languages, runner_type, runner_label, ai_findings_option), the near field-for-field " +
        "mirror of code_scanning_default_setup. A 202 answer means GitHub rolls the change out " +
        "in a configuration run, which the log names; a 409 means a configuration run is " +
        "already in progress (re-run the workflow after it finishes); a 403 can mean code " +
        "quality is unavailable on the repository or the repository is archived, rather than a " +
        "missing permission, and a 422 (the change cannot be applied) carries GitHub's message " +
        "verbatim. Check compares declared keys only, languages as a set. ASSUMPTION: the GET " +
        "is graded as a plain read under the Administration permission, mirroring code " +
        "scanning - the fine-grained grading of these endpoints is not verified against " +
        "production. The sibling /code-quality/findings endpoints are read-only and stay out " +
        "of scope.",
    },
  ],
};
