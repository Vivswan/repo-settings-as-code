/**
 * The single loading point for section documentation, mirroring registry.ts: every SectionKey's
 * docs.yml is read and validated here, so a section without one fails the docs build.
 * Documentation only: nothing bundled from src/main.ts may import this file (a unit test walks
 * the import graph).
 */

import { join } from "node:path";
import { SECTION_KEYS, type SectionKey } from "../schema.js";
import { readDocsYaml, SectionDocs } from "./contract/docs.js";

/** Every section's docs.yml under `sectionsDir`, validated; a missing or malformed one throws naming it. */
function loadSectionDocs(sectionsDir: string): Readonly<Record<SectionKey, SectionDocs>> {
  const entries = SECTION_KEYS.map(
    (key) => [key, readDocsYaml(join(sectionsDir, key, "docs.yml"), SectionDocs)] as const,
  );
  return Object.fromEntries(entries) as Record<SectionKey, SectionDocs>;
}

export const DOCS = loadSectionDocs(import.meta.dir);
