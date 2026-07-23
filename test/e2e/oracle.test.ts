import { describe, expect, test } from "bun:test";
import type { MultiRepoTarget, MultiScenarioMeta, ScenarioMeta } from "./generators.js";
import {
  predictDiscovery,
  predictMulti,
  predictOutcomes,
  predictSection,
  sectionGrade,
} from "./oracle.js";
import type { MaskGrade, MaskKey } from "./schema.js";

/** Build a ScenarioMeta with sensible defaults for one focused assertion. */
function meta(overrides: Partial<ScenarioMeta>): ScenarioMeta {
  return {
    sections: overrides.sections ?? ["labels"],
    mask: overrides.mask ?? {},
    mode: overrides.mode ?? "apply",
    policy: overrides.policy ?? "fail",
    ownerKind: overrides.ownerKind ?? "org",
    denialStyle: overrides.denialStyle ?? "fine_grained",
    requiredSections: overrides.requiredSections ?? [],
    onlySections: overrides.onlySections,
    liveKinds: overrides.liveKinds,
  };
}

describe("sectionGrade", () => {
  const cases: Array<[string, MaskKey, MaskGrade | undefined, MaskGrade]> = [
    ["unspecified resource defaults to write", "issues", undefined, "write"],
    ["explicit none", "issues", "none", "none"],
    ["explicit read", "issues", "read", "read"],
  ];
  for (const [name, key, grade, want] of cases) {
    test(`labels: ${name}`, () => {
      const mask = grade === undefined ? {} : { [key]: grade };
      expect(sectionGrade("labels", mask)).toBe(want);
    });
  }

  test("repository takes the max over its (single) repo resource", () => {
    expect(sectionGrade("repository", { administration: "read" })).toBe("read");
    expect(sectionGrade("repository", { administration: "none" })).toBe("none");
  });

  test("code_scanning is granted when EITHER admin or code_scanning_alerts is", () => {
    // repo resources are OR: the max grade wins.
    expect(sectionGrade("code_scanning_default_setup", { administration: "none" })).toBe("write");
    expect(
      sectionGrade("code_scanning_default_setup", {
        administration: "none",
        code_scanning_alerts: "none",
      }),
    ).toBe("none");
    expect(
      sectionGrade("code_scanning_default_setup", {
        administration: "none",
        code_scanning_alerts: "read",
      }),
    ).toBe("read");
  });

  test("teams: org_members is a read-gate, not a grade cap", () => {
    // org_members none denies the section (the org probe fails); read or write
    // both leave the repo (administration) grade intact - org_members write is
    // NOT required to write teams.
    expect(sectionGrade("teams", { administration: "write", org_members: "none" })).toBe("none");
    expect(sectionGrade("teams", { administration: "write", org_members: "read" })).toBe("write");
    expect(sectionGrade("teams", { administration: "read", org_members: "write" })).toBe("read");
    expect(sectionGrade("teams", { administration: "write", org_members: "write" })).toBe("write");
  });

  test("teams: the org gate reads org_members from orgMask, not the per-slug mask", () => {
    // Multi-repo regression (nightly seed 28401742): the mock grades teams'
    // org-scoped grant endpoint against the GLOBAL mask, so a per-slug
    // org_members:none must NOT gate teams when the global mask grants it. With
    // an empty orgMask (org_members defaults to write) teams stays write-graded
    // even though the per-slug mask says org_members:none.
    expect(sectionGrade("teams", { administration: "write", org_members: "none" }, {})).toBe(
      "write",
    );
    // And the orgMask's org_members:none DOES gate it (single-repo path: orgMask
    // === mask), matching the read-gate rule above.
    expect(sectionGrade("teams", { administration: "write" }, { org_members: "none" })).toBe(
      "none",
    );
  });
});

describe("predictSection rules", () => {
  test("write granted: check => {clean, drift}", () => {
    const p = predictSection("labels", meta({ mode: "check", mask: { issues: "write" } }));
    expect([...p.allowed].sort()).toEqual(["clean", "drift"]);
  });

  test("write granted: apply => {applied}", () => {
    const p = predictSection("labels", meta({ mode: "apply", mask: { issues: "write" } }));
    expect([...p.allowed]).toEqual(["applied"]);
    expect(p.mayWrite).toBe(true);
  });

  test("none + 403 style: skipped under warn, failed under fail", () => {
    const denied = { mask: { issues: "none" as MaskGrade }, denialStyle: 403 as const };
    expect([
      ...predictSection("labels", meta({ ...denied, mode: "apply", policy: "warn" })).allowed,
    ]).toEqual(["skipped"]);
    expect([
      ...predictSection("labels", meta({ ...denied, mode: "apply", policy: "fail" })).allowed,
    ]).toEqual(["failed"]);
  });

  test("none + fine_grained on a denied-semantics section behaves like 403", () => {
    // labels is "denied" semantics, so a fine_grained 404 read classifies as denial.
    const p = predictSection(
      "labels",
      meta({
        mask: { issues: "none" },
        denialStyle: "fine_grained",
        mode: "apply",
        policy: "warn",
      }),
    );
    expect([...p.allowed]).toEqual(["skipped"]);
  });

  test("none + fine_grained on an absent-semantics section: check => {clean, drift}", () => {
    // pages is "absent" semantics: the 404 read looks like a missing resource.
    const p = predictSection(
      "pages",
      meta({
        sections: ["pages"],
        mask: { pages: "none" },
        denialStyle: "fine_grained",
        mode: "check",
      }),
    );
    expect([...p.allowed].sort()).toEqual(["clean", "drift"]);
  });

  test("none + fine_grained absent-semantics apply: {applied, failed} fail, {applied, skipped} warn", () => {
    const base = {
      sections: ["pages"] as ScenarioMeta["sections"],
      mask: { pages: "none" as MaskGrade },
      denialStyle: "fine_grained" as const,
      mode: "apply" as const,
    };
    expect([...predictSection("pages", meta({ ...base, policy: "fail" })).allowed].sort()).toEqual([
      "applied",
      "failed",
    ]);
    expect([...predictSection("pages", meta({ ...base, policy: "warn" })).allowed].sort()).toEqual([
      "applied",
      "skipped",
    ]);
  });

  test("read grade apply: {applied, failed} fail, {applied, skipped} warn", () => {
    const base = { mask: { issues: "read" as MaskGrade }, mode: "apply" as const };
    expect([...predictSection("labels", meta({ ...base, policy: "fail" })).allowed].sort()).toEqual(
      ["applied", "failed"],
    );
    expect([...predictSection("labels", meta({ ...base, policy: "warn" })).allowed].sort()).toEqual(
      ["applied", "skipped"],
    );
  });

  test("a required denied section fails even under warn (apply)", () => {
    const p = predictSection(
      "labels",
      meta({
        mask: { issues: "read" },
        mode: "apply",
        policy: "warn",
        requiredSections: ["labels"],
      }),
    );
    expect([...p.allowed].sort()).toEqual(["applied", "failed"]);
  });

  test("a matching witness pins check to exactly clean and apply to exactly applied", () => {
    const check = predictSection(
      "labels",
      meta({ mode: "check", liveKinds: { labels: "matching" } }),
    );
    expect([...check.allowed]).toEqual(["clean"]);
    const apply = predictSection(
      "labels",
      meta({ mode: "apply", liveKinds: { labels: "matching" } }),
    );
    expect([...apply.allowed]).toEqual(["applied"]);
    // No write is attempted against a matching live state.
    expect(apply.mayWrite).toBe(false);
  });

  test("a drift witness pins check to exactly drift (a clean is a false negative)", () => {
    for (const kind of ["drift-update", "extra-undeclared"] as const) {
      const p = predictSection("labels", meta({ mode: "check", liveKinds: { labels: kind } }));
      expect([...p.allowed]).toEqual(["drift"]);
    }
  });

  test("permission folding beats the witness: a denied section stays skipped", () => {
    // labels is denied outright (issues none + 403 style); the matching witness
    // must NOT tighten the outcome to clean - the section never ran.
    const p = predictSection(
      "labels",
      meta({
        mask: { issues: "none" },
        denialStyle: 403,
        mode: "check",
        policy: "warn",
        liveKinds: { labels: "matching" },
      }),
    );
    expect([...p.allowed]).toEqual(["skipped"]);
  });

  test("read grade + drift witness in apply: the forced write is denied", () => {
    // The witness guarantees a write is needed, so the loose {applied, ...}
    // tightens: the section can never be a no-op applied.
    const base = {
      mask: { issues: "read" as MaskGrade },
      mode: "apply" as const,
      liveKinds: { labels: "drift-update" as const },
    };
    expect([...predictSection("labels", meta({ ...base, policy: "warn" })).allowed]).toEqual([
      "skipped",
    ]);
    expect([...predictSection("labels", meta({ ...base, policy: "fail" })).allowed]).toEqual([
      "failed",
    ]);
  });

  test("read grade + matching witness in apply: applied despite the missing write grant", () => {
    const p = predictSection(
      "labels",
      meta({ mask: { issues: "read" }, mode: "apply", liveKinds: { labels: "matching" } }),
    );
    expect([...p.allowed]).toEqual(["applied"]);
    expect(p.mayWrite).toBe(false);
  });

  test("exclusion folds before grades and witnesses", () => {
    // A declared section outside the `sections` allowlist never runs: the
    // engine reports it "excluded" before any read, so neither the denied
    // grade nor the seeded witness may tighten the prediction.
    const p = predictSection(
      "labels",
      meta({
        sections: ["labels", "pages"],
        onlySections: ["pages"],
        mask: { issues: "none" },
        denialStyle: 403,
        mode: "check",
        liveKinds: { labels: "drift-update" },
      }),
    );
    expect([...p.allowed]).toEqual(["excluded"]);
    expect(p.mayWrite).toBe(false);
    // An undefined allowlist keeps today's behavior: every section runs.
    const unrestricted = predictSection("labels", meta({ mode: "check" }));
    expect(unrestricted.allowed.has("excluded")).toBe(false);
  });

  test("an excluded denied section never arms the preflight barrier", () => {
    // Preflight probes only ACTIVE sections, so a permission-denied section
    // that the allowlist excludes cannot abort the run.
    const p = predictOutcomes(
      meta({
        sections: ["labels"],
        onlySections: ["pages"],
        mask: { issues: "none" },
        denialStyle: 403,
        mode: "apply",
        policy: "fail",
      }),
    );
    expect(p.preflightAborts).toBe(false);
    expect([...p.allowedExitCodes]).toEqual([0]);
  });

  test("an EMPTY allowlist is unrestricted, mirroring the engine's size > 0 gate", () => {
    // inputs.ts builds onlySections from a comma-split with filter(Boolean),
    // and orchestrate.ts only excludes when the set is non-empty - so `[]`
    // must predict exactly like an undefined allowlist: the denied section
    // stays active and arms the preflight barrier.
    const p = predictOutcomes(
      meta({
        sections: ["labels"],
        onlySections: [],
        mask: { issues: "none" },
        denialStyle: 403,
        mode: "apply",
        policy: "fail",
      }),
    );
    expect(p.preflightAborts).toBe(true);
  });

  test("teams + owner_kind user no-ops: applied in apply, clean in check", () => {
    const applyP = predictSection(
      "teams",
      meta({
        sections: ["teams"],
        ownerKind: "user",
        mask: { administration: "none" },
        mode: "apply",
      }),
    );
    expect([...applyP.allowed]).toEqual(["applied"]);
    expect(applyP.mayWrite).toBe(false);

    const checkP = predictSection(
      "teams",
      meta({
        sections: ["teams"],
        ownerKind: "user",
        mask: { administration: "none" },
        mode: "check",
      }),
    );
    expect([...checkP.allowed]).toEqual(["clean"]);
    expect(checkP.mayWrite).toBe(false);
  });
});

describe("predictOutcomes run level", () => {
  test("fully granted apply predicts exit 0 and flags convergence", () => {
    const p = predictOutcomes(meta({ sections: ["labels", "pages"], mode: "apply", mask: {} }));
    expect(p.allowedExitCodes.has(0)).toBe(true);
    expect(p.fullyGranted).toBe(true);
    expect(p.noWritesInCheck).toBe(false);
  });

  test("check mode never writes", () => {
    const p = predictOutcomes(meta({ mode: "check", mask: {} }));
    expect(p.noWritesInCheck).toBe(true);
  });

  test("a denied required section under apply+fail forces exit 1", () => {
    const p = predictOutcomes(
      meta({
        sections: ["labels"],
        mask: { issues: "none" },
        denialStyle: 403,
        mode: "apply",
        policy: "fail",
        requiredSections: ["labels"],
      }),
    );
    expect([...p.allowedExitCodes]).toEqual([1]);
  });

  test("check mode with a write-granted section may exit 0 or 1 (clean vs drift)", () => {
    const p = predictOutcomes(meta({ mode: "check", mask: { issues: "write" } }));
    expect([...p.allowedExitCodes].sort()).toEqual([0, 1]);
  });

  test("apply + fail + a permission-denied section aborts at preflight", () => {
    // The barrier only runs under apply + fail; a denied section makes it abort
    // before rendering any section, so preflightAborts is set.
    const p = predictOutcomes(
      meta({ sections: ["labels"], mask: { issues: "none" }, mode: "apply", policy: "fail" }),
    );
    expect(p.preflightAborts).toBe(true);
  });

  test("preflightAborts is false under warn, under check, and when fully granted", () => {
    const warn = predictOutcomes(
      meta({ sections: ["labels"], mask: { issues: "none" }, mode: "apply", policy: "warn" }),
    );
    expect(warn.preflightAborts).toBe(false);
    const check = predictOutcomes(
      meta({ sections: ["labels"], mask: { issues: "none" }, mode: "check", policy: "fail" }),
    );
    expect(check.preflightAborts).toBe(false);
    const granted = predictOutcomes(
      meta({ sections: ["labels"], mask: {}, mode: "apply", policy: "fail" }),
    );
    expect(granted.preflightAborts).toBe(false);
  });

  test("a read grade never aborts preflight: preflight is reads-only", () => {
    // Preflight runs every handler in check mode behind the write-stopping
    // probe wrapper, so a read-graded section passes it; the write denial
    // happens later, during apply, after the summary rows exist.
    const p = predictOutcomes(
      meta({ sections: ["labels"], mask: { issues: "read" }, mode: "apply", policy: "fail" }),
    );
    expect(p.preflightAborts).toBe(false);
  });

  test("a fine_grained absent-tolerant denial does not abort preflight", () => {
    // branches is "absent" semantics: a fine_grained 404 reads as resource
    // absent, not a permission denial, so the barrier does not fire.
    const p = predictOutcomes(
      meta({
        sections: ["branches"],
        mask: { administration: "none", contents: "none" },
        denialStyle: "fine_grained",
        mode: "apply",
        policy: "fail",
      }),
    );
    expect(p.preflightAborts).toBe(false);
  });
});

describe("predictMulti rollup", () => {
  // Explicit target builders: the tests state the target kind directly instead
  // of inferring "missing" from a null, matching the discriminated union.
  const normal = (m: ScenarioMeta): MultiRepoTarget => ({ kind: "normal", meta: m });
  const missing = (): MultiRepoTarget => ({ kind: "missing" });
  function multiMeta(targets: MultiRepoTarget[]): MultiScenarioMeta {
    return {
      repos: targets.map((target, i) => ({
        slug: `e2e-owner/repo-${i}`,
        target,
        visibility: "public" as const,
        probeDenied: false,
        redacted: false,
        displayKey: `e2e-owner/repo-${i}`,
        canaries: [],
      })),
      mode: "apply",
      policy: "fail",
      privateRepos: "show",
      privateReport: "none",
      selfSlug: "e2e-owner/e2e-repo",
    };
  }

  test("a missing-settings target is skipped (null run)", () => {
    const p = predictMulti(multiMeta([missing()]));
    expect(p.repos[0]?.run).toBeNull();
    expect([...(p.repos[0]?.allowedResults ?? [])]).toEqual(["skipped"]);
  });

  test("a raw-settings target predicts exactly failed and raises exit 1", () => {
    // Both raw kinds fail before any section runs: unparseable at the parse
    // gate, non-mapping at the top-level validator. Never skipped.
    for (const raw of ["unparseable", "non-mapping"] as const) {
      const base = multiMeta([missing(), normal(meta({ mode: "apply", mask: {} }))]);
      const rawRepo = base.repos[0];
      if (rawRepo === undefined) {
        throw new Error("multiMeta built no repos");
      }
      rawRepo.target = { kind: "raw-invalid", raw };
      const p = predictMulti(base);
      expect(p.repos[0]?.run).toBeNull();
      expect([...(p.repos[0]?.allowedResults ?? [])]).toEqual(["failed"]);
      expect(p.allowedExitCodes.has(1)).toBe(true);
    }
  });

  test("a fatal contentsGet fault fails the FIRST target whatever its kind", () => {
    // The fault hook precedes both the missing-file 404 and the permission
    // gate, and the whole budget (1 + MAX_RETRIES) burns on the first target's
    // fetch - so even a missing-settings victim flips from skipped to failed,
    // a raw-invalid one fails at the transport gate instead of its parse gate,
    // and later targets keep their normal predictions.
    const granted = meta({ sections: ["labels"], mode: "apply", mask: {} });
    const victims: MultiRepoTarget[] = [
      missing(),
      normal(granted),
      { kind: "raw-invalid", raw: "unparseable" },
    ];
    for (const victim of victims) {
      const base = multiMeta([victim, normal(granted)]);
      base.coreFault = { key: "core.contentsGet", fatal: true };
      const p = predictMulti(base);
      expect(p.repos[0]?.run).toBeNull();
      expect([...(p.repos[0]?.allowedResults ?? [])]).toEqual(["failed"]);
      expect([...(p.repos[1]?.allowedResults ?? [])]).toEqual(["applied"]);
      expect(p.allowedExitCodes.has(1)).toBe(true);
    }
  });

  test("a non-fatal contentsGet fault changes no prediction", () => {
    const granted = meta({ sections: ["labels"], mode: "apply", mask: {} });
    const base = multiMeta([missing(), normal(granted)]);
    base.coreFault = { key: "core.contentsGet", fatal: false };
    const p = predictMulti(base);
    expect([...(p.repos[0]?.allowedResults ?? [])]).toEqual(["skipped"]);
    expect([...(p.repos[1]?.allowedResults ?? [])]).toEqual(["applied"]);
    expect([...p.allowedExitCodes]).toEqual([0]);
  });

  test("repo result is the mechanical worst-of fold, not a loose union", () => {
    // A fully-granted apply target: every section is "applied", so the ONLY
    // reachable repo result is "applied" - a union over section outcomes would
    // also be {applied}, but the fold proves no stray clean/partial leaks in.
    const granted = meta({ sections: ["labels", "pages"], mode: "apply", mask: {} });
    const p = predictMulti(multiMeta([normal(granted)]));
    expect([...(p.repos[0]?.allowedResults ?? [])]).toEqual(["applied"]);
  });

  test("apply target mixing an applied and a skipped section rolls up to partial", () => {
    // labels write-granted (applied), collaborators denied under warn (skipped):
    // the fold yields "partial", never a bare {applied, skipped} union.
    const mixed = meta({
      sections: ["labels", "collaborators"],
      mask: { administration: "none" },
      denialStyle: 403,
      mode: "apply",
      policy: "warn",
    });
    const p = predictMulti({
      repos: [
        {
          slug: "e2e-owner/repo-0",
          target: { kind: "normal", meta: mixed },
          visibility: "public",
          probeDenied: false,
          redacted: false,
          displayKey: "e2e-owner/repo-0",
          canaries: [],
        },
      ],
      mode: "apply",
      policy: "warn",
      privateRepos: "show",
      privateReport: "none",
      selfSlug: "e2e-owner/e2e-repo",
    });
    expect(p.repos[0]?.allowedResults.has("partial")).toBe(true);
    expect(p.repos[0]?.allowedResults.has("skipped")).toBe(false);
  });

  test("contents:none gates the settings read - fine_grained target is skipped", () => {
    // The settings file is read through the contents endpoint before any
    // section runs; a denied contents read 404s (fine_grained), and with
    // administration still granted the repo probe succeeds (pull:true), so the
    // 404 reads as a missing file and the whole target is skipped.
    const gated = meta({
      sections: ["labels", "collaborators"],
      mask: { contents: "none" },
      denialStyle: "fine_grained",
    });
    const p = predictMulti(multiMeta([normal(gated)]));
    expect(p.repos[0]?.run).toBeNull();
    expect([...(p.repos[0]?.allowedResults ?? [])]).toEqual(["skipped"]);
    expect(p.allowedExitCodes.has(0)).toBe(true);
  });

  test("contents:none AND administration:none under fine_grained fails the target", () => {
    // With administration also denied, the repo probe the action falls back to
    // ALSO 404s, so the read is "visible but unreadable" and the target FAILS
    // (not skipped) even under fine_grained. Mirrors repo-file.ts.
    const gated = meta({
      sections: ["labels"],
      mask: { contents: "none", administration: "none" },
      denialStyle: "fine_grained",
    });
    const p = predictMulti(multiMeta([normal(gated)]));
    expect(p.repos[0]?.run).toBeNull();
    expect([...(p.repos[0]?.allowedResults ?? [])]).toEqual(["failed"]);
    expect(p.allowedExitCodes.has(1)).toBe(true);
  });

  test("contents:none under the 403 style fails the target and raises exit 1", () => {
    const gated = meta({
      sections: ["labels"],
      mask: { contents: "none" },
      denialStyle: 403,
    });
    const p = predictMulti(multiMeta([normal(gated)]));
    expect(p.repos[0]?.run).toBeNull();
    expect([...(p.repos[0]?.allowedResults ?? [])]).toEqual(["failed"]);
    expect(p.allowedExitCodes.has(1)).toBe(true);
  });

  test("contents:read lets the settings read through to per-section prediction", () => {
    // A non-none contents grade does not gate the target: it gets a real run.
    const readable = meta({ sections: ["labels"], mask: { contents: "read" } });
    const p = predictMulti(multiMeta([normal(readable)]));
    expect(p.repos[0]?.run).not.toBeNull();
  });

  test("all granted targets => exit 0 only", () => {
    const granted = meta({ mode: "apply", mask: {} });
    const p = predictMulti(multiMeta([normal(granted), normal(granted)]));
    expect([...p.allowedExitCodes]).toEqual([0]);
  });

  test("one target that can fail raises the multi exit to include 1", () => {
    const granted = meta({ mode: "apply", mask: {} });
    const denied = meta({
      sections: ["labels"],
      mask: { issues: "none" },
      denialStyle: 403,
      mode: "apply",
      policy: "fail",
      requiredSections: ["labels"],
    });
    const p = predictMulti(multiMeta([normal(granted), normal(denied)]));
    expect(p.allowedExitCodes.has(1)).toBe(true);
  });

  test("a redacted target keys its result by the placeholder, not the slug", () => {
    const granted = meta({ sections: ["labels"], mode: "apply", mask: {} });
    const p = predictMulti({
      repos: [
        {
          slug: "e2e-owner/repo-0",
          target: { kind: "normal", meta: granted },
          visibility: "private",
          probeDenied: false,
          redacted: true,
          displayKey: "private repository #1",
          canaries: ["CANARY-1-0-name"],
        },
      ],
      mode: "apply",
      policy: "fail",
      privateRepos: "redact",
      privateReport: "none",
      selfSlug: "e2e-owner/e2e-repo",
    });
    // The result prediction keys on the placeholder; the real slug never appears.
    expect(p.repos[0]?.displayKey).toBe("private repository #1");
    expect(p.repos[0]?.redacted).toBe(true);
    // The forbidden set folds the redacted target's real slug plus its canaries.
    expect(p.forbidden).toContain("e2e-owner/repo-0");
    expect(p.forbidden).toContain("CANARY-1-0-name");
  });

  test("under show nothing is redacted, so the forbidden set is empty", () => {
    const granted = meta({ sections: ["labels"], mode: "apply", mask: {} });
    const p = predictMulti(multiMeta([normal(granted)]));
    expect(p.forbidden).toEqual([]);
    expect(p.repos[0]?.displayKey).toBe("e2e-owner/repo-0");
  });
});

describe("predictDiscovery filter rules", () => {
  const pool = [
    { slug: "e2e-owner/pub", visibility: "public" },
    { slug: "e2e-owner/priv", visibility: "private" },
    { slug: "e2e-owner/intern", visibility: "internal" },
    { slug: "e2e-owner/arch", visibility: "public", archived: true },
    { slug: "e2e-owner/fork", visibility: "public", fork: true },
    { slug: "e2e-owner/tagged", visibility: "public", topics: ["infra"] },
  ];

  test("no filters keeps everything except archived (default skip)", () => {
    const kept = predictDiscovery(pool, {});
    expect(kept).not.toContain("e2e-owner/arch");
    expect(kept).toContain("e2e-owner/pub");
    expect(kept).toContain("e2e-owner/fork");
  });

  test("visibility public keeps only public", () => {
    const kept = predictDiscovery(pool, { visibility: "public", archived: "include" });
    expect(kept).not.toContain("e2e-owner/priv");
    expect(kept).not.toContain("e2e-owner/intern");
  });

  test("visibility private keeps only private (drops internal and public)", () => {
    const kept = predictDiscovery(pool, { visibility: "private", archived: "include" });
    expect(kept).toEqual(["e2e-owner/priv"]);
  });

  test("forks exclude drops forks; only keeps only forks", () => {
    expect(predictDiscovery(pool, { forks: "exclude", archived: "include" })).not.toContain(
      "e2e-owner/fork",
    );
    expect(predictDiscovery(pool, { forks: "only", archived: "include" })).toEqual([
      "e2e-owner/fork",
    ]);
  });

  test("topics keeps only repos with a matching topic", () => {
    expect(predictDiscovery(pool, { topics: "infra", archived: "include" })).toEqual([
      "e2e-owner/tagged",
    ]);
  });

  test("exclude patterns drop matching slugs", () => {
    const kept = predictDiscovery(pool, { exclude: "pub", archived: "include" });
    expect(kept).not.toContain("e2e-owner/pub");
  });

  test("exclude globs: wildcards, name-vs-slug, backtracking, case-insensitivity", () => {
    const globPool = [
      { slug: "e2e-owner/svc-a" },
      { slug: "e2e-owner/svc-b" },
      { slug: "e2e-owner/legacy-x" },
      { slug: "e2e-owner/UPPER" },
    ];
    // A trailing-star name glob keeps only non-svc repos.
    expect(predictDiscovery(globPool, { exclude: "svc-*" })).toEqual([
      "e2e-owner/legacy-x",
      "e2e-owner/UPPER",
    ]);
    // A slash-bearing pattern matches the full slug.
    expect(predictDiscovery(globPool, { exclude: "e2e-owner/legacy-*" })).not.toContain(
      "e2e-owner/legacy-x",
    );
    // Middle-wildcard backtracking: "*-*" matches svc-a, svc-b, legacy-x.
    expect(predictDiscovery(globPool, { exclude: "*-*" })).toEqual(["e2e-owner/UPPER"]);
    // Case-insensitive: "upper" excludes "UPPER".
    expect(predictDiscovery(globPool, { exclude: "upper" })).not.toContain("e2e-owner/UPPER");
  });
});
