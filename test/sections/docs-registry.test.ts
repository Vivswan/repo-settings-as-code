// The docs registry's contracts: authored prose stays consistent with the declarations beside it
// (a Notes cell or coverage row never contradicts undeclaredDefault; Endpoints cells and coverage
// rows name every resource the section calls), and no docs file is reachable from the bundle.

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { SECTION_KEYS, type SectionKey } from "../../src/schema.js";
import { readDocsYaml, SectionDocs } from "../../src/sections/contract/docs.js";
import { endpointPath, type Route } from "../../src/sections/contract/endpoints.js";
import { DOCS } from "../../src/sections/docs-registry.js";
import { allEndpoints, allGraphqlOps, SECTIONS } from "../../src/sections/registry.js";
import { CLAIM_FAMILY, CLAIM_STEMS, defaultClaimProblems, stemNegation } from "../docs/claims.js";

const ROOT = join(import.meta.dir, "..", "..");

/** `text` as a regex source matching itself literally. */
function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whether `prose` names the GraphQL operation `name` as a whole identifier, case-insensitively:
// "the pinEnvironment mutation" names PinEnvironment, "DocumentPinEnvironmentAudit" does not.
function namesOperation(prose: string, name: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_])${escapeRe(name)}(?![A-Za-z0-9_])`, "i").test(prose);
}

// Whether `prose` spells the path segment `segment` as a whole token: a route in prose bounds it
// with "/" or "{" ("GET .../keys/{key_id}"), so "monkeys" never satisfies "keys" and "labels/{name}" does.
function mentionsSegment(prose: string, segment: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_-])${escapeRe(segment)}(?![A-Za-z0-9_-])`).test(prose);
}

/** A section's coverage Notes cells joined, since a section may span several rows. */
function coverageNotes(key: SectionKey): string {
  return DOCS[key].coverage.map((row) => row.notes).join(" ");
}

/** The distinctive leading segment of an endpoint's path below the repo, or "" for the bare repo endpoint. */
function leadingSegment(route: Route): string {
  const tail = endpointPath(route)
    .replace("/repos/{owner}/{repo}", "")
    .replace(/\{[^}]+\}/g, "")
    .replace(/\/+$/g, "");
  return tail.replace(/^\//, "").split("/")[0] ?? "";
}

/** Whether a source path is documentation code: the docs registry or the docs document shapes. */
function isDocsFile(path: string): boolean {
  return path.endsWith("/contract/docs.ts") || path.endsWith("/docs-registry.ts");
}

// The specifiers a source file depends on, as the bundler sees them (Bun's own scanner, so no
// import form slips past a regex); type-only imports are erased and carry no prose, so they do not count.
const transpiler = new Bun.Transpiler({ loader: "ts" });
function importSpecifiers(source: string): string[] {
  return transpiler.scanImports(source).map((entry) => entry.path);
}

/** Every source file transitively imported from `entry` (.js -> .ts, a directory -> its index.ts). */
function importGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
      if (!specifier.startsWith(".")) {
        continue;
      }
      let resolved = join(dirname(file), specifier.replace(/\.js$/, ".ts"));
      if (existsSync(resolved) && statSync(resolved).isDirectory()) {
        resolved = join(resolved, "index.ts");
      }
      if (!existsSync(resolved)) {
        throw new Error(
          `${relative(ROOT, file)} imports "${specifier}", which resolves to nothing`,
        );
      }
      queue.push(resolved);
    }
  }
  return seen;
}

describe("docs registry reachability", () => {
  test("the specifier scan sees every import form a docs file could hide behind", () => {
    // Control for the walk below: each form yields its specifier, so a
    // docs import in any of them is a reachable edge, not a blind spot. The
    // type-only import is erased on purpose: it puts nothing in the bundle.
    const source = [
      'import { a } from "./static.js";',
      "import {",
      "  b,",
      '} from "./multiline.js";',
      'import type { C } from "./type-only.js";',
      'export { d } from "./reexport.js";',
      'import "./side-effect.js";',
      'const e = await import("./dynamic.js");',
      "const f = await import(`./template.js`);",
      'const g = require("./required.js");',
      'const h = await import(/* note */ "./commented.js", { with: { type: "json" } });',
      'import { z } from "zod";',
    ].join("\n");
    expect(importSpecifiers(source).sort()).toEqual(
      [
        "./static.js",
        "./multiline.js",
        "./reexport.js",
        "./side-effect.js",
        "./dynamic.js",
        "./template.js",
        "./required.js",
        "./commented.js",
        "zod",
      ].sort(),
    );
  });

  test("no docs file is reachable from the bundle entrypoint", () => {
    const bundled = [...importGraph(join(ROOT, "src", "main.ts"))].map((file) =>
      relative(ROOT, file),
    );
    // Control: the walk must reach the section modules, or "no docs file
    // found" would be vacuous.
    expect(bundled).toContain("src/sections/registry.ts");
    expect(bundled).toContain("src/sections/labels/index.ts");
    expect(bundled.filter(isDocsFile)).toEqual([]);
  });

  test("the generator does reach the docs code, so the walk sees it", () => {
    const reached = [...importGraph(join(ROOT, ".github", "scripts", "gen-docs.ts"))]
      .map((file) => relative(ROOT, file))
      .filter(isDocsFile)
      .sort();
    expect(reached).toEqual(["src/sections/contract/docs.ts", "src/sections/docs-registry.ts"]);
  });
});

describe("docs.yml completeness", () => {
  test("every section has a docs.yml and every docs.yml belongs to a section", () => {
    // Loading DOCS already proves each SectionKey's file exists and parses; the reverse pin is
    // what a stray file (a renamed or removed section's leftover) would otherwise escape.
    const onDisk = readdirSync(join(ROOT, "src", "sections"), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && existsSync(join(entry.parentPath, entry.name, "docs.yml")),
      )
      .map((entry) => entry.name)
      .sort();
    expect(onDisk).toEqual([...SECTION_KEYS].sort());
    expect(Object.keys(DOCS).sort()).toEqual([...SECTION_KEYS].sort());
  });

  test("a malformed docs.yml fails naming the file and the issue, a missing one naming the path", () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-yml-"));
    try {
      const malformed = join(dir, "docs.yml");
      // Every guard the shape carries, in one document: an unknown key, an empty coverage list,
      // and a blank cell.
      writeFileSync(
        malformed,
        ["readme:", "  endpoints: labels CRUD", "  notes: ''", "  extra: 1", "coverage: []"].join(
          "\n",
        ),
      );
      // Zod reports the issues in its own order, so each is pinned on its own.
      for (const issue of [
        `${malformed} is not a valid docs document:`,
        'Unrecognized key: "extra"',
        "at readme.notes",
        "at coverage",
      ]) {
        expect(() => readDocsYaml(malformed, SectionDocs)).toThrow(new RegExp(escapeRe(issue)));
      }
      expect(() => readDocsYaml(join(dir, "absent.yml"), SectionDocs)).toThrow(/absent\.yml/);
      // YAML that does not even parse (a duplicated key, which the loader refuses) names the file too.
      writeFileSync(malformed, ["readme:", "  endpoints: a", "  endpoints: b"].join("\n"));
      expect(() => readDocsYaml(malformed, SectionDocs)).toThrow(
        new RegExp(`${escapeRe(malformed)} is not valid YAML: .*unique`),
      );
      // Control: the same reader accepts a well-formed document.
      writeFileSync(
        malformed,
        [
          "readme:",
          "  endpoints: labels CRUD",
          "  notes: upsert by name",
          "coverage:",
          "  - area: Labels",
          "    notes: CRUD",
        ].join("\n"),
      );
      expect(readDocsYaml(malformed, SectionDocs)).toEqual({
        readme: { endpoints: "labels CRUD", notes: "upsert by name" },
        coverage: [{ area: "Labels", notes: "CRUD" }],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Notes cells vs undeclaredDefault", () => {
  test("a knobbed section's Notes cell never claims the opposite of its undeclaredDefault", () => {
    // A claim is a claim-family word joined to "default" ("deleted by default", "keep is the
    // default"); its family, negation resolved by stemNegation, must be the section's own. A cell
    // that mentions a default without a parseable claim fails loudly rather than leaving the sweep.
    const claimRe = new RegExp(
      String.raw`\b(${CLAIM_STEMS})\b(?:[\s-]by[\s-]|\s+(?:is|are|stays?|remains?)\s+the\s+)default`,
      "gi",
    );
    const trigger = /by[\s-]default|\bthe default\b/i;
    for (const section of SECTIONS) {
      if (section.undeclaredDefault === "untouched") {
        continue;
      }
      const notes = DOCS[section.key].readme.notes;
      const claims = [...notes.matchAll(claimRe)];
      if (trigger.test(notes)) {
        // Per-section tripwire: THIS cell mentions its default, so at least
        // one claim must parse here - a global counter would let one
        // section's unrecognized grammar hide behind another's claims.
        expect(
          claims.length,
          `the ${section.key} Notes cell mentions a default but no claim parses; reword the cell or extend the claim grammar`,
        ).toBeGreaterThan(0);
      }
      for (const claim of claims) {
        const family = CLAIM_FAMILY.delete.test(claim[1] ?? "") ? "delete" : "keep";
        const negation = stemNegation(notes.slice(0, claim.index));
        if ("doubleNegation" in negation) {
          throw new Error(
            `the ${section.key} Notes cell: a double negation governs "${negation.doubleNegation} ${claim[1]}"; reword it - double negatives are not resolved`,
          );
        }
        const flipped = family === "delete" ? "keep" : "delete";
        const effective = negation.negated ? flipped : family;
        expect(
          effective,
          `the ${section.key} Notes cell claims "${claim[0]}"${negation.negated ? " (negated)" : ""}, contradicting its "${section.undeclaredDefault}" undeclaredDefault`,
        ).toBe(section.undeclaredDefault);
      }
    }
  });
});

describe("Endpoints cells vs declared operations", () => {
  test("each Endpoints cell names every distinct leading resource segment its section calls", () => {
    // The cells are terse summaries ("labels CRUD"), so the pin is the leading resource segment of
    // each endpoint tail, matched case- and separator-insensitively as a WHOLE word or its singular
    // form ("branch protection" satisfies "branches"; "homepage" can never satisfy "pages").
    const normalize = (text: string): string => text.toLowerCase().replace(/[-_]/g, " ");
    const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // A compound word satisfies its base segment only where the compound IS the resource's common
    // name; whole-word matching is deliberate ("monkeys" must never satisfy "keys"), so extend this
    // map, not the matching, when a cell is reworded ("hooks" -> "webhooks").
    const COMPOUND_MENTIONS: Record<string, readonly string[]> = { hooks: ["webhooks"] };
    for (const endpoint of Object.values(allEndpoints())) {
      const segment = leadingSegment(endpoint.route);
      if (segment === "") {
        continue; // the bare repo endpoint has no distinctive resource
      }
      const needle = normalize(segment);
      // Singular variants of the LAST word only ("branches" -> "branch", "orgs" -> "org"), each
      // matched as a whole word, so an over-stripped form ("pages" -> "pag") never matches inside
      // an unrelated word.
      const words = needle.split(" ");
      const last = words.pop() ?? "";
      const lastForms = new Set([last]);
      if (last.endsWith("es")) {
        lastForms.add(last.slice(0, -2));
      }
      if (last.endsWith("s")) {
        lastForms.add(last.slice(0, -1));
      }
      const variants = [
        ...[...lastForms].map((form) => [...words, form].join(" ")),
        ...(COMPOUND_MENTIONS[needle] ?? []),
      ];
      const cell = normalize(DOCS[endpoint.section].readme.endpoints);
      expect(
        variants.some((variant) => new RegExp(`\\b${escapeRe(variant)}\\b`).test(cell)),
        `the ${endpoint.section} Endpoints cell never mentions "${needle}" from endpoint ${endpoint.route}`,
      ).toBe(true);
    }
    // GraphQL operations have no path to derive a resource segment from, so
    // the cell must name each one by its wire operationName instead.
    for (const op of Object.values(allGraphqlOps())) {
      expect(
        namesOperation(DOCS[op.section].readme.endpoints, op.name),
        `the ${op.section} Endpoints cell never mentions the GraphQL operation "${op.name}"`,
      ).toBe(true);
    }
  });
});

describe("coverage rows vs declarations", () => {
  test("each section's coverage rows name the leading path segment of every endpoint it calls", () => {
    // Control for the matcher: a whole token counts, a longer word does not.
    expect(mentionsSegment("DELETE /repos/{owner}/{repo}/keys/{key_id}", "keys")).toBe(true);
    expect(mentionsSegment("the monkeys endpoint", "keys")).toBe(false);
    // The COVERAGE rows spell endpoints out ("GET/POST /repos/{owner}/{repo}/labels"),
    // so the coverage inventory cannot omit an endpoint the code calls.
    for (const endpoint of Object.values(allEndpoints())) {
      const segment = leadingSegment(endpoint.route);
      if (segment === "") {
        continue; // the bare repo endpoint has no distinctive resource
      }
      expect(
        mentionsSegment(coverageNotes(endpoint.section), segment),
        `the ${endpoint.section} coverage rows never mention "${segment}" from endpoint ${endpoint.route}`,
      ).toBe(true);
    }
  });

  test("each section's coverage rows name every GraphQL operation it issues", () => {
    // Control for the matcher both GraphQL sweeps share: a whole identifier
    // in either case counts, a longer identifier containing the name does
    // not, and a name's regex metacharacters match only themselves.
    expect(namesOperation("the pinEnvironment ({environmentId}) mutation", "PinEnvironment")).toBe(
      true,
    );
    expect(namesOperation("the DocumentPinEnvironmentAudit query", "PinEnvironment")).toBe(false);
    expect(namesOperation("see a.b here", "a.b")).toBe(true);
    expect(namesOperation("see axb here", "a.b")).toBe(false);
    // No path to derive a segment from, so the rows name each operation by
    // its wire operationName.
    for (const op of Object.values(allGraphqlOps())) {
      expect(
        namesOperation(coverageNotes(op.section), op.name),
        `the ${op.section} coverage rows never mention the GraphQL operation "${op.name}"`,
      ).toBe(true);
    }
  });

  test("a knobbed section's coverage rows state its undeclaredDefault and never the opposite", () => {
    // Every knobbed section's rows state the default in a "... by default"
    // clause; the claim windows, families, and negator handling live in
    // test/docs/claims.ts, shared with the schema description sweep.
    for (const section of SECTIONS) {
      if (section.undeclaredDefault === "untouched") {
        continue;
      }
      for (const problem of defaultClaimProblems(
        coverageNotes(section.key),
        section.undeclaredDefault,
      )) {
        throw new Error(`the ${section.key} coverage rows: ${problem}`);
      }
    }
  });
});
