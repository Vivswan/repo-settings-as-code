/**
 * Types for the settings file: a superset of the Probot Settings app schema
 * (https://github.com/repository-settings/app) plus `rulesets`, `autolinks`,
 * `actions`, `workflows`, `pages`, and `code_scanning_default_setup`. Only
 * DECLARED keys are ever applied or compared - omitting a key means "leave
 * it alone".
 */

/** One settings.yml document: every top-level section is optional. */
export interface SettingsFile {
  /** Repo fields sent verbatim to PATCH /repos/{r}, plus the special keys below. */
  repository?: Record<string, unknown>;
  /** Issue/PR labels; undeclared labels are DELETED (Probot parity). */
  labels?: LabelConfig[];
  /** Repository rulesets, upserted by name; undeclared ones are kept. */
  rulesets?: RulesetConfig[];
  /** Classic branch protection per branch. */
  branches?: BranchConfig[];
  /** Deployment environments, upserted by name. */
  environments?: EnvironmentConfig[];
  /** Autolink references; undeclared ones are DELETED. */
  autolinks?: AutolinkConfig[];
  /** GitHub Actions permissions for the repository. */
  actions?: ActionsConfig;
  /** Per-workflow enable/disable state; undeclared workflows are untouched. */
  workflows?: WorkflowConfig[];
  /** GitHub Pages configuration; null disables Pages on the repository. */
  pages?: PagesConfig | null;
  /** Code scanning default setup (CodeQL). */
  code_scanning_default_setup?: CodeScanningDefaultSetupConfig;
  /** Direct collaborators; undeclared ones are REMOVED (owner never touched). */
  collaborators?: CollaboratorConfig[];
  /** Org team access to the repo; skipped on personal accounts. */
  teams?: TeamConfig[];
  /** Milestones, upserted by title; undeclared ones are kept. */
  milestones?: MilestoneConfig[];
}

/** One label, matched to the live repo by name. */
export interface LabelConfig {
  /** The label name, the natural key. */
  name: string;
  /** Hex color, with or without the leading "#". */
  color?: string;
  /** Short explanation shown in the label picker. */
  description?: string;
  /** Probot compat: rename an existing label. */
  new_name?: string;
}

/** One repository ruleset, matched to the live repo by name. */
export interface RulesetConfig {
  /** The ruleset name, the natural key. */
  name: string;
  /** What the ruleset applies to; defaults to "branch" upstream. */
  target?: "branch" | "tag" | "push";
  /** "active", "evaluate", or "disabled". Created rulesets default to "active". */
  enforcement?: string;
  /** Which refs the ruleset covers. */
  conditions?: {
    /** Short ref names are auto-prefixed (staging -> refs/heads/staging). */
    ref_name?: { include?: string[]; exclude?: string[] };
  };
  /** Rule list, passed through verbatim (future rule types included). */
  rules?: Array<{ type: string; parameters?: Record<string, unknown> }>;
  /** Who may bypass the ruleset, passed through verbatim. */
  bypass_actors?: Array<Record<string, unknown>>;
}

/** Classic protection for one branch. */
export interface BranchConfig {
  /** The branch name. */
  name: string;
  /** PUT .../protection payload; null removes protection (Probot parity). */
  protection: Record<string, unknown> | null;
}

/** One deployment environment, matched by name. */
export interface EnvironmentConfig {
  /** The environment name, the natural key. */
  name: string;
  /** Minutes to wait before deployments proceed. */
  wait_timer?: number;
  /** Whether the deployer may approve their own deployment. */
  prevent_self_review?: boolean;
  /** Required reviewers by numeric user/team id. */
  reviewers?: Array<{ type: "User" | "Team"; id: number }>;
  /** Which branches may deploy; null clears the policy. */
  deployment_branch_policy?: {
    /** Restrict to branches with protection rules. */
    protected_branches: boolean;
    /** Restrict to name patterns (declared separately, a known gap). */
    custom_branch_policies: boolean;
  } | null;
}

/** One autolink reference, matched by key prefix. */
export interface AutolinkConfig {
  /** Text prefix that triggers the link (e.g. "TICKET-"), the natural key. */
  key_prefix: string;
  /** Target URL template containing "<num>". */
  url_template: string;
  /** Whether <num> also matches letters; upstream default is true. */
  is_alphanumeric?: boolean;
}

/** GitHub Actions permissions, routed across four endpoints by key. */
export interface ActionsConfig {
  /** PUT /repos/{r}/actions/permissions: whether Actions runs at all. */
  enabled?: boolean;
  /** Which actions may run; "selected" pairs with selected_actions below. */
  allowed_actions?: "all" | "local_only" | "selected";
  /** PUT /repos/{r}/actions/permissions/selected-actions (allowed_actions: selected) */
  selected_actions?: Record<string, unknown>;
  /** PUT /repos/{r}/actions/permissions/workflow: the default GITHUB_TOKEN grant. */
  default_workflow_permissions?: "read" | "write";
  /** Whether workflows may approve pull request reviews. */
  can_approve_pull_request_reviews?: boolean;
  /** PUT /repos/{r}/actions/permissions/access (private repositories only) */
  access_level?: "none" | "user" | "organization";
}

/** One workflow's enable/disable state, keyed by its file path. */
export interface WorkflowConfig {
  /** Full ".github/workflows/ci.yml" or the bare "ci.yml" file name. */
  path: string;
  /** Desired state; every live disabled_* variant counts as "disabled". */
  state: "active" | "disabled";
}

/** PATCH /repos/{r}/code-scanning/default-setup, sent verbatim. */
export interface CodeScanningDefaultSetupConfig {
  /** Turn default setup on ("configured") or off ("not-configured"). */
  state?: "configured" | "not-configured";
  /** CodeQL query suite to run. */
  query_suite?: "default" | "extended";
  /** Languages to scan, compared as a set; GitHub auto-detects when omitted. */
  languages?: string[];
  /** Run on GitHub-hosted ("standard") or labeled self-hosted runners. */
  runner_type?: "standard" | "labeled";
  /** Runner label when runner_type is "labeled"; null clears it. */
  runner_label?: string | null;
  /** Whether to model local sources as threats in addition to remote ones. */
  threat_model?: "remote" | "remote_and_local";
}

/** GitHub Pages site configuration; use `pages: null` to disable the site. */
export interface PagesConfig {
  /** "workflow" (GitHub Actions) or "legacy" (branch). */
  build_type?: "workflow" | "legacy";
  /** The update PUT requires both branch and path when source is sent. */
  source?: { branch: string; path?: string };
  /** Custom domain; null removes it. */
  cname?: string | null;
  /** Whether HTTPS is enforced for the site. */
  https_enforced?: boolean;
}

/** One direct collaborator, matched by username. */
export interface CollaboratorConfig {
  /** GitHub login, the natural key. */
  username: string;
  /** "pull", "triage", "push", "maintain", "admin", or a custom org role; defaults to "push". */
  permission?: string;
}

/** One org team's access to the repository, matched by team slug. */
export interface TeamConfig {
  /** The team slug, the natural key. */
  name: string;
  /** Same vocabulary as collaborators; defaults to "push". */
  permission?: string;
}

/** One milestone, matched by title. */
export interface MilestoneConfig {
  /** The milestone title, the natural key. */
  title: string;
  /** Longer explanation of the milestone. */
  description?: string;
  /** Open or closed; untouched unless declared. */
  state?: "open" | "closed";
}

/** Every recognized top-level section, in execution order. */
export const SECTION_KEYS = [
  "repository",
  "labels",
  "rulesets",
  "branches",
  "environments",
  "autolinks",
  "actions",
  "workflows",
  "pages",
  "code_scanning_default_setup",
  "collaborators",
  "teams",
  "milestones",
] as const;

/** A recognized top-level section name. */
export type SectionKey = (typeof SECTION_KEYS)[number];
