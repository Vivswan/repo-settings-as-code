/** The codespaces_secrets entry-config declaration (see index.ts for the section). */

import type { z } from "zod";
import { sealedSecretConfig } from "../shared/schema-helpers.js";

export const CodespacesSecretConfig = sealedSecretConfig("CodespacesSecretConfig");
export type CodespacesSecretConfig = z.infer<typeof CodespacesSecretConfig>;
