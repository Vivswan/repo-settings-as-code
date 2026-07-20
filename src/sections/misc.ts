/**
 * `environments:`, `autolinks:`, `actions:`, `pages:`, `milestones:`,
 * `collaborators:`, `teams:` sections. Grouped here because each is a small
 * handler over one or two endpoints; they share nothing but the contract.
 */

import { subsetDiff } from "../diff.js";
import type {
  ActionsConfig,
  AutolinkConfig,
  CollaboratorConfig,
  EnvironmentConfig,
  MilestoneConfig,
  PagesConfig,
  TeamConfig,
} from "../schema.js";
import {
  call,
  emptyResult,
  listAll,
  type Section,
  type SectionResult,
  throwFor,
} from "./section.js";

export const environmentsSection: Section = {
  key: "environments",
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    for (const env of desiredRaw as EnvironmentConfig[]) {
      const { name, ...settings } = env;
      const path = `/repos/${ctx.repo}/environments/${encodeURIComponent(name)}`;
      if (ctx.check) {
        const probe = await ctx.api.tryRequest("GET", path);
        if ("error" in probe && probe.error.status !== 404) {
          throwFor(this.key, "GET", path, probe.error);
        }
        if ("error" in probe) {
          result.drift.push(`environments[${name}]: missing`);
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
    const live = (await listAll(ctx, this.key, `/repos/${ctx.repo}/autolinks`)) as LiveAutolink[];
    const liveByPrefix = new Map(live.map((a) => [a.key_prefix, a]));
    const declared = new Set<string>();

    for (const autolink of desired) {
      declared.add(autolink.key_prefix);
      const existing = liveByPrefix.get(autolink.key_prefix);
      const matches =
        existing !== undefined &&
        existing.url_template === autolink.url_template &&
        existing.is_alphanumeric === (autolink.is_alphanumeric ?? true);
      if (matches) {
        continue;
      }
      if (ctx.check) {
        result.drift.push(
          existing
            ? `autolinks[${autolink.key_prefix}]: differs (autolinks are immutable; recreate)`
            : `autolinks[${autolink.key_prefix}]: missing`,
        );
        continue;
      }
      if (existing) {
        // Autolinks have no update endpoint; replace.
        await call(ctx, this.key, "DELETE", `/repos/${ctx.repo}/autolinks/${existing.id}`);
      }
      await call(ctx, this.key, "POST", `/repos/${ctx.repo}/autolinks`, {
        key_prefix: autolink.key_prefix,
        url_template: autolink.url_template,
        is_alphanumeric: autolink.is_alphanumeric ?? true,
      });
      result.changes.push(`${existing ? "replaced" : "created"} autolink ${autolink.key_prefix}`);
    }

    for (const autolink of live) {
      if (!declared.has(autolink.key_prefix)) {
        if (ctx.check) {
          result.drift.push(`autolinks[${autolink.key_prefix}]: undeclared, would be DELETED`);
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
    const permissions: Record<string, unknown> = {};
    if (desired.enabled !== undefined) {
      permissions.enabled = desired.enabled;
    }
    if (desired.allowed_actions !== undefined) {
      permissions.allowed_actions = desired.allowed_actions;
      // The PUT body requires `enabled`; declaring an allowed-actions policy
      // implies actions are on unless said otherwise.
      permissions.enabled = permissions.enabled ?? true;
    }
    const workflow: Record<string, unknown> = {};
    if (desired.default_workflow_permissions !== undefined) {
      workflow.default_workflow_permissions = desired.default_workflow_permissions;
    }
    if (desired.can_approve_pull_request_reviews !== undefined) {
      workflow.can_approve_pull_request_reviews = desired.can_approve_pull_request_reviews;
    }

    if (ctx.check) {
      if (Object.keys(permissions).length > 0) {
        const live = await call(ctx, this.key, "GET", `/repos/${ctx.repo}/actions/permissions`);
        result.drift.push(...subsetDiff(permissions, live, "actions.permissions"));
      }
      if (desired.selected_actions !== undefined) {
        const live = await call(
          ctx,
          this.key,
          "GET",
          `/repos/${ctx.repo}/actions/permissions/selected-actions`,
        );
        result.drift.push(...subsetDiff(desired.selected_actions, live, "actions.selected"));
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
    return result;
  },
};

export const pagesSection: Section = {
  key: "pages",
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const desired = desiredRaw as PagesConfig;
    const probe = await ctx.api.tryRequest("GET", `/repos/${ctx.repo}/pages`);
    if ("error" in probe && probe.error.status !== 404) {
      throwFor(this.key, "GET", `/repos/${ctx.repo}/pages`, probe.error);
    }
    const exists = !("error" in probe);

    if (ctx.check) {
      if (!exists) {
        result.drift.push("pages: not enabled");
      } else {
        result.drift.push(...subsetDiff(desired, probe.data, "pages"));
      }
      return result;
    }

    if (!exists) {
      // The create endpoint accepts only build_type/source; cname and the
      // rest are update-only, so create first, then PUT the remainder.
      const create: Record<string, unknown> = {};
      if (desired.build_type !== undefined) {
        create.build_type = desired.build_type;
      }
      if (desired.source !== undefined) {
        create.source = desired.source;
      }
      await call(ctx, this.key, "POST", `/repos/${ctx.repo}/pages`, create);
      result.changes.push("enabled GitHub Pages");
      const rest = Object.keys(desired).filter((k) => !(k in create));
      if (rest.length > 0) {
        await call(ctx, this.key, "PUT", `/repos/${ctx.repo}/pages`, desired);
        result.changes.push("applied remaining Pages configuration");
      }
    } else {
      await call(ctx, this.key, "PUT", `/repos/${ctx.repo}/pages`, desired);
      result.changes.push("updated GitHub Pages configuration");
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
      // Declared-keys-only: never touch description/state unless declared.
      const want: Record<string, unknown> = { title: milestone.title };
      if (milestone.description !== undefined) {
        want.description = milestone.description;
      }
      if (milestone.state !== undefined) {
        want.state = milestone.state;
      }
      if (!existing) {
        if (ctx.check) {
          result.drift.push(`milestones[${milestone.title}]: missing`);
        } else {
          await call(ctx, this.key, "POST", `/repos/${ctx.repo}/milestones`, want);
          result.changes.push(`created milestone "${milestone.title}"`);
        }
        continue;
      }
      const descriptionDrift =
        milestone.description !== undefined &&
        (existing.description ?? "") !== milestone.description;
      const stateDrift = milestone.state !== undefined && existing.state !== milestone.state;
      if (descriptionDrift || stateDrift) {
        if (ctx.check) {
          result.drift.push(`milestones[${milestone.title}]: description/state differ`);
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
        result.notes.push(`milestone "${milestone.title}" is not declared; left untouched`);
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
      // GET reports role_name in read/triage/write/maintain/admin; the PUT
      // vocabulary is pull/triage/push/maintain/admin. Compare like for like.
      const roleForPermission: Record<string, string> = { push: "write", pull: "read" };
      const wantRole = roleForPermission[permission] ?? permission;
      if (existing && (existing.role_name ?? "") === wantRole) {
        continue;
      }
      if (ctx.check) {
        result.drift.push(
          existing
            ? `collaborators[${collaborator.username}]: role "${existing.role_name}" != wanted "${wantRole}"`
            : `collaborators[${collaborator.username}]: missing (invitation would be sent)`,
        );
      } else {
        await call(
          ctx,
          this.key,
          "PUT",
          `/repos/${ctx.repo}/collaborators/${encodeURIComponent(collaborator.username)}`,
          { permission },
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
        result.drift.push(`collaborators[${collaborator.login}]: undeclared, would be REMOVED`);
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
    // Teams only exist on organization repos; on a personal account the org
    // endpoints 404. Probe once and no-op with a note instead of failing.
    const orgProbe = await ctx.api.tryRequest("GET", `/orgs/${ctx.owner}`);
    if ("error" in orgProbe) {
      // Only a confirmed non-org (404) skips; 403/5xx must flow through the
      // permission policy instead of silently no-opping.
      if (orgProbe.error.status !== 404) {
        throwFor(this.key, "GET", `/orgs/${ctx.owner}`, orgProbe.error);
      }
      result.notes.push("teams: repository owner is not an organization; section skipped");
      return result;
    }
    const roleForPermission: Record<string, string> = { push: "write", pull: "read" };
    for (const team of desired) {
      const path = `/orgs/${ctx.owner}/teams/${encodeURIComponent(team.name)}/repos/${ctx.repo}`;
      if (ctx.check) {
        // The repository media type makes this endpoint return the repo
        // object (with role_name) instead of 204.
        const probe = await ctx.api.tryRequest("GET", path, undefined, {
          accept: "application/vnd.github.v3.repository+json",
        });
        if ("error" in probe && probe.error.status !== 404) {
          throwFor(this.key, "GET", path, probe.error);
        }
        if ("error" in probe) {
          result.drift.push(`teams[${team.name}]: no access to ${ctx.repo}`);
        } else {
          const permission = team.permission ?? "push";
          const wantRole = roleForPermission[permission] ?? permission;
          const liveRole = (probe.data as { role_name?: string } | null)?.role_name ?? "";
          if (liveRole !== wantRole) {
            result.drift.push(`teams[${team.name}]: role "${liveRole}" != wanted "${wantRole}"`);
          }
        }
      } else {
        await call(ctx, this.key, "PUT", path, { permission: team.permission ?? "push" });
        result.changes.push(`granted team "${team.name}" ${team.permission ?? "push"}`);
      }
    }
    return result;
  },
};
