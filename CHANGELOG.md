# Changelog

## [2.0.1](https://github.com/Vivswan/github-settings-as-code/compare/v2.0.0...v2.0.1) (2026-09-06)


### Features

* add the plan-returning section contract and migrate the workflows section ([8a65765](https://github.com/Vivswan/github-settings-as-code/commit/8a65765e276540e75aae83992b3383ea8e4002ef))
* **contract:** extend the plan contract for every migrating section ([9ae375c](https://github.com/Vivswan/github-settings-as-code/commit/9ae375cc6027d9d7eac970eb808d14a588bac80f))
* derive list sections from a declarative factory, piloted on labels ([71859b5](https://github.com/Vivswan/github-settings-as-code/commit/71859b571bc4c334d4e6796b5424b27f361fb8df))
* generate action.yml, the inputs table, and the policy and permissions references from declarations ([d062cf1](https://github.com/Vivswan/github-settings-as-code/commit/d062cf1b6bd4f2767986477c383f2bed1a201341))
* generate COVERAGE.md from section declarations ([51068cd](https://github.com/Vivswan/github-settings-as-code/commit/51068cdd765667b1190cb99625cd7ab6f656df7f))
* generate the README sections table, outputs, and PAT form from section declarations ([83f3c84](https://github.com/Vivswan/github-settings-as-code/commit/83f3c84ede257c66e2d5ca0cb46f9b3ebfee20e3))


### Bug Fixes

* adopt zod 4.5's native root $ref emission and own-__proto__ rejection ([#67](https://github.com/Vivswan/github-settings-as-code/issues/67)) ([44dab3b](https://github.com/Vivswan/github-settings-as-code/commit/44dab3bccf1e5fca5546d48dda45756c1d7ae084))
* apply review fixes to the docs and tooling sweep ([73b6b4a](https://github.com/Vivswan/github-settings-as-code/commit/73b6b4a4f2cbc2f0f3263fee3478ea0eb2b6eab8))
* apply review fixes to the harness audit batch ([ceb9f46](https://github.com/Vivswan/github-settings-as-code/commit/ceb9f463d7e7bd24acf4bcb770eb6bee63a9219a))
* apply review fixes to the src-side audit batch ([b9de617](https://github.com/Vivswan/github-settings-as-code/commit/b9de617bdd0e9cb2444f2b544f8c5c3ae8c754bb))
* attest build provenance and attach the sigstore bundle to releases ([b5db672](https://github.com/Vivswan/github-settings-as-code/commit/b5db67242eabf3b2c380ba672bcd022c476ddfdf))
* **branches:** seal GraphQL node-id lookups at execution so check mode never issues them ([#75](https://github.com/Vivswan/github-settings-as-code/issues/75)) ([feaf279](https://github.com/Vivswan/github-settings-as-code/commit/feaf279a69df4c125f33827ed5b300c18b657a4e)), closes [#73](https://github.com/Vivswan/github-settings-as-code/issues/73)
* centralize the token-leak sweep in the runner ([7dcc225](https://github.com/Vivswan/github-settings-as-code/commit/7dcc2256e80f56248284b77b7ef1c17decd3c5c2))
* classify rate limits structurally on every path ([65f97a2](https://github.com/Vivswan/github-settings-as-code/commit/65f97a2a86e85d60492889a85f28273996d48fd7))
* correct mock identity minting and the pages resurrect bug ([9152a91](https://github.com/Vivswan/github-settings-as-code/commit/9152a91b6f1ef2dd8b5ef94223abb9d5dc72a663))
* cover every faultable section in the fuzz fault battery ([e41aa99](https://github.com/Vivswan/github-settings-as-code/commit/e41aa9916c9673941b40365347c77692352a16e1))
* derive owner-kind sensitivity from the section declaration ([0181f01](https://github.com/Vivswan/github-settings-as-code/commit/0181f01a752eb9675f48663d21e9ce70ef497b31))
* discover schema-corpus scenarios across all scenario roots ([d34d031](https://github.com/Vivswan/github-settings-as-code/commit/d34d0316af107fccf5c910352eae608dff39e91c))
* hand sections the parsed settings document instead of the raw one ([1ddc2f3](https://github.com/Vivswan/github-settings-as-code/commit/1ddc2f3ed9cf567e5bd5bb67d658d6ae28f3902a))
* harden release boundary checks and decouple the schema id from the release manifest ([f5c4c59](https://github.com/Vivswan/github-settings-as-code/commit/f5c4c59896053ed9ef5eecd44e550887dfe33959))
* harden the CI tooling ([6fb2603](https://github.com/Vivswan/github-settings-as-code/commit/6fb2603a57cfa6ed2d6fc98041fbb60dd2d18f7a))
* keep spec-pinned gaps out of automatic graduation ([ae278c9](https://github.com/Vivswan/github-settings-as-code/commit/ae278c9f3770a8580727db917124a0cea32e164b))
* parse live bodies through parseLive in the seven asserting sections ([56ca3e4](https://github.com/Vivswan/github-settings-as-code/commit/56ca3e41dc90981580c4d45057594ad8f4b74369))
* pass zod's schema layout through instead of guarding it ([#68](https://github.com/Vivswan/github-settings-as-code/issues/68)) ([64aad27](https://github.com/Vivswan/github-settings-as-code/commit/64aad276b2182d4a39175d15fe5e4e7b530345d0))
* reject required-sections entries excluded by the sections allowlist ([c1fc169](https://github.com/Vivswan/github-settings-as-code/commit/c1fc1699adc8027919464bea8eceb65b53fc81f2))
* **release:** follow the attestation bundle rename in the repo-owned asset check and SECURITY.md ([#76](https://github.com/Vivswan/github-settings-as-code/issues/76)) ([3704176](https://github.com/Vivswan/github-settings-as-code/commit/3704176cc0709d1c19a70765c925f033f4266ccd))
* single-tag releases - version tags live only on packaged commits ([08d5585](https://github.com/Vivswan/github-settings-as-code/commit/08d5585b974e529898cf2121bfea220317c914c8))
* size the harness kill cap for the directed fuzz battery ([8543af8](https://github.com/Vivswan/github-settings-as-code/commit/8543af85d8178f736598e6565839df1c57b8334c))
* strengthen the remaining per-section representations ([3fc0f85](https://github.com/Vivswan/github-settings-as-code/commit/3fc0f853f914d032e0bf5f746aee48357d062a03))


### Miscellaneous Chores

* drop the release-as pin and the machinery that retired it ([a2cc999](https://github.com/Vivswan/github-settings-as-code/commit/a2cc999d1936b9e72e7762778f3ac2ba58091ecc))

## [2.0.0](https://github.com/Vivswan/github-settings-as-code/compare/v1.0.1...v2.0.0) (2026-08-11)


### ⚠ BREAKING CHANGES

* the action moved to Vivswan/github-settings-as-code; uses: references to Vivswan/repo-settings-as-code fail with "repository not found" and must be updated.
* branches[].protection.required_signatures now acts. Previously the key rode the protection PUT, where GitHub dropped it (check mode showed permanent drift). A settings file already carrying it will start toggling the signed-commit requirement on the first apply after upgrading - a stale required_signatures: false would REMOVE a hand-enabled requirement. Audit existing declarations for intent before moving to v2. The v1 line keeps the old inert behavior.
* actions.fork_pr_contributor_approval and actions.fork_pr_workflows_private_repos now act. Previously both keys fell through to the base permissions PUT, where GitHub ignored them and a notice said so. A settings file already carrying either key will start applying these policies on the first apply after upgrading; audit existing declarations for intent before moving to v2. The v1 line keeps the old inert behavior.
* actions.oidc_customization_sub now acts. Previously the key fell through to the base permissions PUT, where GitHub ignored it and a notice said so. A settings file already carrying the key will start customizing the OIDC subject claim template on the first apply after upgrading; audit existing declarations for intent before moving to v2. The v1 line keeps the old inert behavior.

### Features

* add issue-on-failure private-report channel (quiet on healthy runs) ([934a321](https://github.com/Vivswan/github-settings-as-code/commit/934a321d64d49470ced76b484f6f714fc2a2bbe4))
* enrich API rejection errors and reject unknown keys in closed sections ([7a44e90](https://github.com/Vivswan/github-settings-as-code/commit/7a44e90bc15016d7926b812000f22043d1f3058f))
* first-class GraphQL operation layer ([7d5279f](https://github.com/Vivswan/github-settings-as-code/commit/7d5279fcdae87c0985c9a6ecb637c89dcd38e2f7))
* let settings.yml choose the undeclared-resource policy per section ([372b884](https://github.com/Vivswan/github-settings-as-code/commit/372b8844f1274cdfac71d04b5c526d6d6714da8f))
* manage Actions artifact/log retention and cache limits ([8014910](https://github.com/Vivswan/github-settings-as-code/commit/8014910b884aece9cc71f974cef26db4656da74f))
* manage code quality setup and check suite preferences ([adab49e](https://github.com/Vivswan/github-settings-as-code/commit/adab49e76316dfab7122b30c114d7bde1f69b1ba))
* manage Copilot agents secrets and variables ([1d839e1](https://github.com/Vivswan/github-settings-as-code/commit/1d839e1797f622da2cb01331a8ec395cd56dcf0b))
* manage deploy keys ([a6f7ae1](https://github.com/Vivswan/github-settings-as-code/commit/a6f7ae1251177cd07c1ce6d0acc3176e3986f9b0))
* manage environment custom deployment protection rules ([f752ce8](https://github.com/Vivswan/github-settings-as-code/commit/f752ce8626e98689902e4f83463816fe25636139))
* manage environment deployment branch-policy patterns ([34eafe4](https://github.com/Vivswan/github-settings-as-code/commit/34eafe4e46dd12f6b17dfdf4987b7898270d1718))
* manage environment variables in the environments section ([1d272c3](https://github.com/Vivswan/github-settings-as-code/commit/1d272c355ed1b933080d1234b3925625ec1e1edb))
* manage environment, Dependabot, and Codespaces secrets ([c8bbe75](https://github.com/Vivswan/github-settings-as-code/commit/c8bbe75a91fadbfe241e152ab3fdcf3d52120309))
* manage fork pull request workflow policies from the actions section ([cd2bfcf](https://github.com/Vivswan/github-settings-as-code/commit/cd2bfcfb332cd789cb4d8d55a7ca40daefcdfec8))
* manage Git LFS enablement from the repository section ([a0195fa](https://github.com/Vivswan/github-settings-as-code/commit/a0195faf6bc2a8df6e68437a38c35c6d419020bc))
* manage immutable releases from the repository section ([f2582f7](https://github.com/Vivswan/github-settings-as-code/commit/f2582f7b8d66d5d7db79fad6b2b0f70788baa590))
* manage pinned environments ([c368c98](https://github.com/Vivswan/github-settings-as-code/commit/c368c98a52ee5d0a35028e2501423316b5c65023))
* manage repository Actions secrets ([0f8ea4e](https://github.com/Vivswan/github-settings-as-code/commit/0f8ea4e0ba0ffc23802bfd608fc979b40045eaf2))
* manage repository Actions variables ([780abf0](https://github.com/Vivswan/github-settings-as-code/commit/780abf0ec19c50279cc2454606492101bfbdebf7))
* manage repository custom property values ([b5bf3ac](https://github.com/Vivswan/github-settings-as-code/commit/b5bf3ac547b0ad84ae19427cf2da06b35b3911fb))
* manage repository interaction limits ([c8dd58d](https://github.com/Vivswan/github-settings-as-code/commit/c8dd58d04de93da9f76168f985654e5d54646065))
* manage repository secret scanning custom patterns ([05f614c](https://github.com/Vivswan/github-settings-as-code/commit/05f614c0a894e2a9599e81f03c7de593164ad9eb))
* manage repository webhooks ([85013d3](https://github.com/Vivswan/github-settings-as-code/commit/85013d3d6437bd78357dd37547c1426c80fb449b))
* manage required commit signatures in the branches section ([16bec9a](https://github.com/Vivswan/github-settings-as-code/commit/16bec9a328879af3a522e67fb80c86e50c4e6460))
* manage the Actions OIDC subject claim from the actions section ([c4e712f](https://github.com/Vivswan/github-settings-as-code/commit/c4e712fd4b929ba6553f2e54c3f1b53b6fd7971b))
* manage the pull request creation cap and bypass list ([e98fb3a](https://github.com/Vivswan/github-settings-as-code/commit/e98fb3ad58b2f8b78d759480cf096a483678a741))
* manage the sponsor button and issue creation policy ([97111fb](https://github.com/Vivswan/github-settings-as-code/commit/97111fb2fa66779f099e6daf3c0ac5c5b44b189f))
* manage wildcard branch protection, force-push bypassers, and required deployments ([085ac52](https://github.com/Vivswan/github-settings-as-code/commit/085ac52683eaacbda1d974cf19f5a6e38f774b71))
* move repo-owned CI and release logic to template extension points ([#12](https://github.com/Vivswan/github-settings-as-code/issues/12)) ([cdde9cc](https://github.com/Vivswan/github-settings-as-code/commit/cdde9ccbf867af6d257ce26f5eac8180930b4ca9))
* reconcile pending collaborator invitations ([cb92188](https://github.com/Vivswan/github-settings-as-code/commit/cb9218874d6a6956cb1a575ce64418ad8614c199))
* rename to github-settings-as-code ([9678cee](https://github.com/Vivswan/github-settings-as-code/commit/9678ceef5375ce7a30f70107ef441a496cf8653b))


### Bug Fixes

* **ci:** cover src/report in the changed-sections selector and openapi cache key ([a1c4302](https://github.com/Vivswan/github-settings-as-code/commit/a1c43023ab54ea3dca16dd61a2034d2b003756fd))
* declare dependabot default labels and realign SECURITY.md ([aa89a23](https://github.com/Vivswan/github-settings-as-code/commit/aa89a230e6dbe0f823dc7998c21edbed0b167972))
* drop connections for real in the e2e mock, on bun 1.3.14 ([791c4bf](https://github.com/Vivswan/github-settings-as-code/commit/791c4bfe668f02b1d72bdb8677f14fd390678ea5))
* **e2e:** keep body-presence checks active for requestOffSpec rejections ([43426a6](https://github.com/Vivswan/github-settings-as-code/commit/43426a6cca49370f6200acef20dbe368af190106))
* mark the secrets-and-vaults action pins for major-tag rewrites ([9d1f616](https://github.com/Vivswan/github-settings-as-code/commit/9d1f616eaf368f959b1761945619ca1926ecc659))
* name every offender in errors and carry engine invariants in types ([49b386a](https://github.com/Vivswan/github-settings-as-code/commit/49b386a1313173fdcf376c7698852f497a355626))
* preserve a rotated deploy key's live read_only flag ([a36da82](https://github.com/Vivswan/github-settings-as-code/commit/a36da82b4c2ca0a91549b40ca8a4a1e522b16bc4))
* re-enable declared protection rules the API reports as disabled ([b469a6f](https://github.com/Vivswan/github-settings-as-code/commit/b469a6fde4c32b20fe4abf4b895a0d4f525d39d6))
* reject invalid actions and repository declarations before any section writes ([85be8ef](https://github.com/Vivswan/github-settings-as-code/commit/85be8efd6355326f3814616580d8ff6586e7cbe7))
* silence and label intentional error noise in green runs ([a786ae6](https://github.com/Vivswan/github-settings-as-code/commit/a786ae682fc791c0be8fc1bc94881265d28c30ed))
* track secret-reference provenance structurally through the merge ([e9c223e](https://github.com/Vivswan/github-settings-as-code/commit/e9c223e2f828aee777270939948093e3467618c9))
* unpad flow-mapping braces in the pins cap scenario ([7b041fd](https://github.com/Vivswan/github-settings-as-code/commit/7b041fd13a4da8466f5b9c622993a04a7fc3ff73))
* write version-less secret scanning patterns the way the API allows ([6fa0cef](https://github.com/Vivswan/github-settings-as-code/commit/6fa0cefed39867bcd44d615da5e5bf0c22b237c1))

## [1.0.1](https://github.com/Vivswan/github-settings-as-code/compare/v1.0.0...v1.0.1) (2026-07-23)


### Bug Fixes

* **ci:** adopt the top-level modules format in .repo-platform.yml ([0d33581](https://github.com/Vivswan/github-settings-as-code/commit/0d33581fd15099b01692a1dadd91b4200322a173))
* **ci:** exclude the generated bundle from CodeQL and inline the suppression ([a5e286c](https://github.com/Vivswan/github-settings-as-code/commit/a5e286cfb79dcdd297263a8869e42d385b1562ba))
* **ci:** grant contents read so auto-assign can resolve CODEOWNERS ([494f2bd](https://github.com/Vivswan/github-settings-as-code/commit/494f2bdd57b66cba8c3243f81c5644ea73d824a8))
* **discovery:** redact private repositories from logs, summaries, and outputs ([fd8d105](https://github.com/Vivswan/github-settings-as-code/commit/fd8d105b6446d16a839937fa03007a853011366f))
* **engine:** move multi-repo label prefixing into the Io sink ([eec6ecb](https://github.com/Vivswan/github-settings-as-code/commit/eec6ecbae71a3512d5fd72e2fd20d0c78e619a5b))
* **quality:** flatten nested branches into guard clauses across the codebase ([1c0a3ce](https://github.com/Vivswan/github-settings-as-code/commit/1c0a3ce2ba3fce462918ccf0c4e6ff16f1ca9491))
* **report:** add the encrypted artifact report channel ([770dbb0](https://github.com/Vivswan/github-settings-as-code/commit/770dbb0434d2329b3e248abdf0042e34f43589f3))
* **report:** deliver full private-target reports via repo issues ([4465282](https://github.com/Vivswan/github-settings-as-code/commit/446528244592b16d4671d10738935d8e3bdcffa3))
* **report:** escape backslashes and bare CR in markdown table cells ([571166f](https://github.com/Vivswan/github-settings-as-code/commit/571166f6daeeff9c1cf62da7c540ba4c0ef7f066))
* **test:** add token-leak and self-consistency fuzz invariants ([089fe60](https://github.com/Vivswan/github-settings-as-code/commit/089fe600d6192cfd392153560ff2434d6979b62d))
* **test:** assert apply-convergence and state stability under fuzz ([193c6f2](https://github.com/Vivswan/github-settings-as-code/commit/193c6f28a1780725c8adf44f1ca33598cf4b4eeb))
* **test:** broaden input-mode validator fuzzing across the settings surface ([8c55504](https://github.com/Vivswan/github-settings-as-code/commit/8c555041bd001c7f8311cc537c42833a3012d835))
* **test:** close fuzz vacuity with a discovery guard and a live CI seed ([7c023fc](https://github.com/Vivswan/github-settings-as-code/commit/7c023fc1c7e63502d45ee8b17c6bf0db14faf0e8))
* **test:** extend the e2e harness with core-route faults, idempotence checks, and raw settings ([aa3cdbc](https://github.com/Vivswan/github-settings-as-code/commit/aa3cdbc35b0eb764c729bc944877b10d8ba0c752))
* **test:** fuzz live state so drift detection is actually tested ([9599759](https://github.com/Vivswan/github-settings-as-code/commit/9599759926164969019be4edf10358b4a6f42e8d))
* **test:** fuzz the dead corners of the input space ([7de5404](https://github.com/Vivswan/github-settings-as-code/commit/7de5404180041a15ba5eb2a45a335026a96d5e84))
* **test:** randomize fault targets and model 5xx and core-path faults ([4a80ac6](https://github.com/Vivswan/github-settings-as-code/commit/4a80ac65aa21fe327cfed028a8667fc67ab58e61))

## 1.0.0 (2026-07-22)


### Features

* actionable errors, per-call debug tracing, and coverage docs ([fe9c9c5](https://github.com/Vivswan/github-settings-as-code/commit/fe9c9c51b565f740a76324533e0eb3c34bd57a9f))
* add discovery filters for multi-repo "*" mode ([1d6531f](https://github.com/Vivswan/github-settings-as-code/commit/1d6531f22b8d46a088b4e0f017eb1e67d080a1a2))
* adopt octokit, actions/core, and zod for transport, IO, and validation ([ff89bb6](https://github.com/Vivswan/github-settings-as-code/commit/ff89bb6d3500b6917c3adc0a4a6f4118d397ab39))
* api-version input, self-updating pre-commit, bundle-freshness test ([a836718](https://github.com/Vivswan/github-settings-as-code/commit/a83671815b3bce667f0784ff5befe950fd0c552d))
* apply own settings with the action at HEAD ([4dac8fc](https://github.com/Vivswan/github-settings-as-code/commit/4dac8fc756ec7bffb439896a92febbf6028a263a))
* declarative section permissions and endpoint dictionaries ([de24164](https://github.com/Vivswan/github-settings-as-code/commit/de2416411d32eda6f38c145890a8d8091ea3a5a2))
* five new settings surfaces, audit fixes, and structural refactors ([30e2dd2](https://github.com/Vivswan/github-settings-as-code/commit/30e2dd2e932776302d563536282a5e7f969aa62b))
* forward-compatible key routing in the actions section ([1818569](https://github.com/Vivswan/github-settings-as-code/commit/1818569cad66a37d174090dada741e058ee13307))
* full passthrough in every section plus coverage inventory ([34f108a](https://github.com/Vivswan/github-settings-as-code/commit/34f108a30e5f925e783e17279be8abeadbb42c4d))
* initial settings-as-code action ([6e4857f](https://github.com/Vivswan/github-settings-as-code/commit/6e4857f78bf37304a3e115b42f6c4b99a2018cf7))
* multi-repo mode with central files, remote settings, and a defaults layer ([04b379e](https://github.com/Vivswan/github-settings-as-code/commit/04b379e10e236e753eed740d27c3f809b526d2ed))
* node24 runtime and husky pre-commit hook ([ba04830](https://github.com/Vivswan/github-settings-as-code/commit/ba04830806226425d9e8b3375ff2651a26d78e73))
* preflight barrier makes strict applies all-or-nothing ([a92173f](https://github.com/Vivswan/github-settings-as-code/commit/a92173fe5ada43a5bbc3602ae332a9d30b1a4e6e))
* publish generated settings.yml JSON Schema ([b706fa9](https://github.com/Vivswan/github-settings-as-code/commit/b706fa9287569b0d9c7be7e4a073e28d4e0e3419))


### Bug Fixes

* enforce read-only preflight probes and guard check-mode purity ([009def9](https://github.com/Vivswan/github-settings-as-code/commit/009def97ad53a5ab84416cc4416a930a21c67ba9))
* environments PUT status and write-throttle scaling, found by the new e2e fuzz harness ([b032024](https://github.com/Vivswan/github-settings-as-code/commit/b03202487bb0e0149b34304464cfe2ca08ea615a))
* escape backslashes before pipes in the summary table ([6684569](https://github.com/Vivswan/github-settings-as-code/commit/668456951edcad3701955467d082a56f7f7928e0))
* format the e2e mock files that landed mid-refinement ([8911068](https://github.com/Vivswan/github-settings-as-code/commit/89110689a6b2476c663fb3f0ea8a9a292139fe0f))
* make the unrecognized actions-key note mode-aware and name the enabled value ([1d3bc0a](https://github.com/Vivswan/github-settings-as-code/commit/1d3bc0a4c78dd76854e7eb119438dd6a86e7c2c0))
* pin bun via .bun-version so CI rebuilds the bundle byte-identically ([4e7f2bc](https://github.com/Vivswan/github-settings-as-code/commit/4e7f2bcf59d5d477e1bb6727ba5c3bf33dcadbdf))
* print the final result on stdout ([76b258d](https://github.com/Vivswan/github-settings-as-code/commit/76b258d05785ea3d5fbed0ca62329811ae4a5557))
* rate-limit discovery advice, shared constants, docs pinned to code ([cf8f291](https://github.com/Vivswan/github-settings-as-code/commit/cf8f291ca25222b28c8d6db1e28b14e387153714))
* reject duplicate ruleset and branch declarations before any API call ([441ed49](https://github.com/Vivswan/github-settings-as-code/commit/441ed4956f95272517bdf058286c78e5a2acdb50))
* shape-check the fields section handlers dereference ([c9a8585](https://github.com/Vivswan/github-settings-as-code/commit/c9a8585d16d8a18b790e71bef1704067d25fb991))
* teams org grading, nightly issue auto-assignment, and fuzz artifact hygiene ([f0378f0](https://github.com/Vivswan/github-settings-as-code/commit/f0378f0c0e641978bf387c60bedf6471f4af652b))
* unique marketplace name and shorter description ([9508134](https://github.com/Vivswan/github-settings-as-code/commit/9508134821b3197a81476bc4033ebebd413bc239))
