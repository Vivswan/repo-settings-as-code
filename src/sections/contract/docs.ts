/**
 * The prose a section contributes to the generated README and COVERAGE.md: the shape of the
 * docs.yml beside each section module (src/sections/<key>/docs.yml), and the loader primitive
 * every docs document goes through. Documentation only: nothing bundled from src/main.ts may
 * import this file or the docs registry (a unit test walks the import graph).
 */

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

/** One COVERAGE.md Supported row: the GitHub surface it covers and how the section handles it. */
const CoverageRow = z
  .strictObject({
    /** The Area cell: the GitHub feature, usually a docs link with the fields it spans. */
    area: z.string().min(1),
    /** Settings keys this row covers, rendered as "section (keys)"; omitted for a whole-section row. */
    keys: z.string().min(1).optional(),
    /** The Notes cell: endpoints, semantics, and caveats. */
    notes: z.string().min(1),
  })
  .readonly();

export const SectionDocs = z
  .strictObject({
    /** The section's two authored cells in the README Sections table. */
    readme: z
      .strictObject({
        /** The Endpoints cell: the API surface the section calls, in prose. */
        endpoints: z.string().min(1),
        /** The Notes cell: semantics, caveats, and the knob in passing. */
        notes: z.string().min(1),
      })
      .readonly(),
    // The section's rows in the COVERAGE.md Supported table, in display order. At least one: a
    // section with no coverage row does not exist to the inventory, so the shape (and the type it
    // infers, a non-empty tuple) refuses [].
    coverage: z.tuple([CoverageRow], CoverageRow).readonly(),
  })
  .readonly();
export type SectionDocs = z.infer<typeof SectionDocs>;

/**
 * The YAML document at `path`, validated against `schema`. A missing file throws the read error
 * (which names the path); unparseable YAML or a document off the shape throws naming the path
 * and the issues.
 */
export function readDocsYaml<T>(path: string, schema: z.ZodType<T>): T {
  let loaded: unknown;
  try {
    loaded = parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${path} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = schema.safeParse(loaded);
  if (!result.success) {
    throw new Error(`${path} is not a valid docs document:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
