import { Container, Rectangle, Sprite, Texture } from 'pixi.js';
import type { CoffeeResources, MotionPartId } from './contracts.js';

export interface BoatHandle {
  readonly root: Container;
  readonly sprites: readonly Sprite[];
  setAmbient(enabled: boolean): void;
  setTime(seconds: number, speed: number): void;
  dispose(): void;
}

// Authored routes chosen above the foreground shoreline, not a water simulation.
const ROUTES = [
  { min: 845, max: 1070, y: 526, period: 22, bobPeriod: 3.6, rollPeriod: 4.8, bob: 1, roll: 0.024 },
  { min: 870, max: 1160, y: 512, period: 28, bobPeriod: 4.4, rollPeriod: 5.6, bob: 0.9, roll: 0.020 },
  { min: 940, max: 1020, y: 625, period: 18, bobPeriod: 5.2, rollPeriod: 4.2, bob: 0.7, roll: 0.018 },
] as const;
const IDS: readonly MotionPartId[] = ['boat-1', 'boat-2', 'boat-3'];
const TAU = Math.PI * 2;

export function createBoats(resources: CoffeeResources): BoatHandle {
  const root = new Container({ label: 'coffee.boats', eventMode: 'none', visible: false });
  const slots = IDS.map((id, i) => {
    const part = resources.motion.manifest.parts.find(p => p.id === id);
    if (!part) throw new Error(`Missing coffee motion part: ${id}`);
    const route = ROUTES[i]!, [x, y, w, h] = part.frame;
    const texture = new Texture({ source: resources.motion.texture.source, frame: new Rectangle(x, y, w, h), label: `coffee.${id}` });
    const hull = new Sprite({ texture, label: `coffee.${id}.hull`, eventMode: 'none' });
    const reflection = new Sprite({ texture, label: `coffee.${id}.reflection`, eventMode: 'none', alpha: 0.28 });
    hull.anchor.set(0.5, 1); reflection.anchor.set(0.5, 1);
    reflection.scale.y = -0.32;
    root.addChild(reflection, hull);
    const mid = (route.min + route.max) / 2, half = (route.max - route.min) / 2;
    const start = Math.max(route.min, Math.min(route.max, part.origin[0] + w / 2));
    return { hull, reflection, texture, route, start, mid, half,
      phase: Math.asin((start - mid) / half),
      travelRate: TAU / route.period, bobRate: TAU / route.bobPeriod, rollRate: TAU / route.rollPeriod };
  });
  const sprites = slots.map(slot => slot.hull);
  let ambient = false, disposed = false, time = 0, speed = 0;
  let appliedTime = -1, appliedSpeed = -1;
  function apply(force = false): void {
    if (!force && ((speed === 0 && appliedSpeed === 0) || (time === appliedTime && speed === appliedSpeed))) return;
    const t = time * speed;
    for (const slot of slots) {
      const x = t === 0 ? slot.start : slot.mid + slot.half * Math.sin(slot.travelRate * t + slot.phase);
      const y = slot.route.y + slot.route.bob * Math.sin(slot.bobRate * t);
      const roll = slot.route.roll * Math.sin(slot.rollRate * t);
      slot.hull.position.set(x, y); slot.hull.rotation = roll;
      slot.reflection.position.set(x, y + 2); slot.reflection.rotation = -roll * 0.5;
    }
    appliedTime = time; appliedSpeed = speed;
  }
  return {
    root, sprites,
    setAmbient(enabled) {
      if (disposed) return;
      ambient = enabled; root.visible = enabled;
      if (ambient) apply(true);
    },
    setTime(seconds, multiplier) {
      if (disposed) return;
      time = Math.max(0, seconds); speed = multiplier;
      if (ambient) apply();
    },
    dispose() {
      if (disposed) return;
      disposed = true; root.removeFromParent();
      root.destroy({ children: true, texture: false, textureSource: false });
      for (const slot of slots) slot.texture.destroy(false);
    },
  };
}
