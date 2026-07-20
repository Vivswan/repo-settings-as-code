/**
 * Types for the settings file: a superset of the Probot Settings app schema
 * (https://github.com/repository-settings/app) plus `rulesets`, `autolinks`,
 * `actions`, and `pages`. Only DECLARED keys are ever applied or compared -
 * omitting a key means "leave it alone".
 */

export interface SettingsFile {
  repository?: Record<string, unknown>;
  labels?: LabelConfig[];
  rulesets?: RulesetConfig[];
  branches?: BranchConfig[];
  environments?: EnvironmentConfig[];
  autolinks?: AutolinkConfig[];
  actions?: ActionsConfig;
  pages?: PagesConfig;
  collaborators?: CollaboratorConfig[];
  teams?: TeamConfig[];
  milestones?: MilestoneConfig[];
}

export interface LabelConfig {
  name: string;
  color?: string;
  description?: string;
  /** Probot compat: rename an existing label. */
  new_name?: string;
}

export interface RulesetConfig {
  name: string;
  target?: "branch" | "tag" | "push";
  enforcement?: string;
  conditions?: {
    ref_name?: { include?: string[]; exclude?: string[] };
  };
  rules?: Array<{ type: string; parameters?: Record<string, unknown> }>;
  bypass_actors?: Array<Record<string, unknown>>;
}

export interface BranchConfig {
  name: string;
  /** null removes protection (Probot parity). */
  protection: Record<string, unknown> | null;
}

export interface EnvironmentConfig {
  name: string;
  wait_timer?: number;
  prevent_self_review?: boolean;
  reviewers?: Array<{ type: "User" | "Team"; id: number }>;
  deployment_branch_policy?: {
    protected_branches: boolean;
    custom_branch_policies: boolean;
  } | null;
}

export interface AutolinkConfig {
  key_prefix: string;
  url_template: string;
  is_alphanumeric?: boolean;
}

export interface ActionsConfig {
  /** PUT /repos/{r}/actions/permissions */
  enabled?: boolean;
  allowed_actions?: "all" | "local_only" | "selected";
  /** PUT /repos/{r}/actions/permissions/selected-actions (allowed_actions: selected) */
  selected_actions?: Record<string, unknown>;
  /** PUT /repos/{r}/actions/permissions/workflow */
  default_workflow_permissions?: "read" | "write";
  can_approve_pull_request_reviews?: boolean;
}

export interface PagesConfig {
  /** "workflow" (GitHub Actions) or "legacy" (branch). */
  build_type?: "workflow" | "legacy";
  source?: { branch: string; path?: string };
  cname?: string | null;
}

export interface CollaboratorConfig {
  username: string;
  permission?: string;
}

export interface TeamConfig {
  name: string;
  permission?: string;
}

export interface MilestoneConfig {
  title: string;
  description?: string;
  state?: "open" | "closed";
}

export const SECTION_KEYS = [
  "repository",
  "labels",
  "rulesets",
  "branches",
  "environments",
  "autolinks",
  "actions",
  "pages",
  "collaborators",
  "teams",
  "milestones",
] as const;

export type SectionKey = (typeof SECTION_KEYS)[number];
