/**
 * Unit test for the diff-aware section selector: the shared fan-out derived
 * from the import graph (canaries on the real tree, the scanner, resolver, and
 * graph rules on synthetic trees), that every path on disk resolves through
 * some rule, and the cross-cutting, docs-only, deleted-path, and fail-loud
 * branches - including the tripwire that a flat src/sections/ file outside the
 * named registry files throws instead of silently skipping the smoke job.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ALL_SELECTING_PREFIXES,
  type ChangedFile,
  deriveSharedFanOut,
  parseNameStatus,
  renderSelection,
  resolveImport,
  scanImports,
  sectionsForFiles,
} from "../../.github/scripts/changed-sections.js";
import { SECTION_KEYS, type SectionKey, UNDECLARED_POLICY_SECTIONS } from "../../src/schema.js";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SRC_DIR = join(REPO_ROOT, "src");
const SECTIONS_DIR = join(SRC_DIR, "sections");

/** Diff entries for files that still exist (added or modified). */
function changed(...paths: string[]): ChangedFile[] {
  return paths.map((path) => ({ path, deleted: false }));
}

/** Diff entries for files the diff deletes. */
function removed(...paths: string[]): ChangedFile[] {
  return paths.map((path) => ({ path, deleted: true }));
}

/** Every path under src/sections on disk, repo-relative with forward slashes. */
function sectionsPathsOnDisk(dir = SECTIONS_DIR, prefix = "src/sections"): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...sectionsPathsOnDisk(join(dir, entry.name), path));
    } else if (entry.isFile()) {
      out.push(path);
    }
  }
  return out;
}

/** The given keys in SECTION_KEYS order, which is the order the fan-out emits. */
function inKeyOrder(...keys: SectionKey[]): SectionKey[] {
  const wanted = new Set<SectionKey>(keys);
  return SECTION_KEYS.filter((key) => wanted.has(key));
}

const scratchRoots: string[] = [];
afterAll(() => {
  for (const root of scratchRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A throwaway repo root under os.tmpdir() holding `files` (repo-relative path -> text). */
function syntheticRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "changed-sections-"));
  scratchRoots.push(root);
  mkdirSync(join(root, "src", "sections", "shared"), { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/**
 * Every graph rule in one tree: an intermediate shared file, a shared
 * subdirectory, and importers that must add no key.
 */
const GRAPH_FIXTURE: Record<string, string> = {
  "src/sections/shared/engine.ts": "export const engine = 1;\n",
  "src/sections/shared/factory.ts":
    'import { engine } from "./engine.js";\nexport const factory = engine;\n',
  "src/sections/shared/util/index.ts": "export const util = 1;\n",
  "src/sections/labels/index.ts":
    'import {\n  factory,\n} from "../shared/factory.js";\nexport default factory;\n',
  "src/sections/teams/index.ts": 'export { engine } from "../shared/engine";\n',
  "src/sections/milestones/mock.ts": 'export const util = await import("../shared/util");\n',
  "src/sections/pages/mock.ts": "export const util = await import(`../shared/util`);\n",
  "src/sections/pages/schema.ts":
    'import type { engine } from "../shared/engine.js";\nexport type Engine = typeof engine;\n',
  "src/sections/labels/labels.test.ts": 'import { util } from "../shared/util/index.js";\nutil;\n',
  "src/schema.ts":
    'import { engine } from "./sections/shared/engine.js";\nexport default engine;\n',
  "src/sections/registry.ts": 'import "./labels/index.js";\nimport "./teams/index.js";\n',
};

describe("changed-sections derived fan-out", () => {
  test("the real tree derives exactly the layout's fan-out for every shared file", () => {
    // A canary over the whole map: a new importer, a dropped one, a new or
    // deleted shared file, or a hub edge reopening (a section file importing
    // the registry-backed engine modules) all surface here and force a
    // decision - check the import chain is intended, then update the row.
    expect(deriveSharedFanOut(REPO_ROOT)).toEqual({
      // The permission-vocabulary normalizer for the two membership sections.
      "roles.ts": inKeyOrder("collaborators", "teams"),
      // The sealing engine: the four repository-level secret families through
      // the repo-secrets factory, environments through its nested secrets key.
      "secrets-engine.ts": inKeyOrder(
        "environments",
        "actions_secrets",
        "dependabot_secrets",
        "codespaces_secrets",
        "agents_secrets",
      ),
      "repo-secrets.ts": inKeyOrder(
        "actions_secrets",
        "dependabot_secrets",
        "codespaces_secrets",
        "agents_secrets",
      ),
      // The list-section factory: every list section on it adds itself here.
      "list-section.ts": inKeyOrder("labels", "autolinks", "deploy_keys"),
      // The value-based engine: the two variable families through the
      // repo-variables factory, environments through its nested variables key.
      "variables-engine.ts": inKeyOrder("environments", "actions_variables", "agents_variables"),
      "repo-variables.ts": inKeyOrder("actions_variables", "agents_variables"),
      // The setup factory: the two GET/PATCH setup sections.
      "setup-section.ts": inKeyOrder("code_scanning_default_setup", "code_quality_setup"),
      // knobbed() shapes every knobbed section's wrapper and environments'
      // nested lists. src/schema.ts uses it too, but every section reaches
      // src/schema.ts only through type imports, which are not edges.
      "schema-helpers.ts": inKeyOrder(...UNDECLARED_POLICY_SECTIONS, "environments"),
    });
  });

  test("scanImports finds every runtime import form and nothing that only looks like one", () => {
    const text = [
      'import { a } from "./a.js";',
      "import {",
      "  b,",
      "  c,",
      '} from "../b/c.js";',
      'export { e } from "./e";',
      'export * from "../f/index.js";',
      'const g = await import("./g.js");',
      'import "./side-effect.js";',
      'const r = require("./require.js");',
      'import tsr = require("./ts-require.js");',
      // Bare specifiers are not edges in the src/ graph.
      'import { z } from "zod";',
      'import { readFileSync } from "node:fs";',
      // Type-only imports are erased from the bundle.
      'import type { D } from "./type-only.js";',
      'import { type Only } from "./inline-type-only.js";',
      'export type { T } from "./type-reexport.js";',
      // Lookalikes a regex would take for imports.
      '// import { nope } from "./line-comment.js";',
      '/* export { nope } from "./block-comment.js"; */',
      'const s = "import(\\"./string.js\\")";',
      'const tpl = `import x from "./template.js"`;',
    ].join("\n");
    expect(scanImports(text, "probe.ts")).toEqual([
      "./a.js",
      "../b/c.js",
      "./e",
      "../f/index.js",
      "./g.js",
      "./side-effect.js",
      "./require.js",
      "./ts-require.js",
    ]);
  });

  test("scanImports throws on a computed specifier instead of dropping the edge", () => {
    // Bun's import list silently omits these three; each must name the file
    // and line so the author rewrites it as a literal.
    for (const [line, form] of [
      ["const d = await import(name);", "import(name)"],
      ["const r = require(name);", "require(name)"],
      [`const t = await import(\`./\${name}.js\`);`, "template import"],
    ] as const) {
      expect(
        () => scanImports(`const name = "./dyn.js";\n${line}\n`, "src/sections/labels/index.ts"),
        form,
      ).toThrow(/src\/sections\/labels\/index\.ts:2 loads a module through a computed specifier/);
    }
    // A literal template is a literal: no throw, and it is an edge.
    expect(scanImports("const t = await import(`./lit.js`);\n", "probe.ts")).toEqual(["./lit.js"]);
  });

  test("resolveImport maps .js to .ts, a directory to its index, and .json to itself, and throws on a dangling one", () => {
    const root = syntheticRepo({
      "src/sections/shared/engine.ts": "",
      "src/sections/shared/util/index.ts": "",
      "src/sections/labels/index.ts": "",
      "lib/settings.schema.json": "{}",
    });
    const importer = join(root, "src/sections/labels/index.ts");
    expect(resolveImport(importer, "../shared/engine.js")).toBe(
      join(root, "src/sections/shared/engine.ts"),
    );
    expect(resolveImport(importer, "../shared/engine")).toBe(
      join(root, "src/sections/shared/engine.ts"),
    );
    expect(resolveImport(importer, "../shared/util")).toBe(
      join(root, "src/sections/shared/util/index.ts"),
    );
    expect(resolveImport(importer, "../../../lib/settings.schema.json")).toBe(
      join(root, "lib/settings.schema.json"),
    );
    expect(() => resolveImport(importer, "../shared/missing.js")).toThrow(
      /imports "\.\.\/shared\/missing\.js", which resolves to no file/,
    );
    expect(() => resolveImport(importer, "../../../lib/missing.json")).toThrow(
      /imports "\.\.\/\.\.\/\.\.\/lib\/missing\.json", which resolves to no file/,
    );
  });

  test("the fan-out follows the graph through intermediates and ignores non-section importers", () => {
    const fanOut = deriveSharedFanOut(syntheticRepo(GRAPH_FIXTURE));
    expect(fanOut).toEqual({
      // labels reaches engine through factory; teams imports it directly;
      // src/schema.ts and registry.ts import it too but add no key, and
      // pages' type-only import is no edge at all.
      "engine.ts": inKeyOrder("labels", "teams"),
      "factory.ts": inKeyOrder("labels"),
      // milestones' dynamic import of the directory and pages' template
      // spelling of it; labels' unit test imports it too and is not an edge.
      "util/index.ts": inKeyOrder("pages", "milestones"),
    });
  });

  test("a new import edge widens exactly the shared file it reaches", () => {
    const fanOut = deriveSharedFanOut(
      syntheticRepo({
        ...GRAPH_FIXTURE,
        "src/sections/webhooks/index.ts":
          'import { engine } from "../shared/engine.js";\nexport default engine;\n',
      }),
    );
    expect(fanOut).toEqual({
      "engine.ts": inKeyOrder("labels", "teams", "webhooks"),
      "factory.ts": inKeyOrder("labels"),
      "util/index.ts": inKeyOrder("pages", "milestones"),
    });
  });

  test("a shared file no section imports throws", () => {
    const root = syntheticRepo({
      "src/sections/shared/live.ts": "export const live = 1;\n",
      "src/sections/shared/dead.ts": "export const dead = 1;\n",
      "src/sections/labels/index.ts":
        'import { live } from "../shared/live.js";\nexport default live;\n',
    });
    expect(() => deriveSharedFanOut(root)).toThrow(
      /no section imports src\/sections\/shared\/dead\.ts/,
    );
  });

  test("a dangling relative import anywhere under src throws", () => {
    const root = syntheticRepo({
      "src/sections/shared/engine.ts": "export const engine = 1;\n",
      "src/sections/labels/index.ts":
        'import { gone } from "../shared/gone.js";\nexport default gone;\n',
    });
    expect(() => deriveSharedFanOut(root)).toThrow(/resolves to no file/);
  });

  test("a computed import anywhere under src fails the whole derivation, naming the file", () => {
    // Every form Bun's import list would silently drop; the template edge in
    // GRAPH_FIXTURE (pages/mock.ts) proves a substitution-free template passes.
    for (const load of ["await import(which)", "require(which)", `await import(\`\${which}\`)`]) {
      const root = syntheticRepo({
        ...GRAPH_FIXTURE,
        "src/sections/webhooks/index.ts": `const which = "../shared/engine.js";\nexport const engine = ${load};\n`,
      });
      expect(() => deriveSharedFanOut(root), load).toThrow(
        /src\/sections\/webhooks\/index\.ts:2 loads a module through a computed specifier/,
      );
    }
  });
});

describe("changed-sections file map", () => {
  test("every path on disk under src/sections resolves through some selector rule", () => {
    // sectionsForFiles throws on an unrecognized src/sections/ path, so a
    // stray helper file must either get a rule or move under a recognized
    // directory - resolving every real path proves nothing on disk is in that
    // state.
    for (const path of sectionsPathsOnDisk()) {
      expect(() => sectionsForFiles(changed(path)), `${path} does not resolve`).not.toThrow();
    }
  });

  test("every top-level src entry is either sections/ or all-selecting", () => {
    // A new top-level src module the selector does not know about would make
    // PRs touching only it skip the smoke job; force a prefix entry instead.
    // Only directories and .ts files count: stray artifacts like .DS_Store
    // are not selector inputs.
    for (const entry of readdirSync(SRC_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.name.endsWith(".ts")) {
        continue;
      }
      const path = entry.isDirectory() ? `src/${entry.name}/` : `src/${entry.name}`;
      if (path === "src/sections/") {
        continue;
      }
      expect(
        ALL_SELECTING_PREFIXES.includes(path),
        `${path} is not in ALL_SELECTING_PREFIXES, so the selector would ignore changes to it`,
      ).toBe(true);
    }
  });
});

describe("changed-sections selection", () => {
  test("a docs-only change selects none", () => {
    const selection = sectionsForFiles(
      changed("README.md", "COVERAGE.md", ".github/workflows/ci.yml"),
    );
    expect(selection.kind).toBe("none");
    expect(renderSelection(selection)).toBe("none");
  });

  test("a section directory selects its key for every file under it", () => {
    // The post-migration layout: src/sections/<key>/... spells the key
    // verbatim, and everything under it - module, mock, test, scenario -
    // selects exactly that section. Path-based, so the rule holds before any
    // directory exists on disk.
    expect(renderSelection(sectionsForFiles(changed("src/sections/labels/index.ts")))).toBe(
      "labels",
    );
    expect(renderSelection(sectionsForFiles(changed("src/sections/labels/mock.ts")))).toBe(
      "labels",
    );
    expect(
      renderSelection(
        sectionsForFiles(changed("src/sections/environments/scenarios/environments-apply.yml")),
      ),
    ).toBe("environments");
    expect(
      renderSelection(
        sectionsForFiles(changed("src/sections/secret_scanning_custom_patterns/schema.ts")),
      ),
    ).toBe("secret_scanning_custom_patterns");
  });

  test("shared files fan out to their consumers", () => {
    expect(renderSelection(sectionsForFiles(changed("src/sections/shared/roles.ts")))).toBe(
      "collaborators,teams",
    );
    expect(
      renderSelection(sectionsForFiles(changed("src/sections/shared/secrets-engine.ts"))),
    ).toBe("environments,actions_secrets,dependabot_secrets,codespaces_secrets,agents_secrets");
  });

  test("a deleted shared file adds nothing itself; every other path rule still applies", () => {
    // Its importers had to change in the same diff and select their sections.
    expect(sectionsForFiles(removed("src/sections/shared/roles.ts")).kind).toBe("none");
    expect(
      renderSelection(
        sectionsForFiles([
          ...removed("src/sections/shared/roles.ts"),
          ...changed("src/sections/collaborators/index.ts", "src/sections/teams/index.ts"),
        ]),
      ),
    ).toBe("collaborators,teams");
    // A deleted scenario can leave a route cold, so its section still runs.
    expect(
      renderSelection(sectionsForFiles(removed("src/sections/labels/scenarios/labels-apply.yml"))),
    ).toBe("labels");
    expect(sectionsForFiles(removed("src/sections/registry.ts")).kind).toBe("all");
    expect(() => sectionsForFiles(removed("src/sections/labels.ts"))).toThrow(
      /matches no selector rule/,
    );
  });

  test("a deleted shared file whose importers now resolve to its sibling spelling selects that sibling's sections", () => {
    // foo.ts and foo/index.ts are interchangeable to an importer of "./foo.js",
    // so deleting one leaves the importers unchanged and typecheck green; the
    // sibling's current fan-out is the affected set.
    const fanOut = deriveSharedFanOut(
      syntheticRepo({
        "src/sections/shared/a/index.ts": "export const a = 1;\n",
        "src/sections/shared/b.ts": "export const b = 1;\n",
        "src/sections/labels/index.ts": 'import { a } from "../shared/a.js";\nexport default a;\n',
        "src/sections/teams/index.ts": 'import { b } from "../shared/b.js";\nexport default b;\n',
      }),
    );
    const select = (files: ChangedFile[]) => renderSelection(sectionsForFiles(files, () => fanOut));
    expect(select(removed("src/sections/shared/a.ts"))).toBe("labels");
    expect(select(removed("src/sections/shared/b/index.ts"))).toBe("teams");
    expect(select(removed("src/sections/shared/c.ts"))).toBe("none");
    // Only .ts files are selector inputs, deleted or not: a stray file under
    // shared/ never gets the sibling rule, so "a.js" cannot borrow a/index.ts.
    expect(() => select(removed("src/sections/shared/a.js"))).toThrow(/matches no selector rule/);
    expect(() => select(removed("src/sections/shared/notes.md"))).toThrow(
      /matches no selector rule/,
    );
  });

  test("parseNameStatus reads NUL-delimited records raw and throws on any other shape", () => {
    // -z keeps a path with a tab, a quote, and a backslash verbatim (git would
    // C-quote it otherwise, and the src/sections/ prefix would go unmatched).
    const odd = 'src/sections/labels/scenarios/tab\there "quoted" back\\slash.yml';
    expect(
      parseNameStatus(
        `A\0src/sections/labels/index.ts\0M\0README.md\0D\0src/sections/shared/roles.ts\0T\0lib/settings.schema.json\0M\0${odd}\0`,
      ),
    ).toEqual([
      ...changed("src/sections/labels/index.ts", "README.md"),
      ...removed("src/sections/shared/roles.ts"),
      ...changed("lib/settings.schema.json", odd),
    ]);
    // Every status --no-renames can emit is a record; only D means deleted.
    expect(parseNameStatus("A\0a\0D\0d\0M\0m\0T\0t\0U\0u\0X\0x\0B\0b\0")).toEqual([
      ...changed("a"),
      ...removed("d"),
      ...changed("m", "t", "u", "x", "b"),
    ]);
    expect(parseNameStatus("")).toEqual([]);
    // Letters git does not emit here: a rename score (--no-renames was lost;
    // its two paths misalign the fields) and a letter git never uses.
    expect(() => parseNameStatus("R100\0old.ts\0new.ts\0")).toThrow(/unparseable/);
    expect(() => parseNameStatus("R\0old.ts\0")).toThrow(/unparseable/);
    expect(() => parseNameStatus("Q\0q.ts\0")).toThrow(/unparseable/);
    expect(() => parseNameStatus("M\0")).toThrow(/unparseable/);
    expect(() => parseNameStatus("src/sections/labels/index.ts\0")).toThrow(/unparseable/);
    // A cut-off stream (no terminator on the last field) is not a record.
    expect(() => parseNameStatus("M\0README.md")).toThrow(/not NUL-terminated/);
  });

  test("an unrecognized src/sections path throws instead of silently selecting nothing", () => {
    expect(() => sectionsForFiles(changed("src/sections/stray-helper.ts"))).toThrow(
      /matches no selector rule/,
    );
    expect(() => sectionsForFiles(changed("src/sections/not_a_key/index.ts"))).toThrow(
      /matches no selector rule/,
    );
    expect(() => sectionsForFiles(changed("src/sections/shared/unmapped.ts"))).toThrow(
      /matches no selector rule/,
    );
  });

  test("a flat src/sections file besides the registry files throws", () => {
    // Sections are directories; registry.ts and docs-registry.ts are the only
    // flat files the layout allows. A diff naming any other flat path
    // (whatever its history) must fail loudly, never resolve quietly.
    for (const stale of [
      "src/sections/labels.ts",
      "src/sections/deploy-keys.ts",
      "src/sections/code-scanning.ts",
      "src/sections/roles.ts",
      "src/sections/secrets-engine.ts",
      "src/sections/contract.ts",
    ]) {
      expect(() => sectionsForFiles(changed(stale)), `${stale} must throw`).toThrow(
        /matches no selector rule/,
      );
    }
    // A cross-cutting path in the same diff must not mask the stale path:
    // the selector resolves every src/sections/ path before answering "all".
    expect(() => sectionsForFiles(changed("src/schema.ts", "src/sections/labels.ts"))).toThrow(
      /matches no selector rule/,
    );
  });

  test("multiple section directories union in SECTION_KEYS order", () => {
    const selection = sectionsForFiles(
      changed("src/sections/milestones/index.ts", "src/sections/labels/index.ts"),
    );
    // labels precedes milestones in SECTION_KEYS, so the list is ordered.
    expect(renderSelection(selection)).toBe("labels,milestones");
  });

  test("registry.ts selects all", () => {
    expect(sectionsForFiles(changed("src/sections/registry.ts"))).toEqual({ kind: "all" });
    expect(renderSelection(sectionsForFiles(changed("src/sections/registry.ts")))).toBe("all");
  });

  test("the shared docs prose selects none, like the docs registry", () => {
    const prose = "src/sections/shared/shared.docs.yml";
    expect(sectionsForFiles(changed(prose)).kind).toBe("none");
    expect(renderSelection(sectionsForFiles(changed(prose, "src/sections/labels/index.ts")))).toBe(
      "labels",
    );
    expect(() => sectionsForFiles(changed("src/sections/shared/notes.yml"))).toThrow(
      /matches no selector rule/,
    );
  });

  test("docs-registry.ts selects none and never masks or widens the rest of the diff", () => {
    // The docs-only aggregator is never in the bundle; build:check gates docs
    // drift, so it behaves like lib/: no section on its own, transparent
    // beside a section or a cross-cutting change.
    expect(sectionsForFiles(changed("src/sections/docs-registry.ts")).kind).toBe("none");
    expect(
      renderSelection(
        sectionsForFiles(changed("src/sections/docs-registry.ts", "src/sections/labels/index.ts")),
      ),
    ).toBe("labels");
    expect(sectionsForFiles(changed("src/sections/docs-registry.ts", "src/schema.ts")).kind).toBe(
      "all",
    );
  });

  test("core paths select all", () => {
    for (const file of [
      "src/engine/orchestrate.ts",
      "src/github/api.ts",
      "src/action/inputs.ts",
      "src/discovery/discover.ts",
      "src/report/issue-report.ts",
      "src/io.ts",
      "src/main.ts",
      "src/schema.ts",
      "test/e2e/runner.ts",
      // The selection machinery itself, the repo-owned checks workflow, and
      // the local composite actions it runs: a PR touching only one of them
      // must not skip the smoke job.
      ".github/scripts/changed-sections.ts",
      ".github/workflows/checks.yml",
      ".github/actions/fetch-test-artifacts/action.yml",
      // src/sections/contract/ holds the cross-cutting contract modules (the
      // barrel split); a contract-module-only PR must select every section.
      "src/sections/contract/requests.ts",
    ]) {
      expect(sectionsForFiles(changed(file)), `${file} should select all`).toEqual({
        kind: "all",
      });
    }
  });

  test("a section change plus a regenerated schema scopes to the section, not all", () => {
    // lib/settings.schema.json regenerates alongside schema-affecting src
    // changes; the lib file must not force "all" or diff-awareness is dead.
    const selection = sectionsForFiles(
      changed("src/sections/labels/index.ts", "lib/settings.schema.json"),
    );
    expect(renderSelection(selection)).toBe("labels");
  });

  test("a lib-only diff selects none (the schema-check job gates schema drift)", () => {
    // The only committed file under lib/ is the generated schema, which
    // carries no runnable code; the smoke job has nothing to exercise.
    expect(sectionsForFiles(changed("lib/settings.schema.json")).kind).toBe("none");
  });

  test("lib alongside a docs-only change selects none", () => {
    expect(sectionsForFiles(changed("README.md", "lib/settings.schema.json")).kind).toBe("none");
  });

  test("a core-path change wins over a section change", () => {
    // Any all-selecting path forces all, regardless of other changed files.
    const selection = sectionsForFiles(
      changed("src/sections/labels/index.ts", "src/engine/diff.ts"),
    );
    expect(selection.kind).toBe("all");
  });
});
