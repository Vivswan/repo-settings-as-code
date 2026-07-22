import { describe, expect, test } from "bun:test";
import { validateSettingsDoc } from "../../src/engine/orchestrate.js";
import type { Io } from "../../src/io.js";
import { SECTION_KEYS, type SectionKey } from "../../src/schema.js";
import { sectionShape } from "../../src/sections/registry.js";
import {
  genLiveState,
  genMultiScenario,
  genScenario,
  genSettings,
  type LiveStateKind,
  validateAgainstPublishedSchema,
} from "./generators.js";
import { Rng } from "./prng.js";
import { parseScenario } from "./schema.js";

/** A no-op Io so validateSettingsDoc can run without @actions/core. */
const silentIo: Io = { annotate() {}, log() {} };

describe("three-way drift detection", () => {
  test("every generated section doc passes schema, validateSettingsDoc, and its zod shape", () => {
    for (const key of SECTION_KEYS) {
      const shape = sectionShape(key);
      for (let i = 0; i < 200; i++) {
        const value = genSettings(new Rng(i * 7 + key.length), key);
        const doc = { [key]: value };
        // 1. Published JSON schema (ajv).
        expect(() => validateAgainstPublishedSchema(doc)).not.toThrow();
        // 2. The action's own doc validator (unknown-key check + more).
        expect(validateSettingsDoc(doc, "fuzz", new Set<string>(), silentIo)).toBeNull();
        // 3. The section's zod shape parses the raw value.
        expect(shape.safeParse(value).success).toBe(true);
      }
    }
  });

  test("validateAgainstPublishedSchema rejects a section with the wrong type", () => {
    // The published schema is permissive about unknown top-level keys (the
    // action rejects those at runtime), but it enforces each section's type.
    expect(() => validateAgainstPublishedSchema({ labels: "not-an-array" })).toThrow();
  });
});

describe("generator couplings and pools", () => {
  test("actions keeps selected_actions coupled to allowed_actions selected", () => {
    for (let i = 0; i < 200; i++) {
      const actions = genSettings(new Rng(i), "actions") as Record<string, unknown>;
      if (actions.selected_actions !== undefined) {
        expect(actions.allowed_actions).toBe("selected");
      }
    }
  });

  test("branches protection payloads only use the four core keys", () => {
    const core = new Set([
      "required_status_checks",
      "enforce_admins",
      "required_pull_request_reviews",
      "restrictions",
    ]);
    for (let i = 0; i < 200; i++) {
      const branches = genSettings(new Rng(i), "branches") as Array<{
        protection: Record<string, unknown> | null;
      }>;
      for (const branch of branches) {
        if (branch.protection) {
          for (const key of Object.keys(branch.protection)) {
            expect(core.has(key)).toBe(true);
          }
        }
      }
    }
  });

  test("milestones due_on, when present, is a fixed ISO date (deterministic)", () => {
    const pool = new Set(["2026-01-15T00:00:00Z", "2026-06-30T00:00:00Z", "2026-12-31T00:00:00Z"]);
    for (let i = 0; i < 200; i++) {
      const milestones = genSettings(new Rng(i), "milestones") as Array<{ due_on?: string }>;
      for (const m of milestones) {
        if (m.due_on !== undefined) {
          expect(pool.has(m.due_on)).toBe(true);
        }
      }
    }
  });

  test("labels never collide on name identities", () => {
    for (let i = 0; i < 200; i++) {
      const labels = genSettings(new Rng(i), "labels") as Array<{ name: string }>;
      const names = labels.map((l) => l.name.toLowerCase());
      expect(new Set(names).size).toBe(names.length);
    }
  });

  test("hostile names surface across seeds", () => {
    let hostile = 0;
    for (let i = 0; i < 100; i++) {
      const json = JSON.stringify(genSettings(new Rng(i), "labels"));
      if (/pipe|quote|percent|space|unicode|éñ|slash|hash/.test(json)) {
        hostile++;
      }
    }
    expect(hostile).toBeGreaterThan(0);
  });

  test("genLiveState produces all three kinds over seeds", () => {
    const kinds = new Set<LiveStateKind>();
    for (let i = 0; i < 100; i++) {
      const settings = genSettings(new Rng(i), "labels");
      kinds.add(genLiveState(new Rng(i + 1000), "labels", settings).kind);
    }
    expect([...kinds].sort()).toEqual(["absent", "divergent", "matching"]);
  });
});

describe("genScenario", () => {
  const KNOWN_MASK_KEYS = new Set([
    "administration",
    "issues",
    "environments",
    "actions",
    "pages",
    "code_scanning_alerts",
    "contents",
    "org_members",
  ]);

  test("is deterministic for a seed (byte-equal JSON)", () => {
    expect(JSON.stringify(genScenario(new Rng(42)))).toBe(JSON.stringify(genScenario(new Rng(42))));
  });

  test("produces internally consistent, schema-valid scenarios with sound meta", () => {
    for (let i = 0; i < 200; i++) {
      const { scenario, meta } = genScenario(new Rng(i));
      expect(() => validateAgainstPublishedSchema(scenario.settings)).not.toThrow();
      const declared = new Set(Object.keys(scenario.settings) as SectionKey[]);
      for (const section of meta.requiredSections) {
        expect(declared.has(section)).toBe(true);
      }
      for (const key of Object.keys(meta.mask)) {
        expect(KNOWN_MASK_KEYS.has(key)).toBe(true);
      }
      expect([...meta.sections].sort()).toEqual([...declared].sort());
      expect(meta.sections.length).toBeGreaterThan(0);
      expect([403, "fine_grained"]).toContain(meta.denialStyle);
    }
  });

  test("honors the sections option", () => {
    for (let i = 0; i < 30; i++) {
      const { scenario, meta } = genScenario(new Rng(i), { sections: ["labels"] });
      expect(Object.keys(scenario.settings)).toEqual(["labels"]);
      expect(meta.sections).toEqual(["labels"]);
    }
  });

  test("declared branches and workflows are present in live_state so they converge", () => {
    // branches (protection PUT) and workflows (enable/disable) can configure but
    // not create their resource; a declared name absent from live_state would
    // permanently drift with a skip note. Every declared branch name / workflow
    // path must appear in the seeded live_state.
    for (let i = 0; i < 200; i++) {
      const { scenario } = genScenario(new Rng(i));
      const branches = scenario.settings.branches as Array<{ name: string }> | undefined;
      if (branches) {
        const live = new Set((scenario.live_state?.branches as string[] | undefined) ?? []);
        for (const b of branches) {
          expect(live.has(b.name)).toBe(true);
        }
      }
      const workflows = scenario.settings.workflows as Array<{ path: string }> | undefined;
      if (workflows) {
        const livePaths = new Set(
          ((scenario.live_state?.workflows as Array<{ path: string }> | undefined) ?? []).map(
            (w) => w.path,
          ),
        );
        for (const w of workflows) {
          expect(livePaths.has(w.path)).toBe(true);
        }
      }
    }
  });
});

describe("genMultiScenario", () => {
  test("builds 2 to 5 valid targets with exactly one skipped", () => {
    for (let i = 0; i < 100; i++) {
      const { scenario, meta } = genMultiScenario(new Rng(i));
      expect(() => parseScenario(scenario, `m-${i}`)).not.toThrow();
      expect(meta.repos.length).toBeGreaterThanOrEqual(2);
      expect(meta.repos.length).toBeLessThanOrEqual(5);
      const skipped = meta.repos.filter((r) => r.meta === null);
      expect(skipped.length).toBe(1);
    }
  });

  test("is deterministic for a seed", () => {
    expect(JSON.stringify(genMultiScenario(new Rng(9)).scenario)).toBe(
      JSON.stringify(genMultiScenario(new Rng(9)).scenario),
    );
  });

  test("defaults file declares milestones; a target sometimes nulls it (the opt-out)", () => {
    // The null-section opt-out lives on a TARGET (nulling a section the defaults
    // declare), never in the defaults file itself - a defaults file with a null
    // section fails the action's schema validation. So the defaults file always
    // declares milestones as a real array, and some targets set milestones: null.
    let targetOptOut = 0;
    for (let i = 0; i < 100; i++) {
      const { scenario } = genMultiScenario(new Rng(i));
      expect(Array.isArray(scenario.defaults_file?.milestones)).toBe(true);
      for (const spec of Object.values(scenario.repos ?? {})) {
        const settings = (spec as { settings: Record<string, unknown> | null }).settings;
        if (settings && settings.milestones === null) {
          targetOptOut++;
        }
      }
    }
    expect(targetOptOut).toBeGreaterThan(0);
  });
});
