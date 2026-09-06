import { describe, expect, test } from "bun:test";
import type { GithubClient } from "../../../src/github/api.js";
import { type PlannedOp, planContext } from "../../../src/sections/contract/plan.js";
import { MockApi } from "../../../test/mock-api.js";
import { provePlanIdempotent } from "../../../test/sections/plan-idempotence.js";
import { REPO } from "../../../test/sections/section-run.js";
import { pagesSection } from "./index.js";

const GET = "GET /repos/o/r/pages";

/**
 * A stateful fake of the Pages API: the GET reflects every create, update,
 * and delete, so a plan over executed state sees the converged site.
 */
function liveRepo(site: Record<string, unknown> | null): GithubClient & { writes: string[] } {
  let live = site;
  return {
    writes: [],
    async tryRequest(method, path, payload) {
      if (method === "GET") {
        return live === null
          ? { error: { status: 404, message: "Not Found", body: "" } }
          : { data: live };
      }
      this.writes.push(`${method} ${path}`);
      if (method === "DELETE") {
        live = null;
      } else {
        live = { ...(live ?? {}), ...(payload as Record<string, unknown>) };
      }
      return { data: null };
    },
    async tryGraphql() {
      throw new Error("the pages section issues no GraphQL");
    },
  };
}

describe("pages", () => {
  const plan = (api: MockApi, desired: Parameters<typeof pagesSection.plan>[1]) =>
    pagesSection.plan(planContext(pagesSection, api, REPO), desired);

  test("no live site: create carries build_type and source, then the update the rest", async () => {
    const api = new MockApi({}); // GET /pages 404s
    const result = await plan(api, {
      build_type: "legacy",
      source: { branch: "main", path: "/docs" },
      cname: "docs.example.com",
      https_enforced: true,
    });
    expect(result).toEqual({
      ops: [
        {
          role: "create",
          payload: { build_type: "legacy", source: { branch: "main", path: "/docs" } },
          drift: [
            "pages: declared in the settings file but GitHub Pages is not enabled on the repo; apply will enable it",
          ],
          change: "enabled GitHub Pages",
        },
        {
          role: "update",
          payload: {
            build_type: "legacy",
            source: { branch: "main", path: "/docs" },
            cname: "docs.example.com",
            https_enforced: true,
          },
          drift: [
            "pages: the create call takes only build_type and source, so apply will then set the remaining configuration (cname, https_enforced)",
          ],
          change: "applied remaining Pages configuration",
        },
      ],
      notes: [],
      drift: [],
    });
    // Planning reads and never writes.
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([GET]);
  });

  test("a live site is updated in place only where it diverges", async () => {
    const api = new MockApi({ [GET]: { data: { build_type: "legacy", cname: null } } });
    const result = await plan(api, { build_type: "workflow" });
    expect(result.ops).toEqual([
      {
        role: "update",
        payload: { build_type: "workflow" },
        drift: ['pages.build_type: "workflow" != "legacy"'],
        change: "updated GitHub Pages configuration",
      },
    ]);
    const matching = await plan(api, { build_type: "legacy" });
    expect(matching).toEqual({ ops: [], notes: [], drift: [] });
  });

  test("a source without a path gets the default path everywhere", async () => {
    const api = new MockApi({ [GET]: { data: {} } });
    const result = await plan(api, { source: { branch: "main" } });
    expect(result.ops[0]?.payload).toEqual({ source: { branch: "main", path: "/" } });
  });

  test("an empty pages mapping is a note, not an empty PUT", async () => {
    const api = new MockApi({ [GET]: { data: {} } });
    expect(await plan(api, {})).toEqual({
      ops: [],
      notes: [
        "pages: declared as an empty mapping, which configures nothing (the update endpoint rejects an empty body). Declare at least one field, use pages: null to disable the site, or remove the section",
      ],
      drift: [],
    });
  });

  test("a passthrough key named like a prototype member still reaches the second PUT", async () => {
    // The create body is a plain object, so an `in` check would see
    // Object.prototype's members and drop such a key from the remainder.
    const api = new MockApi({});
    const result = await plan(api, {
      source: { branch: "main" },
      constructor: "rides along",
    } as Parameters<typeof pagesSection.plan>[1]);
    expect(result.ops.map((op) => [op.role, op.payload])).toEqual([
      ["create", { source: { branch: "main", path: "/" } }],
      ["update", { source: { branch: "main", path: "/" }, constructor: "rides along" }],
    ]);
  });

  test("a passthrough value JSON cannot carry is a BUG naming its path, never a wire body", async () => {
    // Every pages payload crosses plainData(): the loose shape lets an
    // arbitrary passthrough value through, and only a JSON-plain one may leave.
    const api = new MockApi({ [GET]: { data: {} } });
    await expect(
      plan(api, { cname: "docs.example.com", hook: () => "x" } as unknown as Parameters<
        typeof pagesSection.plan
      >[1]),
    ).rejects.toThrow(/BUG: a planned payload carries a value JSON cannot carry at hook/);
    expect(api.mutations()).toEqual([]);
  });

  test("pages: null disables a live site and notes the ambiguous absence of one", async () => {
    const api = new MockApi({ [GET]: { data: { build_type: "legacy" } } });
    const result = await plan(api, null);
    expect(result).toEqual({
      ops: [
        {
          role: "remove",
          drift: [
            "pages: enabled live but the settings file declares pages: null; apply will disable GitHub Pages",
          ],
          change: "disabled GitHub Pages",
        },
      ],
      notes: [],
      drift: [],
    });
    expect(await plan(new MockApi({}), null)).toEqual({
      ops: [],
      notes: [
        "pages: declared null and GitHub reports no Pages site, so there is nothing to disable. A fine-grained token missing the Pages permission gets the same answer; if this repo does have a Pages site, grant the token Pages read and write",
      ],
      drift: [],
    });
  });

  test("executing the plan converges: create-then-update, then nothing", async () => {
    const api = liveRepo(null);
    const { second, changes } = await provePlanIdempotent(pagesSection, api, {
      build_type: "workflow",
      source: { branch: "main" },
      cname: "docs.example.com",
    });
    expect(changes).toEqual(["enabled GitHub Pages", "applied remaining Pages configuration"]);
    expect(api.writes).toEqual(["POST /repos/o/r/pages", "PUT /repos/o/r/pages"]);
    expect(second).toEqual({ ops: [], notes: [], drift: [] });
  });

  test("executing pages: null converges: the delete, then the nothing-to-disable note", async () => {
    const api = liveRepo({ build_type: "legacy" });
    const { second, changes } = await provePlanIdempotent(pagesSection, api, null);
    expect(changes).toEqual(["disabled GitHub Pages"]);
    expect(api.writes).toEqual(["DELETE /repos/o/r/pages"]);
    expect(second.ops).toEqual([]);
    expect(second.notes[0]).toStartWith("pages: declared null and GitHub reports no Pages site");
  });

  test("the read port exposes exactly the site probe, narrowed to its absent posture", () => {
    const ctx = planContext(pagesSection, new MockApi({}), REPO);
    expect(Object.keys(ctx.read)).toEqual(["get"]);
    // @ts-expect-error a write role is not a read: the port has no `create`
    ctx.read.create;
    // @ts-expect-error nor an `update`
    ctx.read.update;
    // @ts-expect-error nor a `remove`
    ctx.read.remove;
    // @ts-expect-error nor the raw client
    ctx.api;
    // @ts-expect-error an "absent" primary read offers no throwing helper
    ctx.read.get.call;
  });

  test("a planned operation can only name a declared write role, and must justify itself", () => {
    type Op = PlannedOp<typeof pagesSection.endpoints>;
    const read = { role: "get", drift: ["x"], change: "" } as const;
    // @ts-expect-error the get role is a read, not a plannable write
    const _read: Op = read;
    const silent = { role: "remove", drift: [], change: "" } as const;
    // @ts-expect-error a write on a non-alwaysRewrite endpoint must carry drift
    const _silent: Op = silent;
  });
});
