import { describe, expect, test } from "bun:test";
import { validateSettingsDoc } from "../../src/engine/orchestrate.js";
import type { Io } from "../../src/io.js";
import { SECTION_KEYS, type SectionKey } from "../../src/schema.js";
import { sectionShape } from "../../src/sections/registry.js";
import {
  ARTIFACT_TEST_RECIPIENT,
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
const silentIo: Io = { annotate() {}, log() {}, mask() {} };

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

  test("the redaction flag follows the mechanical rule per target", () => {
    // redacted iff policy=redact AND slug != selfSlug AND (private/internal OR
    // probe-denied). Re-derive it independently from the recorded facts and
    // require it matches what the generator stamped on each target.
    let sawRedacted = false;
    let sawShown = false;
    for (let i = 0; i < 200; i++) {
      const { scenario, meta } = genMultiScenario(new Rng(i));
      const redact = meta.privateRepos === "redact";
      if (redact) {
        sawRedacted = true;
      } else {
        sawShown = true;
      }
      for (const repo of meta.repos) {
        const expected =
          redact &&
          repo.slug !== meta.selfSlug &&
          (repo.visibility !== "public" || repo.probeDenied);
        expect(repo.redacted).toBe(expected);
      }
      // The action input echoes the policy the meta records.
      expect(scenario.inputs?.private_repos).toBe(meta.privateRepos);
    }
    // Both policies are exercised across the seed range.
    expect(sawRedacted).toBe(true);
    expect(sawShown).toBe(true);
  });

  test("private_report is only a delivering channel under redact, and the input echoes the meta", () => {
    // The config rejects a delivering channel (issue or artifact) + private-repos:
    // show, so the generator picks them only under redact. The artifact channel
    // also forwards a valid report-public-key; the other channels forward none.
    // Every channel is exercised across the seed range.
    let sawIssue = false;
    let sawArtifact = false;
    let sawNone = false;
    for (let i = 0; i < 300; i++) {
      const { scenario, meta } = genMultiScenario(new Rng(i));
      if (meta.privateReport === "issue") {
        sawIssue = true;
        expect(meta.privateRepos).toBe("redact");
        expect(scenario.inputs?.private_report).toBe("issue");
        // The issue channel needs no age recipient.
        expect(scenario.inputs?.report_public_key).toBeUndefined();
      } else if (meta.privateReport === "artifact") {
        sawArtifact = true;
        expect(meta.privateRepos).toBe("redact");
        expect(scenario.inputs?.private_report).toBe("artifact");
        // The artifact channel MUST carry a valid recipient, or the config rejects
        // the run before it starts (a vacuous fuzz iteration).
        expect(scenario.inputs?.report_public_key).toBe(ARTIFACT_TEST_RECIPIENT);
      } else {
        sawNone = true;
        // `none` is the default, so the input is left unset - and no key either.
        expect(scenario.inputs?.private_report).toBeUndefined();
        expect(scenario.inputs?.report_public_key).toBeUndefined();
      }
    }
    expect(sawIssue).toBe(true);
    expect(sawArtifact).toBe(true);
    expect(sawNone).toBe(true);
  });

  test("a redact run always has at least one redacted target (non-vacuous leak check)", () => {
    // The generator forces one non-missing target private under redact, so the
    // forbidden set is never empty and the leak invariant is never vacuous.
    for (let i = 0; i < 300; i++) {
      const { meta } = genMultiScenario(new Rng(i));
      if (meta.privateRepos !== "redact") {
        continue;
      }
      expect(meta.repos.some((r) => r.redacted)).toBe(true);
    }
  });

  test("the forced-private target is fully granted so its canary provably flows", () => {
    // Under apply + fail a single denied section read preflight-aborts the whole
    // target and renders nothing, so the forced-private leak target clears its
    // mask (every resource back to the write default). This guarantees the canary
    // label's name reaches the detail output the counterfactual relies on. Other
    // private targets keep random masks, so at LEAST one redacted target must be
    // fully granted (the forced one).
    for (let i = 0; i < 300; i++) {
      const { scenario, meta } = genMultiScenario(new Rng(i));
      if (meta.privateRepos !== "redact") {
        continue;
      }
      const fullyGrantedRedacted = meta.repos.some((r) => {
        if (!r.redacted || r.canaries.length === 0) {
          return false;
        }
        const spec = scenario.repos?.[r.slug] as { permissions?: Record<string, string> };
        return Object.keys(spec.permissions ?? {}).length === 0;
      });
      expect(fullyGrantedRedacted).toBe(true);
    }
  });

  test("redacted targets carry unique canaries planted into their settings and live state", () => {
    let sawCanary = false;
    for (let i = 0; i < 200; i++) {
      const { scenario, meta } = genMultiScenario(new Rng(i));
      for (const repo of meta.repos) {
        if (!repo.redacted) {
          // A shown target plants no canaries.
          expect(repo.canaries).toEqual([]);
          continue;
        }
        if (repo.canaries.length === 0) {
          // A redacted missing-settings target has no surfaces to plant into.
          expect(repo.meta).toBeNull();
          continue;
        }
        sawCanary = true;
        const spec = scenario.repos?.[repo.slug] as {
          settings: Record<string, unknown> | null;
          live_state?: {
            labels?: Array<{ name?: string; description?: string }>;
            repo?: { description?: string };
          };
        };
        const nameCanary = repo.canaries.find((c) => c.endsWith("-name"));
        const declaredDescCanary = repo.canaries.find((c) => c.endsWith("-declared"));
        const liveDescCanary = repo.canaries.find((c) => c.endsWith("-live"));
        const repoCanary = repo.canaries.find((c) => c.endsWith("-repo"));
        // The canary label is declared and mirrored in live by NAME, but with a
        // DIFFERENT description, so it drifts (check) / updates (apply) - the name
        // and description flow into the detail a suppression regression would leak.
        const declared = spec.settings?.labels as
          | Array<{ name?: string; description?: string }>
          | undefined;
        const declaredCanary = declared?.find((l) => l.name === nameCanary);
        const liveCanary = spec.live_state?.labels?.find((l) => l.name === nameCanary);
        expect(declaredCanary?.description).toBe(declaredDescCanary);
        expect(liveCanary?.description).toBe(liveDescCanary);
        expect(declaredDescCanary).not.toBe(liveDescCanary); // guarantees drift
        expect(spec.live_state?.repo?.description).toBe(repoCanary);
        // The labels section must be predicted so the oracle expects the canary.
        expect(repo.meta?.sections).toContain("labels");
      }
    }
    expect(sawCanary).toBe(true);
  });
});
