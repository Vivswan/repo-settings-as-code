/**
 * Diff-aware section selector for the PR e2e smoke job. Given the files a PR
 * changed, decide which settings sections the smoke job must exercise, so a PR
 * touching one section runs that section's scenarios and fuzz rather than the
 * whole corpus, and a docs-only PR skips the smoke job entirely.
 *
 * The rules follow the per-section layout: a src/sections/<key>/... directory
 * (the key spelled verbatim) selects that key for every file under it,
 * src/sections/shared/ code fans out to the sections that transitively import
 * it (derived from the src/ import graph, see deriveSharedFanOut), and the
 * cross-cutting files (the contract modules, the registry, the engine, the
 * schema, the e2e harness) select every section. A path under src/sections/
 * that none of the rules recognize throws, so a new file cannot silently skip
 * the smoke job - src/sections/ holds only the flat files named below, the
 * per-section directories, contract/, and shared/, and a file anywhere else
 * must gain a rule before it can land.
 *
 * Usage (CI): `bun .github/scripts/changed-sections.ts [base-ref]` prints one
 * of: a comma-separated section list, the literal `all`, or the literal
 * `none`. The base ref defaults to `origin/main`. The smoke job runs when the
 * output is not `none`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { type Node, parseSync } from "oxc-parser";
import { SECTION_KEYS, type SectionKey } from "../../src/schema.js";

/** The sentinel the CLI prints (and the job branches on) when every section is in play. */
export const ALL = "all";
/** The sentinel printed when nothing settings-related changed. */
export const NONE = "none";

/** This script lives at .github/scripts/, two levels below the repository root. */
const REPO_ROOT = join(import.meta.dir, "..", "..");

/**
 * Flat src/sections/ files and what they select. registry.ts wires every
 * handler together, so it selects EVERY section. A flat docs-only aggregator
 * that never reaches the bundle selects NONE: docs drift is gated by
 * build:check, the same reasoning that keeps lib/ out of
 * ALL_SELECTING_PREFIXES. The contract's modules live under
 * src/sections/contract/, an ALL_SELECTING_PREFIXES entry.
 */
const ALL_SELECTING_SECTION_FILES = new Set(["registry.ts"]);
const NONE_SELECTING_SECTION_FILES = new Set(["docs-registry.ts"]);

/** The section keys, as a Set of plain strings for path-segment lookups. */
const SECTION_KEY_SET: ReadonlySet<string> = new Set(SECTION_KEYS);

/**
 * Path prefixes/files that select every section: the shared engine, transport,
 * action layer, discovery, reporting, the io seam, the entrypoint and schema,
 * and the e2e harness itself (a harness change can change every scenario).
 * `lib/` is deliberately NOT here: the only committed file under it is the
 * generated settings.schema.json, which carries no runnable code and mirrors
 * a `src/schema.ts` change when one exists; the schema-check job gates schema
 * drift on its own. A unit test checks every top-level `src/` entry other
 * than `sections/` is listed, so a new top-level module cannot be silently
 * skipped.
 */
export const ALL_SELECTING_PREFIXES = [
  // The contract's layered modules: every section is written against them,
  // so a change there selects everything.
  "src/sections/contract/",
  "src/engine/",
  "src/github/",
  "src/action/",
  "src/discovery/",
  "src/report/",
  // Cross-cutting: gap files define supplemental route typing across sections.
  "src/upstream-gaps/",
  "src/io.ts",
  "src/main.ts",
  "src/plain-data.ts",
  "src/private-open.ts",
  "src/private.ts",
  "src/schema.ts",
  "src/types.ts",
  "test/e2e/",
  // The selection machinery itself (this selector, sibling CI scripts, the smoke
  // job's workflow, the local composite actions it runs): a PR touching only these
  // must not select "none" and skip the very job they configure.
  ".github/scripts/",
  ".github/workflows/checks.yml",
  ".github/actions/",
];

/** The decision for one changed-file set: every section, some, or none. */
export type Selection =
  | { kind: "all" }
  | { kind: "some"; sections: SectionKey[] }
  | { kind: "none" };

/** One path from the diff. A deleted file has no code left to smoke. */
export interface ChangedFile {
  path: string;
  deleted: boolean;
}

/** bun's own TypeScript parser, so comments, strings, and templates never read as imports. */
const TRANSPILER = new Bun.Transpiler({ loader: "ts" });

/** A specifier the graph can read: a string literal, or a template with nothing to substitute. */
function isLiteralSpecifier(node: Node | undefined): boolean {
  return (
    (node?.type === "Literal" && typeof node.value === "string") ||
    (node?.type === "TemplateLiteral" && node.expressions.length === 0)
  );
}

/** Whether `node` is an `import(x)` or `require(x)` whose x is not a literal. */
function isComputedModuleLoad(node: Node): boolean {
  if (node.type === "ImportExpression") {
    return !isLiteralSpecifier(node.source);
  }
  return (
    node.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === "require" &&
    !isLiteralSpecifier(node.arguments[0])
  );
}

/** Every AST node under `value`, in source order. */
function* nodesOf(value: unknown): Generator<Node> {
  if (Array.isArray(value)) {
    for (const item of value) {
      yield* nodesOf(item);
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  if ("type" in value && typeof value.type === "string") {
    yield value as Node;
  }
  for (const child of Object.values(value)) {
    yield* nodesOf(child);
  }
}

/**
 * Throw if `text` loads a module through a specifier the graph cannot read.
 * A missing edge means a shared change could under-select - the one failure
 * this selector exists to prevent - so the file must be rewritten, not skipped.
 */
function assertNoComputedImports(text: string, file: string): void {
  // A second parser beside Bun.Transpiler: Bun's import list silently omits a
  // computed import()/require(), so oxc walks the AST only to find those.
  const { program, errors } = parseSync(file, text);
  const lineOf = (offset: number): number => text.slice(0, offset).split("\n").length;
  const [error] = errors;
  if (error) {
    throw new Error(
      `changed-sections: ${file}:${lineOf(error.labels[0]?.start ?? 0)} does not parse: ${error.message}`,
    );
  }
  for (const node of nodesOf(program)) {
    if (isComputedModuleLoad(node)) {
      throw new Error(
        `changed-sections: ${file}:${lineOf(node.start)} loads a module through a computed specifier, which the import graph cannot follow - use a string literal`,
      );
    }
  }
}

/**
 * The relative specifiers `file` loads at runtime. Type-only imports are not
 * edges (erased from the bundle) and neither are bare specifiers; a
 * computed specifier throws rather than dropping an edge.
 */
export function scanImports(text: string, file: string): string[] {
  assertNoComputedImports(text, file);
  return TRANSPILER.scanImports(text)
    .map((entry) => entry.path)
    .filter((specifier) => specifier.startsWith("./") || specifier.startsWith("../"));
}

/**
 * Resolve a relative specifier against its importer to the source on disk: `.js` maps to
 * `<spec>.ts` then `<spec>/index.ts` (source spells the emitted extension); `.json` is data
 * and resolves to itself. Nothing found throws: a dangling edge would silently drop an edge.
 */
export function resolveImport(importer: string, specifier: string): string {
  const target = resolve(dirname(importer), specifier);
  const candidates = specifier.endsWith(".json")
    ? [target]
    : [`${target.replace(/\.[jt]s$/, "")}.ts`, join(target.replace(/\.[jt]s$/, ""), "index.ts")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `changed-sections: ${importer} imports "${specifier}", which resolves to no file (tried ${candidates.join(" and ")})`,
  );
}

/**
 * Every non-test .ts file under `root`, as absolute paths. Unit tests are not
 * smoke inputs (`bun test` runs them all on every PR), and the section tests
 * that import the engine would otherwise pull the registry - and through it
 * every section - into every shared file's fan-out.
 */
export function sourceFilesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
    .map((entry) => join(root, entry));
}

/** The reverse import graph over `files`: each file -> the files that import it. */
export function reverseImportGraph(files: readonly string[]): Map<string, Set<string>> {
  const importedBy = new Map<string, Set<string>>();
  for (const file of files) {
    for (const specifier of scanImports(readFileSync(file, "utf8"), file)) {
      const target = resolveImport(file, specifier);
      const importers = importedBy.get(target) ?? new Set<string>();
      importers.add(file);
      importedBy.set(target, importers);
    }
  }
  return importedBy;
}

/** Every file that imports `file`, directly or through intermediate files. */
export function transitiveDependents(
  importedBy: ReadonlyMap<string, ReadonlySet<string>>,
  file: string,
): Set<string> {
  const seen = new Set<string>();
  const pending = [file];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const importer of importedBy.get(next) ?? []) {
      if (!seen.has(importer)) {
        seen.add(importer);
        pending.push(importer);
      }
    }
  }
  return seen;
}

/**
 * src/sections/shared/<path> -> the section keys it fans out to, derived from
 * the import graph over src/**: a shared file selects every section whose
 * directory holds a transitive dependent. Dependents outside a section
 * directory (src/schema.ts, the contract, the flat registry files) add no
 * key - when they change they are in the diff as ALL_SELECTING_PREFIXES
 * entries themselves. A shared file with no section dependent throws: it is
 * either dead code to delete or a scan gap to fix, and neither may quietly
 * select nothing.
 */
export function deriveSharedFanOut(repoRoot: string): Record<string, SectionKey[]> {
  const sectionsDir = join(repoRoot, "src", "sections");
  const sharedDir = join(sectionsDir, "shared");
  const importedBy = reverseImportGraph(sourceFilesUnder(join(repoRoot, "src")));
  const fanOut: Record<string, SectionKey[]> = {};
  for (const shared of sourceFilesUnder(sharedDir)) {
    const keys = new Set<string>();
    for (const dependent of transitiveDependents(importedBy, shared)) {
      const [dir] = relative(sectionsDir, dependent).split("/");
      if (dir !== undefined && SECTION_KEY_SET.has(dir)) {
        keys.add(dir);
      }
    }
    const sharedPath = relative(sharedDir, shared);
    if (keys.size === 0) {
      throw new Error(
        `changed-sections: no section imports src/sections/shared/${sharedPath}, so no smoke selection covers it - delete the dead file, or fix the import scan if a section does import it`,
      );
    }
    fanOut[sharedPath] = SECTION_KEYS.filter((key) => keys.has(key));
  }
  return fanOut;
}

/** src/sections/shared/<path> -> the section keys it fans out to. */
export type SharedFanOut = Record<string, SectionKey[]>;

let realFanOut: SharedFanOut | undefined;

/** The real tree's fan-out, derived once per process on the first shared/ path. */
function realSharedFanOut(): SharedFanOut {
  realFanOut ??= deriveSharedFanOut(REPO_ROOT);
  return realFanOut;
}

/**
 * The other file the resolver accepts for the same specifier: `foo.ts` and
 * `foo/index.ts` are interchangeable to every importer of `./foo.js`.
 */
function siblingResolution(sharedPath: string): string {
  return sharedPath.endsWith("/index.ts")
    ? `${sharedPath.slice(0, -"/index.ts".length)}.ts`
    : `${sharedPath.slice(0, -".ts".length)}/index.ts`;
}

/**
 * Resolve one src/sections/ path (below the ALL_SELECTING_PREFIXES check, so
 * src/sections/contract/ never reaches here) to the sections it selects:
 * - src/sections/<key>/... (the section key spelled verbatim) selects <key>,
 *   whatever the file under it is - module, mock, schema, test, or scenario;
 * - src/sections/shared/<file> fans out through the derived import graph;
 * - the flat files select all (registry.ts) or none (docs-registry.ts).
 * Anything else throws: a silently ignored section path would let a PR skip
 * the very scenarios its change needs, so an unrecognized file must either
 * get a rule or move under a recognized directory.
 */
function sectionsForSectionsPath(
  { path, deleted }: ChangedFile,
  sharedFanOut: () => SharedFanOut,
): SectionKey[] | "all" {
  const rest = path.slice("src/sections/".length);
  const slash = rest.indexOf("/");
  if (slash < 0) {
    if (ALL_SELECTING_SECTION_FILES.has(rest)) {
      return "all";
    }
    if (NONE_SELECTING_SECTION_FILES.has(rest)) {
      return [];
    }
    throw new Error(
      `changed-sections: ${path} matches no selector rule; src/sections/ holds only the flat ` +
        `files in ALL_SELECTING_SECTION_FILES and NONE_SELECTING_SECTION_FILES, the per-section ` +
        `<key>/ directories, contract/, and shared/ - move the file under its section directory`,
    );
  }
  const dir = rest.slice(0, slash);
  if (SECTION_KEY_SET.has(dir)) {
    return [dir as SectionKey];
  }
  if (dir === "shared") {
    const sharedPath = rest.slice(slash + 1);
    if (sharedPath.endsWith(".docs.yml")) {
      // The factories' schema prose: never in the bundle, gated by build:check
      // like the docs registry, so it selects nothing on its own.
      return [];
    }
    if (deleted && sharedPath.endsWith(".ts")) {
      // Nothing of its own left to smoke. Its importers either changed in the
      // same diff (typecheck fails otherwise) and select their sections, or
      // now resolve to the sibling spelling, whose fan-out is then theirs.
      return sharedFanOut()[siblingResolution(sharedPath)] ?? [];
    }
    const keys = sharedFanOut()[sharedPath];
    if (keys) {
      return keys;
    }
    throw new Error(
      `changed-sections: ${path} matches no selector rule; under src/sections/shared/ only .ts files (fanning out through the import graph) and the .docs.yml prose are recognized`,
    );
  }
  throw new Error(
    `changed-sections: ${path} matches no selector rule; a section directory must spell its SectionKey verbatim (or add the directory to ALL_SELECTING_PREFIXES if it is cross-cutting)`,
  );
}

/**
 * Map the diff's changed files (repo-relative, forward slashes) to the
 * sections the smoke job must run. Any cross-cutting path forces "all", but
 * every src/sections/ path is still resolved through sectionsForSectionsPath,
 * which throws on an unrecognized one - a stale flat path cannot ride along
 * unnoticed behind a cross-cutting change. Files that touch nothing
 * settings-related are ignored, so a purely docs/config PR yields "none".
 * `lib/` contributes no section either - the only committed file under it is
 * the generated settings.schema.json, which the schema-check job gates on its
 * own - so a lib-only diff selects "none". `sharedFanOut` is the derived
 * map to consult, the real tree's unless a test hands in a synthetic one.
 */
export function sectionsForFiles(
  files: readonly ChangedFile[],
  sharedFanOut: () => SharedFanOut = realSharedFanOut,
): Selection {
  const selected = new Set<SectionKey>();
  // No early return on an all-selecting path: every src/sections/ path is
  // still resolved (and can throw), so an unrecognized or stale flat path
  // fails loudly even when a cross-cutting file in the same diff already
  // forces "all".
  let all = false;
  for (const file of files) {
    if (ALL_SELECTING_PREFIXES.some((prefix) => file.path.startsWith(prefix))) {
      all = true;
      continue;
    }
    if (!file.path.startsWith("src/sections/")) {
      // Everything else (README, COVERAGE, lib/, workflows, package.json,
      // tests outside e2e) contributes no section.
      continue;
    }
    if (sectionsForSectionsPath(file, sharedFanOut) === "all") {
      all = true;
    }
  }
  if (all) {
    return { kind: "all" };
  }
  for (const file of files) {
    if (!file.path.startsWith("src/sections/")) {
      continue;
    }
    const keys = sectionsForSectionsPath(file, sharedFanOut);
    if (keys !== "all") {
      for (const key of keys) {
        selected.add(key);
      }
    }
  }
  if (selected.size === 0) {
    return { kind: "none" };
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

/**
 * Exactly the statuses `git diff --name-status --no-renames` can emit:
 * added, deleted, modified, type-changed, unmerged, unknown, broken pairing.
 * Anything else (a scored R/C, or a letter git does not use) is a shape we
 * do not understand.
 */
const GIT_STATUS = /^[ADMTUXB]$/;

/**
 * Parse `git diff --name-status --no-renames -z` output: alternating
 * NUL-terminated `<status>` and `<path>` fields. `-z` keeps paths raw (git
 * would otherwise C-quote unicode, tabs, and newlines, hiding a
 * src/sections/ prefix), and `--no-renames` keeps every record single-path
 * (a rename is a D plus an A). Output that is not empty and not
 * NUL-terminated, a field where a status should be that is not one, or a
 * dangling status with no path, means a shape we do not understand and
 * throws rather than being skipped.
 */
export function parseNameStatus(out: string): ChangedFile[] {
  if (out !== "" && !out.endsWith("\0")) {
    throw new Error(
      `changed-sections: git name-status output is not NUL-terminated: ${JSON.stringify(out.slice(-40))}`,
    );
  }
  const fields = out.split("\0");
  fields.pop();
  const files: ChangedFile[] = [];
  for (let i = 0; i < fields.length; i += 2) {
    const status = fields[i] ?? "";
    const path = fields[i + 1];
    if (!GIT_STATUS.test(status) || path === undefined || path === "") {
      throw new Error(
        `changed-sections: unparseable git name-status record ${JSON.stringify(fields.slice(i, i + 2))}`,
      );
    }
    files.push({ path, deleted: status === "D" });
  }
  return files;
}

/** The files changed between `baseRef` and HEAD, with whether each was deleted. */
export function changedFiles(baseRef: string): ChangedFile[] {
  return parseNameStatus(
    execFileSync("git", ["diff", "--name-status", "--no-renames", "-z", `${baseRef}...HEAD`], {
      encoding: "utf8",
    }),
  );
}

// CLI: print the selection token for the given base ref (default origin/main).
// Kept side-effect-free on import (the unit test imports the pure functions
// above) by gating on import.meta.main.
if (import.meta.main) {
  const baseRef = process.argv[2] ?? "origin/main";
  const selection = sectionsForFiles(changedFiles(baseRef));
  console.log(renderSelection(selection));
}
