/**
 * Unit test for the diff-aware section selector. Pins the file-to-section map
 * against SECTION_KEYS so a new section forces a map entry, and checks the
 * cross-cutting and docs-only branches select "all" and "none" respectively.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  buildSectionsByFile,
  renderSelection,
  sectionsForFiles,
} from "../../.github/scripts/changed-sections.js";
import { SECTION_KEYS } from "../../src/schema.js";

const SECTIONS_DIR = join(import.meta.dir, "..", "..", "src", "sections");

describe("changed-sections file map", () => {
  const byFile = buildSectionsByFile();

  test("every section key is reachable from some section file", () => {
    const reachable = new Set(Object.values(byFile).flat());
    for (const key of SECTION_KEYS) {
      expect(reachable.has(key), `no section file maps to key "${key}"`).toBe(true);
    }
  });

  test("every mapped key is a real SECTION_KEYS member", () => {
    const known = new Set<string>(SECTION_KEYS);
    for (const [file, keys] of Object.entries(byFile)) {
      for (const key of keys) {
        expect(known.has(key), `${file} maps to unknown section key "${key}"`).toBe(true);
      }
    }
  });

  test("every mapped file exists in src/sections", () => {
    // Both directions with the on-disk files below: a renamed or deleted
    // section handler must break this test rather than silently mis-select.
    const onDisk = new Set(readdirSync(SECTIONS_DIR));
    for (const file of Object.keys(byFile)) {
      expect(onDisk.has(file), `map names "${file}", which does not exist in src/sections`).toBe(
        true,
      );
    }
  });

  test("every section handler file on disk is mapped", () => {
    // contract.ts and registry.ts are cross-cutting (they force "all", not a
    // per-file mapping) and roles.ts is a shared helper mapped explicitly; every
    // OTHER .ts in src/sections is a section handler and must be in the map.
    const crossCutting = new Set(["contract.ts", "registry.ts"]);
    const mapped = new Set(Object.keys(byFile));
    for (const file of readdirSync(SECTIONS_DIR)) {
      if (!file.endsWith(".ts") || crossCutting.has(file)) {
        continue;
      }
      expect(
        mapped.has(file),
        `src/sections/${file} exists but the changed-sections map does not name it`,
      ).toBe(true);
    }
  });

  test("the special-named files map to their real keys", () => {
    expect(byFile["code-scanning.ts"]).toEqual(["code_scanning_default_setup"]);
    expect(byFile["roles.ts"]).toEqual(["collaborators", "teams"]);
  });

  test("each 1:1 section file maps to exactly its own key", () => {
    // code_scanning_default_setup lives in code-scanning.ts, so it has no
    // <key>.ts entry; every other key does.
    for (const key of SECTION_KEYS) {
      if (key === "code_scanning_default_setup") {
        expect(byFile[`${key}.ts`]).toBeUndefined();
        continue;
      }
      expect(byFile[`${key}.ts`]).toEqual([key]);
    }
  });
});

describe("changed-sections selection", () => {
  test("a docs-only change selects none", () => {
    const selection = sectionsForFiles(["README.md", "COVERAGE.md", ".github/workflows/ci.yml"]);
    expect(selection.kind).toBe("none");
    expect(renderSelection(selection)).toBe("none");
  });

  test("a single section file selects just that section", () => {
    const selection = sectionsForFiles(["src/sections/labels.ts"]);
    expect(renderSelection(selection)).toBe("labels");
  });

  test("code-scanning.ts selects the long key", () => {
    expect(renderSelection(sectionsForFiles(["src/sections/code-scanning.ts"]))).toBe(
      "code_scanning_default_setup",
    );
  });

  test("roles.ts fans out to collaborators and teams, in SECTION_KEYS order", () => {
    expect(renderSelection(sectionsForFiles(["src/sections/roles.ts"]))).toBe(
      "collaborators,teams",
    );
  });

  test("multiple section files union in SECTION_KEYS order", () => {
    const selection = sectionsForFiles(["src/sections/milestones.ts", "src/sections/labels.ts"]);
    // labels precedes milestones in SECTION_KEYS, so the list is ordered.
    expect(renderSelection(selection)).toBe("labels,milestones");
  });

  test("contract.ts and registry.ts each select all", () => {
    expect(sectionsForFiles(["src/sections/contract.ts"]).kind).toBe("all");
    expect(sectionsForFiles(["src/sections/registry.ts"]).kind).toBe("all");
    expect(renderSelection(sectionsForFiles(["src/sections/registry.ts"]))).toBe("all");
  });

  test("core paths select all", () => {
    for (const file of [
      "src/engine/orchestrate.ts",
      "src/github/api.ts",
      "src/action/inputs.ts",
      "src/discovery/discover.ts",
      "src/main.ts",
      "src/schema.ts",
      "test/e2e/runner.ts",
    ]) {
      expect(sectionsForFiles([file]).kind, `${file} should select all`).toBe("all");
    }
  });

  test("a section change plus its regenerated lib scopes to the section, not all", () => {
    // lib/ regenerates on every src change, so a labels change also touches
    // lib/index.js; the lib file must not force "all" or diff-awareness is dead.
    const selection = sectionsForFiles(["src/sections/labels.ts", "lib/index.js"]);
    expect(renderSelection(selection)).toBe("labels");
  });

  test("a lib-only diff selects all (no source to scope from)", () => {
    expect(sectionsForFiles(["lib/index.js"]).kind).toBe("all");
    expect(sectionsForFiles(["lib/index.js", "lib/settings.schema.json"]).kind).toBe("all");
  });

  test("lib alongside a docs-only change stays scoped by the non-lib files", () => {
    // README + lib (no src): the README contributes no section, lib is ignored,
    // but lib was touched with a non-lib file present, so it is not the lib-only
    // case; the result is none.
    expect(sectionsForFiles(["README.md", "lib/index.js"]).kind).toBe("none");
  });

  test("a core-path change wins over a section change", () => {
    // Any all-selecting path forces all, regardless of other changed files.
    const selection = sectionsForFiles(["src/sections/labels.ts", "src/engine/diff.ts"]);
    expect(selection.kind).toBe("all");
  });
});
