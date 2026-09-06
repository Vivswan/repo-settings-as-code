import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints: "actions secrets list + public-key + sealed PUT + delete",
    notes:
      "`{name, value: $NAME}` sealed writes, re-sent every apply; existence-only checks, values unrecoverable",
  },
  coverage: [
    {
      area: "[Actions secrets](https://docs.github.com/en/rest/actions/secrets)",
      notes:
        "GET /repos/{owner}/{repo}/actions/secrets (names + timestamps), GET " +
        ".../actions/secrets/public-key, PUT .../actions/secrets/{secret_name} (libsodium " +
        "sealed box, {encrypted_value, key_id}), DELETE .../actions/secrets/{secret_name}. " +
        "Values never live in settings.yml: each entry's `value` is a whole-value `$NAME` " +
        "reference resolved from the step's env at apply time, sealed client-side, and " +
        "re-written on EVERY apply so a rotated source value propagates. CAVEAT " +
        "(existence-only): GitHub cannot return a value, so drift detection is presence, not " +
        "content - check mode reports a declared-but-missing secret as drift and adds one " +
        "cannot-verify note for the values; a changed value on GitHub's side is undetectable. " +
        "Undeclared secrets are kept by default (their values are unrecoverable); the wrapped " +
        "`undeclared: delete` form opts into deletion.",
    },
  ],
};
