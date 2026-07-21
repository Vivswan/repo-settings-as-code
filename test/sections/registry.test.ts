import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SECTION_KEYS } from "../../src/schema.js";
import { SECTIONS } from "../../src/sections/registry.js";

describe("registry <-> README", () => {
  test("the README grant table lists every section, in order, naming each granted permission", () => {
    const readme = readFileSync("README.md", "utf8");
    const start = readme.indexOf("## Token permissions by section");
    expect(start).toBeGreaterThan(-1);
    const end = readme.indexOf("\n## ", start + 1);
    const section = end === -1 ? readme.slice(start) : readme.slice(start, end);

    const rows = [...section.matchAll(/^\| `([a-z_]+)` \| ([^|]+) \|/gm)].map((match) => ({
      key: match[1] ?? "",
      permission: match[2] ?? "",
    }));
    // One row per section, in SECTION_KEYS order - a new section without a
    // README row (or a stale row) fails here. The raw line count catches
    // malformed rows the key regex would otherwise skip silently.
    const tableLines = section.split("\n").filter((line) => line.startsWith("|"));
    expect(tableLines).toHaveLength(SECTION_KEYS.length + 2); // header + separator
    expect(rows.map((row) => row.key)).toEqual([...SECTION_KEYS]);

    // Every permission the grant advice names (the quoted words in
    // SectionMeta.grant) must appear in that section's README row, so the
    // table cannot drift from the advice users see in errors.
    for (const module of SECTIONS) {
      const row = rows.find((r) => r.key === module.key);
      const granted = [...module.grant.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
      expect(granted.length).toBeGreaterThan(0);
      for (const name of granted) {
        expect(row?.permission).toContain(name);
      }
    }
  });
});
