// Hand-written permission prose in permissions.md, pinned to the section declarations; the
// generated regions (permissions.md, check-mode.md) are covered by gen-action-docs.test.ts.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { overrideAdviceLevel } from "../../src/sections/contract/errors.js";
import { RESOURCE_LABEL, type SectionPermission } from "../../src/sections/contract/permissions.js";
import { DOCS } from "../../src/sections/docs-registry.js";
import { allEndpoints, sectionModule } from "../../src/sections/registry.js";

const ROOT = join(import.meta.dir, "..", "..");
// Flattened for matching: the pages wrap sentences across lines.
const permissions = readFileSync(join(ROOT, "docs", "reference", "permissions.md"), "utf8").replace(
  /\s+/g,
  " ",
);

/** The token-UI labels of a section permission's Repository resources. */
function repoLabels(permission: SectionPermission): string[] {
  return permission.repo.map((resource) => RESOURCE_LABEL[resource]);
}

describe("branches Contents advice", () => {
  test("the branches Notes cell and permissions.md advise the branch probe's override grant", () => {
    // The advisory branch-existence probe carries a Contents permission
    // override (src/sections/branches/endpoints.ts), advised at the level the section
    // needs on that permission - the source both prose mentions restate. The
    // README row renders from the section's authored docs, pinned here at
    // their source.
    const probe = allEndpoints()["branches.branchProbe"];
    const override = probe?.permission;
    expect(override !== undefined && override !== "none").toBe(true);
    const label = repoLabels(override as SectionPermission).join(" or ");
    const level = overrideAdviceLevel(sectionModule("branches"), override as SectionPermission);
    const advice = `${label}: ${level}`;
    const notes = DOCS.branches.readme.notes;
    expect(
      notes.includes(`add ${advice}`),
      `the branches Notes cell (src/sections/branches/branches.docs.yml) must advise "add ${advice}" for the probe`,
    ).toBe(true);
    expect(notes).toContain("missing branch");
    // permissions.md restates the same advice as the Contents grant's second
    // job; the grant name, the section, and what the probe buys must match.
    expect(permissions).toContain(`The ${label} grant earns its keep twice`);
    expect(permissions).toContain(
      "it also lets `branches` tell a missing branch from an unprotected one in check mode",
    );
  });
});
