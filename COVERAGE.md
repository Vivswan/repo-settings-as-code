# Coverage

The tenet: this action can control everything about a repository and
nothing about the user. This page is the honest inventory: what works
today, what is repo-scoped but not built yet, and what is out of scope
because it belongs to a user or organization account.

## Compared to the Probot Settings app

This action started as a replacement for the [Probot Settings app](https://github.com/repository-settings/app)
(repository-settings/app), so the schema is a superset of Probot's:
an existing settings.yml keeps working, and migration is swapping the
app installation for a workflow. What changes:

| | Probot Settings app | This action |
|---|---|---|
| Delivery | GitHub App you install (hosted by a third party, or self-hosted) | A step in your own workflow; no app installation, no third party |
| Failure visibility | Silent: no run log a repo owner can open; a misconfigured or uninstalled app just does nothing | Every apply is a workflow run with a log, annotations, a step summary, and a red X on failure |
| Drift detection | None | mode: check reports every difference between the file and the live repo, exits 1 on drift, writes nothing |
| Rulesets | Experimental upstream feature; schema may change | First class: branch, tag, and push targets, upsert by name, never deletes undeclared rulesets |
| Partial success policy | None | on-missing-permission: fail or warn, plus required-sections as a minimum-requirements floor |
| Token | App installation token; its scope is invisible in the repo | A PAT you mint and scope yourself; permission errors name the exact missing permission |
| Org-level shared config | Yes (org _settings repo with extends) | Yes, as multi-repo mode: an admin repo with a defaults-file plus per-repo files (repos-dir) or each repo's own settings.yml (repos input); no hosted app needed |
| Call transparency | None | Every API call is traced as a debug line (method, path, payload, status, timing) when debug logging is on |

The one Probot-family feature without a direct equivalent is suborg-level
grouping (safe-settings' .github/suborgs layer); here the layers are the
defaults-file and per-repo files. Everything else in Probot's schema is
supported, plus the rows above.

## Supported

| Area | Section | Notes |
|---|---|---|
| [Repository core settings](https://docs.github.com/en/rest/repos/repos) (name, description, homepage, visibility/private, has_issues, has_wiki, has_projects, has_discussions, merge-strategy toggles, squash/merge commit title+message, delete_branch_on_merge, allow_update_branch, allow_auto_merge, web_commit_signoff_required, is_template, archived, default_branch) | `repository` | PATCH /repos/{owner}/{repo} verbatim passthrough (src/sections/repository.ts). Any current or FUTURE field GitHub adds to the repo PATCH body works day one with no action update, the future-compatibility tenet's strongest case. Check mode = subsetDiff of declared keys against GET /repos. |
| [security_and_analysis](https://docs.github.com/en/rest/repos/repos) (GitHub Advanced Security, secret scanning, push protection, and any future nested toggles) | `repository` | Nested object inside the same PATCH /repos passthrough; flows through untouched. New sub-toggles GitHub adds (e.g. secret_scanning_ai_detection) work automatically. |
| [Topics](https://docs.github.com/en/rest/repos/repos) | `repository (topics key)` | PUT /repos/{owner}/{repo}/topics. Only normalization: string-to-list splitting (normalizeTopics) and order-insensitive compare in check mode. |
| [Dependabot alerts](https://docs.github.com/en/rest/repos/repos) (vulnerability alerts) | `repository (enable_vulnerability_alerts)` | PUT/DELETE /repos/{owner}/{repo}/vulnerability-alerts; check mode probes GET and treats 404 as disabled. |
| [Dependabot security updates](https://docs.github.com/en/rest/repos/repos) (automated security fixes) | `repository (enable_automated_security_fixes)` | PUT/DELETE /repos/{owner}/{repo}/automated-security-fixes; check handles both 204-empty and {enabled} body shapes. |
| [Forking policy](https://docs.github.com/en/rest/repos/repos) | `repository (allow_forking, fork-related PATCH fields)` | allow_forking and any other fork-policy fields on the repo object ride the PATCH passthrough. (Org-side 'members can fork' policy is org-scoped, out of scope.) |
| [Labels](https://docs.github.com/en/rest/issues/labels) | `labels` | Full CRUD on /repos/{owner}/{repo}/labels: upsert by name, rename via new_name (Probot parity), undeclared labels DELETED loudly. |
| [Rulesets](https://docs.github.com/en/rest/repos/rules) (branch, tag, and push targets; all rule types, conditions, bypass_actors) | `rulesets` | GET/POST/PUT /repos/{owner}/{repo}/rulesets: upsert-by-name, full-payload PUT, verbatim passthrough except ref-name prefixing (staging -> refs/heads/staging, ~DEFAULT_BRANCH passes through). New rule types/bypass fields/condition types GitHub ships work day one. Undeclared rulesets never deleted (notes only). Org-sourced rulesets filtered out via source_type. |
| [Merge queue](https://docs.github.com/en/rest/repos/rules) | `rulesets` | Configured as the merge_queue rule type inside a branch ruleset; passes through verbatim like every other rule type. No dedicated endpoint exists; rulesets ARE the API for merge queue. |
| [Tag protection (modern)](https://docs.github.com/en/rest/repos/rules) | `rulesets` | target: tag rulesets cover everything the retired legacy tag-protection API did (legacy API itself is out of scope, removed by GitHub). |
| [Classic branch protection](https://docs.github.com/en/rest/branches/branch-protection) | `branches` | PUT /repos/{owner}/{repo}/branches/{branch}/protection passthrough; the four required keys are null-filled; protection: null issues DELETE. Check mode flattens the GET shape ({enabled} wrappers, actor objects -> login/slug strings, *_url dropped) to compare like with like (src/sections/branches.ts flattenProtection). |
| [Environments](https://docs.github.com/en/rest/deployments/environments) (wait_timer, reviewers, prevent_self_review, deployment_branch_policy protected_branches/custom_branch_policies flags) | `environments` | PUT /repos/{owner}/{repo}/environments/{name} passthrough; check mode flattens GET's protection_rules[] back into the PUT shape. CAVEATS: custom branch-policy PATTERNS, env secrets, and env variables are separate endpoints, listed as gaps. Undeclared environments are left untouched. |
| [Autolinks](https://docs.github.com/en/rest/repos/autolinks) | `autolinks` | GET/POST/DELETE /repos/{owner}/{repo}/autolinks; immutable upstream so changed entries are delete+recreate; undeclared autolinks DELETED. |
| [Actions permissions](https://docs.github.com/en/rest/actions/permissions) (enabled, allowed_actions + any future base-permission fields; selected_actions policy; workflow token default permissions + can_approve_pull_request_reviews) | `actions` | Key routing (src/sections/misc.ts): the two known workflow-token keys -> PUT .../actions/permissions/workflow, selected_actions -> PUT .../permissions/selected-actions, EVERYTHING else -> base PUT .../actions/permissions verbatim. allowed_actions implies enabled: true. RISK: a future key that belongs on a NEW sub-endpoint (e.g. access_level) gets routed to the base PUT where GitHub ignores it (see the access-level gap). |
| [GitHub Pages](https://docs.github.com/en/rest/pages/pages) (build_type, source, cname, https_enforced and future PUT fields) | `pages` | POST /repos/{owner}/{repo}/pages (create accepts only build_type/source) then PUT for the rest; existing sites get straight PUT passthrough. Cannot declare Pages OFF; no DELETE path (see gap). |
| [Collaborators](https://docs.github.com/en/rest/collaborators/collaborators) (direct) | `collaborators` | PUT/DELETE /repos/{owner}/{repo}/collaborators/{username} (affiliation=direct); vocabulary mapping push<->write, pull<->read for check mode; custom org role names pass through; undeclared direct collaborators REMOVED, owner never touched; new users get invitations. |
| [Team repository permissions](https://docs.github.com/en/rest/teams/teams) (org repos) | `teams` | PUT /orgs/{org}/teams/{slug}/repos/{owner}/{repo}; probes GET /orgs/{owner} and no-ops with a note on personal accounts (404 only; 403/5xx still fail). Check mode uses the v3.repository media type to read role_name. |
| [Milestones](https://docs.github.com/en/rest/issues/milestones) | `milestones` | POST/PATCH /repos/{owner}/{repo}/milestones, matched by title, declared-keys-only (description/state untouched unless declared); undeclared milestones kept (may hold issues) and surfaced as notes. |

## Repo-scoped gaps (not built yet)

Ordered roughly by value. PRs welcome; each needs a new section handler.

| Area | Endpoints | Why it matters |
|---|---|---|
| [Webhooks](https://docs.github.com/en/rest/repos/webhooks) | GET/POST /repos/{owner}/{repo}/hooks; PATCH/DELETE /repos/{owner}/{repo}/hooks/{hook_id}; GET/PATCH /repos/{owner}/{repo}/hooks/{hook_id}/config | The single biggest hole in 'control everything about a repository': webhooks are a first-class settings-page tab and almost entirely pure config (url, content_type, events, active, insecure_ssl). Natural key is config.url, fitting the upsert-by-name model. Only wrinkle is material: the secret is write-only (never returned by GET), so check mode can verify everything except the secret and applies must treat secret as always-write. |
| [Actions variables](https://docs.github.com/en/rest/actions/variables) | GET/POST /repos/{owner}/{repo}/actions/variables; GET/PATCH/DELETE /repos/{owner}/{repo}/actions/variables/{name} | Pure config, plain-text, fully readable back: the ideal declarative resource. Trivially diffable in check mode, natural-key by name, delete-undeclared is safe and loud. Cheapest high-value section to add. |
| [Environment variables](https://docs.github.com/en/rest/actions/variables) | GET/POST /repos/{owner}/{repo}/environments/{name}/variables; GET/PATCH/DELETE .../variables/{var_name} | Same pure-config profile as repo Actions variables and completes the existing environments section (declared as a nested key per environment). No material concerns. |
| [Environment deployment branch policies](https://docs.github.com/en/rest/deployments/branch-policies) (custom patterns) | GET/POST /repos/{owner}/{repo}/environments/{name}/deployment-branch-policies; PUT/DELETE .../deployment-branch-policies/{branch_policy_id} | The environments section can already declare custom_branch_policies: true but has NO way to declare the actual patterns, leaving the feature half-configured; a user must finish in the UI, which contradicts the tenet. Pure config, upsert by name pattern. |
| [Private vulnerability reporting](https://docs.github.com/en/rest/repos/repos) | GET /repos/{owner}/{repo}/private-vulnerability-reporting; PUT (enable) / DELETE (disable) same path | A single boolean toggle with exactly the same enable/disable shape as vulnerability-alerts and automated-security-fixes already special-cased in the repository section; near-zero implementation cost and it rounds out the security toggles. |
| [Actions workflow access level](https://docs.github.com/en/rest/actions/permissions) (and newer fork-PR policy sub-endpoints) | GET/PUT /repos/{owner}/{repo}/actions/permissions/access (body: {access_level}) | Repo-scoped pure config for private/internal repos. Worse than a plain gap: the actions section's else-branch routing sends an access_level key to the base permissions PUT, where GitHub silently ignores it, a silent drop that directly violates the 'nothing silently dropped' tenet. Needs a routing entry (and the same audit applies to any future permissions sub-endpoint GitHub adds). |
| [Actions OIDC subject claim customization](https://docs.github.com/en/rest/actions/oidc) | GET/PUT /repos/{owner}/{repo}/actions/oidc/customization/sub (body: {use_default, include_claim_keys}) | Pure config, readable back, security-relevant for cloud OIDC trust policies; small fixed schema makes it a cheap addition under the actions section. |
| [Deploy keys](https://docs.github.com/en/rest/deploy-keys/deploy-keys) | GET/POST /repos/{owner}/{repo}/keys; GET/DELETE /repos/{owner}/{repo}/keys/{key_id} | Repo-scoped and REST-configurable; the declared material is a PUBLIC key, so it is safe to keep in settings.yml (unlike secrets). Keys are immutable upstream, so the autolinks replace-on-diff pattern applies (title, key, read_only). Material distinction: public-key-only makes this tractable where secrets are not. |
| [Actions secrets](https://docs.github.com/en/rest/actions/secrets) | GET /repos/{owner}/{repo}/actions/secrets; PUT /repos/{owner}/{repo}/actions/secrets/{name} (libsodium-sealed with GET .../secrets/public-key); DELETE .../secrets/{name} | Repo-scoped, but values are write-only material that cannot live in settings.yml and cannot be read back, so a section can only do existence reconciliation (declare names, delete undeclared, flag missing) with values injected from workflow secrets at apply time. Useful but semantically weaker than pure-config sections; design carefully before promising drift detection. |
| [Environment secrets](https://docs.github.com/en/rest/actions/secrets) | GET/PUT/DELETE /repos/{owner}/{repo}/environments/{name}/secrets/{secret_name} (+ .../secrets/public-key) | Same write-only-material profile as Actions secrets, scoped per environment; existence-only reconciliation. Would ship together with an Actions-secrets design. |
| [Custom property values](https://docs.github.com/en/rest/repos/custom-properties) | GET /repos/{owner}/{repo}/properties/values; PATCH same path (org-defined properties, values set per repo) | Repo-scoped pure config with a PATCH-upsert shape that fits declared-keys-only semantics perfectly. Limited to org-owned repos (property DEFINITIONS are org-scoped and out of scope), which narrows the audience for a personal-account-first action. |
| [Code scanning default setup](https://docs.github.com/en/rest/code-scanning/code-scanning) | GET/PATCH /repos/{owner}/{repo}/code-scanning/default-setup (state, query_suite, languages) | Repo-scoped security config not reachable via the security_and_analysis PATCH block. Pure config, but PATCH returns 202 with async setup and language auto-detection, so check-mode comparison needs care (compare state/query_suite, treat languages as advisory). |
| [Dependabot secrets](https://docs.github.com/en/rest/dependabot/secrets) | GET /repos/{owner}/{repo}/dependabot/secrets; PUT/DELETE .../dependabot/secrets/{name} (+ public-key) | Identical write-only-material constraints as Actions secrets but a much smaller audience (private-registry credentials for Dependabot). Existence-only reconciliation; low demand. |
| [Codespaces repository secrets](https://docs.github.com/en/rest/codespaces/repository-secrets) | GET /repos/{owner}/{repo}/codespaces/secrets; PUT/DELETE .../codespaces/secrets/{name} (+ public-key) | The only repo-scoped Codespaces configuration surface (machine policies and user/org secrets are account-scoped). Write-only material, niche feature. |
| [Interaction limits](https://docs.github.com/en/rest/interactions/repos) | GET/PUT/DELETE /repos/{owner}/{repo}/interaction-limits (limit + expiry) | Repo-scoped and REST-configurable, but limits self-expire (expiry is mandatory), so a stateless declarative model re-arms them on every run and check mode drifts by design once they lapse. Awkward fit; document rather than rush. |
| [Workflow enable/disable state](https://docs.github.com/en/rest/actions/workflows) | GET /repos/{owner}/{repo}/actions/workflows; PUT .../workflows/{workflow_id}/enable and .../disable | Repo-scoped toggle keyed by workflow file path; occasionally useful (permanently disabling a vendored workflow) but overlaps with just deleting the file, which the repo's own content controls. |
| [Pending invitation reconciliation](https://docs.github.com/en/rest/collaborators/invitations) | GET /repos/{owner}/{repo}/invitations; PATCH/DELETE /repos/{owner}/{repo}/invitations/{invitation_id} | The collaborators section sends invitations but never lists pending ones, so an outstanding invite with a stale permission (or to an undeclared user) is invisible to check mode and never corrected/cancelled. Completeness fix for an existing section. |
| [Pages disable](https://docs.github.com/en/rest/pages/pages) | DELETE /repos/{owner}/{repo}/pages | The pages section can create and update a site but offers no way to declare Pages off (e.g. pages: null, mirroring branches' protection: null). Small parity gap in an existing section. |

## No public API (cannot be built)

Repo-scoped settings the GitHub UI offers but no REST or GraphQL endpoint
exposes. These stay unsupported until GitHub ships an API for them:

- The "Include in the home page" sidebar checkboxes (Releases, Packages,
  Deployments/Environments). [PATCH /repos/{owner}/{repo}](https://docs.github.com/en/rest/repos/repos) has toggles for
  issues, wiki, projects, pull requests, and discussions, but nothing
  controls those three sections' visibility.
- Discussion categories. No REST endpoint creates or manages them, and
  GraphQL can only read them; category management is UI-only. Enabling
  discussions itself (has_discussions) rides the repository PATCH
  passthrough (verified live; the [PATCH docs](https://docs.github.com/en/rest/repos/repos) omit the field but the API
  accepts it).

## Out of scope (user or org account surface)

- User account surface (profile, emails, notification settings, SSH/GPG/signing keys, blocking, starring/watching, user migrations): User-scoped, not repository configuration, exactly what the tenet's second half excludes. Watching/subscription state on a repo is likewise per-user, not a property of the repo.
- Organization settings (membership, org-level Actions policies, runner groups, org webhooks, org rulesets, org secrets/variables and their repo-selection lists, custom property DEFINITIONS, custom repository roles, code security configurations): Org-account-scoped (/orgs/* endpoints); they influence repos from above but are not settings OF a repository. Their repo-visible effects (org rulesets, applied security configs) surface read-only and are already filtered out (e.g. rulesets skips source_type != Repository).
- GitHub Packages: Package namespaces and their settings belong to the user or org account even when a package is linked to a repo; explicitly user/account territory under the tenet.
- Legacy tag protection API: Deprecated and removed by GitHub (sunset August 2024); no endpoints remain. Its function is fully covered by tag-target rulesets, which are supported.
- Projects: Classic repo projects are sunset; Projects v2 are user/org-owned GraphQL objects merely linked to repos. The repo-level has_projects flag rides the repository PATCH passthrough.
- Releases: Releases are content/artifacts, not configuration; there is no repo release-settings REST surface. If GitHub ever exposes release policy as a field on PATCH /repos, the repository passthrough picks it up automatically.
- Repo-content-borne configuration (CODEOWNERS, dependabot.yml, workflow files, issue/PR templates, FUNDING.yml, .gitattributes): These are versioned files in the repository tree, managed by commits/PRs (e.g. by the copier template layer), not by the settings REST API. Writing repo content is a different tool's job.
- Self-hosted runners (repo-level registration, labels): Operational infrastructure lifecycle: registration requires short-lived tokens and a live agent process; there is no meaningful declarative desired-state to reconcile from a YAML file.
- Imperative repository operations (transfer, archive-via-migration, fork creation, branch create/rename, workflow/repository dispatch, cache purges, alert triage for code scanning / secret scanning / Dependabot alerts, issues and PRs): One-shot actions or work items, not settings; running them repeatedly from declarative state is meaningless or destructive. (The archived boolean itself IS supported via repository PATCH.)
- Codespaces user/org configuration (user secrets, machine-type policies, org access controls): User- and org-scoped; the only repo-scoped Codespaces surface is repository Codespaces secrets, which is tracked as a gap.
- Read-only repository surfaces (traffic, statistics, languages, SBOM/dependency graph exports, attestations, community profile): Nothing to configure; GET-only endpoints with no desired state to apply.
