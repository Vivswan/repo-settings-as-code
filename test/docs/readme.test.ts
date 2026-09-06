/**
 * README contract tests: pin the schema link, the example settings.yml
 * blocks, the migration paragraph, and the version pins to their single
 * sources, so a prose claim cannot drift from what the code does. The
 * Sections table, the outputs list, and the token-form link are generated
 * (.github/scripts/gen-docs.ts) and pinned by that generator's tests.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { countWord } from "../../.github/scripts/lib/count-word.js";
import {
  DEFAULT_PRIVATE_REPOS,
  PRIVATE_REPORT_CHANNELS,
  REDACTED_DETAIL,
} from "../../src/action/redact.js";
import { REPO_RESULTS } from "../../src/engine/orchestrate.js";
import { ARTIFACT_FILE, ARTIFACT_NAME } from "../../src/report/artifact-report.js";
import { PROBOT_PARITY_KEYS, SECTION_KEYS } from "../../src/schema.js";
import { DOCS } from "../../src/sections/docs-registry.js";
import { SECTIONS } from "../../src/sections/registry.js";
import { defaultClaimProblems, deleteEnumerationProblems } from "./claims.js";
import { fencedBlocks, sectionLines } from "./markdown.js";
import { assertValidSettingsExample } from "./settings-examples.js";
import { stalePins } from "./version-pins.js";

const ROOT = join(import.meta.dir, "..", "..");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");

/**
 * Assert the parenthesized enumeration `leadRe` captures from `text` carries
 * each `expected` value backticked and nothing else backticked - the same pin
 * the action-yml contract test applies to the output description, so a new
 * value cannot skip the prose and a dropped one cannot linger.
 */
function assertBacktickedEnumeration(
  text: string,
  leadRe: RegExp,
  expected: readonly string[],
  label: string,
): void {
  const parenthesized = text.match(leadRe)?.[1];
  expect(parenthesized, label).toBeDefined();
  const listed = [...(parenthesized ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
  expect(listed.sort()).toEqual([...expected].sort());
}

describe("README example settings.yml blocks", () => {
  test("every settings.yml example validates and its repository keys are known", () => {
    // The example block parses to a settings document (other yaml blocks are
    // workflow yaml). Validate any block whose top level is a mapping of known
    // section keys, then confirm repository special-looking keys are real.
    const known = new Set<string>(SECTION_KEYS);
    let validated = 0;
    for (const block of fencedBlocks(readme, "yaml")) {
      let doc: unknown;
      try {
        doc = parseYaml(block);
      } catch {
        continue;
      }
      if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
        continue;
      }
      const keys = Object.keys(doc);
      if (keys.length === 0 || !keys.some((k) => known.has(k))) {
        continue; // not a settings document
      }
      assertValidSettingsExample(doc, "README settings.yml example");
      validated++;
    }
    expect(validated, "no settings.yml example block was found in the README").toBeGreaterThan(0);
  });
});

describe("README version pins", () => {
  test("every uses: pin names the current release's moving major tag", () => {
    // The uses: pins carry the inline x-release-please-major annotation, so
    // every release PR that bumps the major rewrites them together with the
    // manifest; this test is the tripwire for the annotations rotting away.
    const pins = stalePins([{ label: "README.md", text: readme }]);
    if (pins === null) {
      return; // nothing released yet, no pin can be right
    }
    expect(pins.references).toBeGreaterThan(0);
    expect(
      pins.stale.map(
        (pin) => `README pins @${pin.ref}, but the current major tag is ${pins.major}`,
      ),
    ).toEqual([]);
  });

  test("the exact-pin advice names the version tag and the build/ namespace stays retired", () => {
    // Under the single-tag scheme (.github/workflows/release.yml) every
    // vX.Y.Z tag points at a packaged commit carrying the built action, so
    // the exact pin README offers is the version tag itself; the retired
    // build/ namespace must not reappear anywhere in the README.
    expect(
      readme.includes("`@vX.Y.Z`"),
      "README's exact-pin advice must name the `@vX.Y.Z` tag form",
    ).toBe(true);
    expect(
      readme.includes("build/"),
      "README references the retired build/ tag namespace; version tags are the packaged, runnable refs now",
    ).toBe(false);
    // Concrete version pins would rot on every release; the moving major
    // (annotated for release-please) and the @vX.Y.Z placeholder are the
    // only forms the README may offer.
    const versionPins = [...readme.matchAll(/@v\d+\.\d+\.\d+/g)].map((m) => m[0]);
    expect(
      versionPins,
      `README pins concrete version tag(s) ${versionPins.join(", ")}; offer the moving major or the @vX.Y.Z placeholder instead`,
    ).toEqual([]);
  });
});

describe("delete-by-default enumeration", () => {
  // Both prose spots enumerate the sections whose undeclared entries an
  // apply deletes; the set is derived from the registry so a new
  // delete-by-default section fails here until the prose (and the display
  // map in claims.ts) follows. This list drifted once already - the
  // quick-start warning named three of five sections.
  const deleteKeys = SECTIONS.filter((s) => s.undeclaredDefault === "delete").map((s) => s.key);

  test("the quick-start first-run warning names every delete-by-default section", () => {
    const step = readme.match(/\n4\. Add the workflow\.[\s\S]*?\n\n/)?.[0] ?? "";
    expect(step, "README lost its '4. Add the workflow.' quick-start step").not.toBe("");
    expect(deleteEnumerationProblems(step, deleteKeys)).toEqual([]);
  });

  test("the migration paragraph's implicit-deletion list names every delete-by-default section", () => {
    const paragraph = readme.split("\n\n").find((p) => p.includes("nothing except"));
    expect(paragraph, 'README lost its "nothing except ..." migration paragraph').toBeDefined();
    expect(deleteEnumerationProblems(paragraph ?? "", deleteKeys)).toEqual([]);
  });
});

describe("schema $schema hints and $id", () => {
  const schema = JSON.parse(readFileSync(join(ROOT, "lib", "settings.schema.json"), "utf8"));
  const id = schema.$id as string;

  /** Every markdown page that may carry a yaml-language-server hint. */
  const hintPages = (): Array<{ label: string; path: string }> => [
    { label: "README.md", path: join(ROOT, "README.md") },
    ...readdirSync(join(ROOT, "docs"), { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".md"))
      .sort()
      .map((name) => ({ label: `docs/${name}`, path: join(ROOT, "docs", name) })),
  ];

  test("every yaml-language-server line in the README and the guides names the schema at the moving major tag", () => {
    expect(id, "lib/settings.schema.json has no $id").toBeTruthy();
    // The hints share the $id's owner/repo/path but fetch at the current
    // release line's moving major tag: the $id is version-free (HEAD), the
    // hints are what editors download, so they pin a release ref.
    const pins = stalePins([{ label: "README.md", text: readme }]);
    expect(pins, "no release yet, so no major tag for the hints to name").not.toBeNull();
    const idUrl = new URL(id);
    const [owner, repo, , ...rest] = idUrl.pathname.split("/").filter(Boolean);
    const expectedHint = `${idUrl.origin}/${owner}/${repo}/${pins?.major}/${rest.join("/")}`;
    // Per-file counts, pinned: a global total would let one of the README's
    // two hints disappear while the guides' hint keeps the sum positive.
    // Adding a hint to a new page is a conscious edit here.
    const EXPECTED_HINTS: Record<string, number> = {
      "README.md": 2, // the Usage step and the example block
      "docs/start/getting-started.md": 1,
    };
    for (const page of hintPages()) {
      const markdown = readFileSync(page.path, "utf8");
      const hints = [...markdown.matchAll(/yaml-language-server: \$schema=(\S+)/g)];
      expect(
        hints.length,
        `${page.label} carries ${hints.length} $schema hint(s), expected ${EXPECTED_HINTS[page.label] ?? 0}; update EXPECTED_HINTS if the move is deliberate`,
      ).toBe(EXPECTED_HINTS[page.label] ?? 0);
      for (const match of hints) {
        expect(
          match[1],
          `${page.label} carries a $schema hint that is not the schema at ${pins?.major}`,
        ).toBe(expectedHint);
      }
    }
  });

  test("the $id points at this repository's raw HEAD copy of the build output", () => {
    // The $id is stamped by gen-settings-schema.ts as the raw copy at HEAD,
    // an identity that names no release...
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      name: string;
    };
    // ...and the URL's parts must each match their own single source:
    // https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>.
    const url = new URL(id);
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("raw.githubusercontent.com");
    const [owner, repo, ref, ...rest] = url.pathname.split("/").filter(Boolean);
    // <path> is the build output, exactly where the generator writes it.
    const genScript = readFileSync(
      join(ROOT, ".github", "scripts", "gen-settings-schema.ts"),
      "utf8",
    );
    expect(
      genScript.includes(`join(ROOT, ${rest.map((part) => JSON.stringify(part)).join(", ")})`),
      `gen-settings-schema.ts does not write to ${rest.join("/")}, where the $id points`,
    ).toBe(true);
    // <repo> matching the package name is a convention witness, not an
    // authority - nothing forces a repository to be named after its package,
    // but this one is, and the equality catches a rename on either side.
    expect(repo).toBe(pkg.name);
    // <owner>/<repo> is the slug the README's own workflow snippet installs
    // (that pin is itself anchored by the "README version pins" test). An
    // includes() cannot prove EVERY install line agrees - third-party
    // actions share the uses: syntax - but a $id naming a slug no snippet
    // installs fails here.
    expect(
      readme.includes(`uses: ${owner}/${repo}@`),
      `the README never installs "uses: ${owner}/${repo}@...", so the $id's slug matches no workflow snippet`,
    ).toBe(true);
    // <ref> is HEAD: version-free, so a major bump never waits on a schema
    // regeneration to go green.
    expect(ref).toBe("HEAD");
  });
});

describe("README migration paragraph", () => {
  test("lists exactly the Probot-parity sections", () => {
    const paragraph = sectionLines(
      readme,
      "Migrating from the Probot Settings app",
      "README.md",
    ).join(" ");
    // Isolate the parity clause precisely so later mentions (e.g. "move to
    // `rulesets`") cannot leak in and a filename dot cannot truncate it: the
    // clause runs from "works as-is for" up to its "(for the list sections
    // among them, the plain-array form remains Probot-compatible" marker -
    // the array-form claim is scoped to the list sections, since the
    // object-shaped sections have no array form and the wrapped `undeclared`
    // form is this action's own addition.
    const clause = paragraph.match(
      /works as-is for\s+(.*?)\(for the list sections among them, the plain-array form remains Probot-compatible/s,
    );
    expect(
      clause,
      'README migration paragraph must name the parity sections in a "works as-is for ... (for the list sections among them, the plain-array form remains Probot-compatible" clause',
    ).not.toBeNull();
    const listed = new Set(
      [...(clause?.[1] ?? "").matchAll(/`([a-z_]+)`/g)]
        .map((m) => m[1] as string)
        .filter((key) => (SECTION_KEYS as readonly string[]).includes(key)),
    );
    const parity = new Set<string>(PROBOT_PARITY_KEYS);
    // Exact set-equality, both directions: no parity section omitted, and no
    // non-parity section claimed.
    const missing = [...parity].filter((key) => !listed.has(key));
    const extra = [...listed].filter((key) => !parity.has(key));
    expect(
      missing,
      `README migration parity clause omits Probot-parity section(s): ${missing.join(", ")}`,
    ).toEqual([]);
    expect(
      extra,
      `README migration parity clause claims parity for non-parity section(s): ${extra.join(", ")}`,
    ).toEqual([]);
  });
});

describe("private repositories guide", () => {
  // The guide is a standalone page whose title is a single `#`, so it is
  // read whole-document rather than via sectionLines() - the stronger pin
  // anyway, since each claim must live somewhere on the page.
  const section = readFileSync(join(ROOT, "docs", "operate", "private-repositories.md"), "utf8");

  test("names every private-report channel the code accepts", () => {
    // A channel added to PRIVATE_REPORT_CHANNELS but never documented (or a
    // documented channel the code dropped) fails here.
    for (const channel of PRIVATE_REPORT_CHANNELS) {
      expect(
        section.includes(`\`private-report: ${channel}\``) || channel === "none",
        `the private repositories guide does not document the "${channel}" channel`,
      ).toBe(true);
    }
    // `none` is the default (it delivers nothing), so it is named as the
    // input default rather than as a delivering channel; pin the verbatim
    // default sentence - a bare "none" would match unrelated prose.
    expect(section).toContain("defaults to `private-report: none`, which delivers nothing");
  });

  test("states the default redaction policy and the placeholder/detail constants", () => {
    expect(section).toContain(`\`private-repos: ${DEFAULT_PRIVATE_REPOS}\` (the default)`);
    expect(section).toContain("private repository #N");
    expect(section).toContain(REDACTED_DETAIL);
  });

  test("pins the artifact names and the age keygen/decrypt commands", () => {
    expect(section).toContain(ARTIFACT_NAME);
    expect(section).toContain(ARTIFACT_FILE);
    expect(section).toContain("age-keygen -o key.txt");
    expect(section).toContain(`age -d -i key.txt ${ARTIFACT_FILE}`);
  });

  test("documents the issue-channel PAT grant", () => {
    // The issue channel needs Issues read+write on every target; the grant
    // prose mirrors grantFor(ISSUE_REPORT_PERMISSION).
    expect(section).toContain('`"Issues"` (read and write)');
  });

  test("states the delivery accuracy caveats the review pinned", () => {
    // Delivery is gated on PROVEN private/internal, not merely redacted.
    expect(section.toLowerCase()).toContain("private or internal");
    // The artifact channel does not work on GitHub Enterprise Server.
    expect(section).toContain("GitHub Enterprise Server");
    // A downloaded artifact is a ZIP; the docs give an extraction path.
    expect(section).toContain("gh run download");
  });

  test("the overall-result enumeration names exactly the REPO_RESULTS members", () => {
    // The safe-skeleton paragraph enumerates every result value a redacted
    // target can show; pin the parenthesized list to REPO_RESULTS the same
    // way the action-yml contract test pins the output description.
    assertBacktickedEnumeration(
      section.replace(/\n/g, " "),
      /the overall result \(([^)]*)\)/,
      REPO_RESULTS,
      'the guide must enumerate the result values in "the overall result (...)"',
    );
  });
});

describe("SettingsFile deletion claims", () => {
  test("the description of delete/keep sections claims its own policy and never the opposite", () => {
    // Each knobbed section's published description (its <key>.docs.yml
    // `SettingsFile.<key>` entry) states its default in a "... by default"
    // clause and may mention the opposite word elsewhere (the `undeclared:`
    // opt-in it documents). The claim windows, families, and negator handling
    // live in ./claims.ts, shared with the COVERAGE sweep.
    for (const section of SECTIONS) {
      if (section.undeclaredDefault === "untouched") {
        continue; // "untouched" sections make no per-key deletion claim
      }
      const description = DOCS[section.key].schema[`SettingsFile.${section.key}`];
      expect(
        description,
        `no SettingsFile.${section.key} description in its docs file`,
      ).toBeTruthy();
      for (const problem of defaultClaimProblems(description ?? "", section.undeclaredDefault)) {
        throw new Error(`SettingsFile.${section.key} description: ${problem}`);
      }
    }
  });
});

describe("schema.ts file-header additions claim", () => {
  const schemaSrc = readFileSync(join(ROOT, "src", "schema.ts"), "utf8");
  // The header block, with URLs removed so a section-key word inside a link
  // (e.g. "repository" in the repository-settings/app URL) cannot match.
  const header = schemaSrc.slice(0, schemaSrc.indexOf("*/")).replace(/https?:\/\/\S+/g, "");

  test("the header defers to PROBOT_PARITY_KEYS", () => {
    // The header must define the additions by exclusion over
    // PROBOT_PARITY_KEYS; the pointer to the constant IS the derivation.
    expect(
      header.includes("PROBOT_PARITY_KEYS"),
      "the schema.ts file header must define the additions via PROBOT_PARITY_KEYS",
    ).toBe(true);
  });

  test("the header names no addition section", () => {
    // An enumeration of the non-parity sections is the copy that drifts, so
    // no section key outside PROBOT_PARITY_KEYS may appear in the header.
    const parity = new Set<string>(PROBOT_PARITY_KEYS);
    for (const key of SECTION_KEYS) {
      if (parity.has(key)) {
        continue;
      }
      expect(
        new RegExp(`\\b${key}\\b`).test(header),
        `the schema.ts file header names the addition section "${key}"; defer to PROBOT_PARITY_KEYS instead of enumerating`,
      ).toBe(false);
    }
  });
});

describe("section-contract README-heading references", () => {
  const contractDir = join(ROOT, "src", "sections", "contract");
  const contractSrc = readdirSync(contractDir)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => readFileSync(join(contractDir, file), "utf8"))
    .join("\n");
  // Headings count only outside fenced code blocks: the README carries a
  // "# yaml-language-server:" line inside a yaml fence that is not a heading.
  const readmeProse = readme.replace(/```[\s\S]*?```/g, "");

  test('every README "..." name quoted in the JSDoc is a real README heading', () => {
    // Every quoted name following a README mention must exist as a markdown
    // heading, so a heading rename (or a JSDoc typo) fails here. All quoted
    // names on the mention's line count, not just the first.
    const named: string[] = [];
    for (const line of contractSrc.split("\n")) {
      const mention = line.search(/README'?s?\b/);
      if (mention === -1) {
        continue;
      }
      named.push(...[...line.slice(mention).matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? ""));
    }
    // Zero extracted names while the contract still mentions the README means
    // the extraction went blind (e.g. a rewrap split a mention from its
    // quotes); fail loudly rather than pass on an empty list.
    expect(
      named.length,
      "the section contract mentions the README but no quoted heading name was extracted; fix the JSDoc line wrap or this extraction",
    ).toBeGreaterThan(0);
    for (const name of named) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(
        new RegExp(`^#{1,6} ${escaped}\\s*$`, "m").test(readmeProse),
        `a section-contract JSDoc names the README's "${name}", but README.md has no such heading`,
      ).toBe(true);
    }
  });
});

describe("forward-compatibility closed-sections claim", () => {
  test("the guide's prose names exactly the closedSurface sections", () => {
    // closedSurface is the module-level source of which sections reject
    // unrecognized keys; the forward-compatibility page must list those and
    // no others, the same way undeclaredDefault pins the Sections table.
    // The page's title is a single `#`, so it is read whole-document.
    const closed = SECTIONS.filter((section) => section.closedSurface !== undefined).map(
      (section) => section.key,
    );
    expect(closed.length).toBeGreaterThan(0);
    const paragraph = readFileSync(
      join(ROOT, "docs", "reference", "forward-compatibility.md"),
      "utf8",
    ).replace(/\n/g, " ");
    const sentence = paragraph.match(/[^.]*closed rather than passthrough[^.]*\./)?.[0];
    expect(
      sentence,
      'docs/reference/forward-compatibility.md has no sentence containing "closed rather than passthrough"; restore the phrase or update this extraction',
    ).toBeDefined();
    // The sentence opens with the count in words; pin it to the derived list
    // so the next closed section cannot leave the number stale.
    const word = countWord(closed.length);
    const capitalized = word.charAt(0).toUpperCase() + word.slice(1);
    expect(sentence).toContain(`${capitalized} sections are closed`);
    for (const key of closed) {
      expect(sentence).toContain(`\`${key}\``);
    }
    for (const key of SECTION_KEYS) {
      if (!closed.includes(key)) {
        expect(sentence).not.toContain(`\`${key}\``);
      }
    }
  });
});
