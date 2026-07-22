/**
 * Contract test pinning action.yml, the code, and the README's Inputs
 * table to each other. Nothing parses action.yml at runtime, so an input
 * added to one side and forgotten on the others would drift silently; this
 * test fails loudly with the specific names that diverged.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  DEFAULT_MODE,
  DEFAULT_ON_MISSING_PERMISSION,
  DEFAULT_SETTINGS_FILE,
  INPUT_NAMES,
} from "../../src/action/inputs.js";
import { OUTPUT_NAMES } from "../../src/action/io.js";
import { DEFAULT_DISCOVERY_FILTERS } from "../../src/discovery/discover.js";
import { REPO_RESULTS } from "../../src/engine/orchestrate.js";
import { DEFAULT_API_VERSION } from "../../src/github/api.js";

const ROOT = join(import.meta.dir, "..", "..");

interface ActionInput {
  description?: string;
  default?: unknown;
}
interface ActionYml {
  inputs: Record<string, ActionInput>;
  outputs: Record<string, { description?: string }>;
}

const actionYml = parseYaml(readFileSync(join(ROOT, "action.yml"), "utf8")) as ActionYml;

/** Names in `a` missing from `b`, for an actionable failure message. */
function missingFrom(a: readonly string[], b: readonly string[]): string[] {
  const set = new Set(b);
  return a.filter((name) => !set.has(name));
}

describe("action.yml <-> inputs.ts", () => {
  test("input names match INPUT_NAMES in both directions", () => {
    const declared = Object.keys(actionYml.inputs);
    const extraInYml = missingFrom(declared, INPUT_NAMES);
    const missingInYml = missingFrom(INPUT_NAMES, declared);
    expect(
      extraInYml,
      `action.yml declares input(s) the code never reads (add to INPUT_NAMES or remove from action.yml): ${extraInYml.join(", ")}`,
    ).toEqual([]);
    expect(
      missingInYml,
      `INPUT_NAMES lists input(s) missing from action.yml (add to action.yml or remove from INPUT_NAMES): ${missingInYml.join(", ")}`,
    ).toEqual([]);
  });

  test("input defaults equal the code constants", () => {
    const def = (name: string): unknown => actionYml.inputs[name]?.default;
    expect(def("settings-file")).toBe(DEFAULT_SETTINGS_FILE);
    expect(def("api-version")).toBe(DEFAULT_API_VERSION);
    expect(def("mode")).toBe(DEFAULT_MODE);
    expect(def("on-missing-permission")).toBe(DEFAULT_ON_MISSING_PERMISSION);
  });
});

describe("action.yml outputs", () => {
  test("output names match OUTPUT_NAMES in both directions", () => {
    const declared = Object.keys(actionYml.outputs);
    expect(missingFrom(declared, OUTPUT_NAMES)).toEqual([]);
    expect(missingFrom(OUTPUT_NAMES, declared)).toEqual([]);
  });

  test("the result description mentions every RepoResult value", () => {
    // REPO_RESULTS is the canonical value list exported next to worstOf() in
    // src/engine/orchestrate.ts; a new RepoResult value added there but left
    // out of the output docs fails here.
    const description = actionYml.outputs.result?.description ?? "";
    const missing = REPO_RESULTS.filter((value) => !description.includes(value));
    expect(
      missing,
      `the action.yml "result" output description omits RepoResult value(s): ${missing.join(", ")}`,
    ).toEqual([]);
  });
});

describe("action.yml <-> discovery defaults", () => {
  const FILTER_INPUTS = ["visibility", "archived", "forks", "exclude", "topics", "affiliation"];

  test("every discovery filter input has an empty action.yml default", () => {
    // The bottom layer of the two-layer model: the code detects an
    // explicitly-set filter by comparing the raw input against "", and
    // supplies DEFAULT_DISCOVERY_FILTERS only when it is empty. A non-empty
    // action.yml default (e.g. visibility: "public") would silently defeat
    // that detection, so pin every filter default to "".
    for (const name of FILTER_INPUTS) {
      expect(
        actionYml.inputs[name]?.default,
        `action.yml "${name}" default must be present and "" so the code's explicit-set detection and DEFAULT_DISCOVERY_FILTERS fallback work; got: ${JSON.stringify(actionYml.inputs[name]?.default)}`,
      ).toBe("");
    }
  });

  test("each discovery filter description documents its default", () => {
    // The filter descriptions carry the documented default inline (e.g.
    // "all (default)"); check each names the DEFAULT_DISCOVERY_FILTERS value.
    const documented: Record<string, string> = {
      visibility: DEFAULT_DISCOVERY_FILTERS.visibility,
      archived: DEFAULT_DISCOVERY_FILTERS.archived,
      forks: DEFAULT_DISCOVERY_FILTERS.forks,
      affiliation: DEFAULT_DISCOVERY_FILTERS.affiliation.join(","),
    };
    for (const [name, value] of Object.entries(documented)) {
      const description = actionYml.inputs[name]?.description ?? "";
      expect(
        description.includes(value),
        `action.yml "${name}" description does not mention its default "${value}"`,
      ).toBe(true);
    }
  });
});

/**
 * Parse the README's "## Inputs" markdown table into rows of
 * {name, default}. Small and forgiving of column widths: the backticked
 * name in the first cell and the first backticked token in the default
 * cell are what matter.
 */
function readmeInputRows(): Array<{ name: string; defaultCell: string }> {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const lines = readme.split("\n");
  const start = lines.findIndex((line) => /^##\s+Inputs\s*$/.test(line));
  if (start === -1) {
    throw new Error('README.md has no "## Inputs" heading');
  }
  const rows: Array<{ name: string; defaultCell: string }> = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^##\s/.test(line)) {
      break; // next heading ends the section
    }
    if (!line.trim().startsWith("|")) {
      continue;
    }
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 2) {
      continue;
    }
    const nameMatch = cells[0]?.match(/`([^`]+)`/);
    if (!nameMatch) {
      continue; // header row and the |---| separator have no backticked name
    }
    rows.push({ name: nameMatch[1] ?? "", defaultCell: cells[1] ?? "" });
  }
  return rows;
}

describe("README Inputs table <-> action.yml", () => {
  const rows = readmeInputRows();

  test("exactly one README row per action.yml input", () => {
    const rowNames = rows.map((r) => r.name);
    const declared = Object.keys(actionYml.inputs);
    const extraRows = missingFrom(rowNames, declared);
    const missingRows = missingFrom(declared, rowNames);
    expect(
      extraRows,
      `README Inputs table has row(s) for unknown input(s): ${extraRows.join(", ")}`,
    ).toEqual([]);
    expect(
      missingRows,
      `README Inputs table is missing row(s) for action.yml input(s): ${missingRows.join(", ")}`,
    ).toEqual([]);
    const seen = new Set<string>();
    const duplicated = rowNames.filter((name) => {
      if (seen.has(name)) {
        return true;
      }
      seen.add(name);
      return false;
    });
    expect(
      duplicated,
      `README Inputs table has duplicate row(s): ${duplicated.join(", ")}`,
    ).toEqual([]);
  });

  test("each README default cell matches the action.yml default", () => {
    // Discovery filters carry default: "" in action.yml but a documented
    // effective default the code supplies; the README shows that effective
    // default (e.g. `all`), so assert it backticked for these inputs.
    const effectiveDefault: Record<string, string> = {
      visibility: DEFAULT_DISCOVERY_FILTERS.visibility,
      archived: DEFAULT_DISCOVERY_FILTERS.archived,
      forks: DEFAULT_DISCOVERY_FILTERS.forks,
      affiliation: DEFAULT_DISCOVERY_FILTERS.affiliation.join(","),
    };
    // Inputs whose default renders as prose rather than the raw action.yml
    // value; the exact cell text is pinned so README drift here still fails.
    const proseCell: Record<string, string> = {
      token: "`github.token`",
      repository: "current repo",
      sections: "(all declared)",
    };
    for (const { name, defaultCell } of rows) {
      const actual = String(actionYml.inputs[name]?.default ?? "");
      if (name in effectiveDefault) {
        expect(
          defaultCell,
          `README default cell for "${name}" should read exactly \`${effectiveDefault[name]}\`, got: ${defaultCell}`,
        ).toBe(`\`${effectiveDefault[name]}\``);
        continue;
      }
      if (name in proseCell) {
        expect(
          defaultCell,
          `README default cell for "${name}" should read exactly "${proseCell[name]}", got: ${defaultCell}`,
        ).toBe(proseCell[name] as string);
        continue;
      }
      if (actual === "") {
        // Every remaining empty-default input uses the exact marker "(empty)";
        // asserting the literal (not a loose regex) catches real README drift.
        expect(
          defaultCell,
          `README default cell for "${name}" should read exactly "(empty)", got: ${defaultCell}`,
        ).toBe("(empty)");
        continue;
      }
      expect(
        defaultCell,
        `README default cell for "${name}" should read exactly \`${actual}\`, got: ${defaultCell}`,
      ).toBe(`\`${actual}\``);
    }
  });
});
