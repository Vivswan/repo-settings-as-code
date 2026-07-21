/**
 * `teams:` section - team repository access, organization repos only; on a
 * personal account the section no-ops with a note.
 */

import { roleForPermission } from "../normalize.js";
import type { TeamConfig } from "../schema.js";
import {
  call,
  emptyResult,
  probeAbsent,
  rejectDuplicates,
  type Section,
  type SectionResult,
} from "./section.js";

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
