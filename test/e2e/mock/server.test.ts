/**
 * Unit tests for the mock server and its pipeline, run under the normal
 * `bun test` suite (no subprocess): each test starts a real server, drives it
 * with in-process fetch(), and asserts on the response plus the handle's
 * request/violation logs. The server's own logic (permission gate, denial
 * barriers, pagination, chaos) is exercised end to end through the wire.
 *
 * Two invariants are checked without the wire: assertHandlerCompleteness fires
 * when the table drifts, and every handler's observed status is a subset of its
 * endpoint's declaration (the status-subset guard from routes.ts).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { endpointPermission } from "../../../src/sections/contract.js";
import { allEndpoints, SECTIONS } from "../../../src/sections/registry.js";
import { parseScenario, type Scenario } from "../schema.js";
import {
  assertFaultKeys,
  assertHandlerCompleteness,
  declaredStatuses,
  slicePage,
  statusAllowed,
} from "./routes.js";
import { type MockHandle, type ServerOptions, startMockServer } from "./server.js";
import type { MockState } from "./state.js";

const OWNER = "e2e-owner";
const REPO = "e2e-repo";
const AUTH = { authorization: "Bearer test-token", "x-github-api-version": "2022-11-28" };

/** A minimal valid scenario; each test overrides only what it exercises. */
function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return parseScenario(
    {
      name: "unit",
      settings: {},
      expect: { exit_code: 0 },
      ...overrides,
    },
    "server.test.ts",
  );
}

let handle: MockHandle | undefined;

afterEach(async () => {
  await handle?.stop();
  handle = undefined;
});

async function start(s: Scenario, options?: ServerOptions): Promise<MockHandle> {
  handle = await startMockServer(s, options);
  return handle;
}

/** GET/PUT/etc. against the running server with the wire headers by default. */
async function call(
  h: MockHandle,
  method: string,
  path: string,
  init: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...AUTH, ...init.headers };
  const requestInit: RequestInit = { method, headers };
  if (init.body !== undefined) {
    requestInit.body = JSON.stringify(init.body);
    headers["content-type"] = "application/json";
  }
  return fetch(`${h.url}${path}`, requestInit);
}

/** Parse a response body as an untyped record (test-only convenience). */
async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** Parse a response body as an untyped array (test-only convenience). */
async function jsonArray(res: Response): Promise<Record<string, unknown>[]> {
  return (await res.json()) as Record<string, unknown>[];
}

/** The single-repo MockState (defined for every non-multi scenario here). */
function singleState(h: MockHandle): MockState {
  if (!h.state) {
    throw new Error("expected a single-repo MockState on the handle");
  }
  return h.state;
}

const labelsPath = `/repos/${OWNER}/${REPO}/labels`;

describe("handler-completeness startup assertion", () => {
  test("passes for the real table", () => {
    expect(() => assertHandlerCompleteness()).not.toThrow();
  });

  test("fires when an endpoint has no handler", () => {
    const endpoints = { "phantom.role": {} } as unknown as Parameters<
      typeof assertHandlerCompleteness
    >[0];
    expect(() => assertHandlerCompleteness(endpoints, {})).toThrow(/no mock handler/);
  });

  test("fires when a handler names no known endpoint", () => {
    const handlers = { "ghost.role": () => ({ status: 200, body: null }) } as unknown as Parameters<
      typeof assertHandlerCompleteness
    >[1];
    expect(() => assertHandlerCompleteness({}, handlers)).toThrow(/no known endpoint/);
  });
});

describe("pagination slicing", () => {
  test("first page returns up to per_page items", () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    expect(slicePage(items, { per_page: "100", page: "1" })).toHaveLength(100);
    expect(slicePage(items, { per_page: "100", page: "1" })[0]).toBe(0);
  });

  test("the 100-boundary: exactly 100 items yields a full page then an empty one", () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    expect(slicePage(items, { per_page: "100", page: "1" })).toHaveLength(100);
    expect(slicePage(items, { per_page: "100", page: "2" })).toHaveLength(0);
  });

  test("defaults per_page to 100 and page to 1 when absent or invalid", () => {
    const items = Array.from({ length: 150 }, (_, i) => i);
    expect(slicePage(items, {})).toHaveLength(100);
    expect(slicePage(items, { per_page: "0", page: "-1" })).toHaveLength(100);
  });

  test("a page past the end is empty", () => {
    expect(slicePage([1, 2, 3], { per_page: "100", page: "5" })).toHaveLength(0);
  });

  test("labels.list paginates over the wire", async () => {
    const h = await start(
      scenario({
        live_state: { labels: { generate: { count: 100, prefix: "gen", color: "ededed" } } },
      }),
    );
    const first = await jsonArray(await call(h, "GET", `${labelsPath}?per_page=100&page=1`));
    const second = await jsonArray(await call(h, "GET", `${labelsPath}?per_page=100&page=2`));
    expect(first).toHaveLength(100);
    expect(second).toHaveLength(0);
    // The page=2 read is present in the log, proving the client can advance.
    expect(h.requests.some((r) => r.query.includes("page=2"))).toBe(true);
  });
});

describe("permission gate grades", () => {
  test("a read is allowed under a read mask, a write is denied and logged", async () => {
    // labels needs "issues"; grant it read only.
    const h = await start(scenario({ token_permissions: { issues: "read" } }));
    const read = await call(h, "GET", labelsPath);
    expect(read.status).toBe(200);

    const write = await call(h, "POST", labelsPath, { body: { name: "new" } });
    expect(write.status).toBe(403); // fine_grained denied write
    const denied = h.requests.find((r) => r.method === "POST");
    expect(denied?.deniedBy).toBe("issues");
  });

  test("a denied read answers 404 under fine_grained and logs deniedBy", async () => {
    const h = await start(scenario({ token_permissions: { issues: "none" } }));
    const read = await call(h, "GET", labelsPath);
    expect(read.status).toBe(404);
    expect(h.requests[0]?.deniedBy).toBe("issues");
  });

  test("org: members gates the teams probe on org_members read", async () => {
    // teams needs administration (repo) AND org_members (org). Grant repo,
    // deny org_members: the org probe (repo? no - it's permission none) still
    // passes, but the team probe requires org_members.
    const h = await start(
      scenario({
        owner_kind: "org",
        token_permissions: { administration: "write", org_members: "none" },
      }),
    );
    const probe = await call(h, "GET", `/orgs/${OWNER}/teams/reviewers/repos/${OWNER}/${REPO}`);
    expect(probe.status).toBe(404);
    expect(h.requests[0]?.deniedBy).toBe("org_members");
  });

  test("the org endpoint needs no permission (permission: none)", async () => {
    const h = await start(scenario({ token_permissions: { administration: "none" } }));
    const org = await call(h, "GET", `/orgs/${OWNER}`);
    expect(org.status).toBe(200);
  });
});

describe("permission mask semantics", () => {
  const codeScanningPath = `/repos/${OWNER}/${REPO}/code-scanning/default-setup`;

  test("ANY-of-resources: code_scanning read is granted by administration alone", async () => {
    // code_scanning declares repo: ["administration", "code_scanning_alerts"];
    // ANY one at the needed grade suffices. Grant administration, deny the other.
    const h = await start(
      scenario({ token_permissions: { administration: "read", code_scanning_alerts: "none" } }),
    );
    expect((await call(h, "GET", codeScanningPath)).status).toBe(200);
    expect(h.requests[0]?.deniedBy).toBeUndefined();
  });

  test("ANY-of-resources: code_scanning read is granted by code_scanning_alerts alone", async () => {
    const h = await start(
      scenario({ token_permissions: { administration: "none", code_scanning_alerts: "read" } }),
    );
    expect((await call(h, "GET", codeScanningPath)).status).toBe(200);
    expect(h.requests[0]?.deniedBy).toBeUndefined();
  });

  test("ANY-of-resources: code_scanning read is denied only when BOTH are insufficient", async () => {
    const h = await start(
      scenario({ token_permissions: { administration: "none", code_scanning_alerts: "none" } }),
    );
    expect((await call(h, "GET", codeScanningPath)).status).toBe(404);
    // The denying resource is the FIRST listed repo resource (deterministic).
    expect(h.requests[0]?.deniedBy).toBe("administration");
  });

  test("unlisted resources default to write grade", async () => {
    // token_permissions omits "issues" entirely; labels (issues) writes must
    // still be allowed because the default grade is write.
    const h = await start(scenario({ token_permissions: { administration: "read" } }));
    const created = await call(h, "POST", labelsPath, { body: { name: "x" } });
    expect(created.status).toBe(201);
    expect(h.violations).toHaveLength(0);
  });

  test("every section endpoint's requirement resolves from the registry, not a hand list", () => {
    // Spot-check that the gate's requirement source is the section declaration:
    // for each endpoint, endpointPermission(section, endpoint) must be "none"
    // or name at least one repo resource. Driven from allEndpoints() so a new
    // section is covered automatically.
    const sectionByKey = new Map(SECTIONS.map((s) => [s.key, s]));
    for (const endpoint of Object.values(allEndpoints())) {
      const section = sectionByKey.get(endpoint.section);
      expect(section).toBeDefined();
      if (!section) {
        continue;
      }
      const permission = endpointPermission(section, endpoint);
      if (permission === "none") {
        continue;
      }
      expect(permission.repo.length).toBeGreaterThan(0);
    }
  });
});

describe("denial style bodies", () => {
  test("fine_grained: a denied read answers 404 Not Found", async () => {
    const h = await start(scenario({ token_permissions: { issues: "none" } }));
    const read = await json(await call(h, "GET", labelsPath));
    expect(read.message).toBe("Not Found");
  });

  test("fine_grained: a denied write answers 403 not accessible", async () => {
    // environments has "absent" denial semantics, so the probe-then-write path
    // reaches the server and the write body is asserted cleanly (no violation).
    const h = await start(scenario({ token_permissions: { environments: "none" } }));
    const put = await call(h, "PUT", `/repos/${OWNER}/${REPO}/environments/prod`, { body: {} });
    expect(put.status).toBe(403);
    expect((await json(put)).message).toBe("Resource not accessible by personal access token");
  });

  test("style 403: both reads and writes answer 403", async () => {
    const h = await start(scenario({ denial_style: 403, token_permissions: { issues: "none" } }));
    const read = await call(h, "GET", labelsPath);
    expect(read.status).toBe(403);
  });

  test("style 404: both reads and writes answer 404", async () => {
    const h = await start(
      scenario({ denial_style: 404, token_permissions: { environments: "none" } }),
    );
    const write = await call(h, "PUT", `/repos/${OWNER}/${REPO}/environments/prod`, { body: {} });
    expect(write.status).toBe(404);
  });

  test("no denial body ever mentions rate limit", async () => {
    for (const style of [403, 404, "fine_grained"] as const) {
      const h = await start(
        scenario({ denial_style: style, token_permissions: { issues: "none" } }),
      );
      const body = await (await call(h, "GET", labelsPath)).text();
      expect(body.toLowerCase()).not.toContain("rate limit");
      await h.stop();
    }
    handle = undefined;
  });
});

describe("denial barrier", () => {
  test("a read-grade mask + fail policy + denied write is NOT a violation (preflight only proves reads)", async () => {
    // labels is "denied", but issues:read passes the list READ, so preflight
    // (fail policy) succeeds - it can only prove reads work; the engine then
    // legitimately sends the create, which is write-denied. No preceding denied
    // read, so NO violation. Fuzz seed 1723060241 found the old rule flagging
    // exactly this (repo mask issues:read false-flagged POST labels).
    const h = await start(scenario({ token_permissions: { issues: "read" } }));
    const read = await call(h, "GET", labelsPath);
    expect(read.status).toBe(200); // the read is allowed
    const write = await call(h, "POST", labelsPath, { body: { name: "x" } });
    expect(write.status).toBe(403); // the write is denied
    expect(h.violations).toHaveLength(0);
  });

  test("a denied write to an 'absent'-semantics section under fine_grained is NOT a violation", async () => {
    // environments is "absent": the probe-then-write path is expected, so a
    // denied write is answered without a violation.
    const h = await start(scenario({ token_permissions: { environments: "none" } }));
    await call(h, "PUT", `/repos/${OWNER}/${REPO}/environments/prod`, { body: {} });
    expect(h.violations).toHaveLength(0);
  });

  test("a denied write to a 'denied'-semantics section under the WARN policy is NOT a violation", async () => {
    // Under warn there is no preflight (orchestrate gates it on fail), so a
    // "denied"-semantics section whose first apply op is a write legitimately
    // sends it and takes the 403. repository is "denied"; deny it, no violation.
    const h = await start(
      scenario({
        inputs: { on_missing_permission: "warn" },
        token_permissions: { administration: "none" },
      }),
    );
    const res = await call(h, "PATCH", `/repos/${OWNER}/${REPO}`, { body: { description: "x" } });
    expect(res.status).toBe(403); // fine_grained denied write
    const log = h.requests.find((r) => r.method === "PATCH");
    expect(log?.deniedBy).toBe("administration");
    expect(h.violations).toHaveLength(0);
  });

  test("a denied write AFTER a denied read in the same section IS a violation (fail policy)", async () => {
    // Under fail, preflight issues the section's read first. When the read grade
    // is none the read is denied (fatal) and recorded; the apply-pass write then
    // proves broken sequencing. Simulate preflight's read explicitly. labels is
    // used (not repository) so this stays independent of the probe exemption:
    // only the FIRST repository.get is exempt, but labels.list always arms.
    const h = await start(
      scenario({
        inputs: { on_missing_permission: "fail" },
        token_permissions: { issues: "none" },
      }),
    );
    await call(h, "GET", labelsPath); // labels.list denied, fatal
    await call(h, "POST", labelsPath, { body: { name: "x" } });
    expect(h.violations.some((v) => v.includes("should have aborted"))).toBe(true);
  });

  test("the visibility probe (expected, first repository.get) does NOT arm the barrier", async () => {
    // In a redact multi-repo run, an EXPLICIT target's first repository.get is
    // the visibility probe (issued before the target loop). A denied probe must
    // NOT arm: a repository PATCH after it is the section's own legitimate
    // write-then-403, not a sequencing bug.
    const target = "e2e-owner/svc-probe";
    const h = await start(
      scenario({
        inputs: { on_missing_permission: "fail", private_repos: "redact" },
        repos: {
          [target]: {
            settings: { repository: { has_issues: true } },
            permissions: { administration: "none" },
          },
        },
      }),
    );
    await call(h, "GET", `/repos/${target}`); // probe (expected), exempt
    await call(h, "PATCH", `/repos/${target}`, { body: { description: "x" } });
    expect(h.violations).toHaveLength(0);
  });

  test("a LATER denied repository.get (the section's own read) DOES arm the barrier", async () => {
    // The exemption is probe-only: once the probe has been served, a subsequent
    // denied repository.get IS the repository section's check-mode read, so a
    // write after it proves broken sequencing. First call is the probe (exempt),
    // second is the section read (arms), and the PATCH trips it.
    const target = "e2e-owner/svc-probe";
    const h = await start(
      scenario({
        inputs: { on_missing_permission: "fail", private_repos: "redact" },
        repos: {
          [target]: {
            settings: { repository: { has_issues: true } },
            permissions: { administration: "none" },
          },
        },
      }),
    );
    await call(h, "GET", `/repos/${target}`); // probe (expected), exempt
    await call(h, "GET", `/repos/${target}`); // section read, arms
    await call(h, "PATCH", `/repos/${target}`, { body: { description: "x" } });
    expect(h.violations.some((v) => v.includes("should have aborted"))).toBe(true);
  });

  test("NO probe under private-repos: show - the first repository.get arms the barrier", async () => {
    // show never probes, so the first repository.get IS the section's check-mode
    // read and must arm. A blanket first-repository.get exemption would wrongly
    // hide this denied-read-then-write regression.
    const target = "e2e-owner/svc-show";
    const h = await start(
      scenario({
        inputs: { on_missing_permission: "fail", private_repos: "show" },
        repos: {
          [target]: {
            settings: { repository: { has_issues: true } },
            permissions: { administration: "none" },
          },
        },
      }),
    );
    await call(h, "GET", `/repos/${target}`); // section read (no probe), arms
    await call(h, "PATCH", `/repos/${target}`, { body: { description: "x" } });
    expect(h.violations.some((v) => v.includes("should have aborted"))).toBe(true);
  });

  test("NO probe for the admin repo (self carve-out) - the first repository.get arms", async () => {
    // The self carve-out never probes GITHUB_REPOSITORY (e2e-owner/e2e-repo), so
    // targeting it in a redact multi-run makes its first repository.get a section
    // read that must arm.
    const h = await start(
      scenario({
        inputs: { on_missing_permission: "fail", private_repos: "redact" },
        repos: {
          [`${OWNER}/${REPO}`]: {
            settings: { repository: { has_issues: true } },
            permissions: { administration: "none" },
          },
        },
      }),
    );
    await call(h, "GET", `/repos/${OWNER}/${REPO}`); // section read (self, no probe), arms
    await call(h, "PATCH", `/repos/${OWNER}/${REPO}`, { body: { description: "x" } });
    expect(h.violations.some((v) => v.includes("should have aborted"))).toBe(true);
  });

  test("NO probe for a discovery-supplied slug - the first repository.get arms", async () => {
    // A slug whose visibility came from /user/repos discovery is never probed, so
    // its first repository.get is the section read and must arm - even in a redact
    // run.
    const target = "e2e-owner/disc-x";
    const h = await start(
      scenario({
        inputs: { on_missing_permission: "fail", private_repos: "redact" },
        discovery: { pool: [{ slug: target, visibility: "private" }], inputs: {} },
        repos: {
          [target]: {
            settings: { repository: { has_issues: true } },
            permissions: { administration: "none" },
          },
        },
      }),
    );
    await call(h, "GET", `/repos/${target}`); // section read (discovered, no probe), arms
    await call(h, "PATCH", `/repos/${target}`, { body: { description: "x" } });
    expect(h.violations.some((v) => v.includes("should have aborted"))).toBe(true);
  });

  test("a faulted probe retry is still the probe (exempt), not a section read", async () => {
    // A rate-limited probe returns 403-throttle before delivering, so the slug is
    // NOT marked seen; the retry is still the probe and stays exempt. Without the
    // "mark seen only after the fault barrier" rule, the retry would be misread as
    // the section read and the following PATCH would false-flag.
    const target = "e2e-owner/svc-fault";
    const h = await start(
      scenario({
        inputs: { on_missing_permission: "fail", private_repos: "redact" },
        repos: {
          [target]: {
            settings: { repository: { has_issues: true } },
            permissions: { administration: "none" },
          },
        },
      }),
      { faults: [{ key: "repository.get", kind: "rate_limit_403", times: 1 }] },
    );
    await call(h, "GET", `/repos/${target}`); // faulted probe (throttle), not delivered
    await call(h, "GET", `/repos/${target}`); // probe retry, still exempt
    await call(h, "PATCH", `/repos/${target}`, { body: { description: "x" } });
    expect(h.violations).toHaveLength(0);
  });

  test("an ALL-faulting probe exhausts its budget; the section read then arms", async () => {
    // If EVERY probe attempt faults, the probe never delivers and gives up after
    // its retry budget (3 wire attempts). The exemption must expire there: the
    // next repository.get is the section's own denied read, and a write after it
    // MUST arm the barrier. Faulting the first 3 repository.get (the probe's whole
    // budget) leaves the 4th - the section read - delivered and denied.
    const target = "e2e-owner/svc-allfault";
    const h = await start(
      scenario({
        inputs: { on_missing_permission: "fail", private_repos: "redact" },
        repos: {
          [target]: {
            settings: { repository: { has_issues: true } },
            permissions: { administration: "none" },
          },
        },
      }),
      { faults: [{ key: "repository.get", kind: "rate_limit_403", times: 3 }] },
    );
    await call(h, "GET", `/repos/${target}`); // probe attempt 1 (faulted)
    await call(h, "GET", `/repos/${target}`); // probe attempt 2 (faulted)
    await call(h, "GET", `/repos/${target}`); // probe attempt 3 (faulted) - budget spent
    await call(h, "GET", `/repos/${target}`); // section read, delivered + denied, ARMS
    await call(h, "PATCH", `/repos/${target}`, { body: { description: "x" } });
    expect(h.violations.some((v) => v.includes("should have aborted"))).toBe(true);
  });

  test("a first-op denied write under WARN + uniform 403 style is NOT a violation", async () => {
    // Under warn there is no preflight in EITHER denial style; a section whose
    // first apply operation is a write legitimately sends it. Fuzz seed
    // 2151064002 found the old rule flagging this.
    const h = await start(
      scenario({
        denial_style: 403,
        inputs: { on_missing_permission: "warn" },
        token_permissions: { administration: "none" },
      }),
    );
    const res = await call(h, "PATCH", `/repos/${OWNER}/${REPO}`, { body: { description: "x" } });
    expect(res.status).toBe(403);
    expect(h.violations).toHaveLength(0);
  });

  test("a denied write AFTER a denied read in the same section is a violation (warn policy too)", async () => {
    // The engine aborts a section at a hard-denied read, so a later write for
    // that section proves broken sequencing even under warn.
    const h = await start(
      scenario({
        denial_style: 403,
        inputs: { on_missing_permission: "warn" },
        token_permissions: { issues: "none" },
      }),
    );
    await call(h, "GET", labelsPath); // denied read, not tolerated (403)
    await call(h, "POST", labelsPath, { body: { name: "x" } });
    expect(h.violations.some((v) => v.includes("should have aborted"))).toBe(true);
  });

  test("a tolerated fine_grained 404 read does not arm the write barrier", async () => {
    // environments' probe tolerates 404, so the engine reads the denial as
    // "absent" and legitimately writes; the barrier must not fire.
    const h = await start(
      scenario({
        inputs: { on_missing_permission: "warn" },
        token_permissions: { environments: "none" },
      }),
    );
    await call(h, "GET", `/repos/${OWNER}/${REPO}/environments/prod`); // 404, tolerated
    await call(h, "PUT", `/repos/${OWNER}/${REPO}/environments/prod`, { body: {} });
    expect(h.violations).toHaveLength(0);
  });

  test("a denied write does not mutate state (invariant holds under warn too)", async () => {
    const h = await start(
      scenario({
        inputs: { on_missing_permission: "warn" },
        token_permissions: { issues: "read" },
      }),
    );
    await call(h, "POST", labelsPath, { body: { name: "x" } });
    expect(singleState(h).labels).toHaveLength(0);
  });
});

describe("check-mode barrier", () => {
  test("any non-GET in check mode is a violation", async () => {
    const h = await start(scenario({ inputs: { mode: "check" } }));
    const res = await call(h, "POST", labelsPath, { body: { name: "x" } });
    expect(res.status).toBe(400);
    expect((await json(res)).message).toContain("write in check mode");
    expect(h.violations.some((v) => v === "write in check mode")).toBe(true);
  });

  test("a faulted write in check mode is STILL a check-mode violation (barrier runs before faults)", async () => {
    // The check-mode barrier runs before the fault barrier, so a synthetic fault
    // cannot mask the write the engine should never have sent in check mode.
    const h = await start(scenario({ inputs: { mode: "check" } }), {
      faults: [{ key: "labels.create", kind: "rate_limit_403" }],
    });
    const res = await call(h, "POST", labelsPath, { body: { name: "x" } });
    expect(res.status).toBe(400); // the check-mode violation, not the 403 fault
    expect(h.violations.some((v) => v === "write in check mode")).toBe(true);
  });

  test("a GET in check mode is allowed", async () => {
    const h = await start(scenario({ inputs: { mode: "check" } }));
    const res = await call(h, "GET", labelsPath);
    expect(res.status).toBe(200);
    expect(h.violations).toHaveLength(0);
  });

  test("enterCheckMode() arms the barrier on an apply-mode server (convergence re-run)", async () => {
    // The server was built with an apply-mode scenario, so a write is allowed
    // at first. After enterCheckMode(), a subsequent write is a violation -
    // this is what the runner calls before the convergence re-run.
    const h = await start(scenario());
    const before = await call(h, "POST", labelsPath, { body: { name: "first" } });
    expect(before.status).toBe(201);
    expect(h.violations).toHaveLength(0);

    h.enterCheckMode();
    const after = await call(h, "POST", labelsPath, { body: { name: "second" } });
    expect(after.status).toBe(400);
    expect(h.violations.some((v) => v === "write in check mode")).toBe(true);
    // A GET still works after entering check mode.
    expect((await call(h, "GET", labelsPath)).status).toBe(200);
  });
});

describe("route matching and wire contract", () => {
  test("an unhandled route is a violation naming method, path, routes.ts", async () => {
    const h = await start(scenario());
    const res = await call(h, "GET", `/repos/${OWNER}/${REPO}/nonexistent`);
    expect(res.status).toBe(400);
    const message = (await json(res)).message as string;
    expect(message).toContain("E2E MOCK VIOLATION:");
    expect(message).toContain("routes.ts");
    expect(h.violations).toHaveLength(1);
  });

  test("a missing Authorization header is a violation", async () => {
    const h = await start(scenario());
    const res = await fetch(`${h.url}${labelsPath}`, {
      method: "GET",
      headers: { "x-github-api-version": "2022-11-28" },
    });
    expect(res.status).toBe(400);
    expect((await json(res)).message).toContain("Authorization header");
    expect(h.violations.some((v) => v.includes("Authorization"))).toBe(true);
  });

  test("a missing api-version header is a violation", async () => {
    const h = await start(scenario());
    const res = await fetch(`${h.url}${labelsPath}`, {
      method: "GET",
      headers: { authorization: "Bearer t" },
    });
    expect(res.status).toBe(400);
    expect((await json(res)).message).toContain("x-github-api-version");
  });

  test("the repo probe is served by the repository.get section endpoint", async () => {
    // GET /repos/{owner}/{repo} matches a section endpoint, so it never reaches
    // handleCorePath (which no longer carries a dead repo-probe branch).
    const h = await start(scenario());
    const res = await call(h, "GET", `/repos/${OWNER}/${REPO}`);
    expect(res.status).toBe(200);
    expect((await json(res)).name).toBe(REPO);
    expect(h.violations).toHaveLength(0);
  });

  test("the contents core path answers a not-implemented violation", async () => {
    const h = await start(scenario());
    // The real settings fetch hits a nested path (.github/settings.yml); the
    // contents match is prefix-based so a multi-segment {path} still routes.
    const res = await call(h, "GET", `/repos/${OWNER}/${REPO}/contents/.github/settings.yml`);
    expect(res.status).toBe(400);
    expect(h.violations.some((v) => v.includes("not implemented"))).toBe(true);
  });
});

describe("GHES base prefix", () => {
  test("the handle url carries the prefix, and a prefixed request matches", async () => {
    const h = await start(scenario(), { basePrefix: "/api/v3" });
    // The prefix is baked into h.url, so the client appends nothing extra.
    expect(h.url.endsWith("/api/v3")).toBe(true);
    const res = await call(h, "GET", `/repos/${OWNER}/${REPO}/labels`);
    expect(res.status).toBe(200);
    expect(h.violations).toHaveLength(0);
    // The logged pathname has the prefix stripped.
    expect(h.requests[0]?.pathname).toBe(labelsPath);
  });

  test("a request missing the required prefix is a violation", async () => {
    const h = await start(scenario(), { basePrefix: "/api/v3" });
    // Hit the raw base (prefix removed) so the request arrives without it.
    const rawBase = h.url.replace("/api/v3", "");
    const res = await fetch(`${rawBase}${labelsPath}`, { method: "GET", headers: AUTH });
    expect(res.status).toBe(400);
    expect(h.violations.some((v) => v.includes("base prefix"))).toBe(true);
  });
});

describe("workflows envelope", () => {
  test("the list wraps in {total_count, workflows}", async () => {
    const h = await start(
      scenario({
        live_state: {
          workflows: [{ id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" }],
        },
      }),
    );
    const body = await json(await call(h, "GET", `/repos/${OWNER}/${REPO}/actions/workflows`));
    expect(body.total_count).toBe(1);
    expect(body.workflows).toHaveLength(1);
  });
});

describe("writes mutate state", () => {
  test("a label create then list sees the new label", async () => {
    const h = await start(scenario());
    const created = await call(h, "POST", labelsPath, {
      body: { name: "feature", color: "00ff00" },
    });
    expect(created.status).toBe(201);
    const list = await jsonArray(await call(h, "GET", labelsPath));
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("feature");
    expect(singleState(h).labels).toHaveLength(1);
  });

  test("a branch protection PUT stores the flattened GET shape; DELETE clears it", async () => {
    const h = await start(scenario());
    const branch = `/repos/${OWNER}/${REPO}/branches/main/protection`;
    await call(h, "PUT", branch, { body: { enforce_admins: true, restrictions: null } });
    const get = await json(await call(h, "GET", branch));
    expect(get.enforce_admins).toEqual({ enabled: true });
    await call(h, "DELETE", branch);
    const after = await call(h, "GET", branch);
    expect(after.status).toBe(404);
  });

  test("a label update renames the stored key", async () => {
    const h = await start(
      scenario({ live_state: { labels: [{ id: 1, name: "old", color: "ccc" }] } }),
    );
    await call(h, "PATCH", `${labelsPath}/old`, { body: { new_name: "new" } });
    const list = await jsonArray(await call(h, "GET", labelsPath));
    expect(list[0]?.name).toBe("new");
  });
});

describe("actions selected-actions 409", () => {
  test("GET selected-actions answers 409 when the policy is not 'selected'", async () => {
    const h = await start(
      scenario({ live_state: { actions_permissions: { allowed_actions: "all" } } }),
    );
    const res = await call(
      h,
      "GET",
      `/repos/${OWNER}/${REPO}/actions/permissions/selected-actions`,
    );
    expect(res.status).toBe(409);
  });

  test("GET selected-actions answers 200 when the policy is 'selected'", async () => {
    const h = await start(
      scenario({
        live_state: {
          actions_permissions: { allowed_actions: "selected" },
          selected_actions: { github_owned_allowed: true },
        },
      }),
    );
    const res = await call(
      h,
      "GET",
      `/repos/${OWNER}/${REPO}/actions/permissions/selected-actions`,
    );
    expect(res.status).toBe(200);
  });
});

describe("code-scanning 200-vs-202 rule", () => {
  test("a payload changing languages answers 202 with run_id; else 200 with an empty body", async () => {
    const h = await start(
      scenario({ live_state: { code_scanning: { state: "configured", languages: ["python"] } } }),
    );
    const path = `/repos/${OWNER}/${REPO}/code-scanning/default-setup`;
    const changed = await call(h, "PATCH", path, { body: { languages: ["javascript"] } });
    expect(changed.status).toBe(202);
    expect((await json(changed)).run_id).toBeDefined();

    const same = await call(h, "PATCH", path, { body: { state: "configured" } });
    expect(same.status).toBe(200);
    // The spec's 200 body is an empty object (additionalProperties: false), NOT
    // the stored config - so the handler returns {}.
    expect(await json(same)).toEqual({});
  });
});

describe("logged response bodies are snapshots, not live-state aliases", () => {
  test("a later mutation does not retroactively rewrite an earlier logged body", async () => {
    // repository.get returns the live state.repo; a subsequent repository.update
    // Object.assigns into that same object. If the log kept a reference, the GET
    // entry's body would reflect the later PATCH. structuredClone prevents that.
    const h = await start(scenario());
    await call(h, "GET", `/repos/${OWNER}/${REPO}`);
    await call(h, "PATCH", `/repos/${OWNER}/${REPO}`, { body: { description: "changed-after" } });
    const getLog = h.requests.find(
      (r) => r.method === "GET" && r.pathname === `/repos/${OWNER}/${REPO}`,
    );
    // The GET's logged body must show the ORIGINAL description, not the PATCH's.
    expect((getLog?.responseBody as Record<string, unknown>)?.description).not.toBe(
      "changed-after",
    );
  });
});

describe("chaos hook", () => {
  test("invalid_json corrupts the first response only", async () => {
    const h = await start(scenario(), { corrupt: { key: "labels.list", mode: "invalid_json" } });
    const first = await call(h, "GET", labelsPath);
    await expect(first.json()).rejects.toThrow();
    // The second response is clean JSON again.
    const second = await call(h, "GET", labelsPath);
    expect(await second.json()).toEqual([]);
  });

  test("missing_envelope strips the workflows list wrapper", async () => {
    const h = await start(
      scenario({
        live_state: {
          workflows: [{ id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" }],
        },
      }),
      { corrupt: { key: "workflows.list", mode: "missing_envelope" } },
    );
    const body = await json(await call(h, "GET", `/repos/${OWNER}/${REPO}/actions/workflows`));
    expect(body.workflows).toBeUndefined();
    expect(body.total_count).toBe(1);
  });

  test("times defaults to 1: only the first response is corrupt, the follow-up is real", async () => {
    const h = await start(scenario(), { corrupt: { key: "labels.list", mode: "invalid_json" } });
    await expect((await call(h, "GET", labelsPath)).json()).rejects.toThrow();
    // The second request serves the real (empty) labels list.
    expect(await jsonArray(await call(h, "GET", labelsPath))).toEqual([]);
  });

  test('times: "always" corrupts every response', async () => {
    const h = await start(scenario(), {
      corrupt: { key: "labels.list", mode: "invalid_json", times: "always" },
    });
    for (let i = 0; i < 4; i++) {
      await expect((await call(h, "GET", labelsPath)).json()).rejects.toThrow();
    }
  });

  test("times: N corrupts the first N responses then serves real ones", async () => {
    const h = await start(scenario(), {
      corrupt: { key: "labels.list", mode: "invalid_json", times: 3 },
    });
    for (let i = 0; i < 3; i++) {
      await expect((await call(h, "GET", labelsPath)).json()).rejects.toThrow();
    }
    expect(await jsonArray(await call(h, "GET", labelsPath))).toEqual([]);
  });
});

describe("handler statuses obey the realism rule", () => {
  // The rule (statusAllowed): a handler may answer any DECLARED status plus any
  // UNdeclared error status (>= 400); an undeclared 2xx/3xx is forbidden. This
  // drives EVERY handler branch - success AND the error branches (missing
  // resource 404s, the pages-already-enabled 422, the selected-actions 409),
  // and every repository security toggle (get/put/remove, enabled and absent) -
  // not just happy paths, so a handler inventing an undeclared success fails.
  test("every handler branch returns an allowed status", async () => {
    const h = await start(
      scenario({
        live_state: {
          labels: [{ id: 1, name: "bug", color: "d73a4a" }],
          rulesets: [{ id: 42, name: "main", source_type: "Repository" }],
          autolinks: [{ id: 5, key_prefix: "T-", url_template: "https://x/<num>" }],
          workflows: [{ id: 9, name: "CI", path: ".github/workflows/ci.yml", state: "active" }],
          collaborators: [{ login: "carol", role_name: "write" }],
          milestones: [{ number: 1, title: "v1", state: "open" }],
          environments: { prod: { name: "prod", protection_rules: [] } },
          teams: { reviewers: { role_name: "write" } },
          pages: { url: "u", source: { branch: "main", path: "/" } },
          actions_permissions: { allowed_actions: "selected" },
          selected_actions: { github_owned_allowed: true },
          branch_protection: { main: { enforce_admins: { enabled: true } } },
          branches: ["main"],
          // Security toggles start enabled so the GET/enabled branch is hit;
          // the "absent" GET branch is exercised by a second server below.
          repo: {
            vulnerability_alerts_enabled: true,
            automated_security_fixes_enabled: true,
            private_vulnerability_reporting_enabled: true,
          },
        },
      }),
    );
    // (key, method, path, body?) tuples. Ordering matters where one call sets
    // up another (e.g. a create before the list, a remove last).
    const cases: Array<[string, string, string, unknown?]> = [
      // repository core + all three security toggles (enabled GET, put, remove)
      ["repository.get", "GET", `/repos/${OWNER}/${REPO}`],
      ["repository.update", "PATCH", `/repos/${OWNER}/${REPO}`, { description: "x" }],
      ["repository.topics", "PUT", `/repos/${OWNER}/${REPO}/topics`, { names: ["a"] }],
      ["repository.vulnerabilityAlertsGet", "GET", `/repos/${OWNER}/${REPO}/vulnerability-alerts`],
      ["repository.vulnerabilityAlertsPut", "PUT", `/repos/${OWNER}/${REPO}/vulnerability-alerts`],
      [
        "repository.vulnerabilityAlertsRemove",
        "DELETE",
        `/repos/${OWNER}/${REPO}/vulnerability-alerts`,
      ],
      [
        "repository.automatedSecurityFixesGet",
        "GET",
        `/repos/${OWNER}/${REPO}/automated-security-fixes`,
      ],
      [
        "repository.automatedSecurityFixesPut",
        "PUT",
        `/repos/${OWNER}/${REPO}/automated-security-fixes`,
      ],
      [
        "repository.automatedSecurityFixesRemove",
        "DELETE",
        `/repos/${OWNER}/${REPO}/automated-security-fixes`,
      ],
      [
        "repository.privateVulnerabilityReportingGet",
        "GET",
        `/repos/${OWNER}/${REPO}/private-vulnerability-reporting`,
      ],
      [
        "repository.privateVulnerabilityReportingPut",
        "PUT",
        `/repos/${OWNER}/${REPO}/private-vulnerability-reporting`,
      ],
      [
        "repository.privateVulnerabilityReportingRemove",
        "DELETE",
        `/repos/${OWNER}/${REPO}/private-vulnerability-reporting`,
      ],
      // labels: create, list, update, then the error branches, then remove
      ["labels.create", "POST", labelsPath, { name: "feat" }],
      ["labels.list", "GET", labelsPath],
      ["labels.update", "PATCH", `${labelsPath}/bug`, { color: "fff" }],
      ["labels.update", "PATCH", `${labelsPath}/nonexistent`, { color: "fff" }], // 404 error branch
      ["labels.remove", "DELETE", `${labelsPath}/nonexistent`], // 404 error branch
      ["labels.remove", "DELETE", `${labelsPath}/bug`],
      // rulesets: list, get, update, create, plus get/update 404 branches
      ["rulesets.list", "GET", `/repos/${OWNER}/${REPO}/rulesets`],
      ["rulesets.get", "GET", `/repos/${OWNER}/${REPO}/rulesets/42`],
      ["rulesets.get", "GET", `/repos/${OWNER}/${REPO}/rulesets/999`], // 404 error branch
      ["rulesets.update", "PUT", `/repos/${OWNER}/${REPO}/rulesets/42`, { name: "main" }],
      ["rulesets.update", "PUT", `/repos/${OWNER}/${REPO}/rulesets/999`, { name: "x" }], // 404
      ["rulesets.create", "POST", `/repos/${OWNER}/${REPO}/rulesets`, { name: "new" }],
      // branches: get (protected + unprotected 404), put, remove, probe (both)
      ["branches.getProtection", "GET", `/repos/${OWNER}/${REPO}/branches/main/protection`],
      ["branches.getProtection", "GET", `/repos/${OWNER}/${REPO}/branches/dev/protection`], // 404
      [
        "branches.putProtection",
        "PUT",
        `/repos/${OWNER}/${REPO}/branches/dev/protection`,
        { enforce_admins: true },
      ],
      ["branches.removeProtection", "DELETE", `/repos/${OWNER}/${REPO}/branches/main/protection`],
      ["branches.branchProbe", "GET", `/repos/${OWNER}/${REPO}/branches/main`],
      ["branches.branchProbe", "GET", `/repos/${OWNER}/${REPO}/branches/ghost`], // 404 error branch
      // environments: probe (both), update (create + update)
      ["environments.probe", "GET", `/repos/${OWNER}/${REPO}/environments/prod`],
      ["environments.probe", "GET", `/repos/${OWNER}/${REPO}/environments/absent`], // 404
      ["environments.update", "PUT", `/repos/${OWNER}/${REPO}/environments/staging`, {}], // 200 create
      ["environments.update", "PUT", `/repos/${OWNER}/${REPO}/environments/staging`, {}], // 200 update
      // autolinks: list, create, remove (both)
      ["autolinks.list", "GET", `/repos/${OWNER}/${REPO}/autolinks`],
      [
        "autolinks.create",
        "POST",
        `/repos/${OWNER}/${REPO}/autolinks`,
        { key_prefix: "Z-", url_template: "https://z/<num>" },
      ],
      ["autolinks.remove", "DELETE", `/repos/${OWNER}/${REPO}/autolinks/999`], // 404 error branch
      ["autolinks.remove", "DELETE", `/repos/${OWNER}/${REPO}/autolinks/5`],
      // actions: all four get/put pairs (selected GET 200 because policy is selected)
      ["actions.getPermissions", "GET", `/repos/${OWNER}/${REPO}/actions/permissions`],
      [
        "actions.putPermissions",
        "PUT",
        `/repos/${OWNER}/${REPO}/actions/permissions`,
        { enabled: true, allowed_actions: "selected" },
      ],
      [
        "actions.getSelected",
        "GET",
        `/repos/${OWNER}/${REPO}/actions/permissions/selected-actions`,
      ],
      [
        "actions.putSelected",
        "PUT",
        `/repos/${OWNER}/${REPO}/actions/permissions/selected-actions`,
        { github_owned_allowed: true },
      ],
      ["actions.getWorkflow", "GET", `/repos/${OWNER}/${REPO}/actions/permissions/workflow`],
      [
        "actions.putWorkflow",
        "PUT",
        `/repos/${OWNER}/${REPO}/actions/permissions/workflow`,
        { default_workflow_permissions: "read" },
      ],
      ["actions.getAccess", "GET", `/repos/${OWNER}/${REPO}/actions/permissions/access`],
      [
        "actions.putAccess",
        "PUT",
        `/repos/${OWNER}/${REPO}/actions/permissions/access`,
        { access_level: "none" },
      ],
      // workflows: list, enable/disable (both + 404 branches)
      ["workflows.list", "GET", `/repos/${OWNER}/${REPO}/actions/workflows`],
      ["workflows.enable", "PUT", `/repos/${OWNER}/${REPO}/actions/workflows/9/enable`],
      ["workflows.disable", "PUT", `/repos/${OWNER}/${REPO}/actions/workflows/9/disable`],
      ["workflows.enable", "PUT", `/repos/${OWNER}/${REPO}/actions/workflows/999/enable`], // 404
      ["workflows.disable", "PUT", `/repos/${OWNER}/${REPO}/actions/workflows/999/disable`], // 404
      // pages: get, update, then remove (get-after-remove 404 covered elsewhere)
      ["pages.get", "GET", `/repos/${OWNER}/${REPO}/pages`],
      ["pages.update", "PUT", `/repos/${OWNER}/${REPO}/pages`, { cname: "x" }],
      ["pages.remove", "DELETE", `/repos/${OWNER}/${REPO}/pages`],
      // code-scanning: get, update 200 (no language change)
      [
        "code_scanning_default_setup.get",
        "GET",
        `/repos/${OWNER}/${REPO}/code-scanning/default-setup`,
      ],
      [
        "code_scanning_default_setup.update",
        "PATCH",
        `/repos/${OWNER}/${REPO}/code-scanning/default-setup`,
        { state: "configured" },
      ],
      // collaborators: list, update (upsert new = 201), remove (both)
      ["collaborators.list", "GET", `/repos/${OWNER}/${REPO}/collaborators`],
      [
        "collaborators.update",
        "PUT",
        `/repos/${OWNER}/${REPO}/collaborators/dave`,
        { permission: "push" },
      ],
      ["collaborators.remove", "DELETE", `/repos/${OWNER}/${REPO}/collaborators/ghost`], // no-op 204
      ["collaborators.remove", "DELETE", `/repos/${OWNER}/${REPO}/collaborators/carol`],
      // teams: org, probe (both), grant
      ["teams.org", "GET", `/orgs/${OWNER}`],
      ["teams.probe", "GET", `/orgs/${OWNER}/teams/reviewers/repos/${OWNER}/${REPO}`],
      ["teams.probe", "GET", `/orgs/${OWNER}/teams/absent/repos/${OWNER}/${REPO}`], // 404
      [
        "teams.grant",
        "PUT",
        `/orgs/${OWNER}/teams/newteam/repos/${OWNER}/${REPO}`,
        { permission: "push" },
      ],
      // milestones: list, create, update (both + 404 branch)
      ["milestones.list", "GET", `/repos/${OWNER}/${REPO}/milestones`],
      ["milestones.create", "POST", `/repos/${OWNER}/${REPO}/milestones`, { title: "v2" }],
      ["milestones.update", "PATCH", `/repos/${OWNER}/${REPO}/milestones/1`, { state: "closed" }],
      ["milestones.update", "PATCH", `/repos/${OWNER}/${REPO}/milestones/999`, { state: "x" }], // 404
    ];
    for (const [key, method, path, body] of cases) {
      const res = await call(h, method, path, body === undefined ? {} : { body });
      if (!statusAllowed(key, res.status)) {
        throw new Error(
          `handler ${key} returned status ${res.status}, which is neither declared [${[...declaredStatuses(key)].join(", ")}] nor a >= 400 error status`,
        );
      }
    }
    // None of these are permission-denied or check-mode writes, so no request
    // should have raised a mock violation.
    expect(h.violations).toHaveLength(0);
  });

  test("security-toggle GET returns an allowed status when the feature is absent", async () => {
    // A second server with the toggles unset exercises the "not enabled"
    // branches: vulnerability-alerts 404, automated-security-fixes 404,
    // private-vulnerability-reporting 200 (enabled: false).
    const h = await start(scenario());
    const branches: Array<[string, string]> = [
      ["repository.vulnerabilityAlertsGet", `/repos/${OWNER}/${REPO}/vulnerability-alerts`],
      ["repository.automatedSecurityFixesGet", `/repos/${OWNER}/${REPO}/automated-security-fixes`],
      [
        "repository.privateVulnerabilityReportingGet",
        `/repos/${OWNER}/${REPO}/private-vulnerability-reporting`,
      ],
    ];
    for (const [key, path] of branches) {
      const res = await call(h, "GET", path);
      expect(statusAllowed(key, res.status)).toBe(true);
    }
  });

  test("pages create answers an allowed status when a site already exists", async () => {
    // The pages.create 422 conflict branch: create declares only 201, so the
    // 422 must pass by the >= 400 error allowance, never as an undeclared 2xx.
    const h = await start(scenario({ live_state: { pages: { url: "u" } } }));
    const res = await call(h, "POST", `/repos/${OWNER}/${REPO}/pages`, {
      body: { source: { branch: "main", path: "/" } },
    });
    expect(res.status).toBe(422);
    expect(statusAllowed("pages.create", res.status)).toBe(true);
  });
});

describe("pages create on empty state", () => {
  test("POST /pages creates the site (201) when none exists", async () => {
    const h = await start(scenario({ live_state: { pages: null } }));
    const res = await call(h, "POST", `/repos/${OWNER}/${REPO}/pages`, {
      body: { source: { branch: "main", path: "/" } },
    });
    expect(res.status).toBe(201);
    expect(singleState(h).pages).not.toBeNull();
  });
});

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
    expect(h.multi).toBeDefined();
    expect(h.state).toBeUndefined();
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

describe("fault injection", () => {
  test("rate_limit_403 answers 403 with a rate-limit body, then normal", async () => {
    const h = await start(scenario(), {
      faults: [{ key: "labels.list", kind: "rate_limit_403" }],
    });
    const faulted = await call(h, "GET", labelsPath);
    expect(faulted.status).toBe(403);
    // The body says "rate limit" (this is the ONLY place a 403 may) so the
    // client classifies it as throttling, not a permission denial.
    expect((await faulted.text()).toLowerCase()).toContain("rate limit");
    // The fault fired once (default times: 1); the next request is served.
    const normal = await call(h, "GET", labelsPath);
    expect(normal.status).toBe(200);
  });

  test("times: N applies the fault to the first N matching requests", async () => {
    const h = await start(scenario(), {
      faults: [{ key: "labels.list", kind: "rate_limit_403", times: 2 }],
    });
    expect((await call(h, "GET", labelsPath)).status).toBe(403);
    expect((await call(h, "GET", labelsPath)).status).toBe(403);
    expect((await call(h, "GET", labelsPath)).status).toBe(200);
  });

  test("429_then_200 answers 429 with Retry-After: 0, then serves the handler", async () => {
    const h = await start(scenario(), {
      faults: [{ key: "labels.list", kind: "429_then_200" }],
    });
    const faulted = await call(h, "GET", labelsPath);
    expect(faulted.status).toBe(429);
    expect(faulted.headers.get("retry-after")).toBe("0");
    const retried = await call(h, "GET", labelsPath);
    expect(retried.status).toBe(200);
  });

  test("connection_drop does not serve the real response and logs the attempt (status 0)", async () => {
    const h = await start(scenario({ live_state: { labels: [{ id: 1, name: "real" }] } }), {
      faults: [{ key: "labels.list", kind: "connection_drop" }],
    });
    // The mid-response abort is the drop: the client never receives the real
    // labels list. Bun's in-process fetch cannot observe the connection-level
    // failure the way undici does over a socket (the true client-visible reject
    // is proven end-to-end by labels-network-drop), so the reliable in-process
    // signals are: the attempt is logged with status 0, and the body is NOT the
    // served list.
    const res = await call(h, "GET", labelsPath);
    expect(res.status).not.toBe(200);
    expect(h.requests.some((r) => r.status === 0)).toBe(true);
    // The fault fires once, so the next request serves the real list.
    const normal = await jsonArray(await call(h, "GET", labelsPath));
    expect(normal.map((l) => l.name)).toEqual(["real"]);
  });

  test("a fault only fires for its named endpoint", async () => {
    const h = await start(scenario(), {
      faults: [{ key: "labels.list", kind: "rate_limit_403" }],
    });
    // A different endpoint is unaffected.
    expect((await call(h, "GET", `/repos/${OWNER}/${REPO}/milestones`)).status).toBe(200);
  });

  test("a fault/corrupt naming an unknown endpoint throws at construction", async () => {
    await expect(
      startMockServer(scenario(), { faults: [{ key: "labels.nope", kind: "rate_limit_403" }] }),
    ).rejects.toThrow(/unknown endpoint/);
    await expect(
      startMockServer(scenario(), { corrupt: { key: "ghost.list", mode: "invalid_json" } }),
    ).rejects.toThrow(/unknown endpoint/);
  });

  test("duplicate fault entries for one endpoint throw at construction", async () => {
    await expect(
      startMockServer(scenario(), {
        faults: [
          { key: "labels.list", kind: "rate_limit_403" },
          { key: "labels.list", kind: "connection_drop" },
        ],
      }),
    ).rejects.toThrow(/duplicate fault/);
  });

  test("assertFaultKeys accepts valid keys and rejects unknown/duplicate directly", () => {
    expect(() =>
      assertFaultKeys([{ key: "labels.list", kind: "rate_limit_403" }], undefined),
    ).not.toThrow();
    expect(() => assertFaultKeys([{ key: "bogus", kind: "rate_limit_403" }], undefined)).toThrow(
      /unknown endpoint/,
    );
  });
});

describe("state-flag gaps", () => {
  test("code-scanning update answers 409 when a run is in progress", async () => {
    const h = await start(
      scenario({
        live_state: { code_scanning: { state: "configured", configuration_run_in_progress: true } },
      }),
    );
    const res = await call(h, "PATCH", `/repos/${OWNER}/${REPO}/code-scanning/default-setup`, {
      body: { state: "configured", languages: ["javascript"] },
    });
    expect(res.status).toBe(409);
  });

  test("code-scanning update applies (202) without the in-progress flag", async () => {
    const h = await start(scenario({ live_state: { code_scanning: { state: "configured" } } }));
    const applied = await call(h, "PATCH", `/repos/${OWNER}/${REPO}/code-scanning/default-setup`, {
      body: { languages: ["javascript"] },
    });
    expect(applied.status).toBe(202);
  });

  test("private-vulnerability-reporting GET/DELETE answer 404 when not applicable", async () => {
    const h = await start(
      scenario({
        live_state: { repo: { private_vulnerability_reporting_not_applicable: true } },
      }),
    );
    const get = await call(h, "GET", `/repos/${OWNER}/${REPO}/private-vulnerability-reporting`);
    expect(get.status).toBe(404);
    const del = await call(h, "DELETE", `/repos/${OWNER}/${REPO}/private-vulnerability-reporting`);
    expect(del.status).toBe(404);
    expect(h.violations).toHaveLength(0);
  });

  test("PVR GET answers 200 when applicable (flag absent)", async () => {
    const h = await start(scenario());
    const get = await call(h, "GET", `/repos/${OWNER}/${REPO}/private-vulnerability-reporting`);
    expect(get.status).toBe(200);
  });
});
