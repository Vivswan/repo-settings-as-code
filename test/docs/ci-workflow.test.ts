/**
 * CI structural contract: the single required check `all-green` must `needs:`
 * every other job in ci.yml. Branch protection points at all-green, so a new
 * job it forgets would pass CI while never being required. Jobs that
 * themselves need all-green (the release job) are exempt: they run downstream
 * of the gate and cannot also be inside it. Informational jobs are exempt on
 * BOTH sides of the comparison: template sync flips ci.yml independently of
 * this test, so it must pass whether the job is still in the needs list or
 * already out of it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = join(import.meta.dir, "..", "..");

// Deliberately outside the gate: a red run flags template-convention drift
// that the next sync PR heals, and must not block unrelated merges. Mirrors
// repo-platform's validator (see its docs/all-green.md).
const INFORMATIONAL = new Set(["validate-template"]);

interface Workflow {
  jobs: Record<string, { needs?: string | string[] }>;
}

function needsOf(job: { needs?: string | string[] } | undefined): string[] {
  const raw = job?.needs ?? [];
  return Array.isArray(raw) ? raw : [raw];
}

describe("ci.yml all-green gate", () => {
  const ci = parseYaml(
    readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8"),
  ) as Workflow;

  test("all-green needs every job that is not downstream of it", () => {
    const jobs = Object.keys(ci.jobs);
    expect(jobs, "ci.yml has no all-green job").toContain("all-green");
    const downstream = jobs.filter((name) => needsOf(ci.jobs[name]).includes("all-green"));
    const others = jobs
      .filter(
        (name) => name !== "all-green" && !downstream.includes(name) && !INFORMATIONAL.has(name),
      )
      .sort();
    const needs = needsOf(ci.jobs["all-green"])
      .filter((name) => !INFORMATIONAL.has(name))
      .sort();
    expect(
      needs,
      `all-green.needs must list every job not downstream of it. Missing: [${others.filter((j) => !needs.includes(j)).join(", ")}], extra: [${needs.filter((n) => !others.includes(n)).join(", ")}]`,
    ).toEqual(others);
  });
});
