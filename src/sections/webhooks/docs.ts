import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints: "hooks CRUD + hook config sub-endpoint",
    notes:
      "one hook per `config.url`, the natural key; `config.secret` takes a `$NAME` reference and is re-sent every run",
  },
  coverage: [
    {
      area: "[Webhooks](https://docs.github.com/en/rest/repos/webhooks)",
      notes:
        "GET/POST /repos/{owner}/{repo}/hooks, PATCH/DELETE .../hooks/{hook_id}, and PATCH " +
        ".../hooks/{hook_id}/config. At most ONE hook per config.url (the natural key); a " +
        "declared url matching several live hooks fails loudly naming their ids, and a changed " +
        "url is a NEW hook (the old one turns undeclared: kept and noted by default, deleted " +
        "under `undeclared: delete`). Config-field drift goes through the config sub-endpoint, " +
        "which updates named fields without the general PATCH's whole-config replacement, so " +
        "a live secret the file does not declare is never removed; events/active drift rides " +
        "the general PATCH with no config key. config.secret is declared as a whole-value " +
        "`$NAME` reference resolved from the step env at apply time ([secrets and " +
        "vaults](docs/reference/secrets-and-vaults.md)); GitHub echoes a live secret as " +
        '"********", so check mode verifies everything except the secret (a cannot-verify ' +
        "note) and apply re-sends the declared secret every run so rotations propagate. " +
        "insecure_ssl compares number and string spellings as equal (GitHub stores strings); " +
        "events compare order-insensitively. Hook urls appear in drift and change lines on " +
        "purpose: they are configuration, not credentials (the secret is the masked part).",
    },
  ],
};
