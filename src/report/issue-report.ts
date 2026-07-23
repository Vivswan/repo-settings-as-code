/**
 * The `issue` private-report channel: the full unredacted report lands as
 * a deterministically-titled issue on the private target repo itself - the
 * one GitHub-ACL-private channel a public run has under PAT auth. One issue
 * per repo, reused every run: the body is REPLACED (prior reports stay in
 * the issue-body edit history) and the state mirrors the run's exit
 * semantics (open = needs attention, closed = latest report inside, all
 * well).
 *
 * Shaped like a SectionModule where it matters - an ENDPOINTS dictionary
 * and a permission declaration - so the mock route table, USED_PATHS, and
 * the PAT grant prose pick it up through the existing machinery. It is NOT
 * a settings section (never registered in sections/registry.ts): report
 * delivery is infrastructure that writes even in check mode.
 */

import type { ApiError, GithubClient } from "../github/api.js";
import { isPermissionError } from "../github/api.js";
import { paginate } from "../github/paginate.js";
import type { LabelConfig, SettingsFile } from "../schema.js";
import {
  type EndpointDecl,
  expand,
  grantFor,
  type SectionPermission,
} from "../sections/contract.js";
import { nameKey } from "../sections/labels.js";

/** The lookup key: one exact-titled report issue per repo, forever reused. */
export const ISSUE_TITLE = "[automated] settings-as-code: private settings report";

/**
 * The marker label that makes the lookup one indexed, database-consistent
 * request (the search API is eventually consistent and separately
 * throttled, so it is not used at all).
 */
export const MARKER_LABEL = "settings-as-code-report";

/** The marker label as the labels section (and ensure-create) declares it. */
export const MARKER_LABEL_CONFIG = {
  name: MARKER_LABEL,
  color: "0e2a47",
  description: "managed by settings-as-code private reporting - do not remove",
} as const satisfies LabelConfig;

export const ISSUE_REPORT_PERMISSION: SectionPermission = { repo: ["issues"] };

export const ISSUE_REPORT_ENDPOINTS = {
  list: {
    route: "GET /repos/{owner}/{repo}/issues",
    statuses: { 200: "the issue list (pull requests included)" },
  },
  create: {
    route: "POST /repos/{owner}/{repo}/issues",
    statuses: { 201: "report issue created" },
  },
  update: {
    route: "PATCH /repos/{owner}/{repo}/issues/{issue_number}",
    statuses: { 200: "report issue updated" },
  },
  createLabel: {
    route: "POST /repos/{owner}/{repo}/labels",
    statuses: { 201: "marker label created", 422: "the marker label already exists" },
  },
  user: {
    route: "GET /user",
    statuses: { 200: "the token's user, for the fallback creator scan" },
    permission: "none",
  },
} as const satisfies Record<string, EndpointDecl>;

/** Success carries the issue URL for the run summary; failure a safe warning. */
export type IssueDelivery = { url: string } | { warning: string };

/** The owner/repo halves expand() needs, from an owner/name slug. */
function repoRef(slug: string): { owner: string; repo: string } {
  return { owner: slug.slice(0, slug.indexOf("/")), repo: slug };
}

/**
 * The one failure surface, and it must stay public-safe: the warning names
 * the HTTP status and generic advice only - never the slug, the request
 * path, or the API's message, all of which would leak into public logs.
 */
function deliveryWarning(error: ApiError): { warning: string } {
  const advice = isPermissionError(error)
    ? `To fix, ${grantFor(ISSUE_REPORT_PERMISSION)} for the target repository, or set private-report: none`
    : "Re-run the workflow, or set private-report: none if it persists";
  return { warning: `could not deliver the private report (HTTP ${error.status}). ${advice}` };
}

function malformedWarning(): { warning: string } {
  return {
    warning:
      'could not deliver the private report: the issues API returned an unexpected shape. Check the "api-version" input, or set private-report: none',
  };
}

/**
 * The report issue in a page of issue-list entries: skips pull requests
 * (the issues list includes them) and demands the exact title.
 */
function reportIssueIn(items: unknown[]): { number: number; url: string } | null {
  for (const item of items) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const issue = item as Record<string, unknown>;
    if (issue.pull_request !== undefined || issue.title !== ISSUE_TITLE) {
      continue;
    }
    if (typeof issue.number !== "number") {
      continue;
    }
    return { number: issue.number, url: typeof issue.html_url === "string" ? issue.html_url : "" };
  }
  return null;
}

/**
 * The fallback lookup for when a human stripped the marker label: an
 * early-exit scan of the token user's own issues in creation order. It runs
 * BEFORE any create, so a stripped label can never cause a duplicate.
 */
async function fallbackScan(
  api: GithubClient,
  ref: { owner: string; repo: string },
): Promise<{ found: { number: number; url: string } | null } | { warning: string }> {
  const user = await api.tryRequest("GET", expand(ISSUE_REPORT_ENDPOINTS.user, ref));
  if ("error" in user) {
    return deliveryWarning(user.error);
  }
  const login = (user.data as { login?: unknown } | null)?.login;
  if (typeof login !== "string" || login === "") {
    return malformedWarning();
  }
  const path = expand(ISSUE_REPORT_ENDPOINTS.list, ref, undefined, {
    state: "all",
    creator: login,
    sort: "created",
    direction: "asc",
  });
  const page = await paginate(api, path, undefined, (items) => reportIssueIn(items) !== null);
  if ("error" in page) {
    return deliveryWarning(page.error);
  }
  if ("malformed" in page) {
    return malformedWarning();
  }
  return { found: reportIssueIn(page.items) };
}

async function deliver(
  api: GithubClient,
  slug: string,
  body: string,
  needsAttention: boolean,
): Promise<IssueDelivery> {
  const ref = repoRef(slug);
  // Ensure the marker label exists so lookup stays one indexed request;
  // a 422 means it already does.
  const label = await api.tryRequest("POST", expand(ISSUE_REPORT_ENDPOINTS.createLabel, ref), {
    name: MARKER_LABEL_CONFIG.name,
    color: MARKER_LABEL_CONFIG.color,
    description: MARKER_LABEL_CONFIG.description,
  });
  if ("error" in label && label.error.status !== 422) {
    return deliveryWarning(label.error);
  }
  const listPath = expand(ISSUE_REPORT_ENDPOINTS.list, ref, undefined, {
    state: "all",
    labels: MARKER_LABEL,
    per_page: "100",
  });
  const listed = await api.tryRequest("GET", listPath);
  if ("error" in listed) {
    return deliveryWarning(listed.error);
  }
  if (!Array.isArray(listed.data)) {
    return malformedWarning();
  }
  let found = reportIssueIn(listed.data);
  if (!found) {
    const scanned = await fallbackScan(api, ref);
    if ("warning" in scanned) {
      return scanned;
    }
    found = scanned.found;
  }
  const state = needsAttention ? "open" : "closed";
  if (found) {
    const updated = await api.tryRequest(
      "PATCH",
      expand(ISSUE_REPORT_ENDPOINTS.update, ref, { issue_number: String(found.number) }),
      { body, state },
    );
    if ("error" in updated) {
      return deliveryWarning(updated.error);
    }
    return { url: found.url };
  }
  const created = await api.tryRequest("POST", expand(ISSUE_REPORT_ENDPOINTS.create, ref), {
    title: ISSUE_TITLE,
    body,
    labels: [MARKER_LABEL],
  });
  if ("error" in created) {
    return deliveryWarning(created.error);
  }
  const issue = created.data as { number?: unknown; html_url?: unknown } | null;
  const url = typeof issue?.html_url === "string" ? issue.html_url : "";
  if (state === "closed") {
    // Creation cannot set the state, so a healthy first run closes right after.
    if (typeof issue?.number !== "number") {
      return malformedWarning();
    }
    const closed = await api.tryRequest(
      "PATCH",
      expand(ISSUE_REPORT_ENDPOINTS.update, ref, { issue_number: String(issue.number) }),
      { state },
    );
    if ("error" in closed) {
      return deliveryWarning(closed.error);
    }
  }
  return { url };
}

/**
 * Upsert the report issue on the target repo: ensure the marker label, find
 * the issue by label (one request) or by the early-exit creator scan, then
 * PATCH the body and state - or POST it with the marker label attached.
 * `needsAttention` opens the issue (failed / check-mode drift, exactly the
 * results that fail the run) and anything else closes it. Never throws:
 * report delivery is auxiliary, so every failure comes back as a safe
 * warning and the run's result stays untouched.
 */
export async function deliverIssueReport(
  api: GithubClient,
  slug: string,
  body: string,
  needsAttention: boolean,
): Promise<IssueDelivery> {
  try {
    return await deliver(api, slug, body, needsAttention);
  } catch {
    // A throw is a network-level failure whose message embeds the request
    // path (the private slug), so nothing from it may escape.
    return {
      warning:
        "could not deliver the private report: the request failed before an HTTP response arrived. Re-run the workflow, or set private-report: none if it persists",
    };
  }
}

/**
 * Marker-label injection, closing the deletesUndeclared hole: when the
 * merged settings declare a `labels` section, an apply would DELETE the
 * undeclared marker label right after report delivery created it. Appending
 * the marker to the declared set (when no entry already manages it) lets the
 * labels section manage it like any other label.
 *
 * A declared entry whose name OR new_name resolves to the marker already
 * manages it, so no injection is needed. But an entry that RENAMES the marker
 * AWAY (name is the marker, new_name is something else) would break the
 * next run's marker lookup, so its rename is refused: the new_name is stripped
 * and `renameRefused` is set. Pure: the input settings object is never mutated.
 */
export function injectMarkerLabel(settings: SettingsFile): {
  settings: SettingsFile;
  injected: boolean;
  renameRefused: boolean;
} {
  const labels = settings.labels;
  if (!Array.isArray(labels)) {
    return { settings, injected: false, renameRefused: false };
  }
  const marker = nameKey(MARKER_LABEL);
  // An entry that renames the marker to a different name: keep the entry but
  // drop the rename so the marker label keeps its name.
  const renamesMarkerAway = (label: LabelConfig): boolean =>
    nameKey(label.name) === marker &&
    label.new_name !== undefined &&
    nameKey(label.new_name) !== marker;
  if (labels.some(renamesMarkerAway)) {
    const guarded = labels.map((label) =>
      renamesMarkerAway(label) ? { ...label, new_name: undefined } : label,
    );
    return { settings: { ...settings, labels: guarded }, injected: false, renameRefused: true };
  }
  const declared = labels.some(
    (label) => nameKey(label.name) === marker || nameKey(label.new_name ?? label.name) === marker,
  );
  if (declared) {
    return { settings, injected: false, renameRefused: false };
  }
  return {
    settings: { ...settings, labels: [...labels, MARKER_LABEL_CONFIG] },
    injected: true,
    renameRefused: false,
  };
}
