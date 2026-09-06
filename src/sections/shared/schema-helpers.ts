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

const UndeclaredPolicySchema = z.enum(["keep", "delete"]).meta({ id: "UndeclaredPolicy" });

/**
 * The knobbed form of a list section's value: the plain entry array, or the
 * strict {undeclared, entries} wrapper (published under the definition name
 * "UndeclaredPolicyList<Entry>", matching the UndeclaredPolicyList type).
 * loosen() recognizes this union and rewraps it with the routed check that
 * keeps precise per-entry issue paths. The wrapper's definition name derives
 * from the entry schema's own .meta({id}), so the document composition and a
 * section's runtime derivation can never label the same entry differently -
 * an entry without an id (or a clone that shed it) throws at MODULE LOAD,
 * not typecheck. Each call mints a fresh wrapper registered
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
      undeclared: UndeclaredPolicySchema.optional(),
      entries: z.array(entry),
    })
    .meta({ id: `UndeclaredPolicyList<${entryName}>` });
  return z.union([z.array(entry), wrapper]);
}

/** A repository-scope sealed secret entry (name + `$NAME` reference value). */
export function sealedSecretConfig(id: string) {
  return z
    .object({
      name: z.string(),
      value: z.string(),
    })
    .meta({ id });
}
