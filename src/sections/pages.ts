/**
 * `pages:` section - create/update the GitHub Pages site; `pages: null`
 * declares Pages OFF (mirroring branches' `protection: null`).
 */

import { z } from "zod";
import { subsetDiff } from "../engine/diff.js";
import type { PagesConfig } from "../schema.js";
import {
  call,
  emptyResult,
  probeAbsent,
  type SectionModule,
  type SectionResult,
} from "./contract.js";

export const pagesSection: SectionModule<"pages"> = {
  key: "pages",
  grant: `grant "Pages" (read and write) under the PAT's Repository permissions`,
  // The handler dereferences source.path before the API sees it, so the
  // shape must catch source: null or a source without a branch.
  shape: z.looseObject({ source: z.looseObject({ branch: z.string() }).optional() }).nullable(),
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const probe = await probeAbsent(ctx, this, `/repos/${ctx.repo}/pages`);
    const exists = !("missing" in probe);
    const liveSite = "data" in probe ? probe.data : undefined;

    // pages: null declares Pages OFF, mirroring branches' protection: null.
    if (desiredRaw === null) {
      if (!exists) {
        // A 404 here is ambiguous: no Pages site, or a fine-grained token
        // without the Pages permission (which also answers 404). The
        // non-null path stays loud either way (the POST would fail); this
        // no-op path must say so instead of silently succeeding.
        result.notes.push(
          "pages: declared null and GitHub reports no Pages site, so there is nothing to disable. A fine-grained token missing the Pages permission gets the same answer; if this repo does have a Pages site, grant the token Pages read and write",
        );
        return result;
      }
      if (ctx.check) {
        result.drift.push(
          "pages: enabled live but the settings file declares pages: null; apply will disable GitHub Pages",
        );
        return result;
      }
      await call(ctx, this, "DELETE", `/repos/${ctx.repo}/pages`);
      result.changes.push("disabled GitHub Pages");
      return result;
    }
    const desired = desiredRaw as PagesConfig;
    if (Object.keys(desired).length === 0) {
      result.notes.push(
        "pages: declared as an empty mapping, which configures nothing (the update endpoint rejects an empty body). Declare at least one field, use pages: null to disable the site, or remove the section",
      );
      return result;
    }
    // The update PUT requires path alongside branch when source is sent;
    // the create POST defaults it, so default it everywhere.
    const payload: Record<string, unknown> = { ...desired };
    if (desired.source !== undefined && desired.source.path === undefined) {
      payload.source = { ...desired.source, path: "/" };
    }

    if (ctx.check) {
      if (!exists) {
        result.drift.push(
          "pages: declared in the settings file but GitHub Pages is not enabled on the repo; apply will enable it",
        );
      } else {
        result.drift.push(...subsetDiff(payload, liveSite, "pages"));
      }
      return result;
    }

    if (!exists) {
      // The create endpoint accepts only build_type/source; cname and the
      // rest are update-only, so create first, then PUT the remainder.
      const create: Record<string, unknown> = {};
      if (payload.build_type !== undefined) {
        create.build_type = payload.build_type;
      }
      if (payload.source !== undefined) {
        create.source = payload.source;
      }
      await call(ctx, this, "POST", `/repos/${ctx.repo}/pages`, create);
      result.changes.push("enabled GitHub Pages");
      const rest = Object.keys(payload).filter((k) => !(k in create));
      if (rest.length > 0) {
        await call(ctx, this, "PUT", `/repos/${ctx.repo}/pages`, payload);
        result.changes.push("applied remaining Pages configuration");
      }
    } else {
      await call(ctx, this, "PUT", `/repos/${ctx.repo}/pages`, payload);
      result.changes.push("updated GitHub Pages configuration");
    }
    return result;
  },
};
