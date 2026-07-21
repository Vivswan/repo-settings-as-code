/**
 * Fetch one file's raw content from a repository's default branch.
 * A contents 404 is ambiguous (missing file, missing Contents
 * permission, or a token that cannot see the repo at all), so it is
 * disambiguated here: the repo probe runs only on that rare path, and
 * `missing` always means the FILE. Every fine-grained PAT can read the
 * repo object (Metadata), so the probe's permissions block settles
 * whether the token could have read the contents.
 */

import type { ApiError, GithubClient } from "./api.js";

export async function getRepoFile(
  api: GithubClient,
  slug: string,
  filePath: string,
): Promise<{ content: string } | { missing: true } | { error: ApiError }> {
  const result = await api.tryRequest("GET", `/repos/${slug}/contents/${filePath}`, undefined, {
    accept: "application/vnd.github.raw+json",
    raw: true,
  });
  if ("error" in result) {
    if (result.error.status === 404) {
      const repoProbe = await api.tryRequest("GET", `/repos/${slug}`);
      if ("error" in repoProbe) {
        return { error: repoProbe.error };
      }
      const pull = (repoProbe.data as { permissions?: { pull?: boolean } } | null)?.permissions
        ?.pull;
      if (pull === true) {
        return { missing: true };
      }
      return {
        error: {
          status: 404,
          message: `the repository is visible but the token cannot read its contents, so ${filePath} cannot be fetched (grant Contents: read)`,
          body: "",
        },
      };
    }
    return { error: result.error };
  }
  return { content: String(result.data ?? "") };
}
