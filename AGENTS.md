# AGENTS.md

This file provides guidance to AI coding agents working in this repository.
`CLAUDE.md`, `.github/copilot-instructions.md`, and `.github/agents.md` are
symlinks to this file, so edit only here.

## Project

Settings as Code: GitHub Action applying declarative repository settings: rulesets, labels, branch protection, and more - a loud, stateless Probot Settings replacement

## Toolchain

- Runtime and package manager: bun (`bun install`, `bun test`, `bun run <script>`)
- See `package.json` scripts for the available commands.

## Conventions

- PR titles and commit subjects must be Conventional Commits (`feat:`, `fix:`,
  `feat!:`, `chore:`, ...). PRs are squash-merged, so the PR title becomes the
  commit subject and drives release-please versioning. CI validates both
  (pr-title workflow + validate-commit-names).
- CI gates on a single required check named `all-green`, which `needs:` every
  other job in `.github/workflows/ci.yml`. When adding a CI job, add it to
  all-green's `needs` list.
- No typographic look-alike characters (curly quotes, em-dashes, invisible
  unicode). CI enforces this with the check-typography action; use plain ASCII
  punctuation.
- Files marked "managed by Vivswan/repo-platform" are updated by
  template sync PRs. Put repository-specific content in `.gitignore`'s marked
  LOCAL section or below this line in this file.

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
