/**
 * Zod-validated Scenario type for the e2e harness. A scenario fully describes
 * one hermetic run: the settings file and action inputs, the token's
 * permission mask and how denials are shaped, the mock's starting live state,
 * and the expected outcome. The loader validates every scenario file against
 * this schema, so a malformed scenario fails loudly at load time (naming the
 * file and the offending field) rather than producing a confusing run.
 */

import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { FILTER_INPUTS } from "../../src/action/inputs.js";
import type { PatResource } from "../../src/sections/contract.js";
import type { LiveState } from "./mock/state.js";

/** The tiers a scenario can run against. Only "mock" exists today; "live" is
 * reserved for a future App-token tier so scenarios can opt in later. */
export const TierSchema = z.enum(["mock", "live"]);

/**
 * The permission mask keys: every fine-grained PAT resource plus the
 * organization "members" grant (teams need it, and it is not a PatResource).
 * The `satisfies` keeps this list in lockstep with PatResource - a new
 * resource that is not listed here fails to compile.
 */
const MASK_KEYS = [
  "administration",
  "issues",
  "environments",
  "actions",
  "pages",
  "code_scanning_alerts",
  "contents",
  "org_members",
] as const satisfies readonly (PatResource | "org_members")[];

export const MaskKeySchema = z.enum(MASK_KEYS);

/** Access level granted to a masked resource. */
export const MaskGradeSchema = z.enum(["none", "read", "write"]);

/**
 * How denied resources answer. "fine_grained" (the default) mirrors real
 * fine-grained tokens: a denied read answers 404 "Not Found", a denied write
 * answers 403 "Resource not accessible by personal access token". The numeric
 * styles answer every denial uniformly with that status.
 */
export const DenialStyleSchema = z.union([
  z.literal("fine_grained"),
  z.literal(403),
  z.literal(404),
]);

/** Which account kind the mock owner presents as (teams behave differently). */
export const OwnerKindSchema = z.enum(["org", "user"]);

/**
 * The action inputs a scenario can set; all optional with runner defaults.
 * required_sections and sections are comma-separated strings, matching the
 * action's own INPUT_REQUIRED-SECTIONS / INPUT_SECTIONS wire format.
 */
export const InputsSchema = z
  .object({
    mode: z.enum(["apply", "check"]).optional(),
    on_missing_permission: z.enum(["fail", "warn"]).optional(),
    required_sections: z.string().optional(),
    sections: z.string().optional(),
  })
  .strict();

/**
 * The expected outcome of a run. Every field is optional except exit_code; the
 * runner asserts only what a scenario declares, in a fixed order (violations
 * first, then exit code, then the rest), so a partial expectation still pins
 * the parts it names.
 */
export const ExpectSchema = z
  .object({
    /** The process exit code (0 clean/applied, 1 failed). */
    exit_code: z.number().int(),
    /** The `result` output ("clean", "drift", "applied", "failed", ...). */
    result: z.string().optional(),
    /** Per-section outcome parsed from the step-summary table. */
    outcomes: z.record(z.string(), z.string()).optional(),
    /**
     * Ordered "METHOD /path" prefixes the non-GET request log must contain as
     * a subsequence. `{repo}` is a placeholder the loader expands to the
     * scenario's owner/name before matching.
     */
    mutations: z.array(z.string()).optional(),
    /** "METHOD /path" prefixes that must NEVER appear in the request log. */
    never: z.array(z.string()).optional(),
    /** Substrings the step summary must contain. */
    summary_contains: z.array(z.string()).optional(),
    /** Substrings stdout must contain. */
    stdout_contains: z.array(z.string()).optional(),
    /**
     * Requests (any method) the log must contain, e.g. a `page=2` read that
     * proves pagination was exercised. Matched as substrings of "METHOD path".
     */
    requests_contain: z.array(z.string()).optional(),
    /**
     * When true, the runner reruns the scenario in check mode against the SAME
     * mutated mock and expects exit 0 with zero writes (the convergence proof).
     */
    converges: z.boolean().optional(),
    /**
     * Multi-repo: the expected per-target rollup, parsed from the action's
     * `repos-result` JSON output, keyed by "owner/name" slug -> result string
     * ("applied" | "clean" | "drift" | "skipped" | "failed" | ...).
     */
    repos_result: z.record(z.string(), z.string()).optional(),
  })
  .strict();

/**
 * The mock's starting state. The LiveState shape is owned by
 * ./mock/state.ts (it is the GET-side body space the mock serves); here it is
 * accepted as a loose object and typed as LiveState, so the two files share
 * one definition instead of restating it.
 */
const LiveStateSchema = z.record(z.string(), z.unknown()).transform((v) => v as LiveState);

/** A settings file body: any YAML mapping (validated for real by the action). */
const SettingsSchema = z.record(z.string(), z.unknown());

/** The token permission mask shape, reused for the global and per-repo masks. */
const TokenPermissionsSchema = z.partialRecord(MaskKeySchema, MaskGradeSchema);

/**
 * One target repo in a multi-repo scenario. `settings` is that repo's
 * settings.yml body, or null when the repo has NO settings file (the
 * contents-404 -> skipped path). `live_state` and `permissions` scope the
 * mock's per-slug state and denial mask to this target; `expect.result` pins
 * this repo's individual rollup (also assertable via the top-level
 * repos_result map).
 */
const MultiRepoSchema = z
  .object({
    settings: SettingsSchema.nullable().optional(),
    live_state: LiveStateSchema.optional(),
    permissions: TokenPermissionsSchema.optional(),
    expect: z.object({ result: z.string().optional() }).strict().optional(),
  })
  .strict();

/**
 * One discovery-pool repo `/user/repos` enumerates for a repos: "*" scenario.
 * The four attributes are the client-side-filterable fields the discovery
 * engine reads; the mock serves them verbatim and never pre-filters.
 */
const DiscoveryRepoSchema = z
  .object({
    slug: z.string(),
    archived: z.boolean().optional(),
    fork: z.boolean().optional(),
    visibility: z.string().optional(),
    topics: z.array(z.string()).optional(),
  })
  .strict();

/**
 * The discovery configuration for a repos: "*" scenario: the pool the mock
 * enumerates, and the discovery-filter action inputs the runner forwards as
 * INPUT_* vars. Keys are constrained to the real filter input names
 * (FILTER_INPUTS from the action), so a typoed filter fails at load time rather
 * than being silently forwarded and ignored.
 */
const DiscoverySchema = z
  .object({
    pool: z.array(DiscoveryRepoSchema),
    inputs: z.partialRecord(z.enum(FILTER_INPUTS), z.string()).default({}),
  })
  .strict();

export const ScenarioSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    tiers: z.array(TierSchema).default(["mock"]),
    settings: SettingsSchema,
    inputs: InputsSchema.optional(),
    /** Resource -> granted access; unspecified resources default to "write". */
    token_permissions: TokenPermissionsSchema.optional(),
    denial_style: DenialStyleSchema.default("fine_grained"),
    live_state: LiveStateSchema.optional(),
    owner_kind: OwnerKindSchema.default("org"),
    /**
     * A GHES-style path prefix (e.g. "/api/v3") the mock bakes into its base
     * URL and requires on every request, to prove the client joins the base
     * URL correctly without dropping or doubling the prefix.
     */
    base_prefix: z.string().optional(),
    /**
     * Multi-repo mode: the target repos keyed by "owner/name" slug. Setting
     * this (or `discovery`) makes the runner drive the action's multi-repo
     * path (INPUT_REPOS) against the admin repo e2e-owner/e2e-repo.
     */
    repos: z.record(z.string(), MultiRepoSchema).optional(),
    /** Multi-repo repos: "*" discovery: the pool plus the filter inputs. */
    discovery: DiscoverySchema.optional(),
    /** The defaults-file body merged under every target (INPUT_DEFAULTS-FILE). */
    defaults_file: SettingsSchema.optional(),
    expect: ExpectSchema,
  })
  .strict();

export type Tier = z.infer<typeof TierSchema>;
export type MaskKey = z.infer<typeof MaskKeySchema>;
export type MaskGrade = z.infer<typeof MaskGradeSchema>;
export type DenialStyle = z.infer<typeof DenialStyleSchema>;
export type OwnerKind = z.infer<typeof OwnerKindSchema>;
export type Inputs = z.infer<typeof InputsSchema>;
export type Expect = z.infer<typeof ExpectSchema>;
export type MultiRepo = z.infer<typeof MultiRepoSchema>;
export type DiscoveryRepo = z.infer<typeof DiscoveryRepoSchema>;
export type Discovery = z.infer<typeof DiscoverySchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;

/**
 * Parse and validate one scenario object. On failure, throw an error naming
 * the source file and every offending zod path, so a malformed scenario is
 * diagnosable without reading the schema.
 */
export function parseScenario(raw: unknown, sourcePath: string): Scenario {
  const result = ScenarioSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`invalid scenario ${sourcePath}:\n${detail}`);
  }
  return result.data;
}

/** Recursively collect every .yml file under a directory (empty if absent). */
function collectYmlFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectYmlFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".yml")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Load and validate every scenario under `dir` (recursively, all .yml files),
 * sorted by path for a stable run order. Each file is parsed as YAML and
 * validated through parseScenario, so a bad file fails loudly naming itself.
 */
export function loadScenarios(dir: string): Scenario[] {
  return collectYmlFiles(dir)
    .sort()
    .map((path) => parseScenario(parseYaml(readFileSync(path, "utf8")), path));
}
