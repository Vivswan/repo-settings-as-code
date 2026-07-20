/**
 * Declared-keys-only subset diff: desired is authoritative for exactly the
 * keys it declares; anything extra in the live object is ignored. Lists of
 * objects carrying a `type` key (ruleset rules) match by type instead of
 * position, because the API reorders them.
 */

export function subsetDiff(desired: unknown, live: unknown, path: string): string[] {
  if (desired === null || desired === undefined) {
    if (live === null || live === undefined || live === "") {
      return [];
    }
    return [`${path}: expected empty, live has ${JSON.stringify(live)}`];
  }
  if (Array.isArray(desired)) {
    return diffArray(desired, live, path);
  }
  if (typeof desired === "object") {
    if (typeof live !== "object" || live === null || Array.isArray(live)) {
      return [`${path}: expected object, live has ${JSON.stringify(live)}`];
    }
    const drift: string[] = [];
    for (const [key, value] of Object.entries(desired as Record<string, unknown>)) {
      drift.push(...subsetDiff(value, (live as Record<string, unknown>)[key], `${path}.${key}`));
    }
    return drift;
  }
  // Scalars. Tolerate live null vs desired "" (GitHub returns null for empty).
  if (desired === "" && (live === null || live === undefined)) {
    return [];
  }
  if (desired !== live) {
    return [`${path}: ${JSON.stringify(desired)} != ${JSON.stringify(live)}`];
  }
  return [];
}

function diffArray(desired: unknown[], live: unknown, path: string): string[] {
  if (!Array.isArray(live)) {
    return [`${path}: expected list, live has ${JSON.stringify(live)}`];
  }
  const desiredTypes = desired.map((item) =>
    typeof item === "object" && item !== null && "type" in (item as object)
      ? String((item as { type: unknown }).type)
      : null,
  );
  const liveTypes = Array.isArray(live)
    ? live.map((item) =>
        typeof item === "object" && item !== null && "type" in (item as object)
          ? String((item as { type: unknown }).type)
          : null,
      )
    : [];
  // Match by `type` only when types are UNIQUE on both sides (ruleset rules);
  // environment reviewers repeat types and must fall through to subset
  // matching below.
  const typed =
    desired.length > 0 &&
    desiredTypes.every((t) => t !== null) &&
    new Set(desiredTypes).size === desiredTypes.length &&
    liveTypes.every((t) => t !== null) &&
    new Set(liveTypes).size === liveTypes.length;
  if (typed) {
    // Match by `type` (ruleset rules): order-insensitive, extras ignored only
    // if not declared - a live rule type absent from desired is NOT drift
    // (declared-keys-only), but a declared type missing live IS.
    const drift: string[] = [];
    const liveByType = new Map<string, unknown>();
    for (const item of live) {
      if (typeof item === "object" && item !== null && "type" in (item as object)) {
        liveByType.set(String((item as { type: unknown }).type), item);
      }
    }
    const declaredTypes = new Set<string>();
    for (const item of desired) {
      const type = String((item as { type: unknown }).type);
      declaredTypes.add(type);
      const match = liveByType.get(type);
      if (match === undefined) {
        drift.push(`${path}[${type}]: missing live`);
      } else {
        drift.push(...subsetDiff(item, match, `${path}[${type}]`));
      }
    }
    // Undeclared live rules WOULD stay after an apply that sends the full
    // desired array, so they count as drift for rule lists specifically.
    for (const type of liveByType.keys()) {
      if (!declaredTypes.has(type)) {
        drift.push(`${path}[${type}]: present live but not declared`);
      }
    }
    return drift;
  }
  // Object lists without a `type` key (bypass_actors): order-insensitive
  // subset matching - each desired item must match SOME live item, and live
  // items matched by nothing are drift (a full-payload apply removes them).
  const objectList =
    desired.length > 0 &&
    desired.every((item) => typeof item === "object" && item !== null && !Array.isArray(item));
  if (objectList) {
    const drift: string[] = [];
    const liveItems = [...live];
    for (const [index, item] of desired.entries()) {
      const matchIndex = liveItems.findIndex(
        (candidate) => subsetDiff(item, candidate, "").length === 0,
      );
      if (matchIndex === -1) {
        drift.push(`${path}[${index}]: no matching live entry for ${JSON.stringify(item)}`);
      } else {
        liveItems.splice(matchIndex, 1);
      }
    }
    // Leftover live entries matter: a full-payload apply would remove them.
    for (const leftover of liveItems) {
      drift.push(`${path}: live entry not declared: ${JSON.stringify(leftover)}`);
    }
    return drift;
  }
  // Scalar lists (ref includes, topics): compare as sets.
  const desiredSet = new Set(desired.map((v) => JSON.stringify(v)));
  const liveSet = new Set(live.map((v) => JSON.stringify(v)));
  const drift: string[] = [];
  for (const value of desiredSet) {
    if (!liveSet.has(value)) {
      drift.push(`${path}: missing ${value}`);
    }
  }
  for (const value of liveSet) {
    if (!desiredSet.has(value)) {
      drift.push(`${path}: unexpected ${value}`);
    }
  }
  return drift;
}
