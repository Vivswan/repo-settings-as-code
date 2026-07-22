import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SECTION_KEYS } from "../../src/schema.js";
import {
  call,
  type EndpointDecl,
  endpointKind,
  endpointPath,
  endpointPermission,
  expand,
  grantFor,
  matchesTemplate,
  probeAbsent,
  type SectionContext,
  type SectionMeta,
  type SectionPermission,
  toleratedStatuses,
} from "../../src/sections/contract.js";
import { allEndpoints, SECTIONS } from "../../src/sections/registry.js";

describe("registry <-> README", () => {
  test("the README Sections table lists every section, in order, naming each granted permission", () => {
    const readme = readFileSync("README.md", "utf8");
    const start = readme.indexOf("\n## Sections\n");
    expect(start).toBeGreaterThan(-1);
    const end = readme.indexOf("\n## ", start + 1);
    const section = end === -1 ? readme.slice(start) : readme.slice(start, end);

    // Key from column 1, PAT permission from column 3 (column 2 is Endpoints).
    const rows = [...section.matchAll(/^\| `([a-z_]+)` \| [^|]+ \| ([^|]+) \|/gm)].map((match) => ({
      key: match[1] ?? "",
      permission: match[2] ?? "",
    }));
    // One row per section, in SECTION_KEYS order - a new section without a
    // README row (or a stale row) fails here. The raw line count catches
    // malformed rows the key regex would otherwise skip silently.
    const tableLines = section.split("\n").filter((line) => line.startsWith("|"));
    expect(tableLines).toHaveLength(SECTION_KEYS.length + 2); // header + separator
    expect(rows.map((row) => row.key)).toEqual([...SECTION_KEYS]);

    // Every permission the grant advice names (the quoted words in
    // SectionMeta.grant) must appear in that section's README row, so the
    // table cannot drift from the advice users see in errors.
    for (const module of SECTIONS) {
      const row = rows.find((r) => r.key === module.key);
      const granted = [...module.grant.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
      expect(granted.length).toBeGreaterThan(0);
      for (const name of granted) {
        expect(row?.permission).toContain(name);
      }
    }
  });
});

// The caveat code-scanning appends to its derived grant. Kept here so the
// snapshot below and the derivation check agree on one source of truth.
const CODE_SCANNING_CAVEAT =
  "a 403 on this endpoint can also mean GitHub Advanced Security (code security) is not enabled on the repository, or the repository is archived";

// The exact grant prose each section shows in permission errors, captured
// against the pre-refactor literals. grantFor derives these now, so any
// character-level change is a conscious edit here - not a silent drift.
const EXPECTED_GRANT: Record<string, string> = {
  repository: `grant "Administration" (read and write) under the PAT's Repository permissions`,
  labels: `grant "Issues" (read and write) under the PAT's Repository permissions`,
  rulesets: `grant "Administration" (read and write) under the PAT's Repository permissions`,
  branches: `grant "Administration" (read and write) under the PAT's Repository permissions`,
  environments: `grant "Environments" (read and write) under the PAT's Repository permissions`,
  autolinks: `grant "Administration" (read and write) under the PAT's Repository permissions`,
  actions: `grant "Administration" (read and write) under the PAT's Repository permissions`,
  workflows: `grant "Actions" (read and write) under the PAT's Repository permissions`,
  pages: `grant "Pages" (read and write) under the PAT's Repository permissions`,
  code_scanning_default_setup: `grant "Administration" or "Code scanning alerts" (read and write) under the PAT's Repository permissions; ${CODE_SCANNING_CAVEAT}`,
  collaborators: `grant "Administration" (read and write) under the PAT's Repository permissions`,
  teams: `grant "Members" (read) under the PAT's Organization permissions and "Administration" (read and write) under its Repository permissions`,
  milestones: `grant "Issues" (read and write) under the PAT's Repository permissions`,
};

describe("section permissions", () => {
  test("every registered section declares a permission with at least one repo resource", () => {
    for (const module of SECTIONS) {
      expect(module.permission).toBeDefined();
      expect(module.permission.repo.length).toBeGreaterThan(0);
    }
  });

  test("each section's grant matches grantFor(permission)", () => {
    for (const module of SECTIONS) {
      const caveat =
        module.key === "code_scanning_default_setup" ? CODE_SCANNING_CAVEAT : undefined;
      expect(module.grant).toBe(grantFor(module.permission, caveat));
    }
  });

  test("each section's grant equals its exact pre-refactor literal", () => {
    // A section without an expected literal (a new one) fails here.
    expect(Object.keys(EXPECTED_GRANT).sort()).toEqual([...SECTION_KEYS].sort());
    for (const module of SECTIONS) {
      expect(module.grant).toBe(EXPECTED_GRANT[module.key] ?? "");
    }
  });
});

describe("grantFor", () => {
  test("single repo resource", () => {
    const permission: SectionPermission = { repo: ["administration"] };
    expect(grantFor(permission)).toBe(
      `grant "Administration" (read and write) under the PAT's Repository permissions`,
    );
  });

  test("multiple repo resources with a caveat", () => {
    const permission: SectionPermission = { repo: ["administration", "code_scanning_alerts"] };
    expect(grantFor(permission, CODE_SCANNING_CAVEAT)).toBe(
      `grant "Administration" or "Code scanning alerts" (read and write) under the PAT's Repository permissions; ${CODE_SCANNING_CAVEAT}`,
    );
  });

  test("org variant (teams)", () => {
    const permission: SectionPermission = { repo: ["administration"], org: "members" };
    expect(grantFor(permission)).toBe(
      `grant "Members" (read) under the PAT's Organization permissions and "Administration" (read and write) under its Repository permissions`,
    );
  });
});

describe("section endpoints", () => {
  test("every registered section declares at least one endpoint", () => {
    for (const module of SECTIONS) {
      expect(Object.values(module.endpoints).length).toBeGreaterThan(0);
    }
  });

  test("every declared endpoint is well-formed", () => {
    const methods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
    for (const module of SECTIONS) {
      for (const endpoint of Object.values(module.endpoints)) {
        const [method, path] = endpoint.route.split(" ");
        expect(methods.has(method ?? "")).toBe(true);
        // Absolute path with no query string; only balanced {param} tokens.
        expect(path?.startsWith("/")).toBe(true);
        expect(path).not.toContain("?");
        for (const segment of (path ?? "").split("/").filter(Boolean)) {
          const hasBrace = segment.includes("{") || segment.includes("}");
          if (hasBrace) {
            // A templated segment is exactly one {param} token, nothing else.
            expect(segment).toMatch(/^{[a-z_]+}$/);
          }
        }
        const statusKeys = Object.keys(endpoint.statuses).map(Number);
        expect(statusKeys.length).toBeGreaterThan(0);
        for (const status of statusKeys) {
          expect(status).toBeGreaterThanOrEqual(100);
          expect(status).toBeLessThan(600);
        }
        // Every status carries a non-empty prose meaning.
        for (const meaning of Object.values(endpoint.statuses)) {
          expect(typeof meaning).toBe("string");
          expect(meaning.length).toBeGreaterThan(0);
        }
      }
    }
  });

  test("endpointKind derives read for GET and write for everything else", () => {
    expect(endpointKind({ route: "GET /repos/{owner}/{repo}", statuses: { 200: "x" } })).toBe(
      "read",
    );
    expect(
      endpointKind({ route: "POST /repos/{owner}/{repo}/labels", statuses: { 201: "x" } }),
    ).toBe("write");
    expect(
      endpointKind({ route: "DELETE /repos/{owner}/{repo}/labels/{name}", statuses: { 204: "x" } }),
    ).toBe("write");
  });

  test("toleratedStatuses returns exactly the declared >= 400 statuses", () => {
    expect(
      toleratedStatuses({
        route: "GET /repos/{owner}/{repo}/private-vulnerability-reporting",
        statuses: { 200: "a", 404: "b", 422: "c" },
      }),
    ).toEqual([404, 422]);
    expect(
      toleratedStatuses({
        route: "PATCH /repos/{owner}/{repo}/code-scanning/default-setup",
        statuses: { 200: "a", 202: "b", 409: "c" },
      }),
    ).toEqual([409]);
    // No error statuses declared -> nothing tolerated.
    expect(
      toleratedStatuses({
        route: "DELETE /repos/{owner}/{repo}/labels/{name}",
        statuses: { 204: "a" },
      }),
    ).toEqual([]);
  });

  test("every section's tolerated statuses are a subset of its declared statuses", () => {
    // Trivially true by construction, but this pins the invariant the
    // helpers rely on: tolerances are derived from statuses, never wider.
    for (const module of SECTIONS) {
      for (const endpoint of Object.values(module.endpoints)) {
        const declared = new Set(Object.keys(endpoint.statuses).map(Number));
        for (const status of toleratedStatuses(endpoint)) {
          expect(declared.has(status)).toBe(true);
          expect(status).toBeGreaterThanOrEqual(400);
        }
      }
    }
  });

  test("only branches.branchProbe and teams.org carry a permission override", () => {
    // An override equal to the section permission would be redundant; this
    // guards against redundant or stray overrides creeping in. Exactly two
    // endpoints in the whole registry legitimately override.
    const overridden = Object.entries(allEndpoints())
      .filter(([, endpoint]) => endpoint.permission !== undefined)
      .map(([key]) => key);
    expect(overridden.sort()).toEqual(["branches.branchProbe", "teams.org"]);
  });

  test("endpointPermission resolves override, else section permission", () => {
    const section: SectionMeta = {
      key: "branches",
      permission: { repo: ["administration"] },
      grant: "grant",
      endpoints: {},
      deletesUndeclared: "untouched",
    };
    // No override -> the section's permission.
    expect(
      endpointPermission(section, { route: "GET /repos/{owner}/{repo}", statuses: { 200: "x" } }),
    ).toEqual({ repo: ["administration"] });
    // A repo override wins.
    expect(
      endpointPermission(section, {
        route: "GET /repos/{owner}/{repo}/branches/{branch}",
        statuses: { 200: "x" },
        permission: { repo: ["contents"] },
      }),
    ).toEqual({ repo: ["contents"] });
    // "none" (public) wins.
    expect(
      endpointPermission(section, {
        route: "GET /orgs/{org}",
        statuses: { 200: "x" },
        permission: "none",
      }),
    ).toBe("none");
  });
});

describe("allEndpoints", () => {
  test("flattens every section endpoint under a unique section.role key", () => {
    const all = allEndpoints();
    const keys = Object.keys(all);
    // At least one entry per section, and 55+ overall.
    expect(keys.length).toBeGreaterThanOrEqual(55);
    // Every key is ${sectionKey}.${role}; keys are unique by construction.
    for (const key of keys) {
      expect(key).toMatch(/^[a-z_]+\.[a-zA-Z]+$/);
    }
    expect(new Set(keys).size).toBe(keys.length);
    // Each entry is tagged with its owning section and role, and the counts
    // reconcile with the per-section dictionaries.
    let total = 0;
    for (const module of SECTIONS) {
      total += Object.keys(module.endpoints).length;
    }
    expect(keys.length).toBe(total);
    for (const [key, endpoint] of Object.entries(all)) {
      expect(key).toBe(`${endpoint.section}.${endpoint.role}`);
      expect(endpoint.statuses).toBeDefined();
    }
  });

  test("the returned view is frozen so a consumer cannot corrupt declarations", () => {
    const all = allEndpoints();
    const entry = all["labels.update"];
    expect(entry).toBeDefined();
    expect(Object.isFrozen(all)).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry?.statuses)).toBe(true);
    // A mutation attempt through the view throws in strict mode (test files
    // are ES modules, hence strict) and leaves the source declaration intact.
    expect(() => {
      (entry as unknown as { role: string }).role = "hacked";
    }).toThrow();
    // The section's own declaration is unchanged.
    const labels = SECTIONS.find((s) => s.key === "labels");
    expect(labels?.endpoints.update?.route).toBe("PATCH /repos/{owner}/{repo}/labels/{name}");
  });
});

describe("typed params (compile-time guards)", () => {
  // These assertions are about the TYPE checker, not runtime; the bodies
  // never execute. A route with a path param must require params; a route
  // without one must forbid them AND allow omitting opts entirely.
  const section = {} as SectionMeta;
  const ctx = {} as SectionContext;
  const withName = {
    route: "PATCH /repos/{owner}/{repo}/labels/{name}",
    statuses: { 200: "x" },
  } satisfies EndpointDecl;
  const noParams = {
    route: "GET /repos/{owner}/{repo}/labels",
    statuses: { 200: "x" },
  } satisfies EndpointDecl;

  test("type guards hold", () => {
    // The assertions below are checked by tsc via @ts-expect-error; the body
    // is guarded by a runtime-false condition so nothing actually executes.
    const neverRuns = false as boolean;
    if (neverRuns) {
      // Omitting opts entirely for a route that needs {name} is a compile error.
      // @ts-expect-error - params argument is required for a {name} route
      void call(ctx, section, withName);
      // Providing opts but omitting params is a compile error.
      // @ts-expect-error - params is required inside opts
      void call(ctx, section, withName, {});
      // The correct call type-checks.
      void call(ctx, section, withName, { params: { name: "bug" } });
      // A token-less route allows omitting opts entirely.
      void call(ctx, section, noParams);
      // ...and forbids a stray params key.
      // @ts-expect-error - a token-less route has no params
      void call(ctx, section, noParams, { params: { name: "bug" } });
    }
    expect(true).toBe(true);
  });
});

describe("matchesTemplate", () => {
  test("every {token} consumes exactly one segment", () => {
    expect(matchesTemplate("/repos/{owner}/{repo}/labels", "/repos/o/r/labels")).toBe(true);
    // A missing segment does not match.
    expect(matchesTemplate("/repos/{owner}/{repo}/labels", "/repos/o/labels")).toBe(false);
    // A trailing segment beyond the template does not match.
    expect(matchesTemplate("/repos/{owner}/{repo}/labels", "/repos/o/r/labels/bug")).toBe(false);
  });

  test("a name param consumes exactly one segment", () => {
    expect(matchesTemplate("/repos/{owner}/{repo}/labels/{name}", "/repos/o/r/labels/bug")).toBe(
      true,
    );
    expect(matchesTemplate("/repos/{owner}/{repo}/labels/{name}", "/repos/o/r/labels/a/b")).toBe(
      false,
    );
  });

  test("the teams path shape matches (org, team_slug, owner, repo)", () => {
    expect(
      matchesTemplate(
        "/orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}",
        "/orgs/acme/teams/core/repos/o/r",
      ),
    ).toBe(true);
  });

  test("literal segments must match exactly", () => {
    expect(matchesTemplate("/repos/{owner}/{repo}/pages", "/repos/o/r/pages")).toBe(true);
    expect(matchesTemplate("/repos/{owner}/{repo}/pages", "/repos/o/r/topics")).toBe(false);
  });

  test("the query string is ignored", () => {
    expect(
      matchesTemplate("/repos/{owner}/{repo}/milestones", "/repos/o/r/milestones?state=all"),
    ).toBe(true);
  });

  test("every declared route path matches its own expanded concrete path", () => {
    // Construction parity: each route template matches the path it expands to.
    const ctx: SectionContext = {
      api: { tryRequest: async () => ({ data: null }) },
      repo: "octo/repo",
      owner: "octo",
      check: false,
    };
    for (const endpoint of Object.values(allEndpoints())) {
      const tokens = [...endpointPath(endpoint.route).matchAll(/{([a-z_]+)}/g)]
        .map((m) => m[1])
        .filter((t) => t !== "owner" && t !== "repo");
      const params = Object.fromEntries(tokens.map((t) => [t as string, "x"]));
      const concrete = expand(endpoint, ctx, params);
      expect(matchesTemplate(endpointPath(endpoint.route), concrete)).toBe(true);
    }
  });
});

describe("expand", () => {
  const ctx = (): SectionContext => ({
    api: { tryRequest: async () => ({ data: null }) },
    repo: "octo/repo",
    owner: "octo",
    check: false,
  });

  test("{owner} and {repo} fill from ctx (repo is the name half)", () => {
    const endpoint: EndpointDecl = {
      route: "GET /repos/{owner}/{repo}/labels",
      statuses: { 200: "x" },
    };
    expect(expand(endpoint, ctx())).toBe("/repos/octo/repo/labels");
  });

  test("a {param} is URL-encoded", () => {
    const endpoint: EndpointDecl = {
      route: "PATCH /repos/{owner}/{repo}/labels/{name}",
      statuses: { 200: "x" },
    };
    expect(expand(endpoint, ctx(), { name: "needs review/100%" })).toBe(
      "/repos/octo/repo/labels/needs%20review%2F100%25",
    );
  });

  test("a missing param throws", () => {
    const endpoint: EndpointDecl = {
      route: "PATCH /repos/{owner}/{repo}/labels/{name}",
      statuses: { 200: "x" },
    };
    expect(() => expand(endpoint, ctx())).toThrow(/needs a "name" param/);
  });

  test("an extra (unused) param throws", () => {
    const endpoint: EndpointDecl = {
      route: "GET /repos/{owner}/{repo}/labels",
      statuses: { 200: "x" },
    };
    expect(() => expand(endpoint, ctx(), { name: "bug" })).toThrow(/unused param/);
  });

  test("a query is appended, encoded", () => {
    const endpoint: EndpointDecl = {
      route: "GET /repos/{owner}/{repo}/milestones",
      statuses: { 200: "x" },
    };
    expect(expand(endpoint, ctx(), undefined, { state: "all" })).toBe(
      "/repos/octo/repo/milestones?state=all",
    );
  });
});

describe("probeAbsent tolerance derivation", () => {
  const section: SectionMeta = {
    key: "repository",
    permission: { repo: ["administration"] },
    grant: "grant",
    endpoints: {},
    deletesUndeclared: "untouched",
  };
  const ctxWith = (status: number): SectionContext => ({
    api: {
      tryRequest: async () => ({ error: { status, message: "nope", body: "" } }),
    },
    repo: "octo/repo",
    owner: "octo",
    check: true,
  });

  test("without an explicit tolerate, a declared >= 400 status reads as missing", async () => {
    // 404 and 422 are declared, so both are tolerated automatically.
    const endpoint = {
      route: "GET /repos/{owner}/{repo}/private-vulnerability-reporting",
      statuses: { 200: "a", 404: "b", 422: "c" },
    } satisfies EndpointDecl;
    expect(await probeAbsent(ctxWith(404), section, endpoint)).toEqual({ missing: true });
    expect(await probeAbsent(ctxWith(422), section, endpoint)).toEqual({ missing: true });
  });

  test("without an explicit tolerate, an undeclared error status throws", async () => {
    // 404 is NOT declared here, so it is a real failure, not "missing".
    const endpoint = {
      route: "GET /repos/{owner}/{repo}/vulnerability-alerts",
      statuses: { 204: "a" },
    } satisfies EndpointDecl;
    await expect(probeAbsent(ctxWith(404), section, endpoint)).rejects.toThrow();
  });
});
