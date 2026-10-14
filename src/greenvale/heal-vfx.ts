// Self-centered emerald/mint/ivory healing VFX for Greenvale.
//
// Four bounded cast slots, deterministic sprites and texture banks, owned
// disposal. The visual is purely self-targeted: no projectile, crescent,
// arrow or outward flight. cast(x, y, facing) stores the world chest on
// the OUTER heal-vfx root and sets every per-cast slot root to local
// (0, 0); main is then responsible for keeping root.position tracking
// the hero chest every frame. The heal visual itself ignores facing —
// plus signs and the ground ring stay symmetric — so neither root nor
// any slot is ever mirrored.
//
// Reuses the pixel-skill helpers (pixel / pixelTexture / pixelGlyph /
// pixelSprite) and produces per-factory textures only. No global Texture
// or canvas, no per-cast or per-frame allocation, no fractional sprite
// scaling (native sprite scales are kept at 1 to honour the 2px cell grid).

import { Container, type Sprite, Texture } from 'pixi.js';
import { pixel, pixelGlyph, pixelSprite, pixelTexture, type PixelSkillVfx } from './pixel-skill.js';

// Pixel-perfect 2px step. Times in seconds.
const SLOT_COUNT = 4;
const LIFETIME = 1.2;
const FADE_IN = 0.08;
const FADE_OUT = 0.22;

// Plus-sign rise travel. localY +24 → -82 (below feet to above shoulders).
const RISE_FROM = 24;
const RISE_TO = -82;
// Stagger so the four pluses don't all peak together.
const RISE_HOLD_TAIL = 0.18;

// Ground ring rests at localY = 30.
const RING_LOCAL_Y = 30;

// Ground spread: two staggered expanding waves centred on the ring baseline.
const SPREAD_STARTS: readonly number[] = [0, 0.15];
// Motes drift in a bounded radius around the chest. Each mote computes
// its own radiusX/Y multiplier from its index at init.
const MOTE_COUNT = 8;
const MOTE_RADIUS_X = 56;
const MOTE_RADIUS_Y = 24;

// Emerald / mint / ivory palette — never blue.
const PALETTE = {
  edge: '#0d5a35',
  body: '#2bb877',
  mint: '#5cf2b1',
  light: '#b6ffd9',
  core: '#f3ffe4',
} as const;

// Four plus anchors stay strictly OUTSIDE the protected chest rectangle
// (x∈[-28,+28], y∈[-60,-8]) including the 24×24 plus half-width (12) and
// the per-plus horizontal bob. Anchor 46 - bob 2 - half-glyph 12 = 32,
// leaving a 4px gap from the protected band edge.
const PLUS_OFFSETS: readonly number[] = [-54, -46, 46, 54];
// Bob amplitude must keep |offsetX| - |bob| - 12 > 28 at all times.
const PLUS_BOB: readonly number[] = [-2, 2, 2, -2];
const PLUS_RISE_DUR: readonly number[] = [0.78, 0.74, 0.82, 0.76];
const PLUS_DELAY: readonly number[] = [0, 0.06, 0.04, 0.1];

interface PlusSlot {
  readonly sprite: Sprite;
  readonly offsetX: number;
  readonly bobX: number;
  readonly riseDur: number;
  readonly delay: number;
}

interface MoteSlot {
  readonly sprite: Sprite;
  readonly seedX: number;
  readonly seedY: number;
  readonly phase: number;
  readonly radiusX: number;
  readonly radiusY: number;
  readonly speed: number;
  readonly upper: boolean;
}

interface CastSlot {
  readonly root: Container;
  readonly pluses: PlusSlot[];
  readonly ring: Sprite;
  readonly ringCore: Sprite;
  readonly spread: Sprite[];
  readonly motes: MoteSlot[];
  age: number;
  active: boolean;
}

export function createHealVfx(): PixelSkillVfx {
  const label = 'skill-heal-pixel';
  const root = new Container({ label });
  root.visible = false;
  let disposed = false;

  // ---- textures --------------------------------------------------------

  // 24x24 px outlined plus sign (12x12 cells): dark emerald rim keeps it readable
  // on grass and at night; mint highlight row and ivory centre.
  const plusTexture = pixelGlyph(`${label}.plus`, [
    '....eeee....',
    '....elle....',
    '....emme....',
    '....emme....',
    'eeeeemmeeeee',
    'ellllcclllle',
    'emmmmccmmmme',
    'eeeeemmeeeee',
    '....emme....',
    '....emme....',
    '....emme....',
    '....eeee....',
  ], {
    e: PALETTE.edge,
    m: PALETTE.body,
    l: PALETTE.mint,
    c: PALETTE.core,
  });

  // Crisp ground ring: ONE centred stepped ellipse, outer rx=54 ry=16
  // with an inner empty band. No mirrored-half duplicate lobes, no opaque
  // disk. 112x40 canvas centred at (56, 20).
  const RING_W = 112;
  const RING_H = 40;
  const ringTexture = pixelTexture(`${label}.ring`, RING_W, RING_H, (ctx) => {
    const rx = 54;
    const ry = 16;
    const cx = RING_W / 2;
    const cy = RING_H / 2;
    for (let py = 0; py < RING_H; py += 2) {
      for (let px = 0; px < RING_W; px += 2) {
        const dx = (px + 1 - cx) / rx;
        const dy = (py + 1 - cy) / ry;
        const r2 = dx * dx + dy * dy;
        // outer ring band only (between 0.62 and 1.0 of the ellipse);
        // hollow inside so the ring never becomes an opaque disk.
        if (r2 < 0.62 || r2 > 1.0) continue;
        const t = (r2 - 0.62) / 0.38;
        const color = t > 0.72 ? PALETTE.edge
          : t > 0.4 ? PALETTE.body : PALETTE.mint;
        ctx.fillStyle = color;
        ctx.fillRect(px, py, 2, 2);
      }
    }
  });

  // Inner ring layer: a thinner bright step just inside the outer band,
  // centred, no mirrors.
  const ringCoreTexture = pixelTexture(`${label}.ringCore`, RING_W, RING_H, (ctx) => {
    const rx = 40;
    const ry = 10;
    const cx = RING_W / 2;
    const cy = RING_H / 2;
    for (let py = 0; py < RING_H; py += 2) {
      for (let px = 0; px < RING_W; px += 2) {
        const dx = (px + 1 - cx) / rx;
        const dy = (py + 1 - cy) / ry;
        const r2 = dx * dx + dy * dy;
        if (r2 < 0.7 || r2 > 1.0) continue;
        const t = (r2 - 0.7) / 0.3;
        const color = t < 0.4 ? PALETTE.core
          : t < 0.75 ? PALETTE.light : PALETTE.mint;
        ctx.fillStyle = color;
        ctx.fillRect(px, py, 2, 2);
      }
    }
  });

  // 6x6 cell mote = 12x12 px, body diamond + light cross, no edge to stay
  // soft against the hero silhouette.
  const moteTexture = pixelGlyph(`${label}.mote`, [
    '..mm..',
    'mlllm',
    'mlllm',
    'mlllm',
    'mlllm',
    '..mm..',
  ], {
    m: PALETTE.body,
    l: PALETTE.light,
  });

  // Two baked ground-spread frames: a tight inner ellipse and a wider outer
  // one, both 128x64 centred at (64, 32). Soft mint/emerald, hollow centre.
  const SPREAD_W = 128;
  const SPREAD_H = 64;
  const spreadFrameTexture = (name: string, rx: number, ry: number): Texture =>
    pixelTexture(`${label}.${name}`, SPREAD_W, SPREAD_H, (ctx) => {
      const cx = SPREAD_W / 2;
      const cy = SPREAD_H / 2;
      for (let py = 0; py < SPREAD_H; py += 2) {
        for (let px = 0; px < SPREAD_W; px += 2) {
          const dx = (px + 1 - cx) / rx;
          const dy = (py + 1 - cy) / ry;
          const r2 = dx * dx + dy * dy;
          if (r2 < 0.5 || r2 > 1.0) continue;
          ctx.fillStyle = r2 > 0.8 ? PALETTE.body : PALETTE.mint;
          ctx.fillRect(px, py, 2, 2);
        }
      }
    });
  const spreadFrames: Texture[] = [
    spreadFrameTexture('spread.near', 40, 14),
    spreadFrameTexture('spread.far', 60, 26),
  ];

  const textures: Texture[] = [plusTexture, ringTexture, ringCoreTexture, moteTexture, ...spreadFrames];

  // ---- slots -----------------------------------------------------------

  const slots: CastSlot[] = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    const slotRoot = new Container({ label: `${label}.slot.${i}` });
    slotRoot.visible = false;

    const spread: Sprite[] = [];
    for (let w = 0; w < SPREAD_STARTS.length; w++) {
      const sprite = pixelSprite(spreadFrames[0]!, `${label}.slot.${i}.spread.${w}`);
      sprite.anchor.set(0.5);
      sprite.position.set(0, pixel(RING_LOCAL_Y));
      sprite.visible = false;
      slotRoot.addChild(sprite);
      spread.push(sprite);
    }

    const ring = pixelSprite(ringTexture, `${label}.slot.${i}.ring`);
    ring.position.set(0, pixel(RING_LOCAL_Y));
    ring.anchor.set(0.5);
    slotRoot.addChild(ring);

    const ringCore = pixelSprite(ringCoreTexture, `${label}.slot.${i}.ringCore`);
    ringCore.position.set(0, pixel(RING_LOCAL_Y));
    ringCore.anchor.set(0.5);
    slotRoot.addChild(ringCore);

    const pluses: PlusSlot[] = [];
    for (let p = 0; p < PLUS_OFFSETS.length; p++) {
      const sprite = pixelSprite(plusTexture, `${label}.slot.${i}.plus.${p}`);
      sprite.anchor.set(0.5);
      slotRoot.addChild(sprite);
      pluses.push({
        sprite,
        offsetX: PLUS_OFFSETS[p]!,
        bobX: PLUS_BOB[p]!,
        riseDur: PLUS_RISE_DUR[p]!,
        delay: PLUS_DELAY[p]!,
      });
    }

    const motes: MoteSlot[] = [];
    for (let m = 0; m < MOTE_COUNT; m++) {
      const sprite = pixelSprite(moteTexture, `${label}.slot.${i}.mote.${m}`);
      sprite.anchor.set(0.5);
      slotRoot.addChild(sprite);
      // Half the motes float above the shoulders, half drift around the
      // ground ring; paintMote() then clamps the final centre Y so the
      // resulting sprite position never enters the protected chest rect.
      const upper = m % 2 === 0;
      const phase = (m / MOTE_COUNT) * Math.PI * 2;
      const seedY = upper ? -82 : 18;
      motes.push({
        sprite,
        seedX: Math.cos(phase + i * 0.7) * MOTE_RADIUS_X,
        seedY: seedY + Math.sin(phase + i * 0.5) * (upper ? 12 : 8),
        phase,
        radiusX: MOTE_RADIUS_X * (0.45 + (m % 3) * 0.16),
        radiusY: MOTE_RADIUS_Y * (upper ? 0.7 : 0.5) * (0.6 + ((m + 1) % 4) * 0.12),
        speed: 0.6 + (m % 5) * 0.15,
        upper,
      });
    }

    root.addChild(slotRoot);
    slots.push({ root: slotRoot, pluses, spread, ring, ringCore, motes, age: 0, active: false });
  }

  // ---- paint -----------------------------------------------------------

  function paintRing(slot: CastSlot, t: number): void {
    // Native sprite scales stay at 1 — animate alpha only so the ring
    // never blurs or resamples its stepped grid.
    slot.ring.alpha = Math.sin(Math.PI * Math.min(1, t * 1.4)) * (1 - t * 0.7);
    slot.ringCore.alpha = Math.sin(Math.PI * Math.min(1, t * 1.2)) * (1 - t) * 0.85;
    slot.ring.position.y = pixel(RING_LOCAL_Y);
    slot.ringCore.position.y = pixel(RING_LOCAL_Y);
  }

  function paintPlus(plus: PlusSlot, slotAge: number): void {
    const local = slotAge - plus.delay;
    if (local < 0) {
      plus.sprite.visible = false;
      return;
    }
    const u = Math.min(1, local / plus.riseDur);
    plus.sprite.visible = u < 1 || local < plus.riseDur + RISE_HOLD_TAIL;
    const y = pixel(RISE_FROM + (RISE_TO - RISE_FROM) * u);
    const xBob = Math.sin(u * Math.PI * 2 + plus.bobX) * plus.bobX;
    plus.sprite.position.set(pixel(plus.offsetX + xBob), y);
    // Quick fade-in, full body, fade-out over the last 25%. Alpha only;
    // scale never changes.
    let alpha = 1;
    if (u < 0.18) alpha = u / 0.18;
    else if (u > 0.75) alpha = Math.max(0, 1 - (u - 0.75) / 0.25);
    plus.sprite.alpha = alpha;
  }

  function paintMote(mote: MoteSlot, slotAge: number): void {
    const t = (slotAge * mote.speed + mote.phase) % (Math.PI * 2);
    const breathe = 0.5 + 0.5 * Math.sin(slotAge * 1.4 + mote.phase);
    const radius = 0.4 + 0.6 * breathe;
    const x = mote.seedX + Math.cos(t) * mote.radiusX * radius;
    let y = mote.seedY + Math.sin(t * 1.1) * mote.radiusY * radius;
    // Clamp the rendered centre Y so motes never enter the protected
    // chest rectangle (y∈[-60,-8]). Upper band stays at or above y=-66;
    // lower band stays at or below y=-2. Y clamping alone is enough to
    // keep motes out of the face/scarf zone — the y range is the only
    // way a mote could overlap the chest.
    if (mote.upper) y = Math.min(y, -66);
    else y = Math.max(y, -2);
    mote.sprite.position.set(pixel(x), pixel(y));
    const life = Math.min(1, Math.max(0, slotAge / LIFETIME));
    const fade = life < FADE_IN / LIFETIME ? life / (FADE_IN / LIFETIME)
      : life > 1 - FADE_OUT / LIFETIME ? Math.max(0, (1 - life) / (FADE_OUT / LIFETIME))
      : 1;
    mote.sprite.alpha = fade * (0.45 + 0.35 * breathe);
    mote.sprite.visible = fade > 0;
  }

  // Two staggered ground-spread waves (starts 0s and 0.15s). Each wave
  // expands from the ring baseline over the time left in the cast, so
  // nothing is visible after LIFETIME. Frame swap is by wave progress;
  // alpha = (1 - age/LIFETIME) * ramp-in/steady/ramp-out. Scale stays native.
  function paintSpread(slot: CastSlot, slotAge: number): void {
    for (let w = 0; w < SPREAD_STARTS.length; w++) {
      const sprite = slot.spread[w]!;
      const start = SPREAD_STARTS[w]!;
      const dur = LIFETIME - start;
      const local = slotAge - start;
      if (local < 0 || slotAge >= LIFETIME) {
        sprite.visible = false;
        continue;
      }
      const u = local / dur;
      sprite.texture = u < 0.5 ? spreadFrames[0]! : spreadFrames[1]!;
      let ramp = 1;
      if (u < FADE_IN / dur) ramp = u / (FADE_IN / dur);
      else if (u > 1 - FADE_OUT / dur) ramp = Math.max(0, (1 - u) / (FADE_OUT / dur));
      sprite.alpha = (1 - slotAge / LIFETIME) * ramp;
      sprite.visible = sprite.alpha > 0;
    }
  }

  function paint(slot: CastSlot): void {
    const age = slot.age;
    const t = Math.min(1, age / LIFETIME);
    paintRing(slot, t);
    for (const plus of slot.pluses) paintPlus(plus, age);
    for (const mote of slot.motes) paintMote(mote, age);
    paintSpread(slot, age);
  }

  // ---- public api ------------------------------------------------------

  function cast(x: number, y: number, _facing: number): void {
    if (disposed) return;
    // Outer heal-vfx root holds the world chest position; per-cast slot
    // roots stay at local (0, 0). main drives root.position every frame
    // so healing follows the hero.
    root.position.set(pixel(x), pixel(y));
    let slot = slots[0]!;
    for (const candidate of slots) {
      if (!candidate.active) { slot = candidate; break; }
      if (candidate.age > slot.age) slot = candidate;
    }
    slot.root.position.set(0, 0);
    // Self-targeted: never mirror the heal layout with facing.
    slot.root.scale.set(1, 1);
    slot.age = 0;
    slot.active = true;
    paint(slot);
    slot.root.visible = true;
    root.visible = true;
  }

  function update(dt: number): void {
    if (disposed || !Number.isFinite(dt) || dt <= 0) return;
    let active = false;
    for (const slot of slots) {
      if (!slot.active) continue;
      slot.age += dt;
      if (slot.age >= LIFETIME + 0.05) {
        slot.active = false;
        slot.root.visible = false;
      } else {
        paint(slot);
        active = true;
      }
    }
    root.visible = active;
  }

  function reset(): void {
    if (disposed) return;
    for (const slot of slots) {
      slot.active = false;
      slot.age = 0;
      slot.root.visible = false;
      for (const s of slot.spread) s.visible = false;
    }
    root.visible = false;
  }

  function dispose(): void {
    if (disposed) return;
    reset();
    disposed = true;
    root.destroy({ children: true });
    for (const texture of textures) texture.destroy(true);
  }

  return { root, cast, update, reset, dispose };
}
