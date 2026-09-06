import { describe, expect, test } from "bun:test";
import { validateSectionShapes } from "../../../src/engine/validate.js";
import { MockApi } from "../../../test/mock-api.js";
import { fragmentFake } from "../../../test/sections/fragment-fake.js";
import { provePlanIdempotent } from "../../../test/sections/plan-idempotence.js";
import { REPO } from "../../../test/sections/section-run.js";
import {
  driftOf,
  type ExecTools,
  planCheckNotes,
  planContext,
  planDrift,
  type SectionPlan,
} from "../contract/plan.js";
import { webhooksSection } from "./index.js";
import { webhooksMockHandlers } from "./mock.js";
import type { WebhookConfig } from "./schema.js";

/** The verdict's error prose, or null when the document validated. */
function shapeError(doc: Record<string, unknown>, sourceLabel: string): string | null {
  const verdict = validateSectionShapes(doc, sourceLabel);
  return "error" in verdict ? verdict.error : null;
}

const LIST = "GET /repos/o/r/hooks?per_page=100&page=1";

/** A live hook body as the mock list returns it (GET shape, secret echoed). */
function liveHook(
  id: number,
  url: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    name: "web",
    active: true,
    events: ["push"],
    config: { url, content_type: "json" },
    ...overrides,
  };
}

/** Execution tools serving fixed plaintexts; any other reference is a bug. */
function tools(resolved: Record<string, string> = {}): ExecTools {
  return {
    resolveSecret: (reference) => {
      const plaintext = resolved[reference];
      if (plaintext === undefined) {
        throw new Error(`test resolver has no value for ${reference}`);
      }
      return plaintext;
    },
  };
}

const plan = (api: MockApi, desired: Parameters<typeof webhooksSection.plan>[1]) =>
  webhooksSection.plan(planContext(webhooksSection, api, REPO), desired);

/** The requests a plan would issue: role, path params, and the payload sealed with `resolved`. */
async function requests(result: SectionPlan, resolved: Record<string, string> = {}) {
  const exec = tools(resolved);
  return Promise.all(
    result.ops.map(async (op) => [
      op.role,
      op.params,
      typeof op.payload === "function" ? await op.payload(exec) : op.payload,
    ]),
  );
}

const SECRET_NOTE =
  'webhooks["https://x.test/h"].config.secret: GitHub never reveals a webhook secret (reads echo "********"), so the declared value cannot be verified; apply re-sends it on every run so rotations propagate';

describe("webhooks shape", () => {
  test("an entry-level secret is rejected, pointing at config.secret", () => {
    // The misplacement would otherwise pass the loose shape, ship the raw
    // reference text verbatim, and create a silently unauthenticated hook.
    const result = webhooksSection.shape.safeParse([
      { config: { url: "https://t.test/h" }, secret: "$HOOK_SECRET" },
    ]);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("config.secret");
  });

  test.each<[form: string, doc: Record<string, unknown>, error: string | null]>([
    [
      "a name other than 'web'",
      { webhooks: [{ name: "email", config: { url: "https://x.test/h" } }] },
      "webhooks[0].name",
    ],
    ["name 'web'", { webhooks: [{ name: "web", config: { url: "https://x.test/h" } }] }, null],
    [
      "an omitted name in the wrapped form",
      { webhooks: { undeclared: "delete", entries: [{ config: { url: "https://x.test/h" } }] } },
      null,
    ],
    ["a missing config", { webhooks: [{ events: ["push"] }] }, "webhooks[0].config"],
  ])("%s validates as %j", (_form, doc, error) => {
    const verdict = shapeError(doc, "settings.yml");
    if (error === null) {
      expect(verdict).toBeNull();
    } else {
      expect(verdict).toContain(error);
    }
  });
});

describe("webhooks secretValues", () => {
  test("extracts every declared config.secret, in both knob forms", () => {
    expect(
      webhooksSection.secretValues?.([
        { config: { url: "https://a.test", secret: "$A" } },
        { config: { url: "https://b.test" } },
      ]),
    ).toEqual([{ label: 'the webhook "https://a.test" config.secret', value: "$A" }]);
    expect(
      webhooksSection.secretValues?.({
        undeclared: "keep",
        entries: [{ config: { url: "https://a.test", secret: "$B" } }],
      }),
    ).toEqual([{ label: 'the webhook "https://a.test" config.secret', value: "$B" }]);
  });

  test("malformed containers return [] and leave the error to validation", () => {
    // The extractor can face any merged value, so a malformed declaration
    // must not throw here - validation is where the user gets the message.
    for (const malformed of [null, "hooks", 42, { undeclared: "keep" }, [null, "x"]]) {
      // The double cast feeds the extractor a PRE-VALIDATION value on purpose.
      expect(webhooksSection.secretValues?.(malformed as unknown as WebhookConfig[])).toEqual([]);
    }
  });
});

describe("webhooks plan", () => {
  test("a missing hook plans a create whose POST seals the resolved secret; its drift is the missing line plus the cannot-verify facet", async () => {
    // A fake that would accept any write: the plan must still issue none.
    const api = new MockApi({ [LIST]: { data: [] } }, { unroutedMutations: "succeed" });
    const result = await plan(api, [
      {
        config: { url: "https://x.test/h", content_type: "json", secret: "$HOOK" },
        events: ["push"],
        active: true,
      },
    ]);
    expect(result.ops.map((op) => [op.role, op.drift, op.describe, op.change])).toEqual([
      [
        "create",
        {
          unverifiable: SECRET_NOTE,
          lines: [
            'webhooks["https://x.test/h"]: missing - declared in the settings file but not on the repo; apply will create it',
          ],
        },
        'creating webhook "https://x.test/h"',
        'created webhook "https://x.test/h"',
      ],
    ]);
    expect(await requests(result, { $HOOK: "plain-secret" })).toEqual([
      [
        "create",
        undefined,
        {
          name: "web",
          config: { url: "https://x.test/h", content_type: "json", secret: "plain-secret" },
          events: ["push"],
          active: true,
        },
      ],
    ]);
    expect(planDrift(result)).toEqual([
      'webhooks["https://x.test/h"]: missing - declared in the settings file but not on the repo; apply will create it',
    ]);
    expect(planCheckNotes(result)).toEqual([SECRET_NOTE]);
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([LIST]);
  });

  test("a declared secret plans the config PATCH with EMPTY drift under the facet, even with zero config drift", async () => {
    const api = new MockApi({
      [LIST]: {
        data: [
          liveHook(7, "https://x.test/h", {
            config: { url: "https://x.test/h", secret: "********" },
          }),
        ],
      },
    });
    const result = await plan(api, [{ config: { url: "https://x.test/h", secret: "$HOOK" } }]);
    expect(result.ops.map((op) => [op.role, op.params, op.drift, op.change])).toEqual([
      [
        "updateConfig",
        { hook_id: "7" },
        { unverifiable: SECRET_NOTE, lines: [] },
        'updated webhook "https://x.test/h" config (the declared secret is re-sent every run)',
      ],
    ]);
    // "$HOOK" vs "********" would be drift if the secret were compared.
    expect(planDrift(result)).toEqual([]);
    expect(planCheckNotes(result)).toEqual([SECRET_NOTE]);
    expect(await requests(result, { $HOOK: "rotated" })).toEqual([
      ["updateConfig", { hook_id: "7" }, { url: "https://x.test/h", secret: "rotated" }],
    ]);
  });

  test("config drift without a secret is the config sub-endpoint alone; events/active drift the general PATCH with NO config key", async () => {
    const api = new MockApi({
      [LIST]: {
        data: [
          liveHook(3, "https://x.test/h"),
          liveHook(4, "https://y.test/h", { config: { url: "https://y.test/h" } }),
        ],
      },
    });
    const result = await plan(api, [
      { config: { url: "https://x.test/h", content_type: "form" } },
      { config: { url: "https://y.test/h" }, events: ["push", "release"], active: false },
    ]);
    expect(result.ops.map((op) => [op.role, op.params, driftOf(op), op.change])).toEqual([
      [
        "updateConfig",
        { hook_id: "3" },
        ['webhooks["https://x.test/h"].config.content_type: "form" != "json"'],
        'updated webhook "https://x.test/h" config',
      ],
      [
        "update",
        { hook_id: "4" },
        [
          'webhooks["https://y.test/h"].events: declared ["push","release"] != live ["push"] (compared order-insensitively); apply will set the declared events',
          'webhooks["https://y.test/h"].active: declared false != live true; apply will set the declared value',
        ],
        'updated webhook "https://y.test/h"',
      ],
    ]);
    expect(await requests(result)).toEqual([
      ["updateConfig", { hook_id: "3" }, { url: "https://x.test/h", content_type: "form" }],
      ["update", { hook_id: "4" }, { events: ["push", "release"], active: false }],
    ]);
    expect(planCheckNotes(result)).toEqual([]);
  });

  test.each<[form: string, live: Record<string, unknown>, declared: WebhookConfig]>([
    [
      "insecure_ssl as a number against GitHub's stored string",
      liveHook(6, "https://x.test/h", {
        config: { url: "https://x.test/h", content_type: "json", insecure_ssl: "0" },
      }),
      { config: { url: "https://x.test/h", content_type: "json", insecure_ssl: 0 } },
    ],
    [
      "events in another order",
      liveHook(21, "https://x.test/h", { events: ["release", "push"] }),
      { config: { url: "https://x.test/h", content_type: "json" }, events: ["push", "release"] },
    ],
  ])("%s plans nothing", async (_form, live, declared) => {
    expect(await plan(new MockApi({ [LIST]: { data: [live] } }), [declared])).toEqual({
      ops: [],
      notes: [],
      drift: [],
    });
  });

  test("a changed config.url is a new identity: a create plus a kept undeclared note, or a delete under undeclared:delete", async () => {
    const api = new MockApi({ [LIST]: { data: [liveHook(8, "https://old.test/h")] } });
    const kept = await plan(api, [{ config: { url: "https://new.test/h" } }]);
    expect(kept.ops.map((op) => [op.role, op.params])).toEqual([["create", undefined]]);
    expect(kept.notes).toEqual([
      'webhook "https://old.test/h" exists on the repo but is not declared in the settings file; kept under "undeclared: keep" - add it to the settings file to manage it, or set "undeclared: delete" to have apply DELETE it',
    ]);
    const deleted = await plan(api, {
      undeclared: "delete",
      entries: [{ config: { url: "https://new.test/h" } }],
    });
    expect(deleted.notes).toEqual([]);
    expect(deleted.ops.map((op) => [op.role, op.params, driftOf(op), op.change])).toEqual([
      [
        "create",
        undefined,
        [
          'webhooks["https://new.test/h"]: missing - declared in the settings file but not on the repo; apply will create it',
        ],
        'created webhook "https://new.test/h"',
      ],
      [
        "remove",
        { hook_id: "8" },
        [
          'webhooks["https://old.test/h"]: undeclared - not in the settings file and "undeclared: delete" is set, so apply will DELETE it; add it to the settings file to keep it',
        ],
        'DELETED undeclared webhook "https://old.test/h"',
      ],
    ]);
  });

  test("a declared url matching several live hooks fails BEFORE any operation is planned, naming their ids", async () => {
    // A missing url declared BEFORE the ambiguous one must not become a
    // create; the scan runs over the whole declaration first.
    const api = new MockApi({
      [LIST]: { data: [liveHook(11, "https://dup.test/h"), liveHook(12, "https://dup.test/h")] },
    });
    await expect(
      plan(api, [
        { config: { url: "https://new.test/h" } },
        { config: { url: "https://dup.test/h" } },
      ]),
    ).rejects.toThrow(
      /webhooks: 1 declared url\(s\) each match more than one live hook.*"https:\/\/dup.test\/h" matches 2 live hooks \(ids 11, 12\)/,
    );
  });

  test("two declared entries with the same url are rejected before any call", async () => {
    const api = new MockApi({});
    await expect(
      plan(api, [{ config: { url: "https://x.test/h" } }, { config: { url: "https://x.test/h" } }]),
    ).rejects.toThrow(/Keep exactly one entry per resource/);
    expect(api.calls).toEqual([]);
  });

  test("executing the plan against the mock fragment converges: the re-plan carries only the secret-bearing config PATCHes", async () => {
    const api = fragmentFake(webhooksSection, webhooksMockHandlers, {
      hooks: [
        {
          id: 601,
          events: ["push"],
          config: { url: "https://ci.test/hook", content_type: "form" },
        },
        { id: 602, config: { url: "https://stray.test/hook", content_type: "json" } },
      ],
    });
    const { first, second, changes, notes } = await provePlanIdempotent(
      webhooksSection,
      api,
      {
        undeclared: "delete",
        entries: [
          {
            config: {
              url: "https://ci.test/hook",
              content_type: "json",
              secret: "$WEBHOOK_SECRET",
            },
            events: ["push", "pull_request"],
            active: true,
          },
          {
            config: {
              url: "https://deploy.test/hook",
              content_type: "json",
              secret: "$WEBHOOK_SECRET",
            },
          },
        ],
      },
      tools({ $WEBHOOK_SECRET: "hook-secret-1" }),
    );
    expect(changes).toEqual([
      'updated webhook "https://ci.test/hook" config (the declared secret is re-sent every run)',
      'updated webhook "https://ci.test/hook"',
      'created webhook "https://deploy.test/hook"',
      'DELETED undeclared webhook "https://stray.test/hook"',
    ]);
    expect(notes).toEqual([]);
    // The proof also executes the converged second plan, so the two
    // secret-bearing config PATCHes land once more and nothing else does.
    expect(api.writes).toEqual([
      "PATCH /repos/o/r/hooks/601/config",
      "PATCH /repos/o/r/hooks/601",
      "POST /repos/o/r/hooks",
      "DELETE /repos/o/r/hooks/602",
      "PATCH /repos/o/r/hooks/601/config",
      expect.stringMatching(/^PATCH \/repos\/o\/r\/hooks\/\d+\/config$/),
    ]);
    // The created hook now exists, so its secret recurs as a config PATCH: the
    // facet with no lines, which check mode reads as clean plus the note.
    expect(first.ops.map((op) => op.role)).toEqual(["updateConfig", "update", "create", "remove"]);
    expect(second.ops.map((op) => [op.role, op.params, op.drift])).toEqual([
      [
        "updateConfig",
        { hook_id: "601" },
        { unverifiable: expect.stringContaining('webhooks["https://ci.test/hook"]'), lines: [] },
      ],
      [
        "updateConfig",
        { hook_id: expect.any(String) },
        {
          unverifiable: expect.stringContaining('webhooks["https://deploy.test/hook"]'),
          lines: [],
        },
      ],
    ]);
    expect(planDrift(second)).toEqual([]);
    expect(api.state.hooks.map((hook) => [hook.config, hook.events, hook.active])).toEqual([
      [
        { url: "https://ci.test/hook", content_type: "json", secret: "hook-secret-1" },
        ["push", "pull_request"],
        true,
      ],
      [
        { url: "https://deploy.test/hook", content_type: "json", secret: "hook-secret-1" },
        ["push"],
        true,
      ],
    ]);
  });

  test("the read port exposes exactly the list role in its denied posture", () => {
    const ctx = planContext(webhooksSection, new MockApi({}), REPO);
    expect(Object.keys(ctx.read)).toEqual(["list"]);
    // @ts-expect-error a write role is not a read: the port has no `create`
    ctx.read.create;
    // @ts-expect-error nor an `updateConfig`
    ctx.read.updateConfig;
    // @ts-expect-error a "denied" primary read offers no 404-tolerant helper
    ctx.read.list.probeAbsent;
  });
});
