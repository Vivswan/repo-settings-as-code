import { describe, expect, test } from "bun:test";
import { DEFAULT_ROLE, roleForPermission } from "../../src/sections/roles.js";

describe("roleForPermission", () => {
  test("maps the PUT vocabulary to the GET role_name vocabulary", () => {
    expect(roleForPermission("push")).toBe("write");
    expect(roleForPermission("pull")).toBe("read");
  });

  test("passes custom and already-GET-vocabulary roles through untouched", () => {
    expect(roleForPermission("admin")).toBe("admin");
    expect(roleForPermission("maintain")).toBe("maintain");
    expect(roleForPermission("triage")).toBe("triage");
    expect(roleForPermission("security-team")).toBe("security-team");
  });
});

describe("DEFAULT_ROLE", () => {
  test("is push, the write default both collaborators and teams fall back to", () => {
    // Pins the shared default: collaborators.ts and teams.ts both read this
    // symbol, so an accidental change here would move both sections at once
    // (and this test would flag it) rather than letting them silently diverge.
    expect(DEFAULT_ROLE).toBe("push");
    expect(roleForPermission(DEFAULT_ROLE)).toBe("write");
  });
});
