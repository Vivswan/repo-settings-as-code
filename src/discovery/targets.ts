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
 * The notice renders the repository slug through `display` so a redacted
 * target's placeholder is what lands in the log. Origins are operator-authored
 * paths and input names; the remote origin already reads as a generic noun
 * phrase (`the "repos" input`, `repos: "*" discovery`), but a CENTRAL origin is
 * a repos-dir FILE PATH that can embed the real repository name - so for a
 * redacted target it is rendered generically ("a repos-dir file") to avoid
 * leaking the name right next to its placeholder.
 */
export function dedupeTargets(
  central: Target[],
  remote: Target[],
  notice: (message: string) => void,
  display: (slug: string) => string,
  isRedacted: (slug: string) => boolean = () => false,
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
      const centralOrigin = isRedacted(target.slug) ? "a repos-dir file" : winner.origin;
      notice(
        `${display(target.slug)}: using the central file ${centralOrigin}; the entry for the same repository from ${target.origin} is ignored`,
      );
      continue;
    }
    out.push(target);
  }
  return out;
}
