import { describe, expect, test } from "bun:test";
import { dedupeTargets, type Target } from "../../src/discovery/targets.js";

describe("dedupeTargets", () => {
  test("central wins over remote for the same repo, with a notice", () => {
    const central: Target[] = [
      { slug: "o/x", source: "central", origin: "repos/x.yml", filePath: "repos/x.yml" },
    ];
    const remote: Target[] = [
      { slug: "O/X", source: "remote", origin: 'the "repos" input' },
      { slug: "o/z", source: "remote", origin: 'the "repos" input' },
    ];
    const notices: string[] = [];
    const merged = dedupeTargets(central, remote, (m) => notices.push(m));
    expect(merged.map((t) => t.slug)).toEqual(["o/x", "o/z"]);
    expect(notices[0]).toContain("using the central file repos/x.yml");
  });
});
