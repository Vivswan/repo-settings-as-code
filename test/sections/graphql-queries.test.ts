/**
 * Every declared GraphQL operation's query, validated at two depths:
 *   - structural checks that need only the query TEXT (a single named
 *     operation whose name and kind match the declaration, $owner/$repo on
 *     repo-addressed reads) run always;
 *   - full schema validation (graphql.validate against GitHub's published
 *     schema) runs when the fetched, gitignored schema artifact is present.
 *     Locally its absence skips with the fetch command (a fresh clone should
 *     not fail on a missing artifact); in CI the artifact is cache-restored
 *     or re-fetched before `bun test`, so absence there is a broken pipeline
 *     and FAILS - the same missing-artifact posture as the trimmed OpenAPI
 *     spec, where CI always materializes the file and only local runs may
 *     lack it.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSchema, type OperationDefinitionNode, parse, validate, visit } from "graphql";
import {
  GRAPHQL_BOOLEAN_TWINS,
  GRAPHQL_REVIEW_TWINS,
  GRAPHQL_STATUS_CHECK_TWINS,
} from "../../src/sections/branches/graphql-rules.js";
import { allGraphqlOps } from "../../src/sections/registry.js";

const SCHEMA_PATH = join(import.meta.dir, "..", "e2e", "graphql", "schema.docs.graphql");
const FETCH_COMMAND = "bun .github/scripts/fetch-graphql-schema.ts";

const schemaAvailable = existsSync(SCHEMA_PATH);
if (!schemaAvailable) {
  if (process.env.CI) {
    throw new Error(
      `the GraphQL schema is missing at ${SCHEMA_PATH} in CI. The checks workflow must restore it from cache or fetch it (${FETCH_COMMAND}) before running tests`,
    );
  }
  console.warn(
    `graphql-queries: schema validation skipped - the fetched artifact is missing at ${SCHEMA_PATH}. Generate it with: ${FETCH_COMMAND}`,
  );
}

/** The single operation definition of a declared query, asserted to exist. */
function operationOf(key: string, query: string): OperationDefinitionNode {
  const document = parse(query);
  const operations = document.definitions.filter(
    (definition): definition is OperationDefinitionNode =>
      definition.kind === "OperationDefinition",
  );
  expect(operations, `${key}: a query must be a single operation`).toHaveLength(1);
  return operations[0] as OperationDefinitionNode;
}

describe("declared GraphQL queries", () => {
  test("every query is one named operation matching its declaration", () => {
    for (const [key, op] of Object.entries(allGraphqlOps())) {
      const operation = operationOf(key, op.query);
      expect(operation.name?.value, `${key}: the operation name must equal op.name`).toBe(op.name);
      // The declared kind and the query's operation type must agree: kind is
      // the explicit gating truth (never derived from POST), so a mutation
      // declared "read" would silently pass the preflight write guard.
      const expectedType = op.kind === "write" ? "mutation" : "query";
      expect(operation.operation, `${key}: a ${op.kind} op must be a ${expectedType}`).toBe(
        expectedType,
      );
      if (op.kind === "read") {
        // Repo-addressed reads carry $owner/$repo, which is also how the e2e
        // mock resolves their multi-repo target.
        const variables = (operation.variableDefinitions ?? []).map(
          (definition) => definition.variable.name.value,
        );
        expect(variables, `${key}: a read must take $owner and $repo`).toContain("owner");
        expect(variables, `${key}: a read must take $owner and $repo`).toContain("repo");
      }
    }
  });

  test.skipIf(!schemaAvailable)("every query validates against GitHub's published schema", () => {
    // assumeValid skips graphql-js's SCHEMA-level validation, which rejects
    // GitHub's published SDL as-is (it deprecates implementation fields, e.g.
    // Project.id, whose interface fields are not deprecated); each QUERY is
    // still fully validated against the schema's types below.
    const schema = buildSchema(readFileSync(SCHEMA_PATH, "utf8"), { assumeValid: true });
    for (const [key, op] of Object.entries(allGraphqlOps())) {
      const errors = validate(schema, parse(op.query));
      expect(
        errors.map((error) => `${key}: ${error.message}`),
        `${key}: the query must validate against the schema`,
      ).toEqual([]);
    }
  });

  test("the branches rules query selects every translation-table twin", () => {
    // The twin tables translate classic protection keys into GraphQL rule
    // fields the engine diffs against the rules query's read-back, so a twin
    // added to a table but not to RULES_QUERY's selection set would drift
    // forever (the live field would read as undefined, never converging).
    const op = allGraphqlOps()["branches.rulesQuery"];
    if (op === undefined) {
      throw new Error("the branches section no longer declares rulesQuery; update this test");
    }
    // Collect only the fields selected DIRECTLY on the rule nodes (the
    // branchProtectionRules connection's nodes selection): that is where the
    // engine reads node[twin], so a twin selected elsewhere in the document
    // must not satisfy the assertion. Aliases are rejected for the same
    // reason - an aliased twin reads back under the alias, not the twin name.
    const selected = new Set<string>();
    visit(parse(op.query), {
      Field(node) {
        if (node.name.value !== "branchProtectionRules") {
          return;
        }
        for (const selection of node.selectionSet?.selections ?? []) {
          if (selection.kind !== "Field" || selection.name.value !== "nodes") {
            continue;
          }
          for (const field of selection.selectionSet?.selections ?? []) {
            if (field.kind === "Field") {
              expect(
                field.alias,
                `RULES_QUERY must not alias "${field.name.value}": the engine reads rule fields by their twin name`,
              ).toBeUndefined();
              selected.add(field.name.value);
            }
          }
        }
      },
    });
    const twins = [
      ...Object.values(GRAPHQL_BOOLEAN_TWINS),
      ...Object.values(GRAPHQL_REVIEW_TWINS),
      ...Object.values(GRAPHQL_STATUS_CHECK_TWINS),
    ];
    for (const twin of twins) {
      expect(
        selected.has(twin),
        `RULES_QUERY must select "${twin}" on the rule nodes: a twin in a translation table but not in the query's selection set can never converge`,
      ).toBe(true);
    }
  });
});
