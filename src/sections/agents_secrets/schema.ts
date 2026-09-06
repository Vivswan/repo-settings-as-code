/** The agents_secrets entry-config declaration (see index.ts for the section). */

import type { z } from "zod";
import { sealedSecretConfig } from "../shared/schema-helpers.js";

export const AgentsSecretConfig = sealedSecretConfig("AgentsSecretConfig");
export type AgentsSecretConfig = z.infer<typeof AgentsSecretConfig>;
