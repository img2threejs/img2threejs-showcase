import { Container, Graphics, Rectangle, Sprite, Texture } from 'pixi.js';
import type { CoffeeResources, MotionPartId } from './contracts.js';

export interface SkyHandle {
  readonly root: Container;
  readonly sun: Container;
  readonly moon: Container;
  readonly clouds: readonly Sprite[];
  setAmbient(enabled: boolean): void;
  setTime(seconds: number, cloudSpeed: number): void;
  dispose(): void;
}

const TAU = Math.PI * 2;
const CLOUD_SPEEDS = [11, -7, 9] as const;

function smooth(value: number): number {
  const x = Math.max(0, Math.min(1, value));
  return x * x * (3 - 2 * x);
}

function cloudTint(twilight: number, darkness: number): number {
  const g = 255 - 67 * twilight;
  const b = 255 - 123 * twilight;
  return (Math.round(255 - 105 * darkness) << 16)
    | (Math.round(g + (178 - g) * darkness) << 8)
    | Math.round(b + (226 - b) * darkness);
}

export function createSky(resources: CoffeeResources, haloTexture: Texture): SkyHandle {
  const { manifest, texture } = resources.motion;
  const ownedTextures: Texture[] = [];
  const root = new Container({ label: 'coffee.sky', eventMode: 'none', visible: false });
  function sprite(id: MotionPartId): Sprite {
    const part = manifest.parts.find(p => p.id === id);
    if (!part) throw new Error(`Missing coffee motion part: ${id}`);
    const [x, y, w, h] = part.frame;
    const framed = new Texture({ source: texture.source, frame: new Rectangle(x, y, w, h), label: `coffee.${id}` });
    ownedTextures.push(framed);
    return new Sprite({ texture: framed, x: part.origin[0], y: part.origin[1], label: `coffee.${id}`, eventMode: 'none' });
  }
  const day = sprite('sky-day'), dusk = sprite('sky-dusk'), night = sprite('sky-night');
  for (const gradient of [day, dusk, night]) {
    gradient.position.set(0, 0);
    gradient.width = 1536; gradient.height = 480;
  }
  const clouds = [sprite('cloud-1'), sprite('cloud-2'), sprite('cloud-3')];
  const origins = clouds.map(cloud => cloud.x);
  const stars = manifest.stars.map(([x, y, radius], i) => {
    const star = new Sprite({ texture: haloTexture, x, y, label: `coffee.star.${i}`, eventMode: 'none' });
    star.anchor.set(0.5); star.width = radius * 2; star.height = radius * 2;
    return star;
  });
  function celestial(moon: boolean): Container {
    const node = new Container({ label: moon ? 'coffee.moon' : 'coffee.sun', eventMode: 'none' });
    const halo = new Sprite({ texture: haloTexture, eventMode: 'none' });
    halo.anchor.set(0.5); halo.width = 96; halo.height = 96;
    halo.tint = moon ? 0x95b7ff : 0xffdc8c;
    halo.alpha = moon ? 0.3 : 0.42; halo.blendMode = 'add';
    const body = new Graphics({ eventMode: 'none' });
    if (moon) {
      // A simple concave contour avoids triangulating an overlapping circle hole.
      body.moveTo(10, -20).bezierCurveTo(-8, -26, -25, -12, -20, 8)
        .bezierCurveTo(-15, 25, 9, 28, 20, 9)
        .bezierCurveTo(-3, 20, -18, -4, 10, -20).closePath().fill(0xe8efff);
    } else body.circle(0, 0, 22).fill(0xfff0a8);
    node.addChild(halo, body);
    return node;
  }
  const sun = celestial(false), moon = celestial(true), mask = sprite('sky-mask');
  root.addChild(day, dusk, night, ...clouds, ...stars, sun, moon, mask);
  // One source-derived alpha mask clips every sky actor behind foreground art.
  root.setMask({ mask, channel: 'alpha' });

  let ambient = false, disposed = false, time = 0, cloudSpeed = 0;
  function apply(): void {
    const phase = time * TAU / 24, sine = Math.sin(phase), cosine = Math.cos(phase);
    const darkness = (1 - cosine) / 2, sine2 = sine * sine;
    const twilight = sine2 * sine2 * sine2 * sine2;
    day.alpha = 1; dusk.alpha = twilight; night.alpha = darkness * (1 - twilight);
    sun.position.set(1255 + 150 * sine, 435 - 240 * cosine);
    moon.position.set(1090 - 170 * sine, 435 + 230 * cosine);
    sun.alpha = Math.max(0, Math.min(1, cosine * 5 + 0.5));
    moon.alpha = Math.max(0, Math.min(1, -cosine * 5 + 0.5));
    sun.visible = sun.alpha > 0; moon.visible = moon.alpha > 0;
    for (const star of stars) star.alpha = darkness * (1 - twilight);
    const tint = cloudTint(twilight, darkness * (1 - twilight));
    for (let i = 0; i < clouds.length; i++) {
      const cloud = clouds[i]!, width = cloud.texture.width, span = 1536 + width;
      const raw = origins[i]! + CLOUD_SPEEDS[i]! * time * cloudSpeed;
      // Wrap only when the whole cloud is outside the artboard; both endpoints
      // have zero alpha. Clock zero and speed zero share the source pose.
      cloud.x = ((raw + width) % span + span) % span - width;
      cloud.alpha = cloudSpeed === 0 ? 1 : smooth(Math.min((cloud.x + width) / width, (1536 - cloud.x) / width));
      cloud.tint = tint;
    }
  }
  return {
    root, sun, moon, clouds,
    setAmbient(enabled) {
      if (disposed) return;
      ambient = enabled; root.visible = enabled;
      if (ambient) apply();
    },
    setTime(seconds, speed) {
      if (disposed) return;
      time = Math.max(0, seconds); cloudSpeed = speed;
      if (ambient) apply();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      root.removeFromParent(); root.setMask({ mask: null });
      root.destroy({ children: true, texture: false, textureSource: false });
      for (const framed of ownedTextures) framed.destroy(false);
      ownedTextures.length = 0;
    },
  };
}
