/**
 * Deterministic PRNG for the e2e fuzz harness. mulberry32 is a small, fast,
 * seedable generator; the Rng class wraps it with the sampling helpers the
 * generators need and a fork(label) that derives an independent child stream
 * from a label, so a scenario's sub-decisions stay replayable no matter how
 * many draws happen elsewhere in the parent stream. Nothing here touches
 * Date.now or Math.random - a run is a pure function of its seed.
 */

/** A 32-bit seeded generator returning a float in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mix a string label into a seed so fork(label) is stable and label-specific. */
function hashLabel(seed: number, label: string): number {
  let h = seed >>> 0;
  for (let i = 0; i < label.length; i++) {
    h = Math.imul(h ^ label.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export class Rng {
  private readonly next: () => number;

  constructor(readonly seed: number) {
    this.next = mulberry32(seed);
  }

  /** A float in [0, 1). */
  float(): number {
    return this.next();
  }

  /** An integer in [0, maxExclusive). */
  int(maxExclusive: number): number {
    if (maxExclusive <= 0) {
      throw new Error(`Rng.int: maxExclusive (${maxExclusive}) must be positive`);
    }
    return Math.floor(this.next() * maxExclusive);
  }

  /** A uniformly chosen element of a non-empty array. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error("Rng.pick: empty array");
    }
    return items[this.int(items.length)] as T;
  }

  /** True with the given probability (default 0.5). */
  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  /**
   * An independent child stream keyed by a label. The same (seed, label) pair
   * always yields the same child, regardless of how many draws the parent has
   * taken, so a scenario's per-section decisions replay identically.
   */
  fork(label: string): Rng {
    return new Rng(hashLabel(this.seed, label));
  }
}
