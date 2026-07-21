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
import type { SectionModule } from "./contract.js";
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
