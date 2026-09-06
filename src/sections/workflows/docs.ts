import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints: "Actions workflows list, enable/disable",
    notes: "`{path, state: active or disabled}`; bare file names match `.github/workflows/`",
  },
  coverage: [
    {
      area: "[Workflow enable/disable state](https://docs.github.com/en/rest/actions/workflows)",
      notes:
        "GET /repos/{owner}/{repo}/actions/workflows (paginated envelope), then PUT " +
        ".../workflows/{id}/enable or /disable. Declared as {path, state: active or disabled}; " +
        "a bare file name matches .github/workflows/<name>; every live disabled_* state counts " +
        'as disabled and a live "deleted" workflow counts as absent; undeclared workflows are ' +
        "never touched.",
    },
  ],
};
