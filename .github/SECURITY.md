<!-- BEGIN REPO-PLATFORM MANAGED -->
# Security policy

## Supported versions

Only the latest release is supported.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report vulnerabilities privately via [GitHub Security Advisories](https://github.com/vivswan/github-settings-as-code/security/advisories/new) ("Report a vulnerability"). If that page is unavailable (GitHub offers no advisories on private personal repositories), contact [@Vivswan](https://github.com/vivswan) directly instead. A useful report includes:

- what an attacker can do (impact), and where trust is broken,
- reproduction steps or a proof of concept,
- the affected version or commit.

Expect an acknowledgement within a few days, and a fix in the next release once the report is confirmed. Please allow reasonable time for that fix before any public disclosure.

Never include real credentials in a report; redact everything that looks like a key.

<!-- Everything between the BEGIN/END markers is managed by Vivswan/repo-platform and replaced on template sync. Repository-specific security documentation (scope, threat model, review expectations for security-relevant changes) goes outside the markers - below the END marker, or above BEGIN; it is this repository's own and survives template updates. -->
<!-- END REPO-PLATFORM MANAGED -->

## What counts as a vulnerability here

This action holds a repository-admin token and writes repository settings, so the interesting surface is:

- Token handling. The token is used only in the Authorization header and is never printed, not even in debug traces. Any path that makes it appear in logs, annotations, the step summary, or outputs is a vulnerability.
- Workflow-command injection. API responses and settings-file content are echoed into annotations and the step summary, escaped for workflow commands (%, CR, LF) and for summary tables (pipes, backslashes). Input that breaks out of that escaping and injects commands or forged log lines is a vulnerability.
- Settings escalation. A crafted settings file should never be able to touch a repository or setting it does not declare, nor bypass the preflight barrier or the required-sections policy.
- Supply chain. Every ref a `uses:` pin can name - the `vX.Y.Z` release tags and the moving major - points at a packaged commit parented on the audited release commit, produced by the release workflow run named in its provenance message; main carries no executable bundle. The release-tags ruleset freezes version tags for everything except deliberate repository-admin action (the bypass exists for repair; the release workflow itself never moves a version tag, reruns verify the existing one byte-for-byte instead). A packaged commit whose bundle a rebuild of its parent's src/ does not reproduce is a vulnerability. The release pipeline also attests every release asset (`lib/index.js` and `lib/settings.schema.json`) in one build-provenance attestation while the repository is public (GitHub offers no attestations elsewhere): fetch either from the `vX.Y.Z` tag or the release assets, then check it with `gh attestation verify
  <artifact> -R vivswan/github-settings-as-code` (add
  `--signer-workflow vivswan/github-settings-as-code/.github/workflows/release.yml` to also pin the producing workflow), or without the attestations API via `--bundle` against the `attestation.json` release asset. A release finished by hand carries no attestation at all, and its packaged commit no workflow-run trailer: both need the workflow's OIDC identity.

Fixes ship in the next release and are not backported; upgrade the `uses:` pin to pick them up.

Drift-detection false positives, confusing messages, and similar problems are ordinary bugs; use the issue tracker for those.
