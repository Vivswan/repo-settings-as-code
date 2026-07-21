/**
 * The multi-repo target model shared by central resolution, repos-input
 * parsing, and discovery. Central files WIN over repos-input entries for
 * the same repository: the checked-in file is a curated, code-reviewed
 * artifact; the remote file is self-service.
 */

export interface Target {
  slug: string; // owner/name, original casing
  source: "central" | "remote";
  /** Where this target came from, for messages: a file path or the input name. */
  origin: string;
  /** Central targets only: the settings file to read. */
  filePath?: string;
}

export const SLUG_RE = /^[\w.-]+\/[\w.-]+$/;

/**
 * Merge central and remote target lists. A central file wins over a
 * repos-input entry for the same repository (noticed, not an error).
 */
export function dedupeTargets(
  central: Target[],
  remote: Target[],
  notice: (message: string) => void,
): Target[] {
  const centralBySlug = new Map<string, Target>();
  for (const target of central) {
    const key = target.slug.toLowerCase();
    if (!centralBySlug.has(key)) {
      centralBySlug.set(key, target);
    }
  }
  const out = [...central];
  for (const target of remote) {
    const winner = centralBySlug.get(target.slug.toLowerCase());
    if (winner) {
      notice(
        `${target.slug}: using the central file ${winner.origin}; the ${target.origin} entry for the same repository is ignored`,
      );
      continue;
    }
    out.push(target);
  }
  return out;
}
