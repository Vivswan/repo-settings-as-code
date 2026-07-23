# Changelog

## [1.1.0](https://github.com/Vivswan/repo-settings-as-code/compare/v1.0.1...v1.1.0) (2026-07-23)


### Features

* move repo-owned CI and release logic to template extension points ([#12](https://github.com/Vivswan/repo-settings-as-code/issues/12)) ([f9320b7](https://github.com/Vivswan/repo-settings-as-code/commit/f9320b781e4fc2b7cd144fb26d6f0590c6774dad))

## [1.0.1](https://github.com/Vivswan/repo-settings-as-code/compare/v1.0.0...v1.0.1) (2026-07-23)


### Bug Fixes

* **ci:** adopt the top-level modules format in .repo-platform.yml ([0d33581](https://github.com/Vivswan/repo-settings-as-code/commit/0d33581fd15099b01692a1dadd91b4200322a173))
* **ci:** exclude the generated bundle from CodeQL and inline the suppression ([a5e286c](https://github.com/Vivswan/repo-settings-as-code/commit/a5e286cfb79dcdd297263a8869e42d385b1562ba))
* **ci:** grant contents read so auto-assign can resolve CODEOWNERS ([494f2bd](https://github.com/Vivswan/repo-settings-as-code/commit/494f2bdd57b66cba8c3243f81c5644ea73d824a8))
* **discovery:** redact private repositories from logs, summaries, and outputs ([fd8d105](https://github.com/Vivswan/repo-settings-as-code/commit/fd8d105b6446d16a839937fa03007a853011366f))
* **engine:** move multi-repo label prefixing into the Io sink ([eec6ecb](https://github.com/Vivswan/repo-settings-as-code/commit/eec6ecbae71a3512d5fd72e2fd20d0c78e619a5b))
* **quality:** flatten nested branches into guard clauses across the codebase ([1c0a3ce](https://github.com/Vivswan/repo-settings-as-code/commit/1c0a3ce2ba3fce462918ccf0c4e6ff16f1ca9491))
* **report:** add the encrypted artifact report channel ([770dbb0](https://github.com/Vivswan/repo-settings-as-code/commit/770dbb0434d2329b3e248abdf0042e34f43589f3))
* **report:** deliver full private-target reports via repo issues ([4465282](https://github.com/Vivswan/repo-settings-as-code/commit/446528244592b16d4671d10738935d8e3bdcffa3))
* **report:** escape backslashes and bare CR in markdown table cells ([571166f](https://github.com/Vivswan/repo-settings-as-code/commit/571166f6daeeff9c1cf62da7c540ba4c0ef7f066))
* **test:** add token-leak and self-consistency fuzz invariants ([089fe60](https://github.com/Vivswan/repo-settings-as-code/commit/089fe600d6192cfd392153560ff2434d6979b62d))
* **test:** assert apply-convergence and state stability under fuzz ([193c6f2](https://github.com/Vivswan/repo-settings-as-code/commit/193c6f28a1780725c8adf44f1ca33598cf4b4eeb))
* **test:** broaden input-mode validator fuzzing across the settings surface ([8c55504](https://github.com/Vivswan/repo-settings-as-code/commit/8c555041bd001c7f8311cc537c42833a3012d835))
* **test:** close fuzz vacuity with a discovery guard and a live CI seed ([7c023fc](https://github.com/Vivswan/repo-settings-as-code/commit/7c023fc1c7e63502d45ee8b17c6bf0db14faf0e8))
* **test:** extend the e2e harness with core-route faults, idempotence checks, and raw settings ([aa3cdbc](https://github.com/Vivswan/repo-settings-as-code/commit/aa3cdbc35b0eb764c729bc944877b10d8ba0c752))
* **test:** fuzz live state so drift detection is actually tested ([9599759](https://github.com/Vivswan/repo-settings-as-code/commit/9599759926164969019be4edf10358b4a6f42e8d))
* **test:** fuzz the dead corners of the input space ([7de5404](https://github.com/Vivswan/repo-settings-as-code/commit/7de5404180041a15ba5eb2a45a335026a96d5e84))
* **test:** randomize fault targets and model 5xx and core-path faults ([4a80ac6](https://github.com/Vivswan/repo-settings-as-code/commit/4a80ac65aa21fe327cfed028a8667fc67ab58e61))

## 1.0.0 (2026-07-22)


### Features

* actionable errors, per-call debug tracing, and coverage docs ([fe9c9c5](https://github.com/Vivswan/repo-settings-as-code/commit/fe9c9c51b565f740a76324533e0eb3c34bd57a9f))
* add discovery filters for multi-repo "*" mode ([1d6531f](https://github.com/Vivswan/repo-settings-as-code/commit/1d6531f22b8d46a088b4e0f017eb1e67d080a1a2))
* adopt octokit, actions/core, and zod for transport, IO, and validation ([ff89bb6](https://github.com/Vivswan/repo-settings-as-code/commit/ff89bb6d3500b6917c3adc0a4a6f4118d397ab39))
* api-version input, self-updating pre-commit, bundle-freshness test ([a836718](https://github.com/Vivswan/repo-settings-as-code/commit/a83671815b3bce667f0784ff5befe950fd0c552d))
* apply own settings with the action at HEAD ([4dac8fc](https://github.com/Vivswan/repo-settings-as-code/commit/4dac8fc756ec7bffb439896a92febbf6028a263a))
* declarative section permissions and endpoint dictionaries ([de24164](https://github.com/Vivswan/repo-settings-as-code/commit/de2416411d32eda6f38c145890a8d8091ea3a5a2))
* five new settings surfaces, audit fixes, and structural refactors ([30e2dd2](https://github.com/Vivswan/repo-settings-as-code/commit/30e2dd2e932776302d563536282a5e7f969aa62b))
* forward-compatible key routing in the actions section ([1818569](https://github.com/Vivswan/repo-settings-as-code/commit/1818569cad66a37d174090dada741e058ee13307))
* full passthrough in every section plus coverage inventory ([34f108a](https://github.com/Vivswan/repo-settings-as-code/commit/34f108a30e5f925e783e17279be8abeadbb42c4d))
* initial settings-as-code action ([6e4857f](https://github.com/Vivswan/repo-settings-as-code/commit/6e4857f78bf37304a3e115b42f6c4b99a2018cf7))
* multi-repo mode with central files, remote settings, and a defaults layer ([04b379e](https://github.com/Vivswan/repo-settings-as-code/commit/04b379e10e236e753eed740d27c3f809b526d2ed))
* node24 runtime and husky pre-commit hook ([ba04830](https://github.com/Vivswan/repo-settings-as-code/commit/ba04830806226425d9e8b3375ff2651a26d78e73))
* preflight barrier makes strict applies all-or-nothing ([a92173f](https://github.com/Vivswan/repo-settings-as-code/commit/a92173fe5ada43a5bbc3602ae332a9d30b1a4e6e))
* publish generated settings.yml JSON Schema ([b706fa9](https://github.com/Vivswan/repo-settings-as-code/commit/b706fa9287569b0d9c7be7e4a073e28d4e0e3419))


### Bug Fixes

* enforce read-only preflight probes and guard check-mode purity ([009def9](https://github.com/Vivswan/repo-settings-as-code/commit/009def97ad53a5ab84416cc4416a930a21c67ba9))
* environments PUT status and write-throttle scaling, found by the new e2e fuzz harness ([b032024](https://github.com/Vivswan/repo-settings-as-code/commit/b03202487bb0e0149b34304464cfe2ca08ea615a))
* escape backslashes before pipes in the summary table ([6684569](https://github.com/Vivswan/repo-settings-as-code/commit/668456951edcad3701955467d082a56f7f7928e0))
* format the e2e mock files that landed mid-refinement ([8911068](https://github.com/Vivswan/repo-settings-as-code/commit/89110689a6b2476c663fb3f0ea8a9a292139fe0f))
* make the unrecognized actions-key note mode-aware and name the enabled value ([1d3bc0a](https://github.com/Vivswan/repo-settings-as-code/commit/1d3bc0a4c78dd76854e7eb119438dd6a86e7c2c0))
* pin bun via .bun-version so CI rebuilds the bundle byte-identically ([4e7f2bc](https://github.com/Vivswan/repo-settings-as-code/commit/4e7f2bcf59d5d477e1bb6727ba5c3bf33dcadbdf))
* print the final result on stdout ([76b258d](https://github.com/Vivswan/repo-settings-as-code/commit/76b258d05785ea3d5fbed0ca62329811ae4a5557))
* rate-limit discovery advice, shared constants, docs pinned to code ([cf8f291](https://github.com/Vivswan/repo-settings-as-code/commit/cf8f291ca25222b28c8d6db1e28b14e387153714))
* reject duplicate ruleset and branch declarations before any API call ([441ed49](https://github.com/Vivswan/repo-settings-as-code/commit/441ed4956f95272517bdf058286c78e5a2acdb50))
* shape-check the fields section handlers dereference ([c9a8585](https://github.com/Vivswan/repo-settings-as-code/commit/c9a8585d16d8a18b790e71bef1704067d25fb991))
* teams org grading, nightly issue auto-assignment, and fuzz artifact hygiene ([f0378f0](https://github.com/Vivswan/repo-settings-as-code/commit/f0378f0c0e641978bf387c60bedf6471f4af652b))
* unique marketplace name and shorter description ([9508134](https://github.com/Vivswan/repo-settings-as-code/commit/9508134821b3197a81476bc4033ebebd413bc239))
