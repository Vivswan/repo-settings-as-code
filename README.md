# GitHub Settings as Code

Apply declarative repository settings from `.github/settings.yml`: a loud, stateless replacement for the [Probot Settings app](https://github.com/repository-settings/app) that also manages [rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets) (branch, tag, and push). Every apply is a visible workflow run that fails with the API's error message; nothing happens silently.

## Usage

1. Create a [fine-grained PAT](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token): the [pre-filled token form][pat-form] starts you off with every repository permission the [Sections](#sections) table can need. Pick the resource owner and repositories, and add Members: read by hand when the owner is an organization; the form only offers organization permissions once one is selected. The default `GITHUB_TOKEN` can never hold these permissions.

2. Save the token as a repository secret; `ADMIN_TOKEN` below.

3. Declare your settings in `.github/settings.yml` (see the [example](#example-settingsyml) below). One line at the top gives editor autocomplete and hover docs (agents can fetch the same URL):

   ```yaml
   # yaml-language-server: $schema=https://raw.githubusercontent.com/Vivswan/github-settings-as-code/v2/lib/settings.schema.json # x-release-please-major
   ```

4. Add the workflow. On a repository with existing labels, autolinks, collaborators, Actions variables, or Copilot agents variables, also set `mode: check` under `with:` for the first run: the drift report lists everything an apply would delete, and nothing is written.

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
         - uses: Vivswan/github-settings-as-code@v2 # x-release-please-major
           with:
             token: ${{ secrets.ADMIN_TOKEN }}
   ```

5. Run it once from the Actions tab (workflow_dispatch), review the run, and drop `mode: check` if you set it. From then on every push that touches `.github/settings.yml` applies it.

A JSON Schema describing every section and its structured fields is generated from the zod schemas in `src/schema.ts` (the single source of the config types; their `.describe()` strings become the published descriptions) and served at `https://raw.githubusercontent.com/Vivswan/github-settings-as-code/<ref>/lib/settings.schema.json`, where `<ref>` picks the version: `v2` (canonical, the moving major tag, <!-- x-release-please-major --> always the newest schema in the line) or `vX.Y.Z` (an exact release). The `main` ref still works but is deprecated and will be removed in the next major (the schema's own `$id` names the `HEAD` copy as a version-free identity, not as a ref to pin). Passthrough areas (the `repository` payload, branch protection, rule parameters) stay open objects on purpose.

The schema is documentation, not a gate: unknown fields validate on purpose, because payloads pass through to the API verbatim and declaring a field GitHub ships tomorrow must never read as an error (see [Forward compatibility](docs/reference/forward-compatibility.md)).

## Guides

The guides live in [docs/](docs/README.md), in four groups:

- Start: [getting started](docs/start/getting-started.md), [migrating from Probot](docs/start/migrating-from-probot.md), and the [examples cookbook](docs/start/examples.md).
- Reference: [semantics](docs/reference/semantics.md), [token permissions](docs/reference/permissions.md), [the undeclared policy](docs/reference/undeclared-policy.md), [forward compatibility](docs/reference/forward-compatibility.md), and [secrets and vaults](docs/reference/secrets-and-vaults.md) (the `$NAME` references secret fields take).
- Operate: [check mode](docs/operate/check-mode.md), [multi-repo mode](docs/operate/multi-repo.md), [private repositories](docs/operate/private-repositories.md), and [troubleshooting](docs/operate/troubleshooting.md), which also covers per-call debug tracing.
- Playbooks: [complete workflows to adapt](docs/playbooks/README.md).

## Versioning

- `@v2` is a moving major tag: <!-- x-release-please-major --> every release in that major line moves it, so fixes arrive without changing your pin.
- Pinning exactly: pin `@vX.Y.Z` (or a commit SHA) when you need byte-stable behavior, and upgrade deliberately. Every version tag points at a packaged commit carrying the built action - its parent is the audited release commit on main - and is frozen by a ruleset.
- v2 activates settings keys that were inert on v1: `actions.oidc_customization_sub`, `actions.fork_pr_contributor_approval`, `actions.fork_pr_workflows_private_repos`, and `branches[].protection.required_signatures`. Before moving a `@v1` pin to `@v2`, audit any of those keys already in your settings files for intent; on v2 they act, and a stale `required_signatures: false` would remove a hand-enabled requirement.
- Only the latest release is supported; fixes are not backported (see [SECURITY.md](.github/SECURITY.md)).

## Sections

<!-- BEGIN GENERATED: readme-sections-table (bun run build:docs; edit src/sections/<key>/docs.ts) -->
| Section | Endpoints | PAT permission | Undeclared default | Notes |
|---|---|---|---|---|
| `repository` | PATCH repo, PUT topics, vulnerability-alerts, automated-security-fixes, private-vulnerability-reporting, lfs, immutable-releases, GraphQL RepositoryFeatures + UpdateRepositoryFeatures | Administration: write | untouched | Probot repository payload plus `enable_*` feature toggles; `topics` as string or list; `enable_sponsorships` and `issue_creation_policy` (`all`/`collaborators_only`) route through GraphQL - REST has no surface for them; declared fields only, undeclared siblings untouched |
| `labels` | labels CRUD | Issues: write | deleted (settable) | upsert by name (rename via `new_name`); the delete-by-default is Probot parity |
| `rulesets` | repo rulesets CRUD | Administration: write | kept (settable) | branch, tag, and push targets; short ref names auto-prefixed (`staging` -> `refs/heads/staging`); deletion stays an explicit opt-in |
| `environments` | PUT environments + per-environment variables, secrets, deployment branch policies, deployment protection rules, and pins (GraphQL EnvironmentPins + PinEnvironment + ReorderEnvironment) | Environments: write; declared `deployment_branch_policies` and `deployment_protection_rules` keys additionally need Actions: read and Administration: write | untouched | reviewers, wait timer, branch-policy flags; nested `variables`, `secrets`, `deployment_branch_policies`, and `deployment_protection_rules` keys reconcile per environment, each with its own `undeclared:` knob (within a declared key, undeclared variables and branch-policy patterns are deleted; secrets and protection rules are kept); a `pinned` key pins the environment on the home page's deployments sidebar over GraphQL (declaration order sets the pin order, max 10 pins; environments without the key are never unpinned) |
| `branches` | classic branch protection + required-signatures sub-endpoint + app-by-slug actor lookup + GraphQL BranchProtectionRules + BranchProtectionRepository + BranchProtectionActorUser + BranchProtectionActorTeam + CreateBranchProtectionRule + UpdateBranchProtectionRule + DeleteBranchProtectionRule | Administration: write | untouched | `protection: null` removes protection; the protection PUT drops `required_signatures`, so declare it on any branch already carrying it; `force_push_bypassers` (users, `org/team`, `app/slug`) and `required_deployments` ride the GraphQL rule mutation; wildcard entries (`release/*`) reconcile entirely through GraphQL with a fixed key set; add Contents: read so check mode can tell a missing branch from an unprotected one |
| `autolinks` | autolinks CRUD | Administration: write | deleted (settable) | immutable upstream, so changed entries are replaced |
| `actions` | actions permissions + selected-actions + workflow token + access level + artifact/log retention + cache limits + OIDC subject claim + fork PR policies | Administration: write; the `oidc_customization_sub` key alone instead needs Actions: write | untouched | keys with their own sub-endpoint route there; everything else rides the base permissions PUT verbatim |
| `actions_secrets` | actions secrets list + public-key + sealed PUT + delete | Secrets: write | kept (settable) | `{name, value: $NAME}` sealed writes, re-sent every apply; existence-only checks, values unrecoverable |
| `dependabot_secrets` | dependabot secrets list + public-key + sealed PUT + delete | Dependabot secrets: write | kept (settable) | as `actions_secrets`, over the Dependabot secret store |
| `codespaces_secrets` | codespaces secrets list + public-key + sealed PUT + delete | Codespaces secrets: write | kept (settable) | as `actions_secrets`, over the Codespaces secret store |
| `agents_secrets` | agents secrets list + public-key + sealed PUT + delete | Agent secrets: write | kept (settable) | as `actions_secrets`, over the Copilot agents secret store |
| `workflows` | Actions workflows list, enable/disable | Actions: write | untouched | `{path, state: active or disabled}`; bare file names match `.github/workflows/` |
| `check_suite_preferences` | check-suites preferences PATCH (no read endpoint exists upstream) | Checks: write | untouched | per-app `auto_trigger_checks` toggles; write-only: check mode cannot verify them (one note, zero requests) and apply re-asserts them every run; the token owner must be a repository administrator |
| `pages` | POST/PUT/DELETE pages | Pages: write | untouched | `build_type: workflow` or `legacy` + source, `cname`, `https_enforced`, `public` (GHEC site visibility); `pages: null` disables the site |
| `code_scanning_default_setup` | code scanning default setup | Administration or Code scanning alerts: write | untouched | `state`, `query_suite`, `languages`; needs Advanced Security on private repositories |
| `code_quality_setup` | code-quality setup | Administration: write | untouched | `state`, `languages`, runner and AI-findings options; a 202 means GitHub rolls the change out in a configuration run; needs code quality available on the repository |
| `collaborators` | direct collaborators + pending invitations | Administration: write | deleted (settable) | invitations for new users, pending ones reconciled (stale permission updated, expired re-sent, undeclared cancelled); the repository owner is never touched |
| `teams` | org team repo permissions | Members: read (org permission) + Administration: write | untouched | org repos only, skipped with a notice on personal accounts |
| `milestones` | milestones | Issues: write | kept (settable) | upsert by title; deleting a milestone detaches it from every issue carrying it, which is why keep is the default |
| `interaction_limits` | interaction-limits + pulls creation-cap/bypass-list | Administration: write | untouched | re-arms the self-expiring limit every apply run; `null` clears it (base limit only); a 409 (org/user-level limit overrides) becomes a note; the PR creation cap is persistent (PATCHed only on divergence, 405 where unavailable) and its bypass logins reconcile add/remove |
| `actions_variables` | Actions variables CRUD | Variables: write | deleted (settable) | plain-text variables upserted by name (case-insensitive); values read back in full, so check mode diffs them exactly |
| `agents_variables` | Copilot agents variables CRUD | Agent variables: write | deleted (settable) | as `actions_variables`, over the Copilot agents variable store |
| `webhooks` | hooks CRUD + hook config sub-endpoint | Webhooks: write | kept (settable) | one hook per `config.url`, the natural key; `config.secret` takes a `$NAME` reference and is re-sent every run |
| `custom_properties` | GET/PATCH properties/values; probes GET /orgs/{owner} | Custom properties: write | kept (settable) | values of org-defined properties (definitions are org-scoped); org repos only, skipped with a notice on personal accounts; `value: null` unsets |
| `deploy_keys` | deploy keys list/create/delete | Administration: write | kept (settable) | matched by title; the declared material is a PUBLIC key; immutable upstream, so changed entries are replaced |
| `secret_scanning_custom_patterns` | secret-scanning custom patterns: paginated list + bulk POST + PATCH by id + bulk DELETE | Secret scanning alerts: write | kept (settable) | matched by name (immutable upstream); `state` and `push_protection_enabled` are not declarable; deletes always resolve alerts |
<!-- END GENERATED: readme-sections-table -->

The Undeclared default column says what happens to live resources the settings file does not declare; `(settable)` means the wrapped `undeclared:` form can override it per file. [The undeclared policy](docs/reference/undeclared-policy.md) covers the knob and how it layers with a multi-repo defaults file.

The model in three lines: the engine is stateless and declared-keys-only (a key you do not declare is never touched or compared), applies are convergent (a check right after an apply reports clean), and every failure is loud, carrying the API's message verbatim. [Semantics](docs/reference/semantics.md) is the full model: softenable errors, retries, and the preflight barrier.

Payloads pass through to the API verbatim except for documented normalizations, so fields and rule types GitHub ships tomorrow work the day they exist; a handful of sections are instead closed to catch typos that would otherwise misconfigure silently. [Forward compatibility](docs/reference/forward-compatibility.md) draws that line section by section.

See [COVERAGE.md](COVERAGE.md) for the full per-section detail: every row above expanded with its exact endpoints, semantics, and caveats, plus every repo-scoped gap and the user-scoped surface that is out of scope by design.

## Example settings.yml

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/Vivswan/github-settings-as-code/v2/lib/settings.schema.json # x-release-please-major

repository:
  description: My project
  topics: tooling, github-actions
  has_wiki: false
  delete_branch_on_merge: true

labels:
  - name: bug
    color: "d73a4a"
    description: Something isn't working
```

The [examples cookbook](docs/start/examples.md) is the full tour: a full-featured file exercising every section, classic branch protection, and what `null` means where it is meaningful.

## Inputs

<!-- BEGIN GENERATED: readme-inputs-table (bun run build:action-docs; edit src/action/inputs.ts) -->
| Input | Default | Meaning |
|---|---|---|
| `token` | `github.token` | Token for the API calls (see [Token permissions](docs/reference/permissions.md)) |
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
| `private-report` | `none` | `issue` delivers each redacted target's full report to a reused issue on that target repository; `issue-on-failure` writes that issue only when the target fails or drifts, closing it once healthy; `artifact` uploads all reports as one age-encrypted workflow artifact; rejected with `private-repos: show` |
| `report-public-key` | (empty) | The `age1...` recipient the `artifact` channel encrypts reports to; required with `private-report: artifact`, rejected otherwise |
| `visibility` | `all` | Discovery-only: keep `public`, `private`, or `internal` repositories |
| `archived` | `skip` | Discovery-only: `skip`, `include`, or `only` archived repositories |
| `forks` | `include` | Discovery-only: `include`, `exclude`, or `only` forks |
| `exclude` | (empty) | Discovery-only: `*` wildcard patterns (name, or `owner/name` if the pattern has a `/`) to drop |
| `topics` | (empty) | Discovery-only: keep repositories carrying at least one listed topic |
| `affiliation` | `owner` | Discovery-only: `owner`, `collaborator`, `organization_member` (comma list) |
<!-- END GENERATED: readme-inputs-table -->

Outputs: `result` (<!-- BEGIN GENERATED: readme-outputs (bun run build:docs; derived from REPO_RESULTS in src/engine/orchestrate.ts) -->`applied` / `partial` / `clean` / `drift` / `failed`; worst-of across targets in multi-repo mode, where `skipped` can also appear<!-- END GENERATED: readme-outputs -->), `skipped-sections`, and `repos-result` (multi-repo mode: a JSON map of `owner/name` to `{result, source, skippedSections}`). A redacted private target is keyed by its `private repository #N` placeholder instead of its slug; see [Private repositories](#private-repositories).

## Multi-repo mode

One run in an admin repository can manage a whole fleet. Two sourcing modes are usable together: `repos-dir` names a directory of per-repo settings files in the admin repository, and `repos` lists targets applied from their own `.github/settings.yml` (`repos: "*"` discovers them). When both name the same repository, the central file wins. A `defaults-file` merges under every target, and a target's `null` section opts out of a section the defaults declare. Targets run independently and sequentially; one failure never stops the rest. The [multi-repo guide](docs/operate/multi-repo.md) owns the rules: sourcing precedence, the discovery filters, the merge, and the fleet patterns.

## Private repositories

A public admin repository managing private targets would leak their slugs, live settings, and API error bodies into public logs. `private-repos: redact` (the default) hides every private or internal target behind a placeholder, and the `private-report` input can deliver each target's full report over a private channel. The [private repositories guide](docs/operate/private-repositories.md) covers what is hidden, what stays visible, and how to read the full detail.

## Migrating from the Probot Settings app

This action started as a replacement for the Probot Settings app (repository-settings/app), so the schema is a superset of Probot's: an existing settings.yml keeps working, and migration is swapping the app installation for a workflow.

### Compared to the Probot Settings app

| | Probot Settings app | This action |
|---|---|---|
| Delivery | GitHub App you install (hosted by a third party, or self-hosted) | A step in your own workflow; no app installation, no third party |
| Failure visibility | Silent: no run log a repo owner can open; a misconfigured or uninstalled app just does nothing | Every apply is a workflow run with a log, annotations, a step summary, and a red X on failure |
| Drift detection | None | mode: check reports drift between the file and the live repo, exits 1 when it finds any, changes no settings |
| Rulesets | Experimental upstream feature; schema may change | First class: branch, tag, and push targets, upsert by name; undeclared rulesets kept by default, `undeclared: delete` opts into deletion |
| Partial success policy | None | on-missing-permission: fail or warn, plus required-sections as a minimum-requirements floor |
| Token | App installation token; its scope is invisible in the repo | A PAT you mint and scope yourself; permission errors name the exact missing permission |
| Org-level shared config | Yes (org _settings repo with extends) | Yes, as multi-repo mode: an admin repo with a defaults-file plus per-repo files (repos-dir) or each repo's own settings.yml (repos input); no hosted app needed |
| Call transparency | None | Every API call is traced as a debug line (method, path, payload, status, timing) when debug logging is on |

The one Probot-family feature without a direct equivalent is suborg-level grouping (safe-settings' .github/suborgs layer); here the layers are the defaults-file and per-repo files. Everything else in Probot's schema is supported, plus the rows above.

Your existing `settings.yml` works as-is for `repository`, `labels`, `branches`, `collaborators`, `teams`, and `milestones` (for the list sections among them, the plain-array form remains Probot-compatible; the object-shaped sections keep their original Probot shapes). Uninstall the app, add the workflow above, and optionally move branch protection to `rulesets`. Differences: applies run visibly in Actions (loud failures instead of silent skips), rulesets are supported, and nothing except labels/autolinks/collaborators/Actions variables/Copilot agents variables - plus, WITHIN a declared per-environment key, that environment's variables and deployment branch-policy patterns, and WITHIN a declared `pull_request_creation_bypass` key, that list's undeclared logins - is ever deleted implicitly.

The step-by-step move, including an org-scale shadow run alongside the app, is the [migration guide](docs/start/migrating-from-probot.md).

## Contributing

The toolchain, the end-to-end harness, and the PR conventions are documented in [CONTRIBUTING.md](CONTRIBUTING.md).

<!-- BEGIN GENERATED: readme-pat-url (bun run build:docs; derived from RESOURCE_SLUGS in src/sections/contract/permissions.ts) -->
[pat-form]: https://github.com/settings/personal-access-tokens/new?name=github-settings-as-code&description=Token+for+Vivswan%2Fgithub-settings-as-code&administration=write&issues=write&environments=write&pages=write&actions=write&actions_variables=write&repository_hooks=write&checks=write&secrets=write&dependabot_secrets=write&codespaces_secrets=write&agent_secrets=write&agent_variables=write&repository_custom_properties=write&secret_scanning_alerts=write&contents=read
<!-- END GENERATED: readme-pat-url -->
