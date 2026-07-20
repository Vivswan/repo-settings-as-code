import { describe, expect, test } from "bun:test";
import type { ApiError, GithubApi } from "../src/api.js";
import { branchesSection } from "../src/sections/branches.js";
import { labelsSection } from "../src/sections/labels.js";
import { repositorySection } from "../src/sections/repository.js";
import { rulesetsSection } from "../src/sections/rulesets.js";
import type { SectionContext } from "../src/sections/section.js";
import { PermissionDenied } from "../src/sections/section.js";

type Route = { data?: unknown; error?: ApiError };

/** Duck-typed GithubApi over a route table; records every mutation. */
class MockApi {
  calls: Array<{ method: string; path: string; payload?: unknown }> = [];
  constructor(private routes: Record<string, Route>) {}

  async tryRequest(method: string, path: string, payload?: unknown) {
    this.calls.push({ method, path, payload });
    const route = this.routes[`${method} ${path}`];
    if (!route) {
      if (method === "GET") {
        return { error: { status: 404, message: "Not Found", body: "" } };
      }
      return { data: null }; // unrouted mutations succeed silently
    }
    if (route.error) {
      return { error: route.error };
    }
    return { data: route.data ?? null };
  }

  async request(method: string, path: string, payload?: unknown) {
    const result = await this.tryRequest(method, path, payload);
    if ("error" in result && result.error) {
      throw new Error(`${method} ${path}: ${result.error.status}`);
    }
    return "data" in result ? result.data : null;
  }

  async list(path: string) {
    return (await this.request("GET", path)) as unknown[];
  }

  mutations() {
    return this.calls.filter((c) => c.method !== "GET");
  }
}

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
