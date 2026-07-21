/**
 * "*" discovery: enumerate the repositories the token's user can see and
 * apply the discovery filters. Filters apply to discovery only, never to
 * explicit targets.
 */

import type { components } from "@octokit/openapi-types";
import type { GithubClient } from "../github/api.js";
import { paginate } from "../github/paginate.js";

type DiscoveredRepo = Pick<
  components["schemas"]["repository"],
  "full_name" | "archived" | "fork" | "topics" | "visibility"
>;

/** Allowed values per discovery-filter input; the single source the input validation and types derive from. */
export const VISIBILITY_FILTERS = ["all", "public", "private", "internal"] as const;
export const ARCHIVED_FILTERS = ["skip", "include", "only"] as const;
export const FORKS_FILTERS = ["include", "exclude", "only"] as const;
export const AFFILIATIONS = ["owner", "collaborator", "organization_member"] as const;

/** Filters applied to repos: "*" discovery only, never to explicit targets. */
export interface DiscoveryFilters {
  visibility: (typeof VISIBILITY_FILTERS)[number];
  archived: (typeof ARCHIVED_FILTERS)[number];
  forks: (typeof FORKS_FILTERS)[number];
  affiliation: string[];
  topics: string[];
  exclude: string[];
}

export const DEFAULT_DISCOVERY_FILTERS: DiscoveryFilters = {
  visibility: "all",
  archived: "skip",
  forks: "include",
  affiliation: ["owner"],
  topics: [],
  exclude: [],
};

/** Compile a "*"-only wildcard into an anchored, case-insensitive RegExp. */
function compileExcludePattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

/**
 * True when the pattern excludes this owner/name slug. A pattern containing
 * "/" matches the full slug; otherwise it matches the name alone (same
 * split as the repos-dir <name>.yml vs <owner>/<name>.yml layout).
 */
export function excludeMatches(pattern: string, slug: string): boolean {
  const candidate = pattern.includes("/") ? slug : (slug.split("/")[1] ?? slug);
  return compileExcludePattern(pattern).test(candidate);
}

export interface DiscoveryResult {
  slugs: string[];
  /** Repositories dropped by a filter, grouped by the first reason that hit. */
  filtered: Array<{ reason: string; slugs: string[] }>;
}

/** Discover the repositories the token's user can see, applying the filters. */
export async function discoverRepos(
  api: GithubClient,
  filters: DiscoveryFilters,
): Promise<DiscoveryResult | { error: string }> {
  const params = [`affiliation=${filters.affiliation.join(",")}`];
  if (filters.visibility === "public" || filters.visibility === "private") {
    // The API's visibility param has no "internal" value; that case (and the
    // internal-vs-private distinction on GHEC) is settled client-side below.
    params.push(`visibility=${filters.visibility}`);
  }
  const path = `/user/repos?${params.join("&")}`;
  const wrap = (message: string, advice: string): { error: string } => ({
    error: `cannot discover repositories for repos: "*": ${message}. ${advice}`,
  });
  const RERUN_ADVICE =
    "This is not a permission problem; re-run the workflow, and retry later if it persists";
  let page: Awaited<ReturnType<typeof paginate>>;
  try {
    page = await paginate(api, path);
  } catch (error) {
    // Network-level failure: tryRequest throws once the retries are spent.
    return wrap(error instanceof Error ? error.message : String(error), RERUN_ADVICE);
  }
  if ("error" in page) {
    const cause = `GET ${path} failed: ${page.error.status} ${page.error.message}`;
    // The PAT advice fits denials only; transient failures need re-run
    // advice instead, or an operator abandons "*" discovery for nothing.
    if ([401, 403, 404].includes(page.error.status)) {
      return wrap(
        cause,
        `Discovery needs a user PAT; the workflow GITHUB_TOKEN and GitHub App installation tokens cannot enumerate a user's repositories. List the target repositories explicitly in the "repos" input`,
      );
    }
    return wrap(cause, RERUN_ADVICE);
  }
  if ("malformed" in page) {
    return wrap(
      `GET ${path} returned a JSON value that is not a list, so the response cannot be paginated`,
      RERUN_ADVICE,
    );
  }
  const repos = page.items as DiscoveredRepo[];
  // One rule per filter, in reporting-attribution order; the first reason
  // returned is the one a skipped repo is grouped under.
  const rules: Array<(repo: DiscoveredRepo) => string | null> = [
    (repo) => {
      const isInternal = repo.visibility === "internal";
      if (filters.visibility === "internal" && !isInternal) {
        return "visibility=internal";
      }
      if (filters.visibility === "private" && isInternal) {
        return "visibility=private";
      }
      return null;
    },
    (repo) => {
      if (filters.archived === "skip" && repo.archived) {
        return "archived";
      }
      if (filters.archived === "only" && !repo.archived) {
        return "archived=only";
      }
      return null;
    },
    (repo) => {
      if (filters.forks === "exclude" && repo.fork) {
        return "forks=exclude";
      }
      if (filters.forks === "only" && !repo.fork) {
        return "forks=only";
      }
      return null;
    },
    (repo) => {
      if (
        filters.topics.length > 0 &&
        !(repo.topics ?? []).some((topic) => filters.topics.includes(topic.toLowerCase()))
      ) {
        return `topics (has none of: ${filters.topics.join(", ")})`;
      }
      return null;
    },
    (repo) => {
      const hit = filters.exclude.find((pattern) => excludeMatches(pattern, repo.full_name));
      return hit ? `exclude pattern "${hit}"` : null;
    },
  ];
  const slugs: string[] = [];
  const filtered = new Map<string, string[]>();
  for (const repo of repos) {
    let reason: string | null = null;
    for (const rule of rules) {
      reason = rule(repo);
      if (reason) {
        break;
      }
    }
    if (!reason) {
      slugs.push(repo.full_name);
      continue;
    }
    const group = filtered.get(reason);
    if (group) {
      group.push(repo.full_name);
    } else {
      filtered.set(reason, [repo.full_name]);
    }
  }
  return {
    slugs,
    filtered: [...filtered.entries()].map(([reason, group]) => ({ reason, slugs: group })),
  };
}

/**
 * One aggregate notice per filter reason: with "*" fleets, per-repo notices
 * would flood the annotations UI (GitHub caps annotations per step).
 */
export function formatSkipNotice(group: { reason: string; slugs: string[] }): string {
  const shown = group.slugs.slice(0, 20).join(", ");
  const more = group.slugs.length > 20 ? `, and ${group.slugs.length - 20} more` : "";
  const count = `${group.slugs.length} ${group.slugs.length === 1 ? "repository" : "repositories"}`;
  if (group.reason === "archived") {
    return `repos: "*" discovery skipped ${count} because settings writes fail on archived repositories; unarchive them to manage them: ${shown}${more}`;
  }
  return `repos: "*" discovery skipped ${count} by ${group.reason}: ${shown}${more}`;
}
