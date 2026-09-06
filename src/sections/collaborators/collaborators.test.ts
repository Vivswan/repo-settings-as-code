import { describe, expect, test } from "bun:test";
import { executePlan } from "../../../src/engine/execute.js";
import { PermissionDenied } from "../../../src/sections/contract/errors.js";
import { planContext } from "../../../src/sections/contract/plan.js";
import { MockApi } from "../../../test/mock-api.js";
import { fragmentFake } from "../../../test/sections/fragment-fake.js";
import { provePlanIdempotent } from "../../../test/sections/plan-idempotence.js";
import { REPO } from "../../../test/sections/section-run.js";
import { collaboratorsSection } from "./index.js";
import { collaboratorsMockHandlers } from "./mock.js";

const LIST = "GET /repos/o/r/collaborators?affiliation=direct&per_page=100&page=1";
const INVITATIONS = "GET /repos/o/r/invitations?per_page=100&page=1";
const plan = (api: MockApi, desired: Parameters<typeof collaboratorsSection.plan>[1]) =>
  collaboratorsSection.plan(planContext(collaboratorsSection, api, REPO), desired);
const NO_SECRETS = {
  resolveSecret: (): string => {
    throw new Error("no secrets");
  },
};

describe("collaborators", () => {
  test("plans an update per drifted collaborator, an invitation per missing user, and a removal per undeclared one, reading only", async () => {
    const api = new MockApi({
      [LIST]: {
        data: [
          { login: "Alice", role_name: "read" },
          { login: "O", role_name: "admin" },
          { login: "stale", role_name: "write" },
        ],
      },
      [INVITATIONS]: { data: [] },
    });
    const result = await plan(api, [
      { username: "alice", permission: "push" },
      { username: "bob" },
    ]);
    expect(result).toEqual({
      ops: [
        {
          role: "update",
          params: { username: "alice" },
          payload: { permission: "push" },
          describe: 'updating collaborator "alice"',
          drift: [
            'collaborators[alice]: live role "read" != declared "write"; apply will set the declared permission',
          ],
          change: 'updated collaborator "alice" (push)',
        },
        {
          role: "update",
          params: { username: "bob" },
          payload: { permission: "push" },
          describe: 'inviting collaborator "bob"',
          drift: [
            'collaborators[bob]: missing - not a collaborator on the repo; apply will send an invitation with "push"',
          ],
          change: 'invited collaborator "bob" (push)',
        },
        {
          role: "remove",
          params: { username: "stale" },
          drift: [
            "collaborators[stale]: undeclared - not in the settings file, so apply will REMOVE them; add them to the settings file to keep their access",
          ],
          change: 'REMOVED undeclared collaborator "stale"',
        },
      ],
      notes: [],
      drift: [],
    });
    // The owner "O" is never removed, and planning only reads.
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([LIST, INVITATIONS]);
  });

  test("a matching role and a matching pending invitation plan nothing; keep turns the undeclared ones into notes", async () => {
    const api = new MockApi({
      [LIST]: {
        data: [
          { login: "alice", role_name: "write" },
          { login: "bob", role_name: "read" },
        ],
      },
      [INVITATIONS]: {
        data: [
          { id: 7, invitee: { login: "Carol" }, permissions: "write", expired: false },
          { id: 8, invitee: { login: "mallory" }, permissions: "write", expired: false },
          { id: 9, invitee: null, permissions: "read", expired: false },
        ],
      },
    });
    const result = await plan(api, {
      undeclared: "keep",
      entries: [
        { username: "alice", permission: "push" },
        { username: "carol", permission: "push" },
      ],
    });
    expect(result).toEqual({
      ops: [],
      notes: [
        'collaborator "bob" has access but is not declared in the settings file; kept under "undeclared: keep" - add them to the settings file to manage their access, or set "undeclared: delete" to have apply REMOVE them',
        'invitation for "mallory" is pending but not declared in the settings file; kept under "undeclared: keep" - add them to the settings file to manage their access, or set "undeclared: delete" to have apply CANCEL the invitation',
        "invitation 9 was sent by email, so no username can declare it; left untouched - cancel it from the repository's Access settings if it is unwanted",
      ],
      drift: [],
    });
  });

  test("pending invitations: a stale one is PATCHed in the read vocabulary, an expired one cancelled then re-sent, an undeclared one cancelled", async () => {
    const api = new MockApi({
      [LIST]: { data: [] },
      [INVITATIONS]: {
        data: [
          { id: 7, invitee: { login: "alice" }, permissions: "read", expired: false },
          { id: 8, invitee: { login: "bob" }, permissions: "write", expired: true },
          { id: 9, invitee: { login: "mallory" }, permissions: "write", expired: false },
        ],
      },
    });
    const result = await plan(api, [
      { username: "alice", permission: "push" },
      { username: "bob", permission: "push" },
    ]);
    expect(result).toEqual({
      ops: [
        {
          role: "updateInvitation",
          params: { invitation_id: "7" },
          payload: { permissions: "write" },
          describe: 'updating the pending invitation for "alice"',
          drift: [
            'collaborators[alice]: pending invitation permission "read" != declared "write"; apply will update the invitation',
          ],
          change: 'updated pending invitation for "alice" (push)',
        },
        {
          role: "cancelInvitation",
          params: { invitation_id: "8" },
          describe: 'cancelling the expired invitation for "bob"',
          drift: [
            'collaborators[bob]: pending invitation expired; apply will cancel it and send a fresh invitation with "push"',
          ],
          change: 'cancelled the expired invitation for "bob"',
        },
        {
          role: "update",
          params: { username: "bob" },
          payload: { permission: "push" },
          describe: 'inviting collaborator "bob"',
          drift: [
            'collaborators[bob]: missing - not a collaborator on the repo; apply will send an invitation with "push"',
          ],
          change: 're-invited collaborator "bob" (push) - the pending invitation had expired',
        },
        {
          role: "cancelInvitation",
          params: { invitation_id: "9" },
          drift: [
            "collaborators[mallory]: undeclared - a pending invitation not in the settings file, so apply will CANCEL it; add them to the settings file to keep the invitation",
          ],
          change: 'CANCELLED undeclared invitation for "mallory"',
        },
      ],
      notes: [],
      drift: [],
    });
  });

  test("a declared custom role is noted against a pending invitation, never PATCHed; once expired it is still cancelled and re-sent", async () => {
    const pending = new MockApi({
      [LIST]: { data: [] },
      [INVITATIONS]: {
        data: [{ id: 11, invitee: { login: "alice" }, permissions: "write", expired: false }],
      },
    });
    expect(await plan(pending, [{ username: "alice", permission: "security-team" }])).toEqual({
      ops: [],
      notes: [
        'invitation for "alice" is pending; invitations report only the standard roles, so it cannot be compared to the declared custom role "security-team" - left untouched, the declared role is applied once the invitation is accepted',
      ],
      drift: [],
    });
    const expired = new MockApi({
      [LIST]: { data: [] },
      [INVITATIONS]: {
        data: [{ id: 12, invitee: { login: "alice" }, permissions: "write", expired: true }],
      },
    });
    expect(await plan(expired, [{ username: "alice", permission: "security-team" }])).toEqual({
      ops: [
        {
          role: "cancelInvitation",
          params: { invitation_id: "12" },
          describe: 'cancelling the expired invitation for "alice"',
          drift: [
            'collaborators[alice]: pending invitation expired; apply will cancel it and send a fresh invitation with "security-team"',
          ],
          change: 'cancelled the expired invitation for "alice"',
        },
        {
          role: "update",
          params: { username: "alice" },
          payload: { permission: "security-team" },
          describe: 'inviting collaborator "alice"',
          drift: [
            'collaborators[alice]: missing - not a collaborator on the repo; apply will send an invitation with "security-team"',
          ],
          change:
            're-invited collaborator "alice" (security-team) - the pending invitation had expired',
        },
      ],
      notes: [],
      drift: [],
    });
  });

  test("a 404 on the collaborator list is a denial that stops the section before the invitation read", async () => {
    const api = new MockApi({ [INVITATIONS]: { data: [] } });
    await expect(plan(api, [{ username: "alice" }])).rejects.toBeInstanceOf(PermissionDenied);
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([LIST]);
  });

  test("executing the plan issues the writes in plan order against the encoded paths", async () => {
    const api = new MockApi({
      [LIST]: { data: [{ login: "stale", role_name: "write" }] },
      [INVITATIONS]: {
        data: [{ id: 8, invitee: { login: "bob" }, permissions: "write", expired: true }],
      },
    }).allowMutations(
      "DELETE /repos/o/r/invitations/*",
      "PUT /repos/o/r/collaborators/*",
      "DELETE /repos/o/r/collaborators/*",
    );
    const planned = await plan(api, [{ username: "bob", permission: "push" }]);
    const execution = await executePlan(planned, collaboratorsSection, api, REPO, NO_SECRETS);
    expect(execution.status).toBe("applied");
    expect(api.mutations()).toEqual([
      { method: "DELETE", path: "/repos/o/r/invitations/8", payload: undefined },
      { method: "PUT", path: "/repos/o/r/collaborators/bob", payload: { permission: "push" } },
      { method: "DELETE", path: "/repos/o/r/collaborators/stale", payload: undefined },
    ]);
  });

  test("two entries naming the same login are rejected before any API call", async () => {
    const api = new MockApi({});
    await expect(
      plan(api, [{ username: "alice" }, { username: "Alice", permission: "admin" }]),
    ).rejects.toThrow(/same collaborators entry: "alice" and "Alice"/);
    expect(api.calls).toHaveLength(0);
  });

  test("executing the plan against the mock fragment converges: the re-plan carries only the email note", async () => {
    const api = fragmentFake(collaboratorsSection, collaboratorsMockHandlers, {
      collaborators: [
        { login: "alice", role_name: "read" },
        { login: "stale", role_name: "write" },
      ],
      invitations: [
        { id: 501, invitee: { login: "bob" }, permissions: "read" },
        { id: 502, invitee: { login: "carol" }, permissions: "write", expired: true },
        { id: 503, invitee: { login: "mallory" }, permissions: "write" },
        { id: 504, invitee: null, permissions: "read" },
      ],
    });
    const { second, changes, notes } = await provePlanIdempotent(collaboratorsSection, api, [
      { username: "alice", permission: "admin" },
      { username: "bob", permission: "push" },
      { username: "carol", permission: "push" },
      { username: "dave" },
    ]);
    expect(changes).toEqual([
      'updated collaborator "alice" (admin)',
      'updated pending invitation for "bob" (push)',
      'cancelled the expired invitation for "carol"',
      're-invited collaborator "carol" (push) - the pending invitation had expired',
      'invited collaborator "dave" (push)',
      'REMOVED undeclared collaborator "stale"',
      'CANCELLED undeclared invitation for "mallory"',
    ]);
    expect(notes).toEqual([]);
    expect(api.writes).toEqual([
      "PUT /repos/o/r/collaborators/alice",
      "PATCH /repos/o/r/invitations/501",
      "DELETE /repos/o/r/invitations/502",
      "PUT /repos/o/r/collaborators/carol",
      "PUT /repos/o/r/collaborators/dave",
      "DELETE /repos/o/r/collaborators/stale",
      "DELETE /repos/o/r/invitations/503",
    ]);
    expect(second).toEqual({
      ops: [],
      notes: [
        "invitation 504 was sent by email, so no username can declare it; left untouched - cancel it from the repository's Access settings if it is unwanted",
      ],
      drift: [],
    });
    expect(api.state.collaborators.map((c) => [c.login, c.role_name])).toEqual([
      ["alice", "admin"],
    ]);
    expect(
      api.state.invitations.map((i) => [
        (i.invitee as { login?: string } | null)?.login,
        i.permissions,
      ]),
    ).toEqual([
      ["bob", "write"],
      [undefined, "read"],
      ["carol", "write"],
      ["dave", "write"],
    ]);
  });

  test("the read port exposes exactly the two list roles, the primary one in its denied posture", () => {
    const ctx = planContext(collaboratorsSection, new MockApi({}), REPO);
    expect(Object.keys(ctx.read)).toEqual(["list", "listInvitations"]);
    // @ts-expect-error a write role is not a read: the port has no `update`
    ctx.read.update;
    // @ts-expect-error nor a `remove`
    ctx.read.remove;
    // @ts-expect-error nor an `updateInvitation`
    ctx.read.updateInvitation;
    // @ts-expect-error nor a `cancelInvitation`
    ctx.read.cancelInvitation;
    // @ts-expect-error a "denied" primary read offers no 404-tolerant helper
    ctx.read.list.probeAbsent;
    expect(typeof ctx.read.listInvitations.listAll).toBe("function");
  });
});
