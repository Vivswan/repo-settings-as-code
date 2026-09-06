import { describe, expect, test } from "bun:test";
import { executePlan } from "../../../src/engine/execute.js";
import { planContext } from "../../../src/sections/contract/plan.js";
import { MockApi } from "../../../test/mock-api.js";
import { fragmentFake } from "../../../test/sections/fragment-fake.js";
import { provePlanIdempotent } from "../../../test/sections/plan-idempotence.js";
import { REPO } from "../../../test/sections/section-run.js";
import { labelsSection } from "./index.js";
import { labelsMockHandlers } from "./mock.js";

const LIST = "GET /repos/o/r/labels?per_page=100&page=1";
const liveLabels = [
  { name: "bug", color: "d73a4a", description: "Something isn't working" },
  { name: "stale", color: "ffffff", description: null },
];
const plan = (api: MockApi, desired: Parameters<typeof labelsSection.plan>[1]) =>
  labelsSection.plan(planContext(labelsSection, api, REPO), desired);

describe("labels", () => {
  test("plans a create per missing label, an update per drifted one, and a delete per undeclared one, reading only", async () => {
    const api = new MockApi({ [LIST]: { data: liveLabels } });
    const result = await plan(api, [
      { name: "Bug", color: "#000000", description: "Something isn't working" },
      { name: "enhancement", color: "a2eeef" },
    ]);
    expect(result).toEqual({
      ops: [
        {
          role: "update",
          params: { name: "bug" },
          payload: { new_name: "Bug", color: "000000", description: "Something isn't working" },
          describe: 'updating label "Bug"',
          drift: [
            'labels[bug]: should be named "Bug" per the settings file; apply will rename it',
            'labels[Bug].color: declared "000000" != live "d73a4a"; apply will set the declared value',
          ],
          change: 'updated label "Bug"',
        },
        {
          role: "create",
          payload: { name: "enhancement", color: "a2eeef" },
          describe: 'creating label "enhancement"',
          drift: [
            "labels[enhancement]: missing - declared in the settings file but not on the repo; apply will create it",
          ],
          change: 'created label "enhancement"',
        },
        {
          role: "remove",
          params: { name: "stale" },
          describe: 'deleting undeclared label "stale"',
          drift: [
            "labels[stale]: undeclared - not in the settings file, so apply will DELETE it; add it to the settings file to keep it",
          ],
          change: 'DELETED undeclared label "stale"',
        },
      ],
      notes: [],
      drift: [],
    });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([LIST]);
  });

  test("a matching label plans nothing: color case and '#' fold, and a live null description reads as empty", async () => {
    const api = new MockApi({ [LIST]: { data: liveLabels } });
    const result = await plan(api, {
      undeclared: "keep",
      entries: [
        { name: "BUG", new_name: "bug", color: "#D73A4A", description: "Something isn't working" },
        { name: "stale", description: "" },
      ],
    });
    expect(result).toEqual({ ops: [], notes: [], drift: [] });
  });

  test("a declared key the live label lacks is drift plus a phantom note beside the update", async () => {
    const api = new MockApi({ [LIST]: { data: liveLabels } });
    const result = await plan(api, [{ name: "bug", colr: "000000", description: "" } as never]);
    expect(result).toEqual({
      ops: [
        {
          role: "update",
          params: { name: "bug" },
          payload: { new_name: "bug", description: "", colr: "000000" },
          describe: 'updating label "bug"',
          drift: [
            'labels[bug].description: declared "" != live "Something isn\'t working"; apply will set the declared value',
            'labels[bug].colr: declared "000000" but the API response has no such field (new or write-only field?)',
          ],
          change: 'updated label "bug"',
        },
        {
          role: "remove",
          params: { name: "stale" },
          describe: 'deleting undeclared label "stale"',
          drift: [
            "labels[stale]: undeclared - not in the settings file, so apply will DELETE it; add it to the settings file to keep it",
          ],
          change: 'DELETED undeclared label "stale"',
        },
      ],
      notes: [
        'labels[bug]: declared key(s) "colr" do not exist on the live label, so if GitHub ignores them this update will re-run on every apply without converging. Fix the key name, or remove it from the settings file',
      ],
      drift: [],
    });
  });

  test.each<
    [
      form: string,
      declared: Parameters<typeof labelsSection.plan>[1],
      roles: string[],
      notes: string[],
    ]
  >([
    [
      "wrapped undeclared:keep",
      { undeclared: "keep", entries: [{ name: "bug", color: "d73a4a" }] },
      [],
      [
        'label "stale" exists on the repo but is not declared in the settings file; kept under "undeclared: keep" - add it to the settings file to manage it, or set "undeclared: delete" to have apply DELETE it',
      ],
    ],
    [
      "the wrapper without a policy",
      { entries: [{ name: "bug", color: "d73a4a" }] },
      ["remove"],
      [],
    ],
    ["the plain list", [{ name: "bug", color: "d73a4a" }], ["remove"], []],
  ])(
    "%s resolves the undeclared label against the delete default",
    async (_form, declared, roles, notes) => {
      const api = new MockApi({ [LIST]: { data: liveLabels } });
      const result = await plan(api, declared);
      expect(result.ops.map((op): string => op.role)).toEqual(roles);
      expect(result.notes).toEqual(notes);
      expect(result.drift).toEqual([]);
    },
  );

  test("executing an update addresses the live name, url-encoded", async () => {
    const api = new MockApi({
      [LIST]: { data: [{ name: "autorelease: pending", color: "ededed", description: "x" }] },
    }).allowMutations("PATCH /repos/o/r/labels/*");
    const planned = await plan(api, [{ name: "autorelease: pending", color: "ffffff" }]);
    const execution = await executePlan(planned, labelsSection, api, REPO, {
      resolveSecret: () => {
        throw new Error("no secrets");
      },
    });
    expect(execution.status).toBe("applied");
    expect(api.mutations().map((m) => m.path)).toEqual([
      "/repos/o/r/labels/autorelease%3A%20pending",
    ]);
  });

  test("two entries resolving to the same label (via name or new_name) are rejected before any API call", async () => {
    const api = new MockApi({});
    await expect(
      plan(api, [
        { name: "bug", new_name: "triage" },
        { name: "enhancement", new_name: "Triage" },
      ]),
    ).rejects.toThrow(/name the same labels entry: "triage" and "Triage"/);
    expect(api.calls).toHaveLength(0);
  });

  test("a rename whose source and target both exist live cannot converge", async () => {
    const api = new MockApi({
      [LIST]: { data: [...liveLabels, { name: "defect", color: "000000", description: null }] },
    });
    await expect(plan(api, [{ name: "bug", new_name: "defect" }])).rejects.toThrow(
      /"defect" matches 2 separate live labels \("defect", "bug"\), so it cannot converge/,
    );
  });

  test("executing the plan against the derived mock converges: the re-plan is empty", async () => {
    const api = fragmentFake(labelsSection, labelsMockHandlers, {
      labels: [
        { name: "bug", color: "ff0000", description: "Something isn't working" },
        { name: "wontfix", color: "ffffff", description: "This will not be worked on" },
      ],
    });
    const { second, changes, notes } = await provePlanIdempotent(labelsSection, api, [
      { name: "Bug", new_name: "defect", color: "#D73A4A", description: "", tone: "warm" } as never,
      { name: "enhancement", color: "a2eeef", description: "New feature or request" },
    ]);
    expect(changes).toEqual([
      'updated label "defect"',
      'created label "enhancement"',
      'DELETED undeclared label "wontfix"',
    ]);
    expect(notes).toEqual([]);
    expect(api.writes).toEqual([
      "PATCH /repos/o/r/labels/bug",
      "POST /repos/o/r/labels",
      "DELETE /repos/o/r/labels/wontfix",
    ]);
    expect(second).toEqual({ ops: [], notes: [], drift: [] });
    expect(api.state.labels.map((label) => [label.name, label.color, label.description])).toEqual([
      ["defect", "d73a4a", ""],
      ["enhancement", "a2eeef", "New feature or request"],
    ]);
  });

  test("the read port exposes exactly the list role in its denied posture", () => {
    const ctx = planContext(labelsSection, new MockApi({}), REPO);
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
