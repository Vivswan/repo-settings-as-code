/**
 * `teams:` section - team repository access, organization repos only; on a
 * personal account the section no-ops with a note.
 */

import { z } from "zod";
import type { TeamConfig } from "../schema.js";
import {
  call,
  type EndpointDecl,
  emptyResult,
  grantFor,
  probeAbsent,
  rejectDuplicates,
  type SectionModule,
  type SectionPermission,
  type SectionResult,
} from "./contract.js";
import { DEFAULT_ROLE, roleForPermission } from "./roles.js";

const permission: SectionPermission = { repo: ["administration"], org: "members" };

const ENDPOINTS = {
  // GET /orgs/{org} is a public endpoint, so it needs no token permission.
  org: {
    route: "GET /orgs/{org}",
    statuses: { 200: "the organization", 404: "not an organization (a personal account)" },
    permission: "none",
  },
  probe: {
    route: "GET /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}",
    statuses: { 200: "the team's access to the repository", 404: "the team has no access" },
  },
  grant: {
    route: "PUT /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}",
    statuses: { 204: "team access granted" },
  },
} as const satisfies Record<string, EndpointDecl>;

export const teamsSection: SectionModule<"teams"> = {
  key: "teams",
  deletesUndeclared: "untouched",
  permission,
  grant: grantFor(permission),
  endpoints: ENDPOINTS,
  shape: z.array(z.looseObject({ name: z.string() })),
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const desired = desiredRaw as TeamConfig[];
    rejectDuplicates(
      this,
      desired,
      (t) => t.name.toLowerCase(),
      (t) => t.name,
    );
    // Teams only exist on organization repos; on a personal account the org
    // endpoints 404. Probe once and no-op with a note instead of failing;
    // 403/5xx still flow through the permission policy via probeAbsent.
    const orgProbe = await probeAbsent(ctx, this, ENDPOINTS.org, { params: { org: ctx.owner } });
    if ("missing" in orgProbe) {
      result.notes.push(
        `teams: owner "${ctx.owner}" is a personal account, not an organization, so team access does not apply; section skipped - remove the teams section from the settings file to silence this note`,
      );
      return result;
    }
    for (const team of desired) {
      const permission = team.permission ?? DEFAULT_ROLE;
      if (ctx.check) {
        // The repository media type makes this endpoint return the repo
        // object (with role_name) instead of 204.
        const probe = await probeAbsent(ctx, this, ENDPOINTS.probe, {
          params: { org: ctx.owner, team_slug: team.name },
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
        await call(ctx, this, ENDPOINTS.grant, {
          params: { org: ctx.owner, team_slug: team.name },
          payload: {
            ...body, // future sibling keys pass through
            permission,
          },
        });
        result.changes.push(`granted team "${team.name}" ${permission}`);
      }
    }
    return result;
  },
};
