import { describe, expect, test } from "bun:test";
import type { MultiScenarioMeta, ScenarioMeta } from "./generators.js";
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
  function multiMeta(repoMetas: Array<ScenarioMeta | null>): MultiScenarioMeta {
    return {
      repos: repoMetas.map((m, i) => ({
        slug: `e2e-owner/repo-${i}`,
        meta: m,
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
    const p = predictMulti(multiMeta([null]));
    expect(p.repos[0]?.run).toBeNull();
    expect([...(p.repos[0]?.allowedResults ?? [])]).toEqual(["skipped"]);
  });

  test("repo result is the mechanical worst-of fold, not a loose union", () => {
    // A fully-granted apply target: every section is "applied", so the ONLY
    // reachable repo result is "applied" - a union over section outcomes would
    // also be {applied}, but the fold proves no stray clean/partial leaks in.
    const granted = meta({ sections: ["labels", "pages"], mode: "apply", mask: {} });
    const p = predictMulti(multiMeta([granted]));
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
          meta: mixed,
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
    const p = predictMulti(multiMeta([gated]));
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
    const p = predictMulti(multiMeta([gated]));
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
    const p = predictMulti(multiMeta([gated]));
    expect(p.repos[0]?.run).toBeNull();
    expect([...(p.repos[0]?.allowedResults ?? [])]).toEqual(["failed"]);
    expect(p.allowedExitCodes.has(1)).toBe(true);
  });

  test("contents:read lets the settings read through to per-section prediction", () => {
    // A non-none contents grade does not gate the target: it gets a real run.
    const readable = meta({ sections: ["labels"], mask: { contents: "read" } });
    const p = predictMulti(multiMeta([readable]));
    expect(p.repos[0]?.run).not.toBeNull();
  });

  test("all granted targets => exit 0 only", () => {
    const granted = meta({ mode: "apply", mask: {} });
    const p = predictMulti(multiMeta([granted, granted]));
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
    const p = predictMulti(multiMeta([granted, denied]));
    expect(p.allowedExitCodes.has(1)).toBe(true);
  });

  test("a redacted target keys its result by the placeholder, not the slug", () => {
    const granted = meta({ sections: ["labels"], mode: "apply", mask: {} });
    const p = predictMulti({
      repos: [
        {
          slug: "e2e-owner/repo-0",
          meta: granted,
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
    const p = predictMulti(multiMeta([granted]));
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
