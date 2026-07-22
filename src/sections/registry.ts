/**
 * The single registration point for section modules. `byKey` is a mapped
 * type, so the compiler enforces that every SectionKey has a module AND
 * that each module sits under its own key; execution order comes from
 * SECTION_KEYS alone. Adding a section: create sections/<key>.ts exporting
 * a SectionModule, add the key to SECTION_KEYS in schema.ts, and add one
 * line here.
 */

import type { z } from "zod";
import { SECTION_KEYS, type SectionKey } from "../schema.js";
import { actionsSection } from "./actions.js";
import { autolinksSection } from "./autolinks.js";
import { branchesSection } from "./branches.js";
import { codeScanningDefaultSetupSection } from "./code-scanning.js";
import { collaboratorsSection } from "./collaborators.js";
import type { EndpointDecl, SectionModule } from "./contract.js";
import { environmentsSection } from "./environments.js";
import { labelsSection } from "./labels.js";
import { milestonesSection } from "./milestones.js";
import { pagesSection } from "./pages.js";
import { repositorySection } from "./repository.js";
import { rulesetsSection } from "./rulesets.js";
import { teamsSection } from "./teams.js";
import { workflowsSection } from "./workflows.js";

const byKey: { [K in SectionKey]: SectionModule<K> } = {
  repository: repositorySection,
  labels: labelsSection,
  rulesets: rulesetsSection,
  branches: branchesSection,
  environments: environmentsSection,
  autolinks: autolinksSection,
  actions: actionsSection,
  workflows: workflowsSection,
  pages: pagesSection,
  code_scanning_default_setup: codeScanningDefaultSetupSection,
  collaborators: collaboratorsSection,
  teams: teamsSection,
  milestones: milestonesSection,
};

/** Every section module, in execution order. */
export const SECTIONS: readonly SectionModule[] = SECTION_KEYS.map((key) => byKey[key]);

/** The loose shape validation accepts for a section's declared value. */
export function sectionShape(key: SectionKey): z.ZodType {
  return byKey[key].shape;
}

/** One endpoint in the flattened cross-section view, tagged with its owner. */
export type TaggedEndpoint = EndpointDecl & { section: SectionKey; role: string };

/**
 * Every section's endpoints flattened into one dictionary keyed
 * `${sectionKey}.${role}` ("labels.update", "teams.org", ...). Keys are
 * globally unique by construction (section key + local role). This is the
 * merge-ready single view downstream consumers (the e2e mock's route table,
 * USED_PATHS derivation) iterate, without renaming any section's local roles.
 *
 * The returned record, each tagged entry, and the nested statuses/permission
 * objects are frozen: they are (or reference) the section declarations, which
 * must never mutate at runtime, so a consumer cannot corrupt the source
 * dictionaries through this view.
 */
export function allEndpoints(): Readonly<Record<string, TaggedEndpoint>> {
  const out: Record<string, TaggedEndpoint> = {};
  for (const section of SECTIONS) {
    for (const [role, endpoint] of Object.entries(section.endpoints)) {
      Object.freeze(endpoint.statuses);
      if (endpoint.permission && typeof endpoint.permission === "object") {
        Object.freeze(endpoint.permission);
        Object.freeze(endpoint.permission.repo);
      }
      out[`${section.key}.${role}`] = Object.freeze({ ...endpoint, section: section.key, role });
    }
  }
  return Object.freeze(out);
}
