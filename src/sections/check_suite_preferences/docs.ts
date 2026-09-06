import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints: "check-suites preferences PATCH (no read endpoint exists upstream)",
    notes:
      "per-app `auto_trigger_checks` toggles; write-only: check mode cannot verify them (one note, zero requests) and apply re-asserts them every run; the token owner must be a repository administrator",
  },
  coverage: [
    {
      area: "[Check suite preferences](https://docs.github.com/en/rest/checks/suites)",
      notes:
        "PATCH /repos/{owner}/{repo}/check-suites/preferences: per-app auto_trigger_checks " +
        "toggles ({app_id, setting} pairs) controlling whether pushes automatically create " +
        "check suites, sent verbatim. CAVEAT (write-only upstream): GitHub exposes NO " +
        "companion GET, so check mode cannot verify the preferences - it emits one " +
        "cannot-verify note and issues zero requests - and apply re-asserts the declared " +
        "preferences on EVERY run (the PATCH's 200 echoes the resulting preferences, which the " +
        "change line reads). With nothing to read, the apply-mode preflight cannot probe this " +
        "section either, so a denied write surfaces only after other sections' writes landed " +
        "(the Git LFS precedent). The token owner must be a repository administrator " +
        "(fine-grained PATs with Checks read+write work).",
    },
  ],
};
