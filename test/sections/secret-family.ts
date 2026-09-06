/**
 * The shared pin for one sealed-secret family minted by repoSecretsSection():
 * its routes under the family's path segment, its noun in output lines, and
 * the keep-by-default posture. Engine behavior (existence planning, sealing,
 * the resolver contract) is pinned by secrets-engine.test.ts and the
 * actions_secrets section tests. Each section directory keeps a thin test
 * file invoking this, so the diff-aware CI selector still maps the section's
 * tests to its key.
 */

import { describe, expect, test } from "bun:test";
import { executePlan } from "../../src/engine/execute.js";
import type { SectionModule } from "../../src/sections/contract/module.js";
import { planContext } from "../../src/sections/contract/plan.js";
import type { RepoSecretsKey } from "../../src/sections/shared/repo-secrets.js";
import {
  MOCK_SECRETS_PUBLIC_KEY,
  mockSodiumReady,
  unsealSecretValue,
} from "../e2e/mock/secrets.js";
import { MockApi } from "../mock-api.js";
import { REPO } from "./section-run.js";

/** The facts one family owns; everything else is the shared factory's. */
export interface SecretFamilyFacts {
  section: SectionModule<RepoSecretsKey>;
  /** The path segment under /repos/{owner}/{repo} the family's routes use. */
  segment: string;
  /** A distinctive key_id served by the family's public-key route. */
  keyId: string;
  /** The output noun for notes ("Dependabot secret", ...). */
  noun: string;
  /** A representative declared secret name for the create case. */
  secretName: string;
}

function listOf(...names: string[]) {
  return {
    data: {
      total_count: names.length,
      secrets: names.map((name) => ({
        name,
        created_at: "2020-01-15T00:00:00Z",
        updated_at: "2020-01-15T00:00:00Z",
      })),
    },
  };
}

export function pinSecretFamily({ section, segment, keyId, noun, secretName }: SecretFamilyFacts) {
  const LIST = `GET /repos/o/r/${segment}/secrets?per_page=100&page=1`;
  const PUBLIC_KEY = `GET /repos/o/r/${segment}/secrets/public-key`;
  const plan = (api: MockApi, declared: Parameters<typeof section.plan>[1]) =>
    section.plan(planContext(section, api, REPO), declared);

  describe(section.key, () => {
    test("the plan's drift and notes carry this section's label and noun; the PUT is planned under its route", async () => {
      const api = new MockApi({
        [LIST]: listOf("LEGACY"),
        [PUBLIC_KEY]: { data: { key_id: keyId, key: MOCK_SECRETS_PUBLIC_KEY } },
      });
      const result = await plan(api, [{ name: secretName, value: "$V" }]);
      expect(result.ops.map((op) => [op.role, op.params, op.drift])).toEqual([
        [
          "put",
          { secret_name: secretName },
          [
            `${section.key}[${secretName}]: missing - declared in the settings file but not on the repo; apply will create it`,
          ],
        ],
      ]);
      expect(result.notes.join("\n")).toContain(`${noun} "LEGACY" exists on the repo`);
      expect(result.notes.join("\n")).toContain(`${noun} values cannot be read back`);
      expect(api.mutations()).toEqual([]);
    });

    test("execution seals against this family's public key and PUTs its route", async () => {
      await mockSodiumReady();
      const api = new MockApi({
        [LIST]: listOf(),
        [PUBLIC_KEY]: { data: { key_id: keyId, key: MOCK_SECRETS_PUBLIC_KEY } },
      }).allowMutations(`PUT /repos/o/r/${segment}/secrets/${secretName}`);
      const planned = await plan(api, [{ name: secretName, value: "$V" }]);
      const execution = await executePlan(planned, section, api, REPO, {
        resolveSecret: () => "family-plain",
      });
      expect(execution).toEqual({
        status: "applied",
        changes: [`created secret "${secretName}"`],
        notes: [],
        landed: 1,
      });
      const put = api.mutations().find((c) => c.method === "PUT");
      expect(put?.path).toBe(`/repos/o/r/${segment}/secrets/${secretName}`);
      const payload = put?.payload as { encrypted_value: string; key_id: string };
      expect(payload.key_id).toBe(keyId);
      expect(unsealSecretValue(payload.encrypted_value)).toBe("family-plain");
    });

    test("undeclared secrets are kept by default and deleted only under the knob", async () => {
      expect(section.undeclaredDefault).toBe("keep");
      const api = new MockApi({ [LIST]: listOf("STALE") });
      const result = await plan(api, { undeclared: "delete", entries: [] });
      expect(result.ops.map((op) => [op.role, op.params, op.change])).toEqual([
        ["remove", { secret_name: "STALE" }, 'DELETED undeclared secret "STALE"'],
      ]);
    });
  });
}
