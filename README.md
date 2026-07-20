# settings-as-code

Apply declarative repository settings from `.github/settings.yml` - a loud,
stateless replacement for the [Probot Settings app](https://github.com/repository-settings/app)
that also manages **rulesets** (branch and tag). Every apply is a visible
workflow run that fails with the API's error message; nothing happens
silently.

## Usage

```yaml
# .github/workflows/settings.yml
name: Apply Settings
on:
  push:
    branches: [main]
    paths: [.github/settings.yml]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  apply:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: Vivswan/settings-as-code@v1
        with:
          token: ${{ secrets.ADMIN_TOKEN }}
```

Most sections need a fine-grained PAT with **Administration: read & write**
on the repository - the default `GITHUB_TOKEN` can never hold that
permission.

## Development

`src/` is TypeScript built with bun; `lib/index.js` is the committed bundle
the action executes (`bun run build` regenerates it; CI fails on drift).
Run `bun run check` for lint + typecheck + tests + bundle freshness.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `token` | `github.token` | Token for the API calls (see permissions table below) |
| `repository` | current repo | Target `owner/name` |
| `settings-file` | `.github/settings.yml` | Settings file path |
| `mode` | `apply` | `apply` mutates; `check` reports drift and exits 1 on any, writing nothing |
| `on-missing-permission` | `fail` | `warn` skips sections the token cannot access (partial success) |
| `required-sections` | (empty) | Sections that must fully apply even under `warn` |
| `sections` | (all declared) | Comma-separated allowlist of sections to process |

Outputs: `result` (`applied` / `partial` / `clean` / `drift` / `failed`) and
`skipped-sections`.

## Semantics

- **Stateless, declared-keys-only**: a key you do not declare is never
  touched or compared. There is no state file; resources are matched by
  their natural names.
- **Labels**: declared labels are upserted (rename via `new_name`);
  **undeclared labels are DELETED** (Probot parity), loudly.
- **Rulesets**: upserted by name with the full payload; **undeclared
  rulesets are never deleted** - removing protection stays a human action.
- **Milestones**: upserted by title; undeclared ones are kept (they may hold
  issues) and listed as notices.
- Permission failures (403, or 404 on admin endpoints with a fine-grained
  token) are the only softenable errors; everything else always fails with
  the API message verbatim.

## Sections

| Section | Endpoints | Notes |
|---|---|---|
| `repository` | PATCH repo, PUT topics, vulnerability-alerts, automated-security-fixes | Probot schema incl. `topics` as string or list |
| `labels` | labels CRUD | deletes undeclared |
| `rulesets` | repo rulesets CRUD | branch AND tag targets; short ref names auto-prefixed (`staging` -> `refs/heads/staging`); `~DEFAULT_BRANCH` passes through |
| `branches` | classic branch protection | `protection: null` removes protection |
| `environments` | PUT environments | reviewers, wait timer, branch policies |
| `autolinks` | autolinks CRUD | immutable upstream, so changed entries are replaced; undeclared deleted |
| `actions` | actions permissions + workflow token | `enabled`, `allowed_actions`, `default_workflow_permissions`, `can_approve_pull_request_reviews` |
| `pages` | POST/PUT pages | `build_type: workflow` or `legacy` + source |
| `collaborators` | direct collaborators | invitations for new users; undeclared direct collaborators removed (owner never touched) |
| `teams` | org team repo permissions | skipped with a notice on personal accounts |
| `milestones` | milestones | upsert by title, never deletes |

## Example settings.yml

```yaml
repository:
  description: My project
  topics: tooling, github-actions
  has_wiki: false
  allow_squash_merge: true
  allow_merge_commit: false
  squash_merge_commit_title: PR_TITLE
  delete_branch_on_merge: true
  enable_vulnerability_alerts: true

labels:
  - name: bug
    color: "d73a4a"
    description: Something isn't working

rulesets:
  - name: main
    target: branch
    enforcement: active
    conditions:
      ref_name:
        include: ["~DEFAULT_BRANCH"]
        exclude: []
    rules:
      - type: deletion
      - type: non_fast_forward
      - type: required_status_checks
        parameters:
          strict_required_status_checks_policy: false
          do_not_enforce_on_create: true
          required_status_checks:
            - context: all-green
```

## Migrating from the Probot Settings app

Your existing `settings.yml` works as-is for `repository`, `labels`,
`branches`, `collaborators`, `teams`, and `milestones` (same schema).
Uninstall the app, add the workflow above, and optionally move branch
protection to `rulesets`. Differences: applies run visibly in Actions
(loud failures instead of silent skips), rulesets are supported, and
nothing except labels/autolinks/collaborators is ever deleted implicitly.

## Token permissions by section

| Section | Fine-grained PAT permission |
|---|---|
| repository, rulesets, autolinks | Administration: write |
| labels, milestones | Issues: write |
| branches | Administration: write |
| environments | Environments: write |
| pages | Pages: write |
| actions | Administration: write |
| collaborators | Administration: write |
| teams | Organization members (org repos only) |
