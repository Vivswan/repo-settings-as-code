import { describe, expect, test } from "bun:test";
import type { GithubApi } from "../src/api.js";
import { branchesSection } from "../src/sections/branches.js";
import { labelsSection } from "../src/sections/labels.js";
import {
  actionsSection,
  codeScanningDefaultSetupSection,
  pagesSection,
  workflowsSection,
} from "../src/sections/misc.js";
import { repositorySection } from "../src/sections/repository.js";
import { rulesetsSection } from "../src/sections/rulesets.js";
import type { SectionContext } from "../src/sections/section.js";
import { PermissionDenied } from "../src/sections/section.js";
import { validateSectionShapes } from "../src/validate.js";
import { MockApi } from "./mock-api.js";

function ctx(api: MockApi, check = false): SectionContext {
  return { api: api as unknown as GithubApi, repo: "o/r", owner: "o", check };
}

describe("labels", () => {
  const liveLabels = [
    { name: "bug", color: "d73a4a", description: "Something isn't working" },
    { name: "stale", color: "ffffff", description: null },
  ];

  test("creates missing, updates drifted, deletes undeclared", async () => {
    const api = new MockApi({
      "GET /repos/o/r/labels?per_page=100&page=1": { data: liveLabels },
    });
    const result = await labelsSection.run(ctx(api), [
      { name: "bug", color: "#D73A4A", description: "Something isn't working" },
      { name: "enhancement", color: "a2eeef" },
    ]);
    expect(result.changes).toEqual([
      'created label "enhancement"',
      'DELETED undeclared label "stale"',
    ]);
    const mutations = api.mutations();
    expect(mutations.map((m) => `${m.method} ${m.path}`)).toEqual([
      "POST /repos/o/r/labels",
      "DELETE /repos/o/r/labels/stale",
    ]);
  });

  test("check mode reports drift without mutating", async () => {
    const api = new MockApi({
      "GET /repos/o/r/labels?per_page=100&page=1": { data: liveLabels },
    });
    const result = await labelsSection.run(ctx(api, true), [{ name: "bug", color: "000000" }]);
    expect(result.drift).toEqual([
      'labels[bug].color: declared "000000" != live "d73a4a"; apply will set the declared value',
      "labels[stale]: undeclared - not in the settings file, so apply will DELETE it; add it to the settings file to keep it",
    ]);
    expect(api.mutations()).toEqual([]);
  });

  test("url-encodes tricky names", async () => {
    const api = new MockApi({
      "GET /repos/o/r/labels?per_page=100&page=1": {
        data: [{ name: "autorelease: pending", color: "ededed", description: "x" }],
      },
    });
    await labelsSection.run(ctx(api), [
      { name: "autorelease: pending", color: "ffffff", description: "x" },
    ]);
    expect(api.mutations()[0]?.path).toBe("/repos/o/r/labels/autorelease%3A%20pending");
  });

  test("two entries renaming onto the same label are rejected before any API call", async () => {
    const api = new MockApi({});
    await expect(
      labelsSection.run(ctx(api), [
        { name: "bug", new_name: "triage" },
        { name: "enhancement", new_name: "Triage" },
      ]),
    ).rejects.toThrow(/cannot converge/);
    expect(api.calls).toHaveLength(0);
  });
});

describe("rulesets", () => {
  test("creates missing with normalized refs, never deletes undeclared", async () => {
    const api = new MockApi({
      "GET /repos/o/r/rulesets?per_page=100&page=1": {
        data: [{ id: 7, name: "legacy", source_type: "Repository" }],
      },
    });
    const result = await rulesetsSection.run(ctx(api), [
      {
        name: "build-tags",
        target: "tag",
        enforcement: "active",
        conditions: { ref_name: { include: ["templates/*"], exclude: [] } },
        rules: [{ type: "deletion" }],
      },
    ]);
    expect(result.changes).toEqual(['created ruleset "build-tags"']);
    expect(result.notes).toEqual([
      'ruleset "legacy" exists on the repo but is not declared in the settings file; left untouched - add it to the settings file to manage it, or delete it in the repo\'s GitHub settings',
    ]);
    const post = api.mutations()[0];
    expect(post?.method).toBe("POST");
    const payload = post?.payload as { conditions: { ref_name: { include: string[] } } };
    expect(payload.conditions.ref_name.include).toEqual(["refs/tags/templates/*"]);
  });

  test("updates by name with full payload", async () => {
    const api = new MockApi({
      "GET /repos/o/r/rulesets?per_page=100&page=1": {
        data: [{ id: 9, name: "main", source_type: "Repository" }],
      },
    });
    const result = await rulesetsSection.run(ctx(api), [
      { name: "main", target: "branch", rules: [{ type: "deletion" }] },
    ]);
    expect(result.changes).toEqual(['updated ruleset "main" (id 9)']);
    expect(api.mutations()[0]?.path).toBe("/repos/o/r/rulesets/9");
  });
});

describe("repository", () => {
  test("splits specials onto their endpoints", async () => {
    const api = new MockApi({});
    await repositorySection.run(ctx(api), {
      description: "d",
      topics: "A, b",
      enable_vulnerability_alerts: true,
      enable_automated_security_fixes: false,
    });
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "PATCH /repos/o/r",
      "PUT /repos/o/r/topics",
      "PUT /repos/o/r/vulnerability-alerts",
      "DELETE /repos/o/r/automated-security-fixes",
    ]);
    const patch = api.mutations()[0]?.payload as Record<string, unknown>;
    expect(Object.keys(patch)).toEqual(["description"]);
    const topics = api.mutations()[1]?.payload as { names: string[] };
    expect(topics.names).toEqual(["a", "b"]);
  });

  test("permission error surfaces as PermissionDenied", async () => {
    const api = new MockApi({
      "PATCH /repos/o/r": { error: { status: 403, message: "Resource not accessible", body: "" } },
    });
    await expect(repositorySection.run(ctx(api), { description: "d" })).rejects.toBeInstanceOf(
      PermissionDenied,
    );
  });

  test("private vulnerability reporting toggles its own endpoint", async () => {
    const api = new MockApi({});
    const on = await repositorySection.run(ctx(api), {
      enable_private_vulnerability_reporting: true,
    });
    expect(on.changes).toEqual(["private vulnerability reporting: enabled"]);
    await repositorySection.run(ctx(api), { enable_private_vulnerability_reporting: false });
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "PUT /repos/o/r/private-vulnerability-reporting",
      "DELETE /repos/o/r/private-vulnerability-reporting",
    ]);
  });

  test("private vulnerability reporting check reads the {enabled} body", async () => {
    const api = new MockApi({
      "GET /repos/o/r": { data: {} },
      "GET /repos/o/r/private-vulnerability-reporting": { data: { enabled: false } },
    });
    const result = await repositorySection.run(ctx(api, true), {
      enable_private_vulnerability_reporting: true,
    });
    expect(result.drift).toEqual([
      "repository.enable_private_vulnerability_reporting: declared true != live false; apply will set the declared value",
    ]);
    expect(api.mutations()).toEqual([]);
    const clean = new MockApi({
      "GET /repos/o/r": { data: {} },
      "GET /repos/o/r/private-vulnerability-reporting": { data: { enabled: true } },
    });
    const noDrift = await repositorySection.run(ctx(clean, true), {
      enable_private_vulnerability_reporting: true,
    });
    expect(noDrift.drift).toEqual([]);
  });

  test("private vulnerability reporting probe errors are not swallowed", async () => {
    const api = new MockApi({
      "GET /repos/o/r": { data: {} },
      "GET /repos/o/r/private-vulnerability-reporting": {
        error: { status: 403, message: "Forbidden", body: "" },
      },
    });
    await expect(
      repositorySection.run(ctx(api, true), { enable_private_vulnerability_reporting: true }),
    ).rejects.toBeInstanceOf(PermissionDenied);
  });

  test("private vulnerability reporting treats 404/422 as not applicable", async () => {
    // Check mode: a private repo (422) with a matching declared false is clean.
    const check = new MockApi({
      "GET /repos/o/r": { data: {} },
      "GET /repos/o/r/private-vulnerability-reporting": {
        error: { status: 422, message: "Bad Request", body: "" },
      },
    });
    const clean = await repositorySection.run(ctx(check, true), {
      enable_private_vulnerability_reporting: false,
    });
    expect(clean.drift).toEqual([]);
    const drift = await repositorySection.run(ctx(check, true), {
      enable_private_vulnerability_reporting: true,
    });
    expect(drift.drift).toHaveLength(1);
    // Apply mode: DELETE answering 422 is already the declared state.
    const apply = new MockApi({
      "DELETE /repos/o/r/private-vulnerability-reporting": {
        error: { status: 422, message: "Bad Request", body: "" },
      },
    });
    const off = await repositorySection.run(ctx(apply), {
      enable_private_vulnerability_reporting: false,
    });
    expect(off.changes).toEqual(["private vulnerability reporting: disabled"]);
  });

  test("non-boolean security toggles are rejected with the YAML hint", async () => {
    const api = new MockApi({});
    await expect(
      repositorySection.run(ctx(api), { enable_vulnerability_alerts: "no" }),
    ).rejects.toThrow(/not a boolean/);
    expect(api.calls).toHaveLength(0);
  });
});

describe("actions", () => {
  test("routes every key to its endpoint, access_level included", async () => {
    const api = new MockApi({});
    const result = await actionsSection.run(ctx(api), {
      enabled: true,
      allowed_actions: "selected",
      selected_actions: { github_owned_allowed: true },
      default_workflow_permissions: "read",
      access_level: "organization",
    });
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "PUT /repos/o/r/actions/permissions",
      "PUT /repos/o/r/actions/permissions/selected-actions",
      "PUT /repos/o/r/actions/permissions/workflow",
      "PUT /repos/o/r/actions/permissions/access",
    ]);
    const base = api.mutations()[0]?.payload as Record<string, unknown>;
    expect("access_level" in base).toBe(false);
    expect(api.mutations()[3]?.payload).toEqual({ access_level: "organization" });
    expect(result.notes).toEqual([]);
  });

  test("check compares access_level against its own endpoint", async () => {
    const api = new MockApi({
      "GET /repos/o/r/actions/permissions/access": { data: { access_level: "none" } },
    });
    const result = await actionsSection.run(ctx(api, true), { access_level: "organization" });
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]).toContain("actions.access.access_level");
    expect(api.mutations()).toEqual([]);
  });

  test("any base-permissions key implies enabled: true in the PUT body", async () => {
    const api = new MockApi({});
    await actionsSection.run(ctx(api), { allowed_actions: "all" });
    expect(api.mutations()[0]?.payload).toEqual({ allowed_actions: "all", enabled: true });
    const future = new MockApi({});
    await actionsSection.run(ctx(future), { some_future_key: "x" });
    const payload = future.mutations()[0]?.payload as Record<string, unknown>;
    expect(payload.enabled).toBe(true);
  });

  test("selected-actions check treats a 409 as drift, not failure", async () => {
    const api = new MockApi({
      "GET /repos/o/r/actions/permissions": { data: { enabled: true, allowed_actions: "all" } },
      "GET /repos/o/r/actions/permissions/selected-actions": {
        error: { status: 409, message: "Conflict", body: "" },
      },
    });
    const result = await actionsSection.run(ctx(api, true), {
      allowed_actions: "selected",
      selected_actions: { github_owned_allowed: true },
    });
    expect(result.drift.some((d) => d.includes('not "selected"'))).toBe(true);
    expect(api.mutations()).toEqual([]);
  });

  test("selected_actions implies allowed_actions: selected and rejects contradictions", async () => {
    const api = new MockApi({});
    await actionsSection.run(ctx(api), { selected_actions: { github_owned_allowed: true } });
    const base = api.mutations()[0]?.payload as Record<string, unknown>;
    expect(base.allowed_actions).toBe("selected");
    await expect(
      actionsSection.run(ctx(new MockApi({})), {
        allowed_actions: "all",
        selected_actions: { github_owned_allowed: true },
      }),
    ).rejects.toThrow(/allowed_actions/);
  });
});

describe("pages", () => {
  test("creates when absent, then PUTs the update-only fields", async () => {
    const api = new MockApi({}); // GET /pages 404s
    const result = await pagesSection.run(ctx(api), {
      build_type: "legacy",
      source: { branch: "main", path: "/docs" },
      cname: "docs.example.com",
      https_enforced: true,
    });
    expect(result.changes).toEqual([
      "enabled GitHub Pages",
      "applied remaining Pages configuration",
    ]);
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "POST /repos/o/r/pages",
      "PUT /repos/o/r/pages",
    ]);
  });

  test("updates in place when the site exists", async () => {
    const api = new MockApi({
      "GET /repos/o/r/pages": { data: { build_type: "legacy" } },
    });
    const result = await pagesSection.run(ctx(api), { build_type: "workflow" });
    expect(result.changes).toEqual(["updated GitHub Pages configuration"]);
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual(["PUT /repos/o/r/pages"]);
  });

  test("a source without a path gets the default path everywhere", async () => {
    const api = new MockApi({
      "GET /repos/o/r/pages": { data: {} },
    });
    await pagesSection.run(ctx(api), { source: { branch: "main" } });
    expect(api.mutations()[0]?.payload).toEqual({ source: { branch: "main", path: "/" } });
  });

  test("an empty pages mapping is a note, not an empty PUT", async () => {
    const api = new MockApi({
      "GET /repos/o/r/pages": { data: {} },
    });
    const result = await pagesSection.run(ctx(api), {});
    expect(result.notes).toHaveLength(1);
    expect(api.mutations()).toEqual([]);
  });

  test("pages: null disables a live site and no-ops on an absent one", async () => {
    const api = new MockApi({
      "GET /repos/o/r/pages": { data: { build_type: "legacy" } },
    });
    const result = await pagesSection.run(ctx(api), null);
    expect(result.changes).toEqual(["disabled GitHub Pages"]);
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "DELETE /repos/o/r/pages",
    ]);
    const absent = new MockApi({});
    const noop = await pagesSection.run(ctx(absent), null);
    expect(noop.changes).toEqual([]);
    expect(noop.notes).toHaveLength(1);
    expect(noop.notes[0]).toContain("nothing to disable");
    expect(absent.mutations()).toEqual([]);
  });

  test("pages: null check drifts on a live site and is clean without one", async () => {
    const api = new MockApi({
      "GET /repos/o/r/pages": { data: { build_type: "legacy" } },
    });
    const result = await pagesSection.run(ctx(api, true), null);
    expect(result.drift).toEqual([
      "pages: enabled live but the settings file declares pages: null; apply will disable GitHub Pages",
    ]);
    const absent = new MockApi({});
    const clean = await pagesSection.run(ctx(absent, true), null);
    expect(clean.drift).toEqual([]);
    expect(clean.notes).toHaveLength(1);
  });
});

describe("workflows", () => {
  const liveWorkflows = {
    total_count: 3,
    workflows: [
      { id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" },
      { id: 2, name: "Old", path: ".github/workflows/old.yml", state: "disabled_inactivity" },
      { id: 3, name: "Gone", path: ".github/workflows/gone.yml", state: "deleted" },
    ],
  };
  const route = "GET /repos/o/r/actions/workflows?per_page=100&page=1";

  test("enables and disables by live id, matching bare file names", async () => {
    const api = new MockApi({ [route]: { data: liveWorkflows } });
    const result = await workflowsSection.run(ctx(api), [
      { path: "ci.yml", state: "disabled" },
      { path: ".github/workflows/old.yml", state: "active" },
    ]);
    expect(result.changes).toEqual([
      'disabled workflow ".github/workflows/ci.yml"',
      'enabled workflow ".github/workflows/old.yml"',
    ]);
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "PUT /repos/o/r/actions/workflows/1/disable",
      "PUT /repos/o/r/actions/workflows/2/enable",
    ]);
  });

  test("matching state means no mutation; undeclared workflows stay silent", async () => {
    const api = new MockApi({ [route]: { data: liveWorkflows } });
    const result = await workflowsSection.run(ctx(api), [{ path: "ci.yml", state: "active" }]);
    expect(result.changes).toEqual([]);
    expect(result.notes).toEqual([]);
    expect(api.mutations()).toEqual([]);
  });

  test("check reports drift with the raw live state", async () => {
    const api = new MockApi({ [route]: { data: liveWorkflows } });
    const result = await workflowsSection.run(ctx(api, true), [
      { path: "old.yml", state: "active" },
    ]);
    expect(result.drift).toEqual([
      'workflows[old.yml]: declared "active" != live "disabled" (disabled_inactivity); apply will enable the workflow',
    ]);
    expect(api.mutations()).toEqual([]);
  });

  test("a declared path with no live workflow drifts in check and notes in apply", async () => {
    const api = new MockApi({ [route]: { data: liveWorkflows } });
    const check = await workflowsSection.run(ctx(api, true), [
      { path: "nope.yml", state: "disabled" },
    ]);
    expect(check.drift).toHaveLength(1);
    expect(check.drift[0]).toContain("no workflow with that path exists");
    // A live "deleted" workflow counts as absent too.
    const apply = await workflowsSection.run(ctx(api), [{ path: "gone.yml", state: "active" }]);
    expect(apply.notes).toHaveLength(1);
    expect(apply.changes).toEqual([]);
    expect(api.mutations()).toEqual([]);
  });

  test("duplicate declarations for the same file are rejected before any API call", async () => {
    const api = new MockApi({});
    await expect(
      workflowsSection.run(ctx(api), [
        { path: "ci.yml", state: "disabled" },
        { path: ".github/workflows/ci.yml", state: "active" },
      ]),
    ).rejects.toThrow(/same workflows entry/);
    expect(api.calls).toHaveLength(0);
  });

  test("the workflows envelope paginates past the first page", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      name: `w${i}`,
      path: `.github/workflows/w${i}.yml`,
      state: "active",
    }));
    const page2 = [{ id: 100, name: "tail", path: ".github/workflows/tail.yml", state: "active" }];
    const api = new MockApi({
      "GET /repos/o/r/actions/workflows?per_page=100&page=1": {
        data: { total_count: 101, workflows: page1 },
      },
      "GET /repos/o/r/actions/workflows?per_page=100&page=2": {
        data: { total_count: 101, workflows: page2 },
      },
    });
    const result = await workflowsSection.run(ctx(api), [{ path: "tail.yml", state: "disabled" }]);
    expect(result.changes).toEqual(['disabled workflow ".github/workflows/tail.yml"']);
  });

  test("an envelope without the expected list key is an actionable error", async () => {
    const api = new MockApi({
      [route]: { data: { unexpected: true } },
    });
    await expect(
      workflowsSection.run(ctx(api), [{ path: "ci.yml", state: "active" }]),
    ).rejects.toThrow(/"workflows" list/);
  });
});

describe("code_scanning_default_setup", () => {
  const path = "/repos/o/r/code-scanning/default-setup";
  const live = {
    state: "configured",
    query_suite: "default",
    languages: ["javascript-typescript", "python"],
  };

  test("check compares declared keys only, languages as a set", async () => {
    const api = new MockApi({ [`GET ${path}`]: { data: live } });
    const drifted = await codeScanningDefaultSetupSection.run(ctx(api, true), {
      state: "configured",
      query_suite: "extended",
    });
    expect(drifted.drift).toHaveLength(1);
    expect(drifted.drift[0]).toContain("query_suite");
    const reordered = await codeScanningDefaultSetupSection.run(ctx(api, true), {
      languages: ["python", "javascript-typescript"],
    });
    expect(reordered.drift).toEqual([]);
    expect(api.mutations()).toEqual([]);
  });

  test("apply PATCHes the declared payload verbatim", async () => {
    const api = new MockApi({});
    const result = await codeScanningDefaultSetupSection.run(ctx(api), {
      state: "configured",
      query_suite: "extended",
    });
    expect(result.changes).toEqual(["applied code scanning default setup"]);
    expect(api.mutations()).toEqual([
      {
        method: "PATCH",
        path,
        payload: { state: "configured", query_suite: "extended" },
      },
    ]);
  });

  test("a 202 configuration run is named in the change line", async () => {
    const api = new MockApi({
      [`PATCH ${path}`]: { data: { run_id: 42, run_url: "https://example.test/runs/42" } },
    });
    const result = await codeScanningDefaultSetupSection.run(ctx(api), { state: "configured" });
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toContain("configuration run 42");
  });

  test("409 gets wait-and-retry advice; 403 mentions Advanced Security", async () => {
    const busy = new MockApi({
      [`PATCH ${path}`]: { error: { status: 409, message: "Conflict", body: "" } },
    });
    await expect(
      codeScanningDefaultSetupSection.run(ctx(busy), { state: "configured" }),
    ).rejects.toThrow(/already in progress/);
    const denied = new MockApi({
      [`PATCH ${path}`]: { error: { status: 403, message: "Forbidden", body: "" } },
    });
    await expect(
      codeScanningDefaultSetupSection.run(ctx(denied), { state: "configured" }),
    ).rejects.toThrow(/Advanced Security/);
  });
});

describe("review fixes", () => {
  test("ruleset create defaults enforcement", async () => {
    const api = new MockApi({
      "GET /repos/o/r/rulesets?per_page=100&page=1": { data: [] },
    });
    await rulesetsSection.run(ctx(api), [{ name: "x", target: "branch" }]);
    const payload = api.mutations()[0]?.payload as { enforcement?: string };
    expect(payload.enforcement).toBe("active");
  });

  test("collaborator push matches live role_name write", async () => {
    const api = new MockApi({
      "GET /repos/o/r/collaborators?affiliation=direct&per_page=100&page=1": {
        data: [{ login: "alice", role_name: "write" }],
      },
    });
    const { collaboratorsSection } = await import("../src/sections/misc.js");
    const result = await collaboratorsSection.run(ctx(api, true), [
      { username: "alice", permission: "push" },
    ]);
    expect(result.drift).toEqual([]);
  });
});

describe("section shape validation", () => {
  test("pages: null passes; a bad workflows state fails naming the path", () => {
    expect(validateSectionShapes({ pages: null }, "f.yml")).toBeNull();
    const error = validateSectionShapes(
      { workflows: [{ path: "ci.yml", state: "paused" }] },
      "f.yml",
    );
    expect(error).toContain("workflows[0].state");
  });
});

describe("branches", () => {
  const declared = [{ name: "main", protection: { enforce_admins: true } }];

  test("check: existing unprotected branch reports protectable drift", async () => {
    const api = new MockApi({
      "GET /repos/o/r/branches/main": { data: { name: "main" } },
    });
    const result = await branchesSection.run(ctx(api, true), declared);
    expect(result.drift).toEqual([
      "branches[main]: unprotected live but the settings file declares protection; apply will protect it",
    ]);
  });

  test("check: missing branch is reported as nonexistent, not unprotected", async () => {
    const api = new MockApi({}); // every GET 404s, including the branch itself
    const result = await branchesSection.run(ctx(api, true), declared);
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]).toContain("does not exist");
  });

  test("check: inconclusive branch probe falls back to unprotected drift", async () => {
    const api = new MockApi({
      "GET /repos/o/r/branches/main": { error: { status: 403, message: "Forbidden", body: "" } },
    });
    const result = await branchesSection.run(ctx(api, true), declared);
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]).toContain("apply will protect it");
  });
});
