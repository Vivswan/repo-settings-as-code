/**
 * Trim the published GitHub OpenAPI description down to exactly the paths the
 * action can reach, and write it to disk. The e2e validator (test/e2e/openapi/
 * validate.ts) loads the trimmed spec from disk - never the network - so runs
 * stay hermetic and fast; this script is the ONLY thing that touches the
 * network. The output is a FETCHED, gitignored artifact (a ~2MB generated blob
 * kept out of history): local devs run this once, and CI restores it from
 * actions/cache or re-fetches on a miss.
 *
 * Run: `bun .github/scripts/trim-openapi.ts` (writes the trimmed JSON in place).
 * Re-run whenever USED_PATHS changes (a new section endpoint) or to adopt a
 * newer upstream ref.
 *
 * The upstream ref is PINNED to a commit SHA, not a moving branch, so two runs
 * months apart produce byte-identical output from the same USED_PATHS.
 */

import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_API_VERSION } from "../../src/github/api.js";
import { USED_PATHS } from "../../test/e2e/openapi/paths.js";

/**
 * The github/rest-api-description commit the trimmed spec is cut from. Bump
 * this (and re-run) to adopt upstream changes; pinning to a SHA keeps the
 * output reproducible.
 */
const UPSTREAM_REF = "417c4fb368fc6a7162ce5f3eeeddce1a9a217747";

/**
 * The dereferenced (no $ref) descriptor for our pinned API version. Dereferenced
 * so the trimmed slice is self-contained: keeping a path drags its inlined
 * schemas along, with no components/schemas graph to also carry.
 */
const SPEC_URL =
  `https://raw.githubusercontent.com/github/rest-api-description/${UPSTREAM_REF}` +
  `/descriptions/api.github.com/dereferenced/api.github.com.${DEFAULT_API_VERSION}.deref.json`;

const OUT_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "test",
  "e2e",
  "openapi",
  "github-openapi.trimmed.json",
);

/** The minimal OpenAPI shape we read: a paths map plus top-level metadata. */
interface OpenApiDoc {
  openapi: string;
  info: unknown;
  paths: Record<string, unknown>;
  [key: string]: unknown;
}

/** Abandon the fetch if the (large) descriptor has not arrived in this long. */
const FETCH_TIMEOUT_MS = 60_000;

async function fetchSpec(url: string): Promise<OpenApiDoc> {
  // A timeout so a hung connection fails loudly with advice instead of the
  // script appearing to stall forever on the multi-MB descriptor.
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }).catch(
    (error) => {
      const reason =
        error instanceof Error && error.name === "TimeoutError" ? "timed out" : "failed";
      throw new Error(
        `fetching the OpenAPI descriptor ${reason} after ${FETCH_TIMEOUT_MS}ms for ${url}: ${error instanceof Error ? error.message : String(error)}. Check network access to raw.githubusercontent.com and re-run`,
      );
    },
  );
  if (!response.ok) {
    throw new Error(
      `failed to fetch the OpenAPI descriptor: ${response.status} ${response.statusText} for ${url}. Check UPSTREAM_REF and the DEFAULT_API_VERSION file name`,
    );
  }
  const doc = (await response.json()) as OpenApiDoc;
  if (!doc.paths || typeof doc.paths !== "object") {
    throw new Error(
      `the fetched descriptor has no "paths" object; got keys: ${Object.keys(doc).join(", ")}`,
    );
  }
  return doc;
}

/**
 * Assert the trimmed slice carries no $ref. The dereferenced descriptor should
 * be fully inlined, but a partial deref upstream (or a wrong file name) could
 * leave dangling $refs the disk-only validator cannot resolve - which would
 * make ajv either throw at compile time or silently skip a subschema. Catching
 * it here, at generation, keeps the trimmed spec self-contained by contract.
 */
function assertRefFree(trimmed: OpenApiDoc): void {
  const serialized = JSON.stringify(trimmed);
  if (serialized.includes('"$ref"')) {
    // Surface a couple of offending paths to make the upstream problem concrete.
    const matches = [...serialized.matchAll(/"\$ref":\s*"([^"]+)"/g)].slice(0, 5);
    const sample = matches.map((m) => m[1]).join(", ");
    throw new Error(
      `the trimmed slice still contains $ref pointers (e.g. ${sample}); the descriptor was not fully dereferenced. Confirm SPEC_URL points at the .deref.json file, not the source spec`,
    );
  }
}

/**
 * Keep only the USED_PATHS entries. USED_PATHS spells templates the same way
 * OpenAPI keys them ("/repos/{owner}/{repo}/labels"), so the match is exact
 * string equality - no normalization guessing. A USED_PATHS entry absent from
 * the upstream spec is a hard error: it means the action calls a path GitHub
 * does not document at this version, which the validator could never check.
 */
function trimPaths(doc: OpenApiDoc): { trimmed: OpenApiDoc; kept: string[]; missing: string[] } {
  const kept: string[] = [];
  const missing: string[] = [];
  const paths: Record<string, unknown> = {};
  for (const path of USED_PATHS) {
    const entry = doc.paths[path];
    if (entry === undefined) {
      missing.push(path);
      continue;
    }
    paths[path] = entry;
    kept.push(path);
  }
  const trimmed: OpenApiDoc = {
    openapi: doc.openapi,
    info: doc.info,
    ...(doc.servers ? { servers: doc.servers } : {}),
    paths,
  };
  return { trimmed, kept, missing };
}

async function main(): Promise<number> {
  console.log(`fetching ${SPEC_URL}`);
  const doc = await fetchSpec(SPEC_URL);
  const { trimmed, kept, missing } = trimPaths(doc);
  if (missing.length > 0) {
    throw new Error(
      `these USED_PATHS are not in the upstream descriptor at ${UPSTREAM_REF} for ${DEFAULT_API_VERSION}:\n  ${missing.join("\n  ")}\nEither the path is wrong in test/e2e/openapi/paths.ts, or UPSTREAM_REF/api-version needs updating`,
    );
  }
  // The dereferenced slice must be fully inlined; a stray $ref means the
  // trimmed slice would not be self-contained for the disk-only validator.
  assertRefFree(trimmed);
  // Stable key order and a trailing newline so re-runs are byte-identical and
  // the file plays nicely with the repo's formatting.
  const json = `${JSON.stringify(trimmed, null, 2)}\n`;
  // Atomic write: serialize to a temp file, then rename over the target. A
  // crash or an aborted run then leaves the previously written spec intact
  // rather than a half-written file the validator would fail to parse.
  const tmpPath = `${OUT_PATH}.tmp`;
  writeFileSync(tmpPath, json);
  renameSync(tmpPath, OUT_PATH);
  const sizeKb = Math.round(Buffer.byteLength(json) / 1024);
  console.log(`wrote ${OUT_PATH} (${kept.length} paths, ${sizeKb} KB)`);
  return 0;
}

try {
  process.exit(await main());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
