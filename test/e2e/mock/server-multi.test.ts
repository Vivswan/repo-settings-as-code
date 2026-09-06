/**
 * Unit tests for the mock server's multi-repo mode and the private-report
 * bypass, driven over the wire like server.test.ts: each test starts a real
 * server and asserts on the responses plus the handle's request log.
 */

import { describe, expect, test } from "bun:test";
import type { MockHandle } from "./server.js";
import { call, json, jsonArray, mockServerLifecycle, scenario } from "./server-test-support.js";

const start = mockServerLifecycle();

describe("multi-repo mode", () => {
  const RAW_ACCEPT = "application/vnd.github.raw+json";
  const settingsPath = (slug: string) => `/repos/${slug}/contents/.github/settings.yml`;
  /** A contents GET with the raw Accept header the action sends. */
  const contentsGet = (h: MockHandle, slug: string) =>
    call(h, "GET", settingsPath(slug), { headers: { accept: RAW_ACCEPT } });

  test("contents serves a configured slug's raw settings, 404s a null-settings slug", async () => {
    const h = await start(
      scenario({
        repos: {
          "e2e-owner/svc-a": { settings: { labels: [{ name: "x" }] } },
          "e2e-owner/svc-b": { settings: null },
        },
      }),
    );
    expect(h.working.mode).toBe("multi");
    const configured = await contentsGet(h, "e2e-owner/svc-a");
    expect(configured.status).toBe(200);
    expect(await configured.text()).toContain("labels");
    const missing = await contentsGet(h, "e2e-owner/svc-b");
    expect(missing.status).toBe(404);
  });

  test("contents rejects a non-GET method with a violation", async () => {
    const h = await start(scenario({ repos: { "e2e-owner/svc-a": { settings: {} } } }));
    const res = await call(h, "PUT", settingsPath("e2e-owner/svc-a"), {
      headers: { accept: RAW_ACCEPT },
      body: {},
    });
    expect(res.status).toBe(400);
    expect(h.violations.some((v) => v.includes("must be GET"))).toBe(true);
  });

  test("contents rejects a missing raw Accept header with a violation", async () => {
    const h = await start(scenario({ repos: { "e2e-owner/svc-a": { settings: {} } } }));
    // The default call() sends application/vnd.github+json, not the raw type.
    const res = await call(h, "GET", settingsPath("e2e-owner/svc-a"));
    expect(res.status).toBe(400);
    expect(h.violations.some((v) => v.includes("Accept"))).toBe(true);
  });

  test("contents is permission-gated: a Contents-denied slug answers a denial", async () => {
    const h = await start(
      scenario({
        repos: { "e2e-owner/locked": { settings: {}, permissions: { contents: "none" } } },
      }),
    );
    // fine_grained read denial -> 404 (the action then disambiguates via the
    // repo probe); deniedBy names the contents resource.
    const res = await contentsGet(h, "e2e-owner/locked");
    expect(res.status).toBe(404);
    const log = h.requests.find((r) => r.pathname === settingsPath("e2e-owner/locked"));
    expect(log?.deniedBy).toBe("contents");
  });

  test("/user/repos enumerates the discovery pool, paginated", async () => {
    const pool = Array.from({ length: 100 }, (_, i) => ({ slug: `e2e-owner/repo-${i}` }));
    const h = await start(scenario({ discovery: { inputs: {}, pool } }));
    const first = await jsonArray(await call(h, "GET", "/user/repos?per_page=100&page=1"));
    const second = await jsonArray(await call(h, "GET", "/user/repos?per_page=100&page=2"));
    expect(first).toHaveLength(100);
    expect(second).toHaveLength(0);
    expect(first[0]?.full_name).toBe("e2e-owner/repo-0");
  });

  test("/user/repos does NOT client-side-filter archived/fork/topics", async () => {
    // Those are the action's job; the mock serves them verbatim so the action's
    // own filtering is what the scenario exercises.
    const h = await start(
      scenario({
        discovery: {
          inputs: {},
          pool: [{ slug: "e2e-owner/arch", archived: true, fork: true, topics: ["x"] }],
        },
      }),
    );
    const repos = await jsonArray(await call(h, "GET", "/user/repos"));
    expect(repos[0]).toMatchObject({
      full_name: "e2e-owner/arch",
      archived: true,
      fork: true,
      topics: ["x"],
    });
  });

  test("/user/repos server-side visibility: private retains internal, public drops it", async () => {
    // GitHub's server-side query narrows only coarsely: visibility=private
    // returns private AND internal (no server-side "internal" value), and the
    // ACTION drops internal client-side (discover.test.ts). visibility=public
    // returns only public. The mock must mirror this exactly so the action's
    // own client-side narrowing is what a scenario exercises.
    const h = await start(
      scenario({
        discovery: {
          inputs: {},
          pool: [
            { slug: "e2e-owner/pub", visibility: "public" },
            { slug: "e2e-owner/priv", visibility: "private" },
            { slug: "e2e-owner/int", visibility: "internal" },
          ],
        },
      }),
    );
    // private query keeps private AND internal (the mock does NOT drop internal).
    const priv = await jsonArray(await call(h, "GET", "/user/repos?visibility=private"));
    expect(priv.map((r) => r.full_name).sort()).toEqual(["e2e-owner/int", "e2e-owner/priv"]);
    // public query keeps only public.
    const pub = await jsonArray(await call(h, "GET", "/user/repos?visibility=public"));
    expect(pub.map((r) => r.full_name)).toEqual(["e2e-owner/pub"]);
    // no visibility param: the whole pool passes through.
    const all = await jsonArray(await call(h, "GET", "/user/repos"));
    expect(all).toHaveLength(3);
  });

  test("section endpoints dispatch into the addressed slug's state", async () => {
    const h = await start(
      scenario({
        repos: {
          "e2e-owner/svc-a": { settings: {}, live_state: { labels: [{ id: 1, name: "a-only" }] } },
          "e2e-owner/svc-b": { settings: {}, live_state: { labels: [{ id: 2, name: "b-only" }] } },
        },
      }),
    );
    const aLabels = await jsonArray(await call(h, "GET", "/repos/e2e-owner/svc-a/labels"));
    const bLabels = await jsonArray(await call(h, "GET", "/repos/e2e-owner/svc-b/labels"));
    expect(aLabels.map((l) => l.name)).toEqual(["a-only"]);
    expect(bLabels.map((l) => l.name)).toEqual(["b-only"]);
    // A create on svc-a does not leak into svc-b.
    await call(h, "POST", "/repos/e2e-owner/svc-a/labels", { body: { name: "new-a" } });
    const bAfter = await jsonArray(await call(h, "GET", "/repos/e2e-owner/svc-b/labels"));
    expect(bAfter.map((l) => l.name)).toEqual(["b-only"]);
  });

  test("the disambiguation probe serves the addressed slug's repo object", async () => {
    const h = await start(scenario({ repos: { "e2e-owner/svc-a": { settings: {} } } }));
    const probe = await json(await call(h, "GET", "/repos/e2e-owner/svc-a"));
    expect(probe.full_name).toBe("e2e-owner/svc-a");
    expect(probe.name).toBe("svc-a");
  });

  test("the org probe (GET /orgs/{owner}) is served from the shared org state, not slug-routed", async () => {
    // Org-level endpoints are not repo-scoped; before this they hit the slug
    // router and failed with "names no known target slug".
    const h = await start(scenario({ repos: { "e2e-owner/svc-a": { settings: {} } } }));
    const org = await call(h, "GET", "/orgs/e2e-owner");
    expect(org.status).toBe(200);
    expect((await json(org)).login).toBe("e2e-owner");
    expect(h.violations).toHaveLength(0);
  });

  test("the org probe 404s under a personal-account owner_kind", async () => {
    const h = await start(
      scenario({ owner_kind: "user", repos: { "e2e-owner/svc-a": { settings: {} } } }),
    );
    expect((await call(h, "GET", "/orgs/e2e-owner")).status).toBe(404);
  });

  test("a team-repo route resolves its {owner}/{repo} tail to the addressed slug's state", async () => {
    const h = await start(
      scenario({
        owner_kind: "org",
        repos: {
          "e2e-owner/svc-a": {
            settings: {},
            live_state: { teams: { reviewers: { role_name: "write" } } },
          },
          "e2e-owner/svc-b": { settings: {} },
        },
      }),
    );
    // The team-repo probe reads svc-a's teams state (role_name write), not svc-b's.
    const res = await call(h, "GET", "/orgs/e2e-owner/teams/reviewers/repos/e2e-owner/svc-a");
    expect(res.status).toBe(200);
    expect((await json(res)).role_name).toBe("write");
    // svc-b has no reviewers team -> 404, proving per-slug resolution.
    const missing = await call(h, "GET", "/orgs/e2e-owner/teams/reviewers/repos/e2e-owner/svc-b");
    expect(missing.status).toBe(404);
    expect(h.violations).toHaveLength(0);
  });

  test("team-repo grading: org_members always grades against the GLOBAL mask", async () => {
    // Hybrid grading: org_members is org-wide, so a per-slug org_members:write
    // override must NOT loosen a global org_members:none. (The administration
    // half - per-slug - is covered by the two tests below.)
    const h = await start(
      scenario({
        owner_kind: "org",
        token_permissions: { org_members: "none" },
        repos: {
          "e2e-owner/svc-a": {
            settings: {},
            permissions: { org_members: "write" },
            live_state: { teams: { reviewers: { role_name: "write" } } },
          },
        },
      }),
    );
    const res = await call(h, "GET", "/orgs/e2e-owner/teams/reviewers/repos/e2e-owner/svc-a");
    expect(res.status).toBe(404); // denied by global org_members: none
    const log = h.requests.find((r) => r.pathname.includes("/teams/reviewers/"));
    expect(log?.deniedBy).toBe("org_members");
  });

  test("team-repo grading: administration grades PER-SLUG (denied on A, allowed on B)", async () => {
    // Hybrid grading: administration is a repository permission on the ADDRESSED
    // repo. slug A denies it, slug B grants it; global org_members is write, so
    // the team-repo call is denied on A and allowed on B - matching the oracle's
    // orgMask model.
    const h = await start(
      scenario({
        owner_kind: "org",
        token_permissions: { org_members: "write" },
        repos: {
          "e2e-owner/svc-a": {
            settings: {},
            permissions: { administration: "none" },
            live_state: { teams: { reviewers: { role_name: "write" } } },
          },
          "e2e-owner/svc-b": {
            settings: {},
            permissions: { administration: "write" },
            live_state: { teams: { reviewers: { role_name: "write" } } },
          },
        },
      }),
    );
    // svc-a: administration denied per-slug -> the team-repo read is denied.
    const a = await call(h, "GET", "/orgs/e2e-owner/teams/reviewers/repos/e2e-owner/svc-a");
    expect(a.status).toBe(404);
    expect(h.requests.find((r) => r.pathname.endsWith("/repos/e2e-owner/svc-a"))?.deniedBy).toBe(
      "administration",
    );
    // svc-b: administration granted per-slug -> allowed.
    const b = await call(h, "GET", "/orgs/e2e-owner/teams/reviewers/repos/e2e-owner/svc-b");
    expect(b.status).toBe(200);
  });

  test("team-repo grading: global org_members:none denies BOTH regardless of per-slug administration", async () => {
    const h = await start(
      scenario({
        owner_kind: "org",
        token_permissions: { org_members: "none" },
        repos: {
          "e2e-owner/svc-a": {
            settings: {},
            permissions: { administration: "write" },
            live_state: { teams: { reviewers: { role_name: "write" } } },
          },
          "e2e-owner/svc-b": {
            settings: {},
            permissions: { administration: "write" },
            live_state: { teams: { reviewers: { role_name: "write" } } },
          },
        },
      }),
    );
    // Both repos grant administration per-slug, but the org-wide org_members is
    // denied globally, so both team-repo calls are denied on org_members.
    for (const slug of ["svc-a", "svc-b"]) {
      const res = await call(h, "GET", `/orgs/e2e-owner/teams/reviewers/repos/e2e-owner/${slug}`);
      expect(res.status).toBe(404);
      expect(
        h.requests.find((r) => r.pathname.endsWith(`/repos/e2e-owner/${slug}`))?.deniedBy,
      ).toBe("org_members");
    }
  });

  test("per-slug permission mask scopes a denial to one repository", async () => {
    const h = await start(
      scenario({
        repos: {
          "e2e-owner/svc-a": { settings: {}, permissions: { issues: "none" } },
          "e2e-owner/svc-b": { settings: {}, permissions: { issues: "write" } },
        },
      }),
    );
    // svc-a's labels read is denied (issues none -> 404); svc-b's is allowed.
    expect((await call(h, "GET", "/repos/e2e-owner/svc-a/labels")).status).toBe(404);
    expect((await call(h, "GET", "/repos/e2e-owner/svc-b/labels")).status).toBe(200);
  });

  test("the per-slug mask OVERLAYS the global mask (global is not a no-op)", async () => {
    // Global denies issues; svc-a inherits that (no per-slug issues grade) and
    // its labels read is denied. svc-b overrides issues to write, so its read is
    // allowed - proving both layers compose.
    const h = await start(
      scenario({
        token_permissions: { issues: "none" },
        repos: {
          "e2e-owner/svc-a": { settings: {} },
          "e2e-owner/svc-b": { settings: {}, permissions: { issues: "write" } },
        },
      }),
    );
    expect((await call(h, "GET", "/repos/e2e-owner/svc-a/labels")).status).toBe(404);
    expect((await call(h, "GET", "/repos/e2e-owner/svc-b/labels")).status).toBe(200);
  });

  test("a request to an unknown slug is a violation", async () => {
    const h = await start(scenario({ repos: { "e2e-owner/svc-a": { settings: {} } } }));
    const res = await call(h, "GET", "/repos/e2e-owner/ghost/labels");
    expect(res.status).toBe(400);
    expect(h.violations.some((v) => v.includes("no known target slug"))).toBe(true);
  });

  test("the denial barrier does not leak across slugs (per-target keying)", async () => {
    // repo-1 (svc-a) denies issues -> its labels read is fatal-denied and arms
    // the barrier for svc-a:labels. repo-2 (svc-b) grants issues -> its labels
    // write is legitimate and must NOT be flagged by svc-a's denied read.
    const h = await start(
      scenario({
        denial_style: 403,
        repos: {
          "e2e-owner/svc-a": { settings: {}, permissions: { issues: "none" } },
          "e2e-owner/svc-b": { settings: {}, permissions: { issues: "write" } },
        },
      }),
    );
    // svc-a: denied read (fatal, 403) arms svc-a:labels.
    expect((await call(h, "GET", "/repos/e2e-owner/svc-a/labels")).status).toBe(403);
    // svc-b: a legitimate labels create - the barrier must not fire across slugs.
    const write = await call(h, "POST", "/repos/e2e-owner/svc-b/labels", { body: { name: "x" } });
    expect(write.status).toBe(201);
    expect(h.violations).toHaveLength(0);
  });

  test("a team-repo route naming an unknown slug is a violation (not an orgState fallback)", async () => {
    // The team-repo route carries a {owner}/{repo} tail; an unknown slug must be
    // the unknown-target violation, NOT a silent fall-through to orgState (which
    // would let a buggy write mutate shared org state). Only the BARE org probe
    // (no slug) uses orgState.
    const h = await start(
      scenario({ owner_kind: "org", repos: { "e2e-owner/svc-a": { settings: {} } } }),
    );
    const res = await call(h, "PUT", "/orgs/e2e-owner/teams/reviewers/repos/e2e-owner/ghost", {
      body: { permission: "push" },
    });
    expect(res.status).toBe(400);
    expect(h.violations.some((v) => v.includes("no known target slug"))).toBe(true);
    // The bare org probe (no repo tail) still works from orgState.
    expect((await call(h, "GET", "/orgs/e2e-owner")).status).toBe(200);
  });

  test("a fault does not mask the unknown-target violation (resolution runs first)", async () => {
    // A fault on labels.list must not fire for a request naming a ghost slug:
    // the unknown-target check is a harness-integrity invariant that resolution
    // raises before the fault barrier.
    const h = await start(scenario({ repos: { "e2e-owner/svc-a": { settings: {} } } }), {
      faults: [{ key: "labels.list", kind: "rate_limit_403" }],
    });
    const res = await call(h, "GET", "/repos/e2e-owner/ghost/labels");
    expect(res.status).toBe(400); // the unknown-target violation, NOT the 403 fault
    expect(h.violations.some((v) => v.includes("no known target slug"))).toBe(true);
    // The fault still fires for a VALID target (unchanged behavior).
    expect((await call(h, "GET", "/repos/e2e-owner/svc-a/labels")).status).toBe(403);
  });
});

describe("private-report bypass is scoped to redact-and-deliver targets", () => {
  const jsonHeaders = { "content-type": "application/json" };

  test("a marker-label POST in check mode to a PUBLIC target hits the check-mode barrier", async () => {
    // The report-infra bypass writes even in check mode, but ONLY for a
    // report-delivery target. A marker POST to a public slug (e.g. a buggy
    // labels-section write of the injected marker) is NOT report infra: it falls
    // through to the labels.create section route and the check-mode barrier fires.
    const target = "e2e-owner/svc-pub";
    const h = await start(
      scenario({
        inputs: { mode: "check", private_report: "issue" },
        repos: { [target]: { settings: {}, live_state: { repo: { visibility: "public" } } } },
      }),
    );
    const res = await call(h, "POST", `/repos/${target}/labels`, {
      headers: jsonHeaders,
      body: { name: "settings-as-code-report" },
    });
    expect(res.status).toBe(400);
    expect(h.violations.some((v) => v.startsWith("write in check mode"))).toBe(true);
  });

  test("issue traffic to a PUBLIC (non-delivery) target is a loud no-route violation", async () => {
    // An issue POST to a public slug is accidental delivery: the bypass does not
    // serve it, so it falls through to section matching, which has no /issues
    // route and raises the no-route violation. Fuzz can thus reject a stray
    // report write to a repo that might be public.
    const target = "e2e-owner/svc-pub";
    const h = await start(
      scenario({
        inputs: { private_report: "issue" },
        repos: { [target]: { settings: {}, live_state: { repo: { visibility: "public" } } } },
      }),
    );
    const res = await call(h, "POST", `/repos/${target}/issues`, {
      headers: jsonHeaders,
      body: { title: "x", body: "y" },
    });
    expect(res.status).toBe(400);
    expect(h.violations.some((v) => v.includes("no route in routes.ts"))).toBe(true);
  });

  test("the same issue POST to a PRIVATE delivery target IS served (control)", async () => {
    // The mirror of the above: with a proven-private target and the issue
    // channel on, the bypass serves the create (201), proving the scoping gates
    // on visibility, not on the path alone.
    const target = "e2e-owner/svc-priv";
    const h = await start(
      scenario({
        inputs: { private_report: "issue" },
        repos: {
          [target]: {
            settings: {},
            live_state: { repo: { private: true, visibility: "private" } },
          },
        },
      }),
    );
    const res = await call(h, "POST", `/repos/${target}/issues`, {
      headers: jsonHeaders,
      body: { title: "x", body: "y", labels: ["settings-as-code-report"] },
    });
    expect(res.status).toBe(201);
    expect(h.violations).toHaveLength(0);
  });

  test("delivery to a private target whose PROBE is denied is a no-route violation", async () => {
    // The fixture is private, but administration:none denies the visibility
    // probe, so the action resolves "unknown" and must NOT deliver. The mock
    // models provability, not the fixture alone: the issue POST is not served and
    // falls through to the no-route violation, so a regression that delivers on
    // an unprovable target is caught.
    const target = "e2e-owner/svc-unprovable";
    const h = await start(
      scenario({
        inputs: { private_report: "issue" },
        repos: {
          [target]: {
            settings: {},
            live_state: { repo: { private: true, visibility: "private" } },
            permissions: { administration: "none" },
          },
        },
      }),
    );
    const res = await call(h, "POST", `/repos/${target}/issues`, {
      headers: jsonHeaders,
      body: { title: "x", body: "y" },
    });
    expect(res.status).toBe(400);
    expect(h.violations.some((v) => v.includes("no route in routes.ts"))).toBe(true);
  });

  test("delivery to a private target whose probe FAULTS out its budget is a no-route violation", async () => {
    // A repository.get fault that exhausts the probe's retry budget makes the
    // probe never resolve -> "unknown" -> no delivery. Same provability rule as
    // the denied probe, via the fault path.
    const target = "e2e-owner/svc-faulted";
    const h = await start(
      scenario({
        inputs: { private_report: "issue" },
        repos: {
          [target]: {
            settings: {},
            live_state: { repo: { private: true, visibility: "private" } },
          },
        },
      }),
      { faults: [{ key: "repository.get", kind: "rate_limit_403", times: 3 }] },
    );
    const res = await call(h, "POST", `/repos/${target}/issues`, {
      headers: jsonHeaders,
      body: { title: "x", body: "y" },
    });
    expect(res.status).toBe(400);
    expect(h.violations.some((v) => v.includes("no route in routes.ts"))).toBe(true);
  });

  test("a DISCOVERY-supplied private target IS a delivery target (visibility needs no probe)", async () => {
    // A private repo discovered via /user/repos carries its visibility already, so
    // the action needs no probe and delivers. The mock seeds the discovered
    // repo's state from the pool visibility, so its delivery gate agrees: the
    // issue create is served (201), NOT flagged as an accidental delivery.
    const target = "e2e-owner/disc-priv";
    const h = await start(
      scenario({
        inputs: { private_report: "issue" },
        discovery: { pool: [{ slug: target, visibility: "private" }], inputs: {} },
      }),
    );
    const res = await call(h, "POST", `/repos/${target}/issues`, {
      headers: jsonHeaders,
      body: { title: "x", body: "y", labels: ["settings-as-code-report"] },
    });
    expect(res.status).toBe(201);
    expect(h.violations).toHaveLength(0);
  });
});
