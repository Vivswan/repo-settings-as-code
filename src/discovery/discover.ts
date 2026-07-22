/**
 * "*" discovery: enumerate the repositories the token's user can see and
 * apply the discovery filters. Filters apply to discovery only, never to
 * explicit targets.
 */

import type { components } from "@octokit/openapi-types";
import { type GithubClient, isPermissionError, RERUN_ADVICE } from "../github/api.js";
import { paginate } from "../github/paginate.js";

type DiscoveredRepo = Pick<
  components["schemas"]["repository"],
  "full_name" | "archived" | "fork" | "topics" | "visibility" | "private"
>;

/** One discovered repository: its slug plus the visibility the listing reported. */
export interface DiscoveredRepoRef {
  slug: string;
  visibility: "public" | "private" | "internal";
}

/**
 * Narrow the listing's visibility for the REDACTION decision, failing closed.
 * `visibility` is a plain string in the API schema and optional on GHES; the
 * always-present `private` flag is the authority. A repo is treated as private
 * whenever `private === true` (even if a stale/forged `visibility` says
 * "public"), and when BOTH fields are missing (an unknown repo is hidden, never
 * exposed). Only `private === false` (or a trustworthy non-public visibility)
 * yields a non-private classification. `internal` survives when `visibility`
 * names it and `private` does not contradict it.
 */
function normalizeVisibility(repo: DiscoveredRepo): DiscoveredRepoRef["visibility"] {
  // private === true always wins: it is the field the API guarantees, and a
  // repo the token can see as private must never be classed public.
  if (repo.private === true) {
    return "internal" === repo.visibility ? "internal" : "private";
  }
  const visibility = repo.visibility;
  if (visibility === "public" || visibility === "private" || visibility === "internal") {
    return visibility;
  }
  // visibility absent: trust an explicit private === false, else fail closed.
  return repo.private === false ? "public" : "private";
}

/** Allowed values per discovery-filter input; the single source the input validation and types derive from. */
export const VISIBILITY_FILTERS = ["all", "public", "private", "internal"] as const;
export const ARCHIVED_FILTERS = ["skip", "include", "only"] as const;
export const FORKS_FILTERS = ["include", "exclude", "only"] as const;
export const AFFILIATIONS = ["owner", "collaborator", "organization_member"] as const;

/**
 * The filter reason tag for a repo skipped because it is archived. Shared by
 * the discovery rule that emits it and formatSkipNotice, which special-cases
 * it for the unarchive-to-manage prose - a literal in one place and not the
 * other would silently drop that guidance.
 */
export const ARCHIVED_REASON = "archived";

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
  repos: DiscoveredRepoRef[];
  /** Repositories dropped by a filter, grouped by the first reason that hit. */
  filtered: Array<{ reason: string; repos: DiscoveredRepoRef[] }>;
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
  let page: Awaited<ReturnType<typeof paginate>>;
  try {
    page = await paginate(api, path);
  } catch (error) {
    // Network-level failure: tryRequest throws once the retries are spent.
    return wrap(error instanceof Error ? error.message : String(error), RERUN_ADVICE);
  }
  if ("error" in page) {
    const cause = `GET ${path} failed: ${page.error.status} ${page.error.message}`;
    // The PAT advice fits genuine denials only. A rate-limit 403 is NOT a
    // permission problem (isPermissionError excludes it), so it must fall
    // through to RERUN_ADVICE instead of telling the operator to swap tokens
    // and abandon "*" discovery for nothing. 401 is an invalid/expired token,
    // which the same PAT advice covers.
    if (isPermissionError(page.error) || page.error.status === 401) {
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
        return ARCHIVED_REASON;
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
  const kept: DiscoveredRepoRef[] = [];
  const filtered = new Map<string, DiscoveredRepoRef[]>();
  for (const repo of repos) {
    let reason: string | null = null;
    for (const rule of rules) {
      reason = rule(repo);
      if (reason) {
        break;
      }
    }
    const ref: DiscoveredRepoRef = {
      slug: repo.full_name,
      visibility: normalizeVisibility(repo),
    };
    if (!reason) {
      kept.push(ref);
      continue;
    }
    const group = filtered.get(reason);
    if (group) {
      group.push(ref);
    } else {
      filtered.set(reason, [ref]);
    }
  }
  return {
    repos: kept,
    filtered: [...filtered.entries()].map(([reason, group]) => ({ reason, repos: group })),
  };
}

/**
 * One aggregate notice per filter reason: with "*" fleets, per-repo notices
 * would flood the annotations UI (GitHub caps annotations per step).
 * `redactPrivate` keeps private and internal repository names out of the
 * notice: only public slugs are listed, hidden ones become a count, and a
 * group with no public repos renders as a count with no names at all.
 */
export function formatSkipNotice(
  group: { reason: string; repos: DiscoveredRepoRef[] },
  redactPrivate: boolean,
): string {
  const named = redactPrivate
    ? group.repos.filter((repo) => repo.visibility === "public")
    : group.repos;
  const hidden = group.repos.length - named.length;
  const hiddenCount = `${hidden} private or internal ${hidden === 1 ? "repository" : "repositories"}`;
  const shown = named
    .slice(0, 20)
    .map((repo) => repo.slug)
    .join(", ");
  const more = named.length > 20 ? `, and ${named.length - 20} more` : "";
  const hiddenTail = hidden > 0 ? `, and ${hiddenCount}` : "";
  const names = named.length > 0 ? `: ${shown}${more}${hiddenTail}` : "";
  const count =
    named.length === 0 && hidden > 0
      ? hiddenCount
      : `${group.repos.length} ${group.repos.length === 1 ? "repository" : "repositories"}`;
  if (group.reason === ARCHIVED_REASON) {
    return `repos: "*" discovery skipped ${count} because settings writes fail on archived repositories; unarchive them to manage them${names}`;
  }
  return `repos: "*" discovery skipped ${count} by ${group.reason}${names}`;
}
