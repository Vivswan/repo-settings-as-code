import { describe, expect, test } from "bun:test";
import { labelsSection, normalizeColor } from "../../src/sections/labels.js";
import { MockApi } from "../mock-api.js";
import { ctx } from "./context.js";

describe("normalizeColor", () => {
  test("strips hash, lowercases", () => {
    expect(normalizeColor("#0366D6")).toBe("0366d6");
  });
});

describe("labels", () => {
  const liveLabels = [
    { name: "bug", color: "d73a4a", description: "Something isn't working" },
    { name: "stale", color: "ffffff", description: null },
  ];

  test("creates missing, updates drifted, deletes undeclared", async () => {
    const api = new MockApi({
      "GET /repos/o/r/labels?per_page=100&page=1": { data: liveLabels },
    });
    const result = await labelsSection.run(ctx(api), [
      { name: "bug", color: "#D73A4A", description: "Something isn't working" },
      { name: "enhancement", color: "a2eeef" },
    ]);
    expect(result.changes).toEqual([
      'created label "enhancement"',
      'DELETED undeclared label "stale"',
    ]);
    const mutations = api.mutations();
    expect(mutations.map((m) => `${m.method} ${m.path}`)).toEqual([
      "POST /repos/o/r/labels",
      "DELETE /repos/o/r/labels/stale",
    ]);
  });

  test("check mode reports drift without mutating", async () => {
    const api = new MockApi({
      "GET /repos/o/r/labels?per_page=100&page=1": { data: liveLabels },
    });
    const result = await labelsSection.run(ctx(api, true), [{ name: "bug", color: "000000" }]);
    expect(result.drift).toEqual([
      'labels[bug].color: declared "000000" != live "d73a4a"; apply will set the declared value',
      "labels[stale]: undeclared - not in the settings file, so apply will DELETE it; add it to the settings file to keep it",
    ]);
    expect(api.mutations()).toEqual([]);
  });

  test("url-encodes tricky names", async () => {
    const api = new MockApi({
      "GET /repos/o/r/labels?per_page=100&page=1": {
        data: [{ name: "autorelease: pending", color: "ededed", description: "x" }],
      },
    });
    await labelsSection.run(ctx(api), [
      { name: "autorelease: pending", color: "ffffff", description: "x" },
    ]);
    expect(api.mutations()[0]?.path).toBe("/repos/o/r/labels/autorelease%3A%20pending");
  });

  test("two entries renaming onto the same label are rejected before any API call", async () => {
    const api = new MockApi({});
    await expect(
      labelsSection.run(ctx(api), [
        { name: "bug", new_name: "triage" },
        { name: "enhancement", new_name: "Triage" },
      ]),
    ).rejects.toThrow(/cannot converge/);
    expect(api.calls).toHaveLength(0);
  });
});
