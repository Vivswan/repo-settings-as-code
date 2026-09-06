import { describe, expect, test } from "bun:test";
import { silentIo } from "../../../test/io-fake.js";
import { MockApi } from "../../../test/mock-api.js";
import { fragmentFake } from "../../../test/sections/fragment-fake.js";
import { provePlanIdempotent } from "../../../test/sections/plan-idempotence.js";
import { REPO } from "../../../test/sections/section-run.js";
import { validateSettingsDoc } from "../../engine/orchestrate.js";
import { type PlainData, planContext, type SectionPlan } from "../contract/plan.js";
import { secretScanningPatternsSection } from "./index.js";
import { secretScanningCustomPatternsMockHandlers } from "./mock.js";
import type { SecretScanningPatternConfig } from "./schema.js";

/** The bare-array list body the mock serves for a live pattern set. */
function listRoute(patterns: Array<Record<string, unknown>>) {
  return {
    "GET /repos/o/r/secret-scanning/custom-patterns?per_page=100&page=1": { data: patterns },
  };
}

/** A complete live GET-shape pattern; overrides win. */
function livePattern(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 1,
    name: "internal-token",
    slug: "internal-token",
    pattern: "int_[a-z0-9]{8}",
    state: "published",
    push_protection_enabled: false,
    custom_pattern_version: "v1",
    ...overrides,
  };
}

const plan = (api: MockApi, desired: Parameters<typeof secretScanningPatternsSection.plan>[1]) =>
  secretScanningPatternsSection.plan(
    planContext(secretScanningPatternsSection, api, REPO),
    desired,
  );

/** A plan with every change thunk rendered; the section builds the lines at plan time. */
function rendered(result: SectionPlan) {
  return {
    ...result,
    ops: result.ops.map((op) => ({
      ...op,
      change: typeof op.change === "function" ? [op.change(null)].flat() : [op.change],
    })),
  };
}

const INTERNAL: SecretScanningPatternConfig = {
  name: "internal-token",
  pattern: "int_[a-z0-9]{8}",
};

describe("secret_scanning_custom_patterns", () => {
  test("plans one bulk create, one versioned PATCH of only the divergent fields, and keeps undeclared by default", async () => {
    // A fake that would accept any write: the plan must still issue none.
    const api = new MockApi(
      listRoute([
        livePattern({
          id: 5,
          name: "internal-token",
          pattern: "old_[0-9]{4}",
          end_delimiter: "\\z",
        }),
        livePattern({ id: 6, name: "unmanaged", custom_pattern_version: "v3" }),
      ]),
      { unroutedMutations: "succeed" },
    );
    const result = await plan(api, [
      { ...INTERNAL, end_delimiter: "\\b" },
      { name: "vendor-key", pattern: "key-[0-9]{6}", start_delimiter: "\\b" },
    ]);
    expect(rendered(result)).toEqual({
      ops: [
        {
          role: "create",
          payload: {
            patterns: [{ name: "vendor-key", pattern: "key-[0-9]{6}", start_delimiter: "\\b" }],
          },
          describe: 'creating secret scanning pattern(s) "vendor-key"',
          drift: [
            "secret_scanning_custom_patterns[vendor-key]: missing - declared in the settings file but not on the repo; apply will create it",
          ],
          change: ['created secret scanning custom pattern "vendor-key"'],
        },
        {
          role: "update",
          params: { pattern_id: "5" },
          payload: {
            custom_pattern_version: "v1",
            pattern: "int_[a-z0-9]{8}",
            end_delimiter: "\\b",
          },
          describe: 'updating secret scanning pattern "internal-token"',
          drift: [
            'secret_scanning_custom_patterns[internal-token].pattern: declared "int_[a-z0-9]{8}" != live "old_[0-9]{4}"; apply will set the declared value',
            'secret_scanning_custom_patterns[internal-token].end_delimiter: declared "\\\\b" != live "\\\\z"; apply will set the declared value',
          ],
          change: ['updated secret scanning custom pattern "internal-token"'],
        },
      ],
      notes: [
        'secret scanning custom pattern "unmanaged" exists on the repo but is not declared in ' +
          'the settings file; kept under "undeclared: keep" - add it to the settings file to ' +
          'manage it, or set "undeclared: delete" to have apply DELETE it (its alerts are then ' +
          "resolved, not deleted)",
      ],
      drift: [],
    });
    expect(api.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  test.each<[form: string, live: Record<string, unknown>, declared: SecretScanningPatternConfig]>([
    [
      "an undeclared optional is never compared: a live delimiter alone",
      { start_delimiter: "\\A|[^0-9A-Za-z]", must_match: ["^prefix"] },
      INTERNAL,
    ],
    [
      "the must_match list in the same order",
      { must_match: ["a", "b"] },
      { ...INTERNAL, must_match: ["a", "b"] },
    ],
    [
      "a declared empty list against a live null or absent list",
      { must_match: null, must_not_match: undefined },
      { ...INTERNAL, must_match: [], must_not_match: [] },
    ],
  ])("%s plans nothing", async (_form, live, declared) => {
    expect(await plan(new MockApi(listRoute([livePattern(live)])), [declared])).toEqual({
      ops: [],
      notes: [],
      drift: [],
    });
  });

  test.each<
    [
      form: string,
      live: Record<string, unknown>,
      declared: SecretScanningPatternConfig,
      payload: PlainData,
    ]
  >([
    [
      "the must_match list reordered (compared in order)",
      { must_match: ["a", "b"] },
      { ...INTERNAL, must_match: ["b", "a"] },
      { custom_pattern_version: "v1", must_match: ["b", "a"] },
    ],
    [
      "a declared empty list against a live non-empty one",
      { must_match: ["a"] },
      { ...INTERNAL, must_match: [] },
      { custom_pattern_version: "v1", must_match: [] },
    ],
    [
      "a version-less live pattern (custom_pattern_version: null skips the concurrency check)",
      { pattern: "old_[0-9]{4}", custom_pattern_version: undefined },
      INTERNAL,
      { custom_pattern_version: null, pattern: "int_[a-z0-9]{8}" },
    ],
  ])("%s plans one PATCH carrying %j", async (_form, live, declared, payload) => {
    const result = await plan(new MockApi(listRoute([livePattern(live)])), [declared]);
    expect(result.ops.map((op) => [op.role, op.params, op.payload])).toEqual([
      ["update", { pattern_id: "1" }, payload],
    ]);
  });

  test("a rename is create plus bulk delete under undeclared:delete, never a PATCH (no rename inference)", async () => {
    // The declared pattern carries the SAME fields as the live one, only the
    // name differs: the name is the identity.
    const api = new MockApi(
      listRoute([livePattern({ id: 9, name: "old-name", custom_pattern_version: "v7" })]),
    );
    const result = await plan(api, {
      undeclared: "delete",
      entries: [{ name: "new-name", pattern: "int_[a-z0-9]{8}" }],
    });
    expect(rendered(result).ops).toEqual([
      {
        role: "create",
        payload: { patterns: [{ name: "new-name", pattern: "int_[a-z0-9]{8}" }] },
        describe: 'creating secret scanning pattern(s) "new-name"',
        drift: [
          "secret_scanning_custom_patterns[new-name]: missing - declared in the settings file but not on the repo; apply will create it",
        ],
        change: ['created secret scanning custom pattern "new-name"'],
      },
      {
        role: "remove",
        payload: {
          patterns: [{ pattern_id: 9, custom_pattern_version: "v7" }],
          post_delete_action: "resolve_alerts",
        },
        describe: 'deleting undeclared secret scanning pattern(s) "old-name"',
        drift: [
          'secret_scanning_custom_patterns[old-name]: undeclared - not in the settings file and "undeclared: delete" is set, so apply will DELETE it and resolve its alerts; add it to the settings file to keep it',
        ],
        change: [
          'DELETED undeclared secret scanning custom pattern "old-name" (alerts resolved, not deleted)',
        ],
      },
    ]);
    // The default keep leaves the renamed-away pattern live, as a note.
    const kept = await plan(api, [{ name: "new-name", pattern: "int_[a-z0-9]{8}" }]);
    expect(kept.ops.map((op) => op.role)).toEqual(["create"]);
    expect(kept.notes).toHaveLength(1);
    expect(kept.notes[0]).toContain('"old-name"');
  });

  test("the bulk DELETE always sends resolve_alerts and each pattern's version, omitting a version-less one", async () => {
    // resolve_alerts is policy, not configuration: upstream's delete_alerts
    // default is never sent and no knob exists.
    const api = new MockApi(
      listRoute([
        livePattern({ id: 3, name: "stale-a", custom_pattern_version: "v3" }),
        livePattern({ id: 4, name: "stale-b", custom_pattern_version: "v9" }),
        livePattern({ id: 5, name: "stale-c", custom_pattern_version: undefined }),
      ]),
    );
    const result = await plan(api, { undeclared: "delete", entries: [] });
    expect(result.ops.map((op) => [op.role, op.payload])).toEqual([
      [
        "remove",
        {
          patterns: [
            { pattern_id: 3, custom_pattern_version: "v3" },
            { pattern_id: 4, custom_pattern_version: "v9" },
            { pattern_id: 5 },
          ],
          post_delete_action: "resolve_alerts",
        },
      ],
    ]);
    expect(result.ops[0]?.drift).toHaveLength(3);
  });

  test("two entries with the same name are rejected before any API call", async () => {
    const api = new MockApi({});
    await expect(
      plan(api, [
        { name: "dup", pattern: "a" },
        { name: "dup", pattern: "b" },
      ]),
    ).rejects.toThrow(/same secret_scanning_custom_patterns entry/);
    expect(api.calls).toHaveLength(0);
  });

  test.each<[form: string, live: Record<string, unknown>, at: RegExp]>([
    ["no id", { name: "no-id" }, /\[0\]\.id/],
    ["a non-string name", { id: 1, name: 5 }, /\[0\]\.name/],
    // string = concurrency token; null/absent = none offered; anything else
    // must not quietly disable the 412 protection.
    [
      "a numeric version",
      livePattern({ custom_pattern_version: 7 }),
      /\[0\]\.custom_pattern_version/,
    ],
  ])("a live entry with %s is a loud contract violation", async (_form, live, at) => {
    const rejection = plan(new MockApi(listRoute([live])), []).catch(
      (error: Error) => error.message,
    );
    await expect(rejection).resolves.toMatch(/returned a body outside the documented shape/);
    await expect(rejection).resolves.toMatch(at);
  });

  test("an empty delimiter is rejected at document validation (clearing is not expressible)", () => {
    // "" cannot mean "clear it": the PATCH updates provided fields only, so
    // the zod shape rejects the spelling before any repository is touched.
    for (const key of ["start_delimiter", "end_delimiter"] as const) {
      const doc = { secret_scanning_custom_patterns: [{ ...INTERNAL, [key]: "" }] };
      const invalid = validateSettingsDoc(doc, "test doc", new Set(), silentIo());
      expect("error" in invalid ? invalid.error : "").toContain(
        "cannot be cleared with an empty string",
      );
    }
  });

  test("executing the plan against the mock fragment converges: the re-plan is empty", async () => {
    const api = fragmentFake(
      secretScanningPatternsSection,
      secretScanningCustomPatternsMockHandlers,
      {
        secret_scanning_patterns: [
          livePattern({ id: 501, name: "internal-token", pattern: "int_[a-z0-9]{16}" }),
          livePattern({ id: 502, name: "retired", custom_pattern_version: "v2" }),
        ],
      },
    );
    const { second, changes, notes } = await provePlanIdempotent(
      secretScanningPatternsSection,
      api,
      {
        undeclared: "delete",
        entries: [
          { ...INTERNAL, start_delimiter: "\\b" },
          { name: "vendor-key", pattern: "key-[0-9]{6}", must_not_match: ["example"] },
        ],
      },
    );
    expect(changes).toEqual([
      'created secret scanning custom pattern "vendor-key"',
      'updated secret scanning custom pattern "internal-token"',
      'DELETED undeclared secret scanning custom pattern "retired" (alerts resolved, not deleted)',
    ]);
    expect(notes).toEqual([]);
    expect(api.writes).toEqual([
      "POST /repos/o/r/secret-scanning/custom-patterns",
      "PATCH /repos/o/r/secret-scanning/custom-patterns/501",
      "DELETE /repos/o/r/secret-scanning/custom-patterns",
    ]);
    expect(second).toEqual({ ops: [], notes: [], drift: [] });
    expect(
      api.state.secret_scanning_patterns.map((p) => [p.name, p.pattern, p.start_delimiter]),
    ).toEqual([
      ["internal-token", "int_[a-z0-9]{8}", "\\b"],
      ["vendor-key", "key-[0-9]{6}", undefined],
    ]);
  });

  test("the read port exposes exactly the list role in its denied posture", () => {
    const ctx = planContext(secretScanningPatternsSection, new MockApi({}), REPO);
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

describe("secret_scanning_custom_patterns closed surface", () => {
  test("rejects the read-only state and push_protection_enabled keys BY NAME, before any call", () => {
    // True by construction (closedSurface lists the six declared fields),
    // but no other test names the two read-only fields a user would most
    // plausibly try to declare.
    for (const key of ["state", "push_protection_enabled"]) {
      const error = validateSettingsDoc(
        { secret_scanning_custom_patterns: [{ ...INTERNAL, [key]: true }] },
        "settings.yml",
        new Set(),
        silentIo(),
      );
      expect("error" in error, `a declared "${key}" must be rejected`).toBe(true);
      const message = "error" in error ? error.error : "";
      expect(message).toContain(`"${key}"`);
      expect(message).toContain("read-only");
    }
  });
});
