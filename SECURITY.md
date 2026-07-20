# Security policy

## Supported versions

Only the latest release is supported. Fixes are not backported; upgrade the
`uses:` pin to pick them up.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report vulnerabilities privately via
[GitHub Security Advisories](https://github.com/vivswan/repo-settings-as-code/security/advisories/new)
("Report a vulnerability"). Include reproduction steps, the affected version
(tag or commit sha), and the impact you see. You'll get an acknowledgement as
soon as possible, and a fix ships in the next release once confirmed.

Never include real credentials in a report; redact everything that looks like
a key or token.

## What counts as a vulnerability here

This action holds a repository-admin token and writes repository settings,
so the interesting surface is:

- Token handling. The token is used only in the Authorization header and is
  never printed, not even in debug traces. Any path that makes it appear in
  logs, annotations, the step summary, or outputs is a vulnerability.
- Workflow-command injection. API responses and settings-file content are
  echoed into annotations and the step summary, escaped for workflow
  commands (%, CR, LF) and for summary tables (pipes, backslashes). Input
  that breaks out of that escaping and injects commands or forged log lines
  is a vulnerability.
- Settings escalation. A crafted settings file should never be able to
  touch a repository or setting it does not declare, nor bypass the
  preflight barrier or the required-sections policy.
- Supply chain. lib/index.js is a committed bundle and CI fails unless it
  byte-matches a fresh build of src/. A discrepancy CI accepts is a
  vulnerability.

Drift-detection false positives, confusing messages, and similar problems
are ordinary bugs; use the issue tracker for those.
