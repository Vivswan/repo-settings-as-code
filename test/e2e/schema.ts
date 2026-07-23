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
    private_repos: z.enum(["redact", "show"]).optional(),
    private_report: z.enum(["none", "issue", "artifact"]).optional(),
    /**
     * The age recipient the `artifact` channel encrypts the report to,
     * forwarded as INPUT_REPORT-PUBLIC-KEY. A config-rejection scenario sets a
     * malformed value on purpose; a delivery scenario sets a valid generated
     * recipient (see ARTIFACT_TEST_RECIPIENT in the runner).
     */
    report_public_key: z.string().optional(),
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
    /**
     * Substrings the step summary must NOT contain: the redaction leak guard.
     * A redacted target's slug and its private live values must never reach the
     * publicly-readable summary, so a private scenario lists them here.
     */
    summary_lacks: z.array(z.string()).optional(),
    /** Substrings stdout must contain. */
    stdout_contains: z.array(z.string()).optional(),
    /**
     * Substrings stdout must NOT contain, matched AFTER the runner strips the
     * `::add-mask::` lines core.setSecret emits (those lines legitimately carry
     * the raw slug so the real runner can mask it; nothing else may). The
     * redaction leak guard for logs and workflow-command annotations, which
     * both land on stdout.
     */
    stdout_lacks: z.array(z.string()).optional(),
    /**
     * Substrings that must appear on NO publicly-readable surface at all: the
     * step summary, stdout, stderr (both with the `::add-mask::` lines stripped),
     * AND every action output value. This is the whole-surface leak invariant -
     * the same checkLeaks primitive the fuzzer applies - for a scenario that
     * needs to prove a slug or sentinel leaked NOWHERE, not just from one named
     * surface. Prefer this over listing the same needle in summary_lacks AND
     * stdout_lacks; reserve those two for a string that is allowed on one surface
     * but forbidden on another.
     */
    leaks_nowhere: z.array(z.string()).optional(),
    /**
     * The private-report issue channel's delivery to one target repo. The runner
     * inspects the recorded issue create/patch requests for that slug:
     *   - `body_contains`: substrings the delivered report body must include (the
     *     full unredacted detail, incl the sentinel) - the create body, or the
     *     PATCH body on a reuse run.
     *   - `title`: the created issue's title (checked only on create).
     *   - a created issue must ALWAYS carry the marker label (the lookup key);
     *     this is asserted unconditionally, not gated by a field.
     *   - `lookup_by_label`: assert the issues list GET used the labels=<marker>
     *     filter (the one-indexed-request lookup the reuse path depends on).
     *   - `state`: the final open/closed state after all create/patch writes.
     *   - `created_count`: how many report issues were POSTed for the slug (1 =
     *     created once; 0 = none, e.g. the permission-denied or reuse path).
     * This is the only place the private slug and sentinel may legitimately appear.
     */
    issue_report: z
      .object({
        slug: z.string(),
        title: z.string().optional(),
        body_contains: z.array(z.string()).optional(),
        state: z.enum(["open", "closed"]).optional(),
        created_count: z.number().int().optional(),
        lookup_by_label: z.boolean().optional(),
      })
      .strict()
      .optional(),
    /**
     * Requests (any method) the log must contain, e.g. a `page=2` read that
     * proves pagination was exercised. Matched as substrings of "METHOD path".
     */
    requests_contain: z.array(z.string()).optional(),
    /**
     * When true, the mock must have received ZERO requests: the failure under
     * test (e.g. a settings_raw parse failure, read from the local filesystem
     * before the client is ever used) must fire before any API contact. The
     * same invariant the input fuzzer asserts, available to curated scenarios.
     */
    zero_requests: z.boolean().optional(),
    /**
     * When true, the runner reruns the scenario in check mode against the SAME
     * mutated mock and expects exit 0 with zero writes (the convergence proof).
     */
    converges: z.boolean().optional(),
    /**
     * When true, the runner re-runs the scenario in APPLY mode a second time
     * against the SAME mutated mock and proves apply is a fixpoint: the second
     * apply exits 0; no compare-before-write section (COMPARE_BEFORE_WRITE in
     * apply-idempotence.ts) issues a write; the mock's working state is
     * unchanged family by family (unconditional-PUT sections may write again,
     * but must rewrite the same state); and a final check-mode run converges
     * (exit 0, zero writes), so `converges` need not be set alongside.
     * Requires an apply-mode scenario WITHOUT the issue report channel: that
     * channel embeds a fresh timestamp in the report issue (state moves every
     * run) and injects the marker label into the labels declaration, so no
     * run under it is a fixpoint.
     */
    apply_idempotent: z.boolean().optional(),
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
 * contents-404 -> skipped path). `settings_raw` serves that exact string as the
 * settings.yml content instead (for a genuine YAML PARSE failure, which a
 * serialized object cannot produce); exactly one of `settings`/`settings_raw`
 * is set. `live_state` and `permissions` scope the mock's per-slug state and
 * denial mask to this target; `expect.result` pins this repo's individual
 * rollup (also assertable via the top-level repos_result map).
 */
const MultiRepoSchema = z
  .object({
    settings: SettingsSchema.nullable().optional(),
    settings_raw: z.string().optional(),
    live_state: LiveStateSchema.optional(),
    permissions: TokenPermissionsSchema.optional(),
    expect: z.object({ result: z.string().optional() }).strict().optional(),
  })
  .strict()
  // settings and settings_raw are mutually exclusive: they both define the
  // served settings.yml, and setting both would silently favor one. Reject the
  // ambiguity loudly rather than let a scenario pass with a surprising result.
  .refine((repo) => !(repo.settings !== undefined && repo.settings_raw !== undefined), {
    message: "set only one of `settings` or `settings_raw`, not both",
  });

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

/**
 * A transport-level fault the mock injects on the first `times` (default 1)
 * requests that match `endpoint` - a "section.role" key, or a core-route key
 * from CORE_FAULT_KEYS in mock/routes.ts (e.g. "core.discoveryList" for the
 * /user/repos discovery listing, "core.contentsGet" for the settings-file
 * fetch, and the "core.issue*" / "core.reportLabelCreate" / "core.userGet"
 * report routes). These model failures the permission/handler layers cannot:
 * `rate_limit_403` answers 403 with "rate limit" in the body (the client's
 * classifier must read it as throttling, NOT a permission denial);
 * `429_then_200` answers 429 with Retry-After: 0 so the client's retry plugin
 * retries and the next request succeeds (the retry path, fast under
 * RETRY_BASE_MS=1); `server_error` answers a 5xx with a JSON message body,
 * rotating 500/502/503 deterministically on the fault's fire count - the
 * client retries 5xx, so times: 1 is a transient the run recovers from and
 * times >= 3 (1 + MAX_RETRIES) exhausts the retries into a hard failure;
 * `connection_drop` destroys the socket before any response (a network failure
 * the client surfaces after its retries are spent).
 */
const FaultSchema = z
  .object({
    endpoint: z.string(),
    kind: z.enum(["rate_limit_403", "429_then_200", "connection_drop", "server_error"]),
    times: z.number().int().positive().optional(),
  })
  .strict();

export const ScenarioSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    tiers: z.array(TierSchema).default(["mock"]),
    settings: SettingsSchema.optional(),
    /**
     * The EXACT settings.yml text the single-repo run reads, written verbatim
     * (no YAML round-trip), for inputs a serialized object cannot produce: raw
     * unparseable YAML (the "cannot read settings ... valid YAML" path) or a
     * document that parses to a non-mapping (the "must be a YAML mapping"
     * validator path). The file is read from the LOCAL filesystem before any
     * API call, so such a scenario must see zero requests (assert with
     * expect.zero_requests). Exactly one of `settings`/`settings_raw` is set;
     * a multi-repo target's raw file is `repos.<slug>.settings_raw` instead.
     */
    settings_raw: z.string().optional(),
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
    /** Transport-level faults injected on the first matching requests. */
    faults: z.array(FaultSchema).optional(),
    expect: ExpectSchema,
  })
  .strict()
  // Both fields define the served settings.yml, and setting both would
  // silently favor one; setting neither leaves the run without a settings
  // document at all. Reject each ambiguity loudly, mirroring MultiRepoSchema.
  .refine((s) => !(s.settings !== undefined && s.settings_raw !== undefined), {
    message: "set only one of `settings` or `settings_raw`, not both",
  })
  .refine((s) => s.settings !== undefined || s.settings_raw !== undefined, {
    message: "one of `settings` or `settings_raw` is required",
  })
  // The single-repo settings file is not read at all in multi mode, so a
  // top-level settings_raw there would be silently dead configuration.
  .refine((s) => s.settings_raw === undefined || (!s.repos && !s.discovery), {
    message:
      "settings_raw is single-repo only; a multi-repo target's raw file is `repos.<slug>.settings_raw`",
  });

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
export type Fault = z.infer<typeof FaultSchema>;
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
