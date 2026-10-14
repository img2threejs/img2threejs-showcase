// Visual effects layer for Greenvale.
//
// Exports `createEffects(): Effects`. The root composes explicit
// semantic sub-containers (`lighting`, `water`, `atmospheric`,
// `weather`, `skills`, `characterFoot`) — each holds only
// effects-owning actors.
//
// This module owns its radial lighting atlas and three pixel skill renderers,
// every Graphics and Sprite it draws, every pooled particle, and the
// PRNG that drives stochastic behavior. It does NOT touch the host
// Application / ticker / renderer, the source artwork, or the
// scene-owned night-grade overlay (main handles darkening).
//
// Determinism:
//   A private Mulberry32 PRNG (seed `0xa3c91f57`) drives the stochastic
//   foot dust so `reset() → replay` of identical state/time produces
//   identical pixel output. Water flow and chimney smoke use no PRNG at
//   all: seeded integer hashing of (slot, cycle) and `state.time` only.
//   No `Math.random` is called.
//
// Capacity:
//   Bounded pools, no per-frame allocation:
//   * lantern pool: 9 Sprites, one per observed source center.
//   * water glints: 11 Sprites per body × 4 bodies = 44 Sprites; homes
//     baked at init; positions deterministically drift via fixed
//     per-glint phase, never call PRNG per frame.
//   * fireflies: 24 Sprites, phase baked at init.
//   * water flow (water-flow.ts): 3 baked 72-frame falls, 42 foam cells,
//     9 baked foam-arc sprites, 40 ripple dashes, 20 fountain droplets
//     (+ trails), 3 baked basin rings — all preallocated, pure functions
//     of `state.time`.
//   * chimney smoke (chimney-smoke.ts): 12 preallocated puff slots over
//     baked 5-step growth frames, pure function of `state.time`.
//   * footfall dust: ≤ 64 pooled Particles.
//   * pixel skills: four preallocated cast slots per elemental renderer.
//
// Lifecycle:
//   * `update(dt, state)` advances owned transient state. `dt < 0` or
//     non-finite is rejected; when `state.paused` or `dt === 0`, no
//     particle ages, no particle emits, no glint home updates —
//     pure deterministic replay.
//   * `cast(skill, x, y, facing)` emits a transient visual. Honors
//     `setEnabled`: when disabled, cast is a no-op (no surprise
//     invisible particles fire on re-enable).
//   * `setEnabled(false)` hides every owned actor and freezes
//     emissions; `setEnabled(true)` restores visibility and resumes
//     ticking. Does NOT reset.
//   * `reset()` zeroes accumulated bookkeeping, re-seeds the PRNG,
//     reinstalls pre-allocated glint / firefly slots in the SAME
//     positions they had at construction, and re-enables effects.
//   * `dispose()` is idempotent — second call is a no-op.

import {
  Container,
  Graphics,
  Particle,
  ParticleContainer,
  Rectangle,
  Sprite,
  Texture,
  TextureSource,
} from 'pixi.js';

import type { Attack, Effects, GameState, Skill } from './types.js';
import { createSkillProjectile } from './skill-projectile.js';
import { createHealVfx } from './heal-vfx.js';
import { createAttackVfx } from './attack-vfx.js';
import { createWaterFlow } from './water-flow.js';
import { createChimneySmoke } from './chimney-smoke.js';

// ---------- constants ---------------------------------------------------

const WIDTH = 1536;
const HEIGHT = 1024;
const ATLAS_SIZE = 128;
const ANCHOR = 0.5;
const PRNG_SEED = 0xa3c91f57;

// Pool caps (finite, over-capacity events recycle least-life slot).
const FOOT_CAP = 64;
const FOOT_INTERVAL_WALK = 0.32;
const FOOT_INTERVAL_RUN = 0.16;
const FOOT_BURST_WALK = 4;
const FOOT_BURST_RUN = 7;

// Lantern radii (source px).
const LANTERN_RADII: readonly number[] = [
  62, 56, 70, 64, 70, 60, 78, 68, 76,
];

const LANTERN_CENTERS: ReadonlyArray<readonly [number, number]> = [
  [150, 335], [310, 330], [635, 600], [706, 733], [885, 890],
  [920, 147], [1420, 823], [614, 15], [814, 18],
];

interface WaterBody {
  readonly name: string;
  readonly drawShape: (g: Graphics) => void;
  readonly glintCount: number;
  readonly glints: ReadonlyArray<readonly [number, number]>;
  readonly period: number;
}

// Water contours traced from source, EXCLUDING bridge, boat hull,
// fountain pedestal / angel statue column. Bridge stonework spans
// y270..395 across x≈990..1240; the right stream is split into two
// vertical bands (y180..270, y395..500). The lower river is split
// into two horizontal bands that flank the source boat hull polygon
// [(520,893),(547,877),(593,869),(655,870),(680,890),(685,907),
// (666,926),(627,938),(579,938),(545,925),(532,914)] — left
// (x100..515) and right (x870..945), y900..970. The wooden dock
// occupies x710..845 through y940; both dock and boat are excluded.
// Fountain highlights follow the visible pool around its stone pedestal.
const WATER_BODIES: readonly WaterBody[] = [
  {
    name: 'waterfall',
    drawShape: (g) => {
      g.poly([1130, 0, 1190, 0, 1215, 200, 1100, 200, 1130, 0]);
    },
    glintCount: 7,
    glints: [
      [1145, 20], [1170, 60], [1160, 100], [1175, 140],
      [1140, 170], [1180, 195], [1158, 215],
    ],
    period: 2.4,
  },
  {
    name: 'stream-right',
    drawShape: (g) => {
      // Two vertical segments to leave the bridge stonework free.
      g.poly([1115, 180, 1145, 180, 1145, 270, 1115, 270, 1115, 180]);
      g.poly([1115, 395, 1145, 395, 1155, 500, 1110, 500, 1115, 395]);
    },
    glintCount: 6,
    glints: [
      [1128, 200], [1138, 230], [1130, 260],
      [1126, 410], [1140, 440], [1132, 480],
    ],
    period: 2.8,
  },
  {
    name: 'lower-river',
    drawShape: (g) => {
      // Source boat occupies x520..686 and dock x710..845.
      g.poly([100, 900, 515, 900, 515, 970, 100, 970, 100, 900]);
      g.poly([870, 900, 945, 900, 945, 970, 870, 970, 870, 900]);
    },
    glintCount: 9,
    glints: [
      // left strip
      [150, 920], [220, 935], [300, 920], [380, 938],
      [460, 922], [250, 955], [400, 960],
      // right strip
      [888, 924], [923, 939],
    ],
    period: 3.6,
  },
  {
    name: 'fountain',
    drawShape: (g) => {
      // Concave pool contour leaves the observed pedestal untouched.
      g.poly([657, 234, 677, 220, 692, 217, 693, 252, 705, 258,
        740, 259, 750, 251, 745, 217, 765, 222, 780, 237,
        775, 254, 750, 267, 677, 261, 657, 247]);
    },
    glintCount: 5,
    glints: [
      [667, 245], [680, 253], [754, 244], [762, 252], [714, 264],
    ],
    period: 1.8,
  },
];


interface FireflyRegion { readonly x0: number; readonly x1: number; readonly y0: number; readonly y1: number; }
const FIREFLY_REGIONS: ReadonlyArray<FireflyRegion> = [
  { x0: 320, x1: 760, y0: 360, y1: 560 },
  { x0: 800, x1: 1080, y0: 420, y1: 660 },
  { x0: 500, x1: 820, y0: 600, y1: 780 },
];

const FIREFLY_COUNT = 24;
const FIREFLY_TWINKLE_PERIOD = 2.8;
const FIREFLY_TWINKLE_AMP = 0.55;
const FIREFLY_WARM_TINT = 0xfff1b0;
const FIREFLY_MIN_SCALE = 0.045;
const FIREFLY_MAX_SCALE = 0.075;

const TINT_WHITE: number = 0xffffff;
const TINT_SPARKLE = 0xe6faff;
const TINT_DUST = 0xe1d3a6;
const TINT_GLOW = 0xffd28a;

const LANTERN_PULSE_PERIOD = 2.4;


// ---------- interfaces -------------------------------------------------

interface ParticleState {
  vx: number; vy: number; ax: number; ay: number;
  life: number; maxLife: number;
  baseScale: number; endScale: number;
  baseAlpha: number; endAlpha: number;
  rotSpeed: number; startRotation: number;
  tint: number;
}

interface SpawnOpts {
  x: number; y: number;
  vx: number; vy: number;
  ax: number; ay: number;
  life: number;
  baseScale: number; endScale: number;
  baseAlpha: number; endAlpha: number;
  rotSpeed: number;
  tint: number;
  texture: Texture;
}

interface GlowAtlas {
  source: TextureSource;
  warm: Texture;
  dust: Texture;
  sparkle: Texture;
  ripple: Texture;
}

interface Pool {
  readonly root: Container;
  readonly container: ParticleContainer;
  readonly pool: Particle[];
  readonly state: ParticleState[];
  readonly cap: number;
  active: number;
  spawn(opts: SpawnOpts): number;
  age(dt: number, onSwap?: (from: number, to: number) => void): void;
  clear(): void;
  update(): void;
}

interface WaterGlint {
  sprite: Sprite;
  phase: number;
  ampX: number;
  ampY: number;
  baseAlpha: number;
  period: number;
}

interface LanternRecord {
  sprite: Sprite;
  baseAlpha: number;
  glowScale: number;
  phase: number;
}

interface FireflyRecord {
  sprite: Sprite;
  baseX: number; baseY: number;
  rx: number; ry: number;
  phaseX: number; phaseY: number;
  speedX: number; speedY: number;
  twinklePhase: number;
  baseScale: number; baseAlpha: number;
}

// ---------- pool ------------------------------------------------------

function createPool(parent: Container, label: string, texture: Texture, cap: number): Pool {
  const root = new Container({ label });
  const container = new ParticleContainer({
    label: `${label}.particles`,
    texture,
    // Sprites in this module mutate position, scale, rotation, tint,
    // and texture PER FRAME, so all four dynamic properties must be
    // marked. Using a Sprite-based approach is the recommendation
    // when textures vary per particle; ParticleContainer is still
    // preferred for static texturing — but here it is correct.
    dynamicProperties: {
      vertex: true,
      position: true,
      rotation: true,
      uvs: true,
      color: true,
    },
    boundsArea: new Rectangle(-WIDTH / 2, -HEIGHT / 2, WIDTH * 2, HEIGHT * 2),
    roundPixels: false,
  });
  root.addChild(container);
  parent.addChild(root);

  const pool: Particle[] = new Array(cap);
  const state: ParticleState[] = new Array(cap);
  for (let i = 0; i < cap; i++) {
    pool[i] = new Particle({
      texture,
      anchorX: ANCHOR,
      anchorY: ANCHOR,
      tint: TINT_WHITE,
      alpha: 0,
    });
    state[i] = {
      vx: 0, vy: 0, ax: 0, ay: 0,
      life: 0, maxLife: 0,
      baseScale: 1, endScale: 1,
      baseAlpha: 0, endAlpha: 0,
      rotSpeed: 0, startRotation: 0,
      tint: TINT_WHITE,
    };
  }

  const p: Pool = {
    root,
    container,
    pool,
    state,
    cap,
    active: 0,
    spawn(opts: SpawnOpts): number {
      let idx: number;
      if (p.active < cap) {
        idx = p.active++;
        p.container.particleChildren.push(p.pool[idx]!);
      } else {
        let minLife = Infinity;
        idx = 0;
        for (let i = 0; i < cap; i++) {
          const life = p.state[i]!.life;
          if (life < minLife) {
            minLife = life;
            idx = i;
          }
        }
      }
      const part = p.pool[idx]!;
      const s = p.state[idx]!;
      s.vx = opts.vx; s.vy = opts.vy;
      s.ax = opts.ax; s.ay = opts.ay;
      s.life = opts.life; s.maxLife = opts.life;
      s.baseScale = opts.baseScale; s.endScale = opts.endScale;
      s.baseAlpha = opts.baseAlpha; s.endAlpha = opts.endAlpha;
      s.rotSpeed = opts.rotSpeed;
      // Seeded rotation via stable per-slot hash so reset → replay is
      // exact (no Math.random).
      s.startRotation = ((idx * 0.6180339887 + s.baseScale * 7.0) % 1) * Math.PI * 2 - Math.PI;
      s.tint = opts.tint;
      part.texture = opts.texture;
      part.x = opts.x;
      part.y = opts.y;
      part.scaleX = opts.baseScale;
      part.scaleY = opts.baseScale;
      part.rotation = s.startRotation;
      part.tint = opts.tint;
      part.alpha = opts.baseAlpha;
      return idx;
    },
    age(dt: number, onSwap?: (from: number, to: number) => void) {
      if (dt <= 0) return;
      for (let i = 0; i < p.active; i++) {
        const s = p.state[i]!;
        s.life -= dt;
        if (s.life <= 0) {
          const lastIdx = p.active - 1;
          if (i !== lastIdx) {
            const lastPart = p.pool[lastIdx]!;
            const lastS = p.state[lastIdx]!;
            const curPart = p.pool[i]!;
            p.pool[i] = lastPart;
            p.pool[lastIdx] = curPart;
            p.state[i] = lastS;
            p.state[lastIdx] = s;
            p.container.particleChildren[i] = lastPart;
            if (onSwap) onSwap(lastIdx, i);
          }
          s.life = 0; s.maxLife = 0;
          p.active--;
          i--;
          continue;
        }
        const part = p.pool[i]!;
        s.vx += s.ax * dt;
        s.vy += s.ay * dt;
        part.x += s.vx * dt;
        part.y += s.vy * dt;
        const tt = 1 - s.life / s.maxLife;
        const scale = s.baseScale + (s.endScale - s.baseScale) * tt;
        part.scaleX = scale;
        part.scaleY = scale;
        part.alpha = s.baseAlpha + (s.endAlpha - s.baseAlpha) * tt;
        part.rotation = s.startRotation + s.rotSpeed * (s.maxLife - s.life);
      }
      p.container.particleChildren.length = p.active;
    },
    clear() {
      for (let i = 0; i < cap; i++) {
        p.state[i]!.life = 0;
        p.state[i]!.maxLife = 0;
        p.pool[i]!.alpha = 0;
      }
      p.active = 0;
      p.container.particleChildren.length = 0;
    },
    update() {
      p.container.update();
    },
  };
  return p;
}

// ---------- factory ----------------------------------------------------

export function createEffects(): Effects {
  const root = new Container({ label: 'greenvale-effects' });
  const characterFoot = new Container({ label: 'greenvale-effects.characterFoot' });
  const lightingRoot = new Container({ label: 'greenvale-effects.lighting' });
  const skillsRoot = new Container({ label: 'greenvale-effects.skills' });
  const atmosphericRoot = new Container({ label: 'greenvale-effects.atmospheric' });
  const waterRoot = new Container({ label: 'greenvale-effects.water' });
  root.addChild(waterRoot, atmosphericRoot, skillsRoot, lightingRoot, characterFoot);

  // ---- atlas: shared radial-glow gradient texture --------------------
  const glow = createGlowAtlas();

  // ---- pools --------------------------------------------------------
  const foot = createPool(characterFoot, 'greenvale-effects.foot', glow.dust, FOOT_CAP);
  const chimney = createChimneySmoke();
  atmosphericRoot.addChild(chimney.root);
  const skills = {
    heal: createHealVfx(),
    ice: createSkillProjectile('ice'),
    fire: createSkillProjectile('fire'),
  };
  skillsRoot.addChild(skills.heal.root, skills.ice.root, skills.fire.root);
  const attacks = {
    slash: createAttackVfx('slash'),
    combo: createAttackVfx('combo'),
    thrust: createAttackVfx('thrust'),
    spin: createAttackVfx('spin'),
    dash: createAttackVfx('dash'),
    ground: createAttackVfx('ground'),
  };
  const attackList = Object.values(attacks);
  skillsRoot.addChild(...attackList.map(vfx => vfx.root));

  // ---- water contour mask ------------------------------------------
  const waterMask = new Graphics({ label: 'greenvale-effects.water.mask' });
  for (const body of WATER_BODIES) body.drawShape(waterMask);
  waterMask.fill({ color: 0xffffff, alpha: 1 });
  waterMask.eventMode = 'none';
  waterRoot.addChild(waterMask);

  // ---- water glints (fixed reusable Sprites, NOT Particles) --------
  // Sprite-based for a static texture with per-frame rotation/scale
  // changes; Pixi's ParticleContainer is optimized for static
  // textures and is inappropriate here. Source-pinned homes with
  // deterministic time drift — no per-frame PRNG.
  const waterContainer = new Container({ label: 'greenvale-effects.water.glints' });
  waterRoot.addChild(waterContainer);
  // The legacy glint contour masks only the glint layer; the flow layer
  // below is confined by its own traced zones.
  waterContainer.mask = waterMask;
  const flow = createWaterFlow();
  waterRoot.addChild(flow.root);
  const waterGlints: WaterGlint[] = [];
  for (const body of WATER_BODIES) {
    for (let i = 0; i < body.glints.length; i++) {
      const [gx, gy] = body.glints[i]!;
      const sprite = new Sprite({
        texture: glow.ripple,
        label: 'greenvale-effects.water.glint',
      });
      sprite.anchor.set(0.5);
      sprite.x = gx;
      sprite.y = gy;
      sprite.tint = TINT_SPARKLE;
      sprite.alpha = 0;
      waterContainer.addChild(sprite);
      waterGlints.push({
        sprite,
        phase: i * 0.91 + body.period * 0.13,
        ampX: 3.0,
        ampY: 1.5,
        baseAlpha: 0.7,
        period: body.period,
      });
    }
  }

  // ---- fireflies ----------------------------------------------------
  const fireflies: FireflyRecord[] = [];
  for (let i = 0; i < FIREFLY_COUNT; i++) {
    const region = FIREFLY_REGIONS[i % FIREFLY_REGIONS.length]!;
    // Deterministic distribution via slot hash (no PRNG consumed).
    const hash1 = Math.sin(i * 12.9898 + region.x0) * 43758.5453;
    const hash2 = Math.sin(i * 78.233 + region.y0) * 43758.5453;
    const ux = (hash1 - Math.floor(hash1));
    const uy = (hash2 - Math.floor(hash2));
    const baseX = region.x0 + ux * (region.x1 - region.x0);
    const baseY = region.y0 + uy * (region.y1 - region.y0);
    const ph1 = ((Math.sin(i * 3.13) * 0.5) % 1 + 1) % 1;
    const ph2 = ((Math.sin(i * 7.91) * 0.5) % 1 + 1) % 1;
    const phT = ((Math.sin(i * 5.71) * 0.5) % 1 + 1) % 1;
    const sp1 = 0.4 + (((i * 0.13) % 1)) * 0.5;
    const sp2 = 0.3 + (((i * 0.27) % 1)) * 0.35;
    const rx = 12 + ((i * 11) % 17) + (((i * 0.07) % 1)) * 11;
    const ry = 8 + ((i * 5) % 11) + (((i * 0.11) % 1)) * 7;
    const baseScale = FIREFLY_MIN_SCALE + (((i * 0.31) % 1)) * (FIREFLY_MAX_SCALE - FIREFLY_MIN_SCALE);
    const baseAlpha = 0.55 + (((i * 0.41) % 1)) * 0.35;
    const sprite = new Sprite({
      texture: glow.sparkle,
      label: 'greenvale-effects.firefly',
    });
    sprite.anchor.set(0.5);
    sprite.x = baseX;
    sprite.y = baseY;
    sprite.tint = FIREFLY_WARM_TINT;
    sprite.alpha = 0;
    atmosphericRoot.addChild(sprite);
    fireflies.push({
      sprite, baseX, baseY,
      rx, ry,
      phaseX: ph1 * Math.PI * 2,
      phaseY: ph2 * Math.PI * 2,
      speedX: sp1,
      speedY: sp2,
      twinklePhase: phT * Math.PI * 2,
      baseScale,
      baseAlpha,
    });
  }

  // ---- lighting -----------------------------------------------------
  const lanterns: LanternRecord[] = [];
  for (let i = 0; i < LANTERN_CENTERS.length; i++) {
    const [lx, ly] = LANTERN_CENTERS[i]!;
    const r = LANTERN_RADII[i]!;
    const sprite = new Sprite({
      texture: glow.warm,
      label: 'greenvale-effects.lantern',
    });
    sprite.anchor.set(0.5);
    sprite.x = lx;
    sprite.y = ly;
    sprite.blendMode = 'add';
    sprite.eventMode = 'none';
    sprite.tint = TINT_GLOW;
    const scale = r / (ATLAS_SIZE / 2);
    sprite.scale.set(scale);
    sprite.alpha = 0.55;
    lightingRoot.addChild(sprite);
    lanterns.push({
      sprite,
      baseAlpha: 0.55,
      glowScale: scale,
      phase: i * 0.7,
    });
  }

  // ---- PRNG ----------------------------------------------------------
  let prng = PRNG_SEED;
  const nextRand = (): number => {
    prng = (prng + 0x6d2b79f5) | 0;
    let t = prng;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // ---- firefly -> sprite lookup table -------------------------------
  // Sprites ARE the records — the array of records already maps 1:1.
  // Helper captures for animation loops:
  const fireflyList = fireflies;
  const glintList = waterGlints;

  // ---- footfall bookkeeping ----------------------------------------
  const footTimer = { value: 0 };

  // ---- bookkeeping -------------------------------------------------
  let enabled = true;
  let disposed = false;

  // ---------- water glint updater (no PRNG, source-fixed) -----------
  function updateWaterGlints(t: number, night: number): void {
    for (let i = 0; i < glintList.length; i++) {
      const g = glintList[i]!;
      const ph = t * (Math.PI * 2 / g.period) + g.phase;
      const twinkle = 0.4 + 0.6 * Math.sin(ph * 1.7);
      const s = 0.12 + 0.07 * twinkle;
      g.sprite.scale.set(s);
      g.sprite.alpha = g.baseAlpha * (0.3 + 0.7 * twinkle) * (0.4 + night * 0.6);
    }
    // Sprites stay at their source-pinned home; visual drift is
    // scale + alpha twinkle only — they can never migrate off the
    // water contour even at maximum twinkle.
    void waterContainer;
  }

  // ---------- firefly updater (no PRNG) -----------------------------
  function updateFireflies(t: number, night: number): void {
    for (let i = 0; i < fireflyList.length; i++) {
      const f = fireflyList[i]!;
      const twinkle = 1 + Math.sin((t * (Math.PI * 2 / FIREFLY_TWINKLE_PERIOD)) + f.twinklePhase) * FIREFLY_TWINKLE_AMP;
      f.sprite.x = f.baseX + Math.sin(t * f.speedX + f.phaseX) * f.rx;
      f.sprite.y = f.baseY + Math.cos(t * f.speedY + f.phaseY) * f.ry;
      const s = f.baseScale * (0.6 + 0.4 * twinkle);
      f.sprite.scale.set(s);
      f.sprite.alpha = f.baseAlpha * Math.max(0.18, night) * twinkle;
    }
  }

  // ---------- footfall dust ------------------------------------------
  function updateFootDust(dt: number, state: GameState): void {
    if (state.gait === 'idle') {
      footTimer.value = 0;
      return;
    }
    footTimer.value += dt;
    const interval = state.gait === 'run' ? FOOT_INTERVAL_RUN : FOOT_INTERVAL_WALK;
    const burst = state.gait === 'run' ? FOOT_BURST_RUN : FOOT_BURST_WALK;
    while (footTimer.value >= interval) {
      footTimer.value -= interval;
      if (foot.active >= FOOT_CAP) break;
      const facing = state.facing >= 0 ? 1 : -1;
      for (let i = 0; i < burst; i++) {
        if (foot.active >= FOOT_CAP) break;
        const ang = -Math.PI / 2 + (nextRand() - 0.5) * 1.5;
        const speed = 35 + nextRand() * 60;
        const vx = Math.cos(ang) * speed * (0.45 + nextRand() * 0.5) * facing +
          (nextRand() - 0.5) * 25;
        const vy = Math.sin(ang) * speed - nextRand() * 25;
        const baseScale = 0.055 + nextRand() * 0.035;
        foot.spawn({
          x: state.x + (nextRand() - 0.5) * 8,
          y: state.y + 14 + (nextRand() - 0.5) * 4,
          vx, vy, ax: 0, ay: 60,
          life: 0.55 + nextRand() * 0.35,
          baseScale,
          endScale: baseScale * (1.6 + nextRand() * 0.7),
          baseAlpha: 0.55 + nextRand() * 0.25,
          endAlpha: 0,
          rotSpeed: (nextRand() - 0.5) * 1.4,
          tint: TINT_DUST,
          texture: glow.dust,
        });
      }
    }
  }


  // ---------- lantern flicker ---------------------------------------
  function updateLanterns(t: number, night: number): void {
    for (let i = 0; i < lanterns.length; i++) {
      const rec = lanterns[i]!;
      const pulse = 1 + Math.sin((t / LANTERN_PULSE_PERIOD) * Math.PI * 2 + rec.phase) * 0.08;
      const finalScale = rec.glowScale * (1 + night * 0.25) * pulse;
      rec.sprite.scale.set(finalScale);
      rec.sprite.alpha = rec.baseAlpha + (1 - rec.baseAlpha) * night * pulse;
    }
  }

  // ---------- public API --------------------------------------------
  function update(dt: number, state: GameState): void {
    if (disposed) return;
    if (!enabled) return;
    if (!Number.isFinite(dt) || dt < 0) return;
    const localDt = state.paused ? 0 : Math.min(dt, 0.05);
    const t = state.time;
    const night = Math.max(0, Math.min(1, state.night));
    skills.heal.root.position.set(state.x, state.y - 30);
    // The dash moves the hero, so its trail rides along with the feet.
    attacks.dash.root.position.set(state.x, state.y);

    // 1) Lantern flicker (deterministic time-driven).
    updateLanterns(t, night);

    // 2) Water glints / fireflies — deterministic, no PRNG.
    updateWaterGlints(t, night);
    updateFireflies(t, night);

    // 3) Flowing water + chimney smoke — pure functions of state.time
    //    (frozen while paused, exact after reset, step-size invariant).
    flow.update(t, night);
    chimney.update(t, night);

    // 4) Footfall dust, skill/attack ageing and particle ageing are gated
    //    on `localDt > 0` (paused / dt=0 => no advance, no emit, no PRNG draw).
    if (localDt > 0) {
      updateFootDust(localDt, state);
      skills.heal.update(localDt);
      skills.ice.update(localDt);
      skills.fire.update(localDt);
      for (const vfx of attackList) vfx.update(localDt);
      foot.age(localDt);
    }

    // 5) Update particle containers.
    foot.update();
  }

  function cast(skill: Skill, x: number, y: number, facing: number): void {
    if (disposed) return;
    if (!enabled) return; // cast is a no-op when disabled — no surprise on re-enable
    skills[skill].cast(x, y, facing);
  }

  function attack(action: Attack, x: number, y: number, facing: number): void {
    if (disposed || !enabled) return;
    if (action === 'dash') attacks.dash.cast(0, 0, facing);
    else attacks[action].cast(x, y, facing);
  }

  function setEnabled(value: boolean): void {
    enabled = value;
    root.visible = value;
  }

  function reset(): void {
    if (disposed) return;
    foot.clear();
    flow.reset();
    chimney.reset();
    skills.heal.reset();
    skills.ice.reset();
    skills.fire.reset();
    for (const vfx of attackList) vfx.reset();
    footTimer.value = 0;
    prng = PRNG_SEED;
    enabled = true;
    root.visible = true;
    for (let i = 0; i < lanterns.length; i++) {
      const rec = lanterns[i]!;
      rec.sprite.alpha = rec.baseAlpha;
      rec.sprite.scale.set(rec.glowScale);
    }
    for (let i = 0; i < fireflyList.length; i++) {
      const f = fireflyList[i]!;
      f.sprite.x = f.baseX;
      f.sprite.y = f.baseY;
      f.sprite.alpha = 0;
    }
    for (let i = 0; i < glintList.length; i++) {
      glintList[i]!.sprite.alpha = 0;
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    foot.clear();
    flow.dispose();
    chimney.dispose();
    skills.heal.dispose();
    skills.ice.dispose();
    skills.fire.dispose();
    for (const vfx of attackList) vfx.dispose();
    root.destroy({ children: true });
    if (!glow.warm.destroyed) glow.warm.destroy(false);
    if (!glow.dust.destroyed) glow.dust.destroy(false);
    if (!glow.sparkle.destroyed) glow.sparkle.destroy(false);
    if (!glow.ripple.destroyed) glow.ripple.destroy(false);
    if (!glow.source.destroyed) glow.source.destroy();
  }

  return {
    root,
    update,
    cast,
    attack,
    setEnabled,
    reset,
    dispose,
  };
}

// ---------- atlas ------------------------------------------------------

function createGlowAtlas(): GlowAtlas {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_SIZE * 3;
  canvas.height = ATLAS_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('greenvale-effects: 2D canvas context unavailable');

  drawRadial(ctx, 0, 0, ATLAS_SIZE, [255, 226, 156]);                 // warm lantern
  drawRadial(ctx, ATLAS_SIZE, 0, ATLAS_SIZE, [225, 211, 166]);     // dust
  drawRadial(ctx, ATLAS_SIZE * 2, 0, ATLAS_SIZE, [230, 250, 255]); // sparkle/ripple

  // CanvasSource auto-derives dimensions/labels from the canvas;
  // explicit labelling keeps debug inspection predictable.
  const source = TextureSource.from({
    resource: canvas,
    width: ATLAS_SIZE * 3,
    height: ATLAS_SIZE,
    label: 'greenvale-effects.glow.source',
  });
  return {
    source,
    warm: new Texture({
      source,
      frame: new Rectangle(0, 0, ATLAS_SIZE, ATLAS_SIZE),
      label: 'greenvale-effects.glow.warm',
    }),
    dust: new Texture({
      source,
      frame: new Rectangle(ATLAS_SIZE, 0, ATLAS_SIZE, ATLAS_SIZE),
      label: 'greenvale-effects.glow.dust',
    }),
    sparkle: new Texture({
      source,
      frame: new Rectangle(ATLAS_SIZE * 2, 0, ATLAS_SIZE, ATLAS_SIZE),
      label: 'greenvale-effects.glow.sparkle',
    }),
    ripple: new Texture({
      source,
      frame: new Rectangle(0, 0, ATLAS_SIZE, ATLAS_SIZE),
      label: 'greenvale-effects.glow.ripple',
    }),
  };
}

function drawRadial(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  cell: number,
  rgb: [number, number, number],
): void {
  const grad = ctx.createRadialGradient(
    ox + cell / 2,
    oy + cell / 2,
    0,
    ox + cell / 2,
    oy + cell / 2,
    cell / 2,
  );
  grad.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},1.0)`);
  grad.addColorStop(0.45, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.55)`);
  grad.addColorStop(0.85, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.12)`);
  grad.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(ox, oy, cell, cell);
}
