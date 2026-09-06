/**
 * `deploy_keys:` section - deploy keys matched by exact title; the declared material is a PUBLIC key.
 * Immutable upstream (no update role), so a changed key or read_only flag is delete plus recreate; both
 * sides compare only algorithm + blob (GitHub may strip the trailing comment). Undeclared keys are KEPT.
 */

import { z } from "zod";
import type { EndpointDecl } from "../contract/endpoints.js";
import { listSection } from "../shared/list-section.js";
import { DeployKeyConfig } from "./schema.js";

/** The fields of a live deploy key this section reads; extras ride along. */
const LiveDeployKey = z.looseObject({
  id: z.number(),
  title: z.string(),
  key: z.string(),
  read_only: z.boolean().optional(),
});
type LiveDeployKey = z.infer<typeof LiveDeployKey>;

const ENDPOINTS = {
  list: {
    route: "GET /repos/{owner}/{repo}/keys",
    statuses: { 200: "the deploy key list" },
    primaryRead: { notFound: "denied" },
  },
  create: {
    route: "POST /repos/{owner}/{repo}/keys",
    statuses: { 201: "deploy key created" },
    hints: {
      422: "A public key can be attached to only ONE repository account-wide, so a 422 here can mean the key is already in use elsewhere; generate a distinct keypair per repository",
    },
  },
  remove: {
    route: "DELETE /repos/{owner}/{repo}/keys/{key_id}",
    statuses: { 204: "deploy key deleted" },
  },
} as const satisfies Record<string, EndpointDecl>;

/**
 * The comparable form of deploy key material: the algorithm and base64 blob (the first two
 * whitespace-separated fields), without the trailing comment GitHub may strip. Null when the value
 * has fewer than two fields; callers raise their own loud error instead of comparing garbage.
 */
export function normalizeKeyMaterial(key: string): string | null {
  const fields = key.trim().split(/\s+/);
  const algorithm = fields[0];
  const blob = fields[1];
  if (algorithm === undefined || blob === undefined) {
    return null;
  }
  return `${algorithm} ${blob}`;
}

/** The declared key's comparable material, or a loud settings-file error. */
function declaredMaterial(title: string, key: string): string {
  const normalized = normalizeKeyMaterial(key);
  if (normalized === null) {
    throw new Error(
      `deploy_keys[${title}]: the declared key must have at least two whitespace-separated fields (an algorithm and a base64 blob, e.g. "ssh-ed25519 AAAAC3..."), got ${JSON.stringify(key)}`,
    );
  }
  return normalized;
}

/** A live key's comparable material; sub-two-field material is a contract violation, never a silent skip. */
function liveMaterial(live: LiveDeployKey): string {
  const normalized = normalizeKeyMaterial(live.key);
  if (normalized === null) {
    throw new Error(
      `deploy_keys: GET /repos/{owner}/{repo}/keys returned key id ${live.id} ` +
        `("${live.title}") whose material has fewer than two whitespace-separated fields ` +
        `(${JSON.stringify(live.key)}); the response does not match the documented deploy key ` +
        `shape - check the "api-version" input against the GitHub REST docs for this endpoint`,
    );
  }
  return normalized;
}

export const deployKeysSection = listSection({
  key: "deploy_keys",
  permission: { repo: ["administration"] },
  undeclaredDefault: "keep",
  noun: "deploy key",
  entry: DeployKeyConfig,
  live: LiveDeployKey,
  endpoints: ENDPOINTS,
  // Exact titles: GitHub documents no case folding, so two titles differing in case are two keys.
  identity: { field: "title" },
  address: (live) => ({ key_id: String(live.id) }),
  lens: {
    // read_only is written and compared only when DECLARED: GitHub defaults it
    // to false on create, and an undeclared toggle is not managed by this file.
    toWrite: ({ title, key, read_only, ...passthrough }) => ({
      title,
      key: declaredMaterial(title, key),
      ...(read_only === undefined ? {} : { read_only }),
      ...passthrough,
    }),
    fromLive: (live) => ({
      ...live,
      key: liveMaterial(live),
      read_only: live.read_only ?? false,
    }),
    matchBy: {},
  },
  // The recreate seeds the LIVE read_only: without it a rotated read-only key would come back with
  // GitHub's read/write default, a privilege widening nothing in the file asked for. A declared value wins.
  recreate: (live, write) => ({ read_only: live.read_only ?? false, ...write }),
  // GitHub attaches a public key to one repository once, so a second key with the same material is
  // rejected at create time; both collisions are named upfront instead of failing mid-apply.
  conflicts: {
    declared: (writes) => {
      const titleByMaterial = new Map<string, string>();
      return writes.flatMap((write) => {
        const first = titleByMaterial.get(String(write.key));
        titleByMaterial.set(String(write.key), write.title);
        return first === undefined
          ? []
          : [
              `the entries "${first}" and "${write.title}" declare the same key material, and GitHub attaches a public key to one repository once, so the second create would be rejected - keep one entry per key`,
            ];
      });
    },
    // GitHub does not enforce title uniqueness either, and replacing one of N same-titled keys is a guess.
    live: (writes, live) =>
      writes.flatMap((write) => {
        const sameTitle = live.filter((key) => key.title === write.title);
        const holder = live.find((key) => key.title !== write.title && key.key === write.key);
        return [
          ...(sameTitle.length > 1
            ? [
                `the declared title "${write.title}" matches ${sameTitle.length} live deploy ` +
                  `keys (ids ${sameTitle.map((key) => String(key.id)).join(", ")}), and this ` +
                  `section manages at most one key per title - delete the duplicates on GitHub ` +
                  `so exactly one remains`,
              ]
            : []),
          ...(holder === undefined
            ? []
            : [
                `the entry "${write.title}" declares key material that live key ` +
                  `"${holder.title}" (id ${String(holder.id)}) already holds, and GitHub ` +
                  `attaches a public key to one repository once, so writing it would be rejected ` +
                  `- delete or rename the live key on GitHub, or declare the entry under its ` +
                  `live title "${holder.title}"`,
              ]),
        ];
      }),
  },
  prose: { undeclaredAction: "DELETE it" },
});
