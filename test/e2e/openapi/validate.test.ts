/**
 * Unit tests for the OpenAPI validator, run under the normal `bun test` suite.
 * They exercise the validator directly against the fetched trimmed spec with
 * hand-built LoggedRequest objects (no server, no subprocess), so the schema
 * preprocessing, path/method matching, body checks, and the denial/violation
 * exclusions are pinned without depending on the mock's runtime.
 */

import { describe, expect, test } from "bun:test";
import type { LoggedRequest } from "../mock/routes.js";
import { USED_PATHS } from "./paths.js";
import {
  OpenApiValidator,
  pathMatches,
  sharedValidator,
  toJsonSchema,
  validateExchange,
} from "./validate.js";

/** A LoggedRequest with sane defaults; each test overrides what it exercises. */
function req(overrides: Partial<LoggedRequest>): LoggedRequest {
  return { method: "GET", pathname: "/", query: "", status: 200, ...overrides };
}

describe("toJsonSchema", () => {
  test("folds nullable:true into a type array", () => {
    expect(toJsonSchema({ type: "string", nullable: true })).toEqual({ type: ["string", "null"] });
  });

  test("appends null to an existing type array without duplicating", () => {
    expect(toJsonSchema({ type: ["string", "number"], nullable: true })).toEqual({
      type: ["string", "number", "null"],
    });
    expect(toJsonSchema({ type: ["string", "null"], nullable: true })).toEqual({
      type: ["string", "null"],
    });
  });

  test("nullable without a type is dropped, not turned into a bare null type", () => {
    // No `type` to extend, so nullable simply disappears (ajv treats a
    // type-less schema as accept-anything, which is the safe reading).
    expect(toJsonSchema({ nullable: true, description: "x" })).toEqual({ description: "x" });
  });

  test("strips required from a response schema (presence relaxed) by default", () => {
    expect(
      toJsonSchema({ type: "object", required: ["id"], properties: { id: { type: "integer" } } }),
    ).toEqual({
      type: "object",
      properties: { id: { type: "integer" } },
    });
  });

  test("keeps required when keepRequired is set (request-body variant)", () => {
    expect(
      toJsonSchema(
        { type: "object", required: ["id"], properties: { id: { type: "integer" } } },
        true,
      ),
    ).toEqual({
      type: "object",
      required: ["id"],
      properties: { id: { type: "integer" } },
    });
  });

  test("strips annotation-only keywords ajv would choke on", () => {
    const input = {
      type: "object",
      example: { a: 1 },
      examples: [1, 2],
      xml: { name: "thing" },
      discriminator: { propertyName: "kind" },
      properties: { a: { type: "integer", example: 5 } },
    };
    expect(toJsonSchema(input)).toEqual({
      type: "object",
      properties: { a: { type: "integer" } },
    });
  });

  test("recurses through arrays and nested objects", () => {
    const input = {
      allOf: [
        { type: "string", nullable: true },
        { type: "object", example: {} },
      ],
    };
    expect(toJsonSchema(input)).toEqual({
      allOf: [{ type: ["string", "null"] }, { type: "object" }],
    });
  });

  test("leaves primitives untouched", () => {
    expect(toJsonSchema("s")).toBe("s");
    expect(toJsonSchema(3)).toBe(3);
    expect(toJsonSchema(null)).toBe(null);
  });

  test("relaxed variant rewrites oneOf to anyOf (widened branches may overlap)", () => {
    const input = {
      oneOf: [
        { type: "object", required: ["a"], properties: { a: { type: "string" } } },
        { type: "object", required: ["b"], properties: { b: { type: "string" } } },
      ],
    };
    // Response variant (keepRequired false): oneOf -> anyOf, required stripped.
    expect(toJsonSchema(input)).toEqual({
      anyOf: [
        { type: "object", properties: { a: { type: "string" } } },
        { type: "object", properties: { b: { type: "string" } } },
      ],
    });
    // Request variant (keepRequired true): oneOf and required both preserved.
    expect(toJsonSchema(input, true)).toEqual(input);
  });

  test("a widened oneOf that would fail exactly-one passes as anyOf end to end", () => {
    // A value matching BOTH branches fails oneOf (exactly-one) but passes the
    // relaxed anyOf. Drive it through a real OpenApiValidator over a tiny spec
    // (public API, no internals): a GET whose 200 schema is a oneOf.
    const spec = {
      paths: {
        "/repos/{owner}/{repo}/thing": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: {
                      oneOf: [
                        { type: "object", required: ["a"], properties: { a: { type: "string" } } },
                        { type: "object", required: ["b"], properties: { b: { type: "string" } } },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const v = new OpenApiValidator(spec as never);
    const violations = v.validateRequest({
      method: "GET",
      pathname: "/repos/o/r/thing",
      query: "",
      status: 200,
      responseBody: { a: "x", b: "y" }, // matches both branches
    });
    expect(violations).toEqual([]);
  });

  test("the relaxed oneOf still accepts data matching exactly ONE original branch", () => {
    // The GitHub-shaped case B2 named: a oneOf of [Simple User (required
    // fields), Empty Object]. Under raw oneOf, {} matches only the Empty Object
    // branch. Stripping Simple User's required fields would make {} match BOTH
    // branches and oneOf reject valid data; anyOf keeps it accepted. This is the
    // regression that proves relaxation does not break the common valid case.
    const spec = {
      paths: {
        "/repos/{owner}/{repo}/thing": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: {
                      oneOf: [
                        {
                          type: "object",
                          required: ["login", "id"],
                          properties: { login: { type: "string" }, id: { type: "integer" } },
                        },
                        { type: "object", properties: {}, additionalProperties: false },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const v = new OpenApiValidator(spec as never);
    // {} matched exactly the Empty Object branch originally; must still pass.
    expect(
      v.validateRequest({
        method: "GET",
        pathname: "/repos/o/r/thing",
        query: "",
        status: 200,
        responseBody: {},
      }),
    ).toEqual([]);
    // A well-formed Simple User (matched exactly branch 1 originally) also passes.
    expect(
      v.validateRequest({
        method: "GET",
        pathname: "/repos/o/r/thing",
        query: "",
        status: 200,
        responseBody: { login: "octocat", id: 1 },
      }),
    ).toEqual([]);
  });
});

describe("pathMatches greedy contents param", () => {
  const contents = "/repos/{owner}/{repo}/contents/{path}";

  test("{path} absorbs a multi-segment file path", () => {
    expect(pathMatches(contents, "/repos/o/r/contents/.github/settings.yml")).toBe(true);
    expect(pathMatches(contents, "/repos/o/r/contents/README.md")).toBe(true);
  });

  test("{path} requires at least one trailing segment", () => {
    expect(pathMatches(contents, "/repos/o/r/contents")).toBe(false);
  });

  test("a non-contents template still matches one segment per param", () => {
    expect(pathMatches("/repos/{owner}/{repo}/labels/{name}", "/repos/o/r/labels/bug")).toBe(true);
    // A stray extra segment must NOT match a single-segment param.
    expect(pathMatches("/repos/{owner}/{repo}/labels/{name}", "/repos/o/r/labels/bug/extra")).toBe(
      false,
    );
  });
});

describe("OpenApiValidator against the fetched spec", () => {
  const v = sharedValidator();

  test("the fetched spec loads and shares one instance", () => {
    expect(v).toBeInstanceOf(OpenApiValidator);
    expect(sharedValidator()).toBe(v); // process-wide singleton
  });

  test("a real repository GET with a plausible body passes", () => {
    const violations = v.validateRequest(
      req({
        method: "GET",
        pathname: "/repos/e2e-owner/e2e-repo",
        status: 200,
        responseBody: {
          id: 1,
          node_id: "abc",
          name: "e2e-repo",
          full_name: "e2e-owner/e2e-repo",
          private: false,
          owner: { login: "e2e-owner", id: 2 },
        },
      }),
    );
    // The full repo schema has many required fields; assert the PATH matched
    // (no unknown-route violation), which is the routing contract under test.
    expect(violations.filter((x) => x.kind === "unknown-route")).toEqual([]);
  });

  test("a path the spec does not document is an unknown-route violation", () => {
    const violations = v.validateRequest(
      req({
        method: "GET",
        pathname: "/repos/e2e-owner/e2e-repo/not-a-real-endpoint",
        status: 200,
      }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe("unknown-route");
  });

  test("a method the spec does not document on a known path is a violation", () => {
    // DELETE /repos/{owner}/{repo}/labels is not a documented operation.
    const violations = v.validateRequest(
      req({ method: "DELETE", pathname: "/repos/e2e-owner/e2e-repo/labels", status: 204 }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe("unknown-route");
  });

  test("a valid label create body passes request-body validation", () => {
    const violations = v.validateRequest(
      req({
        method: "POST",
        pathname: "/repos/e2e-owner/e2e-repo/labels",
        status: 201,
        body: { name: "bug", color: "d73a4a", description: "Something isn't working" },
        responseBody: {
          id: 1,
          node_id: "n",
          url: "https://api.github.com/repos/e2e-owner/e2e-repo/labels/bug",
          name: "bug",
          color: "d73a4a",
          default: false,
          description: "Something isn't working",
        },
      }),
    );
    expect(violations).toEqual([]);
  });

  test("a body with a wrong-typed field is a request-body violation", () => {
    // color must be a string per the spec; a number is a real shape drift the
    // validator still catches (unlike a merely-absent required field).
    const violations = v.validateRequest(
      req({
        method: "POST",
        pathname: "/repos/e2e-owner/e2e-repo/labels",
        status: 201,
        body: { name: "bug", color: 123 },
      }),
    );
    expect(violations.some((x) => x.kind === "request-body")).toBe(true);
  });

  test("a request body missing a required field IS a violation (presence enforced)", () => {
    // The labels-create requestBody requires `name`; a body without it is a
    // real mock/client bug the request-body variant catches.
    const violations = v.validateRequest(
      req({
        method: "POST",
        pathname: "/repos/e2e-owner/e2e-repo/labels",
        status: 201,
        body: { color: "d73a4a" }, // no name
      }),
    );
    expect(violations.some((x) => x.kind === "request-body")).toBe(true);
  });

  test("a PRIMITIVE request body where an object is documented IS a violation", () => {
    // labels-create documents an object body; a bare string must not be waved
    // through (the fail-open the object-only guard used to allow).
    const violations = v.validateRequest(
      req({
        method: "POST",
        pathname: "/repos/e2e-owner/e2e-repo/labels",
        status: 201,
        body: "just a string",
      }),
    );
    expect(violations.some((x) => x.kind === "request-body")).toBe(true);
  });

  test("a required request body sent as none IS a violation", () => {
    // labels-create marks requestBody.required true; omitting it entirely is a
    // contract break, distinct from sending an incomplete object.
    const violations = v.validateRequest(
      req({ method: "POST", pathname: "/repos/e2e-owner/e2e-repo/labels", status: 201 }),
    );
    expect(violations.some((x) => x.kind === "request-body" && x.detail.includes("required"))).toBe(
      true,
    );
  });

  test("a JSON body sent to an op that documents NO request body IS a violation", () => {
    // DELETE label documents no requestBody; a JSON value there is not accepted
    // by GitHub, so it must not fail open.
    const violations = v.validateRequest(
      req({
        method: "DELETE",
        pathname: "/repos/e2e-owner/e2e-repo/labels/bug",
        status: 204,
        body: { unexpected: true },
      }),
    );
    expect(
      violations.some((x) => x.kind === "request-body" && x.detail.includes("no request body")),
    ).toBe(true);
  });

  test("a body on a documented no-content (204) success response IS a violation", () => {
    // DELETE label documents a 204 with no content; a non-null body there means
    // the mock returns something GitHub does not.
    const violations = v.validateRequest(
      req({
        method: "DELETE",
        pathname: "/repos/e2e-owner/e2e-repo/labels/bug",
        status: 204,
        responseBody: { message: "deleted" },
      }),
    );
    expect(
      violations.some(
        (x) => x.kind === "response-body" && x.detail.includes("no response content"),
      ),
    ).toBe(true);
  });

  test("a null body on a 204 is fine (the correct empty response)", () => {
    const violations = v.validateRequest(
      req({
        method: "DELETE",
        pathname: "/repos/e2e-owner/e2e-repo/labels/bug",
        status: 204,
        responseBody: null,
      }),
    );
    expect(violations).toEqual([]);
  });

  test("a RESPONSE body merely missing a documented field is NOT a violation (presence relaxed)", () => {
    // The mock may serve only the subset of response fields the action reads;
    // presence is relaxed for responses, only the shape of what is sent checked.
    const violations = v.validateRequest(
      req({
        method: "POST",
        pathname: "/repos/e2e-owner/e2e-repo/labels",
        status: 201,
        body: { name: "bug" },
        responseBody: { name: "bug", color: "d73a4a" },
      }),
    );
    expect(violations).toEqual([]);
  });

  test("an undocumented 2xx status IS a response-body violation", () => {
    // GitHub documents its success statuses. PUT environments returns 200 even
    // on create (spec lists 200/422), so a 201 here means the EndpointDecl or
    // mock serves a status GitHub does not - a real bug the validator catches.
    const violations = v.validateRequest(
      req({
        method: "PUT",
        pathname: "/repos/e2e-owner/e2e-repo/environments/production",
        status: 201,
        body: { wait_timer: 5 },
        responseBody: { id: 1, name: "production" },
      }),
    );
    expect(violations.some((x) => x.kind === "response-body" && x.detail.includes("201"))).toBe(
      true,
    );
  });

  test("an undocumented 2xx status with NO body is still a violation", () => {
    // Status validation must not hide behind body presence.
    const violations = v.validateRequest(
      req({
        method: "PUT",
        pathname: "/repos/e2e-owner/e2e-repo/environments/production",
        status: 201,
      }),
    );
    expect(violations.some((x) => x.kind === "response-body" && x.detail.includes("201"))).toBe(
      true,
    );
  });

  test("an undocumented status >= 400 is accepted silently (spec omits most errors)", () => {
    // GitHub's spec rarely documents 404s; the mock's absent-probe 404s and 409
    // conflicts are realistic. A GET environments 404 (spec lists only 200) is
    // accepted, not flagged.
    const violations = v.validateRequest(
      req({
        method: "GET",
        pathname: "/repos/e2e-owner/e2e-repo/environments/production",
        status: 404,
        responseBody: { message: "Not Found" },
      }),
    );
    expect(violations).toEqual([]);
  });

  test("a documented status is still validated: GET environments 200 passes", () => {
    const violations = v.validateRequest(
      req({
        method: "GET",
        pathname: "/repos/e2e-owner/e2e-repo/environments/production",
        status: 200,
        responseBody: { id: 1, name: "production" },
      }),
    );
    expect(violations).toEqual([]);
  });

  test("a primitive response body where an object is documented IS a violation", () => {
    // A wrong_shape-style scalar (42) served against a JSON object endpoint is
    // caught now that primitives are validated, not skipped.
    const violations = v.validateRequest(
      req({ method: "GET", pathname: "/repos/e2e-owner/e2e-repo", status: 200, responseBody: 42 }),
    );
    expect(violations.some((x) => x.kind === "response-body")).toBe(true);
  });

  test("an offSpec response (raw media / synthetic fault) is excluded entirely", () => {
    // A rate-limit 403 fault: status is undocumented AND body is off-spec, but
    // offSpec makes the validator skip status and body both.
    const violations = v.validateRequest(
      req({
        method: "GET",
        pathname: "/repos/e2e-owner/e2e-repo/labels",
        status: 403,
        offSpec: true,
      }),
    );
    expect(violations).toEqual([]);
  });

  test("a non-HTTP status sentinel (0, connection drop) is excluded", () => {
    const violations = v.validateRequest(
      req({ method: "GET", pathname: "/repos/e2e-owner/e2e-repo/labels", status: 0 }),
    );
    expect(violations).toEqual([]);
  });

  test("a denied request (deniedBy set) is excluded from validation", () => {
    const violations = v.validateRequest(
      req({
        method: "POST",
        pathname: "/repos/e2e-owner/e2e-repo/labels",
        status: 403,
        deniedBy: "issues",
        responseBody: { message: "Resource not accessible by personal access token" },
      }),
    );
    expect(violations).toEqual([]);
  });

  test("a mock VIOLATION 400 is excluded from validation", () => {
    const violations = v.validateRequest(
      req({
        method: "GET",
        pathname: "/user/repos",
        status: 400,
        responseBody: { message: "E2E MOCK VIOLATION: something broke" },
      }),
    );
    expect(violations).toEqual([]);
  });

  test("validateLog flattens violations across many requests", () => {
    const log: LoggedRequest[] = [
      req({ method: "GET", pathname: "/repos/e2e-owner/e2e-repo", status: 200 }),
      req({ method: "GET", pathname: "/totally/unknown", status: 200 }),
    ];
    const violations = v.validateLog(log);
    expect(violations.some((x) => x.kind === "unknown-route")).toBe(true);
  });
});

describe("the fetched trimmed spec", () => {
  test("contains exactly the USED_PATHS paths (no more, no fewer)", () => {
    // Read through the loaded validator (not a static JSON import) so a missing
    // spec surfaces the actionable fetch error from load(), not a cryptic
    // module-resolution failure.
    const specPaths = [...sharedValidator().paths()].sort();
    expect(specPaths).toEqual([...USED_PATHS].sort());
  });

  test("a missing spec throws a loud, actionable fetch error naming the script", () => {
    // The spec is a gitignored, fetched artifact: a fresh clone lacks it, and
    // validation must fail loudly with the exact command, never skip silently.
    expect(() => OpenApiValidator.loadFrom("/nonexistent/github-openapi.trimmed.json")).toThrow(
      /bun \.github\/scripts\/trim-openapi\.ts/,
    );
  });
});

describe("validateExchange adapter", () => {
  test("returns string errors for a wrong-shaped response", () => {
    const errors = validateExchange(
      { method: "GET", pathname: "/repos/e2e-owner/e2e-repo", query: "", status: 200 },
      42, // scalar where the repo object is documented
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("[response-body]");
  });

  test("returns errors for a misspelled request field", () => {
    // colour (British spelling) is not a documented label field, but the schema
    // also requires `name`; sending only the misspelled field trips required.
    const errors = validateExchange(
      {
        method: "POST",
        pathname: "/repos/e2e-owner/e2e-repo/labels",
        query: "",
        status: 201,
        body: { colour: "d73a4a" },
      },
      { id: 1 },
    );
    expect(errors.some((e) => e.includes("[request-body]"))).toBe(true);
  });

  test("returns no errors for a valid exchange", () => {
    const errors = validateExchange(
      {
        method: "POST",
        pathname: "/repos/e2e-owner/e2e-repo/labels",
        query: "",
        status: 201,
        body: { name: "bug", color: "d73a4a" },
      },
      { name: "bug", color: "d73a4a" },
    );
    expect(errors).toEqual([]);
  });

  test("an explicit null responseBody OVERRIDES the request's own field, not falls through", () => {
    // A DELETE label 204 whose log carries a stale non-null responseBody, but
    // the caller passes explicit null (the real empty body). With `??` the null
    // would fall through to the stale object and wrongly flag a no-content
    // violation; the sentinel makes the explicit null win, so no error.
    const errors = validateExchange(
      {
        method: "DELETE",
        pathname: "/repos/e2e-owner/e2e-repo/labels/bug",
        query: "",
        status: 204,
        responseBody: { message: "stale" },
      },
      null,
    );
    expect(errors).toEqual([]);
  });

  test("omitting responseBody falls back to the request's own field", () => {
    // No second argument: the request's responseBody (a scalar 42 against the
    // repo object) is used and flagged.
    const errors = validateExchange({
      method: "GET",
      pathname: "/repos/e2e-owner/e2e-repo",
      query: "",
      status: 200,
      responseBody: 42,
    });
    expect(errors.some((e) => e.includes("[response-body]"))).toBe(true);
  });

  test("passing explicit undefined behaves like omitting (falls back)", () => {
    // undefined is the sentinel default, so it is indistinguishable from omitted
    // and falls back to the request's own responseBody.
    const errors = validateExchange(
      {
        method: "GET",
        pathname: "/repos/e2e-owner/e2e-repo",
        query: "",
        status: 200,
        responseBody: 42,
      },
      undefined,
    );
    expect(errors.some((e) => e.includes("[response-body]"))).toBe(true);
  });
});
