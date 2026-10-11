// Attack VFX layer for Greenvale.
//
// Six distinct world-anchored attack visuals: slash, combo, thrust,
// spin, dash, ground. Each factory mirrors the `PixelSkillVfx`
// contract from `./pixel-skill.js`. No global textures, no per-cast
// or per-frame allocation, no scheduled redraws. Native 2px cells
// only; no per-frame bitmap rotation / scaling / gradients.
//
// Determinism:
//   * All baked textures are factory-owned; cast() never touches
//     the renderer after init.
//   * Lifetime is purely a function of accumulated slot age; no
//     wall-clock state.
//   * Initial positions, scales and alphas are populated eagerly
//     inside paint() so `reset()` followed by replay produces the
//     same visible frame.
//
// Capacity:
//   Four slots per action. Selection policy matches
//   `skill-projectile.ts`: pick an inactive slot; otherwise the
//     oldest active one.
//
// Lifecycle:
//   * `cast(x, y, facing)` records the slot origin in world pixels
//     and snaps the slot's mirror in `+/-1`. `facing < 0` mirrors
//     only the slot's `scale.x` so children keep native pixels.
//   * `update(dt)` ages active slots and paints their phases.
//     Rejects `dt <= 0`, non-finite, and the disposed state.
//   * `reset()` clears every active slot.
//   * `dispose()` destroys the owned root and the textures this
//     factory created; idempotent.

import { Container, Sprite, Texture } from 'pixi.js';
import type { Attack } from './types.js';
import { pixel, pixelGlyph, pixelSprite, pixelTexture, type PixelSkillVfx } from './pixel-skill.js';

// ---------- shared timing (seconds) -----------------------------------

const TIMINGS: Record<Attack, { total: number; wind: number; peak: number; fade: number }> = {
  slash:  { total: 0.36, wind: 0.06, peak: 0.20, fade: 0.36 },
  thrust: { total: 0.40, wind: 0.06, peak: 0.30, fade: 0.40 },
  spin:   { total: 1.08, wind: 0.04, peak: 0.64, fade: 0.76 },
  dash:   { total: 0.50, wind: 0.04, peak: 0.40, fade: 0.50 },
  ground: { total: 0.90, wind: 0.18, peak: 0.50, fade: 0.90 },
  combo:  { total: 1.32, wind: 0, peak: 0.16, fade: 1.32 },
};

// Hero keepout: feet origin. Ground pillars anchor at floor Y=0
// and sit forward of the shield arm.
const FLOOR_Y = 0;

// Cobalt / cyan / ivory / indigo shared palette.
const COBALT = {
  edge:   '#0a1840',
  deep:   '#16286a',
  body:   '#2050c8',
  mid:    '#3a86e6',
  light:  '#7ec8ff',
  glow:   '#cdeeff',
  ivory:  '#fff5d6',
  white:  '#ffffff',
  dust:   '#efe1b3',
  stone:  '#5a6378',
  stoneL: '#9aa3b8',
} as const;

const POOL = 4;

interface CastSlot {
  root: Container;
  age: number;
  active: boolean;
}

interface AttackState {
  readonly root: Container;
  readonly slots: CastSlot[];
  readonly owned: Texture[];
  readonly paint: (slot: CastSlot) => void;
  disposed: boolean;
}

function buildSlotRoot(label: string, index: number): Container {
  return new Container({ label: `${label}.slot.${index}` });
}

// ---------- shared color helpers --------------------------------------

function ellipseMask(px: number, py: number, rx: number, ry: number): boolean {
  return (px * px) / (rx * rx) + (py * py) / (ry * ry) <= 1;
}

function inBand(px: number, py: number, rx: number, ry: number, innerRx: number, innerRy: number): boolean {
  return ellipseMask(px, py, rx, ry) && !ellipseMask(px, py, innerRx, innerRy);
}

// ---------- SLASH ------------------------------------------------------
//
// Forward broad crescent baked from outer ellipse rx=64 ry=74 minus
// inner ellipse shifted by +28 along x (so the arc opens away from
// the hero, never crossing the face). Six angular-reveal frames
// progressively light the crescent.

const SLASH_W = 140;
const SLASH_H = 160;
// Outer ellipse center in texture pixels; the inner ellipse is shifted toward the caster
// and taller than the outer one, so the band reads ")" and tapers to thin tips.
const SLASH_CX = 72;
const SLASH_CY = 80;
const SLASH_RX = 64;
const SLASH_RY = 74;
const SLASH_INNER_SHIFT = 26;
const SLASH_INNER_RX = 62;
const SLASH_INNER_RY = 82;
const SLASH_FRAMES = 6;
const SLASH_LOCAL_X = 28;

function makeSlash(): AttackState {
  const label = `attack-slash-pixel`;
  const textures: Texture[] = [];
  for (let f = 0; f < SLASH_FRAMES; f++) {
    textures.push(bakeCrescent(`${label}.frame.${f}`, f));
  }
  const owned = textures;
  const sprites: Sprite[] = [];

  const slots: CastSlot[] = [];
  const root = new Container({ label });
  root.visible = false;

  for (let i = 0; i < POOL; i++) {
    const slotRoot = buildSlotRoot(label, i);
    slotRoot.visible = false;
    const locals: Sprite[] = [];
    for (let f = 0; f < SLASH_FRAMES; f++) {
      const s = pixelSprite(textures[f]!, `${label}.frame.${i}.${f}`);
      locals.push(s);
      slotRoot.addChild(s);
    }
    root.addChild(slotRoot);
    slots.push({ root: slotRoot, age: 0, active: false });
    sprites.push(...locals);
  }

  // At chest height the band starts >= 54px ahead of the feet origin; tips stay forward too.
  const SLASH_LOCAL_Y = -46;

  function paintSlot(slot: CastSlot): void {
    const age = slot.age;
    const base = slots.indexOf(slot);
    const timing = TIMINGS.slash;
    if (age < timing.wind) {
      const k = age / timing.wind;
      for (let f = 0; f < SLASH_FRAMES; f++) {
        const s = sprites[base * SLASH_FRAMES + f]!;
        s.position.set(pixel(SLASH_LOCAL_X), pixel(SLASH_LOCAL_Y));
        s.visible = f === 0;
        s.alpha = 0.4 * k;
      }
    } else if (age < timing.peak) {
      const k = (age - timing.wind) / (timing.peak - timing.wind);
      // Each baked frame is a cumulative angular mask; showing
      // the highest-reached frame reveals the full sweep to that
      // angle.
      const activeFrame = Math.min(SLASH_FRAMES - 1, Math.floor(k * SLASH_FRAMES));
      for (let f = 0; f < SLASH_FRAMES; f++) {
        const s = sprites[base * SLASH_FRAMES + f]!;
        s.position.set(pixel(SLASH_LOCAL_X), pixel(SLASH_LOCAL_Y));
        s.visible = f === activeFrame;
        s.alpha = 1;
      }
    } else {
      const k = (age - timing.peak) / (timing.fade - timing.peak);
      for (let f = 0; f < SLASH_FRAMES; f++) {
        const s = sprites[base * SLASH_FRAMES + f]!;
        s.position.set(pixel(SLASH_LOCAL_X), pixel(SLASH_LOCAL_Y));
        s.visible = f === SLASH_FRAMES - 1;
        s.alpha = 1 - k;
      }
    }
    slot.root.visible = age < timing.total;
  }

  return { root, slots, owned, paint: paintSlot, disposed: false };
}

function bakeCrescent(label: string, frame: number): Texture {
  // Frame f reveals the arc from the top tip down to (f+1)/SLASH_FRAMES and paints the
  // reveal frontier white, so the frame bank reads as a downward sweep without rotation.
  const reach = (frame + 1) / SLASH_FRAMES;
  return pixelTexture(label, SLASH_W, SLASH_H, ctx => {
    for (let y = 0; y < SLASH_H; y += 2) {
      const py = y + 1 - SLASH_CY;
      for (let x = 0; x < SLASH_W; x += 2) {
        const px = x + 1 - SLASH_CX;
        const outer = ellipseSigned(px, py, SLASH_RX, SLASH_RY);
        const inner = ellipseSigned(px + SLASH_INNER_SHIFT, py, SLASH_INNER_RX, SLASH_INNER_RY);
        if (outer > 1 || inner <= 1) continue;
        const sweep = (py + SLASH_RY) / (2 * SLASH_RY);
        if (sweep > reach) continue;
        let color: string;
        if (sweep > reach - 0.07) color = COBALT.white;
        else if (outer > 0.9) color = COBALT.edge;
        else if (inner < 1.12) color = COBALT.ivory;
        else if (inner < 1.3) color = COBALT.light;
        else if (outer > 0.76) color = COBALT.body;
        else color = COBALT.mid;
        ctx.fillStyle = color;
        ctx.fillRect(x, y, 2, 2);
      }
    }
  });
}

function ellipseSigned(px: number, py: number, rx: number, ry: number): number {
  return (px * px) / (rx * rx) + (py * py) / (ry * ry);
}

// ---------- COMBO ------------------------------------------------------
//
// Three different cuts on the hero's 0.4 s combo stride: a horizontal sweep at
// chest height, a vertical overhead chop and a diagonal leaping finisher. Each
// cut bakes its own crescent frame bank by sampling the crescent in a rotated
// (swing, bulge) frame at bake time, so orientation needs no runtime rotation.
// A cut lingers and fades while the next one sweeps, leaving layered
// horizontal / vertical / diagonal trails; the finisher ends in a star flash.
// Centres are feet-local for facing right and include the hero's lunge offset
// at each strike; every cut stays clear of the live head/scarf bounds.

interface ComboCut {
  readonly name: string;
  /** Seconds after the cast when this cut starts sweeping. */
  readonly start: number;
  /** Crescent centre (feet-local px, facing right). */
  readonly x: number;
  readonly y: number;
  /** Swing direction from the first tip to the last (normalised at bake time). */
  readonly swing: readonly [number, number];
  /** Unit direction of the convex side, perpendicular to the swing, away from the hero. */
  readonly bulge: readonly [number, number];
  readonly half: number;
  readonly depth: number;
  /** Inner ellipse offset toward the concave side; sets the band thickness. */
  readonly shift: number;
  /** White leading-edge width as a fraction of the sweep. */
  readonly frontier: number;
}

const COMBO_DIAG_LEN = Math.hypot(0.66, 0.75);
const COMBO_CUTS: readonly ComboCut[] = [
  // Tips sit below the head/scarf bounds even with the strike lean (bottom edge reaches y=-29).
  { name: 'horizontal', start: 0, x: 74, y: -27, swing: [1, 0], bulge: [0, 1], half: 58, depth: 26, shift: 13, frontier: 0.08 },
  { name: 'vertical', start: 0.4, x: 52, y: -56, swing: [0, 1], bulge: [1, 0], half: 56, depth: 26, shift: 13, frontier: 0.08 },
  {
    // Upper tip stays right of the landing lean's head bounds (right edge reaches x=62).
    name: 'diagonal', start: 0.8, x: 106, y: -46,
    swing: [0.66 / COMBO_DIAG_LEN, 0.75 / COMBO_DIAG_LEN],
    bulge: [0.75 / COMBO_DIAG_LEN, -0.66 / COMBO_DIAG_LEN],
    half: 60, depth: 32, shift: 16, frontier: 0.11,
  },
];
const COMBO_FRAMES = 6;
const COMBO_SWEEP = 0.16;
const COMBO_HOLD = 0.04;
const COMBO_FADE = 0.32;
const COMBO_STAR_SECONDS = 0.1;
const COMBO_STAR_ROWS = [
  '....w....',
  '....w....',
  '...lwl...',
  '..l.w.l..',
  'wwwwWwwww',
  '..l.w.l..',
  '...lwl...',
  '....w....',
  '....w....',
];

function comboCutSize(cut: ComboCut): { w: number; h: number } {
  const span = (axis: number, normal: number): number =>
    2 * (Math.ceil((Math.abs(axis) * cut.half + Math.abs(normal) * cut.depth) / 2) * 2 + 4);
  return { w: span(cut.swing[0], cut.bulge[0]), h: span(cut.swing[1], cut.bulge[1]) };
}

function bakeComboCut(label: string, cut: ComboCut, frame: number): Texture {
  // Frame f reveals the crescent from its first tip to (f+1)/COMBO_FRAMES along the swing.
  const reach = (frame + 1) / COMBO_FRAMES;
  const { w, h } = comboCutSize(cut);
  const [ax, ay] = cut.swing;
  const [nx, ny] = cut.bulge;
  return pixelTexture(label, w, h, ctx => {
    for (let y = 0; y < h; y += 2) {
      const dy = y + 1 - h / 2;
      for (let x = 0; x < w; x += 2) {
        const dx = x + 1 - w / 2;
        const u = dx * ax + dy * ay;
        const v = dx * nx + dy * ny;
        const outer = ellipseSigned(v, u, cut.depth, cut.half);
        const inner = ellipseSigned(v + cut.shift, u, cut.depth, cut.half * 1.12);
        if (outer > 1 || inner <= 1) continue;
        const sweep = (u + cut.half) / (2 * cut.half);
        if (sweep > reach) continue;
        let color: string;
        if (sweep > reach - cut.frontier) color = COBALT.white;
        else if (outer > 0.88) color = COBALT.edge;
        else if (inner < 1.12) color = COBALT.ivory;
        else if (inner < 1.3) color = COBALT.light;
        else if (outer > 0.74) color = COBALT.body;
        else color = COBALT.mid;
        ctx.fillStyle = color;
        ctx.fillRect(x, y, 2, 2);
      }
    }
  });
}

function makeCombo(): AttackState {
  const label = `attack-combo-pixel`;
  const owned: Texture[] = [];
  const banks = COMBO_CUTS.map(cut => {
    const frames: Texture[] = [];
    for (let f = 0; f < COMBO_FRAMES; f++) frames.push(bakeComboCut(`${label}.${cut.name}.${f}`, cut, f));
    owned.push(...frames);
    return frames;
  });
  const star = pixelGlyph(`${label}.star`, COMBO_STAR_ROWS, { W: COBALT.white, w: COBALT.glow, l: COBALT.light });
  owned.push(star);
  const last = COMBO_CUTS[COMBO_CUTS.length - 1]!;
  const starX = last.x + last.swing[0] * last.half;
  const starY = last.y + last.swing[1] * last.half;

  interface ComboSlotSprites { cuts: Sprite[][]; star: Sprite }
  const slotSprites: ComboSlotSprites[] = [];
  const slots: CastSlot[] = [];
  const root = new Container({ label });
  root.visible = false;

  for (let i = 0; i < POOL; i++) {
    const slotRoot = buildSlotRoot(label, i);
    slotRoot.visible = false;
    const cuts = COMBO_CUTS.map((cut, c) => banks[c]!.map((texture, f) => {
      const s = pixelSprite(texture, `${label}.${cut.name}.${i}.${f}`);
      s.position.set(pixel(cut.x), pixel(cut.y));
      s.visible = false;
      slotRoot.addChild(s);
      return s;
    }));
    const flash = pixelSprite(star, `${label}.star.${i}`);
    flash.position.set(pixel(starX), pixel(starY));
    flash.visible = false;
    slotRoot.addChild(flash);
    root.addChild(slotRoot);
    slots.push({ root: slotRoot, age: 0, active: false });
    slotSprites.push({ cuts, star: flash });
  }

  function paintSlot(slot: CastSlot): void {
    const sprites = slotSprites[slots.indexOf(slot)]!;
    for (let c = 0; c < COMBO_CUTS.length; c++) {
      const local = slot.age - COMBO_CUTS[c]!.start;
      const live = local >= 0 && local < COMBO_SWEEP + COMBO_HOLD + COMBO_FADE;
      const frame = local < COMBO_SWEEP
        ? Math.min(COMBO_FRAMES - 1, Math.floor((local / COMBO_SWEEP) * COMBO_FRAMES))
        : COMBO_FRAMES - 1;
      const alpha = local < COMBO_SWEEP + COMBO_HOLD
        ? 1
        : Math.max(0, 1 - (local - COMBO_SWEEP - COMBO_HOLD) / COMBO_FADE);
      const bank = sprites.cuts[c]!;
      for (let f = 0; f < COMBO_FRAMES; f++) {
        const s = bank[f]!;
        s.visible = live && f === frame;
        s.alpha = alpha;
      }
    }
    const starAge = slot.age - last.start - COMBO_SWEEP;
    sprites.star.visible = starAge >= 0 && starAge < COMBO_STAR_SECONDS;
    slot.root.visible = slot.age < TIMINGS.combo.total;
  }

  return { root, slots, owned, paint: paintSlot, disposed: false };
}

// ---------- THRUST -----------------------------------------------------
//
// Forward 220x44 lance, anchor (0, 0.5) at left localX=44, Y=-28.
// Three length frames reveal the lance from short to full reach.

const THRUST_W = 220;
const THRUST_H = 44;
const THRUST_LEN_FRAMES = 3;

function makeThrust(): AttackState {
  const label = `attack-thrust-pixel`;
  const textures: Texture[] = [];
  for (let f = 0; f < THRUST_LEN_FRAMES; f++) textures.push(bakeLance(`${label}.len.${f}`, f));
  const owned = textures;
  const sprites: Sprite[] = [];

  const slots: CastSlot[] = [];
  const root = new Container({ label });
  root.visible = false;

  for (let i = 0; i < POOL; i++) {
    const slotRoot = buildSlotRoot(label, i);
    slotRoot.visible = false;
    const locals: Sprite[] = [];
    for (let f = 0; f < THRUST_LEN_FRAMES; f++) {
      const s = pixelSprite(textures[f]!, `${label}.len.${i}.${f}`);
      s.anchor.set(0, 0.5);
      locals.push(s);
      slotRoot.addChild(s);
    }
    root.addChild(slotRoot);
    slots.push({ root: slotRoot, age: 0, active: false });
    sprites.push(...locals);
  }

  const baseX = 44;
  const baseY = -28;
  const timing = TIMINGS.thrust;

  function paintSlot(slot: CastSlot): void {
    const age = slot.age;
    const base = slots.indexOf(slot);
    if (age < timing.wind) {
      for (let f = 0; f < THRUST_LEN_FRAMES; f++) {
        const s = sprites[base * THRUST_LEN_FRAMES + f]!;
        s.position.set(pixel(baseX), pixel(baseY));
        s.visible = f === 0;
        s.alpha = 0.7;
      }
    } else if (age < timing.peak) {
      const k = (age - timing.wind) / (timing.peak - timing.wind);
      const activeFrame = Math.min(THRUST_LEN_FRAMES - 1, Math.floor(k * THRUST_LEN_FRAMES));
      for (let f = 0; f < THRUST_LEN_FRAMES; f++) {
        const s = sprites[base * THRUST_LEN_FRAMES + f]!;
        s.position.set(pixel(baseX), pixel(baseY));
        s.visible = f === activeFrame;
        s.alpha = 1;
      }
    } else {
      const k = (age - timing.peak) / (timing.fade - timing.peak);
      for (let f = 0; f < THRUST_LEN_FRAMES; f++) {
        const s = sprites[base * THRUST_LEN_FRAMES + f]!;
        s.position.set(pixel(baseX), pixel(baseY));
        s.visible = f === THRUST_LEN_FRAMES - 1;
        s.alpha = 1 - k;
      }
    }
    slot.root.visible = age < timing.total;
  }

  return { root, slots, owned, paint: paintSlot, disposed: false };
}

function bakeLance(label: string, frame: number): Texture {
  // Every frame is a complete pointed wedge; later frames are longer, so the tip stays sharp.
  const length = Math.floor(((THRUST_W - 2) * (frame + 1)) / THRUST_LEN_FRAMES / 2) * 2;
  const baseHalf = 18;
  const tipHalf = 2;
  return pixelTexture(label, THRUST_W, THRUST_H, ctx => {
    for (let x = 0; x < length; x += 2) {
      const t = x / length;
      const half = baseHalf - (baseHalf - tipHalf) * t;
      for (let y = 0; y < THRUST_H; y += 2) {
        const absR = Math.abs(y - THRUST_H / 2);
        if (absR > half) continue;
        let color: string;
        if (absR > half - 2) color = t > 0.85 ? COBALT.edge : COBALT.body;
        else if (absR <= 1) color = COBALT.white;
        else if (absR <= 2) color = COBALT.ivory;
        else if (absR <= 5) color = COBALT.light;
        else color = COBALT.mid;
        ctx.fillStyle = color;
        ctx.fillRect(x, y, 2, 2);
      }
    }
    for (let x = 0; x < length * 0.6; x += 8) {
      ctx.fillStyle = COBALT.glow;
      ctx.fillRect(x, THRUST_H / 2 - 6, 4, 2);
      ctx.fillRect(x + 4, THRUST_H / 2 + 4, 4, 2);
    }
  });
}

// ---------- SPIN -------------------------------------------------------
// Two sword-synchronous revolutions, then two staggered ground waves.
// Expansion is baked at native 2px resolution, never sprite-scaled.
// The wide ellipse stays below the face/scarf; its centre stays transparent.

const SPIN_W = 200;
const SPIN_H = 64;
const SPIN_FRAMES = 8;
const SPIN_WAVE_FRAMES = 12;
const SPIN_WAVE_W = 400;
const SPIN_WAVE_H = 112;
const SPIN_WAVE_STARTS = [0.08, 0.34] as const;
const SPIN_WAVE_SECONDS = 0.70;

function makeSpin(): AttackState {
  const label = 'attack-spin-pixel';
  const core = Array.from({ length: SPIN_FRAMES }, (_, f) => bakeSpinFrame(`${label}.angle.${f}`, f));
  const waves = Array.from({ length: SPIN_WAVE_FRAMES }, (_, f) => bakeSpinWave(`${label}.wave.${f}`, f));
  const owned = [...core, ...waves];
  const sprites: Sprite[] = [];
  const slots: CastSlot[] = [];
  const root = new Container({ label });
  root.visible = false;

  for (let i = 0; i < POOL; i++) {
    const slotRoot = buildSlotRoot(label, i);
    slotRoot.visible = false;
    // Ground waves underneath the sharper sword trail.
    for (let w = 0; w < 2; w++) {
      const s = pixelSprite(waves[0]!, `${label}.wave.${i}.${w}`);
      s.position.set(0, 4);
      s.visible = false;
      sprites.push(s);
      slotRoot.addChild(s);
    }
    const s = pixelSprite(core[0]!, `${label}.core.${i}`);
    s.position.set(0, -2);
    sprites.push(s);
    slotRoot.addChild(s);
    root.addChild(slotRoot);
    slots.push({ root: slotRoot, age: 0, active: false });
  }

  const timing = TIMINGS.spin;
  function paintSlot(slot: CastSlot): void {
    const age = slot.age;
    const base = slots.indexOf(slot) * 3;
    const blade = sprites[base + 2]!;
    // Eight poses per revolution, matching hero-poses.ts exactly.
    const turn = Math.max(0, Math.min(age, timing.peak) - timing.wind);
    blade.texture = core[Math.floor(turn / 0.0375) % SPIN_FRAMES]!;
    blade.visible = age < timing.fade;
    blade.alpha = age < timing.wind ? 0.35 + 0.65 * age / timing.wind
      : age < timing.peak ? 1 : Math.max(0, (timing.fade - age) / (timing.fade - timing.peak));
    for (let w = 0; w < 2; w++) {
      const wave = sprites[base + w]!;
      const k = (age - SPIN_WAVE_STARTS[w]!) / SPIN_WAVE_SECONDS;
      wave.visible = k >= 0 && k < 1;
      if (!wave.visible) continue;
      wave.texture = waves[Math.min(SPIN_WAVE_FRAMES - 1, Math.floor(k * SPIN_WAVE_FRAMES))]!;
      wave.alpha = (w === 0 ? 0.9 : 1) * Math.min(1, (1 - k) / 0.38);
    }
    slot.root.visible = age < timing.total;
  }

  return { root, slots, owned, paint: paintSlot, disposed: false };
}

function bakeSpinFrame(label: string, frame: number): Texture {
  return pixelTexture(label, SPIN_W, SPIN_H, ctx => {
    const startAngle = frame / SPIN_FRAMES * Math.PI * 2;
    for (let y = 0; y < SPIN_H; y += 2) {
      const py = y - SPIN_H / 2;
      for (let x = 0; x < SPIN_W; x += 2) {
        const px = x - SPIN_W / 2;
        if (!inBand(px, py, 96, 28, 78, 18)) continue;
        // Leave the upper-body keepout hollow even on the rear of the ellipse.
        if (Math.abs(px) < 42 && py - 2 <= -26) continue;
        // Bright leading edge with a tapered tail, plus an opposing thin slash.
        const angle = Math.atan2(py / 28, px / 96);
        const trail = (startAngle - angle + Math.PI * 4) % (Math.PI * 2);
        const opposite = (trail + Math.PI) % (Math.PI * 2);
        const radius = Math.sqrt(ellipseSigned(px, py, 96, 28));
        let color: string;
        if (trail < 0.24) color = radius > 0.96 ? COBALT.light : COBALT.ivory;
        else if (trail < 0.75) color = radius > 0.92 ? COBALT.glow : COBALT.light;
        else if (trail < 1.35) color = COBALT.mid;
        else if (opposite < 0.65 && radius > 0.88) color = COBALT.glow;
        else if (radius > 0.94) color = COBALT.body;
        else continue;
        ctx.fillStyle = color;
        ctx.fillRect(x, y, 2, 2);
      }
    }
  });
}

function bakeSpinWave(label: string, frame: number): Texture {
  return pixelTexture(label, SPIN_WAVE_W, SPIN_WAVE_H, ctx => {
    const k = frame / (SPIN_WAVE_FRAMES - 1);
    const spread = 1 - (1 - k) * (1 - k);
    const rx = 56 + spread * 132;
    const ry = 14 + spread * 32;
    const width = 8 - k * 4;
    const cx = SPIN_WAVE_W / 2;
    const cy = SPIN_WAVE_H / 2;
    for (let y = 0; y < SPIN_WAVE_H; y += 2) {
      const py = y - cy;
      for (let x = 0; x < SPIN_WAVE_W; x += 2) {
        const px = x - cx;
        if (!inBand(px, py, rx, ry, rx - width, ry - 3)) continue;
        if (Math.abs(px) < 42 && py + 4 <= -26) continue;
        const angle = Math.atan2(py / ry, px / rx);
        const segment = Math.floor((angle + Math.PI) * 12 / Math.PI);
        // Break the late wave into dissipating streaks, not a solid disk.
        if (k > 0.5 && (segment + frame) % 4 === 0) continue;
        const outer = ellipseSigned(px, py, rx, ry);
        ctx.fillStyle = outer > 0.96 ? COBALT.glow : outer > 0.90 ? COBALT.light : COBALT.mid;
        ctx.fillRect(x, y, 2, 2);
      }
    }
    // Deterministic radial sparks: stretched along the floor, safely below the head.
    for (let i = 0; i < 12; i++) {
      const angle = i * Math.PI / 6 + 0.16;
      const sx = pixel(cx + (rx + 4 + k * 6) * Math.cos(angle));
      const sy = pixel(cy + (ry + 2) * Math.sin(angle));
      if (Math.abs(sx - cx) < 48 && sy - cy + 4 < -20) continue;
      const size = frame < 8 ? 4 : 2;
      ctx.fillStyle = COBALT.mid;
      ctx.fillRect(sx - pixel(Math.cos(angle) * 8), sy - pixel(Math.sin(angle) * 4), size, 2);
      ctx.fillStyle = COBALT.ivory;
      ctx.fillRect(sx, sy, size, 2);
      if ((i + frame) % 3 === 0 && frame < 9) {
        ctx.fillRect(sx + 2, sy - 2, 2, 6);
        ctx.fillRect(sx, sy, 6, 2);
      }
    }
  });
}

// ---------- DASH -------------------------------------------------------
//
// 220x50 rearward speed / afterimage streak. Center localX = -110
// so the streak sits BEHIND the caster; upper bound Y = -33 keeps
// the face clear. Three baked length frames show a quick start and
// a tapered tail; ivory dust puffs sit near the feet.

const DASH_W = 220;
const DASH_H = 50;
const DASH_FRAMES = 3;

function makeDash(): AttackState {
  const label = `attack-dash-pixel`;
  const textures: Texture[] = [];
  for (let f = 0; f < DASH_FRAMES; f++) textures.push(bakeDashFrame(`${label}.len.${f}`, f));
  const owned = textures;
  const sprites: Sprite[] = [];

  const slots: CastSlot[] = [];
  const root = new Container({ label });
  root.visible = false;

  for (let i = 0; i < POOL; i++) {
    const slotRoot = buildSlotRoot(label, i);
    slotRoot.visible = false;
    const locals: Sprite[] = [];
    for (let f = 0; f < DASH_FRAMES; f++) {
      const s = pixelSprite(textures[f]!, `${label}.len.${i}.${f}`);
      locals.push(s);
      slotRoot.addChild(s);
    }
    root.addChild(slotRoot);
    slots.push({ root: slotRoot, age: 0, active: false });
    sprites.push(...locals);
  }

  const baseX = -110;
  const baseY = -8;
  const timing = TIMINGS.dash;

  function paintSlot(slot: CastSlot): void {
    const age = slot.age;
    const base = slots.indexOf(slot);
    if (age < timing.wind) {
      for (let f = 0; f < DASH_FRAMES; f++) {
        const s = sprites[base * DASH_FRAMES + f]!;
        s.position.set(pixel(baseX), pixel(baseY));
        s.visible = f === 0;
        s.alpha = 0.5;
      }
    } else if (age < timing.peak) {
      const k = (age - timing.wind) / (timing.peak - timing.wind);
      const activeFrame = Math.min(DASH_FRAMES - 1, Math.floor(k * DASH_FRAMES));
      for (let f = 0; f < DASH_FRAMES; f++) {
        const s = sprites[base * DASH_FRAMES + f]!;
        s.position.set(pixel(baseX), pixel(baseY));
        s.visible = f === activeFrame;
        s.alpha = 1;
      }
    } else {
      const k = (age - timing.peak) / (timing.fade - timing.peak);
      for (let f = 0; f < DASH_FRAMES; f++) {
        const s = sprites[base * DASH_FRAMES + f]!;
        s.position.set(pixel(baseX), pixel(baseY));
        s.visible = f === DASH_FRAMES - 1;
        s.alpha = 1 - k;
      }
    }
    slot.root.visible = age < timing.total;
  }

  return { root, slots, owned, paint: paintSlot, disposed: false };
}

function bakeDashFrame(label: string, frame: number): Texture {
  // Heads sit just behind the caster (texture x 196 = local -24); frames extend the trail
  // rearward. A tapered energy wake (solid near the head, checker-dithered toward the tail)
  // carries the speed lines; dust clouds puff up behind the feet as the dash grows.
  const head = 196;
  const limit = (frame + 1) / DASH_FRAMES;
  const wake = Math.floor((190 * limit) / 2) * 2;
  const lines = [
    { y: 8, len: 120, offset: 10, thick: 2 },
    { y: 14, len: 180, offset: 4, thick: 4 },
    { y: 20, len: 196, offset: 0, thick: 4 },
    { y: 26, len: 170, offset: 2, thick: 4 },
    { y: 32, len: 110, offset: 8, thick: 2 },
  ];
  const clouds = [
    { x: 178, y: 40, rx: 14, ry: 8 },
    { x: 150, y: 42, rx: 10, ry: 6 },
    { x: 124, y: 42, rx: 8, ry: 4 },
  ];
  return pixelTexture(label, DASH_W, DASH_H, ctx => {
    for (let x = head - wake; x < head; x += 2) {
      const d = (head - x) / 190;
      const half = Math.floor((14 * (1 - d) + 4) / 2) * 2;
      for (let y = 22 - half; y < 22 + half; y += 2) {
        if (d > 0.35 && ((x + y) / 2) % 2 === 1) continue;
        ctx.fillStyle = Math.abs(y + 1 - 22) > half - 3 ? COBALT.deep : COBALT.body;
        ctx.fillRect(x, y, 2, 2);
      }
    }
    for (const line of lines) {
      const end = head - line.offset;
      const len = Math.floor((line.len * limit) / 2) * 2;
      for (let x = end - len; x < end; x += 2) {
        const d = (end - x) / line.len;
        let color: string;
        if (d < 0.1) color = COBALT.white;
        else if (d < 0.25) color = COBALT.ivory;
        else if (d < 0.45) color = COBALT.glow;
        else if (d < 0.7) color = COBALT.light;
        else color = COBALT.mid;
        ctx.fillStyle = color;
        ctx.fillRect(x, line.y, 2, line.thick);
      }
    }
    for (let i = 0; i <= frame && i < clouds.length; i++) {
      const cloud = clouds[i]!;
      for (let y = cloud.y - cloud.ry; y < cloud.y + cloud.ry; y += 2) {
        for (let x = cloud.x - cloud.rx; x < cloud.x + cloud.rx; x += 2) {
          if (ellipseSigned(x + 1 - cloud.x, y + 1 - cloud.y, cloud.rx, cloud.ry) > 1) continue;
          ctx.fillStyle = y < cloud.y - 2 ? COBALT.ivory : y < cloud.y + cloud.ry - 2 ? COBALT.dust : COBALT.stoneL;
          ctx.fillRect(x, y, 2, 2);
        }
      }
    }
  });
}

// ---------- GROUND -----------------------------------------------------
//
// Four pointed-up crystalline pillars (32x128) anchored at floor Y=0, forward at
// x=68/108/148/188, rising tip-first through four baked height frames. A 180x36 stepped
// elliptical shockwave sits centered at (120, 2).

const GROUND_PILLARS = 4;
const GROUND_PILLAR_X = [68, 108, 148, 188];
// Highest frame per pillar: outer pillars stay shorter so the strike reads as a travelling wave.
const GROUND_PILLAR_MAX = [3, 3, 2, 1];
const GROUND_PILLAR_FRAMES = 4;
const PILLAR_W = 32;
const PILLAR_H = 128;
const GROUND_DEBRIS = 6;

function makeGround(): AttackState {
  const label = `attack-ground-pixel`;
  const textures: Texture[] = [];
  for (let f = 0; f < GROUND_PILLAR_FRAMES; f++) textures.push(bakePillar(`${label}.height.${f}`, f));
  const shockTexture = bakeShockwave(`${label}.shock`);
  const debrisTexture = bakeDebris(`${label}.debris`);
  const owned: Texture[] = [...textures, shockTexture, debrisTexture];
  const pillarSprites: Sprite[][] = [];
  const shockSprites: Sprite[] = [];
  const debrisSprites: Sprite[][] = [];

  const slots: CastSlot[] = [];
  const root = new Container({ label });
  root.visible = false;

  for (let i = 0; i < POOL; i++) {
    const slotRoot = buildSlotRoot(label, i);
    slotRoot.visible = false;
    const pillars: Sprite[] = [];
    for (let j = 0; j < GROUND_PILLARS; j++) {
      for (let f = 0; f < GROUND_PILLAR_FRAMES; f++) {
        const s = pixelSprite(textures[f]!, `${label}.height.${i}.${j}.${f}`);
        s.anchor.set(0.5, 1);
        pillars.push(s);
        slotRoot.addChild(s);
      }
    }
    pillarSprites.push(pillars);
    const shock = pixelSprite(shockTexture, `${label}.shock.${i}`);
    shock.anchor.set(0.5, 0.5);
    slotRoot.addChild(shock);
    shockSprites.push(shock);
    const debris: Sprite[] = [];
    for (let j = 0; j < GROUND_DEBRIS; j++) {
      const s = pixelSprite(debrisTexture, `${label}.debris.${i}.${j}`);
      debris.push(s);
      slotRoot.addChild(s);
    }
    debrisSprites.push(debris);
    root.addChild(slotRoot);
    slots.push({ root: slotRoot, age: 0, active: false });
  }

  const timing = TIMINGS.ground;
  const shockCX = 120;
  const shockCY = 2;

  function paintSlot(slot: CastSlot): void {
    const age = slot.age;
    const base = slots.indexOf(slot);
    const pillars = pillarSprites[base]!;
    const shock = shockSprites[base]!;
    const debris = debrisSprites[base]!;

    if (age < timing.wind) {
      for (const s of pillars) s.visible = false;
      shock.visible = true;
      shock.position.set(pixel(shockCX), pixel(shockCY));
      shock.alpha = 0.4 * (age / timing.wind);
    } else if (age < timing.peak) {
      const k = (age - timing.wind) / (timing.peak - timing.wind);
      for (let j = 0; j < GROUND_PILLARS; j++) {
        const frame = Math.min(GROUND_PILLAR_MAX[j]!, Math.floor(k * (GROUND_PILLAR_FRAMES + 1.5) - j * 0.5));
        for (let f = 0; f < GROUND_PILLAR_FRAMES; f++) {
          const s = pillars[j * GROUND_PILLAR_FRAMES + f]!;
          s.position.set(pixel(GROUND_PILLAR_X[j]!), pixel(FLOOR_Y));
          s.visible = f === frame;
          s.alpha = 1;
        }
      }
      shock.visible = true;
      shock.position.set(pixel(shockCX), pixel(shockCY));
      shock.alpha = 1 - k * 0.4;
    } else {
      const k = (age - timing.peak) / (timing.fade - timing.peak);
      for (let j = 0; j < GROUND_PILLARS; j++) {
        for (let f = 0; f < GROUND_PILLAR_FRAMES; f++) {
          const s = pillars[j * GROUND_PILLAR_FRAMES + f]!;
          s.position.set(pixel(GROUND_PILLAR_X[j]!), pixel(FLOOR_Y));
          s.visible = f === GROUND_PILLAR_MAX[j] && k < 0.8;
          s.alpha = 1 - k / 0.8;
        }
      }
      shock.visible = k < 0.7;
      shock.position.set(pixel(shockCX), pixel(shockCY));
      shock.alpha = (1 - k) * 0.6;
    }
    // Debris derives from absolute age in every phase so skipped phases land correctly.
    const strike = (age - timing.wind) / (timing.peak - timing.wind);
    const fadeK = Math.max(0, (age - timing.peak) / (timing.fade - timing.peak));
    for (let j = 0; j < GROUND_DEBRIS; j++) {
      const d = debris[j]!;
      const t = strike - 0.1 - j * 0.04;
      d.visible = t >= 0 && t < 0.7 && fadeK < 0.9;
      if (!d.visible) continue;
      const angle = (j / GROUND_DEBRIS) * Math.PI - Math.PI / 2;
      const radius = t * 56;
      d.position.set(
        pixel(GROUND_PILLAR_X[1]! + Math.cos(angle) * radius),
        pixel(FLOOR_Y - Math.sin(angle) * radius * 0.7 + 30 * t * t),
      );
      d.alpha = (1 - t / 0.7) * (1 - fadeK);
    }
    slot.root.visible = age < timing.total;
  }

  return { root, slots, owned, paint: paintSlot, disposed: false };
}

function bakePillar(label: string, frame: number): Texture {
  // Frame f shows the top (f+1)/GROUND_PILLAR_FRAMES of the crystal seated on the floor, so the
  // tip breaks ground first and the pillar rises without vertical scaling.
  const visible = ((frame + 1) * PILLAR_H) / GROUND_PILLAR_FRAMES;
  const drop = PILLAR_H - visible;
  const center = PILLAR_W / 2;
  return pixelTexture(label, PILLAR_W, PILLAR_H, ctx => {
    for (let row = 0; row < visible; row += 2) {
      const half = 2 + 2 * Math.floor((row / PILLAR_H) * 6.5);
      for (let x = center - half; x < center + half; x += 2) {
        const fromEdge = Math.min(x - (center - half), center + half - 2 - x);
        const left = x < center;
        let color: string = left ? COBALT.light : COBALT.mid;
        if (fromEdge === 0) color = COBALT.edge;
        else if (fromEdge === 2) color = left ? COBALT.glow : COBALT.body;
        if (x === center - 2) color = row < 24 ? COBALT.white : COBALT.ivory;
        ctx.fillStyle = color;
        ctx.fillRect(x, row + drop, 2, 2);
      }
    }
  });
}

function bakeShockwave(label: string): Texture {
  return pixelTexture(label, 180, 36, ctx => {
    const cx = 90;
    const cy = 18;
    const outerRx = 86;
    const outerRy = 14;
    const innerRx = 70;
    const innerRy = 6;
    for (let y = 0; y < 36; y += 2) {
      const py = y - cy;
      for (let x = 0; x < 180; x += 2) {
        const px = x - cx;
        if (!inBand(px, py, outerRx, outerRy, innerRx, innerRy)) continue;
        const t = Math.max(0, 1 - ellipseSigned(px, py, outerRx, outerRy));
        const inner = ellipseSigned(px, py, innerRx, innerRy) - 1;
        let color: string;
        if (t < 0.05) color = COBALT.ivory;
        else if (inner < 0.05) color = COBALT.light;
        else if (t < 0.25) color = COBALT.mid;
        else if (t < 0.5) color = COBALT.body;
        else color = COBALT.deep;
        ctx.fillStyle = color;
        ctx.fillRect(x, y, 2, 2);
      }
    }
  });
}

function bakeDebris(label: string): Texture {
  return pixelTexture(label, 8, 8, ctx => {
    ctx.fillStyle = COBALT.stone;
    ctx.fillRect(0, 4, 8, 4);
    ctx.fillStyle = COBALT.stoneL;
    ctx.fillRect(0, 4, 6, 2);
    ctx.fillStyle = COBALT.dust;
    ctx.fillRect(2, 0, 4, 4);
  });
}

// ---------- factory ----------------------------------------------------

export function createAttackVfx(attack: Attack): PixelSkillVfx {
  const built: AttackState = ((): AttackState => {
    switch (attack) {
      case 'slash': return makeSlash();
      case 'combo': return makeCombo();
      case 'thrust': return makeThrust();
      case 'spin': return makeSpin();
      case 'dash': return makeDash();
      case 'ground': return makeGround();
    }
  })();
  const { root, slots, owned } = built;

  function cast(x: number, y: number, facing: number): void {
    if (built.disposed) return;
    let pick = slots[0]!;
    for (const candidate of slots) {
      if (!candidate.active) { pick = candidate; break; }
      if (candidate.age > pick.age) pick = candidate;
    }
    pick.root.position.set(pixel(x), pixel(y));
    pick.root.scale.set(facing < 0 ? -1 : 1, 1);
    pick.age = 0;
    pick.active = true;
    built.paint(pick);
    pick.root.visible = true;
    root.visible = true;
  }

  function update(dt: number): void {
    if (built.disposed || !Number.isFinite(dt) || dt <= 0) return;
    let active = false;
    for (const slot of slots) {
      if (!slot.active) continue;
      slot.age += dt;
      if (slot.age >= TIMINGS[attack].total) {
        slot.active = false;
        slot.root.visible = false;
      } else {
        built.paint(slot);
        active = true;
      }
    }
    root.visible = active;
  }

  function reset(): void {
    if (built.disposed) return;
    for (const slot of slots) {
      slot.active = false;
      slot.age = 0;
      slot.root.visible = false;
      slot.root.scale.set(1, 1);
    }
    root.visible = false;
  }

  function dispose(): void {
    if (built.disposed) return;
    built.disposed = true;
    root.destroy({ children: true });
    for (const tex of owned) tex.destroy(true);
  }

  return { root, cast, update, reset, dispose };
}
