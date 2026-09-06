/**
 * agents_variables section tests: this section is one repoVariablesSection()
 * factory call, and the factory/engine behavior (reconciliation verbs,
 * case-insensitive matching, the undeclared knob, pagination, phantom keys)
 * is pinned by the actions_variables suite. These tests pin what is THIS
 * section's own: its routes, its "Copilot agents variable" noun, and its
 * delete-by-default posture.
 */

import { describe, expect, test } from "bun:test";
import { executePlan } from "../../../src/engine/execute.js";
import { MockApi } from "../../../test/mock-api.js";
import { REPO } from "../../../test/sections/section-run.js";
import { planContext } from "../contract/plan.js";
import { agentsVariablesSection } from "./index.js";

describe("agents_variables", () => {
  const listRoute = {
    "GET /repos/o/r/agents/variables?per_page=30&page=1": {
      data: {
        total_count: 2,
        variables: [
          { name: "AGENT_MODEL", value: "default" },
          { name: "RETIRED_FLAG", value: "off" },
        ],
      },
    },
  };
  const declared = [
    { name: "AGENT_MODEL", value: "extended" },
    { name: "FIREWALL_MODE", value: "strict" },
  ];
  const plan = (api: MockApi) =>
    agentsVariablesSection.plan(planContext(agentsVariablesSection, api, REPO), declared);

  test("the plan labels drift with this section's key and its noun; undeclared defaults to delete", async () => {
    expect(agentsVariablesSection.undeclaredDefault).toBe("delete");
    const api = new MockApi(listRoute);
    const result = await plan(api);
    expect(result.ops.map((op) => op.drift)).toEqual([
      [
        'agents_variables[AGENT_MODEL].value: declared "extended" != live "default"; apply will set the declared value',
      ],
      [
        "agents_variables[FIREWALL_MODE]: missing - declared in the settings file but not on the repo; apply will create it",
      ],
      [
        "agents_variables[RETIRED_FLAG]: undeclared - not in the settings file, so apply will DELETE it; add it to the settings file to keep it",
      ],
    ]);
    expect(result.ops.map((op) => op.change)).toEqual([
      'updated Copilot agents variable "AGENT_MODEL"',
      'created Copilot agents variable "FIREWALL_MODE"',
      'DELETED undeclared Copilot agents variable "RETIRED_FLAG"',
    ]);
    expect(api.mutations()).toEqual([]);
  });

  test("execution drives this family's routes", async () => {
    const api = new MockApi(listRoute).allowMutations(
      "POST /repos/o/r/agents/variables",
      "PATCH /repos/o/r/agents/variables/*",
      "DELETE /repos/o/r/agents/variables/*",
    );
    const execution = await executePlan(await plan(api), agentsVariablesSection, api, REPO, {
      resolveSecret: () => {
        throw new Error("variables carry no secrets");
      },
    });
    expect(execution.status).toBe("applied");
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "PATCH /repos/o/r/agents/variables/AGENT_MODEL",
      "POST /repos/o/r/agents/variables",
      "DELETE /repos/o/r/agents/variables/RETIRED_FLAG",
    ]);
  });
});
