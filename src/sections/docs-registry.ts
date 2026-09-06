/**
 * The single loading point for authored documentation, mirroring registry.ts: every SectionKey's
 * <key>.docs.yml is read and validated here, so a section without one fails the docs build, and
 * the schema descriptions of every docs file (each section's, the shared factories', the document
 * root's) are collected for the schema generator. Documentation only: nothing bundled from
 * src/main.ts may import this file (a unit test walks the import graph).
 */

import { join, relative } from "node:path";
import { SECTION_KEYS, type SectionKey } from "../schema.js";
import { readDocsYaml, SchemaOnlyDocs, SectionDocs } from "./contract/docs.js";

const SECTIONS_DIR = import.meta.dir;
const ROOT = join(SECTIONS_DIR, "..", "..");

/** The docs files that carry schema descriptions but belong to no section. */
const SCHEMA_ONLY_DOCS = [
  join(SECTIONS_DIR, "shared", "shared.docs.yml"),
  join(SECTIONS_DIR, "..", "schema.docs.yml"),
];

/** Every section's <key>.docs.yml, validated; a missing or malformed one throws naming it. */
function loadSectionDocs(): Readonly<Record<SectionKey, SectionDocs>> {
  const entries = SECTION_KEYS.map(
    (key) => [key, readDocsYaml(join(SECTIONS_DIR, key, `${key}.docs.yml`), SectionDocs)] as const,
  );
  return Object.fromEntries(entries) as Record<SectionKey, SectionDocs>;
}

export const DOCS = loadSectionDocs();

/** One authored schema description and the docs file (repo-relative) it came from. */
export interface SchemaDescriptionEntry {
  readonly key: string;
  readonly text: string;
  readonly source: string;
}

/** Every schema description across the docs files, in file order, for the schema generator. */
function collectSchemaDescriptions(): readonly SchemaDescriptionEntry[] {
  const entries: SchemaDescriptionEntry[] = [];
  const collect = (path: string, descriptions: Readonly<Record<string, string>>): void => {
    const source = relative(ROOT, path);
    for (const [key, text] of Object.entries(descriptions)) {
      entries.push({ key, text, source });
    }
  };
  for (const key of SECTION_KEYS) {
    collect(join(SECTIONS_DIR, key, `${key}.docs.yml`), DOCS[key].schema);
  }
  for (const path of SCHEMA_ONLY_DOCS) {
    collect(path, readDocsYaml(path, SchemaOnlyDocs).schema);
  }
  return entries;
}

export const SCHEMA_DESCRIPTIONS = collectSchemaDescriptions();
