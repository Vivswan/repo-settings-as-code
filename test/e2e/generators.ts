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
import { type MustBeNever, SECTION_KEYS, type SectionKey } from "../../src/schema.js";
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

/**
 * A fixed, valid age recipient for the `artifact` private-report channel:
 * enough for the action's config validation to accept the key and for the
 * encrypter to produce ciphertext. Generated once with age-encryption's own
 * generateX25519Identity/identityToRecipient (runner.test.ts re-validates it
 * against src's parseRecipient so it cannot silently rot), then pinned so
 * scenarios and the fuzzer share one hermetic recipient. The matching identity
 * is never needed: the harness never decrypts (the artifact upload fails with a
 * safe warning because the runner token is absent), it only proves the run
 * stays green and leaks nothing when a real key is configured.
 */
export const ARTIFACT_TEST_RECIPIENT =
  "age1wshulnlu6mpa4rx54w6xs9kscqw7uqem3fh748xsrfyqusgmfv2qfca3qt";

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

/**
 * How a section's seeded live state relates to its declared settings, as a
 * SEMANTIC WITNESS the oracle can predict from exactly:
 *
 * - "matching": the live state mirrors EVERY field the handler diffs, so a
 *   correct engine reports exactly clean (check) or a no-op applied (apply).
 * - "drift-update": one DECLARED field diverges (never an omitted optional -
 *   a divergent value in a field the settings do not declare is not drift),
 *   so check must report drift and apply must issue an update.
 * - "extra-undeclared" (labels only): a live label the settings do not
 *   declare, so check reports undeclared drift and apply DELETEs it.
 *   Milestones KEEP undeclared entries by design (no delete endpoint), so
 *   this kind is never generated for them.
 */
export type LiveWitnessKind = "matching" | "drift-update" | "extra-undeclared";

/**
 * The sections the witness generator models. Repository is deferred: a
 * faithful matching witness needs normalized topics, the enable_* toggles,
 * and fixture-aware treatment of absent fields.
 */
export const WITNESS_SECTIONS = ["labels", "milestones"] as const;
export type WitnessSection = (typeof WITNESS_SECTIONS)[number];

/** The witness kinds each modeled section supports. */
export const WITNESS_KINDS: Record<WitnessSection, readonly LiveWitnessKind[]> = {
  labels: ["matching", "drift-update", "extra-undeclared"],
  milestones: ["matching", "drift-update"],
};

/** Perturbation color: absent from HEX_COLORS, so it always reads as drift. */
const DRIFT_COLOR = "123456";
/** Perturbation description: absent from every description pool. */
const DRIFT_DESCRIPTION = "witness-drift";
/** The extra-undeclared live label; no generated name collides with it. */
const UNDECLARED_LABEL: Json = {
  name: "zz-undeclared-witness",
  color: "cccccc",
  description: "live label the settings never declare",
};

/** A generated live-state witness: the kind that actually holds, plus state. */
export interface LiveWitness {
  /**
   * The kind the state actually witnesses. May fall back to "matching" when
   * "drift-update" was requested but no entry declares a perturbable field.
   */
  kind: LiveWitnessKind;
  state: LiveState;
}

/**
 * Loud disjointness guard: a perturbation sentinel that collides with a
 * generated value would silently turn a drift witness into a matching one
 * (or an "undeclared" label into a declared one), so the collision throws
 * instead of degrading the witness.
 */
function assertSentinelDisjoint(condition: boolean, detail: string): void {
  if (!condition) {
    throw new Error(`witness sentinel collision: ${detail}`);
  }
}

/**
 * A live label body that the labels handler diffs as EXACTLY equal
 * (src/sections/labels.ts): the live label carries the FINAL name (new_name
 * wins - the handler matches by source or target key and treats any other
 * live name as rename drift), the declared color/description verbatim (they
 * are diffed only when DECLARED, so undeclared ones take fixed fillers), and
 * every extra declared key verbatim (extras are subsetDiffed as passthrough
 * fields, so a hardcoded field list would silently read as drift).
 */
function matchingLiveLabel(label: Json): Json {
  const { name, new_name, color, description, ...extras } = label;
  return {
    name: new_name ?? name,
    color: color ?? "ededed",
    description: description ?? null,
    ...extras,
  };
}

/**
 * True when uppercasing changes the name but keeps its case-insensitive key,
 * so the flipped live name still matches the declared label and the handler
 * reads it as rename drift (existing.name !== finalName).
 */
function caseFlippable(name: string): boolean {
  const flipped = name.toUpperCase();
  return flipped !== name && flipped.toLowerCase() === name.toLowerCase();
}

/**
 * The fields of one declared label a drift-update witness may perturb. The
 * name candidate flips the case of the FINAL name (new_name resolved), so the
 * divergence reads as rename drift against the post-rename state.
 */
function labelDriftFields(label: Json): Array<"color" | "description" | "name"> {
  const fields: Array<"color" | "description" | "name"> = [];
  if (label.color !== undefined) {
    fields.push("color");
  }
  if (label.description !== undefined) {
    fields.push("description");
  }
  if (caseFlippable(String(label.new_name ?? label.name))) {
    fields.push("name");
  }
  return fields;
}

function labelsWitness(rng: Rng, declared: Json[], kind: LiveWitnessKind): LiveWitness {
  const labels = declared.map(matchingLiveLabel);
  if (kind === "matching") {
    return { kind, state: { labels } };
  }
  if (kind === "extra-undeclared") {
    const undeclaredKey = String(UNDECLARED_LABEL.name).toLowerCase();
    for (const label of declared) {
      assertSentinelDisjoint(
        String(label.name).toLowerCase() !== undeclaredKey &&
          String(label.new_name ?? label.name).toLowerCase() !== undeclaredKey,
        `a declared label resolves to the undeclared sentinel "${undeclaredKey}"`,
      );
    }
    return { kind, state: { labels: [...labels, { ...UNDECLARED_LABEL }] } };
  }
  const eligible = declared
    .map((label, index) => ({ index, fields: labelDriftFields(label) }))
    .filter((entry) => entry.fields.length > 0);
  if (eligible.length === 0) {
    return { kind: "matching", state: { labels } };
  }
  const { index, fields } = rng.pick(eligible);
  const source = declared[index] as Json;
  const live = labels[index] as Json;
  const field = rng.pick(fields);
  if (field === "color") {
    assertSentinelDisjoint(
      source.color !== DRIFT_COLOR,
      `the label color pool contains ${DRIFT_COLOR}`,
    );
    live.color = DRIFT_COLOR;
  } else if (field === "description") {
    assertSentinelDisjoint(
      source.description !== DRIFT_DESCRIPTION,
      `the label description pool contains "${DRIFT_DESCRIPTION}"`,
    );
    live.description = DRIFT_DESCRIPTION;
  } else {
    live.name = String(source.new_name ?? source.name).toUpperCase();
  }
  return { kind: "drift-update", state: { labels } };
}

/**
 * A live milestone body the milestones handler diffs as EXACTLY equal
 * (src/sections/milestones.ts): the handler subsetDiffs EVERY declared field
 * verbatim, passthrough fields included, so the whole declaration is spread
 * over the handler-visible defaults - a future passthrough field is mirrored
 * automatically instead of silently reading as drift.
 */
function matchingLiveMilestone(milestone: Json, index: number): Json {
  return {
    id: 910_000 + index,
    number: index + 1,
    state: "open",
    description: null,
    ...milestone,
  };
}

/** The fields of one declared milestone a drift-update witness may perturb. */
function milestoneDriftFields(milestone: Json): Array<"description" | "state" | "due_on"> {
  const fields: Array<"description" | "state" | "due_on"> = [];
  if (milestone.description !== undefined) {
    fields.push("description");
  }
  if (milestone.state !== undefined) {
    fields.push("state");
  }
  if (milestone.due_on !== undefined) {
    fields.push("due_on");
  }
  return fields;
}

function milestonesWitness(rng: Rng, declared: Json[], kind: LiveWitnessKind): LiveWitness {
  const milestones = declared.map(matchingLiveMilestone);
  if (kind === "matching") {
    return { kind, state: { milestones } };
  }
  const eligible = declared
    .map((milestone, index) => ({ index, fields: milestoneDriftFields(milestone) }))
    .filter((entry) => entry.fields.length > 0);
  if (eligible.length === 0) {
    // Every milestone declares only its title: no field can legitimately
    // diverge, so the witness degrades to matching (and says so).
    return { kind: "matching", state: { milestones } };
  }
  const { index, fields } = rng.pick(eligible);
  const source = declared[index] as Json;
  const live = milestones[index] as Json;
  const field = rng.pick(fields);
  if (field === "description") {
    assertSentinelDisjoint(
      source.description !== DRIFT_DESCRIPTION,
      `the milestone description pool contains "${DRIFT_DESCRIPTION}"`,
    );
    live.description = DRIFT_DESCRIPTION;
  } else if (field === "state") {
    live.state = source.state === "open" ? "closed" : "open";
  } else {
    live.due_on = rng.pick(DUE_DATES.filter((d) => d !== source.due_on));
  }
  return { kind: "drift-update", state: { milestones } };
}

/**
 * A live-state witness for one section: mock live state with a KNOWN semantic
 * relation to the declared settings, so the oracle can pin the exact outcome
 * class instead of accepting {clean, drift} either way. Returns the kind that
 * actually holds (drift-update falls back to matching when nothing is
 * perturbable); callers that need a specific kind must check it.
 */
export function genLiveWitness(
  rng: Rng,
  key: WitnessSection,
  settings: unknown,
  kind: LiveWitnessKind,
): LiveWitness {
  if (!WITNESS_KINDS[key].includes(kind)) {
    throw new Error(`genLiveWitness: ${key} does not support the "${kind}" witness`);
  }
  const declared = settings as Json[];
  return key === "labels"
    ? labelsWitness(rng, declared, kind)
    : milestonesWitness(rng, declared, kind);
}

// --- Invalid-settings catalog (input-mode fuzz) -----------------------------

/**
 * One deliberately invalid settings document plus a token the action's
 * rejection error must contain: a section path ("labels[2].name"), an unknown
 * top-level key, or a fixed wording fragment. Every case is a violation
 * validateSettingsDoc GENUINELY rejects. Values the loose shapes accept by
 * design stay out of the catalog - unknown nested keys, un-modeled enums
 * (milestones.state, every actions field), arbitrary field types on loose
 * keys, `pages: null`, and underscore-prefixed top-level keys - because
 * generating them would assert failures the contract does not promise.
 */
export interface InvalidSettingsCase {
  doc: Json;
  offendingToken: string;
}

/** The sections whose settings value is a list. */
const ARRAY_SECTIONS = [
  "labels",
  "rulesets",
  "branches",
  "environments",
  "autolinks",
  "workflows",
  "collaborators",
  "teams",
  "milestones",
] as const satisfies readonly SectionKey[];

/** The sections whose settings value is a plain record (anyRecord shapes). */
const RECORD_SECTIONS = [
  "repository",
  "actions",
  "code_scanning_default_setup",
] as const satisfies readonly SectionKey[];

/**
 * Compile-time exhaustiveness: every section is classified as array, record,
 * or pages (the one nullable-object section, covered by its own catalog
 * cases). A new section that lands unclassified fails here instead of
 * silently missing wrong-container fuzzing.
 */
type CoveredSection = (typeof ARRAY_SECTIONS)[number] | (typeof RECORD_SECTIONS)[number] | "pages";
type _UnclassifiedSection = MustBeNever<Exclude<SectionKey, CoveredSection>>;

/** The required string field each array section's item shape enforces. */
const NATURAL_KEYS: Record<(typeof ARRAY_SECTIONS)[number], string> = {
  labels: "name",
  rulesets: "name",
  branches: "name",
  environments: "name",
  autolinks: "key_prefix",
  workflows: "path",
  collaborators: "username",
  teams: "name",
  milestones: "title",
};

/** A valid generated array-section value plus a random item index to break. */
function validItems(
  rng: Rng,
  key: (typeof ARRAY_SECTIONS)[number],
): { value: Json[]; index: number } {
  const value = genSettings(rng.fork("valid"), key) as Json[];
  return { value, index: rng.int(value.length) };
}

/**
 * The named rejection catalog. The fuzz stream draws random members and the
 * directed input battery runs every member each run, so a validator or
 * generator regression on any case fails loudly instead of hiding behind the
 * random draw.
 */
export const INVALID_SETTINGS_CASES: ReadonlyArray<{
  name: string;
  build: (rng: Rng) => InvalidSettingsCase;
}> = [
  {
    name: "unknown-top-level-key",
    build: (rng) => {
      // Near-miss typos of real section names; none underscore-prefixed
      // (those are accepted as private keys by design).
      const typo = rng.pick(["labelz", "label", "milestone", "repositories", "branch"]);
      return {
        doc: { labels: genSettings(rng.fork("labels"), "labels") as Json, [typo]: [] },
        offendingToken: typo,
      };
    },
  },
  {
    name: "array-section-wrong-type",
    build: (rng) => {
      const key = rng.pick(ARRAY_SECTIONS);
      // { not: "an array" } keeps the input block's original fixed doc
      // reachable as one member of this case.
      return { doc: { [key]: rng.pick([{ not: "an array" }, "oops", 7]) }, offendingToken: key };
    },
  },
  {
    name: "record-section-wrong-type",
    build: (rng) => {
      const key = rng.pick(RECORD_SECTIONS);
      return { doc: { [key]: rng.pick(["oops", 7, [1], null] as const) }, offendingToken: key };
    },
  },
  {
    name: "pages-wrong-type",
    build: (rng) => ({
      doc: { pages: rng.pick(["gh-pages", [1]] as const) },
      offendingToken: "pages",
    }),
  },
  {
    name: "scalar-item",
    build: (rng) => {
      const key = rng.pick(ARRAY_SECTIONS);
      const { value, index } = validItems(rng, key);
      (value as unknown[])[index] = "oops";
      return { doc: { [key]: value }, offendingToken: `${key}[${index}]` };
    },
  },
  {
    name: "missing-natural-key",
    build: (rng) => {
      const key = rng.pick(ARRAY_SECTIONS);
      const { value, index } = validItems(rng, key);
      delete (value[index] as Json)[NATURAL_KEYS[key]];
      return { doc: { [key]: value }, offendingToken: `${key}[${index}].${NATURAL_KEYS[key]}` };
    },
  },
  {
    name: "non-string-natural-key",
    build: (rng) => {
      const key = rng.pick(ARRAY_SECTIONS);
      const { value, index } = validItems(rng, key);
      (value[index] as Json)[NATURAL_KEYS[key]] = 42;
      return { doc: { [key]: value }, offendingToken: `${key}[${index}].${NATURAL_KEYS[key]}` };
    },
  },
  {
    name: "labels-new-name-not-a-string",
    build: (rng) => {
      const { value, index } = validItems(rng, "labels");
      (value[index] as Json).new_name = 7;
      return { doc: { labels: value }, offendingToken: `labels[${index}].new_name` };
    },
  },
  {
    name: "branches-protection-missing",
    build: (rng) => {
      // protection is REQUIRED (nullable, not optional) on every branch entry.
      const { value, index } = validItems(rng, "branches");
      delete (value[index] as Json).protection;
      return { doc: { branches: value }, offendingToken: `branches[${index}].protection` };
    },
  },
  {
    name: "workflows-state-enum",
    build: (rng) => {
      // The one enum any loose shape enforces.
      const { value, index } = validItems(rng, "workflows");
      (value[index] as Json).state = rng.pick(["paused", "enabled", "on"]);
      return { doc: { workflows: value }, offendingToken: `workflows[${index}].state` };
    },
  },
  {
    name: "rulesets-include-not-a-list",
    build: (rng) => {
      // The classic missing "-" typo the rulesets shape exists to catch.
      const { value, index } = validItems(rng, "rulesets");
      (value[index] as Json).conditions = { ref_name: { include: "main" } };
      return {
        doc: { rulesets: value },
        offendingToken: `rulesets[${index}].conditions.ref_name.include`,
      };
    },
  },
  {
    name: "pages-source-not-an-object",
    build: () => ({
      doc: { pages: { source: "main" } },
      offendingToken: "pages.source",
    }),
  },
  {
    name: "pages-source-branch-missing",
    build: () => ({
      doc: { pages: { source: { path: "/" } } },
      offendingToken: "pages.source.branch",
    }),
  },
];

/**
 * One random catalog case, tagged with its case name so callers can label
 * failures and coverage checks can prove every case is actually drawn.
 */
export function genInvalidSettings(rng: Rng): InvalidSettingsCase & { name: string } {
  const { name, build } = rng.pick(INVALID_SETTINGS_CASES);
  return { name, ...build(rng) };
}

/**
 * Raw settings bodies the yaml parser GENUINELY throws on (each verified
 * against the yaml package: unclosed flow collections, an unterminated
 * quote, a compact nested mapping). Single-repo they hit the "cannot read
 * settings ... valid YAML" read path; multi-repo the "cannot parse <slug>"
 * target gate. Both fire before any section runs.
 */
export const UNPARSEABLE_YAML = [
  "labels: [oops, unclosed",
  "{",
  "a: b\n  c: d",
  'key: "unterminated',
  "a: [1, 2\nb: 3",
] as const;

/**
 * Raw bodies that PARSE fine but not to a mapping, so they pass the yaml
 * parser and fail validateSettingsDoc's top-level check ("must be a YAML
 * mapping ... parsed as a list/string") instead. In multi mode the
 * defaults merge passes a non-mapping through wholesale (engine/merge.ts
 * deepMerge replaces on a non-object override), so the same wording fires
 * there with the slug as the source label.
 */
export const NON_MAPPING_YAML = ["- a\n- b", "just a string"] as const;

/**
 * Seed the live state that makes the "configure but cannot create" sections
 * converge: every declared branch name is present in `live_state.branches` (so a
 * protection PUT has a branch to attach to), and every declared workflow path is
 * present in `live_state.workflows` at its declared state (so enable/disable is a
 * no-op or a single flip that then converges). Returns undefined when the
 * settings declare neither section, leaving the scenario's live state absent.
 * Exported for the fault fuzz, whose single-section scenarios need the same
 * presence seeding to converge.
 */
export function presenceLiveState(settings: Json): LiveState | undefined {
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

// --- Fault-target catalog (fault-mode fuzz) ---------------------------------

/**
 * The one read each section issues UNCONDITIONALLY - in BOTH modes - whenever
 * the section is declared, as the "section.role" fault key the mock accepts.
 * A fault aimed here is guaranteed to fire, which the fuzz iteration's
 * faultsFired assertion turns into a non-vacuity proof. Sections whose first
 * read is conditional or check-mode-only are deliberately absent: repository,
 * environments, and code_scanning_default_setup read only under check (apply
 * writes unconditionally), and branches/actions gate their reads on the
 * declared keys - a fault aimed at a read that never happens would fail the
 * non-vacuity assertion instead of testing anything.
 */
export const SECTION_PRIMARY_READ = {
  labels: "labels.list",
  rulesets: "rulesets.list",
  autolinks: "autolinks.list",
  workflows: "workflows.list",
  collaborators: "collaborators.list",
  teams: "teams.org",
  milestones: "milestones.list",
  pages: "pages.get",
} as const satisfies Partial<Record<SectionKey, string>>;

export type FaultableSection = keyof typeof SECTION_PRIMARY_READ;

/**
 * The sections deliberately absent from SECTION_PRIMARY_READ (the reasons are
 * in its doc). Together the two lists must cover every SectionKey: a NEW
 * section that lands unclassified fails this exhaustiveness check instead of
 * silently escaping fault fuzzing.
 */
const UNFAULTABLE_SECTIONS = [
  "repository",
  "branches",
  "environments",
  "actions",
  "code_scanning_default_setup",
] as const satisfies readonly SectionKey[];
type FaultClassified = FaultableSection | (typeof UNFAULTABLE_SECTIONS)[number];
type _UnclassifiedFaultSection = MustBeNever<Exclude<SectionKey, FaultClassified>>;

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
  /**
   * The `sections` (INPUT_SECTIONS) allowlist the run was generated under,
   * when one is set; undefined means no allowlist, every declared section
   * runs. The engine reports a declared-but-not-allowlisted section as
   * "excluded" BEFORE its handler runs (orchestrate.ts), so the oracle folds
   * exclusion ahead of grades and witnesses. Generation does not set this
   * yet; it exists so the sections-allowlist fuzz (Commit 7) cannot silently
   * mispredict a witnessed or denied section.
   */
  onlySections?: SectionKey[];
  /**
   * The live-state witness seeded per section (labels and milestones only):
   * the KNOWN semantic relation between the generated live state and the
   * declared settings, so the oracle can pin the exact success outcome. A
   * section without an entry has no witness (absent live state, or a family
   * the witness generator does not model) and keeps the loose prediction.
   */
  liveKinds?: Partial<Record<SectionKey, LiveWitnessKind>>;
  /**
   * The GLOBAL token mask, distinct from `mask` (the effective per-slug mask)
   * ONLY in multi-repo mode. teams' org-scoped endpoints are graded by the mock
   * against this global mask's org_members, not the per-slug overlay, so the
   * oracle uses it for the teams org gate. Absent (undefined) in single-repo
   * mode, where the effective mask IS the global mask.
   */
  orgMask?: Partial<Record<MaskKey, MaskGrade>>;
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
  const presence = presenceLiveState(settings) ?? {};

  // Live-state WITNESSES for labels and milestones: seed live state whose
  // relation to the declared settings is known (matching, drift-update,
  // extra-undeclared), so the oracle predicts the exact outcome instead of
  // accepting {clean, drift} either way - a false-negative drift detector
  // would otherwise pass every iteration. A quarter of the time the section
  // keeps absent live state, preserving the create path.
  const liveKinds: Partial<Record<SectionKey, LiveWitnessKind>> = {};
  const witnessState: LiveState = {};
  for (const key of WITNESS_SECTIONS) {
    if (!chosen.includes(key)) {
      continue;
    }
    const witnessRng = rng.fork(`witness:${key}`);
    if (witnessRng.bool(0.25)) {
      continue;
    }
    const kind = witnessRng.pick(WITNESS_KINDS[key]);
    const witness = genLiveWitness(witnessRng, key, settings[key], kind);
    liveKinds[key] = witness.kind;
    Object.assign(witnessState, witness.state);
  }

  const combinedLive: LiveState = { ...presence, ...witnessState };
  const liveState = Object.keys(combinedLive).length > 0 ? combinedLive : undefined;

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
    liveKinds,
  };
  return { scenario, meta };
}

/**
 * What one multi-repo target IS. The discriminant makes the illegal
 * combinations unrepresentable: only a normal target carries a ScenarioMeta,
 * and only a raw-invalid one carries a raw kind ("unparseable" bodies throw
 * in the yaml parser - the "cannot parse <slug>" gate; "non-mapping" bodies
 * parse to a list/scalar and fail the top-level validator). Both raw kinds
 * fail the target before any section runs.
 */
export type MultiRepoTarget =
  | { kind: "normal"; meta: ScenarioMeta }
  | { kind: "missing" }
  | { kind: "raw-invalid"; raw: "unparseable" | "non-mapping" };

/** Generation facts for one target repo in a multi-repo scenario. */
export interface MultiRepoMeta {
  slug: string;
  /**
   * The target's kind plus its kind-specific facts: "normal" runs sections
   * under its meta, "missing" has no settings file (the action skips it),
   * "raw-invalid" serves settings_raw that fails before any section runs.
   */
  target: MultiRepoTarget;
  /** The visibility planted in this target's mock repo (drives the redaction rule). */
  visibility: "public" | "private" | "internal";
  /**
   * True when this target's administration-gated visibility probe is denied
   * (mask.administration === "none"), so the resolver reads "unknown" and
   * redaction fails closed regardless of the planted visibility.
   */
  probeDenied: boolean;
  /**
   * True when the oracle expects this target hidden from the public view:
   * policy is redact, the slug is not the self slug, and it is private/internal
   * OR its probe was denied. Its repos-result key is a placeholder, and its
   * canaries must leak into no public surface.
   */
  redacted: boolean;
  /** The repos-result KEY the action emits: the placeholder when redacted, else the slug. */
  displayKey: string;
  /**
   * Unique strings planted in this target's private surfaces (live label
   * name/description, repo description, remote settings.yml). When the target
   * is redacted, none may appear in any public surface (the leak invariant).
   */
  canaries: string[];
}

/** The generation facts a multi-repo scenario's oracle rollup consumes. */
export interface MultiScenarioMeta {
  repos: MultiRepoMeta[];
  mode: "apply" | "check";
  policy: "fail" | "warn";
  /** The `private-repos` policy the run was generated under (redact or show). */
  privateRepos: "redact" | "show";
  /**
   * The `private-report` channel: `issue` delivers the full report to each
   * redacted target's own repo; `artifact` age-encrypts the report and uploads
   * it as a workflow artifact (which fails with a safe warning in the harness,
   * where the runner token is absent); `none` sends nothing. Only ever `issue`
   * or `artifact` under redact (the config rejects a delivering channel + show).
   */
  privateReport: "none" | "issue" | "artifact";
  /** GITHUB_REPOSITORY: a target whose slug equals it is never redacted. */
  selfSlug: string;
  /**
   * A core-route fault the FUZZ ITERATION injected (generation never sets
   * this). `fatal` is the modeled VERDICT - the fault kills the FIRST
   * target's settings fetch (an exhausting budget of 1 + MAX_RETRIES, or a
   * rate_limit_403's first firing): targets are processed in generation
   * order, the visibility probes consume nothing (they hit the repository
   * route), and the fault hook precedes both the missing-file 404 and the
   * permission gate - so the victim FAILS outright whatever its kind would
   * otherwise report. A non-fatal fault is retried away and changes no
   * prediction.
   */
  coreFault?: { key: "core.contentsGet"; fatal: boolean };
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
 * left without a settings file, which the action skips, and one may serve raw
 * invalid settings text instead. A defaults file merged under every target may
 * null out one section (the opt-out path). The returned meta records each
 * repo's target kind (normal with its ScenarioMeta, missing, or raw-invalid)
 * for the per-repo oracle plus the worst-of rollup.
 */
/**
 * Battery-construction forces: pin specific rolls so a directed battery entry
 * EXISTS for every master seed. Rejection sampling with ANY fixed fork budget
 * has miss seeds (live counterexample: seed 8181 missed an issue-channel draw
 * in 40 forks), and with live CI seeds every miss is a spurious failure - so
 * the batteries CONSTRUCT eligibility instead of sampling for it. The
 * UNFORCED path is byte-identical to the pre-force generator (verified over
 * 400 seeds against HEAD). FORCED paths may consume a DIFFERENT draw
 * sequence (an overridden roll can gate later draws - e.g. a forced redact
 * consumes the report pick a rolled show would skip), which is safe: forced
 * generation is deterministic per (seed, force), and every battery replay
 * (--iterations 0) reapplies its force. No consumer generates forced and
 * replays unforced.
 *
 * - "issue-report": the delivering issue channel (privateRepos redact +
 *   privateReport issue) - the report-fault battery's precondition.
 * - "idempotence-eligible": apply mode, non-delivering channel, no raw
 *   target, every normal target's mask empty - multiIdempotenceEligible by
 *   construction.
 * - "plain-first-target": privateRepos show (no canaries anywhere) and the
 *   raw target kept off index 0 - the contents-fault victim guard by
 *   construction.
 */
export type MultiBatteryForce = "issue-report" | "idempotence-eligible" | "plain-first-target";

export function genMultiScenario(
  rng: Rng,
  force?: MultiBatteryForce,
): { scenario: Scenario; meta: MultiScenarioMeta } {
  const count = rng.int(4) + 2; // 2..5
  const rolledMode = rng.pick(["apply", "check"] as const);
  const mode = force === "idempotence-eligible" ? "apply" : rolledMode;
  const policy = rng.pick(["fail", "warn"] as const);
  const denialStyle: DenialStyle = rng.pick(["fine_grained", 403] as const);
  // The private-repos policy for the run: redact (the default) or show. Under
  // redact, private/internal targets and probe-denied targets are hidden and
  // keyed by a placeholder; under show, nothing is redacted. Chosen randomly so
  // the fuzzer covers both, and the oracle predicts the placeholder keys and the
  // leak invariant from it.
  const rolledPrivateRepos = rng.pick(["redact", "show"] as const);
  const privateRepos =
    force === "issue-report"
      ? "redact"
      : force === "plain-first-target"
        ? "show"
        : rolledPrivateRepos;
  // The private-report channel. `issue` delivers the full report to each
  // redacted target's own repo; `artifact` age-encrypts every report into one
  // workflow artifact (which fails with a safe warning in the harness, where the
  // runner token is absent). Both are only valid under redact (the config rejects
  // a delivering channel + show, since show redacts nothing), so they are picked
  // only then. Randomized so the fuzzer covers delivery, reuse, denial, and the
  // artifact upload-attempt path.
  const rolledReport =
    privateRepos === "redact" ? rng.pick(["none", "issue", "artifact"] as const) : "none";
  const privateReport =
    force === "issue-report" ? "issue" : force === "idempotence-eligible" ? "none" : rolledReport;
  // The admin repo the runner runs as (GITHUB_REPOSITORY); a target whose slug
  // equals it is never redacted (the self carve-out). Kept in sync with
  // runner.ts's REPO_SLUG.
  const selfSlug = "e2e-owner/e2e-repo";
  // The GLOBAL token mask for the run: empty here (no scenario-wide
  // token_permissions), so every resource defaults to write. The mock grades
  // teams' org-scoped endpoints against THIS mask, so each repo's oracle meta
  // carries it as orgMask (see the teams org gate in sectionGrade).
  const globalMask: Partial<Record<MaskKey, MaskGrade>> = {};
  // One repo (chosen up front) is missing its settings file, so it is skipped.
  const missingIndex = rng.int(count);

  const repos: Record<string, unknown> = {};
  const repoMetas: MultiRepoMeta[] = [];
  // Under redact, force ONE non-missing target private so the run always has a
  // redacted target: otherwise a run where every target rolled public would give
  // an empty forbidden set and a vacuous leak check. Pick any index != missing
  // (count >= 2 guarantees one exists). Under show this is inert.
  const forcedPrivateIndex =
    privateRepos === "redact"
      ? (missingIndex + 1 + rng.int(count - 1)) % count // any non-missing index
      : -1;
  // The running placeholder ordinal, incremented per redacted target in target
  // order - the exact numbering planRedaction assigns (self and public skipped).
  let redactedOrdinal = 0;
  // With ~1/5 probability one further target serves RAW settings text: an
  // unparseable body (the "cannot parse <slug>" gate) or one parsing to a
  // non-mapping (the top-level validator gate). Never the missing target (its
  // gate is the contents 404) and never the forced-private target (its canary
  // flow must stay guaranteed for the leak counterfactual).
  const rawCandidates = Array.from({ length: count }, (_, i) => i).filter(
    (i) =>
      i !== missingIndex &&
      i !== forcedPrivateIndex &&
      // The contents-fault battery's victim is always index 0; keep the raw
      // target off it by construction.
      (force !== "plain-first-target" || i !== 0),
  );
  const rolledRawIndex = rawCandidates.length > 0 && rng.bool(0.2) ? rng.pick(rawCandidates) : -1;
  const rawIndex = force === "idempotence-eligible" ? -1 : rolledRawIndex;
  const rawKind = rawIndex >= 0 ? rng.pick(["unparseable", "non-mapping"] as const) : undefined;
  for (let i = 0; i < count; i++) {
    const slug = `e2e-owner/repo-${i}`;
    // Every target gets a random visibility; roughly half are non-public so the
    // redaction path is exercised. One index is forced private (see above) so a
    // redact run is never vacuous. The self slug is forced public-ish (its
    // visibility never matters - the carve-out fires first).
    const visibility =
      i === forcedPrivateIndex
        ? rng.pick(["private", "internal"] as const)
        : rng.pick(["public", "public", "private", "internal"] as const);
    if (i === missingIndex) {
      // No settings file: the action reads a 404 and skips the target. It is
      // still visibility-probed and can still be redacted (the placeholder key
      // is assigned before the target loop runs).
      const probeDenied = false;
      const redacted =
        privateRepos === "redact" && slug !== selfSlug && (visibility !== "public" || probeDenied);
      if (redacted) {
        redactedOrdinal += 1;
      }
      const displayKey = redacted ? `private repository #${redactedOrdinal}` : slug;
      const repoSpec: Record<string, unknown> = { settings: null };
      if (visibility !== "public") {
        repoSpec.live_state = { repo: { private: true, visibility } };
      }
      repos[slug] = repoSpec;
      repoMetas.push({
        slug,
        target: { kind: "missing" },
        visibility,
        probeDenied,
        redacted,
        displayKey,
        canaries: [],
      });
      continue;
    }
    if (i === rawIndex && rawKind !== undefined) {
      // Raw invalid settings text: the target fails at the parse gate (or the
      // top-level validator, for the non-mapping kind) before any section
      // runs. Fully granted (no mask) so the contents read always succeeds
      // and the parse gate - not a permission gate - is what fires; the
      // redaction mechanics stay identical to every other target.
      const raw =
        rawKind === "unparseable" ? rng.pick(UNPARSEABLE_YAML) : rng.pick(NON_MAPPING_YAML);
      const probeDenied = false;
      const redacted =
        privateRepos === "redact" && slug !== selfSlug && (visibility !== "public" || probeDenied);
      if (redacted) {
        redactedOrdinal += 1;
      }
      const displayKey = redacted ? `private repository #${redactedOrdinal}` : slug;
      const repoSpec: Record<string, unknown> = { settings_raw: raw };
      if (visibility !== "public") {
        repoSpec.live_state = { repo: { private: true, visibility } };
      }
      repos[slug] = repoSpec;
      repoMetas.push({
        slug,
        target: { kind: "raw-invalid", raw: rawKind },
        visibility,
        probeDenied,
        redacted,
        displayKey,
        canaries: [],
      });
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
    const mask: Partial<Record<MaskKey, MaskGrade>> = {};
    for (const resource of MASK_KEYS) {
      if (child.bool(0.3)) {
        mask[resource] = child.pick(["none", "read", "write"] as const);
      }
    }
    // The forced-private target must be a REAL leak test, not sometimes-vacuous.
    // It is fully GRANTED (every mask entry cleared to the write default): under
    // apply + fail a single denied section read aborts the whole target at
    // preflight and nothing - including the canary label - is ever rendered. A
    // fully-granted target never preflight-aborts, so its canary label's name
    // (and, in check mode, its description) always reaches the detail output that
    // redaction must suppress. Its visibility is already private (forced above),
    // so it stays redacted regardless. The OTHER targets keep their random masks,
    // so denial coverage is unaffected.
    // The idempotence battery force clears EVERY normal target's mask: the
    // apply-idempotence gate requires fully-granted targets (empty masks by
    // its deliberately narrow definition). The mask rolls themselves are
    // consumed either way; only their outcome is discarded.
    if (i === forcedPrivateIndex || force === "idempotence-eligible") {
      for (const resource of MASK_KEYS) {
        delete mask[resource];
      }
    }
    // A denied administration mask denies the visibility probe (GET /repos), so
    // the resolver reads "unknown" and redaction fails closed even for a public
    // target. Matches the redaction rule in multi.ts.
    const probeDenied = mask.administration === "none";
    const redacted =
      privateRepos === "redact" && slug !== selfSlug && (visibility !== "public" || probeDenied);
    if (redacted) {
      redactedOrdinal += 1;
    }
    const displayKey = redacted ? `private repository #${redactedOrdinal}` : slug;

    // Seed each target's live state the same way single-repo genScenario does,
    // so a target's declared branches/workflows exist and converge instead of
    // drifting on a permanent skip note.
    const live: LiveState = presenceLiveState(settings) ?? {};
    if (visibility !== "public") {
      live.repo = { ...(live.repo ?? {}), private: true, visibility };
    }

    // Plant canaries in a redacted target's private surfaces so a
    // detail-SUPPRESSION regression (not just a slug leak) is caught. The canary
    // is a declared label matched by a unique name; its live description DIFFERS
    // from the declared one, so the label drifts in check mode and updates in
    // apply mode - in both cases the label name and the differing description
    // flow into the section's drift/change detail, which redaction must hide. A
    // matched-by-name label keeps the outcome class the labels grade already
    // predicts (drift/applied), so the oracle needs no special case. A third
    // canary rides the live repo description. Under redaction none of these may
    // reach any public surface; the leak invariant checks exactly that.
    const canaries: string[] = [];
    if (redacted) {
      const nameCanary = `CANARY-${rng.seed}-${i}-name`;
      const declaredDescCanary = `CANARY-${rng.seed}-${i}-declared`;
      const liveDescCanary = `CANARY-${rng.seed}-${i}-live`;
      const repoCanary = `CANARY-${rng.seed}-${i}-repo`;
      canaries.push(nameCanary, declaredDescCanary, liveDescCanary, repoCanary);
      const declaredLabels = Array.isArray(settings.labels) ? (settings.labels as Json[]) : [];
      declaredLabels.push({ name: nameCanary, color: "abcdef", description: declaredDescCanary });
      settings.labels = declaredLabels;
      const liveLabels = Array.isArray(live.labels) ? (live.labels as Json[]) : [];
      // Same name (so the engine matches and diffs it, not create+delete) but a
      // DIFFERENT description, so the canary drifts into the detail line.
      liveLabels.push({ name: nameCanary, color: "abcdef", description: liveDescCanary });
      live.labels = liveLabels;
      live.repo = { ...(live.repo ?? {}), description: repoCanary };
      // The canary rides in on the labels section, so the oracle must predict it.
      if (!sections.includes("labels")) {
        sections.push("labels");
      }
    }
    validateAgainstPublishedSchema(settings);

    const hasLive = Object.keys(live).length > 0;
    repos[slug] = {
      settings,
      ...(hasLive ? { live_state: live } : {}),
      ...(Object.keys(mask).length > 0 ? { permissions: mask } : {}),
    };
    repoMetas.push({
      slug,
      visibility,
      probeDenied,
      redacted,
      displayKey,
      canaries,
      target: {
        kind: "normal",
        meta: {
          sections,
          mask,
          mode,
          policy,
          ownerKind: "org",
          denialStyle,
          requiredSections: [],
          // teams' org gate is graded by the mock against the GLOBAL mask, not this
          // per-slug one; genMultiScenario sets no global token_permissions, so it
          // is empty (every org_members defaults to write - teams is never gated by
          // a per-slug org_members:none).
          orgMask: globalMask,
        },
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
    .filter(([, spec]) => {
      // Only a target with a REAL settings mapping can opt out: null marks
      // the missing-settings target, and undefined the raw-settings one
      // (writing milestones: null into its absent mapping would crash).
      const settings = (spec as { settings?: unknown }).settings;
      return settings !== null && settings !== undefined;
    })
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
    if (repoMeta.target.kind !== "normal") {
      continue;
    }
    const repoScenarioMeta = repoMeta.target.meta;
    const optedOut = repoMeta.slug === optedOutSlug ? ["milestones"] : [];
    repoScenarioMeta.sections = repoScenarioMeta.sections.filter(
      (s) => !optedOut.includes(s),
    ) as SectionKey[];
    for (const inherited of DEFAULTS_SECTIONS) {
      if (!repoScenarioMeta.sections.includes(inherited) && !optedOut.includes(inherited)) {
        repoScenarioMeta.sections.push(inherited);
      }
    }
  }

  const scenario: Scenario = {
    name: `fuzz-multi-${rng.seed}`,
    tiers: ["mock"],
    settings: {},
    inputs: {
      mode,
      on_missing_permission: policy,
      private_repos: privateRepos,
      ...(privateReport !== "none" ? { private_report: privateReport } : {}),
      // The artifact channel needs a valid age recipient; the config rejects it
      // without one (and rejects a key set for any other channel), so forward the
      // fixed test recipient exactly when the channel is artifact.
      ...(privateReport === "artifact" ? { report_public_key: ARTIFACT_TEST_RECIPIENT } : {}),
    },
    denial_style: denialStyle,
    owner_kind: "org",
    repos: repos as Scenario["repos"],
    defaults_file: defaultsFile,
    expect: { exit_code: 0 },
  };
  return {
    scenario,
    meta: {
      repos: repoMetas,
      mode,
      policy,
      privateRepos,
      privateReport,
      selfSlug,
      milestonesOptOutSlug: optedOutSlug,
    },
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
  /**
   * The `private-repos` policy the discovery run uses. Discovery targets are the
   * one surface with TRUE non-disclosure (their names come only from the private
   * /user/repos listing, never the operator's config), so the fuzzer runs them
   * under redact and checks that a kept private/internal repo is keyed by a
   * placeholder and its slug leaks nowhere.
   */
  privateRepos: "redact" | "show";
}

/**
 * A random `repos: "*"` discovery scenario: a pool of 4 to 8 repos with random
 * archived/fork/visibility/topic attributes, plus a random subset of discovery
 * filters. Each pool repo carries one label so a kept repo applies. The returned
 * meta echoes the pool and filters so predictDiscovery can compute the kept set
 * INDEPENDENTLY, and the fuzz asserts the action discovered exactly those.
 */
export function genDiscoveryScenario(
  rng: Rng,
  /**
   * Battery construction: "converges" pins a non-empty kept set structurally
   * (pool repo 0 non-archived + no filters), so the convergence battery entry
   * exists for EVERY master seed instead of rejection-sampling for one. The
   * unforced path is byte-identical to the pre-force generator; the forced
   * path is deterministic per (seed, force) and battery replays reapply it.
   */
  force?: "converges",
): {
  scenario: Scenario;
  meta: DiscoveryScenarioMeta;
} {
  const count = rng.int(5) + 4; // 4..8
  const TOPIC_POOL = ["platform", "infra", "legacy", "misc"];
  // Discovery always runs under redact (see privateRepos below), so force ONE
  // pool repo non-public: an all-public pool would hand the leak invariant an
  // empty forbidden set and the check would pass vacuously - the same guard
  // genMultiScenario's forced-private target provides.
  const forcedPrivateIndex = rng.int(count);
  const pool: DiscoveryScenarioMeta["pool"] = [];
  for (let i = 0; i < count; i++) {
    const repo: DiscoveryScenarioMeta["pool"][number] = { slug: `e2e-owner/disc-${i}` };
    // This particular roll IS consumed either way (only the outcome is
    // masked): the converges force keeps repo 0 non-archived so the
    // unfiltered kept set is provably non-empty.
    if (rng.bool(0.3) && !(force === "converges" && i === 0)) {
      repo.archived = true;
    }
    if (rng.bool(0.3)) {
      repo.fork = true;
    }
    repo.visibility =
      i === forcedPrivateIndex
        ? rng.pick(["private", "internal"] as const)
        : rng.pick(["public", "private", "internal"]);
    if (rng.bool(0.6)) {
      repo.topics = [rng.pick(TOPIC_POOL)];
    }
    pool.push(repo);
  }

  // A random subset of filters. Each is included ~40% of the time; the values
  // are drawn from the documented allowed sets. exclude uses a glob over slugs.
  // Rolled into `rolledFilters` (these rolls are consumed either way) and
  // overridden to none under the converges force.
  const rolledFilters: DiscoveryScenarioMeta["filters"] = {};
  if (rng.bool(0.4)) {
    rolledFilters.visibility = rng.pick(["all", "public", "private", "internal"]);
  }
  if (rng.bool(0.4)) {
    rolledFilters.archived = rng.pick(["skip", "include", "only"]);
  }
  if (rng.bool(0.4)) {
    rolledFilters.forks = rng.pick(["include", "exclude", "only"]);
  }
  if (rng.bool(0.4)) {
    rolledFilters.topics = rng.pick(TOPIC_POOL);
  }
  if (rng.bool(0.3)) {
    rolledFilters.exclude = `disc-${rng.int(count)}`;
  }
  // Under the converges force no filter applies, so the kept set is exactly
  // the non-archived pool - which provably contains repo 0.
  const filters: DiscoveryScenarioMeta["filters"] = force === "converges" ? {} : rolledFilters;

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

  // Discovery runs under redact (the default and the realistic case for a
  // fleet with private members); the iteration maps kept private/internal repos
  // to their placeholder keys and checks their slugs leak nowhere.
  const privateRepos = "redact" as const;
  const scenario: Scenario = {
    name: `fuzz-discovery-${rng.seed}`,
    tiers: ["mock"],
    settings: {},
    inputs: { mode: "apply", on_missing_permission: "warn", private_repos: privateRepos },
    denial_style: "fine_grained",
    owner_kind: "org",
    discovery: { pool, inputs },
    repos: repos as Scenario["repos"],
    token_permissions: { issues: "write", contents: "read" },
    expect: { exit_code: 0 },
  };
  return { scenario, meta: { pool, filters, privateRepos } };
}
