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
  (node24); regenerate with `bun run build` after any `src/` change. CI's
  bundle-check job fails when it drifts. It is exempt from the typography
  check (third-party unicode) and excluded from [biome](https://biomejs.dev).
- The apply/check engine lives in `src/`; one handler per settings section
  in `src/sections/`. All GitHub API list calls must go through
  `listAll()` (bare-array endpoints) or `listAllEnveloped()` (endpoints
  that wrap the list in a `{total_count, <key>: []}` envelope); errors
  through `call()`/`throwFor()` so the permission policy
  (`on-missing-permission`, `required-sections`) works.
