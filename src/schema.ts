/**
 * The settings-file document, composed from the per-section schema slices
 * (src/sections/<key>/schema.ts). Each slice is ONE declaration that produces
 * its config type (z.infer), the section's tolerant runtime shape (the
 * section module derives loosen(<slice>) itself; see sections/contract/module.ts), and
 * its part of the published lib/settings.schema.json
 * (.github/scripts/gen-settings-schema.ts). This file adds only the
 * document-level wrappers - the undeclared knob, .optional(), and the
 * property .describe() strings - so a future org/user settings document can
 * compose its own SettingsFile from the same slices. The .describe() strings
 * become the published schema's descriptions; .meta({id}) names its
 * definitions; superRefine/refine checks are runtime-only (invisible to
 * toJSONSchema) and survive loosen(), so upfront document validation keeps
 * every invariant.
 *
 * Authoring rules:
 * - z.object (strip) is the default: the published schema leaves it OPEN
 *   (passthrough-first forward compatibility) and loosen() turns it into a
 *   passthrough looseObject for the runtime.
 * - z.strictObject only where the runtime rejects unknown keys in the shape
 *   itself - the {undeclared, entries} wrapper and the nested shapes whose
 *   endpoints offer no passthrough destination: it emits
 *   additionalProperties: false and loosen() keeps it strict.
 * - z.looseObject where the config type carries an index signature (the
 *   GitHub-bound passthrough mappings), so the inferred type keeps it.
 * - Runtime checks that read UNDECLARED keys (base-key sweeps, the
 *   misplaced-secret traps) see them only through loosen()'s passthrough
 *   clone - the authored strip parse is never used at runtime.
 *
 * The sections in PROBOT_PARITY_KEYS (declared below) keep the Probot
 * Settings app schema (https://github.com/repository-settings/app) in their
 * plain-array form, so an existing Probot config applies to them unchanged;
 * every section not in PROBOT_PARITY_KEYS is an addition. Only DECLARED keys
 * are ever applied or compared, so omitting a key means "leave it alone".
 */

import { z } from "zod";
import { ActionsConfig } from "./sections/actions/schema.js";
import { ActionsSecretConfig } from "./sections/actions_secrets/schema.js";
import { ActionsVariableConfig } from "./sections/actions_variables/schema.js";
import { AgentsSecretConfig } from "./sections/agents_secrets/schema.js";
import { AgentsVariableConfig } from "./sections/agents_variables/schema.js";
import { AutolinkConfig } from "./sections/autolinks/schema.js";
import { BranchesConfig } from "./sections/branches/schema.js";
import { CheckSuitePreferencesConfig } from "./sections/check_suite_preferences/schema.js";
import { CodeQualitySetupConfig } from "./sections/code_quality_setup/schema.js";
import { CodeScanningDefaultSetupConfig } from "./sections/code_scanning_default_setup/schema.js";
import { CodespacesSecretConfig } from "./sections/codespaces_secrets/schema.js";
import { CollaboratorConfig } from "./sections/collaborators/schema.js";
import { CustomPropertyConfig } from "./sections/custom_properties/schema.js";
import { DependabotSecretConfig } from "./sections/dependabot_secrets/schema.js";
import { DeployKeyConfig } from "./sections/deploy_keys/schema.js";
import { EnvironmentsConfig } from "./sections/environments/schema.js";
import { InteractionLimitsConfig } from "./sections/interaction_limits/schema.js";
import { LabelConfig } from "./sections/labels/schema.js";
import { MilestoneConfig } from "./sections/milestones/schema.js";
import { PagesConfig } from "./sections/pages/schema.js";
import { RepositoryConfig } from "./sections/repository/schema.js";
import { RulesetConfig } from "./sections/rulesets/schema.js";
import { SecretScanningPatternConfig } from "./sections/secret_scanning_custom_patterns/schema.js";
import { knobbed } from "./sections/shared/schema-helpers.js";
import { TeamsConfig } from "./sections/teams/schema.js";
import { WebhookConfig } from "./sections/webhooks/schema.js";
import { WorkflowsConfig } from "./sections/workflows/schema.js";
import type { MustBeNever } from "./types.js";

// --- The settings document ----------------------------------------------------

export const SettingsFile = z
  .object({
    repository: RepositoryConfig.optional().describe(
      "Repo fields sent verbatim to PATCH /repos/{r}, plus the special keys RepositoryConfig documents.",
    ),
    labels: knobbed(LabelConfig)
      .optional()
      .describe(
        "Issue/PR labels; undeclared labels are DELETED by default (Probot parity; the wrapped form can set `undeclared: keep`).",
      ),
    rulesets: knobbed(RulesetConfig)
      .optional()
      .describe(
        "Repository rulesets, upserted by name; undeclared ones are kept by default (the wrapped form can set `undeclared: delete`).",
      ),
    branches: BranchesConfig.optional().describe("Classic branch protection per branch."),
    environments: EnvironmentsConfig.optional().describe(
      "Deployment environments, upserted by name.",
    ),
    autolinks: knobbed(AutolinkConfig)
      .optional()
      .describe(
        "Autolink references; undeclared ones are DELETED by default (the wrapped form can set `undeclared: keep`).",
      ),
    actions: ActionsConfig.optional().describe("GitHub Actions permissions for the repository."),
    actions_secrets: knobbed(ActionsSecretConfig)
      .optional()
      .describe(
        "Repository Actions secrets, written by name with values sealed client-side; each " +
          "value is a whole-value `$NAME` reference to the action step's environment, never a " +
          "literal. Undeclared secrets are kept by default (the wrapped form can set " +
          "`undeclared: delete`; a deleted secret's value is unrecoverable).",
      ),
    dependabot_secrets: knobbed(DependabotSecretConfig)
      .optional()
      .describe(
        "Repository Dependabot secrets (private-registry credentials Dependabot uses), written " +
          "by name with values sealed client-side; each value is a whole-value `$NAME` reference " +
          "to the action step's environment, never a literal. Undeclared secrets are kept by " +
          "default (the wrapped form can set `undeclared: delete`; a deleted secret's value is " +
          "unrecoverable).",
      ),
    codespaces_secrets: knobbed(CodespacesSecretConfig)
      .optional()
      .describe(
        "Repository Codespaces secrets (development environment secrets), written by name with " +
          "values sealed client-side; each value is a whole-value `$NAME` reference to the " +
          "action step's environment, never a literal. Undeclared secrets are kept by default " +
          "(the wrapped form can set `undeclared: delete`; a deleted secret's value is " +
          "unrecoverable).",
      ),
    agents_secrets: knobbed(AgentsSecretConfig)
      .optional()
      .describe(
        "Repository Copilot agents secrets (the secret store Copilot coding agents read), " +
          "written by name with values sealed client-side; each value is a whole-value `$NAME` " +
          "reference to the action step's environment, never a literal. Undeclared secrets are " +
          "kept by default (the wrapped form can set `undeclared: delete`; a deleted secret's " +
          "value is unrecoverable).",
      ),
    workflows: WorkflowsConfig.optional().describe(
      "Per-workflow enable/disable state; undeclared workflows are untouched.",
    ),
    check_suite_preferences: CheckSuitePreferencesConfig.optional().describe(
      "Check suite preferences: per-GitHub-App `auto_trigger_checks` toggles controlling " +
        "whether pushes automatically create check suites. Write-only upstream (GitHub exposes " +
        "no read endpoint), so check mode cannot verify them and apply re-asserts the declared " +
        "preferences on every run. The token owner must be a repository administrator.",
    ),
    pages: PagesConfig.optional().describe(
      "GitHub Pages configuration; null disables Pages on the repository.",
    ),
    code_scanning_default_setup: CodeScanningDefaultSetupConfig.optional().describe(
      "Code scanning default setup (CodeQL).",
    ),
    code_quality_setup: CodeQualitySetupConfig.optional().describe("Code quality analysis setup."),
    collaborators: knobbed(CollaboratorConfig)
      .optional()
      .describe(
        "Direct collaborators, with pending invitations reconciled alongside; undeclared ones are REMOVED (pending invitations cancelled) by default (owner never touched; the wrapped form can set `undeclared: keep`).",
      ),
    teams: TeamsConfig.optional().describe(
      "Org team access to the repo; skipped on personal accounts.",
    ),
    milestones: knobbed(MilestoneConfig)
      .optional()
      .describe(
        "Milestones, upserted by title; undeclared ones are kept by default (the wrapped form can set `undeclared: delete`, which detaches deleted milestones from their issues).",
      ),
    interaction_limits: InteractionLimitsConfig.optional().describe(
      "Temporary interaction limits; null clears an active repo-level limit, and an absent key " +
        "leaves whatever is live untouched. Limits self-expire (GitHub's expiry tops out at " +
        "six_months), so apply re-arms the declared limit on every run and check mode reports " +
        "drift once it lapses. The pull_request_creation_cap and pull_request_creation_bypass " +
        "keys manage the persistent pull request creation cap and its bypass list instead; " +
        "`interaction_limits: null` clears the base limit only and never touches them.",
    ),
    actions_variables: knobbed(ActionsVariableConfig)
      .optional()
      .describe(
        "GitHub Actions repository variables, upserted by name; undeclared ones are DELETED by " +
          "default (the wrapped form can set `undeclared: keep`). Names are case-insensitive " +
          "(GitHub stores them uppercased). Values are plain text BY DESIGN - variables are " +
          "readable configuration, which is what makes check-mode diffing possible; secrets are " +
          "write-only material and deliberately not this section.",
      ),
    agents_variables: knobbed(AgentsVariableConfig)
      .optional()
      .describe(
        "Copilot agents repository variables (the plain-text configuration Copilot coding " +
          "agents read), upserted by name; undeclared ones are DELETED by default (the wrapped " +
          "form can set `undeclared: keep`). Names are case-insensitive (GitHub stores them " +
          "uppercased). Values are plain text BY DESIGN - variables are readable configuration, " +
          "which is what makes check-mode diffing possible; secrets are write-only material and " +
          "deliberately not this section.",
      ),
    webhooks: knobbed(WebhookConfig)
      .optional()
      .describe(
        "Repository webhooks, managed one per config.url; undeclared hooks are kept by default and surfaced as notes, since integrations create their own hooks (the wrapped form can set `undeclared: delete`).",
      ),
    custom_properties: knobbed(CustomPropertyConfig)
      .optional()
      .describe(
        "Values of organization-defined custom properties, set per repository (the property " +
          "DEFINITIONS are organization-scoped and out of scope); organization repos only, " +
          "skipped with a note on personal accounts. `value: null` unsets a property (reverting " +
          "to the org default, if any), and booleans/numbers are normalized to their string form " +
          '(GitHub transports true_false values as the strings "true"/"false"). Undeclared live ' +
          "values are kept by default - an unset can revert to an org default this action does " +
          "not model, and a property whose values only org actors may edit would reject the " +
          "write - and the wrapped form can set `undeclared: delete` to opt into unsetting them.",
      ),
    deploy_keys: knobbed(DeployKeyConfig)
      .optional()
      .describe(
        "Deploy keys, matched by title. The declared material is a PUBLIC key, safe in a " +
          "committed settings file. Keys are immutable upstream, so any change is applied as " +
          "delete plus recreate. Undeclared keys are kept by default - deleting a live deploy " +
          "key breaks whatever service authenticates with it, and deployment tooling installs " +
          "its own keys - and the wrapped form can set `undeclared: delete`.",
      ),
    secret_scanning_custom_patterns: knobbed(SecretScanningPatternConfig)
      .optional()
      .describe(
        "Repository-level secret scanning custom patterns, matched by name. The name is " +
          "immutable upstream (the update PATCH takes no name field), so a renamed entry is " +
          "applied as a create of the new name - plus, under `undeclared: delete`, deletion of " +
          "the old one; under the default keep policy the old pattern stays live and is surfaced " +
          "as a note. Undeclared patterns are kept by default: removing a pattern disposes of " +
          "its alerts, so deletion stays a human opt-in (the wrapped form can set `undeclared: " +
          "delete`). When this action deletes a pattern it always asks GitHub to RESOLVE the " +
          "pattern's alerts rather than delete them, keeping the audit trail.",
      ),
  })
  .describe("One settings.yml document: every top-level section is optional.")
  .meta({ id: "SettingsFile" });
export type SettingsFile = z.infer<typeof SettingsFile>;

/** Every recognized top-level section, in execution order. */
export const SECTION_KEYS = [
  "repository",
  "labels",
  "rulesets",
  // environments before branches on purpose: branches' required_deployments
  // names deployment environments, and GitHub silently drops names that do
  // not exist, so environments declared in the same file must land first.
  "environments",
  "branches",
  "autolinks",
  "actions",
  "actions_secrets",
  "dependabot_secrets",
  "codespaces_secrets",
  "agents_secrets",
  "workflows",
  "check_suite_preferences",
  "pages",
  "code_scanning_default_setup",
  "code_quality_setup",
  "collaborators",
  "teams",
  "milestones",
  "interaction_limits",
  "actions_variables",
  "agents_variables",
  "webhooks",
  "custom_properties",
  "deploy_keys",
  // Last on purpose: when the repository section enables secret scanning
  // (via security_and_analysis), the patterns run against a repository whose
  // scanning is already on. That helps a warn-policy bootstrap and every
  // later run, but it cannot make the pair land in ONE apply under the
  // default fail policy: preflight probes every declared section read-only
  // BEFORE any write, so the patterns list 404s (scanning still off) and
  // aborts the run before the repository section could enable it. Enable
  // scanning first, or bootstrap under on-missing-permission: warn.
  "secret_scanning_custom_patterns",
] as const satisfies readonly (keyof SettingsFile)[];

/** A recognized top-level section name. */
export type SectionKey = (typeof SECTION_KEYS)[number];

/**
 * The sections that take the `undeclared` policy knob: their SettingsFile
 * value is a union of the plain entry array and UndeclaredPolicyList. The
 * defaults merge (engine/merge.ts) normalizes and resolves exactly these
 * sections; the lockstep types below pin the list to the SettingsFile
 * declarations in both directions.
 */
export const UNDECLARED_POLICY_SECTIONS = [
  "labels",
  "rulesets",
  "autolinks",
  "actions_secrets",
  "dependabot_secrets",
  "codespaces_secrets",
  "agents_secrets",
  "collaborators",
  "milestones",
  "actions_variables",
  "agents_variables",
  "webhooks",
  "custom_properties",
  "deploy_keys",
  "secret_scanning_custom_patterns",
] as const satisfies readonly SectionKey[];

/** A section key that takes the `undeclared` policy knob. */
export type UndeclaredPolicySection = (typeof UNDECLARED_POLICY_SECTIONS)[number];

/**
 * The section keys whose SettingsFile value accepts the wrapped form. Both
 * union branches are required - the plain entry array AND the wrapper - so
 * a future section whose config object merely carries an `entries` property
 * does not classify as knobbed by accident.
 */
type KnobbedByType = {
  [K in SectionKey]: [Extract<NonNullable<SettingsFile[K]>, readonly unknown[]>] extends [never]
    ? never
    : [Extract<NonNullable<SettingsFile[K]>, { entries: readonly unknown[] }>] extends [never]
      ? never
      : K;
}[SectionKey];
/** Compile-time lockstep: a knobbed SettingsFile type missing from the list fails here. */
type _KnobListComplete = MustBeNever<
  Exclude<KnobbedByType, (typeof UNDECLARED_POLICY_SECTIONS)[number]>
>;
/** Compile-time lockstep: a listed section whose type lacks the wrapper fails here. */
type _KnobListSound = MustBeNever<
  Exclude<(typeof UNDECLARED_POLICY_SECTIONS)[number], KnobbedByType>
>;

/**
 * The sections whose plain-array settings.yml form matches the Probot
 * Settings app schema, so an existing Probot config applies to them as-is
 * (the wrapped `undeclared` form is this action's own addition on top). The
 * single source the README's "Migrating from the Probot Settings app"
 * paragraph is pinned against. `satisfies` keeps every entry a real section
 * key.
 */
export const PROBOT_PARITY_KEYS = [
  "repository",
  "labels",
  "branches",
  "collaborators",
  "teams",
  "milestones",
] as const satisfies readonly SectionKey[];

/** Compile-time lockstep: a SettingsFile property missing from SECTION_KEYS fails here. */
type _UnlistedSection = MustBeNever<Exclude<keyof SettingsFile, SectionKey>>;

// --- Slice-composition pins -----------------------------------------------------

/**
 * Each SettingsFile property's slice derivation: the schema the property is
 * composed FROM, before this file's document-level wrappers (.optional() and
 * the property .describe()). The knobbed sections derive as the undeclared
 * knob over their entry slice; everything else is its slice verbatim.
 * Naming rule: a whole-section slice export is named <Key>Config, matching
 * the singular <Entry>Config convention of the entry schemas.
 * Indexing below is total over SectionKey, so a new section fails to compile
 * until its derivation is declared here.
 */
type SliceDerivation = {
  repository: typeof RepositoryConfig;
  labels: ReturnType<typeof knobbed<typeof LabelConfig>>;
  rulesets: ReturnType<typeof knobbed<typeof RulesetConfig>>;
  environments: typeof EnvironmentsConfig;
  branches: typeof BranchesConfig;
  autolinks: ReturnType<typeof knobbed<typeof AutolinkConfig>>;
  actions: typeof ActionsConfig;
  actions_secrets: ReturnType<typeof knobbed<typeof ActionsSecretConfig>>;
  dependabot_secrets: ReturnType<typeof knobbed<typeof DependabotSecretConfig>>;
  codespaces_secrets: ReturnType<typeof knobbed<typeof CodespacesSecretConfig>>;
  agents_secrets: ReturnType<typeof knobbed<typeof AgentsSecretConfig>>;
  workflows: typeof WorkflowsConfig;
  check_suite_preferences: typeof CheckSuitePreferencesConfig;
  pages: typeof PagesConfig;
  code_scanning_default_setup: typeof CodeScanningDefaultSetupConfig;
  code_quality_setup: typeof CodeQualitySetupConfig;
  collaborators: ReturnType<typeof knobbed<typeof CollaboratorConfig>>;
  teams: typeof TeamsConfig;
  milestones: ReturnType<typeof knobbed<typeof MilestoneConfig>>;
  interaction_limits: typeof InteractionLimitsConfig;
  actions_variables: ReturnType<typeof knobbed<typeof ActionsVariableConfig>>;
  agents_variables: ReturnType<typeof knobbed<typeof AgentsVariableConfig>>;
  webhooks: ReturnType<typeof knobbed<typeof WebhookConfig>>;
  custom_properties: ReturnType<typeof knobbed<typeof CustomPropertyConfig>>;
  deploy_keys: ReturnType<typeof knobbed<typeof DeployKeyConfig>>;
  secret_scanning_custom_patterns: ReturnType<typeof knobbed<typeof SecretScanningPatternConfig>>;
};

/** The section keys whose SettingsFile property is NOT composed from its slice. */
type SectionNotComposedFromItsSlice = {
  [K in SectionKey]: (typeof SettingsFile.shape)[K] extends z.ZodOptional<SliceDerivation[K]>
    ? never
    : K;
}[SectionKey];

/**
 * Compile-time lockstep: every SettingsFile property IS its declared slice
 * derivation plus .optional(). The check is STRUCTURAL (zod types
 * refinements as `this`, so a lookalike rebuilt without a slice's
 * superRefine still matches); test/schema-slices.test.ts closes that hole by
 * asserting object identity per key. Together they keep the slices the
 * single composition source: a future org/user settings document composes
 * its own document from the same slices, and every section module keeps
 * deriving its runtime shape from the slice it already owns.
 */
type _EverySectionComposedFromItsSlice = MustBeNever<SectionNotComposedFromItsSlice>;

/** Compile-time lockstep: a SliceDerivation key that is not a section fails here. */
type _SliceDerivationKeysReal = MustBeNever<Exclude<keyof SliceDerivation, SectionKey>>;
