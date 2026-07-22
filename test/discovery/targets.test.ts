import { describe, expect, test } from "bun:test";
import { dedupeTargets, type Target } from "../../src/discovery/targets.js";

describe("dedupeTargets", () => {
  const central: Target[] = [
    { slug: "o/x", source: "central", origin: "repos/x.yml", filePath: "repos/x.yml" },
  ];
  const remote: Target[] = [
    { slug: "O/X", source: "remote", origin: 'the "repos" input' },
    { slug: "o/z", source: "remote", origin: 'the "repos" input' },
  ];

  test("central wins over remote for the same repo, with a notice", () => {
    const notices: string[] = [];
    const merged = dedupeTargets(
      central,
      remote,
      (m) => notices.push(m),
      (slug) => slug,
    );
    expect(merged.map((t) => t.slug)).toEqual(["o/x", "o/z"]);
    expect(notices[0]).toContain("using the central file repos/x.yml");
  });

  test("the notice renders the slug through display; a non-redacted origin stays verbatim", () => {
    const notices: string[] = [];
    dedupeTargets(
      central,
      remote,
      (m) => notices.push(m),
      () => "private repository #1",
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toStartWith("private repository #1: using the central file repos/x.yml");
    expect(notices[0]).toContain('the entry for the same repository from the "repos" input');
    // no doubled article from wrapping the origin noun phrase
    expect(notices[0]).not.toContain("the the ");
    expect(notices[0]?.toLowerCase()).not.toContain("o/x");
  });

  test("a redacted target's central origin is rendered generically, never the file path", () => {
    // The central file path (repos/x.yml) can embed the real repo name, so for
    // a redacted target it must not appear next to the placeholder.
    const notices: string[] = [];
    dedupeTargets(
      [
        {
          slug: "o/secret",
          source: "central",
          origin: "repos/secret.yml",
          filePath: "repos/secret.yml",
        },
      ],
      [{ slug: "o/secret", source: "remote", origin: 'the "repos" input' }],
      (m) => notices.push(m),
      () => "private repository #1",
      () => true,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toStartWith(
      "private repository #1: using the central file a repos-dir file",
    );
    expect(notices[0]).not.toContain("repos/secret.yml");
    expect(notices[0]).not.toContain("secret");
  });
});
