import { describe, expect, test } from "bun:test";
import { paginate } from "../../src/github/paginate.js";
import { MockApi } from "../mock-api.js";

const fullPage = (prefix: string) => Array.from({ length: 100 }, (_, i) => `${prefix}${i}`);

describe("paginate", () => {
  test("walks pages until a short one and concatenates the items", async () => {
    const api = new MockApi({
      "GET /things?per_page=100&page=1": { data: fullPage("a") },
      "GET /things?per_page=100&page=2": { data: ["b0", "b1"] },
    });
    const result = await paginate(api, "/things");
    expect(result).toEqual({ items: [...fullPage("a"), "b0", "b1"] });
    expect(api.calls).toHaveLength(2);
  });

  test("stop ends the walk early with the items collected so far", async () => {
    const api = new MockApi({
      "GET /things?per_page=100&page=1": { data: fullPage("a") },
      "GET /things?per_page=100&page=2": { data: fullPage("b") },
    });
    const result = await paginate(api, "/things", undefined, (items) => items.includes("a5"));
    expect(result).toEqual({ items: fullPage("a") });
    expect(api.calls).toHaveLength(1);
  });

  test("a stop that never fires leaves paging behavior unchanged", async () => {
    const api = new MockApi({
      "GET /things?per_page=100&page=1": { data: fullPage("a") },
      "GET /things?per_page=100&page=2": { data: ["b0"] },
    });
    const result = await paginate(api, "/things", undefined, () => false);
    expect(result).toEqual({ items: [...fullPage("a"), "b0"] });
    expect(api.calls).toHaveLength(2);
  });

  test("an existing query string keeps its params and gains the page ones", async () => {
    const api = new MockApi({
      "GET /things?state=all&per_page=100&page=1": { data: ["only"] },
    });
    const result = await paginate(api, "/things?state=all");
    expect(result).toEqual({ items: ["only"] });
  });

  test("errors surface as values", async () => {
    const api = new MockApi({
      "GET /things?per_page=100&page=1": {
        error: { status: 403, message: "Forbidden", body: "" },
      },
    });
    const result = await paginate(api, "/things");
    expect(result).toEqual({ error: { status: 403, message: "Forbidden", body: "" } });
  });

  test("a non-list page is malformed", async () => {
    const api = new MockApi({
      "GET /things?per_page=100&page=1": { data: { not: "a list" } },
    });
    const result = await paginate(api, "/things");
    expect(result).toEqual({ malformed: true });
  });
});
