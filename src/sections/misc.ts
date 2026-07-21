/**
 * The one-or-two-endpoint section handlers: `environments:`, `autolinks:`,
 * `actions:`, `workflows:`, `pages:`, `code_scanning_default_setup:`,
 * `milestones:`, `collaborators:`, `teams:`. They share nothing but the
 * contract and the section.ts helpers.
 */

import { subsetDiff } from "../diff.js";
import { roleForPermission } from "../normalize.js";
import type {
  ActionsConfig,
  AutolinkConfig,
  CollaboratorConfig,
  EnvironmentConfig,
  MilestoneConfig,
  PagesConfig,
  TeamConfig,
  WorkflowConfig,
} from "../schema.js";
import {
  call,
  emptyResult,
  listAll,
  listAllEnveloped,
  probeAbsent,
  rejectDuplicates,
  type Section,
  type SectionResult,
  throwFor,
} from "./section.js";

export const environmentsSection: Section = {
  key: "environments",
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const desired = desiredRaw as EnvironmentConfig[];
    rejectDuplicates(
      this.key,
      desired,
      (env) => env.name.toLowerCase(),
      (env) => env.name,
    );
    for (const env of desired) {
      const { name, ...settings } = env;
      const path = `/repos/${ctx.repo}/environments/${encodeURIComponent(name)}`;
      if (ctx.check) {
        const probe = await probeAbsent(ctx, this.key, path);
        if ("missing" in probe) {
          result.drift.push(
            `environments[${name}]: missing - declared in the settings file but not on the repo; apply will create it`,
          );
        } else {
          result.drift.push(
            ...subsetDiff(settings, flattenEnvironment(probe.data), `environments[${name}]`),
          );
        }
      } else {
        await call(ctx, this.key, "PUT", path, settings);
        result.changes.push(`applied environment "${name}"`);
      }
    }
    return result;
  },
};

/**
 * GET /environments/{name} nests wait_timer / prevent_self_review / reviewers
 * inside protection_rules[]; translate back into the PUT request shape so
 * check mode compares like with like.
 */
function flattenEnvironment(live: unknown): Record<string, unknown> {
  const raw = (live ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...raw };
  const rules = (raw.protection_rules ?? []) as Array<Record<string, unknown>>;
  for (const rule of rules) {
    if (rule.type === "wait_timer") {
      out.wait_timer = rule.wait_timer;
    }
    if (rule.type === "required_reviewers") {
      if (rule.prevent_self_review !== undefined) {
        out.prevent_self_review = rule.prevent_self_review;
      }
      const reviewers = (rule.reviewers ?? []) as Array<{
        type: unknown;
        reviewer?: { id?: unknown };
      }>;
      out.reviewers = reviewers.map((r) => ({ type: r.type, id: r.reviewer?.id }));
    }
    if (rule.type !== "wait_timer" && rule.type !== "required_reviewers") {
      // Future rule types: un-nest their payload keys generically so check
      // mode can compare declared settings instead of reporting false drift.
      for (const [key, value] of Object.entries(rule)) {
        if (!["id", "node_id", "type", "url"].includes(key)) {
          out[key] = value;
        }
      }
    }
  }
  return out;
}

interface LiveAutolink {
  id: number;
  key_prefix: string;
  url_template: string;
  is_alphanumeric: boolean;
}

export const autolinksSection: Section = {
  key: "autolinks",
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const desired = desiredRaw as AutolinkConfig[];
    rejectDuplicates(
      this.key,
      desired,
      (a) => a.key_prefix,
      (a) => a.key_prefix,
    );
    // The autolinks list endpoint is not paginated; a single GET returns
    // everything, and sending page params would not advance anything.
    const live = (await call(
      ctx,
      this.key,
      "GET",
      `/repos/${ctx.repo}/autolinks`,
    )) as LiveAutolink[];
    const liveByPrefix = new Map(live.map((a) => [a.key_prefix, a]));
    const declared = new Set<string>();

    for (const autolink of desired) {
      declared.add(autolink.key_prefix);
      const existing = liveByPrefix.get(autolink.key_prefix);
      const { key_prefix: _kp, ...declaredFields } = autolink;
      const matches =
        existing !== undefined && subsetDiff(declaredFields, existing, "autolink").length === 0;
      if (matches) {
        continue;
      }
      if (ctx.check) {
        result.drift.push(
          existing
            ? `autolinks[${autolink.key_prefix}]: live settings differ from the settings file, and autolinks cannot be edited; apply will delete and recreate it`
            : `autolinks[${autolink.key_prefix}]: missing - declared in the settings file but not on the repo; apply will create it`,
        );
        continue;
      }
      if (existing) {
        // Autolinks have no update endpoint; replace.
        await call(ctx, this.key, "DELETE", `/repos/${ctx.repo}/autolinks/${existing.id}`);
      }
      await call(ctx, this.key, "POST", `/repos/${ctx.repo}/autolinks`, {
        is_alphanumeric: true,
        ...autolink, // declared keys (including future ones) pass through
      });
      result.changes.push(`${existing ? "replaced" : "created"} autolink ${autolink.key_prefix}`);
    }

    for (const autolink of live) {
      if (!declared.has(autolink.key_prefix)) {
        if (ctx.check) {
          result.drift.push(
            `autolinks[${autolink.key_prefix}]: undeclared - not in the settings file, so apply will DELETE it; add it to the settings file to keep it`,
          );
        } else {
          await call(ctx, this.key, "DELETE", `/repos/${ctx.repo}/autolinks/${autolink.id}`);
          result.changes.push(`DELETED undeclared autolink ${autolink.key_prefix}`);
        }
      }
    }
    return result;
  },
};

export const actionsSection: Section = {
  key: "actions",
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const desired = desiredRaw as ActionsConfig;
    // Forward-compatible key routing: known workflow-token keys go to the
    // /workflow sub-endpoint, selected_actions and access_level to their own
    // endpoints, and EVERYTHING else (including future fields GitHub adds)
    // passes through to the base permissions PUT verbatim - never silently
    // dropped.
    const WORKFLOW_KEYS = new Set([
      "default_workflow_permissions",
      "can_approve_pull_request_reviews",
    ]);
    const permissions: Record<string, unknown> = {};
    const workflow: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(desired as Record<string, unknown>)) {
      if (key === "selected_actions" || key === "access_level") {
        continue;
      }
      if (WORKFLOW_KEYS.has(key)) {
        workflow[key] = value;
      } else {
        permissions[key] = value;
      }
    }
    if (desired.selected_actions !== undefined) {
      // The allowlist endpoint answers 409 unless the policy is "selected";
      // infer the policy when it is undeclared, reject a contradiction.
      if (permissions.allowed_actions === undefined) {
        permissions.allowed_actions = "selected";
      } else if (permissions.allowed_actions !== "selected") {
        throw new Error(
          `actions: selected_actions is declared together with allowed_actions: "${permissions.allowed_actions}", but an allowlist only applies under allowed_actions: "selected". Set allowed_actions to "selected", or remove selected_actions`,
        );
      }
    }
    if (Object.keys(permissions).length > 0) {
      // The PUT body requires `enabled`; declaring any base-permissions key
      // implies actions are on unless said otherwise.
      permissions.enabled = permissions.enabled ?? true;
    }
    const KNOWN_PERMISSION_KEYS = new Set(["enabled", "allowed_actions"]);
    const routed = Object.keys(permissions).filter((k) => !KNOWN_PERMISSION_KEYS.has(k));
    if (routed.length > 0) {
      result.notes.push(
        `key(s) [${routed.join(", ")}] are not recognized by this action; they were sent verbatim to PUT /actions/permissions, where GitHub may ignore them - run mode: check to confirm they took effect, or remove them from the actions section of the settings file`,
      );
    }

    if (ctx.check) {
      if (Object.keys(permissions).length > 0) {
        const live = await call(ctx, this.key, "GET", `/repos/${ctx.repo}/actions/permissions`);
        result.drift.push(...subsetDiff(permissions, live, "actions.permissions"));
      }
      if (desired.selected_actions !== undefined) {
        // This GET errors (409) when the live allowed_actions policy is not
        // "selected"; that is drift, not a failure.
        const probe = await ctx.api.tryRequest(
          "GET",
          `/repos/${ctx.repo}/actions/permissions/selected-actions`,
        );
        if ("error" in probe) {
          if (probe.error.status === 409 || probe.error.status === 404) {
            result.drift.push(
              'actions.selected: the live allowed_actions policy is not "selected", so no selected-actions allowlist exists; apply will set the declared policy and allowlist',
            );
          } else {
            throwFor(
              this.key,
              "GET",
              `/repos/${ctx.repo}/actions/permissions/selected-actions`,
              probe.error,
            );
          }
        } else {
          result.drift.push(
            ...subsetDiff(desired.selected_actions, probe.data, "actions.selected"),
          );
        }
      }
      if (Object.keys(workflow).length > 0) {
        const live = await call(
          ctx,
          this.key,
          "GET",
          `/repos/${ctx.repo}/actions/permissions/workflow`,
        );
        result.drift.push(...subsetDiff(workflow, live, "actions.workflow"));
      }
      if (desired.access_level !== undefined) {
        const live = await call(
          ctx,
          this.key,
          "GET",
          `/repos/${ctx.repo}/actions/permissions/access`,
        );
        result.drift.push(
          ...subsetDiff({ access_level: desired.access_level }, live, "actions.access"),
        );
      }
      return result;
    }

    if (Object.keys(permissions).length > 0) {
      await call(ctx, this.key, "PUT", `/repos/${ctx.repo}/actions/permissions`, permissions);
      result.changes.push("applied actions permissions");
    }
    if (desired.selected_actions !== undefined) {
      await call(
        ctx,
        this.key,
        "PUT",
        `/repos/${ctx.repo}/actions/permissions/selected-actions`,
        desired.selected_actions,
      );
      result.changes.push("applied selected-actions policy");
    }
    if (Object.keys(workflow).length > 0) {
      await call(ctx, this.key, "PUT", `/repos/${ctx.repo}/actions/permissions/workflow`, workflow);
      result.changes.push("applied workflow token permissions");
    }
    if (desired.access_level !== undefined) {
      await call(ctx, this.key, "PUT", `/repos/${ctx.repo}/actions/permissions/access`, {
        access_level: desired.access_level,
      });
      result.changes.push("applied workflows access level");
    }
    return result;
  },
};

export const pagesSection: Section = {
  key: "pages",
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const probe = await probeAbsent(ctx, this.key, `/repos/${ctx.repo}/pages`);
    const exists = !("missing" in probe);
    const liveSite = "data" in probe ? probe.data : undefined;

    // pages: null declares Pages OFF, mirroring branches' protection: null.
    if (desiredRaw === null) {
      if (!exists) {
        // A 404 here is ambiguous: no Pages site, or a fine-grained token
        // without the Pages permission (which also answers 404). The
        // non-null path stays loud either way (the POST would fail); this
        // no-op path must say so instead of silently succeeding.
        result.notes.push(
          "pages: declared null and GitHub reports no Pages site, so there is nothing to disable. A fine-grained token missing the Pages permission gets the same answer; if this repo does have a Pages site, grant the token Pages read and write",
        );
        return result;
      }
      if (ctx.check) {
        result.drift.push(
          "pages: enabled live but the settings file declares pages: null; apply will disable GitHub Pages",
        );
        return result;
      }
      await call(ctx, this.key, "DELETE", `/repos/${ctx.repo}/pages`);
      result.changes.push("disabled GitHub Pages");
      return result;
    }
    const desired = desiredRaw as PagesConfig;
    if (Object.keys(desired).length === 0) {
      result.notes.push(
        "pages: declared as an empty mapping, which configures nothing (the update endpoint rejects an empty body). Declare at least one field, use pages: null to disable the site, or remove the section",
      );
      return result;
    }
    // The update PUT requires path alongside branch when source is sent;
    // the create POST defaults it, so default it everywhere.
    const payload: Record<string, unknown> = { ...desired };
    if (desired.source !== undefined && desired.source.path === undefined) {
      payload.source = { ...desired.source, path: "/" };
    }

    if (ctx.check) {
      if (!exists) {
        result.drift.push(
          "pages: declared in the settings file but GitHub Pages is not enabled on the repo; apply will enable it",
        );
      } else {
        result.drift.push(...subsetDiff(payload, liveSite, "pages"));
      }
      return result;
    }

    if (!exists) {
      // The create endpoint accepts only build_type/source; cname and the
      // rest are update-only, so create first, then PUT the remainder.
      const create: Record<string, unknown> = {};
      if (payload.build_type !== undefined) {
        create.build_type = payload.build_type;
      }
      if (payload.source !== undefined) {
        create.source = payload.source;
      }
      await call(ctx, this.key, "POST", `/repos/${ctx.repo}/pages`, create);
      result.changes.push("enabled GitHub Pages");
      const rest = Object.keys(payload).filter((k) => !(k in create));
      if (rest.length > 0) {
        await call(ctx, this.key, "PUT", `/repos/${ctx.repo}/pages`, payload);
        result.changes.push("applied remaining Pages configuration");
      }
    } else {
      await call(ctx, this.key, "PUT", `/repos/${ctx.repo}/pages`, payload);
      result.changes.push("updated GitHub Pages configuration");
    }
    return result;
  },
};

interface LiveWorkflow {
  id: number;
  name: string;
  path: string;
  state: string;
}

export const workflowsSection: Section = {
  key: "workflows",
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const desired = desiredRaw as WorkflowConfig[];
    // Two entries naming the same file (e.g. "ci.yml" and
    // ".github/workflows/ci.yml") would fight each other on every run.
    rejectDuplicates(
      this.key,
      desired,
      (w) => (w.path.includes("/") ? w.path : `.github/workflows/${w.path}`),
      (w) => w.path,
    );
    const live = (await listAllEnveloped(
      ctx,
      this.key,
      `/repos/${ctx.repo}/actions/workflows`,
      "workflows",
    )) as LiveWorkflow[];
    // A "deleted" workflow has no file behind it anymore; treat as absent.
    const present = live.filter((w) => w.state !== "deleted");

    for (const workflow of desired) {
      const match = present.find(
        (w) => w.path === workflow.path || w.path === `.github/workflows/${workflow.path}`,
      );
      if (!match) {
        if (ctx.check) {
          result.drift.push(
            `workflows[${workflow.path}]: declared in the settings file but no workflow with that path exists on the repo; apply will skip it - create the workflow file, or remove it from the workflows section`,
          );
        } else {
          result.notes.push(
            `workflow "${workflow.path}" is declared in the settings file but no workflow with that path exists on the repo; skipped - create the workflow file, or remove it from the workflows section`,
          );
        }
        continue;
      }
      // Every disabled_* live state counts as "disabled".
      const liveState = match.state === "active" ? "active" : "disabled";
      if (liveState === workflow.state) {
        continue;
      }
      const action = workflow.state === "active" ? "enable" : "disable";
      if (ctx.check) {
        const raw = match.state === liveState ? "" : ` (${match.state})`;
        result.drift.push(
          `workflows[${workflow.path}]: declared "${workflow.state}" != live "${liveState}"${raw}; apply will ${action} the workflow`,
        );
      } else {
        await call(
          ctx,
          this.key,
          "PUT",
          `/repos/${ctx.repo}/actions/workflows/${match.id}/${action}`,
        );
        result.changes.push(`${action}d workflow "${match.path}"`);
      }
    }
    return result;
  },
};

export const codeScanningDefaultSetupSection: Section = {
  key: "code_scanning_default_setup",
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const desired = desiredRaw as Record<string, unknown>;
    const path = `/repos/${ctx.repo}/code-scanning/default-setup`;

    if (ctx.check) {
      const live = await call(ctx, this.key, "GET", path);
      result.drift.push(...subsetDiff(desired, live, "code_scanning_default_setup"));
      return result;
    }

    // Raw tryRequest so a 409 (a configuration run is already in progress)
    // gets accurate advice instead of throwFor's generic fix-the-file text.
    const patch = await ctx.api.tryRequest("PATCH", path, desired);
    if ("error" in patch) {
      if (patch.error.status === 409) {
        throw new Error(
          `code_scanning_default_setup: PATCH ${path}: 409 ${patch.error.message}. A default-setup configuration run is already in progress on the repository; re-run the workflow after it finishes`,
        );
      }
      throwFor(this.key, "PATCH", path, patch.error);
    }
    const run = patch.data as { run_id?: number; run_url?: string } | null;
    if (run?.run_id !== undefined) {
      const url = run.run_url ? ` (${run.run_url})` : "";
      result.changes.push(
        `applied code scanning default setup; GitHub started configuration run ${run.run_id}${url} to roll it out, and the settings take effect when it finishes`,
      );
    } else {
      result.changes.push("applied code scanning default setup");
    }
    return result;
  },
};

interface LiveMilestone {
  number: number;
  title: string;
  description: string | null;
  state: string;
}

export const milestonesSection: Section = {
  key: "milestones",
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const desired = desiredRaw as MilestoneConfig[];
    rejectDuplicates(
      this.key,
      desired,
      (m) => m.title,
      (m) => m.title,
    );
    const live = (await listAll(
      ctx,
      this.key,
      `/repos/${ctx.repo}/milestones?state=all`,
    )) as LiveMilestone[];
    const liveByTitle = new Map(live.map((m) => [m.title, m]));
    const declared = new Set<string>();

    for (const milestone of desired) {
      declared.add(milestone.title);
      const existing = liveByTitle.get(milestone.title);
      // Declared-keys-only AND passthrough: every declared key (including
      // future ones like due_on) is sent verbatim; undeclared keys are
      // never touched.
      const want: Record<string, unknown> = { ...milestone };
      if (!existing) {
        if (ctx.check) {
          result.drift.push(
            `milestones[${milestone.title}]: missing - declared in the settings file but not on the repo; apply will create it`,
          );
        } else {
          await call(ctx, this.key, "POST", `/repos/${ctx.repo}/milestones`, want);
          result.changes.push(`created milestone "${milestone.title}"`);
        }
        continue;
      }
      const { title: _t, ...declaredFields } = milestone;
      const drift = subsetDiff(declaredFields, existing, `milestones[${milestone.title}]`);
      if (drift.length > 0) {
        if (ctx.check) {
          result.drift.push(...drift);
        } else {
          await call(
            ctx,
            this.key,
            "PATCH",
            `/repos/${ctx.repo}/milestones/${existing.number}`,
            want,
          );
          result.changes.push(`updated milestone "${milestone.title}"`);
        }
      }
    }
    // Divergence from Probot: undeclared milestones are kept (they may hold
    // issues); surfaced as notes instead.
    for (const milestone of live) {
      if (!declared.has(milestone.title)) {
        result.notes.push(
          `milestone "${milestone.title}" exists on the repo but is not declared in the settings file; left untouched - add it to the settings file to manage it, or delete it on GitHub (closing is not enough; closed milestones are still listed)`,
        );
      }
    }
    return result;
  },
};

interface LiveCollaborator {
  login: string;
  permissions?: Record<string, boolean>;
  role_name?: string;
}

export const collaboratorsSection: Section = {
  key: "collaborators",
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const desired = desiredRaw as CollaboratorConfig[];
    rejectDuplicates(
      this.key,
      desired,
      (c) => c.username.toLowerCase(),
      (c) => c.username,
    );
    const live = (await listAll(
      ctx,
      this.key,
      `/repos/${ctx.repo}/collaborators?affiliation=direct`,
    )) as LiveCollaborator[];
    const liveByLogin = new Map(live.map((c) => [c.login.toLowerCase(), c]));
    const declared = new Set<string>();

    for (const collaborator of desired) {
      const login = collaborator.username.toLowerCase();
      declared.add(login);
      const permission = collaborator.permission ?? "push";
      const existing = liveByLogin.get(login);
      const wantRole = roleForPermission(permission);
      if (existing && (existing.role_name ?? "") === wantRole) {
        continue;
      }
      if (ctx.check) {
        result.drift.push(
          existing
            ? `collaborators[${collaborator.username}]: live role "${existing.role_name}" != declared "${wantRole}"; apply will set the declared permission`
            : `collaborators[${collaborator.username}]: missing - not a collaborator on the repo; apply will send an invitation with "${permission}"`,
        );
      } else {
        const { username: _u, ...body } = collaborator;
        await call(
          ctx,
          this.key,
          "PUT",
          `/repos/${ctx.repo}/collaborators/${encodeURIComponent(collaborator.username)}`,
          { ...body, permission }, // future sibling keys pass through
        );
        result.changes.push(
          `${existing ? "updated" : "invited"} collaborator "${collaborator.username}" (${permission})`,
        );
      }
    }

    for (const collaborator of live) {
      const login = collaborator.login.toLowerCase();
      if (login === ctx.owner.toLowerCase() || declared.has(login)) {
        continue; // never remove the owner
      }
      if (ctx.check) {
        result.drift.push(
          `collaborators[${collaborator.login}]: undeclared - not in the settings file, so apply will REMOVE them; add them to the settings file to keep their access`,
        );
      } else {
        await call(
          ctx,
          this.key,
          "DELETE",
          `/repos/${ctx.repo}/collaborators/${encodeURIComponent(collaborator.login)}`,
        );
        result.changes.push(`REMOVED undeclared collaborator "${collaborator.login}"`);
      }
    }
    return result;
  },
};

export const teamsSection: Section = {
  key: "teams",
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const desired = desiredRaw as TeamConfig[];
    rejectDuplicates(
      this.key,
      desired,
      (t) => t.name.toLowerCase(),
      (t) => t.name,
    );
    // Teams only exist on organization repos; on a personal account the org
    // endpoints 404. Probe once and no-op with a note instead of failing;
    // 403/5xx still flow through the permission policy via probeAbsent.
    const orgProbe = await probeAbsent(ctx, this.key, `/orgs/${ctx.owner}`);
    if ("missing" in orgProbe) {
      result.notes.push(
        `teams: owner "${ctx.owner}" is a personal account, not an organization, so team access does not apply; section skipped - remove the teams section from the settings file to silence this note`,
      );
      return result;
    }
    for (const team of desired) {
      const permission = team.permission ?? "push";
      const path = `/orgs/${ctx.owner}/teams/${encodeURIComponent(team.name)}/repos/${ctx.repo}`;
      if (ctx.check) {
        // The repository media type makes this endpoint return the repo
        // object (with role_name) instead of 204.
        const probe = await probeAbsent(ctx, this.key, path, {
          accept: "application/vnd.github.v3.repository+json",
        });
        if ("missing" in probe) {
          result.drift.push(
            `teams[${team.name}]: no access to ${ctx.repo}; apply will grant "${permission}"`,
          );
        } else {
          const wantRole = roleForPermission(permission);
          const liveRole = (probe.data as { role_name?: string } | null)?.role_name ?? "";
          if (liveRole !== wantRole) {
            result.drift.push(
              `teams[${team.name}]: live role "${liveRole}" != declared "${wantRole}"; apply will set the declared permission`,
            );
          }
        }
      } else {
        const { name: _n, ...body } = team;
        await call(ctx, this.key, "PUT", path, {
          ...body, // future sibling keys pass through
          permission,
        });
        result.changes.push(`granted team "${team.name}" ${permission}`);
      }
    }
    return result;
  },
};
