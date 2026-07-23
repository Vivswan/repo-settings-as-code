import { describe, expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";
import { validateSettingsDoc } from "../../src/engine/orchestrate.js";
import type { Io } from "../../src/io.js";
import { SECTION_KEYS, type SectionKey } from "../../src/schema.js";
import { sectionShape } from "../../src/sections/registry.js";
import {
  ARTIFACT_TEST_RECIPIENT,
  genInvalidSettings,
  genLiveWitness,
  genMultiScenario,
  genScenario,
  genSettings,
  INVALID_SETTINGS_CASES,
  type LiveWitnessKind,
  NON_MAPPING_YAML,
  UNPARSEABLE_YAML,
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
});

describe("genLiveWitness", () => {
  type Label = { name: string; color?: string; description?: string | null; new_name?: string };
  type Milestone = { title: string; description?: string | null; state?: string; due_on?: string };

  test("matching labels mirror every field the labels handler diffs", () => {
    for (let i = 0; i < 200; i++) {
      const declared = genSettings(new Rng(i), "labels") as Label[];
      const witness = genLiveWitness(new Rng(i + 500), "labels", declared, "matching");
      expect(witness.kind).toBe("matching");
      const live = witness.state.labels as Label[];
      expect(live.length).toBe(declared.length);
      declared.forEach((label, j) => {
        // The name is compared verbatim (a case change would be rename drift);
        // color and description are diffed only when declared, so declared
        // values must be mirrored verbatim.
        expect(live[j]?.name).toBe(label.new_name ?? label.name);
        if (label.color !== undefined) {
          expect(live[j]?.color).toBe(label.color);
        }
        if (label.description !== undefined) {
          expect(live[j]?.description).toBe(label.description);
        }
      });
    }
  });

  test("witnesses seed the FINAL post-rename state for new_name labels", () => {
    // The handler resolves new_name to a final name and treats any other live
    // name as rename drift, so a matching witness must seed the label AT the
    // final name - seeding the source name would make the oracle predict clean
    // while the engine PATCHes a rename.
    const declared: Label[] = [
      { name: "bug", new_name: "defect", color: "d73a4a", description: "broken" },
      { name: "keep", description: "kept" },
    ];
    const matching = genLiveWitness(new Rng(1), "labels", declared, "matching");
    const matchingLive = matching.state.labels as Label[];
    expect(matchingLive[0]?.name).toBe("defect");
    expect(matchingLive[0]?.color).toBe("d73a4a");
    expect(matchingLive[0]?.description).toBe("broken");
    expect(matchingLive[1]?.name).toBe("keep");
    // drift-update diverges in exactly one field measured against the
    // POST-rename state; the name candidate flips the final name's case.
    for (let i = 0; i < 50; i++) {
      const drift = genLiveWitness(new Rng(i), "labels", declared, "drift-update");
      expect(drift.kind).toBe("drift-update");
      const live = drift.state.labels as Label[];
      let diverged = 0;
      for (const [j, label] of declared.entries()) {
        const entry = live[j] as Label;
        const finalName = label.new_name ?? label.name;
        if (entry.name !== finalName) {
          expect(entry.name.toLowerCase()).toBe(finalName.toLowerCase());
          diverged++;
        }
        if (label.color !== undefined && entry.color !== label.color) {
          diverged++;
        }
        if (label.description !== undefined && entry.description !== label.description) {
          diverged++;
        }
      }
      expect(diverged).toBe(1);
    }
    // extra-undeclared keeps the matching (post-rename) base under the extra.
    const extra = genLiveWitness(new Rng(2), "labels", declared, "extra-undeclared");
    expect((extra.state.labels as Label[])[0]?.name).toBe("defect");
  });

  test("matching witnesses mirror passthrough fields verbatim", () => {
    // Both handlers diff passthrough fields (labels via the extra-keys
    // subsetDiff, milestones via the whole-declaration subsetDiff), so a
    // witness built from a hardcoded field list would silently read as drift.
    const labels = [{ name: "a", tone: "warm" }];
    const labelWitness = genLiveWitness(new Rng(1), "labels", labels, "matching");
    expect((labelWitness.state.labels as Array<{ tone?: string }>)[0]?.tone).toBe("warm");
    const milestones = [{ title: "v1", due_on: "2026-01-15T00:00:00Z", closed_issues: 0 }];
    const milestoneWitness = genLiveWitness(new Rng(1), "milestones", milestones, "matching");
    const liveMilestone = (milestoneWitness.state.milestones as Array<Record<string, unknown>>)[0];
    expect(liveMilestone?.due_on).toBe("2026-01-15T00:00:00Z");
    expect(liveMilestone?.closed_issues).toBe(0);
  });

  test("labels drift-update perturbs exactly one declared field (or the name's case)", () => {
    for (let i = 0; i < 200; i++) {
      const declared = genSettings(new Rng(i), "labels") as Label[];
      const witness = genLiveWitness(new Rng(i + 500), "labels", declared, "drift-update");
      expect(witness.kind).toBe("drift-update");
      const live = witness.state.labels as Label[];
      expect(live.length).toBe(declared.length);
      let drifted = 0;
      declared.forEach((label, j) => {
        const entry = live[j] as Label;
        const renamed = entry.name !== label.name;
        if (renamed) {
          // The flipped name must keep its case-insensitive key, so the handler
          // still matches the label and reads the divergence as rename drift.
          expect(entry.name.toLowerCase()).toBe(label.name.toLowerCase());
        }
        const colorDrift = label.color !== undefined && entry.color !== label.color;
        const descriptionDrift =
          label.description !== undefined && entry.description !== label.description;
        if (renamed || colorDrift || descriptionDrift) {
          drifted++;
        }
      });
      expect(drifted).toBe(1);
    }
  });

  test("labels extra-undeclared adds exactly one undeclared label over a matching base", () => {
    for (let i = 0; i < 200; i++) {
      const declared = genSettings(new Rng(i), "labels") as Label[];
      const witness = genLiveWitness(new Rng(i + 500), "labels", declared, "extra-undeclared");
      expect(witness.kind).toBe("extra-undeclared");
      const live = witness.state.labels as Label[];
      expect(live.length).toBe(declared.length + 1);
      const extra = live[live.length - 1] as Label;
      // The extra label matches no declared identity (case-insensitively), so
      // the handler must classify it as undeclared: delete in apply, drift in
      // check.
      expect(declared.some((l) => l.name.toLowerCase() === extra.name.toLowerCase())).toBe(false);
    }
  });

  test("matching milestones mirror every declared field, due_on included", () => {
    for (let i = 0; i < 200; i++) {
      const declared = genSettings(new Rng(i), "milestones") as Milestone[];
      const witness = genLiveWitness(new Rng(i + 500), "milestones", declared, "matching");
      expect(witness.kind).toBe("matching");
      const live = witness.state.milestones as Milestone[];
      expect(live.length).toBe(declared.length);
      declared.forEach((milestone, j) => {
        const entry = live[j] as Milestone;
        expect(entry.title).toBe(milestone.title);
        // subsetDiff compares every DECLARED field verbatim; due_on omitted
        // from a "matching" witness would read as drift.
        if (milestone.state !== undefined) {
          expect(entry.state).toBe(milestone.state);
        }
        if (milestone.description !== undefined) {
          expect(entry.description).toBe(milestone.description);
        }
        if (milestone.due_on !== undefined) {
          expect(entry.due_on).toBe(milestone.due_on);
        }
      });
    }
  });

  test("milestones drift-update perturbs one declared field, or degrades to matching", () => {
    let drifts = 0;
    for (let i = 0; i < 200; i++) {
      const declared = genSettings(new Rng(i), "milestones") as Milestone[];
      const witness = genLiveWitness(new Rng(i + 500), "milestones", declared, "drift-update");
      const live = witness.state.milestones as Milestone[];
      expect(live.length).toBe(declared.length);
      let diverged = 0;
      declared.forEach((milestone, j) => {
        const entry = live[j] as Milestone;
        expect(entry.title).toBe(milestone.title);
        for (const field of ["description", "state", "due_on"] as const) {
          if (milestone[field] !== undefined && entry[field] !== milestone[field]) {
            diverged++;
          }
        }
      });
      if (witness.kind === "drift-update") {
        expect(diverged).toBe(1);
        drifts++;
      } else {
        // The fallback: no milestone declares a perturbable field, so nothing
        // can legitimately diverge and the witness says "matching".
        expect(witness.kind).toBe("matching");
        expect(diverged).toBe(0);
      }
    }
    expect(drifts).toBeGreaterThan(0);
  });

  test("milestones reject the labels-only extra-undeclared kind", () => {
    expect(() =>
      genLiveWitness(new Rng(1), "milestones", [{ title: "v1" }], "extra-undeclared"),
    ).toThrow();
  });

  test("witness sentinels stay disjoint from the generator pools", () => {
    for (let i = 0; i < 300; i++) {
      const labels = genSettings(new Rng(i), "labels") as Label[];
      for (const label of labels) {
        expect(label.color).not.toBe("123456");
        expect(label.description).not.toBe("witness-drift");
        expect(label.name.toLowerCase()).not.toBe("zz-undeclared-witness");
        expect((label.new_name ?? label.name).toLowerCase()).not.toBe("zz-undeclared-witness");
      }
      const milestones = genSettings(new Rng(i), "milestones") as Milestone[];
      for (const milestone of milestones) {
        expect(milestone.description).not.toBe("witness-drift");
      }
    }
  });

  test("a sentinel collision fails loudly instead of degrading the witness", () => {
    // "77" has no letters, so it is not case-flippable and the perturbation
    // picker has exactly one candidate - the collision is guaranteed to fire.
    expect(() =>
      genLiveWitness(new Rng(1), "labels", [{ name: "77", color: "123456" }], "drift-update"),
    ).toThrow(/sentinel/);
    expect(() =>
      genLiveWitness(
        new Rng(1),
        "labels",
        [{ name: "77", description: "witness-drift" }],
        "drift-update",
      ),
    ).toThrow(/sentinel/);
    expect(() =>
      genLiveWitness(new Rng(1), "labels", [{ name: "zz-undeclared-witness" }], "extra-undeclared"),
    ).toThrow(/sentinel/);
    expect(() =>
      genLiveWitness(
        new Rng(1),
        "milestones",
        [{ title: "v1", description: "witness-drift" }],
        "drift-update",
      ),
    ).toThrow(/sentinel/);
  });
});

describe("genInvalidSettings", () => {
  test("every catalog case is rejected and the error names its token", () => {
    for (const { name, build } of INVALID_SETTINGS_CASES) {
      for (let i = 0; i < 25; i++) {
        const { doc, offendingToken } = build(new Rng(i * 13 + 1));
        const error = validateSettingsDoc(doc, "settings.yml", new Set(), silentIo);
        if (error === null) {
          throw new Error(`case "${name}" produced a doc the validator accepts`);
        }
        if (!error.includes(offendingToken)) {
          throw new Error(`case "${name}" token "${offendingToken}" missing from error: ${error}`);
        }
      }
    }
  });

  test("is deterministic for a seed", () => {
    expect(JSON.stringify(genInvalidSettings(new Rng(5)))).toBe(
      JSON.stringify(genInvalidSettings(new Rng(5))),
    );
  });

  test("draws every catalog case over seeds", () => {
    const drawn = new Set<string>();
    for (let i = 0; i < 400; i++) {
      drawn.add(genInvalidSettings(new Rng(i)).name);
    }
    const catalog = INVALID_SETTINGS_CASES.map((c) => c.name);
    // Two-way: no duplicate case names, and the drawn set equals the catalog
    // exactly (an unexpected or never-drawn name both fail).
    expect(new Set(catalog).size).toBe(catalog.length);
    expect([...drawn].sort()).toEqual([...catalog].sort());
  });

  test("the raw pools fail the way their names promise", () => {
    for (const raw of UNPARSEABLE_YAML) {
      expect(() => parseYaml(raw)).toThrow();
    }
    for (const raw of NON_MAPPING_YAML) {
      const parsed: unknown = parseYaml(raw);
      const isMapping = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
      expect(isMapping).toBe(false);
    }
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
      const declared = new Set(Object.keys(scenario.settings ?? {}) as SectionKey[]);
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
      expect(Object.keys(scenario.settings ?? {})).toEqual(["labels"]);
      expect(meta.sections).toEqual(["labels"]);
    }
  });

  test("liveKinds records the seeded witness per section, and every kind surfaces", () => {
    const seen: Record<LiveWitnessKind, number> = {
      matching: 0,
      "drift-update": 0,
      "extra-undeclared": 0,
    };
    for (let i = 0; i < 300; i++) {
      const { scenario, meta } = genScenario(new Rng(i));
      for (const key of ["labels", "milestones"] as const) {
        const kind = meta.liveKinds?.[key];
        if (kind === undefined) {
          // No witness: the family keeps absent live state (the create path).
          expect(scenario.live_state?.[key]).toBeUndefined();
          continue;
        }
        seen[kind]++;
        // A recorded witness implies the section is declared and its live
        // state family is seeded.
        expect(meta.sections).toContain(key);
        expect(Array.isArray(scenario.live_state?.[key])).toBe(true);
      }
    }
    expect(seen.matching).toBeGreaterThan(0);
    expect(seen["drift-update"]).toBeGreaterThan(0);
    expect(seen["extra-undeclared"]).toBeGreaterThan(0);
  });

  test("declared branches and workflows are present in live_state so they converge", () => {
    // branches (protection PUT) and workflows (enable/disable) can configure but
    // not create their resource; a declared name absent from live_state would
    // permanently drift with a skip note. Every declared branch name / workflow
    // path must appear in the seeded live_state.
    for (let i = 0; i < 200; i++) {
      const { scenario } = genScenario(new Rng(i));
      const branches = scenario.settings?.branches as Array<{ name: string }> | undefined;
      if (branches) {
        const live = new Set((scenario.live_state?.branches as string[] | undefined) ?? []);
        for (const b of branches) {
          expect(live.has(b.name)).toBe(true);
        }
      }
      const workflows = scenario.settings?.workflows as Array<{ path: string }> | undefined;
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
      // Exactly one missing-settings target per scenario (a raw-invalid one
      // is a separate kind and may or may not exist).
      const skipped = meta.repos.filter((r) => r.target.kind === "missing");
      expect(skipped.length).toBe(1);
    }
  });

  test("a raw-settings target serves settings_raw, opts out of nothing, and plants no canaries", () => {
    let sawUnparseable = 0;
    let sawNonMapping = 0;
    for (let i = 0; i < 400; i++) {
      const { scenario, meta } = genMultiScenario(new Rng(i));
      for (const repo of meta.repos) {
        if (repo.target.kind !== "raw-invalid") {
          continue;
        }
        if (repo.target.raw === "unparseable") {
          sawUnparseable++;
        } else {
          sawNonMapping++;
        }
        const spec = scenario.repos?.[repo.slug] as {
          settings?: unknown;
          settings_raw?: string;
        };
        expect(typeof spec.settings_raw).toBe("string");
        expect(spec.settings).toBeUndefined();
        // The raw pool entry matches its kind: unparseable bodies throw in
        // the yaml parser, non-mapping ones parse to a non-mapping.
        if (repo.target.raw === "unparseable") {
          expect(() => parseYaml(spec.settings_raw as string)).toThrow();
        } else {
          const parsed: unknown = parseYaml(spec.settings_raw as string);
          expect(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)).toBe(
            false,
          );
        }
        // Never the milestones opt-out target (there is no mapping to null a
        // section in) and never the guaranteed leak-canary target.
        expect(meta.milestonesOptOutSlug).not.toBe(repo.slug);
        expect(repo.canaries).toEqual([]);
      }
    }
    expect(sawUnparseable).toBeGreaterThan(0);
    expect(sawNonMapping).toBeGreaterThan(0);
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
          // Only a normal target has surfaces to plant into: a redacted
          // missing-settings or raw-invalid target legitimately has none.
          expect(repo.target.kind).not.toBe("normal");
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
        expect(repo.target.kind).toBe("normal");
        if (repo.target.kind === "normal") {
          expect(repo.target.meta.sections).toContain("labels");
        }
      }
    }
    expect(sawCanary).toBe(true);
  });
});
