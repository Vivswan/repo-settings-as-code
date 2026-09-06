/** The actions_secrets entry-config declaration (see index.ts for the section). */

import type { z } from "zod";
import { sealedSecretConfig } from "../shared/schema-helpers.js";

export const ActionsSecretConfig = sealedSecretConfig("ActionsSecretConfig");
export type ActionsSecretConfig = z.infer<typeof ActionsSecretConfig>;
