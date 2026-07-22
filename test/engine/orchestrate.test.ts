import { describe, expect, test } from "bun:test";

import { runForRepo, validateSettingsDoc, worstOf } from "../../src/engine/orchestrate.js";
import type { Io } from "../../src/io.js";
import { prefixedIo } from "../../src/io.js";
import type { SettingsFile } from "../../src/schema.js";
import { MockApi } from "../mock-api.js";

function captureIo(): { io: Io; annotations: string[]; logs: string[] } {
  const annotations: string[] = [];
  const logs: string[] = [];
  return {
    io: {
      annotate: (level, message) => annotations.push(`${level}: ${message}`),
      log: (line) => logs.push(line),
    },
    annotations,
    logs,
  };
}

function opts(overrides: Partial<Parameters<typeof runForRepo>[1]> = {}) {
  return {
    repo: "o/r",
    settings: { repository: { has_wiki: false } } as SettingsFile,
    mode: "apply" as const,
    onMissingPermission: "fail" as const,
    requiredSections: new Set<string>(),
    onlySections: new Set<string>(),
    ...overrides,
  };
}

describe("runForRepo", () => {
  test("preflight denial fails with zero mutations", async () => {
    const api = new MockApi({
      "GET /repos/o/r": { error: { status: 403, message: "Forbidden", body: "" } },
    });
    const { io, annotations } = captureIo();
    const result = await runForRepo(api, opts(), io);
    expect(result.result).toBe("failed");
    expect(result.preflightDenied).toHaveLength(1);
    expect(api.mutations()).toHaveLength(0);
    expect(annotations[0]).toContain("preflight: repository:");
  });

  test("warn policy skips the denied section and reports partial", async () => {
    const api = new MockApi({
      "PATCH /repos/o/r": { error: { status: 403, message: "Forbidden", body: "" } },
    });
    const { io, annotations } = captureIo();
    const result = await runForRepo(api, opts({ onMissingPermission: "warn" }), io);
    expect(result.result).toBe("partial");
    expect(result.skippedSections).toEqual(["repository"]);
    expect(annotations.some((a) => a.startsWith("warning: repository: skipped"))).toBe(true);
  });

  test("check mode reports drift, prefixed through prefixedIo", async () => {
    const api = new MockApi({
      "GET /repos/o/r": { data: { has_wiki: true } },
    });
    const { io, logs } = captureIo();
    const result = await runForRepo(api, opts({ mode: "check" }), prefixedIo(io, "o/r: "));
    expect(result.result).toBe("drift");
    expect(logs[0]).toStartWith("o/r: drift: repository.has_wiki");
  });

  test("pages: null is an active section, not an omitted one", async () => {
    const api = new MockApi({
      "GET /repos/o/r/pages": { data: { build_type: "legacy" } },
    });
    const { io } = captureIo();
    const result = await runForRepo(
      api,
      opts({ mode: "check", settings: { pages: null } as SettingsFile }),
      io,
    );
    expect(result.result).toBe("drift");
    expect(result.outcomes.map((o) => o.key)).toEqual(["pages"]);
  });
});

describe("validateSettingsDoc", () => {
  test("unknown top-level keys are errors naming the source", () => {
    const { io } = captureIo();
    const err = validateSettingsDoc({ labls: [] }, "repos/x.yml", new Set(), io);
    expect(err).toContain("repos/x.yml");
    expect(err).toContain("labls");
  });

  test("non-mapping documents are rejected", () => {
    const { io } = captureIo();
    expect(validateSettingsDoc([], "f.yml", new Set(), io)).toContain("a list");
  });
});

describe("worstOf", () => {
  test("failed outranks everything; clean is the floor in check mode", () => {
    expect(worstOf([{ result: "clean" }, { result: "failed" }, { result: "drift" }], true)).toBe(
      "failed",
    );
    expect(worstOf([{ result: "clean" }, { result: "drift" }], true)).toBe("drift");
    expect(worstOf([], true)).toBe("clean");
    expect(worstOf([], false)).toBe("applied");
  });
});
