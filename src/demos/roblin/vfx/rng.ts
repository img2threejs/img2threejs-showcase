/**
 * Deterministic noise for every effect in this showcase.
 *
 * `Math.random` would make two runs of the same cast differ, which makes a screenshot review
 * meaningless — you can never tell whether a change moved the model or the dice. mulberry32 is
 * seeded, fast, and has a long enough period for particle work.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  (): number;
  range(min: number, max: number): number;
  spread(magnitude: number): number;
}

export function createRng(seed: number): Rng {
  const next = mulberry32(seed);
  const rng = (() => next()) as Rng;
  rng.range = (min: number, max: number) => min + (max - min) * next();
  rng.spread = (magnitude: number) => (next() * 2 - 1) * magnitude;
  return rng;
}
