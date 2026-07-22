/**
 * Fuzz generators for the e2e harness: random but valid-shaped settings per
 * section, random mock live state, and random whole scenarios. Everything is a
 * pure function of an Rng, so a failing fuzz iteration replays from its seed.
 *
 * Three-way drift detection: every settings document a generator produces is
 * also validated against the published lib/settings.schema.json with ajv. If a
 * generator emits something the schema rejects, either the generator or the
 * schema is wrong, and the fuzz run fails loudly rather than silently drifting.
 */

import { Ajv, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import settingsSchema from "../../lib/settings.schema.json" with { type: "json" };
import { SECTION_KEYS, type SectionKey } from "../../src/schema.js";
import type { LiveState } from "./mock/state.js";
import type { Rng } from "./prng.js";
import type { DenialStyle, MaskGrade, MaskKey, OwnerKind, Scenario } from "./schema.js";

type Json = Record<string, unknown>;

/**
 * Hostile string pool for names that flow into URLs, step-summary cells, and
 * request paths: pipes and backslashes (summary-table escaping), quotes,
 * spaces, percent signs and slashes (URL encoding), unicode, and a near-limit
 * length. A generator that mixes these in exercises the escaping and encoding
 * paths that a tidy ASCII name would never reach.
 */
const HOSTILE_NAMES = [
  "plain",
  "with space",
  "with|pipe",
  'with"quote',
  "with\\backslash",
  "with%percent",
  "with/slash",
  "with#hash",
  "unicode-éñ中",
  "emoji-\u{1f600}",
  "a".repeat(48),
] as const;

const HEX_COLORS = ["d73a4a", "a2eeef", "ededed", "0e8a16", "ffffff", "000000"] as const;

/** Fixed ISO due dates: a pool, never Date.now, so generation stays deterministic. */
const DUE_DATES = ["2026-01-15T00:00:00Z", "2026-06-30T00:00:00Z", "2026-12-31T00:00:00Z"] as const;

/** The four core branch-protection keys the classic PUT requires. */
const PROTECTION_CORE_KEYS = [
  "required_status_checks",
  "enforce_admins",
  "required_pull_request_reviews",
  "restrictions",
] as const;

/** A hostile-or-plain name, biased toward plain so most docs stay readable. */
function name(rng: Rng): string {
  return rng.bool(0.6)
    ? rng.pick(["bug", "chore", "docs", "feature", "infra"])
    : rng.pick(HOSTILE_NAMES);
}

// Per-section settings generators. Each returns a valid-shaped value for that
// section's SettingsFile property.

function genLabels(rng: Rng): Json[] {
  const count = rng.int(4) + 1;
  const used = new Set<string>();
  const labels: Json[] = [];
  for (let i = 0; i < count; i++) {
    let n = name(rng);
    while (used.has(n.toLowerCase())) {
      n = `${n}-${i}`;
    }
    used.add(n.toLowerCase());
    const label: Json = { name: n };
    if (rng.bool(0.8)) {
      label.color = rng.pick(HEX_COLORS);
    }
    if (rng.bool(0.5)) {
      label.description = rng.pick(["", "does a thing", name(rng)]);
    }
    labels.push(label);
  }
  return labels;
}

function genRepository(rng: Rng): Json {
  const repo: Json = {};
  if (rng.bool()) {
    repo.has_issues = rng.bool();
  }
  if (rng.bool()) {
    repo.has_wiki = rng.bool();
  }
  if (rng.bool()) {
    repo.allow_merge_commit = rng.bool();
  }
  if (rng.bool(0.5)) {
    repo.topics = Array.from({ length: rng.int(3) + 1 }, () =>
      rng.pick(["automation", "governance", "settings", "infra"]),
    );
  }
  if (rng.bool(0.4)) {
    repo.enable_vulnerability_alerts = rng.bool();
  }
  // Always leave at least one key so the section does real work.
  if (Object.keys(repo).length === 0) {
    repo.has_issues = rng.bool();
  }
  return repo;
}

function genRulesets(rng: Rng): Json[] {
  return Array.from({ length: rng.int(2) + 1 }, (_, i) => {
    const target = rng.pick(["branch", "tag"] as const);
    return {
      name: `${rng.pick(["protect", "guard", "lock"])}-${i}`,
      target,
      enforcement: rng.pick(["active", "disabled", "evaluate"]),
      conditions: {
        ref_name: {
          include: [target === "tag" ? "~ALL" : "~DEFAULT_BRANCH"],
          exclude: [],
        },
      },
      rules: [{ type: rng.pick(["deletion", "non_fast_forward", "required_signatures"]) }],
    };
  });
}

function genBranches(rng: Rng): Json[] {
  return Array.from({ length: rng.int(2) + 1 }, (_, i) => {
    const name = `${rng.pick(["main", "release", "dev"])}-${i}`;
    if (rng.bool(0.3)) {
      return { name, protection: null };
    }
    // A random subset of the four core protection keys, with realistic values;
    // the handler null-fills the omitted ones, so any subset is valid input.
    const protection: Json = {};
    if (rng.bool(0.6)) {
      protection.required_pull_request_reviews = {
        required_approving_review_count: rng.int(3) + 1,
      };
    }
    if (rng.bool(0.5)) {
      protection.enforce_admins = rng.bool();
    }
    if (rng.bool(0.4)) {
      protection.required_status_checks = { strict: rng.bool(), contexts: [] };
    }
    if (rng.bool(0.3)) {
      protection.restrictions = null;
    }
    // Guarantee at least one core key so the payload is not empty.
    if (Object.keys(protection).length === 0) {
      const key = rng.pick(PROTECTION_CORE_KEYS);
      protection[key] = key === "enforce_admins" ? true : null;
    }
    return { name, protection };
  });
}

function genEnvironments(rng: Rng): Json[] {
  return Array.from({ length: rng.int(2) + 1 }, (_, i) => {
    const env: Json = { name: `${rng.pick(["staging", "prod", "qa"])}-${i}` };
    if (rng.bool()) {
      env.wait_timer = rng.int(30);
    }
    if (rng.bool()) {
      env.prevent_self_review = rng.bool();
    }
    return env;
  });
}

function genAutolinks(rng: Rng): Json[] {
  return Array.from({ length: rng.int(2) + 1 }, (_, i) => ({
    key_prefix: `${rng.pick(["JIRA", "TICKET", "REF"])}-${i}-`,
    url_template: `https://example.com/browse/<num>?ref=${i}`,
    is_alphanumeric: rng.bool(),
  }));
}

function genActions(rng: Rng): Json {
  const actions: Json = {};
  if (rng.bool()) {
    actions.default_workflow_permissions = rng.pick(["read", "write"]);
  }
  if (rng.bool()) {
    actions.can_approve_pull_request_reviews = rng.bool();
  }
  // Coupling: selected_actions only applies under allowed_actions "selected".
  if (rng.bool(0.5)) {
    actions.allowed_actions = "selected";
    actions.selected_actions = {
      github_owned_allowed: rng.bool(),
      verified_allowed: rng.bool(),
      patterns_allowed: [`${rng.pick(["actions", "octo"])}/*`],
    };
  } else if (rng.bool()) {
    actions.allowed_actions = rng.pick(["all", "local_only"]);
  }
  if (rng.bool(0.3)) {
    actions.access_level = rng.pick(["none", "user", "organization"]);
  }
  if (Object.keys(actions).length === 0) {
    actions.default_workflow_permissions = rng.pick(["read", "write"]);
  }
  return actions;
}

function genWorkflows(rng: Rng): Json[] {
  return Array.from({ length: rng.int(2) + 1 }, (_, i) => ({
    path: `.github/workflows/${rng.pick(["ci", "release", "lint"])}-${i}.yml`,
    state: rng.pick(["active", "disabled"] as const),
  }));
}

function genPages(rng: Rng): Json | null {
  if (rng.bool(0.25)) {
    return null;
  }
  // source is required to CREATE Pages (the POST body must carry it), and the
  // generator never seeds Pages into live state, so every Pages scenario is a
  // create - always emit source. Other fields are optional extras.
  const pages: Json = {
    source: { branch: rng.pick(["main", "gh-pages"]), path: rng.pick(["/", "/docs"]) },
  };
  if (rng.bool(0.4)) {
    pages.https_enforced = rng.bool();
  }
  return pages;
}

/**
 * The code-scanning default-setup languages the real API accepts (the enum from
 * GitHub's OpenAPI). The published settings schema is looser, but the mock
 * validates the PATCH request body against the real spec, so the generator must
 * emit only these canonical values.
 */
const CODE_SCANNING_LANGUAGES = [
  "actions",
  "c-cpp",
  "csharp",
  "go",
  "java-kotlin",
  "javascript-typescript",
  "python",
  "ruby",
  "swift",
] as const;

function genCodeScanning(rng: Rng): Json {
  const cfg: Json = { state: rng.pick(["configured", "not-configured"]) };
  if (rng.bool()) {
    cfg.query_suite = rng.pick(["default", "extended"]);
  }
  if (rng.bool()) {
    cfg.query_suite = rng.pick(["default", "extended"]);
  }
  if (rng.bool(0.5)) {
    cfg.languages = Array.from({ length: rng.int(3) + 1 }, () => rng.pick(CODE_SCANNING_LANGUAGES));
  }
  return cfg;
}

function genCollaborators(rng: Rng): Json[] {
  const used = new Set<string>();
  const out: Json[] = [];
  const count = rng.int(3) + 1;
  for (let i = 0; i < count; i++) {
    const username = `${rng.pick(["octocat", "hubot", "dev"])}-${i}`;
    if (used.has(username.toLowerCase())) {
      continue;
    }
    used.add(username.toLowerCase());
    out.push({ username, permission: rng.pick(["pull", "push", "maintain", "admin"]) });
  }
  return out;
}

function genTeams(rng: Rng): Json[] {
  return Array.from({ length: rng.int(2) + 1 }, (_, i) => ({
    name: `${rng.pick(["core", "reviewers", "ops"])}-${i}`,
    permission: rng.pick(["pull", "push", "maintain", "admin"]),
  }));
}

function genMilestones(rng: Rng): Json[] {
  const used = new Set<string>();
  const out: Json[] = [];
  const count = rng.int(3) + 1;
  for (let i = 0; i < count; i++) {
    const title = `${rng.pick(["v1", "v2", "backlog"])}-${i}`;
    if (used.has(title)) {
      continue;
    }
    used.add(title);
    const m: Json = { title };
    if (rng.bool()) {
      m.description = rng.pick(["", "the milestone", name(rng)]);
    }
    if (rng.bool()) {
      m.state = rng.pick(["open", "closed"]);
    }
    if (rng.bool(0.4)) {
      m.due_on = rng.pick(DUE_DATES);
    }
    out.push(m);
  }
  return out;
}

const SETTINGS_GENERATORS: Record<SectionKey, (rng: Rng) => unknown> = {
  repository: genRepository,
  labels: genLabels,
  rulesets: genRulesets,
  branches: genBranches,
  environments: genEnvironments,
  autolinks: genAutolinks,
  actions: genActions,
  workflows: genWorkflows,
  pages: genPages,
  code_scanning_default_setup: genCodeScanning,
  collaborators: genCollaborators,
  teams: genTeams,
  milestones: genMilestones,
};

/** A valid-shaped settings value for one section. */
export function genSettings(rng: Rng, key: SectionKey): unknown {
  return SETTINGS_GENERATORS[key](rng);
}

/** How generated live state relates to the declared settings. */
export type LiveStateKind = "absent" | "divergent" | "matching";

/**
 * Random mock live state for one section, keyed by the section's LiveState
 * family. "absent" leaves the resource missing (drift or a create), "matching"
 * mirrors the settings (convergence), "divergent" differs (drift or an update).
 * Only the families the mock reads as GET-side bodies are populated; the mock
 * fills the rest from fixtures.
 */
export function genLiveState(
  rng: Rng,
  key: SectionKey,
  settings: unknown,
): { kind: LiveStateKind; state: Json } {
  const kind = rng.pick(["absent", "divergent", "matching"] as const);
  if (kind === "absent") {
    return { kind, state: {} };
  }

  switch (key) {
    case "labels": {
      const declared = settings as Json[];
      const labels = declared.map((label) => ({
        name: label.name,
        color: kind === "matching" ? (label.color ?? "ededed") : "123456",
        description: kind === "matching" ? (label.description ?? "") : "changed",
      }));
      return { kind, state: { labels } };
    }
    case "repository": {
      const declared = settings as Json;
      const repo: Json = {};
      for (const [k, v] of Object.entries(declared)) {
        if (k === "topics" || k.startsWith("enable_")) {
          continue;
        }
        repo[k] = kind === "matching" ? v : negate(v);
      }
      return { kind, state: { repo } };
    }
    case "milestones": {
      const declared = settings as Json[];
      const milestones = declared.map((m, i) => ({
        number: i + 1,
        title: m.title,
        description: kind === "matching" ? (m.description ?? null) : "changed",
        state: kind === "matching" ? (m.state ?? "open") : "closed",
      }));
      return { kind, state: { milestones } };
    }
    default:
      // For families whose GET shape the generator does not model precisely,
      // fall back to absent state; the section still exercises a create path.
      return { kind: "absent", state: {} };
  }
}

/** Flip a boolean; leave other JSON values as a sentinel-different value. */
function negate(value: unknown): unknown {
  if (typeof value === "boolean") {
    return !value;
  }
  if (typeof value === "number") {
    return value + 1;
  }
  return "divergent";
}

/**
 * Seed the live state that makes the "configure but cannot create" sections
 * converge: every declared branch name is present in `live_state.branches` (so a
 * protection PUT has a branch to attach to), and every declared workflow path is
 * present in `live_state.workflows` at its declared state (so enable/disable is a
 * no-op or a single flip that then converges). Returns undefined when the
 * settings declare neither section, leaving the scenario's live state absent.
 */
function presenceLiveState(settings: Json): LiveState | undefined {
  const live: LiveState = {};
  const branches = settings.branches as Json[] | undefined;
  if (Array.isArray(branches)) {
    live.branches = branches.map((b) => String(b.name));
  }
  const workflows = settings.workflows as Json[] | undefined;
  if (Array.isArray(workflows)) {
    live.workflows = workflows.map((w, i) => ({
      id: i + 1,
      name: String(w.path),
      path: String(w.path),
      state: w.state === "disabled" ? "disabled_manually" : "active",
    }));
  }
  return live.branches || live.workflows ? live : undefined;
}

let validator: ValidateFunction | undefined;

/** Compile (once) the ajv validator for the published settings schema. */
function settingsValidator(): ValidateFunction {
  if (!validator) {
    const ajv = new Ajv({ strict: false, allErrors: true });
    const add = (addFormats as unknown as { default?: typeof addFormats }).default ?? addFormats;
    (add as typeof addFormats)(ajv);
    validator = ajv.compile(settingsSchema);
  }
  return validator;
}

/**
 * Validate a whole settings document against the PUBLISHED JSON schema
 * (lib/settings.schema.json). Throws with the ajv errors when it does not
 * match. This is one leg of the three-way drift check: a generated doc must
 * satisfy this, src's validateSettingsDoc, and each section's zod shape.
 */
export function validateAgainstPublishedSchema(doc: unknown): void {
  const validate = settingsValidator();
  if (!validate(doc)) {
    const errors = (validate.errors ?? [])
      .map((e) => `  ${e.instancePath || "(root)"} ${e.message}`)
      .join("\n");
    throw new Error(`generated settings failed schema validation:\n${errors}`);
  }
}

/** Options steering scenario generation, e.g. a biased or fixed section set. */
export interface GenScenarioOptions {
  /** Restrict generation to these sections (a smoke or PR-diff subset). */
  sections?: SectionKey[];
}

const MASK_KEYS: MaskKey[] = [
  "administration",
  "issues",
  "environments",
  "actions",
  "pages",
  "code_scanning_alerts",
  "contents",
  "org_members",
];

/**
 * The generation facts the oracle (Phase 3b) needs to predict an outcome
 * class without re-parsing the scenario: which sections are declared, the
 * permission mask, the denial style, and the mode/policy/owner_kind.
 */
export interface ScenarioMeta {
  sections: SectionKey[];
  mask: Partial<Record<MaskKey, MaskGrade>>;
  mode: "apply" | "check";
  policy: "fail" | "warn";
  ownerKind: OwnerKind;
  denialStyle: DenialStyle;
  requiredSections: SectionKey[];
}

/**
 * A random whole scenario plus the generation metadata the oracle consumes.
 * The scenario's settings pass the published schema; required_sections are
 * drawn only from the declared sections so the scenario is internally
 * consistent. denial_style is random between 403 and fine_grained (the two
 * styles the oracle reasons about). The returned meta echoes the raw
 * generation facts so the oracle does not re-derive them from the scenario.
 */
export function genScenario(
  rng: Rng,
  options: GenScenarioOptions = {},
): { scenario: Scenario; meta: ScenarioMeta } {
  const pool = options.sections ?? [...SECTION_KEYS];
  const chosen = pool.filter(() => rng.bool(0.5));
  if (chosen.length === 0) {
    chosen.push(rng.pick(pool));
  }

  const settings: Json = {};
  for (const key of chosen) {
    settings[key] = genSettings(rng.fork(`settings:${key}`), key);
  }
  validateAgainstPublishedSchema(settings);

  // Seed live state for the sections whose resource the action can configure but
  // NOT create: branches (a protection PUT needs the branch to exist) and
  // workflows (a workflow can only be enabled/disabled if its file is present).
  // Without this the declared branch/workflow permanently drifts with a skip
  // note ("does not exist ... apply will skip it") and never converges, which is
  // correct engine behavior but not what a fully-granted apply should model. So
  // the generated live state contains every declared branch name and workflow
  // path, letting apply act on them and check converge.
  const liveState = presenceLiveState(settings);

  const mask: Partial<Record<MaskKey, MaskGrade>> = {};
  for (const resource of MASK_KEYS) {
    if (rng.bool(0.4)) {
      mask[resource] = rng.pick(["none", "read", "write"] as const);
    }
  }

  const mode = rng.pick(["apply", "check"] as const);
  const policy = rng.pick(["fail", "warn"] as const);
  const ownerKind: OwnerKind = rng.pick(["org", "user"] as const);
  const denialStyle: DenialStyle = rng.pick(["fine_grained", 403] as const);
  const requiredSections = chosen.filter(() => rng.bool(0.25));

  const scenario: Scenario = {
    name: `fuzz-${rng.seed}`,
    tiers: ["mock"],
    settings,
    inputs: {
      mode,
      on_missing_permission: policy,
      ...(requiredSections.length > 0 ? { required_sections: requiredSections.join(",") } : {}),
    },
    token_permissions: Object.keys(mask).length > 0 ? mask : undefined,
    denial_style: denialStyle,
    owner_kind: ownerKind,
    ...(liveState ? { live_state: liveState } : {}),
    // The oracle predicts the outcome class in Phase 3b; a generated scenario
    // carries a placeholder expect until the oracle fills it.
    expect: { exit_code: 0 },
  };
  const meta: ScenarioMeta = {
    sections: chosen,
    mask,
    mode,
    policy,
    ownerKind,
    denialStyle,
    requiredSections,
  };
  return { scenario, meta };
}

/** Generation facts for one target repo in a multi-repo scenario. */
export interface MultiRepoMeta {
  slug: string;
  /** null when this repo has no settings file (the action skips it). */
  meta: ScenarioMeta | null;
}

/** The generation facts a multi-repo scenario's oracle rollup consumes. */
export interface MultiScenarioMeta {
  repos: MultiRepoMeta[];
  mode: "apply" | "check";
  policy: "fail" | "warn";
  /**
   * The slug of the target that opted out of the defaults' milestones section
   * (set milestones: null), or undefined when no target opted out. Recorded so
   * the oracle and tests can reason about the inherited-section fold.
   */
  milestonesOptOutSlug?: string;
}

/**
 * A random multi-repo scenario: 2 to 5 target repos, each with its own
 * generated settings, live state, and permission mask. One repo is randomly
 * left without a settings file, which the action skips. A defaults file merged
 * under every target may null out one section (the opt-out path). The returned
 * meta lists each repo's ScenarioMeta (null for the skipped one) for the
 * per-repo oracle plus the worst-of rollup.
 */
export function genMultiScenario(rng: Rng): { scenario: Scenario; meta: MultiScenarioMeta } {
  const count = rng.int(4) + 2; // 2..5
  const mode = rng.pick(["apply", "check"] as const);
  const policy = rng.pick(["fail", "warn"] as const);
  const denialStyle: DenialStyle = rng.pick(["fine_grained", 403] as const);
  // One repo (chosen up front) is missing its settings file, so it is skipped.
  const missingIndex = rng.int(count);

  const repos: Record<string, unknown> = {};
  const repoMetas: MultiRepoMeta[] = [];
  for (let i = 0; i < count; i++) {
    const slug = `e2e-owner/repo-${i}`;
    if (i === missingIndex) {
      // No settings file: the action reads a 404 and skips the target.
      repos[slug] = { settings: null };
      repoMetas.push({ slug, meta: null });
      continue;
    }
    const child = rng.fork(`repo:${i}`);
    // A random section subset with its own settings and mask, sharing the run's
    // mode and policy. teams is included now that the multi-repo mock serves the
    // org-level probe (GET /orgs/{owner}) from shared org state under the global
    // mask, so per-repo teams exercises the org-members AND-gate too.
    const pool = [...SECTION_KEYS];
    const sections = pool.filter(() => child.bool(0.5));
    if (sections.length === 0) {
      sections.push(child.pick(pool));
    }
    const settings: Json = {};
    for (const key of sections) {
      settings[key] = genSettings(child.fork(`settings:${key}`), key);
    }
    validateAgainstPublishedSchema(settings);
    const mask: Partial<Record<MaskKey, MaskGrade>> = {};
    for (const resource of MASK_KEYS) {
      if (child.bool(0.3)) {
        mask[resource] = child.pick(["none", "read", "write"] as const);
      }
    }
    // Seed each target's live state the same way single-repo genScenario does,
    // so a target's declared branches/workflows exist and converge instead of
    // drifting on a permanent skip note.
    const targetLive = presenceLiveState(settings);
    repos[slug] = {
      settings,
      ...(targetLive ? { live_state: targetLive } : {}),
      ...(Object.keys(mask).length > 0 ? { permissions: mask } : {}),
    };
    repoMetas.push({
      slug,
      meta: {
        sections,
        mask,
        mode,
        policy,
        ownerKind: "org",
        denialStyle,
        requiredSections: [],
      },
    });
  }

  // A defaults file merged under every target. It DECLARES a shared milestones
  // section; a target opts out by setting milestones: null in ITS OWN settings
  // (the null-section opt-out only applies to a section the defaults declare,
  // and the defaults file itself must be schema-valid, so the null lives on a
  // target, never in the defaults file). Pick one non-missing target to opt out.
  const defaultsFile: Json = {
    labels: [{ name: "shared-default", color: "cccccc" }],
    milestones: [{ title: "shared-milestone", state: "open" }],
  };
  const optOutSlugs = Object.entries(repos)
    .filter(([, spec]) => (spec as { settings: unknown }).settings !== null)
    .map(([slug]) => slug);
  let optedOutSlug: string | undefined;
  if (optOutSlugs.length > 0 && rng.bool(0.3)) {
    optedOutSlug = rng.pick(optOutSlugs);
    const spec = repos[optedOutSlug] as { settings: Json };
    spec.settings.milestones = null;
  }

  // Fold the defaults-inherited sections into each target's oracle meta: every
  // target runs the defaults' labels and milestones (merged under its own
  // settings) UNLESS it opted that section out with a null. The oracle predicts
  // from meta.sections, so a target that inherits labels but never declared it
  // must still have labels predicted - otherwise a denied inherited section
  // (e.g. labels under issues:read) is an unpredicted failure. The opt-out
  // works both ways: the null overwrites even a SELF-declared milestones on
  // that target, so the section must also be REMOVED from its meta, not just
  // skipped when adding.
  const DEFAULTS_SECTIONS: SectionKey[] = ["labels", "milestones"];
  for (const repoMeta of repoMetas) {
    if (!repoMeta.meta) {
      continue;
    }
    const optedOut = repoMeta.slug === optedOutSlug ? ["milestones"] : [];
    repoMeta.meta.sections = repoMeta.meta.sections.filter(
      (s) => !optedOut.includes(s),
    ) as SectionKey[];
    for (const inherited of DEFAULTS_SECTIONS) {
      if (!repoMeta.meta.sections.includes(inherited) && !optedOut.includes(inherited)) {
        repoMeta.meta.sections.push(inherited);
      }
    }
  }

  const scenario: Scenario = {
    name: `fuzz-multi-${rng.seed}`,
    tiers: ["mock"],
    settings: {},
    inputs: { mode, on_missing_permission: policy },
    denial_style: denialStyle,
    owner_kind: "org",
    repos: repos as Scenario["repos"],
    defaults_file: defaultsFile,
    expect: { exit_code: 0 },
  };
  return {
    scenario,
    meta: { repos: repoMetas, mode, policy, milestonesOptOutSlug: optedOutSlug },
  };
}

/** The generation facts a discovery scenario's oracle check consumes. */
export interface DiscoveryScenarioMeta {
  pool: Array<{
    slug: string;
    archived?: boolean;
    fork?: boolean;
    visibility?: string;
    topics?: string[];
  }>;
  filters: {
    visibility?: string;
    archived?: string;
    forks?: string;
    topics?: string;
    exclude?: string;
  };
}

/**
 * A random `repos: "*"` discovery scenario: a pool of 4 to 8 repos with random
 * archived/fork/visibility/topic attributes, plus a random subset of discovery
 * filters. Each pool repo carries one label so a kept repo applies. The returned
 * meta echoes the pool and filters so predictDiscovery can compute the kept set
 * INDEPENDENTLY, and the fuzz asserts the action discovered exactly those.
 */
export function genDiscoveryScenario(rng: Rng): {
  scenario: Scenario;
  meta: DiscoveryScenarioMeta;
} {
  const count = rng.int(5) + 4; // 4..8
  const TOPIC_POOL = ["platform", "infra", "legacy", "misc"];
  const pool: DiscoveryScenarioMeta["pool"] = [];
  for (let i = 0; i < count; i++) {
    const repo: DiscoveryScenarioMeta["pool"][number] = { slug: `e2e-owner/disc-${i}` };
    if (rng.bool(0.3)) {
      repo.archived = true;
    }
    if (rng.bool(0.3)) {
      repo.fork = true;
    }
    repo.visibility = rng.pick(["public", "private", "internal"]);
    if (rng.bool(0.6)) {
      repo.topics = [rng.pick(TOPIC_POOL)];
    }
    pool.push(repo);
  }

  // A random subset of filters. Each is included ~40% of the time; the values
  // are drawn from the documented allowed sets. exclude uses a glob over slugs.
  const filters: DiscoveryScenarioMeta["filters"] = {};
  if (rng.bool(0.4)) {
    filters.visibility = rng.pick(["all", "public", "private", "internal"]);
  }
  if (rng.bool(0.4)) {
    filters.archived = rng.pick(["skip", "include", "only"]);
  }
  if (rng.bool(0.4)) {
    filters.forks = rng.pick(["include", "exclude", "only"]);
  }
  if (rng.bool(0.4)) {
    filters.topics = rng.pick(TOPIC_POOL);
  }
  if (rng.bool(0.3)) {
    filters.exclude = `disc-${rng.int(count)}`;
  }

  const repos: Record<string, unknown> = {};
  for (const repo of pool) {
    repos[repo.slug] = {
      settings: { labels: [{ name: "managed", color: "00ff00" }] },
    };
  }

  const inputs: Record<string, string> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined) {
      inputs[key] = value;
    }
  }

  const scenario: Scenario = {
    name: `fuzz-discovery-${rng.seed}`,
    tiers: ["mock"],
    settings: {},
    inputs: { mode: "apply", on_missing_permission: "warn" },
    denial_style: "fine_grained",
    owner_kind: "org",
    discovery: { pool, inputs },
    repos: repos as Scenario["repos"],
    token_permissions: { issues: "write", contents: "read" },
    expect: { exit_code: 0 },
  };
  return { scenario, meta: { pool, filters } };
}
