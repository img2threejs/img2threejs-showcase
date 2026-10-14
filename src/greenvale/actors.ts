import { Container, Sprite, Texture } from 'pixi.js';
import { pixelGlyph, pixelTexture } from './pixel-skill.js';
import type { ActorAsset, Actors, GameState, Resources } from './types.js';

/**
 * One rigged part. Every part container is a direct child of its actor node so
 * draw order follows the manifest's global `order` (as the asset build composes
 * it); `parent` only chains transforms. `dx/dy/rot` are the local pose about the
 * manifest pivot; `wx/wy/wr` the resolved world pivot position and rotation.
 */
interface PartRt {
  node: Container;
  sprite: Sprite;
  parent: PartRt | null;
  pivotX: number; pivotY: number;
  dx: number; dy: number; rot: number;
  wx: number; wy: number; wr: number;
  xMin: number; xMax: number; yMin: number; yMax: number;
  rMin: number; rMax: number;
  overlay: boolean;
}

// ---- timing constants (all pure functions of world time) ------------------
const GUARD = { phase: 0.5, period: 2.4, step: 0.6, y: [0, 1, 2, 1], spear: [-0.04, 0, 0.04, 0], blinkEvery: 4.3, blinkAt: 1.7 };
const FARMER = {
  phase: 1.1, period: 2.2, step: 0.55, y: [0, 1, 2, 1], waveEvery: 6.5, waveAt: 2.4, waveStep: 0.12,
  wave: [0, -0.9, -1.8, -2.5, -2.1, -2.5, -2.1, -2.5, -1.8, -0.9, 0], blinkEvery: 3.7, blinkAt: 1.3,
};
const MERCHANT = {
  phase: 1.9, period: 2.6, step: 0.65, y: [0, 1, 2, 1], tiltEvery: 5.2, tiltAt: 1.5, tiltHold: 0.8, tilt: 0.05,
  blinkEvery: 3.3, blinkAt: 0.9,
};
const DOG = {
  tailEvery: 3.0, tailAt: 0.6, tailActive: 1.4, tailStep: 0.09, tailWag: 0.35, tailRest: 0.1,
  headEvery: 4.5, headAt: 2.0, headHold: 0.7, headTilt: 0.12, headStep: 0.8, phase: 0.3, blinkEvery: 5.1, blinkAt: 3.0,
};
const SMITH = { cycle: 1.2, impact: 0.86, blinkEvery: 4.7, blinkAt: 2.0, impactFlash: 0.07, impactMinY: 887.5 };
const BOAT = { phase: 0.7, step: 0.4, y: [0, -1, -2, -1, 0, 1, 2, 1], xHold: 2.6, ripplePeriod: 1.6, rippleStagger: 0.8 };
const BLINK_SECONDS = 0.12;
const SPARKS = 14;
const SPARK_GRAVITY = 520;
const EMBERS = 6;
const GLOW_CELLS = 48;

const SPARK_COLORS = ['#ffffff', '#ffe46b', '#ff9a2e', '#d6401f'] as const;
const EMBER_COLORS = ['#ffd36a', '#ff9b3d'] as const;
const RIPPLE_ALPHA = [0.8, 0.55, 0.3] as const;
const STAR_ROWS = [
  '....y....',
  '....y....',
  '.y..W..y.',
  '..y.W.y..',
  'yyWWWWWyy',
  '..y.W.y..',
  '.y..W..y.',
  '....y....',
  '....y....',
];

function mod(value: number, period: number): number {
  return value - Math.floor(value / period) * period;
}

/** Seeded integer hash → [0, 1). Deterministic, allocation-free. */
function hash(a: number, b: number, c: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b + 0x7f4a7c15) | 0, 0xc2b2ae35) ^ Math.imul((c + 0x165667b1) | 0, 0x27d4eb2f);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12; h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function snap(value: number): number {
  return Math.round(value / 2) * 2;
}

function pixelRect(label: string, w: number, h: number, color: string): Texture {
  return pixelTexture(label, w, h, (ctx) => { ctx.fillStyle = color; ctx.fillRect(0, 0, w, h); });
}

/** Pale pixel-ellipse outline on a 2px grid; `rx`/`ry` are half-extents in px. */
function rippleTexture(label: string, rx: number, ry: number): Texture {
  const cols = Math.ceil(rx / 2) * 2 + 2;
  const rows = Math.ceil(ry / 2) * 2 + 2;
  const rxc = rx / 2;
  const ryc = ry / 2;
  const inside = (cx: number, cy: number): boolean => {
    if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return false;
    const dx = (cx + 0.5 - cols / 2) / rxc;
    const dy = (cy + 0.5 - rows / 2) / ryc;
    return dx * dx + dy * dy <= 1;
  };
  return pixelTexture(label, cols * 2, rows * 2, (ctx) => {
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        if (!inside(cx, cy) || (inside(cx - 1, cy) && inside(cx + 1, cy) && inside(cx, cy - 1) && inside(cx, cy + 1))) continue;
        ctx.fillStyle = cy < rows / 2 ? '#e8f8f2' : '#b7dfe2';
        ctx.fillRect(cx * 2, cy * 2, 2, 2);
      }
    }
  });
}

/** Banded (2px cells, stepped alpha) warm glow; no smooth gradient. */
function forgeGlowTexture(): Texture {
  const size = GLOW_CELLS * 2;
  return pixelTexture('greenvale-actors.forge-glow', size, size, (ctx) => {
    const half = GLOW_CELLS / 2;
    for (let cy = 0; cy < GLOW_CELLS; cy++) {
      for (let cx = 0; cx < GLOW_CELLS; cx++) {
        const d = Math.hypot(cx + 0.5 - half, cy + 0.5 - half) / half;
        if (d >= 1) continue;
        const band = Math.floor((1 - d) * 6) / 6;
        const alpha = band * band;
        if (alpha <= 0) continue;
        ctx.fillStyle = `rgba(255,${Math.round(120 + 70 * band)},${Math.round(40 + 40 * band)},${alpha.toFixed(3)})`;
        ctx.fillRect(cx * 2, cy * 2, 2, 2);
      }
    }
  });
}

function buildActor(
  asset: ActorAsset, resources: Resources,
): { node: Container; plate: Container; parts: Map<string, PartRt>; chain: PartRt[] } {
  const label = asset.id === 'boat' ? 'boat' : `npc-${asset.id}`;
  const node = new Container({ label, sortableChildren: true });
  node.eventMode = 'none';
  node.zIndex = asset.id === 'boat' ? -950
    : asset.id === 'blacksmith' ? Math.max(asset.feet.y, SMITH.impactMinY) : asset.feet.y;
  const plate = new Container({ label: `${label}-plate` });
  plate.eventMode = 'none';
  plate.zIndex = -999;
  const plateSprite = new Sprite({ texture: resources.textures[asset.plate.file]!, label: asset.plate.id, roundPixels: true });
  plateSprite.eventMode = 'none';
  plateSprite.position.set(asset.plate.x, asset.plate.y);
  plate.addChild(plateSprite);

  const parts = new Map<string, PartRt>();
  for (const part of asset.parts) {
    const container = new Container({ label: part.id });
    container.eventMode = 'none';
    container.zIndex = part.order;
    const sprite = new Sprite({ texture: resources.textures[part.file]!, label: `${part.id}-sprite`, roundPixels: true });
    sprite.eventMode = 'none';
    sprite.position.set(part.x - part.pivot.x, part.y - part.pivot.y);
    container.addChild(sprite);
    const overlay = part.overlay === true || part.role === 'blink';
    container.visible = !overlay;
    node.addChild(container);
    parts.set(part.role, {
      node: container, sprite, parent: null,
      pivotX: part.pivot.x, pivotY: part.pivot.y,
      dx: 0, dy: 0, rot: 0, wx: part.pivot.x, wy: part.pivot.y, wr: 0,
      xMin: part.offsetRange?.x[0] ?? 0, xMax: part.offsetRange?.x[1] ?? 0,
      yMin: part.offsetRange?.y[0] ?? 0, yMax: part.offsetRange?.y[1] ?? 0,
      rMin: part.rotationRange?.[0] ?? 0, rMax: part.rotationRange?.[1] ?? 0,
      overlay,
    });
  }
  for (const part of asset.parts) {
    if (part.parent !== null) parts.get(part.role)!.parent = parts.get(part.parent)!;
  }
  // Parents before children (resources.ts rejects cycles).
  const depth = (rt: PartRt): number => (rt.parent ? depth(rt.parent) + 1 : 0);
  const chain = [...parts.values()].sort((a, b) => depth(a) - depth(b));
  return { node, plate, parts, chain };
}

/** Local integer offset + rotation about the pivot, clamped to the manifest envelope. */
function pose(part: PartRt, dx: number, dy: number, rotation: number): void {
  part.dx = Math.min(part.xMax, Math.max(part.xMin, Math.round(dx)));
  part.dy = Math.min(part.yMax, Math.max(part.yMin, Math.round(dy)));
  part.rot = Math.min(part.rMax, Math.max(part.rMin, rotation));
}

/** Compose parent transforms down the chain and write each part's world pivot/rotation. */
function resolve(chain: readonly PartRt[]): void {
  for (const part of chain) {
    const parent = part.parent;
    if (parent === null) {
      part.wx = part.pivotX + part.dx;
      part.wy = part.pivotY + part.dy;
      part.wr = part.rot;
    } else {
      const vx = part.pivotX + part.dx - parent.pivotX;
      const vy = part.pivotY + part.dy - parent.pivotY;
      const c = Math.cos(parent.wr);
      const s = Math.sin(parent.wr);
      part.wx = parent.wx + c * vx - s * vy;
      part.wy = parent.wy + s * vx + c * vy;
      part.wr = parent.wr + part.rot;
    }
    part.node.position.set(part.wx, part.wy);
    part.node.rotation = part.wr;
  }
}

function blink(part: PartRt, t: number, every: number, at: number): void {
  part.node.visible = mod(t - at, every) < BLINK_SECONDS;
}

export function createActors(resources: Resources): Actors {
  const nodes: Record<string, Container> = {};
  const plates: Record<string, Container> = {};
  const rigs: Record<string, Map<string, PartRt>> = {};
  const chains: PartRt[][] = [];
  const assets: Record<string, ActorAsset> = {};
  for (const asset of resources.actors.actors) {
    const built = buildActor(asset, resources);
    nodes[asset.id] = built.node;
    plates[asset.id] = built.plate;
    rigs[asset.id] = built.parts;
    chains.push(built.chain);
    assets[asset.id] = asset;
  }
  const part = (actor: string, role: string): PartRt => rigs[actor]!.get(role)!;
  const guardUpper = part('guard', 'upper'); const guardSpear = part('guard', 'spear'); const guardBlink = part('guard', 'blink');
  const farmerUpper = part('farmer', 'upper'); const farmerArm = part('farmer', 'arm'); const farmerBlink = part('farmer', 'blink');
  const merchantHead = part('merchant', 'head'); const merchantBlink = part('merchant', 'blink');
  const dogHead = part('dog', 'head'); const dogTail = part('dog', 'tail'); const dogBlink = part('dog', 'blink');
  const smithUpper = part('blacksmith', 'upper'); const smithArm = part('blacksmith', 'arm'); const smithBlink = part('blacksmith', 'blink');
  const boatHull = part('boat', 'hull');
  const smithAnchors = assets.blacksmith!.anchors!;
  const impactX = smithAnchors.impact!.x; const impactY = smithAnchors.impact!.y;
  const forgeX = smithAnchors.forge!.x; const forgeY = smithAnchors.forge!.y;
  const hullPivot = assets.boat!.parts.find((p) => p.role === 'hull')!.pivot;

  // ---- owned generated textures -----------------------------------------
  const owned: Texture[] = [];
  const own = (texture: Texture): Texture => { owned.push(texture); return texture; };
  const spark = SPARK_COLORS.map((c, i) => own(pixelRect(`greenvale-actors.spark.${i}`, 2, 2, c)));
  const streak = SPARK_COLORS.map((c, i) => own(pixelRect(`greenvale-actors.streak.${i}`, 4, 2, c)));
  const ember = EMBER_COLORS.map((c, i) => own(pixelRect(`greenvale-actors.ember.${i}`, 2, 2, c)));
  const star = own(pixelGlyph('greenvale-actors.star', STAR_ROWS, { W: '#ffffff', y: '#ffe36b' }));
  const glow = own(forgeGlowTexture());
  const hullHalf = assets.boat!.parts.find((p) => p.role === 'hull')!.width / 2;
  const ripple = [0.9, 1.1, 1.3].map((k, i) => {
    const rx = snap(hullHalf * k);
    return own(rippleTexture(`greenvale-actors.ripple.${i}`, rx, Math.max(4, snap(rx * 0.16))));
  });

  // ---- emissive layer (above the night grade) ---------------------------
  const emissive = new Container({ label: 'actors-emissive' });
  emissive.eventMode = 'none';
  emissive.zIndex = 2050;
  const makeSprite = (texture: Texture, label: string, centered: boolean): Sprite => {
    const sprite = new Sprite({ texture, label, roundPixels: true });
    sprite.eventMode = 'none';
    sprite.visible = false;
    if (centered) sprite.anchor.set(0.5);
    emissive.addChild(sprite);
    return sprite;
  };
  const glowSprite = makeSprite(glow, 'forge-glow', true);
  glowSprite.blendMode = 'add';
  glowSprite.position.set(snap(forgeX), snap(forgeY));
  const emberSprites: Sprite[] = [];
  for (let i = 0; i < EMBERS; i++) emberSprites.push(makeSprite(ember[0]!, `forge-ember-${i}`, false));
  const sparkSprites: Sprite[] = [];
  for (let i = 0; i < SPARKS; i++) sparkSprites.push(makeSprite(spark[0]!, `smith-spark-${i}`, false));
  const flash = makeSprite(star, 'smith-impact-flash', true);
  flash.position.set(snap(impactX), snap(impactY));

  // ---- boat ripples ------------------------------------------------------
  const rippleLayer = new Container({ label: 'boat-ripples' });
  rippleLayer.eventMode = 'none';
  rippleLayer.zIndex = -1000;
  const rippleSprites: Sprite[] = [];
  for (let i = 0; i < 2; i++) {
    const sprite = new Sprite({ texture: ripple[0]!, label: `boat-ripple-${i}`, roundPixels: true });
    sprite.eventMode = 'none';
    sprite.anchor.set(0.5);
    sprite.position.set(Math.round(hullPivot.x), Math.round(hullPivot.y));
    rippleLayer.addChild(sprite);
    rippleSprites.push(sprite);
  }
  nodes.boat!.addChild(rippleLayer);

  let enabled = true;
  let disposed = false;

  function renderSparks(t: number): void {
    const k = t >= SMITH.impact ? Math.floor((t - SMITH.impact) / SMITH.cycle) : -1;
    const age = k < 0 ? Infinity : t - (k * SMITH.cycle + SMITH.impact);
    flash.visible = age < SMITH.impactFlash;
    for (let i = 0; i < SPARKS; i++) {
      const sprite = sparkSprites[i]!;
      const life = 0.3 + 0.2 * hash(k, i, 3);
      if (age >= life) { sprite.visible = false; continue; }
      const angle = -Math.PI / 2 + (hash(k, i, 1) * 2 - 1) * 1.2;
      const speed = 90 + 130 * hash(k, i, 2);
      const x = impactX + Math.cos(angle) * speed * age;
      const y = impactY + Math.sin(angle) * speed * age + 0.5 * SPARK_GRAVITY * age * age;
      const f = age / life;
      const tone = f < 0.25 ? 0 : f < 0.5 ? 1 : f < 0.75 ? 2 : 3;
      const long = i % 5 === 0;
      sprite.texture = (long ? streak : spark)[tone]!;
      sprite.position.set(snap(x) - (long ? 2 : 1), snap(y) - 1);
      sprite.visible = true;
    }
  }

  function renderForge(t: number, night: number): void {
    const s = Math.floor(t / 0.1) * 0.1;
    const flicker = (Math.sin(s * 7.3) + 0.6 * Math.sin(s * 13.1 + 1.7) + 0.3 * Math.sin(s * 29.7 + 0.4)) / 1.9 * 0.5 + 0.5;
    glowSprite.alpha = Math.min(1, (0.2 + 0.18 * flicker) * (1 + 2.2 * Math.min(1, Math.max(0, night))));
    glowSprite.visible = true;
    for (let i = 0; i < EMBERS; i++) {
      const sprite = emberSprites[i]!;
      const period = 1.3 + 0.5 * hash(i, 0, 7);
      const progress = t / period + i / EMBERS;
      const cycle = Math.floor(progress);
      const phase = progress - cycle;
      const rise = (30 + 20 * hash(i, 0, 8)) * phase;
      const sway = (Math.floor(phase * 5) % 3 - 1) * 2;
      sprite.texture = ember[phase < 0.5 ? 0 : 1]!;
      sprite.position.set(snap(forgeX + (hash(cycle, i, 9) * 2 - 1) * 10) + sway, snap(forgeY - rise));
      sprite.alpha = 1 - phase * phase;
      sprite.visible = true;
    }
  }

  function renderRipples(t: number): void {
    for (let i = 0; i < 2; i++) {
      const age = mod(t + i * BOAT.rippleStagger, BOAT.ripplePeriod);
      const frame = Math.min(2, Math.floor(age / BOAT.ripplePeriod * 3));
      const sprite = rippleSprites[i]!;
      sprite.texture = ripple[frame]!;
      sprite.alpha = RIPPLE_ALPHA[frame]! * (1 - age / BOAT.ripplePeriod * 0.5);
    }
  }

  function render(t: number, night: number): void {
    // guard
    const gs = Math.min(3, Math.floor(mod(t + GUARD.phase, GUARD.period) / GUARD.step));
    pose(guardUpper, 0, GUARD.y[gs]!, 0);
    pose(guardSpear, 0, 0, GUARD.spear[gs]!);
    blink(guardBlink, t, GUARD.blinkEvery, GUARD.blinkAt);
    // farmer
    pose(farmerUpper, 0, FARMER.y[Math.min(3, Math.floor(mod(t + FARMER.phase, FARMER.period) / FARMER.step))]!, 0);
    const wave = mod(t - FARMER.waveAt, FARMER.waveEvery);
    pose(farmerArm, 0, 0, wave < FARMER.wave.length * FARMER.waveStep
      ? FARMER.wave[Math.min(FARMER.wave.length - 1, Math.floor(wave / FARMER.waveStep))]! : 0);
    blink(farmerBlink, t, FARMER.blinkEvery, FARMER.blinkAt);
    // merchant
    const tilt = mod(t - MERCHANT.tiltAt, MERCHANT.tiltEvery);
    pose(merchantHead, 0, MERCHANT.y[Math.min(3, Math.floor(mod(t + MERCHANT.phase, MERCHANT.period) / MERCHANT.step))]!,
      tilt < MERCHANT.tiltHold ? -MERCHANT.tilt : tilt < MERCHANT.tiltHold * 2 ? MERCHANT.tilt : 0);
    blink(merchantBlink, t, MERCHANT.blinkEvery, MERCHANT.blinkAt);
    // dog
    const tail = mod(t - DOG.tailAt, DOG.tailEvery);
    pose(dogTail, 0, 0, tail < DOG.tailActive
      ? (Math.floor(tail / DOG.tailStep) % 2 === 0 ? DOG.tailWag : -DOG.tailWag) : DOG.tailRest);
    pose(dogHead, 0, Math.floor((t + DOG.phase) / DOG.headStep) % 2,
      mod(t - DOG.headAt, DOG.headEvery) < DOG.headHold ? DOG.headTilt : 0);
    blink(dogBlink, t, DOG.blinkEvery, DOG.blinkAt);
    // blacksmith
    const c = mod(t, SMITH.cycle);
    const r = Math.max(0, smithArm.rMax);
    const swing = c < 0.12 ? 0.25 : c < 0.3 ? 0.6 : c < 0.7 ? 1 : c < 0.8 ? 0.55 : c < SMITH.impact ? 0.15 : 0;
    pose(smithArm, 0, 0, swing * r);
    pose(smithUpper, 0, c >= SMITH.impact && c < 1.0 ? 2 : c >= 1.0 && c < 1.08 ? 1 : 0, 0);
    blink(smithBlink, t, SMITH.blinkEvery, SMITH.blinkAt);
    // boat
    pose(boatHull, mod(t, BOAT.xHold * 2) < BOAT.xHold ? 0 : 1,
      BOAT.y[Math.min(7, Math.floor(mod(t + BOAT.phase, BOAT.step * 8) / BOAT.step))]!, 0);
    for (const chain of chains) resolve(chain);
    if (enabled) {
      renderSparks(t);
      renderForge(t, night);
      renderRipples(t);
    }
  }

  function apply(): void {
    emissive.visible = enabled;
    rippleLayer.visible = enabled;
  }

  render(0, 0);
  return {
    nodes, plates, emissive,
    update(state: GameState) {
      if (disposed) return;
      render(state.time, state.night);
    },
    setEnabled(value: boolean) {
      if (disposed) return;
      enabled = value;
      apply();
    },
    reset() {
      if (disposed) return;
      enabled = true;
      apply();
      render(0, 0);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const id of Object.keys(nodes)) {
        nodes[id]!.destroy({ children: true, texture: false, textureSource: false });
        plates[id]!.destroy({ children: true, texture: false, textureSource: false });
      }
      emissive.destroy({ children: true, texture: false, textureSource: false });
      for (const texture of owned) texture.destroy(true);
      owned.length = 0;
    },
  };
}
