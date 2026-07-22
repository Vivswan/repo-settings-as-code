import { describe, expect, test } from "bun:test";
import { capturingIo, planRedaction } from "../../src/action/redact.js";
import type { Io } from "../../src/io.js";
import { prefixedIo } from "../../src/io.js";

/** A private-set predicate from a lowercase-keyed slug list. */
function privateSet(...slugs: string[]): (slug: string) => boolean {
  const set = new Set(slugs.map((s) => s.toLowerCase()));
  return (slug) => set.has(slug.toLowerCase());
}

describe("planRedaction", () => {
  test("numbers redacted targets 1-based in target order, keyed lowercase", () => {
    const plan = planRedaction(
      ["o/pub", "o/PrivA", "o/pub2", "o/privB"],
      [],
      privateSet("o/priva", "o/privb"),
      "admin/repo",
    );
    expect(plan.isRedacted("o/pub")).toBe(false);
    expect(plan.display("o/pub")).toBe("o/pub");
    expect(plan.isRedacted("o/PrivA")).toBe(true);
    expect(plan.display("o/PrivA")).toBe("private repository #1");
    expect(plan.isRedacted("o/privB")).toBe(true);
    expect(plan.display("o/privB")).toBe("private repository #2");
    // case-insensitive lookup finds the same placeholder
    expect(plan.display("O/PRIVA")).toBe("private repository #1");
  });

  test("a central and remote entry for the same slug share one placeholder", () => {
    const plan = planRedaction(["o/priv", "o/PRIV"], [], privateSet("o/priv"), "admin/repo");
    expect(plan.display("o/priv")).toBe("private repository #1");
    expect(plan.display("o/PRIV")).toBe("private repository #1");
    expect(plan.maskedSlugs).toEqual(["o/priv"]);
  });

  test("the self slug is never redacted (carve-out, case-insensitive)", () => {
    const plan = planRedaction(
      ["Admin/Repo", "o/priv"],
      [],
      privateSet("admin/repo", "o/priv"),
      "admin/repo",
    );
    expect(plan.isRedacted("Admin/Repo")).toBe(false);
    expect(plan.display("Admin/Repo")).toBe("Admin/Repo");
    // the private non-self target still gets #1, not #2
    expect(plan.display("o/priv")).toBe("private repository #1");
    expect(plan.maskedSlugs).toEqual(["o/priv"]);
  });

  test("public targets are neither redacted nor masked", () => {
    const plan = planRedaction(["o/a", "o/b"], [], privateSet(), "admin/repo");
    expect(plan.isRedacted("o/a")).toBe(false);
    expect(plan.maskedSlugs).toEqual([]);
  });

  test("discovery-filtered privates are masked but get no placeholder", () => {
    const plan = planRedaction(
      ["o/priv"],
      ["o/filtered", "o/PRIV"],
      privateSet("o/priv"),
      "admin/repo",
    );
    // filtered slug is masked
    expect(plan.maskedSlugs).toContain("o/filtered");
    expect(plan.maskedSlugs).toContain("o/priv");
    // but never placeholdered
    expect(plan.isRedacted("o/filtered")).toBe(false);
    expect(plan.display("o/filtered")).toBe("o/filtered");
    // the target already masked is not duplicated by the extra list
    expect(plan.maskedSlugs.filter((s) => s.toLowerCase() === "o/priv")).toHaveLength(1);
  });

  test("the self slug is excluded from the masked set even as an extra private", () => {
    const plan = planRedaction([], ["admin/repo"], privateSet("admin/repo"), "admin/repo");
    expect(plan.maskedSlugs).toEqual([]);
  });
});

describe("capturingIo", () => {
  test("suppresses public annotate/log but records them in order", () => {
    const emitted: string[] = [];
    const base: Io = {
      annotate: (level, message) => emitted.push(`annotate ${level}: ${message}`),
      log: (line) => emitted.push(`log: ${line}`),
      mask: () => {},
    };
    const { io, drain } = capturingIo(base);
    io.log("first");
    io.annotate("warning", "second");
    io.log("third");
    expect(emitted).toEqual([]);
    expect(drain()).toEqual([
      { kind: "log", line: "first" },
      { kind: "annotate", level: "warning", line: "second" },
      { kind: "log", line: "third" },
    ]);
  });

  test("mask passes through to the base sink", () => {
    const masks: string[] = [];
    const base: Io = { annotate: () => {}, log: () => {}, mask: (v) => masks.push(v) };
    const { io } = capturingIo(base);
    io.mask("o/secret");
    expect(masks).toEqual(["o/secret"]);
  });

  test("composes as capturingIo(prefixedIo(io, display)): capture is per-target, mask stays raw", () => {
    // The plan wraps prefixedIo INSIDE capturingIo. capturingIo suppresses the
    // wrapped sink's emission entirely, so the prefix never reaches the base;
    // each target owns its own capture buffer, so the recorded lines need no
    // prefix to be attributable. mask still passes through to the base.
    const masks: string[] = [];
    const emitted: string[] = [];
    const base: Io = {
      annotate: (l, m) => emitted.push(`${l}: ${m}`),
      log: (line) => emitted.push(line),
      mask: (v) => masks.push(v),
    };
    const { io, drain } = capturingIo(prefixedIo(base, "private repository #1: "));
    io.log("changed a label");
    io.mask("o/secret");
    expect(emitted).toEqual([]);
    expect(drain()).toEqual([{ kind: "log", line: "changed a label" }]);
    expect(masks).toEqual(["o/secret"]);
  });
});

describe("prefixedIo mask", () => {
  test("empty prefix returns the sink unchanged, mask included", () => {
    const base: Io = { annotate: () => {}, log: () => {}, mask: () => {} };
    expect(prefixedIo(base, "")).toBe(base);
  });

  test("non-empty prefix leaves mask values unprefixed", () => {
    const masks: string[] = [];
    const base: Io = { annotate: () => {}, log: () => {}, mask: (v) => masks.push(v) };
    prefixedIo(base, "x/y: ").mask("o/secret");
    expect(masks).toEqual(["o/secret"]);
  });
});
