/**
 * CI structural contract: the single required check `all-green` must `needs:`
 * every other job in ci.yml. Branch protection points at all-green, so a new
 * job it forgets would pass CI while never being required. Parse ci.yml and
 * assert all-green's needs equal the set of all other job ids.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = join(import.meta.dir, "..", "..");

interface Workflow {
  jobs: Record<string, { needs?: string | string[] }>;
}

describe("ci.yml all-green gate", () => {
  const ci = parseYaml(
    readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8"),
  ) as Workflow;

  test("all-green needs every other job", () => {
    const jobs = Object.keys(ci.jobs);
    expect(jobs, "ci.yml has no all-green job").toContain("all-green");
    const others = jobs.filter((name) => name !== "all-green").sort();
    const rawNeeds = ci.jobs["all-green"]?.needs ?? [];
    const needs = (Array.isArray(rawNeeds) ? rawNeeds : [rawNeeds]).slice().sort();
    expect(
      needs,
      `all-green.needs must list every other job. Missing: [${others.filter((j) => !needs.includes(j)).join(", ")}], extra: [${needs.filter((n) => !others.includes(n)).join(", ")}]`,
    ).toEqual(others);
  });
});
