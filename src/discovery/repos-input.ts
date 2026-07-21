/** Parsing for the "repos" input: explicit slugs or "*" discovery. */

import { SLUG_RE } from "./targets.js";

/** Parse the repos input: comma/newline-separated slugs, or exactly "*". */
export function parseReposInput(
  raw: string,
): { slugs: string[]; discover: boolean } | { error: string } {
  const items = raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.includes("*")) {
    if (items.length > 1) {
      return {
        error: `the "repos" input mixes "*" with explicit repositories. Use "*" alone to discover every repository the token owns, or list the repositories without it`,
      };
    }
    return { slugs: [], discover: true };
  }
  const seen = new Map<string, string>();
  for (const item of items) {
    if (!SLUG_RE.test(item)) {
      return {
        error: `the "repos" input entry "${item}" is not an owner/name slug. Fix it to a value like "octocat/hello-world" (comma- or newline-separated), or use "*" alone to discover repositories`,
      };
    }
    const key = item.toLowerCase();
    if (seen.has(key)) {
      return {
        error: `the "repos" input lists ${item} more than once. Keep exactly one entry per repository`,
      };
    }
    seen.set(key, item);
  }
  return { slugs: items, discover: false };
}
