/**
 * `actions:` section - a key router across the four Actions permissions
 * endpoints (base permissions, selected-actions allowlist, workflow token
 * defaults, access level), with unknown keys passed through verbatim.
 */

import { subsetDiff } from "../diff.js";
import type { ActionsConfig } from "../schema.js";
import {
  anyRecord,
  call,
  emptyResult,
  type SectionModule,
  type SectionResult,
  throwFor,
} from "./contract.js";

export const actionsSection: SectionModule<"actions"> = {
  key: "actions",
  grant: `grant "Administration" (read and write) under the PAT's Repository permissions`,
  shape: anyRecord,
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
        const live = await call(ctx, this, "GET", `/repos/${ctx.repo}/actions/permissions`);
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
              this,
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
          this,
          "GET",
          `/repos/${ctx.repo}/actions/permissions/workflow`,
        );
        result.drift.push(...subsetDiff(workflow, live, "actions.workflow"));
      }
      if (desired.access_level !== undefined) {
        const live = await call(ctx, this, "GET", `/repos/${ctx.repo}/actions/permissions/access`);
        result.drift.push(
          ...subsetDiff({ access_level: desired.access_level }, live, "actions.access"),
        );
      }
      return result;
    }

    if (Object.keys(permissions).length > 0) {
      await call(ctx, this, "PUT", `/repos/${ctx.repo}/actions/permissions`, permissions);
      result.changes.push("applied actions permissions");
    }
    if (desired.selected_actions !== undefined) {
      await call(
        ctx,
        this,
        "PUT",
        `/repos/${ctx.repo}/actions/permissions/selected-actions`,
        desired.selected_actions,
      );
      result.changes.push("applied selected-actions policy");
    }
    if (Object.keys(workflow).length > 0) {
      await call(ctx, this, "PUT", `/repos/${ctx.repo}/actions/permissions/workflow`, workflow);
      result.changes.push("applied workflow token permissions");
    }
    if (desired.access_level !== undefined) {
      await call(ctx, this, "PUT", `/repos/${ctx.repo}/actions/permissions/access`, {
        access_level: desired.access_level,
      });
      result.changes.push("applied workflows access level");
    }
    return result;
  },
};
