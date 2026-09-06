import { describe, expect, test } from "bun:test";
import { planContext } from "../../../src/sections/contract/plan.js";
import { MockApi } from "../../../test/mock-api.js";
import { fragmentFake } from "../../../test/sections/fragment-fake.js";
import { provePlanIdempotent } from "../../../test/sections/plan-idempotence.js";
import { REPO } from "../../../test/sections/section-run.js";
import { milestonesSection } from "./index.js";
import { milestonesMockHandlers } from "./mock.js";

/** Closed milestones are listed too: the read asks for state=all. */
const LIST = "GET /repos/o/r/milestones?state=all&per_page=100&page=1";
const liveMilestones = [
  { number: 1, title: "v1", description: null, state: "open" },
  { number: 2, title: "old", description: null, state: "open" },
];
const KEEP_NOTE =
  'milestone "old" exists on the repo but is not declared in the settings file; kept under ' +
  '"undeclared: keep" - add it to the settings file to manage it, or set "undeclared: delete" ' +
  "to have apply DELETE it, detaching it from every issue that carries it (closing is not " +
  "enough; closed milestones are still listed)";
const plan = (api: MockApi, desired: Parameters<typeof milestonesSection.plan>[1]) =>
  milestonesSection.plan(planContext(milestonesSection, api, REPO), desired);

describe("milestones", () => {
  test("plans an update per drifted milestone and a create per missing one, keeps the undeclared one as a note, reading only", async () => {
    const api = new MockApi({ [LIST]: { data: liveMilestones } });
    const result = await plan(api, [
      { title: "v1", description: "first", state: "closed" },
      { title: "v2" },
    ]);
    expect(result).toEqual({
      ops: [
        {
          role: "update",
          params: { milestone_number: "1" },
          payload: { title: "v1", description: "first", state: "closed" },
          describe: 'updating milestone "v1"',
          drift: [
            'milestones[v1].description: "first" != null',
            'milestones[v1].state: "closed" != "open"',
          ],
          change: 'updated milestone "v1"',
        },
        {
          role: "create",
          payload: { title: "v2" },
          describe: 'creating milestone "v2"',
          drift: [
            "milestones[v2]: missing - declared in the settings file but not on the repo; apply will create it",
          ],
          change: 'created milestone "v2"',
        },
      ],
      notes: [KEEP_NOTE],
      drift: [],
    });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([LIST]);
  });

  test("a matching milestone plans nothing: a declared empty description reads as the live null", async () => {
    const api = new MockApi({ [LIST]: { data: liveMilestones } });
    const result = await plan(api, {
      undeclared: "keep",
      entries: [
        { title: "v1", description: "" },
        { title: "old", state: "open" },
      ],
    });
    expect(result).toEqual({ ops: [], notes: [], drift: [] });
  });

  test("a declared key the live milestone lacks is drift plus a phantom note beside the update", async () => {
    const api = new MockApi({ [LIST]: { data: liveMilestones } });
    const result = await plan(api, {
      undeclared: "keep",
      entries: [{ title: "v1", due_on: "2026-01-15T00:00:00Z" } as never],
    });
    expect(result.ops.map((op) => [op.role, op.payload, op.drift])).toEqual([
      [
        "update",
        { title: "v1", due_on: "2026-01-15T00:00:00Z" },
        [
          'milestones[v1].due_on: declared "2026-01-15T00:00:00Z" but the API response has no such field (new or write-only field?)',
        ],
      ],
    ]);
    expect(result.notes).toEqual([
      'milestones[v1]: declared key(s) "due_on" do not exist on the live milestone, so if GitHub ignores them this update will re-run on every apply without converging. Fix the key name, or remove it from the settings file',
      KEEP_NOTE,
    ]);
  });

  test.each<
    [
      form: string,
      declared: Parameters<typeof milestonesSection.plan>[1],
      ops: Awaited<ReturnType<typeof plan>>["ops"],
      notes: string[],
    ]
  >([
    [
      "wrapped undeclared:delete",
      { undeclared: "delete", entries: [{ title: "v1" }] },
      [
        {
          role: "remove",
          params: { milestone_number: "2" },
          describe: 'deleting undeclared milestone "old"',
          drift: [
            'milestones[old]: undeclared - not in the settings file and "undeclared: delete" is set, so apply will DELETE it, detaching it from every issue that carries it; add it to the settings file to keep it',
          ],
          change: 'DELETED undeclared milestone "old" (detached from every issue that carried it)',
        },
      ],
      [],
    ],
    ["the wrapper without a policy", { entries: [{ title: "v1" }] }, [], [KEEP_NOTE]],
    ["the plain list", [{ title: "v1" }], [], [KEEP_NOTE]],
  ])(
    "%s resolves the undeclared milestone against the keep default, naming the detach consequence",
    async (_form, declared, ops, notes) => {
      const api = new MockApi({ [LIST]: { data: liveMilestones } });
      const result = await plan(api, declared);
      expect(result).toEqual({ ops, notes, drift: [] });
    },
  );

  test("duplicate titles are rejected before any API call", async () => {
    const api = new MockApi({});
    await expect(plan(api, [{ title: "v1" }, { title: "v1", state: "closed" }])).rejects.toThrow(
      /same milestones entry/,
    );
    expect(api.calls).toHaveLength(0);
  });

  test("executing the plan against the mock converges: the re-plan is empty", async () => {
    const api = fragmentFake(milestonesSection, milestonesMockHandlers, {
      milestones: [
        {
          id: 900001,
          number: 1,
          state: "open",
          title: "v0.9",
          description: "Old preview.",
          due_on: null,
        },
        {
          id: 900002,
          number: 7,
          state: "open",
          title: "v1.0",
          description: "Outdated description.",
          due_on: null,
        },
      ],
    });
    const { second, changes, notes } = await provePlanIdempotent(milestonesSection, api, {
      undeclared: "delete",
      entries: [
        {
          title: "v1.0",
          description: "First stable release.",
          due_on: "2026-06-30T00:00:00Z",
        } as never,
        { title: "v2.0", state: "closed" },
      ],
    });
    expect(changes).toEqual([
      'updated milestone "v1.0"',
      'created milestone "v2.0"',
      'DELETED undeclared milestone "v0.9" (detached from every issue that carried it)',
    ]);
    expect(notes).toEqual([]);
    expect(api.writes).toEqual([
      "PATCH /repos/o/r/milestones/7",
      "POST /repos/o/r/milestones",
      "DELETE /repos/o/r/milestones/1",
    ]);
    expect(second).toEqual({ ops: [], notes: [], drift: [] });
    expect(api.state.milestones.map((m) => [m.title, m.description, m.state, m.due_on])).toEqual([
      ["v1.0", "First stable release.", "open", "2026-06-30T00:00:00Z"],
      ["v2.0", null, "closed", undefined],
    ]);
  });

  test("the read port exposes exactly the list role in its denied posture", () => {
    const ctx = planContext(milestonesSection, new MockApi({}), REPO);
    expect(Object.keys(ctx.read)).toEqual(["list"]);
    // @ts-expect-error a write role is not a read: the port has no `create`
    ctx.read.create;
    // @ts-expect-error nor an `update`
    ctx.read.update;
    // @ts-expect-error nor a `remove`
    ctx.read.remove;
    // @ts-expect-error a "denied" primary read offers no 404-tolerant helper
    ctx.read.list.probeAbsent;
  });
});
