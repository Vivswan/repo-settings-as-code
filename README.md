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
         - uses: Vivswan/repo-settings-as-code@v1.0.1
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
- Pin an exact tag (`@v1.0.1`) when you need byte-stable behavior, and <!-- x-release-please-version -->
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
| `mode` | `apply` | `apply` mutates; `check` reports drift and exits 1 on any, making no settings changes (a private report may still be delivered) |
| `on-missing-permission` | `fail` | `warn` skips sections the token cannot access (partial success) |
| `required-sections` | (empty) | Sections that must fully apply even under `warn` |
| `sections` | (all declared) | Comma-separated allowlist of sections to process |
| `api-version` | `2022-11-28` | `X-GitHub-Api-Version` header; override to opt into a newer REST API version |
| `repos` | (empty) | Multi-repo remote mode: `owner/name` list (comma/newline), or `*` to discover owned repos |
| `repos-dir` | (empty) | Multi-repo central mode: directory of per-repo settings files in this repo |
| `defaults-file` | (empty) | YAML merged under every multi-repo target's settings (multi-repo mode only) |
| `private-repos` | `redact` | `redact` hides private and internal targets from public logs, summary, and outputs; `show` reveals them |
| `private-report` | `none` | `issue` delivers each redacted target's full report to a reused issue on that target repository; `artifact` uploads all reports as one age-encrypted workflow artifact; rejected with `private-repos: show` |
| `report-public-key` | (empty) | The `age1...` recipient the `artifact` channel encrypts reports to; required with `private-report: artifact`, rejected otherwise |
| `visibility` | `all` | Discovery-only: keep `public`, `private`, or `internal` repositories |
| `archived` | `skip` | Discovery-only: `skip`, `include`, or `only` archived repositories |
| `forks` | `include` | Discovery-only: `include`, `exclude`, or `only` forks |
| `exclude` | (empty) | Discovery-only: `*` wildcard patterns (name, or `owner/name` if the pattern has a `/`) to drop |
| `topics` | (empty) | Discovery-only: keep repositories carrying at least one listed topic |
| `affiliation` | `owner` | Discovery-only: `owner`, `collaborator`, `organization_member` (comma list) |

Outputs: `result` (`applied` / `partial` / `clean` / `drift` / `failed`;
worst-of across targets in multi-repo mode, where `skipped` can also
appear), `skipped-sections`, and `repos-result` (multi-repo mode: a JSON
map of `owner/name` to `{result, source, skippedSections}`). A redacted
private target is keyed by its `private repository #N` placeholder instead of
its slug; see [Private repositories](#private-repositories).

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
- uses: Vivswan/repo-settings-as-code@v1.0.1
  with:
    token: ${{ secrets.FLEET_TOKEN }}
    repos-dir: .github/repos
    defaults-file: .github/settings-defaults.yml
    repos: |
      other-org/service-a
      other-org/service-b
```

<!-- x-release-please-end -->

## Private repositories

GitHub Actions has no log-level access control. Run logs, step summaries, and
uploaded artifacts inherit the repository's visibility, so a public admin repo
managing a private target would print that target's slug, its live settings,
and its API error bodies where anyone can read them. The only GitHub-ACL-private
channel a public run has is another repository the token can reach.

To stop the leak, `private-repos: redact` (the default) hides every private or
internal target from the public view. The target's slug becomes a
`private repository #N` placeholder, its live values and error bodies become
`hidden (private repository)`, and each slug is registered with the runner's
secret masker so it cannot resurface in a stray log line. The visibility check
fails closed: a repository the probe cannot prove public is redacted anyway. A
target equal to `GITHUB_REPOSITORY` is never redacted, because a repository
acting on itself discloses nothing new. Set `private-repos: show` only when the
run's own logs are already private.

The decision comes down to the policy and what the visibility probe finds:

| Condition | Redacted? |
|---|---|
| `private-repos: show` | no, everything is revealed |
| target is `GITHUB_REPOSITORY` (self) | no, the carve-out applies |
| probe proves the target public | no |
| probe proves the target private or internal | yes |
| probe cannot determine visibility | yes, redaction fails closed |

### What a redacted run still shows

Redaction hides values, not the shape of the outcome. The public surfaces still
carry the safe skeleton of each target. The step summary shows, per target, the
overall result (`applied`, `partial`, `clean`, `drift`, `failed`, `skipped`),
each section's key and status, and the HTTP status code on a failed or skipped
section; the `repos-result` output carries `{result, source, skippedSections}`
per target, keyed by the placeholder. These are closed enumerations and numeric
codes, safe to show, and enough to tell whether the fleet is healthy and which
section broke. What they never carry is the slug, a live setting, a desired
setting, or an API error message.

### Seeing the full detail

Three ways to read the unredacted detail, in rough order of convenience:

- Run from a context whose logs are already private. Move the workflow into the
  target repository itself (the self carve-out gives full logs safely), or keep
  the admin repo private and set `private-repos: show`.
- Reproduce locally. The action is a plain Node bundle, so the same PAT and the
  same inputs reproduce the run on your machine, where the logs stay local. A
  shell variable name cannot contain a hyphen, so pass the hyphenated inputs
  through `env`:

  ```bash
  env INPUT_TOKEN=<your-pat> 'INPUT_REPOSITORY=owner/name' 'INPUT_PRIVATE-REPOS=show' \
    node lib/index.js
  ```

  Every input maps to an `INPUT_<NAME>` variable, uppercased with dashes kept
  (so `private-repos` is `INPUT_PRIVATE-REPOS`).
- Have the run deliver a private report, described next.

### Delivering a private report

`private-report` sends the full unredacted report for each redacted target
through a channel whose access control is not the public run. It defaults to
`private-report: none`, which delivers nothing. Any other channel applies only
to redacted targets, and only to those the visibility probe proves private or
internal: an unknown visibility is redacted from the public view but excluded
from delivery, so the report never reaches a repository that might be public.
It is rejected alongside `private-repos: show`. The report mirrors the run's
log, so it is written on every run, `mode: check` included, and a delivery
failure only warns; it never changes the target's or the run's result.

`private-report: issue` posts each target's report to a reused issue on that
target repository, where the repository's own access control protects it. The
action finds the issue by a marker label, replaces the body every run, and
opens the issue when the target fails or drifts and closes it when the target
is healthy. This needs the PAT to hold `"Issues"` (read and write) on every
target repository, on top of the section permissions. Prefer this channel
unless your readers lack GitHub access to the targets.

`private-report: artifact` concatenates the report for every proven-private
target into one document, encrypts it to an age recipient, and uploads it as the
workflow artifact `settings-as-code-private-report` (file
`private-report.md.age`). Use it when the people who need the report cannot be
given repository access, since the archive travels with the run rather than
living in the target repo. This channel needs the Actions artifact service, so
it does not work on GitHub Enterprise Server (the `@actions/artifact` client has
no GHES backend): there the run warns and uploads nothing. Access control here
is key possession, so the key setup matters:

- Generate a keypair on your own machine. The private key must never touch
  GitHub:

  ```bash
  age-keygen -o key.txt
  ```

  `key.txt` holds the secret identity; keep it off GitHub. The command also
  prints the public recipient (`age1...`), which is safe to commit.
- Pass that recipient as `report-public-key`. It is required when
  `private-report` is `artifact` and rejected otherwise; a malformed recipient
  fails the run at startup.
- Download and decrypt. The browser "Download" button gives a ZIP; unzip it,
  then decrypt with the identity file (or use `gh run download`, which extracts
  the artifact for you):

  ```bash
  gh run download <run-id> -n settings-as-code-private-report
  age -d -i key.txt private-report.md.age
  ```

One caveat weighs against this channel: the ciphertext is downloadable by
anyone during the artifact's retention window, and copies persist after that.
If the age key is ever compromised, every archived run it encrypted becomes
readable retroactively. The `issue` channel has no such standing exposure.

### What redaction does and does not protect

Redaction protects the target's live state and its errors. It does not
retroactively hide a name you already published. In a public admin repo, the
names in the `repos` input and the paths and contents of `repos-dir` files are
already public, so redaction there is limited:

| Target source | What is public regardless | What redaction protects |
|---|---|---|
| `repos` explicit list | the target name | live state, desired state, errors |
| `repos-dir` central file | the target name and the desired settings in the committed file | live state, errors |
| `repos: "*"` discovery | nothing | the name, live state, desired state, and errors |

Only `repos: "*"` discovery gives a target true non-disclosure, because its
name never appears in a committed file or input. For the other two sources, the
name is self-disclosed the moment you commit the workflow.

The visibility probe drives two decisions that fail closed in opposite
directions. Redaction fails closed toward hiding: a target the probe cannot
prove public is redacted. Delivery fails closed toward silence: a report is
sent only when the probe proves the target private or internal, so an unknown
visibility redacts the public view yet withholds the private report rather than
risk posting it to a repository that might be public.

A closing point on escape hatches: on a public repository, an unencrypted
artifact or a debug log is not a private channel. Both inherit the run's public
visibility. That is the whole reason the artifact channel encrypts, and the
reason redaction cannot be waved away with `ACTIONS_STEP_DEBUG`.

None of this requires a dedicated account. If you already run the fleet under a
machine user, it happens to fit well here: you can scope its PAT to least
privilege, point `repos: "*"` discovery at only what it owns, and get bot-named
authorship on the report issues. That is a convenience, not a prerequisite; a
personal PAT with the right permissions works the same way.

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
