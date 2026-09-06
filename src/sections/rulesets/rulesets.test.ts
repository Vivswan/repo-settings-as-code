import { describe, expect, test } from "bun:test";
import { executePlan } from "../../../src/engine/execute.js";
import type { GithubClient } from "../../../src/github/api.js";
import { type PlannedOp, planContext } from "../../../src/sections/contract/plan.js";
import { MockApi } from "../../../test/mock-api.js";
import { provePlanIdempotent } from "../../../test/sections/plan-idempotence.js";
import { REPO } from "../../../test/sections/section-run.js";
import { normalizeRefName, normalizeRuleset, rulesetsSection } from "./index.js";

describe("normalizeRefName", () => {
  test("branch short name", () => {
    expect(normalizeRefName("staging", "branch")).toBe("refs/heads/staging");
  });
  test("tag pattern", () => {
    expect(normalizeRefName("templates/*", "tag")).toBe("refs/tags/templates/*");
  });
  test("~DEFAULT_BRANCH passthrough", () => {
    expect(normalizeRefName("~DEFAULT_BRANCH", "branch")).toBe("~DEFAULT_BRANCH");
  });
  test("qualified ref passthrough", () => {
    expect(normalizeRefName("refs/heads/main", "branch")).toBe("refs/heads/main");
  });
});

describe("normalizeRuleset", () => {
  test("normalizes includes without mutating input", () => {
    const input = {
      name: "build-tags",
      target: "tag" as const,
      conditions: { ref_name: { include: ["templates/*", "v*"], exclude: [] } },
    };
    const out = normalizeRuleset(input);
    expect(out.conditions?.ref_name?.include).toEqual(["refs/tags/templates/*", "refs/tags/v*"]);
    expect(input.conditions.ref_name.include).toEqual(["templates/*", "v*"]);
  });
});

/** A live ruleset as the list summary and the by-id read return it. */
type LiveRuleset = Record<string, unknown> & { id: number; name: string; source_type?: string };

/**
 * A stateful fake of the rulesets API: reads reflect every write, so a plan
 * over executed state sees the converged repository. `ignoredKeys` are
 * accepted on a write and dropped, as GitHub does with a key it does not know.
 */
function liveRepo(
  rulesets: LiveRuleset[],
  ignoredKeys: readonly string[] = [],
): GithubClient & { writes: string[] } {
  let nextId = 1000;
  const stored = (body: unknown): Record<string, unknown> =>
    Object.fromEntries(Object.entries(body ?? {}).filter(([key]) => !ignoredKeys.includes(key)));
  return {
    writes: [],
    async tryRequest(method, path, payload) {
      const byId = path.match(/\/rulesets\/(\d+)$/);
      const target = rulesets.find((r) => String(r.id) === byId?.[1]);
      if (method === "GET") {
        if (byId === null) {
          return { data: rulesets.map(({ id, name, source_type }) => ({ id, name, source_type })) };
        }
        return target === undefined
          ? { error: { status: 404, message: "Not Found", body: "" } }
          : { data: target };
      }
      this.writes.push(`${method} ${path}`);
      const body = stored(payload);
      if (method === "POST") {
        const created = { id: nextId++, source_type: "Repository", ...body } as LiveRuleset;
        rulesets.push(created);
        return { data: created };
      }
      if (target === undefined) {
        return { error: { status: 404, message: "Not Found", body: "" } };
      }
      if (method === "PUT") {
        Object.assign(target, body);
        return { data: target };
      }
      rulesets.splice(rulesets.indexOf(target), 1);
      return { data: null };
    },
    async tryGraphql() {
      throw new Error("the rulesets section issues no GraphQL");
    },
  };
}

describe("rulesets", () => {
  const listRoute = "GET /repos/o/r/rulesets?per_page=100&page=1";
  const plan = (api: MockApi, desired: Parameters<typeof rulesetsSection.plan>[1]) =>
    rulesetsSection.plan(planContext(rulesetsSection, api, REPO), desired);
  /** A mock that would accept every write the section declares. */
  const writable = (routes: ConstructorParameters<typeof MockApi>[0]) =>
    new MockApi(routes).allowMutations(
      "POST /repos/o/r/rulesets",
      "PUT /repos/o/r/rulesets/*",
      "DELETE /repos/o/r/rulesets/*",
    );

  test("a missing ruleset plans a create with normalized refs and defaults; undeclared ones are notes", async () => {
    const api = writable({
      [listRoute]: { data: [{ id: 7, name: "legacy", source_type: "Repository" }] },
    });
    const result = await plan(api, [
      {
        name: "build-tags",
        target: "tag",
        conditions: { ref_name: { include: ["templates/*"], exclude: [] } },
        rules: [{ type: "deletion" }],
      },
    ]);
    expect(result).toEqual({
      ops: [
        {
          role: "create",
          payload: {
            name: "build-tags",
            target: "tag",
            enforcement: "active",
            conditions: { ref_name: { include: ["refs/tags/templates/*"], exclude: [] } },
            rules: [{ type: "deletion" }],
          },
          describe: 'creating ruleset "build-tags"',
          drift: [
            "rulesets[build-tags]: missing - declared in the settings file but not on the repo; apply will create it",
          ],
          change: 'created ruleset "build-tags"',
        },
      ],
      notes: [
        'ruleset "legacy" exists on the repo but is not declared in the settings file; kept under "undeclared: keep" - add it to the settings file to manage it, or set "undeclared: delete" to have apply DELETE it',
      ],
      drift: [],
    });
    // Planning reads and never writes, even against a client that would accept one.
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([listRoute]);
  });

  test("a divergent existing ruleset plans a full-payload update carrying the subset drift", async () => {
    const api = writable({
      [listRoute]: { data: [{ id: 9, name: "main", source_type: "Repository" }] },
      "GET /repos/o/r/rulesets/9": {
        data: {
          id: 9,
          name: "main",
          target: "branch",
          enforcement: "evaluate",
          rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
          bypass_actors: [{ actor_id: 1, actor_type: "Team" }],
        },
      },
    });
    const result = await plan(api, [
      { name: "main", target: "branch", rules: [{ type: "deletion" }] },
    ]);
    expect(result).toEqual({
      ops: [
        {
          role: "update",
          params: { ruleset_id: "9" },
          payload: {
            name: "main",
            target: "branch",
            enforcement: "active",
            rules: [{ type: "deletion" }],
          },
          describe: 'updating ruleset "main"',
          drift: [
            "rulesets[main].rules[non_fast_forward]: present live but not declared",
            'rulesets[main].enforcement: "active" != "evaluate"',
          ],
          change: 'updated ruleset "main" (id 9)',
        },
      ],
      notes: [],
      drift: [],
    });
    expect(api.mutations()).toEqual([]);
  });

  test("a declared key the live ruleset lacks is drift plus a phantom-key note", async () => {
    // A declared key the read-back lacks is either ignored (a typo) or
    // write-only; one read cannot tell, so the update still runs and the
    // note warns that it will keep running until the key is fixed or removed.
    const api = writable({
      [listRoute]: { data: [{ id: 9, name: "main", source_type: "Repository" }] },
      "GET /repos/o/r/rulesets/9": {
        data: { id: 9, name: "main", target: "branch", enforcement: "active" },
      },
    });
    // A variable, not a literal, so the extra key is a passthrough field to
    // the type checker rather than an excess property.
    const misspelled = { name: "main", target: "branch" as const, enforcemant: "evaluate" };
    const result = await plan(api, [misspelled]);
    expect(result).toEqual({
      ops: [
        {
          role: "update",
          params: { ruleset_id: "9" },
          payload: { ...misspelled, enforcement: "active" },
          describe: 'updating ruleset "main"',
          drift: [
            'rulesets[main].enforcemant: declared "evaluate" but the API response has no such field (new or write-only field?)',
          ],
          change: 'updated ruleset "main" (id 9)',
        },
      ],
      notes: [
        'rulesets[main]: declared key(s) "enforcemant" do not exist on the live ruleset, so if GitHub ignores them this update will re-run on every apply without converging. Fix the key name, or remove it from the settings file',
      ],
      drift: [],
    });
  });

  test("a key GitHub drops re-plans the identical update and note on every pass: documented non-convergence", async () => {
    // One read cannot tell a typo from a field GitHub omits until set, so the
    // write is never withheld; the note is what tells the user it recurs.
    const api = liveRepo(
      [{ id: 9, name: "main", source_type: "Repository", target: "branch", enforcement: "active" }],
      ["enforcemant"],
    );
    const misspelled = { name: "main", target: "branch" as const, enforcemant: "evaluate" };
    const pass = async () =>
      rulesetsSection.plan(planContext(rulesetsSection, api, REPO), [misspelled]);
    const first = await pass();
    const execution = await executePlan(first, rulesetsSection, api, REPO, {
      resolveSecret() {
        throw new Error("no secrets");
      },
    });
    expect(execution).toEqual({
      status: "applied",
      changes: ['updated ruleset "main" (id 9)'],
      notes: [],
      landed: 1,
    });
    const second = await pass();
    expect(first).toEqual({
      ops: [
        {
          role: "update",
          params: { ruleset_id: "9" },
          payload: { ...misspelled, enforcement: "active" },
          describe: 'updating ruleset "main"',
          drift: [
            'rulesets[main].enforcemant: declared "evaluate" but the API response has no such field (new or write-only field?)',
          ],
          change: 'updated ruleset "main" (id 9)',
        },
      ],
      notes: [
        'rulesets[main]: declared key(s) "enforcemant" do not exist on the live ruleset, so if GitHub ignores them this update will re-run on every apply without converging. Fix the key name, or remove it from the settings file',
      ],
      drift: [],
    });
    expect(second).toEqual(first);
    expect(api.writes).toEqual(["PUT /repos/o/r/rulesets/9"]);
  });

  test("a converged ruleset plans nothing: rules match by type regardless of order", async () => {
    const api = writable({
      [listRoute]: { data: [{ id: 9, name: "main", source_type: "Repository" }] },
      "GET /repos/o/r/rulesets/9": {
        data: {
          id: 9,
          name: "main",
          target: "branch",
          enforcement: "active",
          conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
          rules: [{ type: "non_fast_forward" }, { type: "deletion" }],
        },
      },
    });
    const result = await plan(api, [
      {
        name: "main",
        conditions: { ref_name: { include: ["main"] } },
        rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
      },
    ]);
    expect(result).toEqual({ ops: [], notes: [], drift: [] });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      listRoute,
      "GET /repos/o/r/rulesets/9",
    ]);
  });

  test("duplicate ruleset names are rejected before any API call", async () => {
    const api = new MockApi({});
    await expect(
      plan(api, [
        { name: "main", target: "branch" },
        { name: "main", target: "tag" },
      ]),
    ).rejects.toThrow(/same rulesets entry/);
    expect(api.calls).toHaveLength(0);
  });

  test("wrapped undeclared:delete plans the DELETE after the declared upserts", async () => {
    const api = writable({
      [listRoute]: {
        data: [
          { id: 7, name: "legacy", source_type: "Repository" },
          { id: 9, name: "main", source_type: "Repository" },
        ],
      },
      "GET /repos/o/r/rulesets/9": {
        data: { id: 9, name: "main", target: "branch", enforcement: "disabled", rules: [] },
      },
    });
    const result = await plan(api, {
      undeclared: "delete",
      entries: [{ name: "main", target: "branch", rules: [{ type: "deletion" }] }],
    });
    expect(result).toEqual({
      ops: [
        {
          role: "update",
          params: { ruleset_id: "9" },
          payload: {
            name: "main",
            target: "branch",
            enforcement: "active",
            rules: [{ type: "deletion" }],
          },
          describe: 'updating ruleset "main"',
          drift: [
            "rulesets[main].rules[deletion]: missing live",
            'rulesets[main].enforcement: "active" != "disabled"',
          ],
          change: 'updated ruleset "main" (id 9)',
        },
        {
          role: "remove",
          params: { ruleset_id: "7" },
          describe: 'deleting undeclared ruleset "legacy"',
          drift: [
            'rulesets[legacy]: undeclared - not in the settings file and "undeclared: delete" is set, so apply will DELETE it; add it to the settings file to keep it',
          ],
          change: 'DELETED undeclared ruleset "legacy"',
        },
      ],
      notes: [],
      drift: [],
    });
    expect(api.mutations()).toEqual([]);
  });

  test("undeclared:delete never deletes a ruleset without an explicit Repository source", async () => {
    // source_type is optional in the API type; a missing field is not proof
    // of repository ownership, and deletion cannot be undone. Organization
    // and enterprise rulesets never enter the managed list at all.
    const api = writable({
      [listRoute]: {
        data: [
          { id: 7, name: "ambiguous" },
          { id: 8, name: "org-owned", source_type: "Organization" },
          { id: 9, name: "enterprise-owned", source_type: "Enterprise" },
          { id: 10, name: "repo-owned", source_type: "Repository" },
        ],
      },
    });
    expect(await plan(api, { undeclared: "delete", entries: [] })).toEqual({
      ops: [
        {
          role: "remove",
          params: { ruleset_id: "10" },
          describe: 'deleting undeclared ruleset "repo-owned"',
          drift: [
            'rulesets[repo-owned]: undeclared - not in the settings file and "undeclared: delete" is set, so apply will DELETE it; add it to the settings file to keep it',
          ],
          change: 'DELETED undeclared ruleset "repo-owned"',
        },
      ],
      notes: [
        'ruleset "ambiguous" is undeclared, but the list response does not mark it source_type "Repository"; NOT deleting - only rulesets the API explicitly marks repository-owned are deleted; add it to the settings file to manage it, or delete it in GitHub if it should not exist',
      ],
      drift: [],
    });
  });

  test("the wrapper without a policy keeps the keep default (notes only)", async () => {
    const api = writable({
      [listRoute]: { data: [{ id: 7, name: "legacy", source_type: "Repository" }] },
    });
    expect(await plan(api, { entries: [] })).toEqual({
      ops: [],
      notes: [
        'ruleset "legacy" exists on the repo but is not declared in the settings file; kept under "undeclared: keep" - add it to the settings file to manage it, or set "undeclared: delete" to have apply DELETE it',
      ],
      drift: [],
    });
  });

  test("executing the plan converges: create, update, and delete land once, then the re-plan is empty", async () => {
    const api = liveRepo([
      { id: 7, name: "legacy", source_type: "Repository", enforcement: "active" },
      { id: 9, name: "main", source_type: "Repository", target: "branch", enforcement: "evaluate" },
      { id: 900, name: "org-baseline", source_type: "Organization", enforcement: "active" },
    ]);
    const { first, second, changes } = await provePlanIdempotent(rulesetsSection, api, {
      undeclared: "delete",
      entries: [
        { name: "main", target: "branch", enforcement: "active", rules: [{ type: "deletion" }] },
        { name: "tags", target: "tag", conditions: { ref_name: { include: ["v*"] } } },
      ],
    });
    expect(changes).toEqual([
      'updated ruleset "main" (id 9)',
      'created ruleset "tags"',
      'DELETED undeclared ruleset "legacy"',
    ]);
    expect(api.writes).toEqual([
      "PUT /repos/o/r/rulesets/9",
      "POST /repos/o/r/rulesets",
      "DELETE /repos/o/r/rulesets/7",
    ]);
    expect(first.drift).toEqual([]);
    expect(second).toEqual({ ops: [], notes: [], drift: [] });
  });

  test("the read port exposes the list and get roles, the list narrowed to its denied posture", () => {
    const ctx = planContext(rulesetsSection, new MockApi({}), REPO);
    expect(Object.keys(ctx.read)).toEqual(["list", "get"]);
    // @ts-expect-error a write role is not a read: the port has no `create`
    ctx.read.create;
    // @ts-expect-error nor an `update`
    ctx.read.update;
    // @ts-expect-error nor a `remove`
    ctx.read.remove;
    // @ts-expect-error nor the raw client
    ctx.api;
    // @ts-expect-error a "denied" primary read offers no 404-tolerant helper
    ctx.read.list.probeAbsent;
    // @ts-expect-error nor the tolerant tryCall
    ctx.read.list.tryCall;
  });

  test("a planned operation can only name a declared write role, and must justify itself", () => {
    // Compile-time only: the plans are never executed. Each rejected shape
    // is built first and assigned on one line, so the directive anchors to
    // the assignment whichever property the compiler blames.
    type Op = PlannedOp<typeof rulesetsSection.endpoints>;
    const create: Op = { role: "create", payload: { name: "x" }, drift: ["missing"], change: "" };
    expect(create.role).toBe("create");
    const read = { role: "get", params: { ruleset_id: "1" }, drift: ["x"], change: "" } as const;
    // @ts-expect-error the get role is a read, not a plannable write
    const _read: Op = read;
    const paramless = { role: "update", payload: {}, drift: ["x"], change: "" } as const;
    // @ts-expect-error the route's ruleset_id path param is required
    const _paramless: Op = paramless;
    const silent = { role: "create", payload: {}, drift: [], change: "" } as const;
    // @ts-expect-error a write on a non-alwaysRewrite endpoint must carry drift
    const _silent: Op = silent;
  });
});
