/**
 * README contract tests: pin the Sections table, the schema link, the example
 * settings.yml blocks, the migration paragraph, and the version pins to their
 * single sources, so a prose claim cannot drift from what the code does.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { validateSettingsDoc } from "../../src/engine/orchestrate.js";
import type { Io } from "../../src/io.js";
import { PROBOT_PARITY_KEYS, SECTION_KEYS } from "../../src/schema.js";
import { SECTIONS } from "../../src/sections/registry.js";
import { SPECIAL_KEYS } from "../../src/sections/repository.js";
import { sectionLines, tableRows } from "./markdown.js";

const ROOT = join(import.meta.dir, "..", "..");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");

/** The claim each deletesUndeclared value must appear as in a Sections row. */
const DELETION_CLAIM: Record<string, string> = {
  deletes: "undeclared deleted",
  keeps: "undeclared kept",
  untouched: "undeclared untouched",
};

describe("README Sections table", () => {
  const rows = tableRows(sectionLines(readme, "Sections"));

  test("one row per section, in SECTION_KEYS order", () => {
    const names = rows.map((cells) => (cells[0] ?? "").replace(/`/g, ""));
    expect(names).toEqual([...SECTION_KEYS]);
  });

  test("each row's deletion claim derives from the section's deletesUndeclared", () => {
    const byKey = new Map(SECTIONS.map((section) => [section.key, section]));
    for (const cells of rows) {
      const key = (cells[0] ?? "").replace(/`/g, "");
      const notes = cells.at(-1) ?? ""; // Notes is the table's last column
      const section = byKey.get(key as (typeof SECTION_KEYS)[number]);
      if (!section) {
        throw new Error(`README Sections row "${key}" is not a section key`);
      }
      const claim = DELETION_CLAIM[section.deletesUndeclared] as string;
      expect(
        notes.includes(claim),
        `README Sections row "${key}" must state "${claim}" (its deletesUndeclared is "${section.deletesUndeclared}"), got notes: ${notes}`,
      ).toBe(true);
    }
  });
});

describe("README example settings.yml blocks", () => {
  function fencedYamlBlocks(markdown: string): string[] {
    const blocks: string[] = [];
    const re = /```yaml\n([\s\S]*?)```/g;
    for (const m of markdown.matchAll(re)) {
      blocks.push(m[1] ?? "");
    }
    return blocks;
  }
  const silentIo: Io = { annotate: () => {}, log: () => {} };

  test("every settings.yml example validates and its repository keys are known", () => {
    // The example block parses to a settings document (other yaml blocks are
    // workflow yaml). Validate any block whose top level is a mapping of known
    // section keys, then confirm repository special-looking keys are real.
    const known = new Set<string>(SECTION_KEYS);
    let validated = 0;
    for (const block of fencedYamlBlocks(readme)) {
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
      const invalid = validateSettingsDoc(doc, "README example", new Set(), silentIo);
      expect(invalid, `README settings.yml example failed validation: ${invalid}`).toBeNull();
      const repository = (doc as Record<string, unknown>).repository;
      if (repository && typeof repository === "object") {
        for (const key of Object.keys(repository)) {
          if (key.startsWith("enable_") || key === "topics") {
            expect(
              SPECIAL_KEYS.has(key),
              `README example uses repository.${key}, which looks like a special key but is not in SPECIAL_KEYS`,
            ).toBe(true);
          }
        }
      }
      validated++;
    }
    expect(validated, "no settings.yml example block was found in the README").toBeGreaterThan(0);
  });
});

describe("README version pins", () => {
  test("every uses: pin names the current release major", () => {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, ".release-please-manifest.json"), "utf8"),
    ) as Record<string, string>;
    const config = JSON.parse(readFileSync(join(ROOT, "release-please-config.json"), "utf8")) as {
      packages: Record<string, { "initial-version"?: string }>;
    };
    // Before the first release the manifest still reads 0.0.0; the expected
    // major then comes from the configured initial-version. On a release PR
    // the manifest carries the new version, so a major bump fails this test
    // until the README's uses: pins are updated with it.
    const released = manifest["."] ?? "";
    const version =
      released === "0.0.0" ? (config.packages["."]?.["initial-version"] ?? released) : released;
    const major = version.split(".")[0];
    const pins = [...readme.matchAll(/repo-settings-as-code@v(\d+)/g)].map((m) => m[1]);
    expect(pins.length).toBeGreaterThan(0);
    for (const pin of pins) {
      expect(pin, `README pins @v${pin}, but the current release major is v${major}`).toBe(major);
    }
  });
});

describe("README schema link", () => {
  test("the $schema line points at lib/settings.schema.json's $id", () => {
    const schema = JSON.parse(readFileSync(join(ROOT, "lib", "settings.schema.json"), "utf8"));
    const id = schema.$id as string;
    expect(id, "lib/settings.schema.json has no $id").toBeTruthy();
    expect(
      readme.includes(`$schema=${id}`),
      `README's yaml-language-server line must reference the schema $id ${id}`,
    ).toBe(true);
  });
});

describe("README migration paragraph", () => {
  test("lists exactly the Probot-parity sections", () => {
    const paragraph = sectionLines(readme, "Migrating from the Probot Settings app").join(" ");
    // Isolate the parity clause precisely so later mentions (e.g. "move to
    // `rulesets`") cannot leak in and a filename dot cannot truncate it: the
    // clause runs from "works as-is for" up to its "(same schema)" marker.
    const clause = paragraph.match(/works as-is for\s+(.*?)\(same schema\)/s);
    expect(
      clause,
      'README migration paragraph must name the parity sections in a "works as-is for ... (same schema)" clause',
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

describe("schema.ts SettingsFile JSDoc deletion claims", () => {
  const schemaSrc = readFileSync(join(ROOT, "src", "schema.ts"), "utf8");
  const CLAIM_WORD: Record<string, RegExp> = {
    deletes: /delete|remove/i,
    keeps: /kept|keep/i,
  };

  test("the JSDoc for delete/keep sections matches deletesUndeclared", () => {
    for (const section of SECTIONS) {
      const pattern = CLAIM_WORD[section.deletesUndeclared];
      if (!pattern) {
        continue; // "untouched" sections make no per-key deletion claim
      }
      const propRe = new RegExp(`/\\*\\*([^*]|\\*(?!/))*\\*/\\s*\\n\\s*${section.key}\\?:`, "m");
      const match = schemaSrc.match(propRe);
      expect(match, `no JSDoc found above SettingsFile.${section.key}`).not.toBeNull();
      expect(
        pattern.test(match?.[0] ?? ""),
        `SettingsFile.${section.key} JSDoc must state a "${section.deletesUndeclared}" policy (matching ${pattern})`,
      ).toBe(true);
    }
  });
});
