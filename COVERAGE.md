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
| [Private vulnerability reporting](https://docs.github.com/en/rest/repos/repos) | `repository (enable_private_vulnerability_reporting)` | PUT/DELETE /repos/{owner}/{repo}/private-vulnerability-reporting; check reads the {enabled} body from GET. Repositories where the feature does not apply (observed: private repos) answer 404 or 422, which check treats as "not enabled" and disable treats as already done. |
| [Forking policy](https://docs.github.com/en/rest/repos/repos) | `repository (allow_forking, fork-related PATCH fields)` | allow_forking and any other fork-policy fields on the repo object ride the PATCH passthrough. (Org-side 'members can fork' policy is org-scoped, out of scope.) |
| [Labels](https://docs.github.com/en/rest/issues/labels) | `labels` | Full CRUD on /repos/{owner}/{repo}/labels: upsert by name, rename via new_name (Probot parity), undeclared labels DELETED loudly. |
| [Rulesets](https://docs.github.com/en/rest/repos/rules) (branch, tag, and push targets; all rule types, conditions, bypass_actors) | `rulesets` | GET/POST/PUT /repos/{owner}/{repo}/rulesets: upsert-by-name, full-payload PUT, verbatim passthrough except ref-name prefixing (staging -> refs/heads/staging, ~DEFAULT_BRANCH passes through). New rule types/bypass fields/condition types GitHub ships work day one. Undeclared rulesets never deleted (notes only). Org-sourced rulesets filtered out via source_type. |
| [Merge queue](https://docs.github.com/en/rest/repos/rules) | `rulesets` | Configured as the merge_queue rule type inside a branch ruleset; passes through verbatim like every other rule type. No dedicated endpoint exists; rulesets ARE the API for merge queue. |
| [Tag protection (modern)](https://docs.github.com/en/rest/repos/rules) | `rulesets` | target: tag rulesets cover everything the retired legacy tag-protection API did (legacy API itself is out of scope, removed by GitHub). |
| [Classic branch protection](https://docs.github.com/en/rest/branches/branch-protection) | `branches` | PUT /repos/{owner}/{repo}/branches/{branch}/protection passthrough; the four required keys are null-filled; protection: null issues DELETE. Check mode flattens the GET shape ({enabled} wrappers, actor objects -> login/slug strings, *_url dropped) to compare like with like (src/sections/branches.ts flattenProtection). CAVEAT: required_signatures is the one toggle the PUT does not accept; it needs its own sub-endpoint, listed in the gaps table. |
| [Environments](https://docs.github.com/en/rest/deployments/environments) (wait_timer, reviewers, prevent_self_review, deployment_branch_policy protected_branches/custom_branch_policies flags) | `environments` | PUT /repos/{owner}/{repo}/environments/{name} passthrough; check mode flattens GET's protection_rules[] back into the PUT shape. CAVEATS: custom branch-policy PATTERNS, env secrets, and env variables are separate endpoints, listed as gaps. Undeclared environments are left untouched. |
| [Autolinks](https://docs.github.com/en/rest/repos/autolinks) | `autolinks` | GET/POST/DELETE /repos/{owner}/{repo}/autolinks; immutable upstream so changed entries are delete+recreate; undeclared autolinks DELETED. |
| [Actions permissions](https://docs.github.com/en/rest/actions/permissions) (enabled, allowed_actions + any future base-permission fields; selected_actions policy; workflow token default permissions + can_approve_pull_request_reviews; workflows access_level) | `actions` | Key routing (src/sections/actions.ts): the two known workflow-token keys -> PUT .../actions/permissions/workflow, selected_actions -> PUT .../permissions/selected-actions, access_level -> PUT .../permissions/access (private repositories only), EVERYTHING else -> base PUT .../actions/permissions verbatim. allowed_actions implies enabled: true. RISK: a future key that belongs on a NEW sub-endpoint gets routed to the base PUT where GitHub ignores it; audit the routing whenever GitHub adds a permissions sub-endpoint. |
| [Workflow enable/disable state](https://docs.github.com/en/rest/actions/workflows) | `workflows` | GET /repos/{owner}/{repo}/actions/workflows (paginated envelope), then PUT .../workflows/{id}/enable or /disable. Declared as {path, state: active or disabled}; a bare file name matches .github/workflows/<name>; every live disabled_* state counts as disabled and a live "deleted" workflow counts as absent; undeclared workflows are never touched. |
| [GitHub Pages](https://docs.github.com/en/rest/pages/pages) (build_type, source, cname, https_enforced and future PUT fields; pages: null disables the site) | `pages` | POST /repos/{owner}/{repo}/pages (create accepts only build_type/source) then PUT for the rest; existing sites get straight PUT passthrough; pages: null issues DELETE, mirroring branches' protection: null. In multi-repo mode, pages: null in a target is a defaults opt-out instead when the defaults file declares a non-null pages value. |
| [Code scanning default setup](https://docs.github.com/en/rest/code-scanning/code-scanning) | `code_scanning_default_setup` | GET/PATCH /repos/{owner}/{repo}/code-scanning/default-setup, PATCH body verbatim (state, query_suite, languages, runner_type, runner_label, threat_model). A 202 answer means GitHub rolls the change out in a configuration run, which the log names. Check compares declared keys only, languages as a set. Needs GitHub Advanced Security on private repositories; a 403 can mean that (or an archived repository) rather than a missing permission. |
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
| [Actions OIDC subject claim customization](https://docs.github.com/en/rest/actions/oidc) | GET/PUT /repos/{owner}/{repo}/actions/oidc/customization/sub (body: {use_default, include_claim_keys}) | Pure config, readable back, security-relevant for cloud OIDC trust policies; small fixed schema makes it a cheap addition under the actions section. |
| [Deploy keys](https://docs.github.com/en/rest/deploy-keys/deploy-keys) | GET/POST /repos/{owner}/{repo}/keys; GET/DELETE /repos/{owner}/{repo}/keys/{key_id} | Repo-scoped and REST-configurable; the declared material is a PUBLIC key, so it is safe to keep in settings.yml (unlike secrets). Keys are immutable upstream, so the autolinks replace-on-diff pattern applies (title, key, read_only). Material distinction: public-key-only makes this tractable where secrets are not. |
| [Immutable releases](https://docs.github.com/en/rest/repos/repos) | GET /repos/{owner}/{repo}/immutable-releases (returns {enabled, enforced_by_owner}, 404 when off); PUT (enable) / DELETE (disable) same path | A release-policy toggle with the same GET/PUT/DELETE + 404-means-off profile as vulnerability-alerts, so the repository-section toggle pattern applies directly. enforced_by_owner in the GET body is read-only owner-level enforcement, worth surfacing in check mode. |
| [Git LFS enable/disable](https://docs.github.com/en/rest/repos/lfs) | PUT /repos/{owner}/{repo}/lfs (202); DELETE same path (204) | Repo-scoped on/off desired state, but there is NO GET endpoint to read the current state back, so check mode cannot detect drift; a section could only re-assert the declared state on apply. Document that limit in the section notes before building it. |
| [Secret scanning custom patterns](https://docs.github.com/en/rest/secret-scanning/custom-patterns) (repository-level) | GET/POST /repos/{owner}/{repo}/secret-scanning/custom-patterns (POST and DELETE are bulk, ids in the body); PATCH .../custom-patterns/{pattern_id} | Pure declarative config readable back via GET (name, pattern, delimiters, must_match/must_not_match, state, push_protection_enabled), so check-mode diffing works. Upsert by pattern name; updates go through PATCH with the pattern's version. |
| [Actions artifact and log retention](https://docs.github.com/en/rest/actions/permissions) | GET/PUT /repos/{owner}/{repo}/actions/permissions/artifact-and-log-retention (body: {days}) | Pure repo-scoped config, readable back. It is also a live instance of the actions section's routing risk: a user declaring a retention key today gets it sent to the base permissions PUT (with the unrecognized-key warning note), where GitHub ignores it. Needs a routing entry like access_level got. |
| [Fork pull request workflow policies](https://docs.github.com/en/rest/actions/permissions) | GET/PUT /repos/{owner}/{repo}/actions/permissions/fork-pr-contributor-approval (approval_policy); GET/PUT .../fork-pr-workflows-private-repos (run_workflows_from_fork_pull_requests + token/secrets/approval sub-toggles) | Two security-relevant, repo-scoped, readable-back policies. Same routing-risk situation as artifact-and-log-retention: declared today, they reach the base PUT and are ignored (loudly noted, still not applied). |
| [Actions cache limits](https://docs.github.com/en/rest/actions/cache) | GET/PUT /repos/{owner}/{repo}/actions/cache/retention-limit (max_cache_retention_days); GET/PUT .../cache/storage-limit (max_cache_size_gb) | Repo-scoped, declarative, trivially diffable. The imperative cache PURGE endpoints stay out of scope; these two limits are settings. |
| [Environment custom deployment protection rules](https://docs.github.com/en/rest/deployments/protection-rules) (GitHub App gates) | GET/POST /repos/{owner}/{repo}/environments/{name}/deployment_protection_rules (POST body: {integration_id}); GET .../deployment_protection_rules/apps; GET/DELETE .../deployment_protection_rules/{rule_id} | The set of protection-rule Apps enabled per environment is pure desired state, fully readable back; completes the environments section alongside the branch-policy patterns gap. |
| [Required commit signatures](https://docs.github.com/en/rest/branches/branch-protection) (classic branch protection) | GET/POST/DELETE /repos/{owner}/{repo}/branches/{branch}/protection/required_signatures | The one classic-protection toggle the protection PUT does NOT accept (required_signatures appears only in GET responses), so the branches section's passthrough cannot set it today; declaring it does nothing. Needs a dedicated sub-endpoint call inside the branches section, keyed off a required_signatures boolean. |
| [Actions secrets](https://docs.github.com/en/rest/actions/secrets) | GET /repos/{owner}/{repo}/actions/secrets; PUT /repos/{owner}/{repo}/actions/secrets/{name} (libsodium-sealed with GET .../secrets/public-key); DELETE .../secrets/{name} | Repo-scoped, but values are write-only material that cannot live in settings.yml and cannot be read back, so a section can only do existence reconciliation (declare names, delete undeclared, flag missing) with values injected from workflow secrets at apply time. Useful but semantically weaker than pure-config sections; design carefully before promising drift detection. |
| [Environment secrets](https://docs.github.com/en/rest/actions/secrets) | GET/PUT/DELETE /repos/{owner}/{repo}/environments/{name}/secrets/{secret_name} (+ .../secrets/public-key) | Same write-only-material profile as Actions secrets, scoped per environment; existence-only reconciliation. Would ship together with an Actions-secrets design. |
| [Custom property values](https://docs.github.com/en/rest/repos/custom-properties) | GET /repos/{owner}/{repo}/properties/values; PATCH same path (org-defined properties, values set per repo) | Repo-scoped pure config with a PATCH-upsert shape that fits declared-keys-only semantics perfectly. Limited to org-owned repos (property DEFINITIONS are org-scoped and out of scope), which narrows the audience for a personal-account-first action. |
| [Dependabot secrets](https://docs.github.com/en/rest/dependabot/secrets) | GET /repos/{owner}/{repo}/dependabot/secrets; PUT/DELETE .../dependabot/secrets/{name} (+ public-key) | Identical write-only-material constraints as Actions secrets but a much smaller audience (private-registry credentials for Dependabot). Existence-only reconciliation; low demand. |
| [Codespaces repository secrets](https://docs.github.com/en/rest/codespaces/repository-secrets) | GET /repos/{owner}/{repo}/codespaces/secrets; PUT/DELETE .../codespaces/secrets/{name} (+ public-key) | The only repo-scoped Codespaces configuration surface (machine policies and user/org secrets are account-scoped). Write-only material, niche feature. |
| [Interaction limits](https://docs.github.com/en/rest/interactions/repos) | GET/PUT/DELETE /repos/{owner}/{repo}/interaction-limits (limit + expiry) | Repo-scoped and REST-configurable, but limits self-expire (expiry is mandatory), so a stateless declarative model re-arms them on every run and check mode drifts by design once they lapse. Awkward fit; document rather than rush. |
| [Pending invitation reconciliation](https://docs.github.com/en/rest/collaborators/invitations) | GET /repos/{owner}/{repo}/invitations; PATCH/DELETE /repos/{owner}/{repo}/invitations/{invitation_id} | The collaborators section sends invitations but never lists pending ones, so an outstanding invite with a stale permission (or to an undeclared user) is invisible to check mode and never corrected/cancelled. Completeness fix for an existing section. |

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
- The social preview image (Open Graph image). No PATCH /repos field and
  no standalone endpoint; GraphQL's openGraphImageUrl is read-only.
  Upload is UI-only under Settings.
- The wiki "Restrict editing to collaborators only" checkbox. The only
  wiki field anywhere is the has_wiki on/off toggle (supported via the
  repository PATCH passthrough); no REST or GraphQL surface controls who
  may edit.
- The Copilot Autofix repository checkbox for code scanning. The
  code-scanning REST surface only exposes imperative autofix operations
  on individual alerts; no endpoint reads or writes the repo toggle.
- Dependabot auto-triage rules (custom alert-handling rules). UI-only;
  the Dependabot REST category has alerts, dismissal requests, and
  secrets, but no rules endpoints.
- Automatic dependency submission (the Settings dropdown that makes
  Actions submit build-time dependencies). No repo REST endpoint reads
  or writes it; org-side enablement goes through org-scoped code
  security configurations.
- GitHub Pages site visibility on Enterprise Cloud (public vs
  repo-members-only). The GET response reports it as `public`, but the
  Pages PUT accepts no field to change it.
- Codespaces prebuild configurations. A real per-repo settings surface
  (branch, devcontainer path, triggers, regions) with no REST or GraphQL
  management endpoints; the builds themselves run as Actions workflows.

## Out of scope (user or org account surface)

- User account surface (profile, emails, notification settings, SSH/GPG/signing keys, blocking, starring/watching, user migrations): User-scoped, not repository configuration, exactly what the tenet's second half excludes. Watching/subscription state on a repo is likewise per-user, not a property of the repo.
- Organization settings (membership, org-level Actions policies, runner groups, org webhooks, org rulesets, org secrets/variables and their repo-selection lists, custom property DEFINITIONS, custom repository roles, code security configurations): Org-account-scoped (/orgs/* endpoints); they influence repos from above but are not settings OF a repository. Their repo-visible effects (org rulesets, applied security configs) surface read-only and are already filtered out (e.g. rulesets skips source_type != Repository).
- GitHub Packages: Package namespaces and their settings belong to the user or org account even when a package is linked to a repo; explicitly user/account territory under the tenet.
- Legacy tag protection API: Deprecated and removed by GitHub (sunset August 2024); no endpoints remain. Its function is fully covered by tag-target rulesets, which are supported.
- Projects: Classic repo projects are sunset; Projects v2 are user/org-owned GraphQL objects merely linked to repos. The repo-level has_projects flag rides the repository PATCH passthrough.
- Releases: Releases are content/artifacts, not configuration. The one release-policy setting with a REST surface, immutable releases, is listed in the gaps table above; anything else GitHub ships as a field on PATCH /repos gets picked up by the repository passthrough automatically.
- Repo-content-borne configuration (CODEOWNERS, dependabot.yml, workflow files, issue/PR templates, FUNDING.yml, .gitattributes): These are versioned files in the repository tree, managed by commits/PRs (e.g. by the copier template layer), not by the settings REST API. Writing repo content is a different tool's job.
- Self-hosted runners (repo-level registration, labels): Operational infrastructure lifecycle: registration requires short-lived tokens and a live agent process; there is no meaningful declarative desired-state to reconcile from a YAML file.
- Imperative repository operations (transfer, archive-via-migration, fork creation, branch create/rename, workflow/repository dispatch, cache purges, alert triage for code scanning / secret scanning / Dependabot alerts, issues and PRs): One-shot actions or work items, not settings; running them repeatedly from declarative state is meaningless or destructive. (The archived boolean itself IS supported via repository PATCH.)
- Codespaces user/org configuration (user secrets, machine-type policies, org access controls): User- and org-scoped; the only repo-scoped Codespaces surface is repository Codespaces secrets, which is tracked as a gap.
- Read-only repository surfaces (traffic, statistics, languages, SBOM/dependency graph exports, attestations, community profile): Nothing to configure; GET-only endpoints with no desired state to apply.
