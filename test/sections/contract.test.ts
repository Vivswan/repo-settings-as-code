import { describe, expect, test } from "bun:test";
import { actionsSection } from "../../src/sections/actions/index.js";
import {
  type EndpointDecl,
  endpointKind,
  toleratedStatuses,
} from "../../src/sections/contract/endpoints.js";
import { PermissionDenied, throwFor } from "../../src/sections/contract/errors.js";
import { type GraphqlOpDecl, graphqlOp } from "../../src/sections/contract/graphql.js";
import {
  denialPosture,
  endpointPermission,
  planningReads,
  readGating,
  type SectionMeta,
  sectionGrant,
  sectionOperations,
  writeGatedReads,
} from "../../src/sections/contract/module.js";
import {
  grantFor,
  type SectionPermission,
  samePermission,
} from "../../src/sections/contract/permissions.js";
import { hasDrift, plainData, planContext } from "../../src/sections/contract/plan.js";
import {
  declaredTolerance,
  probeAbsent,
  tryCallDeclared,
} from "../../src/sections/contract/requests.js";
import { environmentsSection } from "../../src/sections/environments/index.js";
import { SECTIONS } from "../../src/sections/registry.js";
import { repositorySection } from "../../src/sections/repository/index.js";
import { rulesetsSection } from "../../src/sections/rulesets/index.js";
import { MockApi } from "../mock-api.js";

const section: SectionMeta = rulesetsSection;

describe("sectionOperations", () => {
  const readOp: GraphqlOpDecl = {
    name: "SyntheticRead",
    kind: "read",
    query: "query SyntheticRead($owner: String!, $repo: String!) { repository { id } }",
    outcomes: { ok: "x" },
  };

  test("flattens BOTH dictionaries, so a GraphQL-read-only section is not read-free", () => {
    // The shape the oracle's NO_READ_SECTIONS derivation must never misread:
    // zero REST endpoints, one GraphQL read. A derivation walking
    // section.endpoints alone would call this section read-free.
    const graphqlOnly: SectionMeta = {
      key: "repository",
      permission: { repo: ["administration"] },
      endpoints: {},
      graphql: { read: readOp },
      undeclaredDefault: "untouched",
    };
    expect(sectionOperations(graphqlOnly)).toEqual([
      {
        role: "read",
        wire: "read",
        grade: "read",
        permission: { repo: ["administration"] },
        phase: "plan",
      },
    ]);
  });

  test("every REST endpoint and GraphQL operation of a real section appears exactly once", () => {
    // repositorySection carries BOTH dictionaries, so the GraphQL half of
    // the flattening binds (a section without `graphql` would prove only the
    // REST half). Content equality over the role-keyed dictionaries is the
    // exactly-once claim: `role` carries each operation's identity, so a
    // duplicated entry canceling an omitted one with the SAME
    // {wire, grade, permission} tuple still fails on content. No repository
    // endpoint overrides accessGrade, so wire and grade coincide here; the
    // override split is pinned by the overrides test below.
    expect(Object.keys(repositorySection.graphql ?? {}).length).toBeGreaterThan(0);
    const phaseOf = (op: EndpointDecl | GraphqlOpDecl): "plan" | "execution" => op.phase ?? "plan";
    expect(sectionOperations(repositorySection)).toEqual([
      ...Object.entries(repositorySection.endpoints).map(([role, op]) => ({
        role,
        wire: endpointKind(op),
        grade: endpointKind(op),
        permission: endpointPermission(repositorySection, op),
        phase: phaseOf(op),
      })),
      ...Object.entries(repositorySection.graphql ?? {}).map(([role, op]) => ({
        role,
        wire: op.kind,
        grade: op.kind,
        permission: endpointPermission(repositorySection, op),
        phase: phaseOf(op),
      })),
    ]);
  });

  test("resolves per-operation permission overrides and accessGrade write-gating", () => {
    const overridden: SectionMeta = {
      key: "repository",
      permission: { repo: ["administration"] },
      endpoints: {
        gatedList: {
          route: "GET /repos/{owner}/{repo}/codespaces/secrets",
          statuses: { 200: "x" },
          accessGrade: "write",
        },
      },
      graphql: { read: { ...readOp, permission: "none" } },
      undeclaredDefault: "untouched",
    };
    expect(sectionOperations(overridden)).toEqual([
      {
        role: "gatedList",
        wire: "read",
        grade: "write",
        permission: { repo: ["administration"] },
        phase: "plan",
      },
      { role: "read", wire: "read", grade: "read", permission: "none", phase: "plan" },
    ]);
  });

  test("an execution-phase read is not a planning read: a section with only that read plans read-free", () => {
    // The shape a write-only section gains when a mutation input needs a node
    // id: check mode and preflight never meet the lookup, so the gating,
    // the posture (no primaryRead to declare), and the oracle's no-read set
    // all read the section as one that issues no read while planning.
    const writeWithLookup = {
      key: "repository",
      permission: { repo: ["administration"] },
      undeclaredDefault: "untouched",
      endpoints: {
        app: {
          route: "GET /apps/{app_slug}",
          statuses: { 200: "the App" },
          permission: "none",
          phase: "execution",
        },
        put: {
          route: "PATCH /repos/{owner}/{repo}",
          statuses: { 200: "updated" },
        },
      },
      graphql: { lookup: { ...readOp, phase: "execution" } },
    } as const satisfies SectionMeta;
    expect(sectionOperations(writeWithLookup)).toEqual([
      { role: "app", wire: "read", grade: "read", permission: "none", phase: "execution" },
      {
        role: "put",
        wire: "write",
        grade: "write",
        permission: { repo: ["administration"] },
        phase: "plan",
      },
      {
        role: "lookup",
        wire: "read",
        grade: "read",
        permission: { repo: ["administration"] },
        phase: "execution",
      },
    ]);
    expect(planningReads(writeWithLookup)).toEqual([]);
    expect(readGating(writeWithLookup)).toBe("plain");
    expect(denialPosture(writeWithLookup)).toBe("absent");
    // An execution-phase read can carry no posture: plan() never meets its denial.
    const postured: SectionMeta = {
      ...writeWithLookup,
      endpoints: {
        app: { ...writeWithLookup.endpoints.app, primaryRead: { notFound: "denied" } },
      },
    };
    expect(() => denialPosture(postured)).toThrow(
      /BUG: repository declares primaryRead on the execution-phase read GET \/apps\/\{app_slug\}/,
    );
  });
});

describe("readGating", () => {
  const plainGet: EndpointDecl = {
    route: "GET /repos/{owner}/{repo}/interaction-limits",
    statuses: { 200: "x" },
  };
  const gatedGet: EndpointDecl = {
    route: "GET /repos/{owner}/{repo}/interaction-limits/pulls/creation-cap",
    statuses: { 200: "x" },
    accessGrade: "write",
  };
  const put: EndpointDecl = {
    route: "PUT /repos/{owner}/{repo}/interaction-limits",
    statuses: { 200: "x" },
  };
  const withEndpoints = (endpoints: SectionMeta["endpoints"]): SectionMeta => ({
    key: "interaction_limits",
    permission: { repo: ["administration"] },
    endpoints,
    undeclaredDefault: "untouched",
  });

  test("accessGrade is representable on a GET only", () => {
    // A mutating route is write-graded by its method, so the override there
    // is a redundant state: the EndpointDecl arms make it fail to compile.
    const mutating: EndpointDecl = {
      route: "PUT /repos/{owner}/{repo}/interaction-limits",
      statuses: { 200: "x" },
      // @ts-expect-error accessGrade on a PUT
      accessGrade: "write",
    };
    expect(endpointKind(mutating)).toBe("write");
    expect(endpointKind(gatedGet)).toBe("write");
    // A public endpoint has no grant to gate, so a gated read cannot be "none".
    // @ts-expect-error permission "none" on a write-gated read
    const publicGated: EndpointDecl = { ...gatedGet, permission: "none" };
    expect(endpointKind(publicGated)).toBe("write");
  });

  test("the recurrence flags are representable on a write only, one at a time", () => {
    // A read has no second-apply behaviour to declare, and one write cannot both recur by contract
    // and merely be allowed to; the EndpointDecl arms make each combination fail to compile.
    const rewritten: EndpointDecl = { ...put, alwaysRewrite: true };
    const unverifiable: EndpointDecl = { ...put, unverifiable: true };
    expect([rewritten.alwaysRewrite, unverifiable.unverifiable]).toEqual([true, true]);
    // @ts-expect-error alwaysRewrite on a GET
    const _readRewrite: EndpointDecl = { ...plainGet, alwaysRewrite: true };
    // @ts-expect-error unverifiable on a GET
    const _readUnverifiable: EndpointDecl = { ...plainGet, unverifiable: true };
    // @ts-expect-error unverifiable on a write-gated read
    const _gatedUnverifiable: EndpointDecl = { ...gatedGet, unverifiable: true };
    // @ts-expect-error both flags on one write
    const _both: EndpointDecl = { ...put, alwaysRewrite: true, unverifiable: true };
  });

  test("classifies a section by how many of its reads GitHub gates at write", () => {
    expect(readGating(withEndpoints({ get: plainGet, put }))).toBe("plain");
    expect(readGating(withEndpoints({ get: gatedGet, put }))).toBe("write-gated");
    expect(readGating(withEndpoints({ get: plainGet, capGet: gatedGet, put }))).toBe("mixed");
    // No reads at all: nothing a grant could deny.
    expect(readGating(withEndpoints({ put }))).toBe("plain");
  });

  test("a GraphQL read counts as a plain read, so it can turn write-gated into mixed", () => {
    const readOp: GraphqlOpDecl = {
      name: "SyntheticRead",
      kind: "read",
      query: "query SyntheticRead($owner: String!, $repo: String!) { repository { id } }",
      outcomes: { ok: "x" },
    };
    expect(readGating({ ...withEndpoints({ get: gatedGet }), graphql: { read: readOp } })).toBe(
      "mixed",
    );
  });

  test("writeGatedReads lists the gated GETs with route and effective permission, in order", () => {
    const section = withEndpoints({
      get: plainGet,
      capGet: gatedGet,
      other: { ...gatedGet, permission: { repo: ["actions"] } },
      put,
    });
    expect(writeGatedReads(section)).toEqual([
      { route: gatedGet.route, permission: { repo: ["administration"] } },
      { route: gatedGet.route, permission: { repo: ["actions"] } },
    ]);
    expect(writeGatedReads(withEndpoints({ get: plainGet, put }))).toEqual([]);
  });

  test("the registered sections agree on which reads GitHub gates at write", () => {
    // The fuzz oracle and the permissions docs both read this classification;
    // interaction_limits mixes its plain base-limit GET with the gated cap
    // and bypass-list GETs (GitHub's fine-grained permission table).
    const gated = SECTIONS.filter((s) => readGating(s) !== "plain").map((s) => [
      s.key,
      readGating(s),
    ]);
    expect(gated).toEqual([
      ["codespaces_secrets", "write-gated"],
      ["code_quality_setup", "write-gated"],
      ["interaction_limits", "mixed"],
    ]);
  });
});

/** A synthetic write declaration carrying just the context fields under test. */
function endpoint(
  extra: Partial<Pick<EndpointDecl, "hints" | "denialHint" | "permission" | "statuses">>,
): EndpointDecl {
  return { route: "POST /repos/{owner}/{repo}/rulesets", statuses: { 201: "created" }, ...extra };
}

describe("throwFor context enrichment", () => {
  const rejection = {
    status: 422,
    message: 'Validation Failed ([{"field":"rules","message":"Invalid rule"}])',
    body: "",
  };

  test("generic rejection without context keeps the classic shape", () => {
    expect(() => throwFor(section, "POST", "/repos/o/r/rulesets", rejection)).toThrow(
      /rulesets: POST \/repos\/o\/r\/rulesets: 422 .*fix the "rulesets" values/,
    );
  });

  test("operation label prefixes the cause", () => {
    expect(() =>
      throwFor(section, "POST", "/repos/o/r/rulesets", rejection, {
        operation: 'creating ruleset "quality"',
      }),
    ).toThrow(/creating ruleset "quality" failed - POST \/repos\/o\/r\/rulesets: 422/);
  });

  test("a GraphQL rejection appends the declared outcome prose of each observed error type; undeclared types add nothing", () => {
    // The GraphQL twin of the status-keyed REST hint (a GraphQL op cannot
    // declare one; its type forbids it).
    const op = {
      name: "PinEnvironment",
      kind: "write",
      query: "mutation PinEnvironment { pinEnvironment { environment { name } } }",
      outcomes: {
        ok: "pinned",
        UNPROCESSABLE: "the pinned list is full; unpin one in the GitHub UI",
      },
    } as const;
    const message = (types: readonly string[]): string => {
      try {
        throwFor(
          section,
          "GRAPHQL",
          "PinEnvironment",
          {
            status: 422,
            message: "Repositories may only have 10 pinned",
            body: "",
            graphqlTypes: types,
          },
          { operation: 'pinning environment "prod"', op },
        );
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("throwFor returned");
    };
    expect(message(["UNPROCESSABLE"])).toBe(
      'rulesets: pinning environment "prod" failed - GRAPHQL PinEnvironment: 422 Repositories ' +
        'may only have 10 pinned. The API rejected the request; fix the "rulesets" values in the ' +
        "settings file to satisfy the message above. The pinned list is full; unpin one in the " +
        "GitHub UI",
    );
    expect(message(["FORBIDDEN"])).toMatch(/message above$/);
    expect(message([])).toMatch(/message above$/);
  });

  test("the status-matched hint and documentation_url are appended to the generic branch", () => {
    expect(() =>
      throwFor(
        section,
        "POST",
        "/repos/o/r/rulesets",
        { ...rejection, documentationUrl: "https://docs.github.com/rest/repos/rules" },
        { op: endpoint({ hints: { 422: "Usually this means a typo" } }) },
      ),
    ).toThrow(
      /message above\. Usually this means a typo\. The fields and values this endpoint accepts are documented at https:\/\/docs\.github\.com\/rest\/repos\/rules$/,
    );
  });

  test("a hint keyed to a different status is not rendered", () => {
    try {
      throwFor(
        section,
        "POST",
        "/repos/o/r/rulesets",
        { status: 409, message: "Conflict", body: "" },
        { op: endpoint({ hints: { 422: "never rendered on a 409" } }) },
      );
    } catch (error) {
      expect(String(error)).toContain("409");
      expect(String(error)).not.toContain("never rendered on a 409");
    }
  });

  test("permission errors keep the grant advice and gain the operation label", () => {
    let thrown: unknown;
    try {
      throwFor(
        section,
        "POST",
        "/repos/o/r/rulesets",
        { status: 403, message: "Resource not accessible", body: "" },
        {
          operation: 'creating ruleset "quality"',
          op: endpoint({ hints: { 422: "never rendered here" } }),
        },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PermissionDenied);
    const denied = thrown as PermissionDenied;
    expect(denied.detail).toContain('creating ruleset "quality" failed - POST');
    expect(denied.detail).toContain(sectionGrant(section));
    expect(denied.detail).not.toContain("never rendered here");
  });

  test("denialHint is appended to the permission branch, and only there", () => {
    let thrown: unknown;
    try {
      throwFor(
        section,
        "PUT",
        "/repos/o/r/lfs",
        { status: 403, message: "Git LFS is globally disabled", body: "" },
        {
          op: endpoint({
            denialHint: "a 403 here can also mean LFS is disabled account-wide",
          }),
        },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PermissionDenied);
    const denied = thrown as PermissionDenied;
    expect(denied.detail).toContain(sectionGrant(section));
    expect(denied.detail).toContain(
      ". Note: a 403 here can also mean LFS is disabled account-wide",
    );
    // The generic branch never renders it.
    expect(() =>
      throwFor(
        section,
        "PUT",
        "/repos/o/r/lfs",
        { status: 422, message: "nope", body: "" },
        { op: endpoint({ denialHint: "not for 422s" }) },
      ),
    ).toThrow(/^(?!.*not for 422s).*fix the "rulesets" values/);
  });

  test("rate-limit and 5xx branches do not render the hint", () => {
    // A 5xx-keyed hint is unrepresentable (HintableStatus), so the fixture
    // carries a 422 one; the 500 branch must throw its own advice without it.
    expect(() =>
      throwFor(
        section,
        "GET",
        "/repos/o/r/rulesets",
        { status: 500, message: "Server Error", body: "" },
        { op: endpoint({ hints: { 422: "never rendered here" } }) },
      ),
    ).toThrow(/server error/);
    try {
      throwFor(
        section,
        "GET",
        "/repos/o/r/rulesets",
        { status: 500, message: "Server Error", body: "" },
        { op: endpoint({ hints: { 422: "never rendered here" } }) },
      );
    } catch (error) {
      expect(String(error)).not.toContain("never rendered here");
    }
  });

  test("a permission override renders the endpoint's own grant, not the section's", () => {
    let thrown: unknown;
    try {
      throwFor(
        section,
        "POST",
        "/repos/o/r/actions/oidc/customization/sub",
        { status: 403, message: "Resource not accessible", body: "" },
        { op: endpoint({ permission: { repo: ["actions"] } }) },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PermissionDenied);
    const denied = thrown as PermissionDenied;
    // The synthetic override has no sibling in the rulesets section carrying
    // the same permission, so the sibling scan finds no write and the advice
    // asks for read - what matters here is the RESOURCE: the endpoint's own
    // grant renders, never the section's.
    expect(denied.detail).toContain(grantFor({ repo: ["actions"] }, undefined, "read"));
    expect(denied.detail).not.toContain(sectionGrant(section));
  });

  test("override advice grades by the section's need: a write sibling on the same permission advises write", () => {
    // The real OIDC pair: the failing call is the GET, but putOidcSub writes
    // with the same Actions permission, so read-only advice would cost a
    // second round trip (grant read, pass the read-only preflight, fail on
    // the write). The sibling scan restores the write-level advice.
    let thrown: unknown;
    try {
      throwFor(
        actionsSection,
        "GET",
        "/repos/o/r/actions/oidc/customization/sub",
        { status: 403, message: "Resource not accessible", body: "" },
        { op: actionsSection.endpoints.getOidcSub as EndpointDecl },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PermissionDenied);
    expect((thrown as PermissionDenied).detail).toContain(grantFor({ repo: ["actions"] }));
  });

  test("override advice grades by the section's need: a read-only permission advises read", () => {
    // The real branch-policy list: its write siblings (create/remove) carry
    // Administration, a DIFFERENT permission, so the Actions grant is only
    // ever read for this section and the advice matches the README PAT cell.
    let thrown: unknown;
    try {
      throwFor(
        environmentsSection,
        "GET",
        "/repos/o/r/environments/prod/deployment-branch-policies",
        { status: 404, message: "Not Found", body: "" },
        { op: environmentsSection.endpoints.listPolicies as EndpointDecl },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PermissionDenied);
    const denied = thrown as PermissionDenied;
    expect(denied.detail).toContain(grantFor({ repo: ["actions"] }, undefined, "read"));
    expect(denied.detail).not.toContain("read and write");
  });

  test('a public endpoint ("none") cannot be a missing-grant failure', () => {
    // A denied PUBLIC endpoint is by definition not about the token's
    // grants, so the 403 takes the generic branch instead of rendering
    // grant advice that cannot help.
    let thrown: unknown;
    try {
      throwFor(
        section,
        "GET",
        "/repos/o/r/rulesets",
        { status: 403, message: "Forbidden", body: "" },
        { op: endpoint({ permission: "none" }) },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).not.toBeInstanceOf(PermissionDenied);
    expect(String(thrown)).toContain('fix the "rulesets" values');
  });

  test("a no-override denial keeps the section grant's caveat", () => {
    // sectionGrant(section) and grantFor(effective) coincide for a caveat-free
    // section, so only a caveat-bearing one can pin the difference: the
    // no-override path must render the section grant (caveat included), and a
    // refactor that re-derives the grant from the resolved permission
    // would silently drop every caveat while caveat-free fixtures stay
    // green.
    let thrown: unknown;
    const noOverride: EndpointDecl = {
      route: "GET /repos/{owner}/{repo}/actions/permissions",
      statuses: { 200: "x" },
    };
    try {
      throwFor(
        actionsSection,
        "GET",
        "/repos/o/r/actions/permissions",
        { status: 403, message: "Resource not accessible", body: "" },
        { op: noOverride },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PermissionDenied);
    const denied = thrown as PermissionDenied;
    expect(denied.detail).toContain(
      'the "oidc_customization_sub" key alone instead needs "Actions"',
    );
  });
});

describe("denialPosture", () => {
  const get = (notFound?: "denied" | "absent"): EndpointDecl => ({
    route: "GET /repos/{owner}/{repo}/interaction-limits",
    statuses: { 200: "x", 404: "none set" },
    ...(notFound === undefined ? {} : { primaryRead: { notFound } }),
  });
  const put: EndpointDecl = {
    route: "PUT /repos/{owner}/{repo}/interaction-limits",
    statuses: { 200: "x" },
  };
  const readOp: GraphqlOpDecl = {
    name: "PostureProbe",
    kind: "read",
    query: "query PostureProbe($owner: String!, $repo: String!) { repository { id } }",
    outcomes: { ok: "x" },
  };
  const meta = (endpoints: SectionMeta["endpoints"], graphql?: SectionMeta["graphql"]) =>
    ({
      key: "interaction_limits",
      permission: { repo: ["administration"] },
      endpoints,
      graphql,
      undeclaredDefault: "untouched",
    }) as SectionMeta;

  test("reads the declared posture, and a section with no read at all is absent", () => {
    expect(denialPosture(meta({ get: get("denied"), put }))).toBe("denied");
    expect(denialPosture(meta({ get: get("absent"), put }))).toBe("absent");
    expect(denialPosture(meta({ put }))).toBe("absent");
  });

  test("a reading section without a posture, or with two, is a BUG rather than a guess", () => {
    expect(() => denialPosture(meta({ get: get(), put }))).toThrow(/declares no primaryRead/);
    // A GraphQL read is a read the posture must cover too.
    expect(() => denialPosture(meta({ put }, { probe: readOp }))).toThrow(
      /declares no primaryRead/,
    );
    expect(() => denialPosture(meta({ get: get("denied"), other: get("absent"), put }))).toThrow(
      /primaryRead on 2 endpoints/,
    );
  });
});

describe("planContext read port", () => {
  const REPO = { owner: "o", name: "r", slug: "o/r" };

  /** Deliberately MUTABLE declarations, the shape a hostile or buggy caller could hold. */
  function mutableSection() {
    const endpoints: Record<string, { route: string; statuses: Record<number, string> }> = {
      list: { route: "GET /repos/{owner}/{repo}/labels", statuses: { 200: "the labels" } },
    };
    const graphql: Record<
      string,
      { name: string; kind: string; query: string; outcomes: { ok: string } }
    > = {
      probe: {
        name: "PortProbe",
        kind: "read",
        query: "query PortProbe($owner: String!, $repo: String!) { repository { id } }",
        outcomes: { ok: "the repository" },
      },
    };
    const section = {
      key: "labels",
      permission: { repo: ["administration"] },
      undeclaredDefault: "delete",
      endpoints,
      graphql,
    } as unknown as SectionMeta;
    return { section, endpoints, graphql };
  }

  test("mutating a declaration after binding cannot turn a bound read into a write", async () => {
    const { section, endpoints, graphql } = mutableSection();
    const api = new MockApi(
      {
        "GET /repos/o/r/labels": { data: [] },
        "GRAPHQL PortProbe": { data: { repository: { id: "R_1" } } },
      },
      { unroutedMutations: "succeed" },
    );
    const ctx = planContext(section, api, REPO) as unknown as {
      read: {
        list: { call(): Promise<unknown> };
        probe: { call(variables: Record<string, unknown>): Promise<unknown> };
      };
    };
    // The bound port is built; now rewrite both declarations into writes.
    (endpoints.list as { route: string }).route = "DELETE /repos/{owner}/{repo}/labels";
    (graphql.probe as { kind: string }).kind = "write";
    await ctx.read.list.call();
    await ctx.read.probe.call({ owner: "o", repo: "r" });
    // Both requests went out as the ORIGINAL reads; the mutations never left.
    expect(api.calls.map((c) => `${c.method} ${c.path} ${c.graphqlKind ?? ""}`.trim())).toEqual([
      "GET /repos/o/r/labels",
      "GRAPHQL PortProbe read",
    ]);
    expect(api.mutations()).toEqual([]);
    // The port itself is sealed too: no role can be swapped in after binding.
    expect(Object.isFrozen(ctx.read)).toBe(true);
  });

  test("an advisory read exposes only tryCall, which tolerates every error status", async () => {
    // No failure on an advisory read may abort the section: the port offers
    // neither a must-succeed call nor an absence probe (a 500 is not
    // "absent"), and tryCall hands every status back to interpret.
    const advisory = {
      key: "branches",
      permission: { repo: ["administration"] },
      undeclaredDefault: "untouched",
      endpoints: {
        probe: {
          route: "GET /repos/{owner}/{repo}/branches/{branch}",
          statuses: { 200: "the branch", 404: "no such branch" },
          advisory: true,
        },
        plain: {
          route: "GET /repos/{owner}/{repo}/branches",
          statuses: { 200: "the branches" },
        },
      },
    } as const satisfies SectionMeta;
    const api = new MockApi({
      "GET /repos/o/r/branches/main": {
        error: { status: 500, message: "Internal Server Error", body: "" },
      },
      "GET /repos/o/r/branches": {
        error: { status: 500, message: "Internal Server Error", body: "" },
      },
    });
    const ctx = planContext(advisory, api, REPO);
    // @ts-expect-error an advisory read offers no must-succeed call
    ctx.read.probe.call;
    // @ts-expect-error nor an absence probe
    ctx.read.probe.probeAbsent;
    // @ts-expect-error nor a list
    ctx.read.probe.listAll;
    // @ts-expect-error nor an enveloped list
    ctx.read.probe.listAllEnveloped;
    expect(await ctx.read.probe.tryCall({ params: { branch: "main" } })).toEqual({
      error: { status: 500, message: "Internal Server Error", body: "" },
    });
    // The control: the same status on a plain read classifies through throwFor.
    expect(typeof ctx.read.plain.call).toBe("function");
    await expect(ctx.read.plain.tryCall()).rejects.toThrow(/500/);
  });

  test("advisory wins over a primaryRead posture on the same declaration", () => {
    // Compile-time only: the advisory arm is tested first, so a "denied"
    // posture cannot hand a must-succeed call back to an advisory read.
    const both = {
      key: "branches",
      permission: { repo: ["administration"] },
      undeclaredDefault: "untouched",
      endpoints: {
        probe: {
          route: "GET /repos/{owner}/{repo}/branches/{branch}",
          statuses: { 200: "the branch" },
          advisory: true,
          primaryRead: { notFound: "denied" },
        },
      },
    } as const satisfies SectionMeta;
    const ctx = planContext(both, new MockApi({}), REPO);
    // @ts-expect-error the denied posture's call is not offered under advisory
    ctx.read.probe.call;
    expect(typeof ctx.read.probe.tryCall).toBe("function");
  });

  test("an execution-phase read demands the ExecTools token only a thunk holds, REST and GraphQL alike", async () => {
    const gated = {
      key: "branches",
      permission: { repo: ["administration"] },
      undeclaredDefault: "untouched",
      endpoints: {
        app: {
          route: "GET /apps/{app_slug}",
          statuses: { 200: "the App" },
          permission: "none",
          phase: "execution",
        },
        plain: {
          route: "GET /repos/{owner}/{repo}/branches",
          statuses: { 200: "the branches" },
        },
      },
      graphql: {
        repo: graphqlOp<{ owner: string; repo: string }>()({
          name: "GateProbe",
          kind: "read",
          phase: "execution",
          query: "query GateProbe($owner: String!, $repo: String!) { repository { id } }",
          outcomes: { ok: "the repository" },
        }),
      },
    } as const satisfies SectionMeta;
    const api = new MockApi({
      "GET /apps/deploy-gate": { data: { node_id: "A_1" } },
      "GET /repos/o/r/branches": { data: [] },
      "GRAPHQL GateProbe": { data: { repository: { id: "R_1" } } },
    });
    const ctx = planContext(gated, api, REPO);
    const exec = {
      resolveSecret: (): string => {
        throw new Error("no secrets here");
      },
    };
    // The first parameter is the token; a plan() body, holding none, cannot
    // spell the call. The ungated read beside them is the control.
    // @ts-expect-error a request options object is not the token
    const forgedRest: Parameters<typeof ctx.read.app.call>[0] = { params: { app_slug: "x" } };
    // @ts-expect-error the variables are not the token either
    const forgedGraphql: Parameters<typeof ctx.read.repo.call>[0] = { owner: "o", repo: "r" };
    expect([forgedRest, forgedGraphql].length).toBe(2);
    expect(await ctx.read.app.call(exec, { params: { app_slug: "deploy-gate" } })).toEqual({
      node_id: "A_1",
    });
    expect(await ctx.read.repo.call(exec, { owner: "o", repo: "r" })).toEqual({
      repository: { id: "R_1" },
    });
    expect(await ctx.read.plain.call()).toEqual([]);
    expect(api.calls.map((c) => c.path)).toEqual([
      "/apps/deploy-gate",
      "GateProbe",
      "/repos/o/r/branches",
    ]);
  });
});

describe("plainData", () => {
  test("accepts a parsed-YAML shape and returns it as is", () => {
    // Nested mappings and lists, null, and an omitted optional field
    // (undefined under a key, which JSON drops) are all what a settings file
    // parses to.
    const shape = {
      name: "x",
      enabled: true,
      count: 3,
      nothing: null,
      omitted: undefined,
      rules: [{ type: "deletion" }, { type: "update", parameters: { tags: ["a", "b"] } }],
    };
    expect(plainData(shape)).toBe(shape);
    expect(plainData([1, "two", null, { three: 3 }])).toEqual([1, "two", null, { three: 3 }]);
  });

  test.each<[what: string, value: unknown, path: string, reason: RegExp]>([
    ["a function", { rules: [{ check: () => true }] }, "rules[0].check", /a function/],
    ["a bigint", { limit: 10n }, "limit", /a bigint/],
    ["a class instance", { when: new Date(0) }, "when", /a non-plain object/],
    ["a symbol", [Symbol("s")], "[0]", /a symbol/],
    ["a non-finite number", { ratio: Number.NaN }, "ratio", /non-finite/],
    ["an undefined list item", { list: [undefined] }, "list[0]", /undefined list item/],
    ["undefined at the root", undefined, "(root)", /has no JSON form/],
    // Keys that are not bare identifiers render bracketed, so a dotted key
    // and a nested key cannot read the same.
    ["a value under a dotted key", { "a.b": { c: 1n } }, '["a.b"].c', /a bigint/],
    ["a value under an empty key", { "": 1n }, '[""]', /a bigint/],
    ["a symbol-keyed property", { ok: true, [Symbol("hidden")]: 1n }, "(root)", /symbol-keyed/],
    [
      "a symbol-keyed list",
      { list: Object.assign([1], { [Symbol("hidden")]: 1n }) },
      "list",
      /symbol-keyed/,
    ],
    [
      "a list with named properties",
      { list: Object.assign([1], { extra: 2 }) },
      "list",
      /named properties/,
    ],
    [
      "a list with a non-enumerable named property",
      { list: Object.defineProperty([1], "extra", { value: 2 }) },
      "list",
      /named properties/,
    ],
    ["a list of a subclass", { list: new (class Tagged extends Array {})() }, "list", /a subclass/],
    [
      "a list with a non-enumerable item",
      { list: Object.defineProperty([1], "0", { enumerable: false }) },
      "list",
      /non-enumerable item/,
    ],
    ["a list with a hole", { list: Object.assign(new Array(3), { 0: 1, 2: 3 }) }, "list", /a hole/],
  ])("rejects %s, naming its path", (_what, value, path, reason) => {
    expect(() => plainData(value)).toThrow(reason);
    expect(() => plainData(value)).toThrow(`at ${path}:`);
  });

  test("rejects a cycle, and only a cycle: a shared sibling reference is plain", () => {
    const shared = { tag: "x" };
    expect(plainData({ a: shared, b: shared })).toEqual({ a: { tag: "x" }, b: { tag: "x" } });
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(() => plainData(cyclic)).toThrow(
      /at self: a reference back to one of its own containers/,
    );
  });
});

describe("hasDrift", () => {
  test("narrows a computed drift list to the non-empty tuple an operation demands", () => {
    const lines: readonly string[] = ["labels[bug]: color d73a4a != live ffffff"];
    expect(hasDrift([])).toBe(false);
    expect(hasDrift(lines)).toBe(true);
    if (hasDrift(lines)) {
      // Under the guard the head is a string, not string | undefined.
      const [head] = lines;
      expect(head.startsWith("labels[bug]")).toBe(true);
    }
  });
});

describe("declaredTolerance", () => {
  const endpoint: EndpointDecl = {
    route: "GET /repos/{owner}/{repo}/branches/{branch}",
    statuses: { 200: "the branch", 404: "no such branch", 409: "empty repository" },
  };

  test("an explicit list tolerates exactly what it names", () => {
    const tolerated = declaredTolerance(endpoint, [404]);
    expect([404, 409, 500].map(tolerated)).toEqual([true, false, false]);
  });

  test("an explicit list may only name declared tolerable statuses", () => {
    // Only an erased caller can spell these; each is refused before any
    // request could leave, naming the offending status.
    for (const status of [422, 200, 401, 500]) {
      expect(() => declaredTolerance(endpoint, [status])).toThrow(
        new RegExp(
          `BUG: GET .*branches/\\{branch\\} was asked to tolerate status\\(es\\) ${status}, which it does not declare`,
        ),
      );
    }
    // The control: the declared 404 and 409 pass, together.
    expect(declaredTolerance(endpoint, [404, 409])(409)).toBe(true);
  });

  test("the declared tolerable set is the 4xx statuses minus 401 and 429; 5xx never", () => {
    expect(
      toleratedStatuses({
        route: "GET /repos/{owner}/{repo}/pages",
        statuses: {
          200: "ok",
          401: "bad token",
          404: "gone",
          422: "no",
          429: "limited",
          500: "down",
        },
      }),
    ).toEqual([404, 422]);
  });

  test("an advisory endpoint tolerates every status", () => {
    const tolerated = declaredTolerance({ ...endpoint, advisory: true });
    expect([404, 409, 500, 401].map(tolerated)).toEqual([true, true, true, true]);
    // An explicit list still wins over the advisory default.
    expect(declaredTolerance({ ...endpoint, advisory: true }, [404])(500)).toBe(false);
  });

  test("otherwise the endpoint's declared tolerable statuses", () => {
    const tolerated = declaredTolerance(endpoint);
    expect([404, 409, 500, 200].map(tolerated)).toEqual([true, true, false, false]);
  });
});

describe("tryCallDeclared", () => {
  // The erased tolerant core takes its tolerance as a resolved predicate
  // (declaredTolerance); the plan executor reaches it with a planned
  // operation's own.
  const ctx = { repo: { owner: "o", name: "r", slug: "o/r" }, check: false as const };
  const endpoint: EndpointDecl = {
    route: "PATCH /repos/{owner}/{repo}/code-quality/setup",
    statuses: { 200: "updated", 409: "a run is in progress" },
  };
  const answering = (status: number, message: string, rateLimited?: true) =>
    new MockApi({
      "PATCH /repos/o/r/code-quality/setup": {
        error: { status, message, body: "", ...(rateLimited ? { rateLimited } : {}) },
      },
    });

  test("a tolerated status comes back as { error }; any other classifies through throwFor", async () => {
    const tolerated = declaredTolerance(endpoint);
    expect(
      await tryCallDeclared(
        { ...ctx, api: answering(409, "Conflict"), resolveSecret: () => "" },
        actionsSection,
        endpoint,
        { tolerated, describe: "arming the setup" },
      ),
    ).toEqual({ error: { status: 409, message: "Conflict", body: "" } });
    await expect(
      tryCallDeclared(
        { ...ctx, api: answering(422, "Unprocessable"), resolveSecret: () => "" },
        actionsSection,
        endpoint,
        { tolerated, describe: "arming the setup" },
      ),
    ).rejects.toThrow(/arming the setup failed - PATCH .*: 422 Unprocessable/);
  });

  test("a rate limit is never a tolerated outcome, even under a tolerated 403", async () => {
    // A rate limit is a transport failure whatever status carries it, so it
    // classifies through throwFor's rate-limit branch; the control shows an
    // ordinary 403 under the same tolerance is handed back.
    const declares403 = {
      route: "GET /repos/{owner}/{repo}/pages",
      statuses: { 200: "the site", 403: "forbidden", 404: "no site" },
    } as const satisfies EndpointDecl;
    const limited = new MockApi({
      "GET /repos/o/r/pages": {
        error: { status: 403, message: "API rate limit exceeded", body: "", rateLimited: true },
      },
    });
    await expect(
      tryCallDeclared(
        { ...ctx, api: limited, resolveSecret: () => "" },
        actionsSection,
        declares403,
        {
          tolerated: declaredTolerance(declares403),
        },
      ),
    ).rejects.toThrow(/rate limit was hit/);
    await expect(
      probeAbsent({ ...ctx, api: limited, check: true }, actionsSection, declares403),
    ).rejects.toThrow(/rate limit was hit/);
    const plain = new MockApi({
      "GET /repos/o/r/pages": { error: { status: 403, message: "Forbidden", body: "" } },
    });
    expect(
      await tryCallDeclared(
        { ...ctx, api: plain, resolveSecret: () => "" },
        actionsSection,
        declares403,
        { tolerated: declaredTolerance(declares403) },
      ),
    ).toEqual({ error: { status: 403, message: "Forbidden", body: "" } });
    expect(
      await probeAbsent({ ...ctx, api: plain, check: true }, actionsSection, declares403),
    ).toEqual({ missing: true });
  });

  test("probeAbsent shares the tolerance boundary: an undeclared status is refused before the request", async () => {
    const api = new MockApi({ "GET /repos/o/r/pages": { data: {} } });
    const probe = {
      route: "GET /repos/{owner}/{repo}/pages",
      statuses: { 200: "the site", 404: "no site" },
    } as const satisfies EndpointDecl;
    await expect(
      probeAbsent({ ...ctx, api, check: true }, actionsSection, probe, {
        tolerate: [422 as unknown as 404],
      }),
    ).rejects.toThrow(/BUG: GET .*pages was asked to tolerate status\(es\) 422/);
    expect(api.calls).toEqual([]);
  });
});

describe("samePermission", () => {
  test.each<
    [label: string, a: SectionPermission | "none", b: SectionPermission | "none", same: boolean]
  >([
    [
      "the same alternatives in another order",
      { repo: ["administration", "code_scanning_alerts"] },
      { repo: ["code_scanning_alerts", "administration"] },
      true,
    ],
    ["a duplicated alternative", { repo: ["actions", "actions"] }, { repo: ["actions"] }, true],
    [
      "the same org grant",
      { repo: ["administration"], org: "members" },
      { repo: ["administration"], org: "members" },
      true,
    ],
    [
      "a differing org grant",
      { repo: ["administration"], org: "members" },
      { repo: ["administration"] },
      false,
    ],
    ["a differing resource", { repo: ["actions"] }, { repo: ["issues"] }, false],
    ["a strict subset", { repo: ["actions"] }, { repo: ["actions", "issues"] }, false],
    ['"none" against itself', "none", "none", true],
    ['"none" against a permission', "none", { repo: ["actions"] }, false],
  ])("compares %s as %p, symmetrically", (_label, a, b, same) => {
    expect(samePermission(a, b)).toBe(same);
    expect(samePermission(b, a)).toBe(same);
  });

  test("an override restating the section's permission as a separate literal keeps the caveat", () => {
    // Equal by structure, distinct by identity: an identity comparison would
    // take the override path and render a caveat-free grant.
    const restated: EndpointDecl = {
      route: "GET /repos/{owner}/{repo}/actions/permissions",
      statuses: { 200: "x" },
      permission: { repo: ["administration"] },
    };
    expect(restated.permission).not.toBe(actionsSection.permission);
    let thrown: unknown;
    try {
      throwFor(
        actionsSection,
        "GET",
        "/repos/o/r/actions/permissions",
        { status: 403, message: "Resource not accessible", body: "" },
        { op: restated },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PermissionDenied);
    expect((thrown as PermissionDenied).detail).toContain(
      `To fix, ${sectionGrant(actionsSection)}`,
    );
  });
});
