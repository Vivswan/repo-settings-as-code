/** Shared SectionContext factory for the per-section handler tests. */

import type { SectionContext } from "../../src/sections/contract.js";
import type { MockApi } from "../mock-api.js";

export function ctx(api: MockApi, check = false): SectionContext {
  return { api, repo: "o/r", owner: "o", check };
}
