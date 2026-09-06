/**
 * The authored half of COVERAGE.md (rendered by gen-docs.ts): the prose no declaration can
 * derive, because it enumerates what does NOT exist - the repo-scoped gaps, the settings with no
 * public API, and the account-scoped surface. The data is coverage-data.yml beside this file;
 * this module is its shape and loader. The Supported table renders from each section's docs.yml.
 */

import { join } from "node:path";
import { z } from "zod";
import { SECTION_KEYS } from "../../src/schema.js";
import { readDocsYaml } from "../../src/sections/contract/docs.js";

/** One endpoint a gap would need: an octokit-spelled REST route ("METHOD /path/{param}") or a GraphQL root field ("GraphQL pinIssue"). */
const GapEndpoint = z
  .string()
  .regex(
    /^(?:(?:GET|POST|PUT|PATCH|DELETE) \/|GraphQL )/,
    'an endpoint is "METHOD /path/{param}" or "GraphQL rootField"',
  );

/** One row of the Repo-scoped gaps table: a repo-scoped setting the action cannot apply yet. */
const GapRow = z
  .strictObject({
    area: z.string().min(1),
    /** The endpoints that would implement it; the Endpoints cell joins them. */
    endpoints: z.tuple([GapEndpoint], GapEndpoint).readonly(),
    why: z.string().min(1),
  })
  .readonly();
export type GapRow = z.infer<typeof GapRow>;

// The Repo-scoped gaps table: either no known gap, with the paragraph shown in place of rows,
// or the rows. One arm at a time, so a note cannot go stale behind rows that hide it.
const CoverageGaps = z.union([
  z.strictObject({ emptyNote: z.string().min(1), rows: z.undefined().optional() }).readonly(),
  z
    .strictObject({
      emptyNote: z.undefined().optional(),
      rows: z.tuple([GapRow], GapRow).readonly(),
    })
    .readonly(),
]);

/** A non-empty list of authored bullets. */
const Items = z.tuple([z.string().min(1)], z.string().min(1)).readonly();

export const CoverageData = z
  .strictObject({
    /** The paragraph under the page title. */
    intro: z.string().min(1),
    /** The Supported table's section order, a display decision; the renderer requires every section once. */
    supportedOrder: z.array(z.enum(SECTION_KEYS)).readonly(),
    gaps: CoverageGaps,
    noPublicApi: z
      .strictObject({
        /** The paragraph introducing the list. */
        intro: z.string().min(1),
        items: Items,
      })
      .readonly(),
    outOfScope: z.strictObject({ items: Items }).readonly(),
  })
  .readonly();
export type CoverageData = z.infer<typeof CoverageData>;

export const COVERAGE_DATA = readDocsYaml(join(import.meta.dir, "coverage-data.yml"), CoverageData);
