import { describe, expect, test } from "bun:test";
import { planContext } from "../../../src/sections/contract/plan.js";
import { MockApi } from "../../../test/mock-api.js";
import { fragmentFake } from "../../../test/sections/fragment-fake.js";
import { provePlanIdempotent } from "../../../test/sections/plan-idempotence.js";
import { REPO } from "../../../test/sections/section-run.js";
import { deployKeysSection, normalizeKeyMaterial } from "./index.js";
import { deployKeysMockHandlers } from "./mock.js";

const LIST = "GET /repos/o/r/keys?per_page=100&page=1";

/** A live GET-shape key body; stored material carries no comment, like GitHub. */
function liveKey(id: number, title: string, key: string, read_only = false) {
  return { id, title, key, read_only, verified: true, created_at: "2026-01-01T00:00:00Z" };
}

const BOT_KEY = "ssh-ed25519 AAAAC3botblob";
const MIRROR_KEY = "ssh-ed25519 AAAAC3mirrorblob";
const STALE_KEY = "ssh-ed25519 AAAAC3staleblob";
const plan = (api: MockApi, desired: Parameters<typeof deployKeysSection.plan>[1]) =>
  deployKeysSection.plan(planContext(deployKeysSection, api, REPO), desired);

describe("normalizeKeyMaterial", () => {
  test("strips the trailing comment, keeping algorithm + blob", () => {
    expect(normalizeKeyMaterial("ssh-ed25519 AAAAC3blob deploy@host")).toBe(
      "ssh-ed25519 AAAAC3blob",
    );
    // A multi-word comment is stripped whole, and surrounding whitespace is
    // irrelevant to the compared material.
    expect(normalizeKeyMaterial("  ssh-rsa AAAAB3blob a b c  ")).toBe("ssh-rsa AAAAB3blob");
  });

  test("comment-free material normalizes to itself", () => {
    expect(normalizeKeyMaterial("ssh-ed25519 AAAAC3blob")).toBe("ssh-ed25519 AAAAC3blob");
  });

  test("sub-two-field material yields null, never a truncated compare", () => {
    expect(normalizeKeyMaterial("ssh-ed25519")).toBeNull();
    expect(normalizeKeyMaterial("")).toBeNull();
    expect(normalizeKeyMaterial("   ")).toBeNull();
  });
});

describe("deploy_keys validation before any read", () => {
  test.each<[label: string, declared: Parameters<typeof deployKeysSection.plan>[1], error: RegExp]>(
    [
      [
        "a malformed declared key",
        [{ title: "deploy-bot", key: "ssh-ed25519" }],
        /deploy_keys\[deploy-bot\]: the declared key must have at least two whitespace-separated fields/,
      ],
      [
        "duplicate declared titles",
        [
          { title: "deploy-bot", key: BOT_KEY },
          { title: "deploy-bot", key: MIRROR_KEY },
        ],
        /same deploy_keys entry/,
      ],
    ],
  )("%s is a settings-file error, before any API call", async (_label, declared, error) => {
    const api = new MockApi({});
    await expect(plan(api, declared)).rejects.toThrow(error);
    expect(api.calls).toHaveLength(0);
  });
});

describe("deploy_keys conflicts", () => {
  test("duplicate declared MATERIAL under different titles (comments ignored) is rejected before any request", async () => {
    const api = new MockApi({});
    await expect(
      plan(api, [
        { title: "deploy-bot", key: `${BOT_KEY} deploy@bot` },
        { title: "mirror-pull", key: `${BOT_KEY} mirror@other-comment` },
      ]),
    ).rejects.toThrow(
      /^deploy_keys: the settings file declares conflicting deploy keys: the entries "deploy-bot" and "mirror-pull" declare the same key material.*keep one entry per key\. Fix the settings file, then re-run$/s,
    );
    expect(api.calls).toHaveLength(0);
  });

  test("material a live key holds under ANOTHER title is named after the one read, before any write", async () => {
    const api = new MockApi({ [LIST]: { data: [liveKey(7, "old-name", MIRROR_KEY)] } });
    await expect(
      plan(api, [{ title: "new-name", key: `${MIRROR_KEY} deploy@renamed` }]),
    ).rejects.toThrow(
      /^deploy_keys: the settings file conflicts with the live deploy keys: the entry "new-name" declares key material that live key "old-name" \(id 7\) already holds.*declare the entry under its live title "old-name"\. Resolve each conflict on GitHub, then re-run$/s,
    );
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([LIST]);
  });

  test("the live holder conflict also fails under wrapped undeclared:delete: the create would run before the holder's delete", async () => {
    const api = new MockApi({ [LIST]: { data: [liveKey(7, "old-name", BOT_KEY)] } });
    await expect(
      plan(api, { undeclared: "delete", entries: [{ title: "new-name", key: BOT_KEY }] }),
    ).rejects.toThrow(/live key "old-name" \(id 7\) already holds/);
    expect(api.mutations()).toEqual([]);
  });

  test("a declared title matching SEVERAL live keys fails loudly naming their ids: GitHub does not enforce title uniqueness", async () => {
    const api = new MockApi({
      [LIST]: {
        data: [liveKey(11, "deploy-bot", BOT_KEY), liveKey(12, "deploy-bot", MIRROR_KEY)],
      },
    });
    await expect(plan(api, [{ title: "deploy-bot", key: BOT_KEY }])).rejects.toThrow(
      /the declared title "deploy-bot" matches 2 live deploy keys \(ids 11, 12\), and this section manages at most one key per title/,
    );
    expect(api.mutations()).toEqual([]);
  });
});

describe("deploy_keys loud live extraction", () => {
  test.each<[label: string, entry: Record<string, unknown>]>([
    ["a non-string title", { id: 1, title: 7, key: BOT_KEY }],
    ["a non-string key", { id: 1, title: "deploy-bot", key: null }],
    ["a non-numeric id", { id: "1", title: "deploy-bot", key: BOT_KEY }],
  ])("a live entry with %s is a contract violation naming the endpoint", async (_label, entry) => {
    const api = new MockApi({ [LIST]: { data: [entry] } });
    await expect(plan(api, [])).rejects.toThrow(
      /GET \/repos\/\{owner\}\/\{repo\}\/keys returned a body outside the documented shape/,
    );
  });

  test("a live key with sub-two-field material is a contract violation naming id and endpoint", async () => {
    const api = new MockApi({ [LIST]: { data: [liveKey(9, "stub", "ssh-ed25519")] } });
    await expect(plan(api, [])).rejects.toThrow(
      /GET \/repos\/\{owner\}\/\{repo\}\/keys returned key id 9 \("stub"\) whose material has fewer than two whitespace-separated fields/,
    );
  });
});

describe("deploy_keys reconcile", () => {
  test("a matching key (declared comment vs stored comment-free) plans nothing, reading only", async () => {
    const api = new MockApi({ [LIST]: { data: [liveKey(1, "deploy-bot", BOT_KEY, true)] } });
    const result = await plan(api, [
      { title: "deploy-bot", key: `${BOT_KEY} deploy@host`, read_only: true },
    ]);
    expect(result).toEqual({ ops: [], notes: [], drift: [] });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([LIST]);
  });

  test("a missing declared key is one create carrying the material as GitHub stores it (comment stripped)", async () => {
    const api = new MockApi({ [LIST]: { data: [] } });
    const result = await plan(api, [
      { title: "deploy-bot", key: `${BOT_KEY} deploy@host`, read_only: true },
    ]);
    expect(result).toEqual({
      ops: [
        {
          role: "create",
          payload: { title: "deploy-bot", key: BOT_KEY, read_only: true },
          describe: 'creating deploy key "deploy-bot"',
          drift: [
            "deploy_keys[deploy-bot]: missing - declared in the settings file but not on the repo; apply will create it",
          ],
          change: 'created deploy key "deploy-bot"',
        },
      ],
      notes: [],
      drift: [],
    });
  });

  test("a divergent key is DELETE then POST: the generic line on the delete, the differing fields on the recreate", async () => {
    const api = new MockApi({ [LIST]: { data: [liveKey(10, "mirror-pull", STALE_KEY, false)] } });
    const result = await plan(api, [
      { title: "mirror-pull", key: `${MIRROR_KEY} mirror@new`, read_only: true },
    ]);
    expect(result).toEqual({
      ops: [
        {
          role: "remove",
          params: { key_id: "10" },
          describe: 'deleting deploy key "mirror-pull" before recreating it',
          drift: [
            "deploy_keys[mirror-pull]: live settings differ from the settings file, and deploy keys cannot be edited; apply will delete and recreate it",
          ],
          change: 'deleted deploy key "mirror-pull" to recreate it with the declared settings',
        },
        {
          role: "create",
          payload: { title: "mirror-pull", key: MIRROR_KEY, read_only: true },
          describe: 'recreating deploy key "mirror-pull"',
          drift: [
            `deploy_keys[mirror-pull].key: declared "${MIRROR_KEY}" != live "${STALE_KEY}"`,
            "deploy_keys[mirror-pull].read_only: declared true != live false",
          ],
          change: 'recreated deploy key "mirror-pull"',
        },
      ],
      notes: [],
      drift: [],
    });
  });

  test.each<
    [
      label: string,
      declaredReadOnly: boolean | undefined,
      liveReadOnly: boolean,
      recreated: boolean,
    ]
  >([
    ["an omitted read_only keeps the live true (no privilege widening)", undefined, true, true],
    ["a declared false beats a live true", false, true, false],
    ["an omitted read_only keeps the live false", undefined, false, false],
  ])("on a rotated blob, %s", async (_label, declaredReadOnly, liveReadOnly, recreated) => {
    const api = new MockApi({
      [LIST]: { data: [liveKey(10, "mirror-pull", STALE_KEY, liveReadOnly)] },
    });
    const result = await plan(api, [
      {
        title: "mirror-pull",
        key: `${MIRROR_KEY} mirror@new`,
        ...(declaredReadOnly === undefined ? {} : { read_only: declaredReadOnly }),
      },
    ]);
    const create = result.ops.find((op) => op.role === "create");
    expect(create?.payload).toMatchObject({ read_only: recreated });
  });

  test("a divergent DECLARED read_only alone forces the replace; an undeclared one is never compared", async () => {
    const live = [liveKey(10, "deploy-bot", BOT_KEY, true)];
    const forced = await plan(new MockApi({ [LIST]: { data: live } }), [
      { title: "deploy-bot", key: BOT_KEY, read_only: false },
    ]);
    expect(forced.ops.map((op) => op.role)).toEqual(["remove", "create"]);
    // The control: the same live toggle, undeclared, is not drift.
    const ignored = await plan(new MockApi({ [LIST]: { data: live } }), [
      { title: "deploy-bot", key: BOT_KEY },
    ]);
    expect(ignored).toEqual({ ops: [], notes: [], drift: [] });
  });

  test('a declared passthrough field named "material" earns the phantom-key note, diffed against the RAW api body', async () => {
    // The normalized material replaces the live `key` in place and never
    // lands under another name, so a user field called "material" reads as
    // absent live (phantom), not as a synthetic field it would match.
    const api = new MockApi({ [LIST]: { data: [liveKey(10, "deploy-bot", BOT_KEY)] } });
    const result = await plan(api, [
      { title: "deploy-bot", key: BOT_KEY, material: "whatever" } as never,
    ]);
    expect(result.ops.map((op) => [op.role, op.drift])).toEqual([
      [
        "remove",
        [
          "deploy_keys[deploy-bot]: live settings differ from the settings file, and deploy keys cannot be edited; apply will delete and recreate it",
        ],
      ],
      [
        "create",
        [
          'deploy_keys[deploy-bot].material: declared "whatever" but the API response has no such field (new or write-only field?)',
        ],
      ],
    ]);
    expect(result.notes).toEqual([
      'deploy_keys[deploy-bot]: declared key(s) "material" do not exist on the live deploy key, so if GitHub ignores them this delete-and-recreate will repeat on every apply without converging. Fix the key name, or remove it from the settings file',
    ]);
  });
});

describe("deploy_keys undeclared policy", () => {
  const liveKeys = [liveKey(1, "deploy-bot", BOT_KEY), liveKey(2, "retired-service", MIRROR_KEY)];
  const KEEP_NOTE =
    'deploy key "retired-service" exists on the repo but is not declared in the settings file; kept under "undeclared: keep" - add it to the settings file to manage it, or set "undeclared: delete" to have apply DELETE it';

  test.each<
    [
      form: string,
      declared: Parameters<typeof deployKeysSection.plan>[1],
      ops: Awaited<ReturnType<typeof plan>>["ops"],
      notes: string[],
    ]
  >([
    [
      "wrapped undeclared:delete",
      { undeclared: "delete", entries: [{ title: "deploy-bot", key: BOT_KEY }] },
      [
        {
          role: "remove",
          params: { key_id: "2" },
          describe: 'deleting undeclared deploy key "retired-service"',
          drift: [
            'deploy_keys[retired-service]: undeclared - not in the settings file and "undeclared: delete" is set, so apply will DELETE it; add it to the settings file to keep it',
          ],
          change: 'DELETED undeclared deploy key "retired-service"',
        },
      ],
      [],
    ],
    [
      "the wrapper without a policy",
      { entries: [{ title: "deploy-bot", key: BOT_KEY }] },
      [],
      [KEEP_NOTE],
    ],
    ["the plain list", [{ title: "deploy-bot", key: BOT_KEY }], [], [KEEP_NOTE]],
  ])(
    "%s resolves the undeclared key against the keep default",
    async (_form, declared, ops, notes) => {
      const api = new MockApi({ [LIST]: { data: liveKeys } });
      expect(await plan(api, declared)).toEqual({ ops, notes, drift: [] });
    },
  );
});

describe("deploy_keys convergence", () => {
  test("executing the plan against the derived mock converges: create, DELETE-then-POST replace, undeclared delete, and an empty re-plan", async () => {
    const api = fragmentFake(deployKeysSection, deployKeysMockHandlers, {
      deploy_keys: [
        liveKey(10, "mirror-pull", STALE_KEY, false),
        liveKey(20, "retired-service", "ssh-rsa AAAAB3retiredblob", true),
      ],
    });
    const { second, changes, notes } = await provePlanIdempotent(deployKeysSection, api, {
      undeclared: "delete",
      entries: [
        { title: "deploy-bot", key: `${BOT_KEY} deploy@bot`, read_only: true },
        { title: "mirror-pull", key: `${MIRROR_KEY} mirror@new` },
      ],
    });
    expect(changes).toEqual([
      'created deploy key "deploy-bot"',
      'deleted deploy key "mirror-pull" to recreate it with the declared settings',
      'recreated deploy key "mirror-pull"',
      'DELETED undeclared deploy key "retired-service"',
    ]);
    expect(notes).toEqual([]);
    expect(api.writes).toEqual([
      "POST /repos/o/r/keys",
      "DELETE /repos/o/r/keys/10",
      "POST /repos/o/r/keys",
      "DELETE /repos/o/r/keys/20",
    ]);
    expect(second).toEqual({ ops: [], notes: [], drift: [] });
    // The mock stores comment-free material the way GitHub does; the rotated
    // key kept its live read_only through the recreate.
    expect(api.state.deploy_keys.map((k) => [k.title, k.key, k.read_only])).toEqual([
      ["deploy-bot", BOT_KEY, true],
      ["mirror-pull", MIRROR_KEY, false],
    ]);
  });

  test("the derived mock holds MATERIAL unique like GitHub: a repeated title is accepted, a repeated blob is 422", async () => {
    const api = fragmentFake(deployKeysSection, deployKeysMockHandlers, {
      deploy_keys: [liveKey(1, "deploy-bot", BOT_KEY)],
    });
    const post = async (body: Record<string, unknown>) => {
      const result = await api.tryRequest("POST", "/repos/o/r/keys", body);
      return "error" in result ? result.error.status : 201;
    };
    expect(await post({ title: "deploy-bot", key: MIRROR_KEY })).toBe(201);
    expect(await post({ title: "other-title", key: `${BOT_KEY} some@comment` })).toBe(422);
    expect(api.state.deploy_keys.map((k) => k.title)).toEqual(["deploy-bot", "deploy-bot"]);
  });

  test("the read port exposes exactly the list role in its denied posture", () => {
    const ctx = planContext(deployKeysSection, new MockApi({}), REPO);
    expect(Object.keys(ctx.read)).toEqual(["list"]);
    // @ts-expect-error a write role is not a read: the port has no `create`
    ctx.read.create;
    // @ts-expect-error nor a `remove`
    ctx.read.remove;
    // @ts-expect-error a "denied" primary read offers no 404-tolerant helper
    ctx.read.list.probeAbsent;
  });
});
