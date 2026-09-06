import { describe, expect, test } from "bun:test";
import type { GithubClient } from "../../../src/github/api.js";
import { planContext, type SectionPlan } from "../../../src/sections/contract/plan.js";
import { MockApi } from "../../../test/mock-api.js";
import { fragmentFake } from "../../../test/sections/fragment-fake.js";
import { provePlanIdempotent } from "../../../test/sections/plan-idempotence.js";
import { REPO } from "../../../test/sections/section-run.js";
import { customPropertiesSection, normalizeValue } from "./index.js";
import { customPropertiesMockHandlers } from "./mock.js";

/** Routes for an org-owned repo with the given live property values. */
function orgRoutes(values: Array<{ property_name: string; value: unknown }>) {
  return {
    "GET /orgs/o": { data: { login: "o" } },
    "GET /repos/o/r/properties/values": { data: values },
  };
}

const plan = (api: MockApi, desired: Parameters<typeof customPropertiesSection.plan>[1]) =>
  customPropertiesSection.plan(planContext(customPropertiesSection, api, REPO), desired);

/** The lines an op's change renders; the section builds them at plan time, so no response is needed. */
function changeLines(op: SectionPlan["ops"][number]): readonly string[] {
  return typeof op.change === "function" ? [op.change(null)].flat() : [op.change];
}

/**
 * The derived fake refuses the org probe: the dispatcher resolves GET /orgs/{org} to teams, the
 * first section declaring it. The probe only reads the seeded org, so it is answered here.
 */
function orgFake(values: Array<{ property_name: string; value: unknown }>) {
  const fake = fragmentFake(customPropertiesSection, customPropertiesMockHandlers, {
    custom_property_values: values,
  });
  const api: GithubClient = {
    ...fake,
    tryRequest: (method, path, payload) =>
      path === "/orgs/o"
        ? Promise.resolve({ data: fake.state.org })
        : fake.tryRequest(method, path, payload),
  };
  return { api, fake };
}

const live = [
  { property_name: "pilot", value: "false" },
  { property_name: "compliance", value: ["soc2"] },
  { property_name: "tier", value: "gold" },
];

describe("custom_properties", () => {
  test.each<
    [declared: Parameters<typeof normalizeValue>[0], wire: ReturnType<typeof normalizeValue>]
  >([
    [true, "true"],
    [false, "false"],
    [7, "7"],
    ["platform", "platform"],
    [
      ["soc2", "hipaa"],
      ["soc2", "hipaa"],
    ],
    [null, null],
  ])("normalizeValue(%j) is %j, GitHub's stored form", (declared, wire) => {
    expect(normalizeValue(declared)).toEqual(wire);
  });

  test("a personal account plans nothing but the note, with zero property calls", async () => {
    // The unrouted GET /orgs/o answers 404, the personal-account signal.
    const api = new MockApi({});
    const result = await plan(api, [{ property_name: "team", value: "platform" }]);
    expect(result).toEqual({
      ops: [],
      notes: [
        'custom_properties: owner "o" is a personal account, and custom properties require an organization-owned repository; section skipped - remove the custom_properties section from the settings file to silence this note',
      ],
      drift: [],
    });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /orgs/o"]);
  });

  test("plans ONE bulk PATCH folding set, change, unset, and undeclared unset, reading only", async () => {
    // A fake that would accept any write: the plan must still issue none.
    const api = new MockApi(orgRoutes(live), { unroutedMutations: "succeed" });
    const result = await plan(api, {
      undeclared: "delete",
      entries: [
        { property_name: "team", value: "platform" },
        { property_name: "pilot", value: true },
        { property_name: "compliance", value: null },
      ],
    });
    expect(result.notes).toEqual([]);
    expect(result.drift).toEqual([]);
    expect(result.ops.map((op) => ({ ...op, change: changeLines(op) }))).toEqual([
      {
        role: "update",
        payload: {
          properties: [
            { property_name: "team", value: "platform" },
            { property_name: "pilot", value: "true" },
            { property_name: "compliance", value: null },
            { property_name: "tier", value: null },
          ],
        },
        describe: "updating custom property values",
        drift: [
          'custom_properties[team]: declared "platform" != live unset; apply will set the declared value',
          'custom_properties[pilot]: declared "true" != live "false"; apply will set the declared value',
          'custom_properties[compliance]: declared null but the live value is ["soc2"]; apply will unset it (reverting to the org default, if any)',
          'custom_properties[tier]: undeclared - not in the settings file and "undeclared: delete" is set, so apply will unset it (reverting to the org default, if any); add it to the settings file to keep it',
        ],
        change: [
          'set custom property "team" to "platform"',
          'set custom property "pilot" to "true"',
          'unset custom property "compliance"',
          'unset undeclared custom property "tier"',
        ],
      },
    ]);
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /orgs/o",
      "GET /repos/o/r/properties/values",
    ]);
  });

  test("under the keep default an undeclared live value is a note, beside the declared drift", async () => {
    const result = await plan(new MockApi(orgRoutes(live)), [
      { property_name: "compliance", value: ["soc2", "hipaa"] },
    ]);
    expect(result.ops.map((op) => op.drift)).toEqual([
      [
        'custom_properties[compliance]: declared ["soc2","hipaa"] != live ["soc2"]; apply will set the declared value',
      ],
    ]);
    // "pilot" is live, declared nowhere, and kept; "compliance" is managed.
    expect(result.notes).toEqual([
      'custom property "pilot" is set on the repo but not declared in the settings file; kept under "undeclared: keep" - add it to the settings file to manage it, or set "undeclared: delete" to have apply UNSET it',
      'custom property "tier" is set on the repo but not declared in the settings file; kept under "undeclared: keep" - add it to the settings file to manage it, or set "undeclared: delete" to have apply UNSET it',
    ]);
  });

  test.each<[form: string, liveValues: typeof live, declared: Parameters<typeof plan>[1]]>([
    [
      "every declared value matches, null against an absent live entry included",
      live,
      [
        { property_name: "pilot", value: false },
        { property_name: "compliance", value: ["soc2"] },
        { property_name: "tier", value: "gold" },
        { property_name: "team", value: null },
      ],
    ],
    [
      "a multi_select list reordered",
      [{ property_name: "compliance", value: ["soc2", "hipaa"] }],
      [{ property_name: "compliance", value: ["hipaa", "soc2"] }],
    ],
    [
      "a live-side duplicate element GitHub would collapse",
      [{ property_name: "compliance", value: ["soc2", "soc2"] }],
      [{ property_name: "compliance", value: ["soc2"] }],
    ],
  ])("%s plans nothing", async (_form, liveValues, declared) => {
    expect(await plan(new MockApi(orgRoutes(liveValues)), declared)).toEqual({
      ops: [],
      notes: [],
      drift: [],
    });
  });

  test.each<[form: string, declared: Parameters<typeof plan>[1], error: RegExp]>([
    [
      "a multi_select listing one option twice",
      [{ property_name: "compliance", value: ["soc2", "hipaa", "soc2"] }],
      /"compliance" entry lists the value "soc2" more than once/,
    ],
    [
      "the same, in the wrapped form",
      { undeclared: "delete", entries: [{ property_name: "compliance", value: ["soc2", "soc2"] }] },
      /"compliance" entry lists the value "soc2" more than once/,
    ],
    [
      "an empty list",
      [{ property_name: "compliance", value: [] }],
      /"compliance" entry declares an empty list; declare value: null/,
    ],
    [
      "two entries naming one property",
      [
        { property_name: "team", value: "a" },
        { property_name: "team", value: "b" },
      ],
      /same custom_properties entry/,
    ],
  ])("%s is rejected before any API call", async (_form, declared, error) => {
    const api = new MockApi({});
    await expect(plan(api, declared)).rejects.toThrow(error);
    expect(api.calls).toHaveLength(0);
  });

  test("a live entry without a string property_name fails loudly as a contract violation", async () => {
    const api = new MockApi(orgRoutes([{ value: "x" } as never]));
    await expect(plan(api, [{ property_name: "team", value: "x" }])).rejects.toThrow(
      /returned a body outside the documented shape - \[0\]\.property_name/,
    );
  });

  test("executing the plan against the mock fragment converges: the re-plan is empty", async () => {
    const { api, fake } = orgFake(live);
    const { second, changes, notes } = await provePlanIdempotent(customPropertiesSection, api, {
      undeclared: "delete",
      entries: [
        { property_name: "team", value: "platform" },
        { property_name: "pilot", value: true },
        { property_name: "compliance", value: null },
      ],
    });
    expect(changes).toEqual([
      'set custom property "team" to "platform"',
      'set custom property "pilot" to "true"',
      'unset custom property "compliance"',
      'unset undeclared custom property "tier"',
    ]);
    expect(notes).toEqual([]);
    expect(fake.writes).toEqual(["PATCH /repos/o/r/properties/values"]);
    expect(second).toEqual({ ops: [], notes: [], drift: [] });
    expect(fake.state.custom_property_values).toEqual([
      { property_name: "pilot", value: "true" },
      { property_name: "team", value: "platform" },
    ]);
  });

  test("the read port exposes the org probe in its absent posture and the values GET, never the PATCH", () => {
    const ctx = planContext(customPropertiesSection, new MockApi({}), REPO);
    expect(Object.keys(ctx.read)).toEqual(["org", "list"]);
    // @ts-expect-error a write role is not a read: the port has no `update`
    ctx.read.update;
    // @ts-expect-error an "absent" primary read offers no throwing helper
    ctx.read.org.call;
  });
});
