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
import { flattenProtection } from "../../../src/sections/branches.js";
import { flattenEnvironment } from "../../../src/sections/environments.js";
import { roleForPermission } from "../../../src/sections/roles.js";
import {
  buildState,
  collaboratorFromPut,
  environmentFromPut,
  protectionFromPut,
  teamRepoFromPut,
} from "./state.js";

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
