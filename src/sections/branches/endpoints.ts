/**
 * The section's REST endpoint declarations: the single dictionary that
 * drives the request paths, the mock routes, and USED_PATHS - the leaf both
 * index.ts and graphql-rules.ts derive their plan context type from.
 */

import type { EndpointDecl } from "../contract/endpoints.js";

export const ENDPOINTS = {
  // The primary read: a fine-grained 404 reads as "unprotected", so a denied
  // token surfaces on the first write, not here.
  getProtection: {
    route: "GET /repos/{owner}/{repo}/branches/{branch}/protection",
    statuses: { 200: "the branch protection", 404: "the branch is unprotected or does not exist" },
    primaryRead: { notFound: "absent" },
  },
  putProtection: {
    route: "PUT /repos/{owner}/{repo}/branches/{branch}/protection",
    statuses: { 200: "protection replaced" },
    hints: {
      422:
        'Usually a sub-object is missing a required half: "required_status_checks" needs both ' +
        '"strict" and "contexts", "required_pull_request_reviews" values must fit their ' +
        'documented shapes, and "restrictions" needs "users" and "teams" lists (or declare the ' +
        "whole key as null)",
    },
  },
  removeProtection: {
    route: "DELETE /repos/{owner}/{repo}/branches/{branch}/protection",
    statuses: { 204: "protection removed" },
  },
  // required_signatures lives on its own sub-resource (the protection PUT
  // silently drops the key), so the declared boolean is applied through
  // these two calls when it drifts, and again after any planned PUT.
  sigPost: {
    route: "POST /repos/{owner}/{repo}/branches/{branch}/protection/required_signatures",
    statuses: { 200: "signed commits now required" },
  },
  sigDelete: {
    route: "DELETE /repos/{owner}/{repo}/branches/{branch}/protection/required_signatures",
    statuses: { 204: "signed-commit requirement removed" },
  },
  // Advisory branch-existence probe, consulted when the protection read 404s
  // to tell a missing branch from an unprotected one. The read port tolerates
  // every failure on it (only a definitive 404 changes the finding). It is
  // Contents-gated in reality, but that requirement stays OUT of the
  // section's grant prose because the probe is optional (a token without
  // Contents just loses the branch-does-not-exist wording).
  branchProbe: {
    route: "GET /repos/{owner}/{repo}/branches/{branch}",
    statuses: { 200: "the branch exists", 404: "no such branch" },
    permission: { repo: ["contents"] },
    advisory: true,
  },
  // GitHub App bypass actors resolve by slug through this PUBLIC endpoint:
  // the GraphQL schema offers no app-by-slug lookup (marketplaceListing
  // covers only listed Apps). CAVEAT, documented rather than hidden: for
  // Apps created before GitHub's global-id migration the REST node_id may
  // still be the legacy format, which the mutation accepts with a
  // deprecation warning in the response extensions; user and team ids
  // resolve through GraphQL and are always new-format.
  appLookup: {
    route: "GET /apps/{app_slug}",
    statuses: { 200: "the GitHub App", 404: "no App with this slug" },
    permission: "none",
    phase: "execution",
  },
} as const satisfies Record<string, EndpointDecl>;
