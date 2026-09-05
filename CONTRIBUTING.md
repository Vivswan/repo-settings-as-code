<!-- BEGIN REPO-PLATFORM MANAGED -->
# Contributing to github-settings-as-code

Thanks for contributing! This document covers the conventions every change in this repository goes through.

CI, settings, and standards files here (including this document between the BEGIN/END markers) are managed by [Vivswan/repo-platform](https://github.com/vivswan/repo-platform); local edits to managed files are replaced on the next template sync.

## Pull requests

- Changes land through pull requests and are squash-merged; the PR title becomes the commit subject on the default branch.
- The PR title and every pushed commit subject must be a [Conventional Commit](https://www.conventionalcommits.org/en/v1.0.0/), for example `feat: add X` or `fix(parser): handle Y`. Releases are versioned from these subjects.
- By opening a pull request, or offering code in an issue or review for inclusion, you agree to the Contributions section of the [LICENSE.md](LICENSE.md), which licenses that code to the licensor - including for relicensing under any terms - unless you conspicuously say otherwise when you submit it.

## CI

- CI gates on the `all-green` status check - the CI workflow's own `all-green` job, which needs every gating job and fails unless each result is success or skipped, with at least one success (the convention is documented in [repo-platform's all-green guide](https://github.com/vivswan/repo-platform/blob/main/docs/all-green.md)).
- Repository-specific checks live in `.github/workflows/checks.yml`; run the commands it lists locally before pushing.
- A typography gate enforces plain ASCII punctuation: no curly quotes, em-dashes, or invisible unicode.

## Security

Never report vulnerabilities in issues or pull requests - see [SECURITY.md](.github/SECURITY.md) for the private reporting route.

## Code of conduct

Participation in this project is governed by the [code of conduct](.github/CODE_OF_CONDUCT.md).

<!-- Repository-specific contributing documentation (dev setup, build and
     test commands, review expectations) goes outside the BEGIN/END markers - below the END marker, or above BEGIN. It is this repository's own and survives template updates. -->
<!-- END REPO-PLATFORM MANAGED -->

## Toolchain

`src/` is TypeScript built with [bun](https://bun.com); `lib/` holds one committed generated artifact, `settings.schema.json`, the published settings.yml schema. `bun run build:schema` regenerates it; CI's schema-check job fails on drift. The bundle the action executes, `lib/index.js`, is not committed: `bun run build:bundle` builds it where it is needed (the CI workflows that run the action build it first, and a release builds and ships it on a packaged commit that every `vX.Y.Z` tag, and the moving major with them, points at).

Runtime dependencies (such as @octokit/rest with the retry and throttling plugins, @actions/core, zod, and yaml) are compiled into that single bundle.

Run `bun run check` for lint + YAML lint + typecheck + dead-code check (knip) + tests + schema freshness. The pre-commit hook runs lint and typecheck only.

[COVERAGE.md](COVERAGE.md) is the honest inventory of the supported API surface: what works today, the repo-scoped gaps, and what is out of scope by design. A change that adds or extends a section should keep it in step.

## End-to-end tests

The end-to-end tests build the bundle to a temp path and run it as a real subprocess against a mock GitHub API, so they exercise the same single-file bundle a release ships, not the TypeScript source directly. `bun run test:e2e` runs the curated scenario corpus, and `bun run fuzz` runs seeded property fuzzing: it generates random scenarios and checks each run's outcome against an oracle that predicts the outcome class from the token mask, policy, and mode.

The fuzzer is deterministic. It prints a master seed and a per-iteration seed for each run; a whole run reproduces with `FUZZ_SEED=<masterSeed> bun run fuzz`, and a single failing iteration replays with `bun test/e2e/fuzz.ts --seed
<iterationSeed> --iterations 1`.

The mock serves the section endpoints plus the core routes the action calls outside the sections (the repo fetch, the settings-file contents read, `repos: "*"` discovery, and the private-report issue channel), so a request that matches no registered section or core route fails loudly rather than returning a made-up response.

PR CI runs a diff-aware subset, scoped to the sections a pull request changed. Two nightly workflows cover the rest: one runs the curated scenario corpus and files an issue labeled `e2e-fuzz` on failure, the other runs the full fuzz and files under `fuzz-nightly`; both issues carry a replay command.

## Releases

The release job runs downstream of the `all-green` gate, so releases and release-PR refreshes only happen from a green main. release-please does version math, the changelog, the manifest and version pins, and the release PR; merging that PR has it cut the release as a draft with no tag. The repo-owned update-release.yml hook then builds the bundle, commits it as a child of the merge commit, creates the `vX.Y.Z` tag once on that packaged commit, moves the moving major tag to it, and uploads the assets; the managed publish stage attests every asset (on a public repository) and flips the draft live, binding the release to the packaged tag. The tag topology is unit-tested in test/scripts/release-pipeline.test.ts.
