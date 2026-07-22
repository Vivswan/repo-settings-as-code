import { describe, expect, test } from "bun:test";
import { createVisibilityResolver } from "../../src/github/repo-visibility.js";
import { MockApi } from "../mock-api.js";

describe("createVisibilityResolver", () => {
  test("the visibility field passes through for all three values", async () => {
    for (const visibility of ["public", "private", "internal"] as const) {
      const api = new MockApi({ "GET /repos/o/r": { data: { visibility } } });
      expect(await createVisibilityResolver(api)("o/r")).toBe(visibility);
    }
  });

  test("a missing visibility field falls back to the private flag", async () => {
    const priv = new MockApi({ "GET /repos/o/r": { data: { private: true } } });
    expect(await createVisibilityResolver(priv)("o/r")).toBe("private");
    const pub = new MockApi({ "GET /repos/o/r": { data: { private: false } } });
    expect(await createVisibilityResolver(pub)("o/r")).toBe("public");
  });

  test("any probe error fails closed to unknown", async () => {
    const api = new MockApi({
      "GET /repos/o/r": { error: { status: 403, message: "Resource not accessible", body: "" } },
    });
    expect(await createVisibilityResolver(api)("o/r")).toBe("unknown");
  });

  test("a 200 body with neither visibility nor private fails closed to unknown", async () => {
    const api = new MockApi({ "GET /repos/o/r": { data: { full_name: "o/r" } } });
    expect(await createVisibilityResolver(api)("o/r")).toBe("unknown");
  });

  test("private === true wins over a stale/forged visibility: public", async () => {
    // Fail closed: a body claiming visibility "public" but private true must
    // resolve private, never public.
    const api = new MockApi({
      "GET /repos/o/liar": { data: { visibility: "public", private: true } },
    });
    expect(await createVisibilityResolver(api)("o/liar")).toBe("private");
  });

  test("private === true with visibility internal stays internal", async () => {
    const api = new MockApi({
      "GET /repos/o/int": { data: { visibility: "internal", private: true } },
    });
    expect(await createVisibilityResolver(api)("o/int")).toBe("internal");
  });

  test("only an explicit private === false (or a real visibility) yields public", async () => {
    const api = new MockApi({ "GET /repos/o/pub": { data: { private: false } } });
    expect(await createVisibilityResolver(api)("o/pub")).toBe("public");
  });

  test("one probe per repository, case-insensitively, errors included", async () => {
    const api = new MockApi({
      "GET /repos/o/pub": { data: { visibility: "public" } },
      "GET /repos/o/gone": { error: { status: 404, message: "Not Found", body: "" } },
    });
    const resolve = createVisibilityResolver(api);
    expect(await resolve("o/pub")).toBe("public");
    expect(await resolve("O/Pub")).toBe("public");
    expect(await resolve("o/gone")).toBe("unknown");
    expect(await resolve("o/gone")).toBe("unknown");
    expect(api.calls.map((call) => call.path)).toEqual(["/repos/o/pub", "/repos/o/gone"]);
  });
});
