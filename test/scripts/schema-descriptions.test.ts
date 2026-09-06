// The schema-description attacher: keys resolve to sites the way the docs files spell them,
// generic and brace keys fan out, and every failure mode (a dangling key, a doubly described site,
// an undescribed site) fails naming the culprit - proven on the bug each guard exists for.

import { describe, expect, test } from "bun:test";
import {
  attachDescriptions,
  describableSites,
  type JsonSchemaNode,
} from "../../.github/scripts/lib/schema-descriptions.js";

/** A small schema with every site kind: definitions, nested properties, an anyOf arm, items, additionalProperties. */
function fixture(): Record<string, JsonSchemaNode> {
  return {
    LabelConfig: {
      type: "object",
      properties: { name: { type: "string" }, color: { type: "string" } },
    },
    "UndeclaredPolicyList<LabelConfig>": {
      type: "object",
      properties: { entries: { type: "array", items: { $ref: "#/definitions/LabelConfig" } } },
    },
    "UndeclaredPolicyList<TeamConfig>": {
      type: "object",
      properties: { entries: { type: "array", items: { $ref: "#/definitions/TeamConfig" } } },
    },
    EnvironmentConfig: {
      type: "object",
      properties: {
        policy: {
          anyOf: [
            { type: "object", properties: { protected: { type: "boolean" } } },
            { type: "null" },
          ],
        },
        reviewers: {
          type: "array",
          items: { type: "object", properties: { id: { type: "number" } } },
        },
      },
    },
    RepositoryConfig: { type: "object", additionalProperties: { type: "string" } },
    WebhookConfig: {
      type: "object",
      properties: { config: { $ref: "#/definitions/WebhookDeliveryConfig" } },
    },
  };
}

const COMPLETE = [
  { key: "LabelConfig", text: "One label.", source: "labels.docs.yml" },
  { key: "LabelConfig.name", text: "The name.", source: "labels.docs.yml" },
  { key: "LabelConfig.color", text: "The color.", source: "labels.docs.yml" },
  { key: "UndeclaredPolicyList<*>", text: "The wrapper.", source: "shared.docs.yml" },
  { key: "UndeclaredPolicyList<*>.entries", text: "The entries.", source: "shared.docs.yml" },
  { key: "EnvironmentConfig", text: "One environment.", source: "environments.docs.yml" },
  { key: "EnvironmentConfig.policy", text: "The policy.", source: "environments.docs.yml" },
  {
    key: "EnvironmentConfig.policy|0.protected",
    text: "Protected only.",
    source: "environments.docs.yml",
  },
  { key: "EnvironmentConfig.reviewers", text: "Reviewers.", source: "environments.docs.yml" },
  { key: "EnvironmentConfig.reviewers[].id", text: "The id.", source: "environments.docs.yml" },
  { key: "RepositoryConfig", text: "The repo.", source: "repository.docs.yml" },
  { key: "RepositoryConfig.*", text: "Any other field.", source: "repository.docs.yml" },
  { key: "WebhookConfig", text: "One webhook.", source: "webhooks.docs.yml" },
  { key: "WebhookConfig.config", text: "Delivery settings.", source: "webhooks.docs.yml" },
];

describe("describableSites", () => {
  test("spells every definition, property, arm, items, and additionalProperties site", () => {
    expect([...describableSites(fixture()).keys()].sort()).toEqual(
      [
        "LabelConfig",
        "LabelConfig.name",
        "LabelConfig.color",
        "UndeclaredPolicyList<LabelConfig>",
        "UndeclaredPolicyList<LabelConfig>.entries",
        "UndeclaredPolicyList<TeamConfig>",
        "UndeclaredPolicyList<TeamConfig>.entries",
        "EnvironmentConfig",
        "EnvironmentConfig.policy",
        "EnvironmentConfig.policy|0.protected",
        "EnvironmentConfig.reviewers",
        "EnvironmentConfig.reviewers[].id",
        "RepositoryConfig",
        "RepositoryConfig.*",
        "WebhookConfig",
        "WebhookConfig.config",
      ].sort(),
    );
  });
});

describe("attachDescriptions", () => {
  test("a complete set lands every text on its site, generic keys fanning out to each instance", () => {
    const definitions = fixture();
    attachDescriptions(definitions, COMPLETE);
    const sites = describableSites(definitions);
    expect(
      Object.fromEntries([...sites].map(([key, site]) => [key, site.node.description])),
    ).toEqual({
      LabelConfig: "One label.",
      "LabelConfig.name": "The name.",
      "LabelConfig.color": "The color.",
      "UndeclaredPolicyList<LabelConfig>": "The wrapper.",
      "UndeclaredPolicyList<LabelConfig>.entries": "The entries.",
      "UndeclaredPolicyList<TeamConfig>": "The wrapper.",
      "UndeclaredPolicyList<TeamConfig>.entries": "The entries.",
      EnvironmentConfig: "One environment.",
      "EnvironmentConfig.policy": "The policy.",
      "EnvironmentConfig.policy|0.protected": "Protected only.",
      "EnvironmentConfig.reviewers": "Reviewers.",
      "EnvironmentConfig.reviewers[].id": "The id.",
      RepositoryConfig: "The repo.",
      "RepositoryConfig.*": "Any other field.",
      WebhookConfig: "One webhook.",
      "WebhookConfig.config": "Delivery settings.",
    });
    // Description first everywhere; a described $ref moves under allOf (draft-7 ignores $ref siblings).
    expect(Object.keys(definitions.LabelConfig?.properties?.name ?? {})).toEqual([
      "description",
      "type",
    ]);
    expect(definitions.WebhookConfig?.properties?.config).toEqual({
      description: "Delivery settings.",
      allOf: [{ $ref: "#/definitions/WebhookDeliveryConfig" }],
    });
  });

  test("an additionalProperties site may stay undescribed: the parent covers 'any other key'", () => {
    const definitions = fixture();
    attachDescriptions(
      definitions,
      COMPLETE.filter((d) => d.key !== "RepositoryConfig.*"),
    );
    expect(definitions.RepositoryConfig?.additionalProperties).toEqual({ type: "string" });
  });

  test("overlapping brace alternatives claim a site once, not as a duplicate", () => {
    const definitions = fixture();
    const overlapping = COMPLETE.filter((d) => d.key !== "UndeclaredPolicyList<*>.entries");
    overlapping.push({
      key: "{UndeclaredPolicyList<*>,UndeclaredPolicyList<TeamConfig>}.entries",
      text: "E.",
      source: "s",
    });
    attachDescriptions(definitions, overlapping);
    expect(definitions["UndeclaredPolicyList<TeamConfig>"]?.properties?.entries?.description).toBe(
      "E.",
    );
  });

  test("a brace key describes each listed definition's field once", () => {
    const definitions = fixture();
    const braced = COMPLETE.filter((d) => !d.key.startsWith("UndeclaredPolicyList<*>"));
    braced.push(
      {
        key: "{UndeclaredPolicyList<LabelConfig>,UndeclaredPolicyList<TeamConfig>}",
        text: "W.",
        source: "s",
      },
      {
        key: "{UndeclaredPolicyList<LabelConfig>,UndeclaredPolicyList<TeamConfig>}.entries",
        text: "E.",
        source: "s",
      },
    );
    attachDescriptions(definitions, braced);
    expect(definitions["UndeclaredPolicyList<TeamConfig>"]?.properties?.entries?.description).toBe(
      "E.",
    );
  });

  test.each<[label: string, mutate: (d: typeof COMPLETE) => typeof COMPLETE, problem: RegExp]>([
    [
      "a key naming no site (the field was renamed)",
      (d) => [...d, { key: "LabelConfig.colour", text: "x", source: "labels.docs.yml" }],
      /labels\.docs\.yml: "LabelConfig\.colour" describes nothing in the schema/,
    ],
    [
      "a brace alternative naming no site (a factory member was removed)",
      (d) => [
        ...d,
        {
          key: "{LabelConfig,RemovedConfig}.name",
          text: "x",
          source: "shared.docs.yml",
        },
      ],
      /shared\.docs\.yml: "RemovedConfig\.name" \(from "\{LabelConfig,RemovedConfig\}\.name"\) describes nothing in the schema/,
    ],
    [
      "a site described twice (a generic key and a specific one)",
      (d) => [
        ...d,
        { key: "UndeclaredPolicyList<TeamConfig>.entries", text: "x", source: "teams.docs.yml" },
      ],
      /UndeclaredPolicyList<TeamConfig>\.entries is described more than once: shared\.docs\.yml \("UndeclaredPolicyList<\*>\.entries"\), teams\.docs\.yml/,
    ],
    [
      "a site nobody describes (a field was added)",
      (d) => d.filter((x) => x.key !== "EnvironmentConfig.reviewers[].id"),
      /EnvironmentConfig\.reviewers\[\]\.id has no description in any docs file/,
    ],
  ])("%s fails naming the culprit", (_label, mutate, problem) => {
    expect(() => attachDescriptions(fixture(), mutate(COMPLETE))).toThrow(problem);
  });

  test("a generic key never matches a non-generic definition or a nested generic", () => {
    const definitions = {
      ...fixture(),
      UndeclaredPolicyList: { type: "object" } as JsonSchemaNode,
    };
    // The bare name is a distinct site, so the generic set now leaves it undescribed.
    expect(() => attachDescriptions(definitions, COMPLETE)).toThrow(
      /^schema descriptions:\n- UndeclaredPolicyList has no description in any docs file$/,
    );
  });
});
