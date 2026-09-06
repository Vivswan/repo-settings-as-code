/**
 * Leaf schema helpers shared by the root src/schema.ts and the per-section
 * schema modules under src/sections/<key>/schema.ts. This module imports
 * ONLY zod: a section schema importing root schema.ts back would be a cycle
 * whose top-level const evaluation TDZ-crashes at import time, so everything
 * both sides need lives here. The smoke selector
 * (.github/scripts/changed-sections.ts) derives this file's section fan-out
 * from the import graph.
 */

import { z } from "zod";

const UndeclaredPolicySchema = z
  .enum(["keep", "delete"])
  .describe("What apply does to live resources the settings file does not declare.")
  .meta({ id: "UndeclaredPolicy" });

const WRAPPER_DOC =
  "The wrapped form of a list, overriding what happens to live resources the file does not " +
  "declare. The plain array form keeps the list's own default policy (for a top-level section " +
  "that is the section default, and a multi-repo defaults file can set it; a nested list such " +
  "as environments[].variables has its own fixed default and never inherits one); this wrapper " +
  "can set it explicitly, and with `undeclared` omitted it behaves exactly like the plain " +
  "array. The wrapper is this action's own vocabulary (nothing here passes through to GitHub), " +
  "so its keys are strict: anything besides `undeclared` and `entries` is rejected upfront as " +
  "a typo.";

/**
 * The knobbed form of a list section's value: the plain entry array, or the
 * strict {undeclared, entries} wrapper (published under the definition name
 * "UndeclaredPolicyList<Entry>", matching the UndeclaredPolicyList type).
 * loosen() recognizes this union and rewraps it with the routed check that
 * keeps precise per-entry issue paths. The wrapper's definition name derives
 * from the entry schema's own .meta({id}), so the document composition and a
 * section's runtime derivation can never label the same entry differently -
 * an entry without an id (or a .describe() clone, which sheds it) throws at
 * MODULE LOAD, not typecheck. Each call mints a fresh wrapper registered
 * under the same id; that is fine for z.toJSONSchema(SettingsFile) (it
 * resolves metadata by schema identity), but a generator iterating
 * z.globalRegistry's id map would see only the last-registered wrapper -
 * keep the published schema on the single-schema path.
 */
export function knobbed<T extends z.ZodType>(entry: T) {
  const entryName = z.globalRegistry.get(entry)?.id;
  if (entryName === undefined) {
    throw new Error(
      "knobbed(): the entry schema carries no .meta({id}) name to derive the wrapper's definition name from; give the entry config a .meta({id})",
    );
  }
  const wrapper = z
    .strictObject({
      undeclared: UndeclaredPolicySchema.describe(
        'What apply does to live resources `entries` does not declare: "delete" removes them, "keep" leaves them alone and surfaces each as a note. Omitted, the list\'s own default applies.',
      ).optional(),
      entries: z
        .array(entry)
        .describe("The declared entries, exactly as the plain array form lists them."),
    })
    .describe(WRAPPER_DOC)
    .meta({ id: `UndeclaredPolicyList<${entryName}>` });
  return z.union([z.array(entry), wrapper]);
}

export const SEALED_SECRET_VALUE_DOC =
  "A whole-value `$NAME` reference to an environment variable holding the secret - never a " +
  "literal (settings files are committed plaintext). Resolved from the action step's env at " +
  "run time and sealed with a libsodium sealed box before upload; GitHub cannot return the " +
  "value, so check mode verifies existence only and apply re-seals it on every run.";

export const SECRET_NAME_DOC =
  "The secret name, the natural key; compared case-insensitively and written uppercase.";

/** A repository-scope sealed secret entry (name + `$NAME` reference value). */
export function sealedSecretConfig(id: string, description: string) {
  return z
    .object({
      name: z.string().describe(SECRET_NAME_DOC),
      value: z.string().describe(SEALED_SECRET_VALUE_DOC),
    })
    .describe(description)
    .meta({ id });
}
