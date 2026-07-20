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
    const live = (await listAll(ctx, this.key, `/repos/${ctx.repo}/autolinks`)) as LiveAutolink[];
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
    // /workflow sub-endpoint, selected_actions to its own endpoint, and
    // EVERYTHING else (including future fields GitHub adds) passes through
    // to the base permissions PUT verbatim - never silently dropped.
    const WORKFLOW_KEYS = new Set([
      "default_workflow_permissions",
      "can_approve_pull_request_reviews",
    ]);
    const permissions: Record<string, unknown> = {};
    const workflow: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(desired as Record<string, unknown>)) {
      if (key === "selected_actions") {
        continue;
      }
      if (WORKFLOW_KEYS.has(key)) {
        workflow[key] = value;
      } else {
        permissions[key] = value;
      }
    }
    if (permissions.allowed_actions !== undefined) {
      // The PUT body requires `enabled`; declaring an allowed-actions policy
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
        result.drift.push(
          "pages: declared in the settings file but GitHub Pages is not enabled on the repo; apply will enable it",
        );
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
    // Teams only exist on organization repos; on a personal account the org
    // endpoints 404. Probe once and no-op with a note instead of failing.
    const orgProbe = await ctx.api.tryRequest("GET", `/orgs/${ctx.owner}`);
    if ("error" in orgProbe) {
      // Only a confirmed non-org (404) skips; 403/5xx must flow through the
      // permission policy instead of silently no-opping.
      if (orgProbe.error.status !== 404) {
        throwFor(this.key, "GET", `/orgs/${ctx.owner}`, orgProbe.error);
      }
      result.notes.push(
        `teams: owner "${ctx.owner}" is a personal account, not an organization, so team access does not apply; section skipped - remove the teams section from the settings file to silence this note`,
      );
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
          result.drift.push(
            `teams[${team.name}]: no access to ${ctx.repo}; apply will grant "${team.permission ?? "push"}"`,
          );
        } else {
          const permission = team.permission ?? "push";
          const wantRole = roleForPermission[permission] ?? permission;
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
          permission: team.permission ?? "push",
        });
        result.changes.push(`granted team "${team.name}" ${team.permission ?? "push"}`);
      }
    }
    return result;
  },
};
