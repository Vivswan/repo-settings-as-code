/**
 * Diff-aware section selector for the PR e2e smoke job. Given the files a PR
 * changed, decide which settings sections the smoke job must exercise, so a PR
 * touching one section runs that section's scenarios and fuzz rather than the
 * whole corpus, and a docs-only PR skips the smoke job entirely.
 *
 * The mapping is EXPLICIT, not inferred: every section file maps to the
 * section key(s) it affects, shared code (roles.ts) fans out to its consumers,
 * and the cross-cutting files (contract.ts, registry.ts, the engine, the
 * schema, the bundle, the e2e harness) select every section. A unit test pins
 * the per-section entries against SECTION_KEYS so a new section cannot be added
 * without teaching this map about it.
 *
 * Usage (CI): `bun .github/scripts/changed-sections.ts [base-ref]` prints one
 * of: a comma-separated section list, the literal `all`, or the literal
 * `none`. The base ref defaults to `origin/main`. The smoke job runs when the
 * output is not `none`.
 */

import { execFileSync } from "node:child_process";
import { SECTION_KEYS, type SectionKey } from "../../src/schema.js";

/** The sentinel the CLI prints (and the job branches on) when every section is in play. */
export const ALL = "all";
/** The sentinel printed when nothing settings-related changed. */
export const NONE = "none";

/**
 * Section files whose name does NOT equal their key, or which fan out to more
 * than one section. Every other src/sections/<key>.ts maps to <key>; the
 * SECTIONS_BY_FILE builder fills those in from SECTION_KEYS.
 */
const SPECIAL_SECTION_FILES: Record<string, SectionKey[]> = {
  // The file is code-scanning.ts but the section key is the longer form.
  "code-scanning.ts": ["code_scanning_default_setup"],
  // roles.ts is the shared permission-vocabulary normalizer for both sections.
  "roles.ts": ["collaborators", "teams"],
};

/**
 * Section files that select EVERY section because they are cross-cutting: the
 * section contract and the registry that wires all handlers together.
 */
const ALL_SELECTING_SECTION_FILES = new Set(["contract.ts", "registry.ts"]);

/**
 * Section keys whose handler file is NOT named `<key>.ts`, so the 1:1 builder
 * must skip them; their real filename is wired through SPECIAL_SECTION_FILES.
 */
const KEYS_WITHOUT_MATCHING_FILE = new Set<SectionKey>(["code_scanning_default_setup"]);

/** src/sections/<file> -> the section key(s) a change to it can affect. */
export function buildSectionsByFile(): Record<string, SectionKey[]> {
  const map: Record<string, SectionKey[]> = {};
  // The 1:1 files: <key>.ts -> [key], except keys whose file has another name.
  for (const key of SECTION_KEYS) {
    if (!KEYS_WITHOUT_MATCHING_FILE.has(key)) {
      map[`${key}.ts`] = [key];
    }
  }
  for (const [file, keys] of Object.entries(SPECIAL_SECTION_FILES)) {
    map[file] = keys;
  }
  return map;
}

const SECTIONS_BY_FILE = buildSectionsByFile();

/**
 * Path prefixes/files that select every section: the shared engine, transport,
 * action layer, discovery, the entrypoint and schema, and the e2e harness
 * itself (a harness change can change every scenario). `lib/` is deliberately
 * NOT here: it regenerates on every `src/` change, so treating it as
 * all-selecting would make almost every PR run every section and defeat the
 * diff scoping. lib is handled as a special case below.
 */
const ALL_SELECTING_PREFIXES = [
  "src/engine/",
  "src/github/",
  "src/action/",
  "src/discovery/",
  "src/main.ts",
  "src/schema.ts",
  "test/e2e/",
];

/** True for a committed generated-bundle path, which every `src/` change touches. */
function isLibFile(file: string): boolean {
  return file.startsWith("lib/");
}

/** The decision for one changed-file set: every section, some, or none. */
export type Selection =
  | { kind: "all" }
  | { kind: "some"; sections: SectionKey[] }
  | { kind: "none" };

/**
 * Map a set of changed file paths (repo-relative, forward slashes) to the
 * sections the smoke job must run. Any cross-cutting path forces "all"; section
 * files contribute their key(s); files that touch nothing settings-related are
 * ignored, so a purely docs/config PR yields "none". `lib/` files are ignored
 * during the per-section pass because they mirror the `src/` change that
 * produced them; a diff that touches ONLY `lib/` (no `src/` at all, e.g. a
 * hand-edited or stale bundle) has no source to scope from, so it selects
 * "all".
 */
export function sectionsForFiles(files: readonly string[]): Selection {
  const selected = new Set<SectionKey>();
  let sawLib = false;
  let sawNonLib = false;
  for (const file of files) {
    if (isLibFile(file)) {
      sawLib = true;
      continue; // the src change that regenerated lib is what scopes the run
    }
    sawNonLib = true;
    if (ALL_SELECTING_PREFIXES.some((prefix) => file.startsWith(prefix))) {
      return { kind: "all" };
    }
    if (!file.startsWith("src/sections/")) {
      // Everything else (README, COVERAGE, workflows, package.json, tests
      // outside e2e) contributes no section.
      continue;
    }
    const name = file.slice("src/sections/".length);
    if (ALL_SELECTING_SECTION_FILES.has(name)) {
      return { kind: "all" };
    }
    const keys = SECTIONS_BY_FILE[name];
    if (keys) {
      for (const key of keys) {
        selected.add(key);
      }
    }
    // A new, unmapped src/sections/*.ts file is conservatively ignored here;
    // the map's unit test fails first if a section lacks an entry, so an
    // unmapped file can only be a non-section helper.
  }
  if (selected.size === 0) {
    // A lib-only diff has no source to scope from, so run everything; a diff
    // with no settings-related files at all runs nothing.
    return sawLib && !sawNonLib ? { kind: "all" } : { kind: "none" };
  }
  // Emit in SECTION_KEYS order for a stable, readable list.
  return { kind: "some", sections: SECTION_KEYS.filter((key) => selected.has(key)) };
}

/** Render a Selection as the single token the CLI prints and the job branches on. */
export function renderSelection(selection: Selection): string {
  if (selection.kind === "all") {
    return ALL;
  }
  if (selection.kind === "none") {
    return NONE;
  }
  return selection.sections.join(",");
}

/** The files changed between `baseRef` and HEAD, per `git diff --name-only`. */
export function changedFiles(baseRef: string): string[] {
  const out = execFileSync("git", ["diff", "--name-only", `${baseRef}...HEAD`], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

// CLI: print the selection token for the given base ref (default origin/main).
// Kept side-effect-free on import (the unit test imports the pure functions
// above) by gating on import.meta.main.
if (import.meta.main) {
  const baseRef = process.argv[2] ?? "origin/main";
  const selection = sectionsForFiles(changedFiles(baseRef));
  console.log(renderSelection(selection));
}
