/**
 * `actions:` section - a key router across the four Actions permissions
 * endpoints (base permissions, selected-actions allowlist, workflow token
 * defaults, access level), with unknown keys passed through verbatim.
 */

import { subsetDiff } from "../engine/diff.js";
import type { ActionsConfig } from "../schema.js";
import {
  anyRecord,
  call,
  type EndpointDecl,
  emptyResult,
  grantFor,
  probeAbsent,
  type SectionModule,
  type SectionPermission,
  type SectionResult,
} from "./contract.js";

const permission: SectionPermission = { repo: ["administration"] };

const ENDPOINTS = {
  getPermissions: {
    route: "GET /repos/{owner}/{repo}/actions/permissions",
    statuses: { 200: "the Actions permissions policy" },
  },
  putPermissions: {
    route: "PUT /repos/{owner}/{repo}/actions/permissions",
    statuses: { 204: "Actions permissions policy applied" },
  },
  getSelected: {
    route: "GET /repos/{owner}/{repo}/actions/permissions/selected-actions",
    statuses: {
      200: "the selected-actions allowlist",
      404: "no allowlist because the policy is not selected",
      409: "the allowed_actions policy is not selected, so the allowlist does not apply",
    },
  },
  putSelected: {
    route: "PUT /repos/{owner}/{repo}/actions/permissions/selected-actions",
    statuses: { 204: "selected-actions allowlist applied" },
  },
  getWorkflow: {
    route: "GET /repos/{owner}/{repo}/actions/permissions/workflow",
    statuses: { 200: "the workflow token permissions" },
  },
  putWorkflow: {
    route: "PUT /repos/{owner}/{repo}/actions/permissions/workflow",
    statuses: { 204: "workflow token permissions applied" },
  },
  getAccess: {
    route: "GET /repos/{owner}/{repo}/actions/permissions/access",
    statuses: { 200: "the workflows access level" },
  },
  putAccess: {
    route: "PUT /repos/{owner}/{repo}/actions/permissions/access",
    statuses: { 204: "workflows access level applied" },
  },
} as const satisfies Record<string, EndpointDecl>;

export const actionsSection: SectionModule<"actions"> = {
  key: "actions",
  permission,
  grant: grantFor(permission),
  endpoints: ENDPOINTS,
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
      // The base PUT body always carries an enabled value (defaulted above),
      // so a mis-routed key can flip Actions on as a side effect; say so.
      // JSON.stringify keeps a malformed quoted "false" distinguishable from
      // the boolean in the message.
      const enabledValue = JSON.stringify(permissions.enabled);
      result.notes.push(
        ctx.check
          ? `key(s) [${routed.join(", ")}] are not recognized by this action; apply would send them verbatim to PUT /actions/permissions (a body that also sets enabled: ${enabledValue}), where GitHub may ignore them - a "no such field" drift line for a key below means GitHub does not accept it there; remove it from the actions section of the settings file`
          : `key(s) [${routed.join(", ")}] are not recognized by this action; they were sent verbatim to PUT /actions/permissions (a body that also sets enabled: ${enabledValue}), where GitHub may ignore them - run mode: check to confirm they took effect, or remove them from the actions section of the settings file`,
      );
    }

    if (ctx.check) {
      if (Object.keys(permissions).length > 0) {
        const live = await call(ctx, this, ENDPOINTS.getPermissions);
        result.drift.push(...subsetDiff(permissions, live, "actions.permissions"));
      }
      if (desired.selected_actions !== undefined) {
        // This GET errors (409) when the live allowed_actions policy is not
        // "selected"; that is drift, not a failure. The declared statuses
        // (200, 409, 404) make 409 and 404 tolerated automatically.
        const probe = await probeAbsent(ctx, this, ENDPOINTS.getSelected);
        if ("missing" in probe) {
          result.drift.push(
            'actions.selected: the live allowed_actions policy is not "selected", so no selected-actions allowlist exists; apply will set the declared policy and allowlist',
          );
        } else {
          result.drift.push(
            ...subsetDiff(desired.selected_actions, probe.data, "actions.selected"),
          );
        }
      }
      if (Object.keys(workflow).length > 0) {
        const live = await call(ctx, this, ENDPOINTS.getWorkflow);
        result.drift.push(...subsetDiff(workflow, live, "actions.workflow"));
      }
      if (desired.access_level !== undefined) {
        const live = await call(ctx, this, ENDPOINTS.getAccess);
        result.drift.push(
          ...subsetDiff({ access_level: desired.access_level }, live, "actions.access"),
        );
      }
      return result;
    }

    if (Object.keys(permissions).length > 0) {
      await call(ctx, this, ENDPOINTS.putPermissions, { payload: permissions });
      result.changes.push("applied actions permissions");
    }
    if (desired.selected_actions !== undefined) {
      await call(ctx, this, ENDPOINTS.putSelected, { payload: desired.selected_actions });
      result.changes.push("applied selected-actions policy");
    }
    if (Object.keys(workflow).length > 0) {
      await call(ctx, this, ENDPOINTS.putWorkflow, { payload: workflow });
      result.changes.push("applied workflow token permissions");
    }
    if (desired.access_level !== undefined) {
      await call(ctx, this, ENDPOINTS.putAccess, {
        payload: { access_level: desired.access_level },
      });
      result.changes.push("applied workflows access level");
    }
    return result;
  },
};
