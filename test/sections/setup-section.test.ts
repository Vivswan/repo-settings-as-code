/**
 * The setup sections setupSection() mints, pinned from one key-correlated
 * table: the shared plan behavior once per section, over the facts they
 * differ on (the route, the change-line noun, the availability a 403 names).
 */

import { describe, expect, test } from "bun:test";
import { executePlan } from "../../src/engine/execute.js";
import type { GithubClient } from "../../src/github/api.js";
import type { SettingsFile } from "../../src/schema.js";
import { codeQualitySetupSection } from "../../src/sections/code_quality_setup/index.js";
import { codeScanningDefaultSetupSection } from "../../src/sections/code_scanning_default_setup/index.js";
import type { SectionModule } from "../../src/sections/contract/module.js";
import { type PlanContext, planContext } from "../../src/sections/contract/plan.js";
import type { SetupKey, SetupSectionModule } from "../../src/sections/shared/setup-section.js";
import type { MustBeNever } from "../../src/types.js";
import { MockApi } from "../mock-api.js";
import { provePlanIdempotent } from "./plan-idempotence.js";
import { REPO } from "./section-run.js";

/** One section's declared setup document. */
type Declared<K extends SetupKey = SetupKey> = Exclude<SettingsFile[K], undefined>;

/** The lockstep tuple on which the minted sections differ, typed by the same key throughout. */
interface SetupFacts<K extends SetupKey> {
  section: SetupSectionModule<K>;
  /** The expanded endpoint path ("/repos/o/r/code-quality/setup"). */
  path: string;
  /** A live GET body; must carry a `languages` list for the set compare. */
  live: Record<string, unknown> & { languages: string[] };
  /** A declared document that drifts from `live`, and the exact drift line. */
  driftDeclared: Declared<K>;
  driftLine: string;
  /** A declared document for the verbatim-PATCH case. */
  applyPayload: Declared<K>;
  changeLine: string;
  denied403: RegExp;
}

/** Exhaustive by type: a setup key without a row fails to compile. */
const SETUP_FACTS: { readonly [K in SetupKey]: SetupFacts<K> } = {
  code_scanning_default_setup: {
    section: codeScanningDefaultSetupSection,
    path: "/repos/o/r/code-scanning/default-setup",
    live: {
      state: "configured",
      query_suite: "default",
      languages: ["javascript-typescript", "python"],
    },
    driftDeclared: { state: "configured", query_suite: "extended" },
    driftLine: 'code_scanning_default_setup.query_suite: "extended" != "default"',
    applyPayload: { state: "configured", query_suite: "extended" },
    changeLine: "applied code scanning default setup",
    denied403: /Advanced Security/,
  },
  code_quality_setup: {
    section: codeQualitySetupSection,
    path: "/repos/o/r/code-quality/setup",
    live: {
      state: "configured",
      languages: ["javascript-typescript", "python"],
      runner_type: "standard",
    },
    driftDeclared: { state: "configured", ai_findings_option: "on_push" },
    driftLine:
      'code_quality_setup.ai_findings_option: declared "on_push" but the API response has no such field (new or write-only field?)',
    applyPayload: { state: "configured", ai_findings_option: "disabled" },
    changeLine: "applied code quality setup",
    denied403: /code quality is unavailable/,
  },
};

/**
 * Compile-time, over each minted module's literal endpoints: the read port
 * spells the GET alone (a write role is not a read), and a "denied" primary
 * read offers no 404-tolerant helper.
 */
type ReadPort<K extends SetupKey> = PlanContext<SetupSectionModule<K>["endpoints"]>["read"];
type _ReadPortIsTheGetAlone = MustBeNever<
  Exclude<{ [K in SetupKey]: keyof ReadPort<K> }[SetupKey], "get">
>;
/** The helpers the GET binds; deferred through `infer` so the mapped type resolves per concrete key. */
type GetHelpers<K extends SetupKey> =
  ReadPort<K> extends { readonly get: infer G } ? keyof G : never;
type _DeniedReadHasNoProbe = MustBeNever<
  Extract<{ [K in SetupKey]: GetHelpers<K> }[SetupKey], "probeAbsent" | "tryCall">
>;

/**
 * Compile-time: each minted plan() is typed over exactly its own section's
 * declared value, so the other setup's field is an excess property (the
 * negative control beside each passing one).
 */
type DeclaredOf<K extends SetupKey> = Parameters<SetupSectionModule<K>["plan"]>[1];
({ query_suite: "extended" }) satisfies DeclaredOf<"code_scanning_default_setup">;
// @ts-expect-error ai_findings_option belongs to code_quality_setup alone
({ ai_findings_option: "disabled" }) satisfies DeclaredOf<"code_scanning_default_setup">;
({ ai_findings_option: "disabled" }) satisfies DeclaredOf<"code_quality_setup">;
// @ts-expect-error query_suite belongs to code_scanning_default_setup alone
({ query_suite: "extended" }) satisfies DeclaredOf<"code_quality_setup">;

/**
 * A stateful fake of a setup endpoint: the GET serves what the PATCH last
 * merged over the seeded body, and the PATCH answers the spec's plain 200,
 * an EMPTY object, so the change thunk sees the real wire shape.
 */
function liveSetup(
  path: string,
  seed: Record<string, unknown>,
): GithubClient & { writes: string[] } {
  let live = seed;
  return {
    writes: [],
    async tryRequest(method, requestPath, payload) {
      if (requestPath !== path) {
        return { error: { status: 404, message: "Not Found", body: "" } };
      }
      if (method === "PATCH") {
        this.writes.push(`${method} ${requestPath}`);
        live = { ...live, ...(payload as Record<string, unknown>) };
        return { data: {} };
      }
      return { data: live };
    },
    async tryGraphql() {
      throw new Error("the setup sections issue no GraphQL");
    },
  };
}

const tools = { resolveSecret: () => "" };

describe.each(Object.values(SETUP_FACTS).map((facts) => [facts.section.key, facts] as const))(
  "%s",
  (_key, facts) => {
    // The erased view: one plan() signature over either section's declared value.
    const section: SectionModule<SetupKey> = facts.section;
    const { path, live, driftDeclared, driftLine, applyPayload, changeLine, denied403 } = facts;
    const plan = (api: GithubClient, declared: Declared) =>
      section.plan(planContext(section, api, REPO), declared);

    test("plans the verbatim PATCH on declared-keys-only drift, languages as a set", async () => {
      const api = new MockApi({ [`GET ${path}`]: { data: live } });
      // Planning reads through the GET port alone, and never writes.
      expect(Object.keys(planContext(section, api, REPO).read)).toEqual(["get"]);
      const drifted = await plan(api, driftDeclared);
      expect(drifted.ops).toHaveLength(1);
      expect(drifted.ops[0]?.role).toBe("update");
      expect(drifted.ops[0]?.payload as unknown).toEqual(driftDeclared);
      expect(drifted.ops[0]?.drift).toEqual([driftLine]);
      expect(drifted.notes).toEqual([]);
      expect(drifted.drift).toEqual([]);
      const reordered = await plan(api, { languages: [...live.languages].reverse() });
      expect(reordered.ops).toEqual([]);
      expect(api.mutations()).toEqual([]);
    });

    test("executing the plan converges: one PATCH, then nothing", async () => {
      const api = liveSetup(path, live);
      const { changes, second } = await provePlanIdempotent(section, api, applyPayload);
      expect(changes).toEqual([changeLine]);
      expect(api.writes).toEqual([`PATCH ${path}`]);
      expect(second).toEqual({ ops: [], notes: [], drift: [] });
    });

    test("a 202 configuration run is named in the change line, URL included", async () => {
      const api = new MockApi({
        [`GET ${path}`]: { data: live },
        [`PATCH ${path}`]: { data: { run_id: 42, run_url: "https://example.test/runs/42" } },
      });
      const planned = await plan(api, driftDeclared);
      const execution = await executePlan(planned, section, api, REPO, tools);
      expect(execution).toEqual({
        status: "applied",
        changes: [
          `${changeLine}; GitHub started configuration run 42 (https://example.test/runs/42) to roll it out, and the settings take effect when it finishes`,
        ],
        notes: [],
        landed: 1,
      });
    });

    test.each([
      [
        "409",
        409,
        "Conflict",
        new RegExp(`${section.key}: PATCH ${path}: 409 Conflict\\. .*already in progress`),
      ],
      ["403", 403, "Forbidden", denied403],
    ])(
      "a %s on the PATCH fails with the section's own advice",
      async (_status, status, message, advice) => {
        // The tolerated 409 carries the wait-and-retry advice; the 403
        // classifies through throwFor and names the section's availability.
        const api = new MockApi({
          [`GET ${path}`]: { data: live },
          [`PATCH ${path}`]: { error: { status, message, body: "" } },
        });
        const execution = await executePlan(
          await plan(api, driftDeclared),
          section,
          api,
          REPO,
          tools,
        );
        expect(execution.status).toBe("failed");
        expect(String((execution as { error: unknown }).error)).toMatch(advice);
      },
    );
  },
);
