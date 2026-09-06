import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints: "interaction-limits + pulls creation-cap/bypass-list",
    notes:
      "re-arms the self-expiring limit every apply run; `null` clears it (base limit only); a " +
      "409 (org/user-level limit overrides) becomes a note; the PR creation cap is persistent " +
      "(PATCHed only on divergence, 405 where unavailable) and its bypass logins reconcile " +
      "add/remove",
  },
  coverage: [
    {
      area: "[Interaction limits](https://docs.github.com/en/rest/interactions/repos)",
      notes:
        "GET/PUT/DELETE /repos/{owner}/{repo}/interaction-limits, plus the two routed keys " +
        "below. Limits self-expire (expiry tops out at six_months), so apply re-arms the " +
        "declared limit on EVERY run and check mode reports drift once it lapses - schedule " +
        "apply more often than the chosen expiry to keep it armed. The declared expiry is " +
        "write-only (GitHub reads back only the computed expires_at), so check verifies the " +
        "limit value, not the duration. `interaction_limits: null` clears a live repo-level " +
        "limit - the base limit only, never the cap or bypass list below. In multi-repo mode, " +
        "interaction_limits: null in a target is a defaults opt-out instead when the defaults " +
        "file declares a non-null value, mirroring pages: null. A 409 means an organization- " +
        "or user-level limit overrides the repository's; writes surface that as a note, not a " +
        "failure, while check mode still reports a mismatched declaration as drift - the org " +
        "is the place to change it. `pull_request_creation_cap` routes to GET/PATCH " +
        "/repos/{owner}/{repo}/interaction-limits/pulls/creation-cap: persistent desired state " +
        "with no self-expiry (enabled plus max_open_pull_requests 1-1000, read back verbatim), " +
        "so check diffs it exactly and apply PATCHes only on divergence - no re-arm. Where the " +
        "cap is unavailable the endpoints answer 405, which apply surfaces as a note (like the " +
        "409) and check as honest drift. `pull_request_creation_bypass` routes to " +
        "GET/PUT/DELETE /repos/{owner}/{repo}/interaction-limits/pulls/bypass-list and " +
        "reconciles: apply DELETEs only the undeclared logins and then PUTs only the missing " +
        "ones ({users: [logins]}, compared case-insensitively; removals go first because the " +
        "list holds at most 100 users, which also caps the declaration), never a wholesale " +
        "replace; a declared empty list removes everyone.",
    },
  ],
};
