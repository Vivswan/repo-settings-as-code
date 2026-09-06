import { describe, expect, test } from "bun:test";
import { planContext } from "../../../src/sections/contract/plan.js";
import { MockApi } from "../../../test/mock-api.js";
import { fragmentFake } from "../../../test/sections/fragment-fake.js";
import { provePlanIdempotent } from "../../../test/sections/plan-idempotence.js";
import { REPO } from "../../../test/sections/section-run.js";
import { autolinksSection } from "./index.js";
import { autolinksMockHandlers } from "./mock.js";

/** The list is unpaginated: one bare GET, no page params. */
const LIST = "GET /repos/o/r/autolinks";
const liveAutolinks = [
  { id: 1, key_prefix: "JIRA-", url_template: "https://x.test/<num>", is_alphanumeric: true },
  { id: 2, key_prefix: "OLD-", url_template: "https://y.test/<num>", is_alphanumeric: true },
];
const KEEP_NOTE =
  'autolink "OLD-" exists on the repo but is not declared in the settings file; kept under "undeclared: keep" - add it to the settings file to manage it, or set "undeclared: delete" to have apply DELETE it';
const plan = (api: MockApi, desired: Parameters<typeof autolinksSection.plan>[1]) =>
  autolinksSection.plan(planContext(autolinksSection, api, REPO), desired);

describe("autolinks", () => {
  test("plans a delete-and-recreate for a changed autolink, a create for a missing one, and a delete for the undeclared one, reading once", async () => {
    const api = new MockApi({ [LIST]: { data: liveAutolinks } });
    const result = await plan(api, [
      { key_prefix: "JIRA-", url_template: "https://z.test/<num>", is_alphanumeric: true },
      { key_prefix: "NEW-", url_template: "https://n.test/<num>" },
    ]);
    expect(result).toEqual({
      ops: [
        {
          role: "remove",
          params: { autolink_id: "1" },
          describe: 'deleting autolink "JIRA-" before recreating it',
          drift: [
            "autolinks[JIRA-]: live settings differ from the settings file, and autolinks cannot be edited; apply will delete and recreate it",
          ],
          change: 'deleted autolink "JIRA-" to recreate it with the declared settings',
        },
        {
          role: "create",
          payload: {
            key_prefix: "JIRA-",
            url_template: "https://z.test/<num>",
            is_alphanumeric: true,
          },
          describe: 'recreating autolink "JIRA-"',
          drift: [
            'autolinks[JIRA-].url_template: declared "https://z.test/<num>" != live "https://x.test/<num>"',
          ],
          change: 'recreated autolink "JIRA-"',
        },
        {
          // An undeclared is_alphanumeric is left to GitHub's default (true).
          role: "create",
          payload: { key_prefix: "NEW-", url_template: "https://n.test/<num>" },
          describe: 'creating autolink "NEW-"',
          drift: [
            "autolinks[NEW-]: missing - declared in the settings file but not on the repo; apply will create it",
          ],
          change: 'created autolink "NEW-"',
        },
        {
          role: "remove",
          params: { autolink_id: "2" },
          describe: 'deleting undeclared autolink "OLD-"',
          drift: [
            "autolinks[OLD-]: undeclared - not in the settings file, so apply will DELETE it; add it to the settings file to keep it",
          ],
          change: 'DELETED undeclared autolink "OLD-"',
        },
      ],
      notes: [],
      drift: [],
    });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([LIST]);
  });

  test("a matching autolink plans nothing, and an omitted is_alphanumeric is not compared", async () => {
    const api = new MockApi({ [LIST]: { data: liveAutolinks } });
    const result = await plan(api, [
      { key_prefix: "JIRA-", url_template: "https://x.test/<num>" },
      { key_prefix: "OLD-", url_template: "https://y.test/<num>", is_alphanumeric: true },
    ]);
    expect(result).toEqual({ ops: [], notes: [], drift: [] });
  });

  test("a declared key the live autolink lacks is drift on the recreate plus a phantom note", async () => {
    const api = new MockApi({ [LIST]: { data: liveAutolinks } });
    const result = await plan(api, {
      undeclared: "keep",
      entries: [
        {
          key_prefix: "JIRA-",
          url_template: "https://x.test/<num>",
          is_alphanumerc: true,
        } as never,
      ],
    });
    expect(result.ops.map((op) => [op.role, op.drift])).toEqual([
      [
        "remove",
        [
          "autolinks[JIRA-]: live settings differ from the settings file, and autolinks cannot be edited; apply will delete and recreate it",
        ],
      ],
      [
        "create",
        [
          "autolinks[JIRA-].is_alphanumerc: declared true but the API response has no such field (new or write-only field?)",
        ],
      ],
    ]);
    expect(result.notes).toEqual([
      'autolinks[JIRA-]: declared key(s) "is_alphanumerc" do not exist on the live autolink, so if GitHub ignores them this delete-and-recreate will repeat on every apply without converging. Fix the key name, or remove it from the settings file',
      KEEP_NOTE,
    ]);
  });

  test.each<
    [
      form: string,
      declared: Parameters<typeof autolinksSection.plan>[1],
      roles: string[],
      notes: string[],
    ]
  >([
    [
      "wrapped undeclared:keep",
      {
        undeclared: "keep",
        entries: [{ key_prefix: "JIRA-", url_template: "https://x.test/<num>" }],
      },
      [],
      [KEEP_NOTE],
    ],
    [
      "the wrapper without a policy",
      { entries: [{ key_prefix: "JIRA-", url_template: "https://x.test/<num>" }] },
      ["remove"],
      [],
    ],
    [
      "the plain list",
      [{ key_prefix: "JIRA-", url_template: "https://x.test/<num>" }],
      ["remove"],
      [],
    ],
  ])(
    "%s resolves the undeclared autolink against the delete default",
    async (_form, declared, roles, notes) => {
      const api = new MockApi({ [LIST]: { data: liveAutolinks } });
      const result = await plan(api, declared);
      expect(result.ops.map((op): string => op.role)).toEqual(roles);
      expect(result.notes).toEqual(notes);
      expect(result.drift).toEqual([]);
    },
  );

  test("duplicate prefixes inside the wrapper are rejected before any API call", async () => {
    const api = new MockApi({});
    await expect(
      plan(api, {
        entries: [
          { key_prefix: "JIRA-", url_template: "https://x.test/<num>" },
          { key_prefix: "JIRA-", url_template: "https://y.test/<num>" },
        ],
      }),
    ).rejects.toThrow(/same autolinks entry/);
    expect(api.calls).toHaveLength(0);
  });

  test("executing the plan against the derived mock converges: DELETE then POST for the replace, and the re-plan is empty", async () => {
    const api = fragmentFake(autolinksSection, autolinksMockHandlers, {
      autolinks: [
        {
          id: 10,
          key_prefix: "TICKET-",
          url_template: "https://old.example.com/<num>",
          is_alphanumeric: true,
        },
        {
          id: 20,
          key_prefix: "JIRA-",
          url_template: "https://jira.example.com/<num>",
          is_alphanumeric: true,
        },
      ],
    });
    const { second, changes, notes } = await provePlanIdempotent(autolinksSection, api, [
      {
        key_prefix: "TICKET-",
        url_template: "https://example.com/TICKET?q=<num>",
        is_alphanumeric: false,
      },
    ]);
    expect(changes).toEqual([
      'deleted autolink "TICKET-" to recreate it with the declared settings',
      'recreated autolink "TICKET-"',
      'DELETED undeclared autolink "JIRA-"',
    ]);
    expect(notes).toEqual([]);
    expect(api.writes).toEqual([
      "DELETE /repos/o/r/autolinks/10",
      "POST /repos/o/r/autolinks",
      "DELETE /repos/o/r/autolinks/20",
    ]);
    expect(second).toEqual({ ops: [], notes: [], drift: [] });
    expect(
      api.state.autolinks.map((a) => [a.key_prefix, a.url_template, a.is_alphanumeric]),
    ).toEqual([["TICKET-", "https://example.com/TICKET?q=<num>", false]]);
  });

  test("the read port exposes exactly the list role in its denied posture", () => {
    const ctx = planContext(autolinksSection, new MockApi({}), REPO);
    expect(Object.keys(ctx.read)).toEqual(["list"]);
    // @ts-expect-error a write role is not a read: the port has no `create`
    ctx.read.create;
    // @ts-expect-error nor a `remove`
    ctx.read.remove;
    // @ts-expect-error a "denied" primary read offers no 404-tolerant helper
    ctx.read.list.probeAbsent;
  });
});
