# Contributing

## Toolchain

`src/` is TypeScript built with [bun](https://bun.com); `lib/` holds the two
committed generated artifacts: `index.js`, the bundle the action executes,
and `settings.schema.json`, the published settings.yml schema. `bun run
build` regenerates both; CI fails on drift.

Runtime dependencies (@octokit/rest with the retry and throttling plugins,
@actions/core, zod, yaml) are compiled into that single bundle.

Run `bun run check` for lint + typecheck + tests + generated-artifact
freshness.

[COVERAGE.md](COVERAGE.md) is the honest inventory of the supported API
surface: what works today, the repo-scoped gaps, and what is out of scope
by design. A change that adds or extends a section should keep it in step.

## End-to-end tests

The end-to-end tests run the committed bundle as a real subprocess against a
mock GitHub API, so they exercise the same `lib/index.js` a user ships, not the
TypeScript source. `bun run test:e2e` runs the curated scenario corpus, and
`bun run fuzz` runs seeded property fuzzing: it generates random scenarios and
checks each run's outcome against an oracle that predicts the outcome class from
the token mask, policy, and mode.

The fuzzer is deterministic. It prints a master seed and a per-iteration seed
for each run; a whole run reproduces with `FUZZ_SEED=<masterSeed> bun run
fuzz`, and a single failing iteration replays with `bun test/e2e/fuzz.ts --seed
<iterationSeed> --iterations 1`.

The mock serves the section endpoints plus the handful of core routes the
action calls (the repo fetch, the settings-file contents read, and
`repos: "*"` discovery), so a request that matches no registered section or
core route fails loudly rather than returning a made-up response.

PR CI runs a diff-aware subset, scoped to the sections a pull request
changed, and a nightly workflow runs the full fuzz and files an issue labeled
`e2e-fuzz` on a scenario or fuzz failure with a replay command.

## Pull requests

PR titles must be [Conventional Commits](https://www.conventionalcommits.org)
(`feat:`, `fix:`, `feat!:`, `chore:`, ...). PRs are squash-merged, so the PR
title becomes the commit subject and drives release versioning; CI validates
it. The single required check is `all-green`, which gates on every other job.
