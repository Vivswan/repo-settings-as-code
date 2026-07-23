import { describe, expect, test } from "bun:test";
import { SECTION_KEYS } from "../../src/schema.js";
import { DENIAL_SEMANTICS } from "./denial-semantics.js";
import { mulberry32, Rng } from "./prng.js";
import { parseScenario } from "./schema.js";

describe("prng", () => {
  test("mulberry32 is deterministic for a seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  test("Rng.int(maxExclusive) stays in [0, max) and is deterministic", () => {
    const a = new Rng(1);
    const b = new Rng(1);
    for (let i = 0; i < 100; i++) {
      const x = a.int(7);
      expect(x).toBe(b.int(7));
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(7);
    }
  });

  test("Rng.int rejects a non-positive bound", () => {
    expect(() => new Rng(1).int(0)).toThrow();
  });

  test("Rng.pick throws on an empty array", () => {
    expect(() => new Rng(1).pick([])).toThrow();
  });

  test("Rng.bool honors its probability at the extremes", () => {
    expect(new Rng(1).bool(1)).toBe(true);
    expect(new Rng(1).bool(0)).toBe(false);
  });

  test("fork(label) is stable regardless of parent draws and varies by label", () => {
    const drained = new Rng(7);
    drained.int(10);
    drained.int(10);
    const fresh = new Rng(7);
    expect(drained.fork("labels").int(1_000_000)).toBe(fresh.fork("labels").int(1_000_000));
    expect(new Rng(7).fork("labels").float()).not.toBe(new Rng(7).fork("teams").float());
  });
});

describe("scenario schema", () => {
  test("applies defaults (tiers, denial_style, owner_kind)", () => {
    const s = parseScenario({ name: "d", settings: {}, expect: { exit_code: 0 } }, "d.yml");
    expect(s.tiers).toEqual(["mock"]);
    expect(s.denial_style).toBe("fine_grained");
    expect(s.owner_kind).toBe("org");
  });

  test("passes live_state through (including the labels.generate sugar)", () => {
    const s = parseScenario(
      {
        name: "g",
        settings: {},
        live_state: { labels: { generate: { count: 150, prefix: "gen", color: "ededed" } } },
        expect: { exit_code: 0 },
      },
      "g.yml",
    );
    expect(s.live_state?.labels).toEqual({
      generate: { count: 150, prefix: "gen", color: "ededed" },
    });
  });

  test("token_permissions is a partial mask", () => {
    const s = parseScenario(
      { name: "m", settings: {}, token_permissions: { issues: "read" }, expect: { exit_code: 0 } },
      "m.yml",
    );
    expect(s.token_permissions).toEqual({ issues: "read" });
  });

  test("inputs.required_sections is a comma-separated string", () => {
    const s = parseScenario(
      {
        name: "r",
        settings: {},
        inputs: { mode: "apply", required_sections: "labels,rulesets" },
        expect: { exit_code: 0 },
      },
      "r.yml",
    );
    expect(s.inputs?.required_sections).toBe("labels,rulesets");
  });

  test("rejects an unknown top-level key and names the file", () => {
    expect(() =>
      parseScenario({ name: "x", settings: {}, expect: { exit_code: 0 }, bogus: 1 }, "bad.yml"),
    ).toThrow(/bad\.yml/);
  });

  test("rejects an unsupported denial_style, naming the field", () => {
    expect(() =>
      parseScenario(
        { name: "x", settings: {}, denial_style: 500, expect: { exit_code: 0 } },
        "d.yml",
      ),
    ).toThrow(/denial_style/);
  });

  test("a missing required field is reported against its path", () => {
    // settings is required; the error names it.
    expect(() => parseScenario({ name: "x", expect: { exit_code: 0 } }, "d.yml")).toThrow(
      /settings/,
    );
  });

  test("rejects a repo that sets both `settings` and `settings_raw`", () => {
    // The two are mutually exclusive (both define settings.yml); setting both is
    // a loud failure, not a silent preference.
    expect(() =>
      parseScenario(
        {
          name: "x",
          settings: {},
          expect: { exit_code: 0 },
          repos: {
            "e2e-owner/svc-a": { settings: { labels: [] }, settings_raw: "labels: [oops" },
          },
        },
        "both.yml",
      ),
    ).toThrow(/only one of `settings` or `settings_raw`/);
  });

  test("accepts the numeric denial styles", () => {
    const s = parseScenario(
      { name: "x", settings: {}, denial_style: 403, expect: { exit_code: 0 } },
      "d.yml",
    );
    expect(s.denial_style).toBe(403);
  });
});

describe("denial semantics", () => {
  test("covers every section exactly once", () => {
    expect(Object.keys(DENIAL_SEMANTICS).sort()).toEqual([...SECTION_KEYS].sort() as string[]);
  });

  test("the four absent sections are exactly branches, environments, pages, teams", () => {
    const absent: string[] = SECTION_KEYS.filter((k) => DENIAL_SEMANTICS[k] === "absent");
    expect(absent.sort()).toEqual(["branches", "environments", "pages", "teams"].sort());
  });

  test("every other section is denied", () => {
    const denied: string[] = SECTION_KEYS.filter((k) => DENIAL_SEMANTICS[k] === "denied");
    expect(denied.sort()).toEqual(
      [
        "actions",
        "autolinks",
        "code_scanning_default_setup",
        "collaborators",
        "labels",
        "milestones",
        "repository",
        "rulesets",
        "workflows",
      ].sort(),
    );
  });
});
