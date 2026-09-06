/** The dependabot_secrets entry-config declaration (see index.ts for the section). */

import type { z } from "zod";
import { sealedSecretConfig } from "../shared/schema-helpers.js";

export const DependabotSecretConfig = sealedSecretConfig("DependabotSecretConfig");
export type DependabotSecretConfig = z.infer<typeof DependabotSecretConfig>;
