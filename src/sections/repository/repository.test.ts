import { describe, expect, test } from "bun:test";
import { executePlan } from "../../../src/engine/execute.js";
import type { GithubClient } from "../../../src/github/api.js";
import { type PlannedOp, planContext } from "../../../src/sections/contract/plan.js";
import { MockApi } from "../../../test/mock-api.js";
import { provePlanIdempotent } from "../../../test/sections/plan-idempotence.js";
import { REPO } from "../../../test/sections/section-run.js";
import { validateSectionShapes } from "../../engine/validate.js";
import { PermissionDenied } from "../contract/errors.js";
import { grantFor } from "../contract/permissions.js";
import { FEATURE_TOGGLES, normalizeTopics, repositorySection } from "./index.js";

/** The verdict's error prose, or null when the document validated. */
function shapeError(doc: Record<string, unknown>, sourceLabel: string): string | null {
  const verdict = validateSectionShapes(doc, sourceLabel);
  return "error" in verdict ? verdict.error : null;
}

const GET = "GET /repos/o/r";
const TOOLS = { resolveSecret: () => "" };

type Desired = Parameters<typeof repositorySection.plan>[1];

const plan = (api: GithubClient, desired: Desired) =>
  repositorySection.plan(planContext(repositorySection, api, REPO), desired);

/** Plan against `api`, then execute the plan against it: what apply would do. */
async function apply(api: GithubClient, desired: Desired) {
  return executePlan(await plan(api, desired), repositorySection, api, REPO, TOOLS);
}

/** The rejection must be a PermissionDenied CARRYING the section's grant advice. */
function expectAdministrationDenied(thrown: unknown): void {
  expect(thrown).toBeInstanceOf(PermissionDenied);
  expect((thrown as PermissionDenied).detail).toContain(grantFor({ repo: ["administration"] }));
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

const features = (overrides?: Record<string, unknown>) => ({
  "GRAPHQL RepositoryFeatures": {
    data: {
      repository: {
        id: "R_node",
        hasSponsorshipsEnabled: false,
        issueCreationPolicy: "ALL",
        ...overrides,
      },
    },
  },
});

const echo = (fields: Record<string, unknown>) => ({
  "GRAPHQL UpdateRepositoryFeatures": { data: { updateRepository: { repository: fields } } },
});

/**
 * A stateful fake of everything the repository section touches: the repo
 * body, the four readable toggles (each GET answers as GitHub does), the
 * write-only LFS pair (stored nowhere), and the two GraphQL-only fields.
 */
function liveRepo(seed: {
  repo?: Record<string, unknown>;
  toggles?: Record<string, boolean>;
  features?: { hasSponsorshipsEnabled: boolean; issueCreationPolicy: string };
}): GithubClient & { writes: string[] } {
  const repo: Record<string, unknown> = { topics: [], ...seed.repo };
  const toggles: Record<string, boolean> = { ...seed.toggles };
  const feature = seed.features ?? { hasSponsorshipsEnabled: false, issueCreationPolicy: "ALL" };
  const off = { error: { status: 404, message: "Not Found", body: "" } } as const;
  return {
    writes: [],
    async tryRequest(method, path, payload) {
      const body = payload as Record<string, unknown>;
      if (method !== "GET") {
        this.writes.push(`${method} ${path}`);
      }
      if (path === "/repos/o/r") {
        if (method === "PATCH") {
          Object.assign(repo, body);
        }
        return { data: repo };
      }
      if (path === "/repos/o/r/topics") {
        repo.topics = body.names;
        return { data: { names: repo.topics } };
      }
      const feature = path.slice("/repos/o/r/".length);
      if (method === "PUT" || method === "DELETE") {
        toggles[feature] = method === "PUT";
        return { data: null };
      }
      const enabled = toggles[feature] === true;
      switch (feature) {
        case "vulnerability-alerts":
          return enabled ? { data: null } : off;
        case "automated-security-fixes":
          return enabled ? { data: { enabled: true, paused: false } } : off;
        case "private-vulnerability-reporting":
          return { data: { enabled } };
        case "immutable-releases":
          return enabled ? { data: { enabled: true, enforced_by_owner: false } } : off;
        default:
          return off;
      }
    },
    async tryGraphql(op, variables) {
      if (op.name === "RepositoryFeatures") {
        return { data: { repository: { id: "R_node", ...feature } } };
      }
      this.writes.push(`GRAPHQL ${op.name}`);
      const { hasSponsorshipsEnabled, issueCreationPolicy } = variables as Partial<typeof feature>;
      if (hasSponsorshipsEnabled !== undefined) {
        feature.hasSponsorshipsEnabled = hasSponsorshipsEnabled;
      }
      if (issueCreationPolicy !== undefined) {
        feature.issueCreationPolicy = issueCreationPolicy;
      }
      return { data: { updateRepository: { repository: { ...feature } } } };
    },
  };
}

describe("normalizeTopics", () => {
  test.each([
    [
      "a comma string",
      "Copier, template , ,GitHub-Actions",
      ["copier", "template", "github-actions"],
    ],
    ["an array, deduped", ["A", "a", "b"], ["a", "b"]],
  ])("lowercases and dedupes %s", (_what, raw, expected) => {
    expect(normalizeTopics(raw)).toEqual(expected);
  });
});

describe("repository", () => {
  test("splits specials onto their endpoints, each write justified by its own drift", async () => {
    const api = new MockApi({
      [GET]: { data: { description: "old", topics: ["a"] } },
      "GET /repos/o/r/automated-security-fixes": { data: { enabled: true } },
    }); // GET vulnerability-alerts 404s: off
    const result = await plan(api, {
      description: "d",
      topics: "A, b",
      enable_vulnerability_alerts: true,
      enable_automated_security_fixes: false,
    });
    expect(result.ops.map((op) => [op.role, op.payload, op.drift, op.change])).toEqual([
      [
        "update",
        { description: "d" },
        ['repository.description: "d" != "old"'],
        "patched repository fields: description",
      ],
      ["topics", { names: ["a", "b"] }, ['repository.topics: missing "b"'], "set topics: a, b"],
      [
        "vulnerabilityAlertsPut",
        undefined,
        [
          "repository.enable_vulnerability_alerts: declared true != live false; apply will set the declared value",
        ],
        "vulnerability alerts: enabled",
      ],
      [
        "automatedSecurityFixesRemove",
        undefined,
        [
          "repository.enable_automated_security_fixes: declared false != live true; apply will set the declared value",
        ],
        "automated security fixes: disabled",
      ],
    ]);
    expect(result.notes).toEqual([]);
    // Planning reads and never writes; no GraphQL without a routed key.
    expect(api.mutations()).toEqual([]);
    expect(api.calls.map((c) => c.method)).toEqual(["GET", "GET", "GET"]);
  });

  test("a declared field the repository GET does not return is noted as a phantom key", async () => {
    // The PATCH is diff-gated: such a key would re-PATCH on every apply
    // without ever converging, so the note says so alongside the drift.
    const api = new MockApi({ [GET]: { data: { description: "d" } } });
    const result = await plan(api, { description: "d", extra_field: "x" });
    expect(result.notes).toEqual([
      'repository: declared key(s) "extra_field" do not exist on the live repository, so if GitHub ignores them this PATCH will re-run on every apply without converging. Fix the key name, or remove it from the settings file',
    ]);
    expect(result.ops.map((op) => op.role)).toEqual(["update"]);
  });

  test.each([
    ["vulnerability-alerts", { enabled: true }],
    ["automated-security-fixes", null],
    ["automated-security-fixes", {}],
    ["private-vulnerability-reporting", { enabled: "yes" }],
    ["immutable-releases", []],
  ] as const)(
    "a toggle GET body off the documented shape fails loudly (%s: %p)",
    async (feature, body) => {
      // Neither a definite on nor a definite off may be read off a body the
      // contract does not document, since either would drive a write.
      const key = {
        "vulnerability-alerts": "enable_vulnerability_alerts",
        "automated-security-fixes": "enable_automated_security_fixes",
        "private-vulnerability-reporting": "enable_private_vulnerability_reporting",
        "immutable-releases": "enable_immutable_releases",
      }[feature];
      const api = new MockApi({
        [GET]: { data: {} },
        [`GET /repos/o/r/${feature}`]: { data: body },
      });
      await expect(plan(api, { [key]: true })).rejects.toThrow(
        new RegExp(
          `repository: GET /repos/\\{owner\\}/\\{repo\\}/${feature} returned a body outside the documented shape`,
        ),
      );
    },
  );

  test("a matching repository plans nothing", async () => {
    const api = new MockApi({
      [GET]: { data: { description: "d", topics: ["b", "a"] } },
      "GET /repos/o/r/vulnerability-alerts": { data: null },
    });
    const result = await plan(api, {
      description: "d",
      topics: ["a", "b"],
      enable_vulnerability_alerts: true,
    });
    expect(result).toEqual({ ops: [], notes: [], drift: [] });
  });

  test("permission errors surface as PermissionDenied with the grant advice, at plan and at apply", async () => {
    const denied = new MockApi({
      [GET]: { error: { status: 403, message: "Resource not accessible", body: "" } },
    });
    expectAdministrationDenied(await rejection(plan(denied, { description: "d" })));
    const refused = new MockApi({
      [GET]: { data: {} },
      "PATCH /repos/o/r": { error: { status: 403, message: "Resource not accessible", body: "" } },
    });
    const execution = await apply(refused, { description: "d" });
    expect(execution.status).toBe("failed");
    expectAdministrationDenied((execution as { error: unknown }).error);
  });

  /**
   * Every toggle's endpoint pair, spelled explicitly so a swapped production
   * role fails here instead of being read back as the expectation;
   * `enabledBody` is the GET's answer when the feature is on (LFS has none).
   */
  const TOGGLE_CASES = [
    ["enable_vulnerability_alerts", "vulnerability alerts", "vulnerability-alerts", null],
    [
      "enable_automated_security_fixes",
      "automated security fixes",
      "automated-security-fixes",
      { enabled: true },
    ],
    [
      "enable_private_vulnerability_reporting",
      "private vulnerability reporting",
      "private-vulnerability-reporting",
      { enabled: true },
    ],
    [
      "enable_immutable_releases",
      "immutable releases",
      "immutable-releases",
      { enabled: true, enforced_by_owner: false },
    ],
    ["enable_git_lfs", "Git LFS", "lfs", undefined],
  ] as const;

  test("the toggle table names every case above and nothing else", () => {
    expect(FEATURE_TOGGLES.map((toggle) => toggle.key).sort()).toEqual(
      TOGGLE_CASES.map(([key]) => key).sort(),
    );
  });

  test.each(TOGGLE_CASES)(
    "%s toggles its own endpoint: PUT on true, DELETE on false, never in the PATCH",
    async (key, label, feature, enabledBody) => {
      // Readable toggles start opposite each declaration; LFS has no live
      // state. So every direction plans its write, and the exact-mutations
      // assertion proves no toggle leaks into the repository PATCH.
      const path = `/repos/o/r/${feature}`;
      const on = new MockApi({ [GET]: { data: {} } }).allowMutations(`PUT ${path}`);
      const enabled = await apply(on, { [key]: true });
      expect(on.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([`PUT ${path}`]);
      expect(enabled).toEqual({
        status: "applied",
        changes: [`${label}: enabled`],
        notes: [],
        landed: 1,
      });
      const off = new MockApi({
        [GET]: { data: {} },
        ...(enabledBody === undefined ? {} : { [`GET ${path}`]: { data: enabledBody } }),
      }).allowMutations(`DELETE ${path}`);
      const disabled = await apply(off, { [key]: false });
      expect(off.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([`DELETE ${path}`]);
      expect(disabled.changes).toEqual([`${label}: disabled`]);
    },
  );

  test.each([
    [
      "a 404 on the private vulnerability reporting DELETE",
      { enable_private_vulnerability_reporting: false },
      { "GET /repos/o/r/private-vulnerability-reporting": { data: { enabled: true } } },
      "DELETE /repos/o/r/private-vulnerability-reporting",
      404,
      "repository.enable_private_vulnerability_reporting: the feature is not applicable, so it is already off, so nothing changed (404)",
    ],
    [
      "a 422 on the private vulnerability reporting DELETE",
      { enable_private_vulnerability_reporting: false },
      { "GET /repos/o/r/private-vulnerability-reporting": { data: { enabled: true } } },
      "DELETE /repos/o/r/private-vulnerability-reporting",
      422,
      "repository.enable_private_vulnerability_reporting: the feature is not applicable, so it is already off, so nothing changed (422)",
    ],
    [
      "a 409 on the immutable releases PUT",
      { enable_immutable_releases: true },
      {},
      "PUT /repos/o/r/immutable-releases",
      409,
      "repository.enable_immutable_releases: the repository owner enforces immutable releases, so apply cannot change it from the repository (409)",
    ],
    [
      "a 409 on the immutable releases DELETE",
      { enable_immutable_releases: false },
      {
        "GET /repos/o/r/immutable-releases": { data: { enabled: true, enforced_by_owner: true } },
      },
      "DELETE /repos/o/r/immutable-releases",
      409,
      "repository.enable_immutable_releases: the repository owner enforces immutable releases, so apply cannot change it from the repository (409)",
    ],
  ] as const)(
    "%s is a note, never a change line",
    async (_what, desired, live, write, status, note) => {
      // The feature changed under the plan (or is enforced above the repo):
      // the tolerated status says nothing changed, in the status's declared
      // meaning, and the run goes on.
      const api = new MockApi({
        [GET]: { data: {} },
        ...live,
        [write]: { error: { status, message: "Nope", body: "" } },
      });
      expect(await apply(api, desired)).toEqual({
        status: "applied",
        changes: [],
        notes: [note],
        landed: 0,
      });
    },
  );

  test("private vulnerability reporting reads the {enabled} body; probe errors are not swallowed", async () => {
    const api = new MockApi({
      [GET]: { data: {} },
      "GET /repos/o/r/private-vulnerability-reporting": { data: { enabled: false } },
    });
    const result = await plan(api, { enable_private_vulnerability_reporting: true });
    expect(result.ops.map((op) => [op.role, op.drift])).toEqual([
      [
        "privateVulnerabilityReportingPut",
        [
          "repository.enable_private_vulnerability_reporting: declared true != live false; apply will set the declared value",
        ],
      ],
    ]);
    const denied = new MockApi({
      [GET]: { data: {} },
      "GET /repos/o/r/private-vulnerability-reporting": {
        error: { status: 403, message: "Forbidden", body: "" },
      },
    });
    expectAdministrationDenied(
      await rejection(plan(denied, { enable_private_vulnerability_reporting: true })),
    );
  });

  test.each([404, 422])(
    "a %i on the private vulnerability reporting probe reads as not applicable, so off",
    async (status) => {
      // A repo where the feature does not apply (private repos): a matching
      // declared false is clean, a declared true is drift with the PUT due.
      const check = new MockApi({
        [GET]: { data: {} },
        "GET /repos/o/r/private-vulnerability-reporting": {
          error: { status, message: "Not applicable", body: "" },
        },
      });
      expect((await plan(check, { enable_private_vulnerability_reporting: false })).ops).toEqual(
        [],
      );
      const on = await plan(check, { enable_private_vulnerability_reporting: true });
      expect(on.ops.map((op) => [op.role, op.drift])).toEqual([
        [
          "privateVulnerabilityReportingPut",
          [
            "repository.enable_private_vulnerability_reporting: declared true != live false; apply will set the declared value",
          ],
        ],
      ]);
    },
  );

  test("non-boolean security toggles are rejected by upfront shape validation with the YAML hint", () => {
    const error = shapeError({ repository: { enable_vulnerability_alerts: "no" } }, "f.yml");
    expect(error).toContain("repository.enable_vulnerability_alerts");
    expect(error).toContain("not a boolean");
    expect(error).toContain('"no"');
  });

  test("git LFS: the cannot-verify note, no drift, an always-rewrite operation, no requests beyond the GET", async () => {
    const api = new MockApi({ [GET]: { data: {} } });
    const result = await plan(api, { enable_git_lfs: true });
    expect(result).toEqual({
      ops: [{ role: "lfsPut", drift: [], change: "Git LFS: enabled" }],
      notes: [
        "repository.enable_git_lfs: GitHub exposes no endpoint to read this state back, so check mode cannot verify it; apply re-asserts the declared value (true) on every run",
      ],
      drift: [],
    });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([GET]);
  });

  test("non-boolean git LFS values hit the shared toggle shape, booleans pass", () => {
    const error = shapeError({ repository: { enable_git_lfs: "yes" } }, "f.yml");
    expect(error).toContain("repository.enable_git_lfs");
    expect(error).toContain("not a boolean");
    // The section stays loose otherwise: booleans and passthrough keys pass.
    expect(
      shapeError({ repository: { enable_git_lfs: true, extra_field: "x" } }, "f.yml"),
    ).toBeNull();
  });

  test("a cyclic toggle value is rejected with a message, never a formatter throw", () => {
    // A YAML alias cycle (enable_git_lfs: &v { self: *v }) reaches the shape
    // as a self-referential object; the error text must be built without
    // JSON.stringify on it, or validation itself would die and the run would
    // lose its normal failed result.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const error = shapeError({ repository: { enable_git_lfs: cyclic } }, "f.yml");
    expect(error).toContain("repository.enable_git_lfs");
    expect(error).toContain("a mapping is not a boolean");
  });

  test("the section accepts plain mappings only, like the record shape always did", () => {
    // requirePlainMapping guards the passthrough mapping: a YAML !!timestamp
    // document parses to a Date, which zod's object schemas would accept as
    // an empty mapping, so it must fail shape validation instead.
    expect(shapeError({ repository: new Date("2020-01-01") }, "f.yml")).toContain("repository");
    expect(shapeError({ repository: [1, 2] }, "f.yml")).toContain("repository");
  });

  test("immutable releases reads the {enabled} body, treats 404 as off, and names owner enforcement", async () => {
    // Live enabled, declared false: ordinary drift with the apply promise.
    const liveOn = new MockApi({
      [GET]: { data: {} },
      "GET /repos/o/r/immutable-releases": { data: { enabled: true, enforced_by_owner: false } },
    });
    const drift = await plan(liveOn, { enable_immutable_releases: false });
    expect(drift.ops.map((op) => [op.role, op.drift])).toEqual([
      [
        "immutableReleasesRemove",
        [
          "repository.enable_immutable_releases: declared false != live true; apply will set the declared value",
        ],
      ],
    ]);
    // The probe's 404 reads as off: drift against declared true, clean against
    // declared false.
    const liveOff = new MockApi({
      [GET]: { data: {} },
      "GET /repos/o/r/immutable-releases": {
        error: { status: 404, message: "Not Found", body: "" },
      },
    });
    expect((await plan(liveOff, { enable_immutable_releases: true })).ops[0]?.drift).toEqual([
      "repository.enable_immutable_releases: declared true != live false; apply will set the declared value",
    ]);
    expect((await plan(liveOff, { enable_immutable_releases: false })).ops).toEqual([]);
    // Owner-enforced: the drift says apply cannot change it (the write is
    // still planned; its 409 is covered by the tolerated-status cases).
    const enforced = new MockApi({
      [GET]: { data: {} },
      "GET /repos/o/r/immutable-releases": { data: { enabled: true, enforced_by_owner: true } },
    });
    const planned = await plan(enforced, { enable_immutable_releases: false });
    expect(planned.ops.map((op) => [op.role, op.drift])).toEqual([
      [
        "immutableReleasesRemove",
        [
          "repository.enable_immutable_releases: declared false != live true; the repository owner enforces immutable releases, so apply cannot change it from the repository",
        ],
      ],
    ]);
    // A matching declaration stays clean even under enforcement.
    expect((await plan(enforced, { enable_immutable_releases: true })).ops).toEqual([]);
  });

  test("executing the plan converges: every drifted write lands once, the LFS re-assertion recurs", async () => {
    const api = liveRepo({
      repo: { description: "old", has_issues: true },
      toggles: { "automated-security-fixes": true },
    });
    const { first, second, changes } = await provePlanIdempotent(repositorySection, api, {
      description: "d",
      has_issues: false,
      topics: ["Automation", "governance"],
      enable_vulnerability_alerts: true,
      enable_automated_security_fixes: false,
      enable_git_lfs: true,
      enable_sponsorships: true,
      issue_creation_policy: "collaborators_only",
    });
    expect(changes).toEqual([
      "patched repository fields: description, has_issues",
      "set topics: automation, governance",
      "vulnerability alerts: enabled",
      "automated security fixes: disabled",
      "Git LFS: enabled",
      "sponsor button: enabled",
      "issue creation policy: collaborators_only",
    ]);
    expect(first.ops.map((op) => op.role)).toEqual([
      "update",
      "topics",
      "vulnerabilityAlertsPut",
      "automatedSecurityFixesRemove",
      "lfsPut",
      "updateFeatures",
    ]);
    expect(second.ops.map((op) => op.role)).toEqual(["lfsPut"]);
    expect(second.notes).toEqual(first.notes);
    // Two executions (the proof also runs the converged plan): every write
    // once, the LFS re-assertion each time.
    expect(api.writes).toEqual([
      "PATCH /repos/o/r",
      "PUT /repos/o/r/topics",
      "PUT /repos/o/r/vulnerability-alerts",
      "DELETE /repos/o/r/automated-security-fixes",
      "PUT /repos/o/r/lfs",
      "GRAPHQL UpdateRepositoryFeatures",
      "PUT /repos/o/r/lfs",
    ]);
  });

  test("the read port exposes the repo GET, the four toggle probes, and the features query", () => {
    const ctx = planContext(repositorySection, new MockApi({}), REPO);
    expect(Object.keys(ctx.read)).toEqual([
      "get",
      "vulnerabilityAlertsGet",
      "automatedSecurityFixesGet",
      "privateVulnerabilityReportingGet",
      "immutableReleasesGet",
      "featuresQuery",
    ]);
    // @ts-expect-error a write role is not a read: the port has no `update`
    ctx.read.update;
    // @ts-expect-error nor a `topics`
    ctx.read.topics;
    // @ts-expect-error nor the mutation
    ctx.read.updateFeatures;
    // @ts-expect-error nor the raw client
    ctx.api;
    // @ts-expect-error a "denied" primary read offers no 404-tolerant helper
    ctx.read.get.probeAbsent;
    // A toggle probe keeps probeAbsent: its 404 means "not enabled".
    expect(typeof ctx.read.immutableReleasesGet.probeAbsent).toBe("function");
  });

  test("a planned operation can only name a declared write, driftless only when alwaysRewrite", () => {
    type Op = PlannedOp<typeof repositorySection.endpoints, typeof repositorySection.graphql>;
    const read = { role: "get", drift: ["x"], change: "" } as const;
    // @ts-expect-error the repo GET is a read, not a plannable write
    const _read: Op = read;
    const query = {
      role: "featuresQuery",
      variables: { owner: "o", repo: "r" },
      drift: ["x"],
      change: "",
    } as const;
    // @ts-expect-error the features query is a read, not a plannable write
    const _query: Op = query;
    const silent = { role: "vulnerabilityAlertsPut", drift: [], change: "" } as const;
    // @ts-expect-error a readable toggle's write must carry drift
    const _silent: Op = silent;
    const lfs: Op = { role: "lfsRemove", drift: [], change: "Git LFS: disabled" };
    expect(lfs.drift).toEqual([]);
    const badVariables = {
      role: "updateFeatures",
      variables: { repositoryId: "R", issueCreationPolicy: "everyone" },
      drift: ["x"],
      change: "",
    } as const;
    // @ts-expect-error the mutation's variables are typed by its declaration
    const _badVariables: Op = badVariables;
  });
});

describe("repository GraphQL-routed keys", () => {
  test("mutates only on divergence, carrying the declared fields and the node id, and reports the echoed state", async () => {
    const api = new MockApi({
      [GET]: { data: {} },
      ...features(),
      ...echo({ hasSponsorshipsEnabled: true, issueCreationPolicy: "COLLABORATORS_ONLY" }),
    });
    const planned = await plan(api, {
      enable_sponsorships: true,
      issue_creation_policy: "collaborators_only",
    });
    expect(planned.ops.map((op) => [op.role, op.variables, op.drift])).toEqual([
      [
        "updateFeatures",
        {
          repositoryId: "R_node",
          hasSponsorshipsEnabled: true,
          issueCreationPolicy: "COLLABORATORS_ONLY",
        },
        [
          "repository.enable_sponsorships: declared true != live false; apply will set the declared value",
          "repository.issue_creation_policy: declared collaborators_only != live all; apply will set the declared value",
        ],
      ],
    ]);
    const execution = await executePlan(planned, repositorySection, api, REPO, TOOLS);
    expect(execution).toEqual({
      status: "applied",
      changes: ["sponsor button: enabled", "issue creation policy: collaborators_only"],
      notes: [],
      landed: 1,
    });
    // The complete call sequence: the repo GET, ONE features read, then the mutation.
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      GET,
      "GRAPHQL RepositoryFeatures",
      "GRAPHQL UpdateRepositoryFeatures",
    ]);
  });

  test("partial divergence: the mutation and the change lines carry only the diverged key", async () => {
    // enable_sponsorships already matches live; only the policy moves. A
    // change line for the untouched sponsor button would be a false claim
    // (the section's own 409 rule: a note, never a false change line).
    const api = new MockApi({
      [GET]: { data: {} },
      ...features({ hasSponsorshipsEnabled: true }),
      ...echo({ hasSponsorshipsEnabled: true, issueCreationPolicy: "COLLABORATORS_ONLY" }),
    });
    const execution = await apply(api, {
      enable_sponsorships: true,
      issue_creation_policy: "collaborators_only",
    });
    expect(api.mutations()[0]?.payload).toEqual({
      repositoryId: "R_node",
      issueCreationPolicy: "COLLABORATORS_ONLY",
    });
    expect(execution.changes).toEqual(["issue creation policy: collaborators_only"]);
  });

  test("a converged repo issues the read but no mutation", async () => {
    const api = new MockApi({
      [GET]: { data: {} },
      ...features({ hasSponsorshipsEnabled: true, issueCreationPolicy: "COLLABORATORS_ONLY" }),
    });
    const result = await plan(api, {
      enable_sponsorships: true,
      issue_creation_policy: "collaborators_only",
    });
    expect(result.ops).toEqual([]);
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      GET,
      "GRAPHQL RepositoryFeatures",
    ]);
  });

  test("an echo reporting the old value, or no echo at all, fails the write loudly after it landed", async () => {
    // "Accepted but silently ignored" is the REST failure mode that forced
    // these keys onto GraphQL; the mutation's echoed post-state is the guard.
    const stale = new MockApi({
      [GET]: { data: {} },
      ...features(),
      ...echo({ hasSponsorshipsEnabled: false }),
    });
    const execution = await apply(stale, { enable_sponsorships: true });
    expect(execution.status).toBe("failed");
    expect(String((execution as { error: unknown }).error)).toContain("the write did not take");
    expect(stale.mutations()).toHaveLength(1);
    const silent = new MockApi({
      [GET]: { data: {} },
      ...features(),
      "GRAPHQL UpdateRepositoryFeatures": { data: { updateRepository: {} } },
    });
    const unverified = await apply(silent, { enable_sponsorships: true });
    expect(String((unverified as { error: unknown }).error)).toContain(
      "returned no repository echo",
    );
  });

  test("neither key declared means zero GraphQL calls; both are stripped from the base PATCH", async () => {
    const rest = new MockApi({ [GET]: { data: {} } });
    await plan(rest, { has_issues: true });
    expect(rest.calls.map((c) => c.method)).toEqual(["GET"]);
    const both = new MockApi({ [GET]: { data: {} }, ...features() });
    const result = await plan(both, {
      description: "d",
      enable_sponsorships: true,
      issue_creation_policy: "all",
    });
    expect(result.ops.map((op) => [op.role, op.payload])).toEqual([
      ["update", { description: "d" }],
      ["updateFeatures", undefined],
    ]);
  });

  test("a features response without a repository id fails loudly", async () => {
    const api = new MockApi({
      [GET]: { data: {} },
      "GRAPHQL RepositoryFeatures": { data: { repository: null } },
    });
    await expect(plan(api, { enable_sponsorships: true })).rejects.toThrow(
      "returned no repository object with an id",
    );
  });

  test("an unreadable value on a DECLARED key fails loudly instead of folding to a default", async () => {
    // A null issueCreationPolicy (the SDL marks the field nullable) or a
    // non-boolean sponsorship flag must never read as "all"/false - that
    // could report a clean check against state the section does not
    // understand.
    const nullPolicy = new MockApi({
      [GET]: { data: {} },
      ...features({ issueCreationPolicy: null }),
    });
    await expect(plan(nullPolicy, { issue_creation_policy: "all" })).rejects.toThrow(
      "GitHub reported no issue creation policy",
    );
    const unknownEnum = new MockApi({
      [GET]: { data: {} },
      ...features({ issueCreationPolicy: "MAINTAINERS_ONLY" }),
    });
    await expect(plan(unknownEnum, { issue_creation_policy: "all" })).rejects.toThrow(
      "MAINTAINERS_ONLY",
    );
    const stringFlag = new MockApi({
      [GET]: { data: {} },
      ...features({ hasSponsorshipsEnabled: "yes" }),
    });
    await expect(plan(stringFlag, { enable_sponsorships: true })).rejects.toThrow(
      "cannot read as a repository.enable_sponsorships value",
    );
  });

  test("an unreadable value on an UNDECLARED key never fails the run", async () => {
    // The strictness is scoped to declared keys: a null policy (SDL-nullable)
    // must not fail a run that only declared the sponsor button.
    const api = new MockApi({
      [GET]: { data: {} },
      ...features({ hasSponsorshipsEnabled: true, issueCreationPolicy: null }),
    });
    expect(await plan(api, { enable_sponsorships: true })).toEqual({
      ops: [],
      notes: [],
      drift: [],
    });
  });

  test("a GraphQL FORBIDDEN on the read surfaces as PermissionDenied", async () => {
    const api = new MockApi({
      [GET]: { data: {} },
      "GRAPHQL RepositoryFeatures": {
        error: {
          status: 403,
          message: "Resource not accessible",
          body: "",
          graphqlTypes: ["FORBIDDEN"],
        },
      },
    });
    expectAdministrationDenied(await rejection(plan(api, { enable_sponsorships: true })));
  });

  test("a non-boolean enable_sponsorships is rejected upfront with the YAML hint", () => {
    const error = shapeError({ repository: { enable_sponsorships: "yes" } }, "f.yml");
    expect(error).toContain("repository.enable_sponsorships");
    expect(error).toContain("not a boolean");
  });

  test("an unrecognized issue_creation_policy is rejected upfront naming the vocabulary", () => {
    const error = shapeError({ repository: { issue_creation_policy: "everyone" } }, "f.yml");
    expect(error).toContain("repository.issue_creation_policy");
    expect(error).toContain('"collaborators_only"');
    expect(shapeError({ repository: { issue_creation_policy: "all" } }, "f.yml")).toBeNull();
  });

  test("prototype-chain property names never pass the policy vocabulary", () => {
    // `"constructor" in ISSUE_CREATION_POLICIES` is true via the prototype
    // chain; the vocabulary check must be an own-property check or these
    // would validate and then map to garbage at the GraphQL boundary.
    for (const name of ["constructor", "toString", "__proto__"]) {
      expect(
        shapeError({ repository: { issue_creation_policy: name } }, "f.yml"),
        `"${name}" must be rejected`,
      ).toContain("repository.issue_creation_policy");
    }
  });
});
