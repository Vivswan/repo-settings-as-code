/**
 * The curated e2e entrypoint: `bun test/e2e/run.ts`. Loads every scenario
 * under test/e2e/scenarios/, optionally filtered by --sections or --scenario,
 * runs each against a fresh mock, prints one line per scenario plus a final
 * table, and exits 1 if any scenario failed so CI gates on it.
 *
 * Flags:
 *   --sections a,b|all   run only scenarios that touch one of these sections
 *                        (a scenario touches a section when it is a top-level
 *                        key of the scenario's settings); default all
 *   --scenario <name>    run only the scenario with this exact name
 */

import { join } from "node:path";
import { runScenario } from "./runner.js";
import { loadScenarios, type Scenario } from "./schema.js";

const SCENARIO_DIR = join(import.meta.dir, "scenarios");

interface Flags {
  sections?: string[];
  scenario?: string;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--sections") {
      const value = argv[++i] ?? "";
      if (value && value !== "all") {
        flags.sections = value.split(",").map((s) => s.trim());
      }
    } else if (arg === "--scenario") {
      flags.scenario = argv[++i];
    }
  }
  return flags;
}

/**
 * Every section a scenario touches: the top-level `settings` keys plus each
 * multi-repo target's `repos.<slug>.settings` keys and the `defaults_file`
 * keys. A multi-repo scenario declares its sections per target, not at the top
 * level, so filtering on `settings` alone would drop it from a --sections run.
 */
function scenarioSections(scenario: Scenario): Set<string> {
  const keys = new Set<string>(Object.keys(scenario.settings ?? {}));
  for (const spec of Object.values(scenario.repos ?? {})) {
    if (spec.settings) {
      for (const key of Object.keys(spec.settings)) {
        keys.add(key);
      }
    }
  }
  for (const key of Object.keys(scenario.defaults_file ?? {})) {
    keys.add(key);
  }
  return keys;
}

/**
 * A scenario "touches" a section when that section appears in its settings, in
 * any multi-repo target's settings, or in its defaults file. --sections keeps
 * scenarios touching any listed section; --scenario matches an exact name.
 */
function selectScenarios(all: Scenario[], flags: Flags): Scenario[] {
  let selected = all;
  if (flags.scenario) {
    selected = selected.filter((s) => s.name === flags.scenario);
  }
  if (flags.sections) {
    const wanted = new Set(flags.sections);
    selected = selected.filter((s) => {
      for (const key of scenarioSections(s)) {
        if (wanted.has(key)) {
          return true;
        }
      }
      return false;
    });
  }
  return selected;
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));
  const scenarios = selectScenarios(loadScenarios(SCENARIO_DIR), flags);

  if (scenarios.length === 0) {
    // Before the corpus phase the scenarios dir is empty; land green so the
    // script itself is not a failure.
    console.log("no scenarios found");
    return 0;
  }

  const table: string[] = [];
  const artifacts: string[] = [];
  let failed = 0;
  for (const scenario of scenarios) {
    const started = Date.now();
    const report = await runScenario(scenario);
    const ms = Date.now() - started;
    if (report.ok) {
      console.log(`  PASS  ${scenario.name} (${ms}ms)`);
      table.push(`  PASS  ${scenario.name}`);
    } else {
      failed++;
      console.log(`  FAIL  ${scenario.name} (${ms}ms)`);
      table.push(`  FAIL  ${scenario.name}`);
      for (const failure of report.failures) {
        table.push(`          ${failure.replace(/\n/g, "\n          ")}`);
      }
      if (report.artifactDir) {
        artifacts.push(report.artifactDir);
      }
    }
  }

  console.log(`\n${table.join("\n")}`);
  console.log(`\n${scenarios.length - failed}/${scenarios.length} passed`);
  if (artifacts.length > 0) {
    console.log(`\nartifacts:\n  ${artifacts.join("\n  ")}`);
  }
  return failed > 0 ? 1 : 0;
}

try {
  process.exit(await main());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
