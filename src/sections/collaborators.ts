/**
 * `collaborators:` section - direct collaborators keyed by username.
 * Undeclared collaborators are REMOVED (the owner never is).
 */

import { roleForPermission } from "../normalize.js";
import type { CollaboratorConfig } from "../schema.js";
import {
  call,
  emptyResult,
  listAll,
  rejectDuplicates,
  type Section,
  type SectionResult,
} from "./section.js";

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
