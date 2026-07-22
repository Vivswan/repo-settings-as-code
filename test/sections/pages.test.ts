import { describe, expect, test } from "bun:test";
import { pagesSection } from "../../src/sections/pages.js";
import { MockApi } from "../mock-api.js";
import { ctx } from "./context.js";

describe("pages", () => {
  test("creates when absent, then PUTs the update-only fields", async () => {
    const api = new MockApi({}).allowMutations("POST /repos/o/r/pages", "PUT /repos/o/r/pages"); // GET /pages 404s
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
    }).allowMutations("PUT /repos/o/r/pages");
    const result = await pagesSection.run(ctx(api), { build_type: "workflow" });
    expect(result.changes).toEqual(["updated GitHub Pages configuration"]);
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual(["PUT /repos/o/r/pages"]);
  });

  test("a source without a path gets the default path everywhere", async () => {
    const api = new MockApi({
      "GET /repos/o/r/pages": { data: {} },
    }).allowMutations("PUT /repos/o/r/pages");
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
    }).allowMutations("DELETE /repos/o/r/pages");
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
