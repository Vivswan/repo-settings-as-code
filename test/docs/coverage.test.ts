/**
 * COVERAGE.md contract tests: the Supported table names every section, and the
 * Repo-scoped gaps table never lists an endpoint the action already
 * implements. The anti-test makes implementing a gap force its row to move out
 * of the gaps table.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SECTION_KEYS } from "../../src/schema.js";
import { endpointMethod, endpointPath, matchesTemplate } from "../../src/sections/contract.js";
import { allEndpoints } from "../../src/sections/registry.js";
import { sectionLines, tableRows } from "./markdown.js";

const ROOT = join(import.meta.dir, "..", "..");
const coverage = readFileSync(join(ROOT, "COVERAGE.md"), "utf8");

describe("COVERAGE Supported table", () => {
  const rows = tableRows(sectionLines(coverage, "Supported"));

  test("every section key appears in at least one Supported row", () => {
    const mentioned = rows.map((cells) => cells[1] ?? "").join(" ");
    for (const key of SECTION_KEYS) {
      expect(
        mentioned.includes(key),
        `COVERAGE Supported table never names the "${key}" section`,
      ).toBe(true);
    }
  });

  test("each section's declared endpoint path tails appear in its rows", () => {
    // For every registered endpoint, the section's Supported row(s) must name
    // the distinctive tail of its path, so the coverage doc cannot omit an
    // endpoint the code calls.
    const rowsByKey = new Map<string, string>();
    for (const cells of rows) {
      const section = cells[1] ?? "";
      const notes = cells[2] ?? "";
      const key = section.replace(/`/g, "").split(" ")[0] ?? "";
      rowsByKey.set(key, `${rowsByKey.get(key) ?? ""} ${notes}`);
    }
    for (const endpoint of Object.values(allEndpoints())) {
      const tail = endpointPath(endpoint.route)
        .replace("/repos/{owner}/{repo}", "")
        .replace(/\{[^}]+\}/g, "")
        .replace(/\/+$/g, "");
      if (tail === "" || tail === "/") {
        continue; // the bare repo endpoint has no distinctive tail
      }
      const notes = rowsByKey.get(endpoint.section) ?? "";
      const needle = tail.replace(/^\//, "").split("/")[0] ?? "";
      expect(
        notes.includes(needle),
        `COVERAGE Supported row for "${endpoint.section}" never mentions "${needle}" from endpoint ${endpoint.route}`,
      ).toBe(true);
    }
  });
});

describe("COVERAGE gaps anti-test", () => {
  /**
   * Turn a gap-table path template into a concrete-looking path by replacing
   * each {param} with a placeholder segment, so matchesTemplate (which matches
   * a registered TEMPLATE against a CONCRETE path) can decide whether a gap
   * endpoint collides with a route the action already calls.
   */
  function concretize(template: string): string {
    return template.replace(/\{[^}]+\}/g, "_param_");
  }

  test("no fully-spelled gap endpoint matches a registered EndpointDecl", () => {
    const routeTemplates = Object.values(allEndpoints()).map((e) => ({
      method: endpointMethod(e.route),
      path: endpointPath(e.route),
      route: e.route,
    }));
    const gapLines = sectionLines(coverage, "Repo-scoped gaps (not built yet)");
    // The gaps table spells combined verbs like "GET/POST /repos/..."; expand
    // each method against the following path.
    const methodPath =
      /\b((?:GET|POST|PUT|PATCH|DELETE)(?:\/(?:GET|POST|PUT|PATCH|DELETE))*)\s+(\/[^\s;()]+)/g;
    let found = 0;
    for (const line of gapLines) {
      for (const m of line.matchAll(methodPath)) {
        const methods = (m[1] ?? "").split("/");
        const gapPath = concretize(m[2] ?? "");
        for (const method of methods) {
          found++;
          for (const route of routeTemplates) {
            if (route.method === method && matchesTemplate(route.path, gapPath)) {
              throw new Error(
                `COVERAGE gap endpoint "${method} ${m[2]}" matches registered route "${route.route}"; a documented gap must not name an endpoint the action already calls`,
              );
            }
          }
        }
      }
    }
    expect(found, "the gaps parser matched no endpoints; the table format changed").toBeGreaterThan(
      10,
    );
  });
});
