// Drifting chimney smoke for the Greenvale smithy.
//
// Exports `createChimneySmoke(): ChimneySmoke`. A fixed ring of 12 sprite
// slots shows puffs emitted from the chimney mouth every 0.3 s. Everything is
// a pure function of the world time handed to `update(t, night)`: the puff
// emitted at index n appeared at `EMIT_OFFSET + n * EMIT_INTERVAL`, slot
// `n mod SLOTS` shows it, and its life/rise/drift/wobble/variant come from
// seeded integer hashing of n. Negative n are pre-roll puffs, so the plume is
// already established at t = 0 and reset replays the same frames exactly.
//
// Pixel art: five baked growth frames (6/10/14/18/24 px, 2 px cells, palette
// #ecebf0 / #d4d5dd / shadow #a9abb8) in two silhouette variants; growth is a
// frame swap, never a bitmap scale. The static baked plume in the source art
// is left untouched underneath.
//
// Bounds: rise <= 75 px/s over <= 3.2 s from y = 604 keeps the highest puff
// edge at y >= 352, so smoke never enters the minimap/HUD rect (y < 338).
//
// Ownership: sprites and baked textures are destroyed by `dispose()`.

import { Container, Sprite } from 'pixi.js';

import { bakeFrameBank, clamp01, even, hash3, lerpColor, u01 } from './water-flow.js';
import type { FrameBank } from './water-flow.js';

export interface ChimneySmoke {
  readonly root: Container;
  update(t: number, night: number): void;
  reset(): void;
  dispose(): void;
}

// Chimney mouth traced from the reference: opening spans x1459-1485, y602-618.
const ORIGIN_X = 1471;
const ORIGIN_Y = 604;
const EMIT_INTERVAL = 0.3;
const EMIT_OFFSET = 0.0731;
const SLOTS = 12; // >= ceil(max life 3.2 / 0.3) + 1
const LIFE_MIN = 2.6;
const LIFE_SPAN = 0.6;
const RISE_MIN = 55;
const RISE_SPAN = 20;
const DRIFT_MIN = 12;
const DRIFT_SPAN = 8;
const WOBBLE_PX = 3;
const PEAK_ALPHA = 1;
const NIGHT_TINT = 0x9a9fb6;
const NIGHT_ALPHA = 0.8;

const FRAME_CELLS = 12; // 24 px sprite frame, puffs centred
const SIZE_CELLS = [3, 5, 7, 9, 12] as const; // 6, 10, 14, 18, 24 px
const GROWTH_STEPS = [0.06, 0.16, 0.3, 0.5] as const; // age/life thresholds for frames 1-4
const FADE_START = 0.35; // opaque until here, then smoothstep to 0 at end of life
const LIGHT = 0xecebf0;
const MID = 0xd4d5dd;
const SHADOW = 0xa9abb8;

function paintPuff(put: (cx: number, cy: number, rgb: number) => void, size: number, variant: number): void {
  const half = FRAME_CELLS / 2;
  const radius = size / 2;
  const flip = variant === 0 ? 1 : -1;
  // Overlapping lobes read as a puff; tiny puffs are a single round blob.
  const lobes: number[] = size <= 3
    ? [0, 0, radius]
    : [
      0, 0, radius * 0.82,
      -0.38 * radius * flip, 0.18 * radius, radius * 0.62,
      0.4 * radius * flip, -0.1 * radius, radius * 0.6,
    ];
  if (size >= 9) lobes.push(0.05 * radius * flip, -0.42 * radius, radius * 0.55);
  for (let cy = 0; cy < FRAME_CELLS; cy++) {
    for (let cx = 0; cx < FRAME_CELLS; cx++) {
      const px = cx + 0.5 - half;
      const py = cy + 0.5 - half;
      const edge = (u01(hash3(cx, cy, size * 2 + variant + 0x91)) - 0.5) * 0.6;
      let inside = false;
      for (let i = 0; i < lobes.length && !inside; i += 3) {
        inside = Math.hypot(px - lobes[i]!, py - lobes[i + 1]!) <= lobes[i + 2]! + edge;
      }
      if (!inside) continue;
      const light = -((px / radius) * 0.55 + (py / radius) * 0.83);
      put(cx, cy, light > 0.28 ? LIGHT : light < -0.1 ? SHADOW : MID);
    }
  }
}

export function createChimneySmoke(): ChimneySmoke {
  const root = new Container({ label: 'greenvale-effects.chimney-smoke' });
  root.eventMode = 'none';
  root.interactiveChildren = false;
  const bank: FrameBank = bakeFrameBank(
    'greenvale.chimney-smoke', FRAME_CELLS, FRAME_CELLS, SIZE_CELLS.length * 2,
    (put, index) => paintPuff(put, SIZE_CELLS[index % SIZE_CELLS.length]!, Math.floor(index / SIZE_CELLS.length)),
  );
  const sprites: Sprite[] = [];
  for (let i = 0; i < SLOTS; i++) {
    const sprite = new Sprite({ texture: bank.textures[0]!, label: 'greenvale-effects.chimney-smoke.puff' });
    sprite.eventMode = 'none';
    sprite.visible = false;
    root.addChild(sprite);
    sprites.push(sprite);
  }
  const half = bank.frameWidth / 2;
  let disposed = false;

  function render(t: number, night: number): void {
    const n = clamp01(night);
    const tint = lerpColor(0xffffff, NIGHT_TINT, n);
    const alphaK = 1 - (1 - NIGHT_ALPHA) * n;
    const latest = Math.floor((t - EMIT_OFFSET) / EMIT_INTERVAL);
    for (let slot = 0; slot < SLOTS; slot++) {
      const sprite = sprites[slot]!;
      const index = latest - ((((latest - slot) % SLOTS) + SLOTS) % SLOTS);
      const life = LIFE_MIN + LIFE_SPAN * u01(hash3(index, 0x5e, 1));
      const age = t - EMIT_OFFSET - index * EMIT_INTERVAL;
      if (age < 0 || age >= life) {
        sprite.visible = false;
        continue;
      }
      const p = age / life;
      const rise = RISE_MIN + RISE_SPAN * u01(hash3(index, 0x5e, 2));
      const drift = DRIFT_MIN + DRIFT_SPAN * u01(hash3(index, 0x5e, 3));
      const wobblePhase = u01(hash3(index, 0x5e, 4)) * Math.PI * 2;
      const wobbleRate = Math.PI * 2 / (1.1 + 0.6 * u01(hash3(index, 0x5e, 5)));
      const variant = hash3(index, 0x5e, 6) & 1;
      const growth = p < GROWTH_STEPS[0] ? 0 : p < GROWTH_STEPS[1] ? 1 : p < GROWTH_STEPS[2] ? 2 : p < GROWTH_STEPS[3] ? 3 : 4;
      const x = ORIGIN_X + drift * age + WOBBLE_PX * Math.sin(wobbleRate * age + wobblePhase);
      const y = ORIGIN_Y - rise * age;
      sprite.visible = true;
      sprite.texture = bank.textures[variant * SIZE_CELLS.length + growth]!;
      sprite.position.set(even(x - half), even(y - half));
      sprite.tint = tint;
      const fadeQ = clamp01((p - FADE_START) / (1 - FADE_START));
      sprite.alpha = PEAK_ALPHA * Math.min(1, p / 0.05) * (1 - fadeQ * fadeQ * (3 - 2 * fadeQ)) * alphaK;
    }
  }

  function update(t: number, night: number): void {
    if (disposed) return;
    render(t, night);
  }

  function reset(): void {
    if (disposed) return;
    render(0, 0);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    root.destroy({ children: true });
    bank.destroy();
  }

  render(0, 0);
  return { root, update, reset, dispose };
}
