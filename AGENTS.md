# AGENTS.md

This file provides guidance to AI coding agents working in this repository.
`CLAUDE.md`, `.github/copilot-instructions.md`, and `.github/agents.md` are
symlinks to this file, so edit only here.

## Project

Settings as Code: GitHub Action applying declarative repository settings: rulesets, labels, branch protection, and more. A loud, stateless Probot Settings replacement.

## Toolchain

- Runtime and package manager: bun (`bun install`, `bun test`, `bun run <script>`)
- See `package.json` scripts for the available commands.

## Conventions

- PR titles and commit subjects must be Conventional Commits (`feat:`, `fix:`,
  `feat!:`, `chore:`, ...). PRs are squash-merged, so the PR title becomes the
  commit subject and drives release-please versioning. CI validates both
  (the ci.yml pr-title job + validate-commit-names).
- CI gates on a single required check named `all-green` in the managed
  `.github/workflows/ci.yml`. This repository's own test/lint jobs belong in
  `.github/workflows/checks.yml` (repo-owned, called inside the gate); do not
  edit ci.yml, template sync overwrites it. The `release` job runs on top
  of the gate (`needs: all-green`); the release pipeline is repo-owned in
  `.github/workflows/release.yml` (pre/post-release jobs go there, around the
  managed release-please machinery).
- No typographic look-alike characters (curly quotes, em-dashes, invisible
  unicode). CI enforces this with the check-typography action; use plain ASCII
  punctuation.

## Managed by repo-platform

- Files whose header says "managed by Vivswan/repo-platform"
  arrive via sync PRs pushed by that repository. Do not edit them here;
  change them in Vivswan/repo-platform and let the next sync
  PR deliver the update.
- Repository settings (description, topics, labels, rulesets, merge policy)
  are applied from Vivswan/repo-platform: by the
  `settings/repos/` file named after this repository over there when one
  exists, otherwise by this repository's own `.github/settings.yml`. Do not
  change settings by hand in the GitHub UI; edit the settings file.
- Repo-owned escape hatches stay local: `.github/workflows/checks.yml` and
  `.github/workflows/release.yml`, `.gitignore`'s marked LOCAL section,
  `.typography-allow.local` (typography exemptions; the managed
  `.typography-allow` is overwritten by sync), and the repository-specific
  section below.
- Module selection is this repository's own: edit the `modules` list in
  `.repo-platform.yml` and the next sync PR applies the change.

## Repository-specific guidance

<!-- Add project-specific instructions below. This section survives template
     updates via three-way merge. -->

- `lib/index.js` is the COMMITTED bundled entrypoint the action runs
  (node24); `lib/settings.schema.json` is the COMMITTED JSON Schema for
  settings.yml, generated from the `SettingsFile` types (JSDoc comments in
  `src/schema.ts` become the schema descriptions). Regenerate both with
  `bun run build` after any `src/` change. CI's bundle-check job fails
  when either drifts. `lib/` is exempt from the typography check
  (third-party unicode in the bundle; schema JSDoc is checked at source)
  and excluded from [biome](https://biomejs.dev).
- The apply/check engine layout: `src/main.ts` is the thin bundled
  entrypoint; `src/action/` is the GitHub Actions layer (inputs, Io over
  @actions/core, settings reading, step summaries, the single- and
  multi-repo run flows); `src/engine/` is the per-repo pipeline
  (orchestrate, validate, merge, diff); `src/github/` is the REST client,
  pagination, and repo-file fetch; `src/discovery/` resolves multi-repo
  targets; `src/sections/` holds one handler per settings section. Each
  section is a self-contained `SectionModule`
  (key, PAT grant advice, loose zod shape, handler) registered in
  `src/sections/registry.ts`; adding a section means declaring its
  property on `SettingsFile` in `src/schema.ts` (with a JSDoc comment,
  which feeds the published schema), adding the key to `SECTION_KEYS`,
  creating `src/sections/<key>.ts`, and adding one registry line - the
  compiler flags any forgotten step. All GitHub API list calls must go through
  `listAll()` (bare-array endpoints) or `listAllEnveloped()` (endpoints
  that wrap the list in a `{total_count, <key>: []}` envelope), both
  backed by the single page loop in `src/github/paginate.ts`; errors
  through `call()`/`throwFor()` so the permission policy
  (`on-missing-permission`, `required-sections`) works.
- The end-to-end harness lives under `test/e2e/`: `run.ts` runs the curated
  scenarios in `test/e2e/scenarios/`, `fuzz.ts` runs seeded property fuzzing,
  `runner.ts` spawns the committed bundle against the mock, `mock/` is the
  in-process GitHub API (route table in `mock/routes.ts`, state in
  `mock/state.ts`), and `oracle.ts` predicts outcome classes. On-contract mock
  responses are validated against a trimmed OpenAPI spec
  (`openapi/github-openapi.trimmed.json`, a fetched gitignored artifact -
  generate it with `bun .github/scripts/trim-openapi.ts`; CI caches or
  re-fetches it); responses the spec cannot document are skipped, namely raw
  media types, injected transport faults, chaos-corrupted bodies, permission
  denials, and the mock's own contract-violation replies.
- Adding a section endpoint: declare it in the section module's `ENDPOINTS`,
  then add a matching handler under its `section.role` key in
  `test/e2e/mock/routes.ts`. The section route table, permission gate, and
  tolerated statuses derive from `allEndpoints()`, so `assertHandlerCompleteness()`
  fails at construction if a declared endpoint has no handler or a handler names
  no endpoint. Core routes the action calls outside the sections (the repo
  fetch, the settings-file contents read, and `repos: "*"` discovery) are served
  by a separate core-path handler, and a request that matches no registered
  section or core route fails loudly. `USED_PATHS` (in
  `test/e2e/openapi/paths.ts`) picks the new path up automatically, so beyond
  the handler a new endpoint needs a corpus scenario that reaches it (the
  coverage tripwire fails on a cold route) and a regenerated trimmed spec (`bun
  .github/scripts/trim-openapi.ts`, committed).
- Two declarations on each section are single sources the rest of the system
  reads: `permission` (a `SectionPermission`) drives the PAT grant prose
  (`grantFor`), the mock's permission gate, and the fuzz oracle; the `ENDPOINTS`
  dictionary drives the paths, the mock routes, and `USED_PATHS`.
  `deletesUndeclared` pins the README Sections table via the docs contradiction
  test. Change one and its consumers follow.
- Scenarios in `test/e2e/scenarios/` must run green via `bun run test:e2e`
  before they land. When adding a section file under `src/sections/`, its
  selector entry in `.github/scripts/changed-sections.ts` is auto-generated for
  the conventional `<key>.ts` name; only a file whose name differs from its
  section key (or that maps to several sections) needs a hand-written entry in
  `SPECIAL_SECTION_FILES`, and the map's unit test fails if a section key has no
  file mapped to it.
- The `release` job in ci.yml is deliberately NOT in all-green's `needs`:
  it runs downstream of the gate (calling release-please.yml via
  workflow_call), so releases and release-PR refreshes only happen on a
  green main. Do not add it to the needs list.
