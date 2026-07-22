/**
 * `workflows:` section - enable/disable existing workflows by path. A
 * declared workflow whose file does not exist is skipped loudly, never
 * created (workflow files are code, not settings).
 */

import { z } from "zod";
import type { WorkflowConfig } from "../schema.js";
import {
  call,
  type EndpointDecl,
  emptyResult,
  grantFor,
  listAllEnveloped,
  rejectDuplicates,
  type SectionModule,
  type SectionPermission,
  type SectionResult,
} from "./contract.js";

interface LiveWorkflow {
  id: number;
  name: string;
  path: string;
  state: string;
}

const permission: SectionPermission = { repo: ["actions"] };

const ENDPOINTS = {
  list: {
    route: "GET /repos/{owner}/{repo}/actions/workflows",
    statuses: { 200: "the workflow list" },
  },
  enable: {
    route: "PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/enable",
    statuses: { 204: "workflow enabled" },
  },
  disable: {
    route: "PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/disable",
    statuses: { 204: "workflow disabled" },
  },
} as const satisfies Record<string, EndpointDecl>;

export const workflowsSection: SectionModule<"workflows"> = {
  key: "workflows",
  permission,
  grant: grantFor(permission),
  endpoints: ENDPOINTS,
  shape: z.array(z.looseObject({ path: z.string(), state: z.enum(["active", "disabled"]) })),
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const desired = desiredRaw as WorkflowConfig[];
    // Two entries naming the same file (e.g. "ci.yml" and
    // ".github/workflows/ci.yml") would fight each other on every run.
    rejectDuplicates(
      this,
      desired,
      (w) => (w.path.includes("/") ? w.path : `.github/workflows/${w.path}`),
      (w) => w.path,
    );
    const live = (await listAllEnveloped(ctx, this, ENDPOINTS.list, "workflows")) as LiveWorkflow[];
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
        await call(ctx, this, action === "enable" ? ENDPOINTS.enable : ENDPOINTS.disable, {
          params: { workflow_id: String(match.id) },
        });
        result.changes.push(`${action}d workflow "${match.path}"`);
      }
    }
    return result;
  },
};
