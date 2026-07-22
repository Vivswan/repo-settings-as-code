/**
 * Unit test for the endpoint-coverage tripwire's pure logic: attributing mock
 * requests to registered routes and computing cold routes against an injected
 * route set (so the test does not depend on the live endpoint count).
 */

import { describe, expect, test } from "bun:test";
import {
  coldRoutes,
  recordHits,
  registeredRoutes,
} from "../../.github/scripts/check-endpoint-coverage.js";
import type { LoggedRequest } from "../../test/e2e/mock/routes.js";

const ROUTES = [
  { key: "labels.list", method: "GET", path: "/repos/{owner}/{repo}/labels" },
  { key: "labels.create", method: "POST", path: "/repos/{owner}/{repo}/labels" },
  { key: "labels.update", method: "PATCH", path: "/repos/{owner}/{repo}/labels/{name}" },
  { key: "teams.org", method: "GET", path: "/orgs/{org}" },
];

function req(method: string, pathname: string): LoggedRequest {
  return { method, pathname, query: "", status: 200 };
}

describe("registeredRoutes", () => {
  test("splits each registered endpoint into key, method, and path template", () => {
    const routes = registeredRoutes();
    expect(routes.length).toBeGreaterThan(10);
    const labelsList = routes.find((r) => r.key === "labels.list");
    expect(labelsList?.method).toBe("GET");
    expect(labelsList?.path).toBe("/repos/{owner}/{repo}/labels");
  });
});

describe("recordHits", () => {
  test("attributes a concrete request to its route template", () => {
    const hit = new Set<string>();
    recordHits([req("GET", "/repos/o/r/labels")], ROUTES, hit);
    expect(hit).toEqual(new Set(["labels.list"]));
  });

  test("distinguishes method and path (POST vs GET, param vs collection)", () => {
    const hit = new Set<string>();
    recordHits(
      [req("POST", "/repos/o/r/labels"), req("PATCH", "/repos/o/r/labels/bug")],
      ROUTES,
      hit,
    );
    expect(hit).toEqual(new Set(["labels.create", "labels.update"]));
  });

  test("a request matching no route records nothing", () => {
    const hit = new Set<string>();
    recordHits([req("GET", "/repos/o/r/unknown")], ROUTES, hit);
    expect(hit.size).toBe(0);
  });

  test("accumulates across calls without double counting", () => {
    const hit = new Set<string>();
    recordHits([req("GET", "/repos/o/r/labels")], ROUTES, hit);
    recordHits([req("GET", "/repos/x/y/labels"), req("GET", "/orgs/acme")], ROUTES, hit);
    expect(hit).toEqual(new Set(["labels.list", "teams.org"]));
  });
});

describe("coldRoutes", () => {
  test("names every route no request reached, sorted by key", () => {
    const hit = new Set(["labels.list", "teams.org"]);
    expect(coldRoutes(hit, ROUTES)).toEqual(["labels.create", "labels.update"]);
  });

  test("returns empty when every route was hit", () => {
    expect(coldRoutes(new Set(ROUTES.map((r) => r.key)), ROUTES)).toEqual([]);
  });
});
