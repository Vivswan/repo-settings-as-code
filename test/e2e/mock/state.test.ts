/**
 * State-layer unit tests: buildState overlay semantics and the write-to-read
 * transformer round trips. These run under the normal `bun test` suite (no
 * server, no subprocess). The transformer tests import the ENGINE's real
 * flatteners (flattenProtection, flattenEnvironment) and assert that flattening
 * a transformer's output reproduces the payload under the same declared-keys-
 * only subsetDiff the engine uses. Importing the real functions (not local
 * copies) is deliberate: it makes the test fail if a transformer and its
 * flattener ever drift, which is the whole point of the round trip.
 */

import { describe, expect, test } from "bun:test";
import { subsetDiff } from "../../../src/engine/diff.js";
import {
  bypassActorStrings,
  classicViewOfRule,
} from "../../../src/sections/branches/graphql-rules.js";
import { flattenProtection } from "../../../src/sections/branches/index.js";
import { flattenEnvironment } from "../../../src/sections/environments/index.js";
import { SECTIONS } from "../../../src/sections/registry.js";
import { roleForPermission } from "../../../src/sections/shared/roles.js";
import { genScenario } from "../generators.js";
import { Rng } from "../prng.js";
import { decodeNodeId, mintAppNodeId, mintNodeId } from "./node-id.js";
import {
  applyRuleInput,
  applyRuleInputToLiteral,
  buildState,
  buildStateForSlug,
  bypassUser,
  collaboratorFromPut,
  completeInvitation,
  completeRule,
  environmentFromPut,
  invitationFromPut,
  LIST_MOCKS,
  type MockState,
  normalizePinnedSeed,
  protectionFromPut,
  ruleFromProtection,
  ruleWireNode,
  teamRepoFromPut,
} from "./state.js";
import { storedKeyMaterial } from "./support.js";

describe("buildState overlay semantics", () => {
  test("undefined LiveState uses fixture defaults and empty lists", () => {
    const state = buildState(undefined, "org");
    expect(state.repo.name).toBe("e2e-repo");
    expect(state.repo.full_name).toBe("e2e-owner/e2e-repo");
    expect(state.labels).toEqual([]);
    expect(state.rulesets).toEqual([]);
    expect(state.pages).toBeNull();
    expect(state.org).not.toBeNull();
    expect((state.org as Record<string, unknown>).login).toBe("e2e-owner");
  });

  test("repo overlay wins field-by-field, deep-merging nested objects", () => {
    const state = buildState(
      { repo: { description: "overridden", permissions: { admin: false } } },
      "org",
    );
    expect(state.repo.description).toBe("overridden");
    // Deep merge keeps sibling fixture fields under permissions.
    expect(state.repo.permissions).toMatchObject({ admin: false, push: true, pull: true });
    // Untouched top-level fixture fields survive.
    expect(state.repo.default_branch).toBe("main");
  });

  test("explicit labels list replaces the (empty) baseline", () => {
    const state = buildState({ labels: [{ name: "bug", color: "d73a4a" }] }, "org");
    expect(state.labels).toHaveLength(1);
    expect(state.labels[0]).toMatchObject({ name: "bug", color: "d73a4a" });
  });

  test("labels.generate sugar produces count labels with the prefix and color", () => {
    const state = buildState(
      { labels: { generate: { count: 3, prefix: "area", color: "abcdef" } } },
      "org",
    );
    expect(state.labels).toHaveLength(3);
    expect(state.labels.map((l) => (l as Record<string, unknown>).name)).toEqual([
      "area-1",
      "area-2",
      "area-3",
    ]);
    for (const label of state.labels) {
      expect((label as Record<string, unknown>).color).toBe("abcdef");
    }
    // Generated ids are unique.
    const ids = new Set(state.labels.map((l) => (l as Record<string, unknown>).id));
    expect(ids.size).toBe(3);
  });

  test("list collections complete sparse seeds with the mock's defaults and server-owned fields", () => {
    const state = buildState(
      {
        labels: [{ name: "bug", color: "d73a4a" }],
        autolinks: [{ key_prefix: "JIRA-", url_template: "https://j.example.com/<num>" }],
        deploy_keys: [{ title: "bot", key: "ssh-ed25519 AAAAC3seedseedseed deploy@bot" }],
      },
      "org",
    );
    expect(state.labels[0]).toEqual({
      name: "bug",
      color: "d73a4a",
      description: null,
      default: false,
      id: expect.any(Number),
      node_id: expect.any(String),
      url: "https://api.github.com/repos/e2e-owner/e2e-repo/labels/bug",
    });
    expect(state.autolinks[0]).toEqual({
      key_prefix: "JIRA-",
      url_template: "https://j.example.com/<num>",
      is_alphanumeric: true,
      id: expect.any(Number),
    });
    // The seed's comment is stripped the way a created key is stored, so a converging apply over a
    // seeded key still proves the section compares algorithm + blob, not the raw string.
    expect(state.deploy_keys[0]).toMatchObject({
      title: "bot",
      key: storedKeyMaterial("ssh-ed25519 AAAAC3seedseedseed deploy@bot"),
      read_only: false,
      verified: true,
    });
    expect(String((state.deploy_keys[0] as Record<string, unknown>).key)).not.toContain(
      "deploy@bot",
    );
  });

  test("a pinned seed id anywhere in the overlay is reserved before any family mints", () => {
    // One pinned id sits in a list collection (last, after a minted sibling), one nested two levels
    // down in a non-list family; every id every family mints must still clear both.
    const state = buildState(
      {
        labels: [{ name: "minted" }, { name: "pinned", id: 90_000_001 }],
        autolinks: [{ key_prefix: "A-", url_template: "u" }],
        hooks: [{ config: { url: "https://example.test/hook" } }],
        invitations: [{ invitee: { login: "carol" } }],
        pull_bypass_list: [{ login: "dave" }],
        environment_branch_policies: { prod: [{ id: 90_000_000, name: "main", type: "branch" }] },
      },
      "org",
    );
    const ids = [
      ...state.labels,
      ...state.autolinks,
      ...state.hooks,
      ...state.invitations,
      ...state.pull_bypass_list,
      ...(state.environment_branch_policies.prod ?? []),
    ].map((item) => item.id as number);
    expect(ids).toContain(90_000_000);
    expect(ids).toContain(90_000_001);
    expect(new Set(ids).size).toBe(ids.length);
    expect(state.nextId).toBeGreaterThan(Math.max(...ids));
  });

  test("every id in a generated scenario's state is distinct, across every minting family", () => {
    // The one id counter starts past every seeded id, so nothing a family mints can collide with a
    // seed or with another family; generated live state exercises every seeding path at once.
    const mintingFamilies = (state: MockState) => [
      ...state.labels,
      ...state.autolinks,
      ...state.deploy_keys,
      ...state.hooks,
      ...state.invitations,
      ...state.pull_bypass_list,
    ];
    for (let seed = 0; seed < 25; seed++) {
      const { scenario } = genScenario(new Rng(seed));
      const state = buildState(scenario.live_state, scenario.owner_kind ?? "org");
      const ids = mintingFamilies(state).map((item) => item.id as number);
      expect(ids.every((id) => typeof id === "number")).toBe(true);
      expect(new Set(ids).size, `seed ${seed}`).toBe(ids.length);
      expect(state.nextId).toBeGreaterThan(Math.max(0, ...ids));
    }
  });

  test("every section built on the list factory has a completion spec, and nothing else does", () => {
    // A factory module carries its declaration; its mock serves seeds through LIST_MOCKS, so a new
    // factory section without a spec would serve incomplete seeds until it lands here.
    const factoryKeys = SECTIONS.filter((section) => "decl" in section).map((s) => s.key);
    expect(Object.keys(LIST_MOCKS).sort()).toEqual([...factoryKeys].sort());
  });

  test("actions retention and cache limits default to GitHub's values, overlay replaces", () => {
    const state = buildState(undefined, "org");
    expect(state.actions_retention).toEqual({ days: 90, maximum_allowed_days: 400 });
    expect(state.cache_retention_limit).toEqual({ max_cache_retention_days: 7 });
    expect(state.cache_storage_limit).toEqual({ max_cache_size_gb: 10 });
    const seeded = buildState(
      { actions_retention: { days: 30, maximum_allowed_days: 400 } },
      "org",
    );
    expect(seeded.actions_retention).toEqual({ days: 30, maximum_allowed_days: 400 });
  });

  test("ownerKind user marks the org absent", () => {
    const state = buildState(undefined, "user");
    expect(state.org).toBeNull();
  });

  test("state is decoupled from the fixture: mutating it does not leak", () => {
    const a = buildState(undefined, "org");
    a.repo.description = "mutated";
    const b = buildState(undefined, "org");
    expect(b.repo.description).not.toBe("mutated");
  });

  test("reslugging one state's nested owner does not contaminate the fixture singleton", () => {
    // deepMerge shallow-copied the top level, so before the clone fix state.repo
    // .owner aliased the imported fixture's nested owner object; reslugRepo then
    // mutated owner.login on the module singleton, contaminating later builds.
    // buildStateForSlug re-slugs owner.login; a second, unrelated build must
    // still see the pristine fixture owner.
    const first = buildStateForSlug("e2e-owner/svc-a", { settingsYaml: null }, "org");
    expect((first.repo.owner as Record<string, unknown>).login).toBe("e2e-owner");
    // Build a second state with a live_state.repo overlay (the deepMerge path)
    // and re-slug it to a different owner.
    const second = buildStateForSlug(
      "other-owner/svc-b",
      { settingsYaml: null, liveState: { repo: { description: "x" } } },
      "org",
    );
    expect((second.repo.owner as Record<string, unknown>).login).toBe("other-owner");
    // A third, plain build must see the untouched fixture owner - proof the
    // module singleton was never mutated by the re-slugs above.
    const third = buildState(undefined, "org");
    expect((third.repo.owner as Record<string, unknown>).login).toBe("e2e-owner");
    expect(third.repo.full_name).toBe("e2e-owner/e2e-repo");
  });
});

describe("protectionFromPut round trip", () => {
  test("the engine flattener over protectionFromPut(payload) shows no drift", () => {
    // A payload exercising every field the branches section reads: the four
    // required core keys, the boolean toggles, nested review settings, and the
    // actor string arrays that must expand then collapse back to strings.
    const payload = {
      required_status_checks: { strict: true, contexts: ["all-green"] },
      enforce_admins: true,
      required_pull_request_reviews: {
        dismiss_stale_reviews: true,
        require_code_owner_reviews: false,
        required_approving_review_count: 2,
        require_last_push_approval: true,
        dismissal_restrictions: { users: ["alice"], teams: ["reviewers"], apps: [] },
        bypass_pull_request_allowances: { users: [], teams: ["admins"], apps: [] },
      },
      restrictions: { users: ["alice", "bob"], teams: ["reviewers"], apps: ["my-app"] },
      required_linear_history: true,
      allow_force_pushes: false,
      allow_deletions: false,
      block_creations: true,
      required_conversation_resolution: true,
      lock_branch: false,
      allow_fork_syncing: true,
    };
    // subsetDiff is exactly how the branches section compares declared
    // protection against the flattened live GET; no drift proves the round trip.
    const flattened = flattenProtection(protectionFromPut(payload));
    expect(subsetDiff(payload, flattened, "protection")).toEqual([]);
  });

  test("a null core key is dropped from the GET shape", () => {
    const flattened = flattenProtection(
      protectionFromPut({ enforce_admins: false, restrictions: null }),
    );
    expect(flattened).toEqual({ enforce_admins: false });
  });

  test("required_signatures is dropped from the PUT shape (its sub-endpoint owns it)", () => {
    // GitHub's protection PUT silently discards the toggle, so the stored GET
    // shape must not gain it from a PUT body.
    expect(protectionFromPut({ enforce_admins: true, required_signatures: true })).toEqual({
      enforce_admins: { enabled: true },
    });
  });
});

describe("branch protection rule projections", () => {
  test("the section's classicViewOfRule over ruleFromProtection shows no drift", () => {
    // A LITERAL rule with every translated key plus the GraphQL-only extras:
    // projecting the stored REST GET shape into a rule node and reading it
    // back through the engine's classic view must reproduce the declaration
    // under the same declared-keys-only subsetDiff the section uses.
    const payload = {
      enforce_admins: true,
      required_linear_history: true,
      allow_force_pushes: false,
      allow_deletions: false,
      block_creations: true,
      required_conversation_resolution: true,
      lock_branch: false,
      allow_fork_syncing: true,
      required_status_checks: { strict: true, contexts: ["all-green"] },
      required_pull_request_reviews: {
        required_approving_review_count: 2,
        require_code_owner_reviews: true,
        dismiss_stale_reviews: false,
        require_last_push_approval: true,
      },
    };
    const extras = {
      bypassForcePushActors: ["octocat", "e2e-owner/platform", "app/deploy-gate"],
      requiresDeployments: true,
      requiredDeploymentEnvironments: ["prod"],
    };
    const node = ruleFromProtection("main", protectionFromPut(payload), extras, "o/r");
    const view = classicViewOfRule(node as Record<string, unknown>);
    expect(subsetDiff(payload, view, "protection")).toEqual([]);
    expect(view.force_push_bypassers).toEqual(["app/deploy-gate", "e2e-owner/platform", "octocat"]);
    expect(view.required_deployments).toEqual({ environments: ["prod"] });
    const decoded = decodeNodeId(String((node as Record<string, unknown>).id));
    expect(decoded).toEqual({ family: "rule", slug: "o/r", key: "main" });
  });

  test("required_signatures projects from the GET sub-resource shape", () => {
    // The sub-endpoint stores {enabled} on the GET shape; the rule node's
    // requiresCommitSignatures twin must read it back.
    const node = ruleFromProtection(
      "main",
      { enforce_admins: { enabled: true }, required_signatures: { enabled: true } },
      undefined,
      "o/r",
    );
    expect(classicViewOfRule(node as Record<string, unknown>).required_signatures).toBe(true);
  });

  test("a stored wildcard rule round-trips through ruleWireNode and the classic view", () => {
    const stored = completeRule({
      pattern: "release/*",
      isAdminEnforced: true,
      requiresStatusChecks: true,
      requiresStrictStatusChecks: true,
      requiredStatusCheckContexts: ["ci"],
      bypassForcePushActors: ["octocat"],
    });
    const view = classicViewOfRule(ruleWireNode(stored) as Record<string, unknown>);
    expect(view.enforce_admins).toBe(true);
    expect(view.required_status_checks).toEqual({ strict: true, contexts: ["ci"] });
    expect(view.force_push_bypassers).toEqual(["octocat"]);
    expect(view.required_deployments).toBeNull();
  });

  test("applyRuleInput decodes actor ids and mimics the environment silent drop", () => {
    const state = buildState({ environments: { prod: { name: "prod" } } }, "org");
    const stored = completeRule({ pattern: "release/*" });
    const applied = applyRuleInput(
      stored,
      {
        branchProtectionRuleId: mintNodeId("rule", "e2e-owner/e2e-repo", "release/*"),
        isAdminEnforced: true,
        bypassForcePushActorIds: [
          mintNodeId("user", "e2e-owner/e2e-repo", "octocat"),
          mintNodeId("team", "e2e-owner/e2e-repo", "e2e-owner/platform"),
          mintAppNodeId("deploy-gate"),
        ],
        requiresDeployments: true,
        requiredDeploymentEnvironments: ["prod", "ghost"],
      },
      state,
    );
    expect(applied).toEqual({ ok: true });
    expect(stored.isAdminEnforced).toBe(true);
    expect(stored.bypassForcePushActors).toEqual([
      "octocat",
      "e2e-owner/platform",
      "app/deploy-gate",
    ]);
    // GitHub keeps only names of EXISTING environments and still succeeds;
    // "ghost" must vanish so the section's read-back check can catch it.
    expect(stored.requiredDeploymentEnvironments).toEqual(["prod"]);
    expect(bypassActorStrings(ruleWireNode(stored) as Record<string, unknown>)).toEqual([
      "octocat",
      "e2e-owner/platform",
      "app/deploy-gate",
    ]);
  });

  test("applyRuleInput rejects an actor id the codec did not mint", () => {
    const state = buildState(undefined, "org");
    const stored = completeRule({ pattern: "release/*" });
    const applied = applyRuleInput(stored, { bypassForcePushActorIds: ["MDQ6VXNlcjE="] }, state);
    expect(applied).toEqual({ bad: "MDQ6VXNlcjE=" });
  });

  test("applyRuleInputToLiteral splits twins onto the GET shape and extras", () => {
    const state = buildState(
      {
        branch_protection: { main: { enforce_admins: { enabled: false } } },
        environments: { prod: { name: "prod" } },
      },
      "org",
    );
    const applied = applyRuleInputToLiteral(state, "main", {
      branchProtectionRuleId: mintNodeId("rule", "e2e-owner/e2e-repo", "main"),
      isAdminEnforced: true,
      bypassForcePushActorIds: [mintNodeId("user", "e2e-owner/e2e-repo", "octocat")],
      requiresDeployments: true,
      requiredDeploymentEnvironments: ["prod", "ghost"],
    });
    expect(applied).toEqual({ ok: true });
    // The translated twin lands back on the REST GET shape (one underlying
    // rule), while the GraphQL-only fields live in the extras family.
    expect((state.branch_protection.main as Record<string, unknown>).enforce_admins).toEqual({
      enabled: true,
    });
    expect(state.branch_protection_graphql.main).toEqual({
      bypassForcePushActors: ["octocat"],
      requiresDeployments: true,
      requiredDeploymentEnvironments: ["prod"],
    });
  });
});

describe("environmentFromPut round trip", () => {
  test("the engine flattener over environmentFromPut(payload) shows no drift", () => {
    const payload = {
      wait_timer: 30,
      prevent_self_review: true,
      reviewers: [
        { type: "User", id: 101 },
        { type: "Team", id: 201 },
      ],
      deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
    };
    // flattenEnvironment leaves the un-nested protection_rules on the object;
    // subsetDiff (declared-keys-only, exactly as the environments section
    // uses it) ignores that undeclared key and confirms the payload survives.
    const flattened = flattenEnvironment(environmentFromPut(payload));
    expect(subsetDiff(payload, flattened, "environments[production]")).toEqual([]);
  });

  test("deployment_branch_policy passes through untouched", () => {
    const get = environmentFromPut({ deployment_branch_policy: null });
    expect(get.deployment_branch_policy).toBeNull();
    expect(get.protection_rules).toEqual([]);
  });
});

describe("collaborator and team transformers map permission to role_name", () => {
  test("collaboratorFromPut uses roleForPermission", () => {
    const get = collaboratorFromPut("alice", { permission: "push" });
    expect(get.login).toBe("alice");
    expect(get.role_name).toBe(roleForPermission("push"));
    expect(get.role_name).toBe("write");
  });

  test("collaboratorFromPut defaults to push when permission is absent", () => {
    expect(collaboratorFromPut("bob", {}).role_name).toBe("write");
  });

  test("custom org role names pass through untouched", () => {
    expect(collaboratorFromPut("carol", { permission: "security-team" }).role_name).toBe(
      "security-team",
    );
  });

  test("teamRepoFromPut maps pull to read", () => {
    expect(teamRepoFromPut({ permission: "pull" })).toEqual({ role_name: "read" });
  });
});

describe("invitationFromPut round-trips the PUT permission into the invitation vocabulary", () => {
  const repo = { full_name: "e2e-owner/e2e-repo", owner: { login: "e2e-owner" } };

  test("the declared permission becomes the permissions string via roleForPermission", () => {
    const invitation = invitationFromPut(
      "alice",
      { permission: "push" },
      42,
      repo,
      "e2e-owner/e2e-repo",
    );
    expect((invitation.invitee as { login: string }).login).toBe("alice");
    expect(invitation.permissions).toBe(roleForPermission("push"));
    expect(invitation.permissions).toBe("write");
    // The section's converged-pending comparison reads exactly these two
    // fields plus `expired`, which a fresh invitation must not carry as true.
    expect(invitation.expired).toBe(false);
    expect(invitation.id).toBe(42);
  });

  test("defaults to push when permission is absent; a custom role clamps to its base grant", () => {
    expect(invitationFromPut("bob", {}, 1, repo, "e2e-owner/e2e-repo").permissions).toBe("write");
    // GitHub never reports a custom role name on an invitation (the
    // permissions field is a spec enum), so the mock stores the base grant.
    expect(
      invitationFromPut("carol", { permission: "security-team" }, 2, repo, "e2e-owner/e2e-repo")
        .permissions,
    ).toBe("write");
  });

  test("the scaffold derives identity fields from the target repo", () => {
    const invitation = invitationFromPut(
      "alice",
      { permission: "pull" },
      3,
      repo,
      "e2e-owner/e2e-repo",
    );
    expect((invitation.inviter as { login: string }).login).toBe("e2e-owner");
    expect(invitation.url).toBe("https://api.github.com/repos/e2e-owner/e2e-repo/invitations/3");
    // A clone of the repo, not the live reference: stored invitations must
    // not mirror later repo mutations (the snapshot layer keys on families).
    expect(invitation.repository).toEqual(repo);
    expect(invitation.repository).not.toBe(repo);
  });
});

describe("completeInvitation", () => {
  const repo = { full_name: "e2e-owner/e2e-repo", owner: { login: "e2e-owner" } };

  test("a sparse seed keeps its own fields and gains the required scaffold", () => {
    const completed = completeInvitation(
      { invitee: { login: "dave" }, permissions: "read", expired: true },
      77,
      repo,
      "e2e-owner/e2e-repo",
    );
    expect(completed.id).toBe(77);
    expect(completed.permissions).toBe("read");
    expect(completed.expired).toBe(true);
    expect(completed.invitee).toEqual({
      login: "dave",
      id: 0,
      type: "User",
      site_admin: false,
    });
    expect(completed.created_at).toBe("2026-07-01T00:00:00Z");
  });

  test("a seeded id wins over the caller's", () => {
    expect(
      completeInvitation({ id: 5, invitee: { login: "x" } }, 99, repo, "e2e-owner/e2e-repo").id,
    ).toBe(5);
  });

  test("an explicit null invitee stays null (an email invitation)", () => {
    expect(
      completeInvitation({ invitee: null, permissions: "read" }, 6, repo, "e2e-owner/e2e-repo")
        .invitee,
    ).toBeNull();
  });

  test("a multi-repo target's seeded invitation derives from the re-slugged repo", () => {
    // Re-slugging must happen BEFORE family completion (the buildState slug
    // param), or the invitation scaffold bakes the fixture slug into its urls.
    const state = buildStateForSlug(
      "acme/payments",
      {
        settingsYaml: null,
        liveState: { invitations: [{ id: 9, invitee: { login: "dave" }, permissions: "read" }] },
      },
      "org",
    );
    const invitation = state.invitations[0] as Record<string, unknown>;
    expect(invitation.url).toBe("https://api.github.com/repos/acme/payments/invitations/9");
    expect((invitation.inviter as { login: string }).login).toBe("acme");
    expect((invitation.repository as { full_name: string }).full_name).toBe("acme/payments");
  });
});

describe("bypassUser", () => {
  test("a sparse seed keeps its own fields and gains the simple-user scaffold", () => {
    const completed = bypassUser({ login: "dave" }, 42) as Record<string, unknown>;
    expect(completed.id).toBe(42);
    expect(completed.login).toBe("dave");
    expect(completed.type).toBe("User");
    expect(completed.site_admin).toBe(false);
    expect(completed.node_id).toBe("MDQ6VXNlcj42");
    expect(completed.url).toBe("https://api.github.com/users/dave");
    expect(completed.html_url).toBe("https://github.com/dave");
    expect(completed.avatar_url).toBe("https://avatars.githubusercontent.com/u/42?v=4");
  });

  test("a seeded id wins over the caller's and drives the derived fields", () => {
    const completed = bypassUser({ login: "x", id: 5 }, 99) as Record<string, unknown>;
    expect(completed.id).toBe(5);
    expect(completed.node_id).toBe("MDQ6VXNlcj5");
    expect(completed.avatar_url).toBe("https://avatars.githubusercontent.com/u/5?v=4");
  });

  test("a seed's own scaffold fields win over the defaults", () => {
    const completed = bypassUser(
      { login: "bot", type: "Bot", site_admin: true, url: "https://example.test/bot" },
      7,
    ) as Record<string, unknown>;
    expect(completed.type).toBe("Bot");
    expect(completed.site_admin).toBe(true);
    expect(completed.url).toBe("https://example.test/bot");
  });

  test("buildState completes pull_bypass_list seeds to the served shape", () => {
    const state = buildState({ pull_bypass_list: [{ login: "dave" }] }, "org");
    const user = state.pull_bypass_list[0] as Record<string, unknown>;
    expect(user.login).toBe("dave");
    expect(typeof user.id).toBe("number");
    expect(user.type).toBe("User");
    expect(user.url).toBe("https://api.github.com/users/dave");
  });
});

describe("mock node ids", () => {
  test("mint/decode round-trips family, slug, and key", () => {
    const id = mintNodeId("environment", "acme/api.service-1", "prod");
    expect(decodeNodeId(id)).toEqual({
      family: "environment",
      slug: "acme/api.service-1",
      key: "prod",
    });
  });

  test("a key containing colons survives the round trip", () => {
    const id = mintNodeId("rule", "o/r", "branch:main:pattern");
    expect(decodeNodeId(id)?.key).toBe("branch:main:pattern");
  });

  test("foreign ids do not decode", () => {
    // A GitHub-realistic legacy id, an arbitrary string, and an empty string:
    // none of them are the mock's, so a mutation carrying one is a violation
    // the pipeline can only raise if the codec refuses to guess.
    expect(decodeNodeId("MDU6TGFiZWw5MDAwMDAwMQ==")).toBeNull();
    expect(decodeNodeId("not-base64-at-all")).toBeNull();
    expect(decodeNodeId("")).toBeNull();
  });

  test("buildState stamps the repo node id with the fixture slug", () => {
    const state = buildState(undefined, "org");
    expect(decodeNodeId(String(state.repo.node_id))).toEqual({
      family: "repo",
      slug: "e2e-owner/e2e-repo",
      key: "",
    });
  });

  test("buildStateForSlug re-mints ids for the target slug, environments included", () => {
    const state = buildStateForSlug(
      "acme/private",
      { settingsYaml: null, liveState: { environments: { prod: { name: "prod" } } } },
      "org",
    );
    expect(decodeNodeId(String(state.repo.node_id))?.slug).toBe("acme/private");
    expect(decodeNodeId(String(state.environments.prod?.node_id))).toEqual({
      family: "environment",
      slug: "acme/private",
      key: "prod",
    });
  });

  test("generated labels and completed hooks name the TARGET slug in their urls", () => {
    // The url is served state like any other field: a multi-repo target's
    // generated labels and seeded hooks must name the target repository, not
    // the admin fixture the mock happens to run as.
    const state = buildStateForSlug(
      "acme/private",
      {
        settingsYaml: null,
        liveState: {
          labels: { generate: { count: 2, prefix: "area", color: "abcdef" } },
          hooks: [{ config: { url: "https://example.test/hook" } }],
        },
      },
      "org",
    );
    for (const label of state.labels) {
      expect(String((label as Record<string, unknown>).url)).toContain("/repos/acme/private/");
    }
    const hook = state.hooks[0] as Record<string, unknown>;
    for (const field of ["url", "test_url", "ping_url", "deliveries_url"] as const) {
      expect(String(hook[field])).toContain("/repos/acme/private/hooks/");
    }
  });

  test("no fixture identity survives anywhere in a re-slugged repo body", () => {
    // reslugRepo rewrites the explicit identity fields AND every url/template
    // string (html_url, hooks_url, clone_url, the owner's own urls, ...): a
    // target's GET /repos/{slug} body must nowhere point at the admin
    // fixture's repository.
    const state = buildStateForSlug("acme/private", { settingsYaml: null }, "org");
    const body = JSON.stringify(state.repo);
    expect(body).not.toContain("e2e-owner");
    expect(body).not.toContain("e2e-repo");
    expect(String(state.repo.html_url)).toBe("https://github.com/acme/private");
    expect(String((state.repo.owner as Record<string, unknown>).url)).toBe(
      "https://api.github.com/users/acme",
    );
  });

  test("re-slugging is exact for identities overlapping the fixture's", () => {
    // The substitution is two-phase through placeholder tokens: a sequential
    // replace would re-match the old owner INSIDE a new identity that
    // contains it, corrupting the urls (e2e-owner-fork -> e2e-owner-fork-fork,
    // my-e2e-owner-repo -> my-<owner>-repo).
    const forkOwner = buildStateForSlug("e2e-owner-fork/service", { settingsYaml: null }, "org");
    expect(String(forkOwner.repo.html_url)).toBe("https://github.com/e2e-owner-fork/service");
    const nameCarrier = buildStateForSlug("acme/my-e2e-owner-repo", { settingsYaml: null }, "org");
    expect(String(nameCarrier.repo.html_url)).toBe("https://github.com/acme/my-e2e-owner-repo");
  });

  test("re-slugging rewrites only url fields, never seeded content", () => {
    // A description MENTIONING the fixture owner is content, not identity.
    const state = buildStateForSlug(
      "acme/private",
      {
        settingsYaml: null,
        liveState: { repo: { description: "forked from e2e-owner long ago" } },
      },
      "org",
    );
    expect(state.repo.description).toBe("forked from e2e-owner long ago");
  });
});

describe("normalizePinnedSeed", () => {
  test("strings take contiguous positions; explicit entries keep their holes", () => {
    expect(normalizePinnedSeed(["a", "b"])).toEqual([
      { name: "a", position: 1 },
      { name: "b", position: 2 },
    ]);
    // Explicit hole-y positions survive verbatim and come back rank-sorted,
    // so a scenario can seed the layouts live GitHub produces after unpins.
    expect(
      normalizePinnedSeed([
        { name: "b", position: 5 },
        { name: "a", position: 2 },
      ]),
    ).toEqual([
      { name: "a", position: 2 },
      { name: "b", position: 5 },
    ]);
    // A string after an explicit entry continues past the largest position.
    expect(normalizePinnedSeed([{ name: "a", position: 3 }, "b"])).toEqual([
      { name: "a", position: 3 },
      { name: "b", position: 4 },
    ]);
  });

  test("buildState seeds the monotonic counter at the largest seeded position", () => {
    const state = buildState(
      {
        pinned_environments: [
          { name: "a", position: 2 },
          { name: "b", position: 5 },
        ],
      },
      "org",
    );
    expect(state._pinned_position_counter).toBe(5);
    // An empty seed leaves the counter at zero, so the first pin takes 1.
    expect(buildState(undefined, "org")._pinned_position_counter).toBe(0);
  });
});
