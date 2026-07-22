import { describe, expect, test } from "bun:test";
import { PermissionDenied } from "../../src/sections/contract.js";
import { normalizeTopics, repositorySection } from "../../src/sections/repository.js";
import { MockApi } from "../mock-api.js";
import { ctx } from "./context.js";

describe("normalizeTopics", () => {
  test("comma string", () => {
    expect(normalizeTopics("Copier, template , ,GitHub-Actions")).toEqual([
      "copier",
      "template",
      "github-actions",
    ]);
  });
  test("array and dedupe", () => {
    expect(normalizeTopics(["A", "a", "b"])).toEqual(["a", "b"]);
  });
});

describe("repository", () => {
  test("splits specials onto their endpoints", async () => {
    const api = new MockApi({}).allowMutations(
      "PATCH /repos/o/r",
      "PUT /repos/o/r/topics",
      "PUT /repos/o/r/vulnerability-alerts",
      "DELETE /repos/o/r/automated-security-fixes",
    );
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
    const api = new MockApi({}).allowMutations(
      "PUT /repos/o/r/private-vulnerability-reporting",
      "DELETE /repos/o/r/private-vulnerability-reporting",
    );
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
