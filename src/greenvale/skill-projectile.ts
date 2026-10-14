import { Container, type Sprite } from 'pixi.js';
import type { Skill } from './types.js';
import { pixel, pixelGlyph, pixelSprite, pixelTexture, type PixelSkillVfx } from './pixel-skill.js';

// Native pixels, seconds. World-anchored visual projectiles, not combat simulation.
const LAUNCH_X = 80;
const RANGE = 560;
const SPEED = 700;
const CHARGE = 0.08;
const FLIGHT_END = CHARGE + RANGE / SPEED;
const FADE = 0.32;
const LAUNCH_BURST_DUR = 0.08;
const LAUNCH_FRAMES = 4;
const SPREAD_DUR = 0.32;
const SPREAD_STARTS = [CHARGE, CHARGE + 0.12] as const;
const SPREAD_FRAMES = 6;
const SPREAD_W = 128;
const SPREAD_H = 48;
const FLOOR = 30; // The cast origin is the chest, 30px above the feet.
const TRAILS = 8;
const FRAGMENTS = 12;
const PALETTES = {
  ice: { edge: '#24468f', body: '#4cbeef', light: '#a4eaff', core: '#f2fbff' },
  fire: { edge: '#8d241f', body: '#f34d29', light: '#ffb63d', core: '#fff8d0' },
} as const;

interface CastSlot {
  root: Container;
  age: number;
  active: boolean;
  projectile: Sprite;
  charge: Sprite;
  trail: Sprite[];
  burst: Sprite;
  fragments: Sprite[];
  burstLaunch: Sprite;
  spread: Sprite[];
}

export function createSkillProjectile(skill: Exclude<Skill, 'heal'>): PixelSkillVfx {
  const palette = PALETTES[skill];
  const label = `skill-${skill}-pixel`;
  const root = new Container({ label });
  root.visible = false;
  let disposed = false;

  // Two-pixel stepped geometry, baked per factory. No rotating/resampled glyphs.
  const projectileTexture = pixelTexture(`${label}.projectile`, 80, 76, ctx => {
    for (let y = -38; y < 38; y += 2) {
      for (let x = -40; x < 40; x += 2) {
        const px = x + 1;
        const py = y + 1;
        let color: string;
        if (skill === 'ice') {
          const head = px >= 5 && px <= 36 && Math.abs(py) <= (36 - px) * 0.6;
          const shaft = px >= -30 && px <= 12 && Math.abs(py) <= 3;
          const feather = px >= -36 && px <= -20 && Math.abs(py) <= 11
            && Math.abs(py) >= Math.abs(px + 27) * 0.65;
          if (!head && !shaft && !feather) continue;
          color = Math.abs(py) < 2 ? palette.core
            : py < 0 ? palette.light : Math.abs(py) < 7 ? palette.body : palette.edge;
        } else {
          const outer = (px * px) / (27 * 27) + (py * py) / (35 * 35);
          const inner = ((px + 13) * (px + 13)) / (27 * 27) + (py * py) / (30 * 30);
          if (outer > 1 || inner < 1) continue;
          color = outer > 0.9 ? palette.edge
            : inner < 1.22 ? palette.core : outer > 0.73 ? palette.light : palette.body;
        }
        ctx.fillStyle = color;
        ctx.fillRect(x + 40, y + 38, 2, 2);
      }
    }
  });
  const trailTexture = pixelTexture(`${label}.trail`, 32, 10, ctx => {
    ctx.fillStyle = palette.edge;
    ctx.fillRect(10, 2, 22, 6);
    ctx.fillStyle = palette.body;
    ctx.fillRect(4, 4, 28, 4);
    ctx.fillStyle = palette.light;
    ctx.fillRect(0, 4, 32, 2);
    ctx.fillStyle = palette.core;
    ctx.fillRect(20, 4, 12, 2);
  });
  const sparkleTexture = pixelGlyph(`${label}.fragment`, [
    '..l..', '..c..', 'lccll', '..c..', '..l..',
  ], { l: palette.light, c: palette.core });
  const chargeTexture = pixelGlyph(`${label}.charge`, [
    '....l....', '....c....', '..l.c.l..', '...bcb...', 'lccccccll',
    '...bcb...', '..l.c.l..', '....c....', '....l....',
  ], { l: palette.light, c: palette.core, b: palette.body });
  const burstTexture = pixelTexture(`${label}.burst`, 64, 64, ctx => {
    for (let y = -32; y < 32; y += 2) {
      for (let x = -32; x < 32; x += 2) {
        const r = Math.abs(x) + Math.abs(y);
        if (r > 34 || (Math.abs(x) > 9 && Math.abs(y) > 9 && r > 24)) continue;
        ctx.fillStyle = r < 10 ? palette.core : r < 22 ? palette.light : palette.body;
        ctx.fillRect(x + 32, y + 32, 2, 2);
      }
    }
  });
  const launchBurstTextures = Array.from({ length: LAUNCH_FRAMES }, (_, frame) =>
    pixelTexture(`${label}.launch.${frame}`, 64, 64, ctx => {
      const radius = 15 + 15 * frame / (LAUNCH_FRAMES - 1);
      for (let y = -32; y < 32; y += 2) {
        for (let x = -32; x < 32; x += 2) {
          const r = Math.abs(x + 1) + Math.abs(y + 1);
          if (r > radius) continue;
          ctx.fillStyle = r < radius * 0.27 ? palette.core
            : r < radius * 0.6 ? palette.light : palette.body;
          ctx.fillRect(x + 32, y + 32, 2, 2);
        }
      }
    }));
  // Expansion is baked on the native 2px grid, never scaled at runtime.
  const spreadTextures = Array.from({ length: SPREAD_FRAMES }, (_, frame) =>
    pixelTexture(`${label}.spread.frame.${frame}`, SPREAD_W, SPREAD_H, ctx => {
      const size = 0.35 + 0.65 * frame / (SPREAD_FRAMES - 1);
      for (let y = 0; y < SPREAD_H; y += 2) {
        for (let x = 0; x < SPREAD_W; x += 2) {
          const nx = (x + 1 - SPREAD_W / 2) / (SPREAD_W / 2 * size);
          const ny = (y + 1 - SPREAD_H / 2) / (SPREAD_H / 2 * size);
          const d = nx * nx + ny * ny;
          if (d < 0.65 || d > 1) continue;
          ctx.fillStyle = d > 0.88 ? palette.body : d > 0.76 ? palette.light : palette.core;
          ctx.fillRect(x, y, 2, 2);
        }
      }
    }));
  const textures = [
    projectileTexture, trailTexture, sparkleTexture, chargeTexture, burstTexture,
    ...launchBurstTextures, ...spreadTextures,
  ];
  const paths = Array.from({ length: FRAGMENTS }, (_, i) => {
    const angle = (i / FRAGMENTS) * Math.PI * 2;
    return { vx: Math.cos(angle) * (100 + (i % 3) * 30), vy: Math.sin(angle) * 120, delay: (i % 3) * 0.015 };
  });
  const slots: CastSlot[] = [];
  for (let i = 0; i < 4; i++) {
    const slotRoot = new Container({ label: `${label}.slot.${i}` });
    slotRoot.visible = false;
    const trail: Sprite[] = [];
    for (let j = 0; j < TRAILS; j++) {
      const sprite = pixelSprite(trailTexture, `${label}.trail.${j}`);
      trail.push(sprite);
      slotRoot.addChild(sprite);
    }
    const charge = pixelSprite(chargeTexture, `${label}.charge`);
    const projectile = pixelSprite(projectileTexture, `${label}.projectile`);
    const burst = pixelSprite(burstTexture, `${label}.burst`);
    const burstLaunch = pixelSprite(launchBurstTextures[0]!, `${label}.launch`);
    const spread = SPREAD_STARTS.map((_, w) => pixelSprite(spreadTextures[0]!, `${label}.spread.${w}`));
    const fragments: Sprite[] = [];
    slotRoot.addChild(charge, projectile, burst, burstLaunch, ...spread);
    for (let j = 0; j < FRAGMENTS; j++) {
      const sprite = pixelSprite(sparkleTexture, `${label}.fragment.${j}`);
      fragments.push(sprite);
      slotRoot.addChild(sprite);
    }
    root.addChild(slotRoot);
    slots.push({
      root: slotRoot, age: 0, active: false, projectile, charge, trail, burst, burstLaunch, spread, fragments,
    });
  }

  function paint(slot: CastSlot): void {
    const age = slot.age;
    const flying = age >= CHARGE && age < FLIGHT_END;
    const distance = Math.min(RANGE, Math.max(0, (age - CHARGE) * SPEED));
    const headX = LAUNCH_X + distance;
    slot.charge.visible = age < CHARGE;
    slot.charge.position.set(44, -8);
    slot.charge.alpha = 1;
    slot.projectile.visible = flying;
    slot.projectile.position.set(pixel(headX), -8);
    slot.projectile.alpha = 1;
    for (let i = 0; i < TRAILS; i++) {
      const trail = slot.trail[i]!;
      const lag = (i + 1) * 16;
      trail.visible = age >= CHARGE && age < FLIGHT_END + 0.08 && distance >= lag + 16;
      trail.position.set(pixel(headX - lag), pixel(-8 + (i % 2 ? 2 : -2)));
      trail.alpha = (1 - i / TRAILS) * 0.55 * Math.max(0, 1 - Math.max(0, age - FLIGHT_END) / 0.08);
    }
    const tailAge = age - FLIGHT_END;
    slot.burst.visible = tailAge >= 0 && tailAge < 0.2;
    slot.burst.position.set(LAUNCH_X + RANGE, -8);
    slot.burst.alpha = Math.max(0, 1 - tailAge / 0.2);
    const launchT = age / LAUNCH_BURST_DUR;
    slot.burstLaunch.visible = age >= 0 && age < LAUNCH_BURST_DUR;
    slot.burstLaunch.position.set(LAUNCH_X, -8);
    slot.burstLaunch.texture = launchBurstTextures[Math.min(LAUNCH_FRAMES - 1, Math.floor(launchT * LAUNCH_FRAMES))]!;
    slot.burstLaunch.alpha = Math.max(0, 1 - launchT);
    for (let w = 0; w < slot.spread.length; w++) {
      const ring = slot.spread[w]!;
      const spreadT = (age - SPREAD_STARTS[w]!) / (CHARGE + SPREAD_DUR - SPREAD_STARTS[w]!);
      ring.visible = spreadT >= 0 && spreadT < 1;
      ring.position.set(LAUNCH_X, FLOOR);
      if (!ring.visible) continue;
      ring.texture = spreadTextures[Math.min(SPREAD_FRAMES - 1, Math.floor(spreadT * SPREAD_FRAMES))]!;
      ring.alpha = 1 - spreadT;
    }
    for (let i = 0; i < FRAGMENTS; i++) {
      const fragment = slot.fragments[i]!;
      const path = paths[i]!;
      const t = tailAge - path.delay;
      fragment.visible = t >= 0 && t < FADE;
      fragment.position.set(pixel(LAUNCH_X + RANGE + path.vx * Math.max(0, t)),
        pixel(-8 + path.vy * Math.max(0, t) + 90 * Math.max(0, t) * Math.max(0, t)));
      fragment.alpha = Math.max(0, 1 - t / FADE);
    }
  }

  function cast(x: number, y: number, facing: number): void {
    if (disposed) return;
    let slot = slots[0]!;
    for (const candidate of slots) {
      if (!candidate.active) { slot = candidate; break; }
      if (candidate.age > slot.age) slot = candidate;
    }
    slot.root.position.set(pixel(x), pixel(y));
    slot.root.scale.set(facing < 0 ? -1 : 1, 1);
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
      if (slot.age >= FLIGHT_END + FADE + 0.03) {
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
      slot.burstLaunch.visible = false;
      for (const ring of slot.spread) ring.visible = false;
    }
    root.visible = false;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    root.destroy({ children: true });
    for (const texture of textures) texture.destroy(true);
  }

  return { root, cast, update, reset, dispose };
}
