# Repo Settings as Code

Apply declarative repository settings from `.github/settings.yml`: a loud,
stateless replacement for the [Probot Settings app](https://github.com/repository-settings/app)
that also manages [rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets) (branch, tag, and push). Every apply is a visible
workflow run that fails with the API's error message; nothing happens
silently.

## Usage

1. Create a [fine-grained PAT](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token):
   the [pre-filled token form](https://github.com/settings/personal-access-tokens/new?name=repo-settings-as-code&description=Token+for+Vivswan%2Frepo-settings-as-code&administration=write&issues=write&environments=write&pages=write&actions=write&contents=read)
   starts you off with every repository permission the
   [Sections](#sections) table can need. Pick the resource owner and
   repositories, and add Members: read by hand when the owner is an
   organization; the form only offers organization permissions once one
   is selected. The default `GITHUB_TOKEN` can never hold these
   permissions.

2. Save the token as a repository secret; `ADMIN_TOKEN` below.

3. Declare your settings in `.github/settings.yml` (see the
   [example](#example-settingsyml) below). One line at the top gives
   editor autocomplete and hover docs (agents can fetch the same URL):

   ```yaml
   # yaml-language-server: $schema=https://raw.githubusercontent.com/Vivswan/repo-settings-as-code/main/lib/settings.schema.json
   ```

4. Add the workflow. On a repository with existing labels, autolinks, or
   collaborators, also set `mode: check` under `with:` for the first run:
   the drift report lists everything an apply would delete, and nothing is
   written.

   <!-- x-release-please-start-version -->

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
         - uses: Vivswan/repo-settings-as-code@v1.0.0
           with:
             token: ${{ secrets.ADMIN_TOKEN }}
   ```

   <!-- x-release-please-end -->

5. Run it once from the Actions tab (workflow_dispatch), review the run,
   and drop `mode: check` if you set it. From then on every push that
   touches `.github/settings.yml` applies it.

A JSON Schema describing every section and its structured fields is
published at
[`lib/settings.schema.json`](lib/settings.schema.json), generated from the
commented types in `src/schema.ts`. Passthrough areas (the `repository`
payload, branch protection, rule parameters) stay open objects on purpose.

The schema is documentation, not a gate: unknown fields validate on
purpose, because payloads pass through to the API verbatim and declaring a
field GitHub ships tomorrow must never read as an error (see
[Forward compatibility](#forward-compatibility)).

## Versioning

- `@v1` is a moving major tag: <!-- x-release-please-major -->
  every release in that major line moves it, so fixes arrive without
  changing your pin.
- Pin an exact tag (`@v1.0.0`) when you need byte-stable behavior, and <!-- x-release-please-version -->
  upgrade deliberately.
- Only the latest release is supported; fixes are not backported (see
  [SECURITY.md](SECURITY.md)).

## Sections

| Section | Endpoints | PAT permission | Notes |
|---|---|---|---|
| `repository` | PATCH repo, PUT topics, vulnerability-alerts, automated-security-fixes, private-vulnerability-reporting | Administration: write | Probot schema incl. `topics` as string or list; `enable_private_vulnerability_reporting` toggle; declared fields only, siblings undeclared untouched |
| `labels` | labels CRUD | Issues: write | upsert by name (rename via `new_name`); undeclared deleted |
| `rulesets` | repo rulesets CRUD | Administration: write | branch, tag, and push targets; short ref names auto-prefixed (`staging` -> `refs/heads/staging`); `~DEFAULT_BRANCH` passes through; undeclared kept (notes only) |
| `branches` | classic branch protection | Administration: write | `protection: null` removes protection; undeclared untouched; add Contents: read so check mode can tell a missing branch from an unprotected one |
| `environments` | PUT environments | Environments: write | reviewers, wait timer, branch policies; undeclared untouched |
| `autolinks` | autolinks CRUD | Administration: write | immutable upstream, so changed entries are replaced; undeclared deleted |
| `actions` | actions permissions + selected-actions + workflow token + access level | Administration: write | `enabled`, `allowed_actions`, `selected_actions`, `default_workflow_permissions`, `can_approve_pull_request_reviews`, `access_level` (private repos only); undeclared untouched |
| `workflows` | list workflows, enable/disable | Actions: write | `{path, state: active or disabled}`; bare file names match `.github/workflows/`; undeclared untouched |
| `pages` | POST/PUT/DELETE pages | Pages: write | `build_type: workflow` or `legacy` + source, `cname`, `https_enforced`; `pages: null` disables the site; undeclared untouched |
| `code_scanning_default_setup` | code scanning default setup | Administration or Code scanning alerts: write | `state`, `query_suite`, `languages` (compared as a set), and future PATCH fields; needs Advanced Security on private repos, where a 403 can mean Advanced Security is off or the repo is archived; undeclared untouched |
| `collaborators` | direct collaborators | Administration: write | invitations for new users; undeclared deleted (owner never touched) |
| `teams` | org team repo permissions | Members: read (org permission) + Administration: write | org repos only, skipped with a notice on personal accounts; undeclared untouched |
| `milestones` | milestones | Issues: write | upsert by title; undeclared kept (may hold issues) |

## Semantics

- Stateless, declared-keys-only: a key you do not declare is never
  touched or compared. There is no state file; resources are matched by
  their natural names.
- Apply is convergent: re-running preserves the declared state (some
  sections diff first and skip converged writes, others send idempotent
  full-payload writes), and a check right after an apply reports clean.
- Labels: declared labels are upserted (rename via `new_name`);
  undeclared labels are DELETED (Probot parity), loudly.
- Rulesets: upserted by name with the full payload; undeclared
  rulesets are never deleted, since removing protection stays a human action.
- Milestones: upserted by title; undeclared ones are kept (they may hold
  issues) and listed as notices.
- Permission failures (403, or 404 on admin endpoints with a fine-grained
  token) are the only softenable errors; everything else always fails with
  the API message verbatim.
- Rate limits (429 and secondary limits) and transient 5xx or network
  failures are retried automatically with backoff, honoring Retry-After
  and the rate-limit reset, up to two retries; a reset more than 60
  seconds away fails loudly instead of stalling the workflow. Permission
  errors are never retried.
- Preflight barrier: under `on-missing-permission: fail`, every
  declared section is probed read-only before ANY write; if a section is
  inaccessible, nothing is applied at all (per repository in multi-repo
  mode; earlier targets in the same run are already done). The API has no
  transactions; a read-but-not-write token can still fail mid-apply, and
  re-running after fixing it converges because applies are idempotent.

See [COVERAGE.md](COVERAGE.md) for the full inventory: everything
supported, every repo-scoped gap, and the user-scoped surface that is out of
scope by design.

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
  enable_private_vulnerability_reporting: true

workflows:
  - path: vendored-sync.yml
    state: disabled

code_scanning_default_setup:
  state: configured
  query_suite: default

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

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `token` | `github.token` | Token for the API calls (see [Token permissions](#token-permissions)) |
| `repository` | current repo | Target `owner/name` (single-repo mode only) |
| `settings-file` | `.github/settings.yml` | Settings file path (single-repo mode only) |
| `mode` | `apply` | `apply` mutates; `check` reports drift and exits 1 on any, writing nothing |
| `on-missing-permission` | `fail` | `warn` skips sections the token cannot access (partial success) |
| `required-sections` | (empty) | Sections that must fully apply even under `warn` |
| `sections` | (all declared) | Comma-separated allowlist of sections to process |
| `api-version` | `2022-11-28` | `X-GitHub-Api-Version` header; override to opt into a newer REST API version |
| `repos` | (empty) | Multi-repo remote mode: `owner/name` list (comma/newline), or `*` to discover owned repos |
| `repos-dir` | (empty) | Multi-repo central mode: directory of per-repo settings files in this repo |
| `defaults-file` | (empty) | YAML merged under every multi-repo target's settings (multi-repo mode only) |
| `private-repos` | `redact` | `redact` hides private and internal targets from public logs, summary, and outputs; `show` reveals them |
| `visibility` | `all` | Discovery-only: keep `public`, `private`, or `internal` repositories |
| `archived` | `skip` | Discovery-only: `skip`, `include`, or `only` archived repositories |
| `forks` | `include` | Discovery-only: `include`, `exclude`, or `only` forks |
| `exclude` | (empty) | Discovery-only: `*` wildcard patterns (name, or `owner/name` if the pattern has a `/`) to drop |
| `topics` | (empty) | Discovery-only: keep repositories carrying at least one listed topic |
| `affiliation` | `owner` | Discovery-only: `owner`, `collaborator`, `organization_member` (comma list) |

Outputs: `result` (`applied` / `partial` / `clean` / `drift` / `failed`;
worst-of across targets in multi-repo mode, where `skipped` can also
appear), `skipped-sections`, and `repos-result` (multi-repo mode: a JSON
map of `owner/name` to `{result, source, skippedSections}`).

## Multi-repo mode

One run in an admin repository can manage a whole fleet, in the spirit of
[safe-settings](https://github.com/github-community-projects/safe-settings)
but without a hosted app. Two sourcing modes, usable together:

- Central (`repos-dir`): a directory in the admin repo holds one settings
  file per target: `<name>.yml` (same owner as the admin repo) or
  `<owner>/<name>.yml`. Needs `actions/checkout`. These files are the
  curated, code-reviewed source of truth.
- Remote (`repos`): a comma- or newline-separated list of `owner/name`
  targets, each applied from its own `.github/settings.yml` (default
  branch). `repos: "*"` alone discovers every repository the token's user
  owns (needs a user PAT; the workflow `GITHUB_TOKEN` cannot enumerate).
  A target without a settings file is skipped with a notice.

Discovery takes six filter inputs that apply only to `repos: "*"`; setting
any of them in another mode fails the run. Repositories a filter drops are
reported in one aggregate notice per reason.

- `visibility` keeps public, private, or internal repositories.
- `archived` defaults to `skip`, because settings writes fail on archived
  repositories; `archived: only` is mostly useful with `mode: check`.
- `forks` includes, excludes, or keeps only forks.
- `topics` keeps repositories carrying at least one listed topic, so a
  single marker topic can opt repositories in.
- `exclude` takes wildcard patterns where `*` matches anything: a pattern
  containing `/` is matched against the full `owner/name`, any other
  against the name alone, case-insensitively.
- `affiliation` selects which relationships to the token's user qualify:
  `owner` (the default), `collaborator`, or `organization_member`. The
  list replaces the default, so widening discovery beyond owned
  repositories takes `owner,collaborator`.

When the same repository appears in both, the central file wins (with a
notice).

`defaults-file` names a YAML document deep-merged UNDER every target's
settings: target keys win, objects merge, arrays and scalars replace (an
array is always a full payload, matching check-mode semantics).

A `null` section in a target means one of two things in that merge:

- When the defaults file declares the section with a non-null value,
  `null` opts that repository out of the defaults section.
- When the defaults do not override it, the `null` passes through to the
  engine, where it can carry meaning of its own. So `pages: null` in the
  defaults file disables Pages fleet-wide, while `pages: null` in a target
  under a defaults file that declares a `pages` object means "leave this
  repo's Pages alone", not "disable Pages".

Targets run independently and sequentially: one repository's failure never
stops the others; the run exits 1 at the end if any target failed (or, in
check mode, drifted). The step summary shows a fleet rollup table plus a
per-repository section table, and the `repos-result` output carries the
per-repo results as JSON.

`sections` and `required-sections` apply to all targets alike, and the
token needs the same per-section permissions (see the
[Sections](#sections) table) on every target.

<!-- x-release-please-start-version -->

```yaml
# One admin repo managing the fleet
- uses: actions/checkout@v7
- uses: Vivswan/repo-settings-as-code@v1.0.0
  with:
    token: ${{ secrets.FLEET_TOKEN }}
    repos-dir: .github/repos
    defaults-file: .github/settings-defaults.yml
    repos: |
      other-org/service-a
      other-org/service-b
```

<!-- x-release-please-end -->

## Token permissions

The PAT permission column in the [Sections](#sections) table names the
grant each section needs. Grant only the permissions for the sections your
settings file declares; the action never needs more. In multi-repo mode
the token needs the same permissions on every target repository.

To manage everything in one PAT, grant Administration, Issues,
Environments, Pages, and Actions at write, plus Contents at read and (for
org repos) the Members organization permission at read. The pre-filled
token form linked under [Usage](#usage) grants exactly the repository
half of that set.

Three things worth knowing when a run fails on permissions:

- `mode: check` never writes, so the read half of each permission is
  enough for a drift-report-only workflow.
- Fine-grained tokens surface a missing Administration permission as a
  404, not a 403, on admin endpoints. The action treats both as
  permission errors and its messages name the exact permission to grant.
- `repos: "*"` discovery needs a user PAT; the workflow `GITHUB_TOKEN`
  and GitHub App installation tokens cannot enumerate a user's
  repositories. Remote multi-repo targets also need Contents: read on
  every target, because each repository's own settings.yml is fetched
  through the contents API.

## Forward compatibility

Passthrough-first by design: payloads are sent to the API verbatim
except for documented normalizations (ref prefixes, topics splitting,
vocabulary mapping), so new fields and rule types GitHub ships work the day
they exist: declare them in `settings.yml`, no action update needed. This
holds for `rulesets` (new rule types, bypass-actor fields, condition
types), `repository`, `branches`, `environments`, `actions`, `pages`, and
`code_scanning_default_setup`.

Two deliberate boundaries:

- A brand-new top-level settings *category* needs a handler: a new API
  endpoint cannot be guessed, so unknown sections fail loudly rather
  than no-op.
- The pinned `X-GitHub-Api-Version` only changes intentionally.

## Migrating from the Probot Settings app

Your existing `settings.yml` works as-is for `repository`, `labels`,
`branches`, `collaborators`, `teams`, and `milestones` (same schema).
Uninstall the app, add the workflow above, and optionally move branch
protection to `rulesets`. Differences: applies run visibly in Actions
(loud failures instead of silent skips), rulesets are supported, and
nothing except labels/autolinks/collaborators is ever deleted implicitly.

In short, what you gain over the app:

- visible runs instead of silent no-ops
- a drift-report check mode
- first-class rulesets
- a partial-success policy (`on-missing-permission` + `required-sections`)
- a token you scope yourself
- per-call debug tracing
- multi-repo fleet management with a defaults layer (the `extends` role,
  minus the hosted app)

The full side-by-side table is in
[COVERAGE.md](COVERAGE.md#compared-to-the-probot-settings-app).

## Debugging

Every API call the action makes is traced as a debug line: method, path,
request payload, response status, and timing. Debug lines are hidden in
normal runs; to see them, re-run the workflow with "[Enable debug logging](https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/troubleshooting-workflows/enabling-debug-logging)"
checked (or set the `ACTIONS_STEP_DEBUG` secret to `true`).

Failures do not need debug mode: every error already carries the API's
error message verbatim plus the fix, and the step summary table shows the
outcome per section.

## Contributing

The toolchain, the end-to-end harness, and the PR conventions are
documented in [CONTRIBUTING.md](CONTRIBUTING.md).
