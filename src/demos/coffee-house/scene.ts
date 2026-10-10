// Coffee-house scene factory.
//
// Wires a borrowed atlas Texture (with manifest identifying five
// disjoint rectangular regions of the source artwork) plus a frame
// clock into a single Container hierarchy matching the CoffeeScene
// contract:
//
//   root
//     environment Mesh (original or approved authored backdrop)
//     cafe / castle contextual Sprites; original or source-textured cat skin
//     sky Container (masked day/night gradients, clouds, sun and moon)
//     foliage Container (two pinned contextual source meshes)
//     water Container (source windows and authored wave crests)
//     boats Container (independent source boats and reflections)
//     lights Container (native halos at observed lantern centers)
//     fireflies ParticleContainer (~20 reusable deterministic warm
//                                  particles near vines/front garden)
//     hotspots Container (native Graphics restrained markers near
//                         PLACES points)
//
// Constraints honoured:
//   * No Application, ticker, or host listeners are created here.
//   * No borrowed atlas source is destroyed; the borrowed source
//     remains valid for a second consumer after our dispose().
//   * Mesh geometry.destroy(true) releases its OWN buffer set.
//   * Owned framed Texture wrappers are destroyed with destroy(false).
//   * Generated light texture/source is destroyed once.
//   * setTime(0) returns to a known neutral shape; no Math.random
//     anywhere in the per-frame path.
//   * When onSelect is supplied, Pixi pointertap on actual cafe/cat/castle
//     nodes invokes it. Without it the scene is presentation-only.
//     Markers are an INDEPENDENT Graphics overlay
//     that the host can show or hide; the original capture (and
//     ambient state) hides the markers but is unaffected by them.

import {
  Container,
  Graphics,
  Mesh,
  MeshGeometry,
  Particle,
  ParticleContainer,
  Rectangle,
  Sprite,
  Texture,
  TextureSource,
} from 'pixi.js';

import { PLACES, EFFECTS, createAnimationSettings, nightAtTime } from './contracts.js';
import type { CoffeePart, CoffeeResources, CoffeeScene, EffectId, PlaceId } from './contracts.js';
import { createWaterWindow } from './water.js';
import type { WaterWindowHandle } from './water.js';
import { createCatPuppet } from './cat-puppet.js';
import { createSurfaceWaves } from './waves.js';
import { createSky } from './sky.js';
import { createBoats } from './boats.js';
import { createFoliage, FOLIAGE_REGIONS } from './foliage.js';

// ----------------- authoring constants ----------------------------------
//
// Day/night sky and source-layer animation use the approved reconstruction.
// Original mode restores every original sampler and disables new layers.

const WATER_HORIZON_AMP_U = 3.4;
const WATER_HORIZON_AMP_V = 1.4;
const WATER_HORIZON_OMEGA = 0.6 * Math.PI * 2; // 0.6 cycles/sec
const WATER_HORIZON_PHASE = 1.2;
const WATER_HORIZON_COLS = 41;
const WATER_HORIZON_ROWS = 3;

const WATER_CHANNEL_AMP_U = 3.1;
const WATER_CHANNEL_AMP_V = 1.3;
const WATER_CHANNEL_OMEGA = 0.9 * Math.PI * 2; // 0.9 cycles/sec
const WATER_CHANNEL_PHASE = 1.4;
const WATER_CHANNEL_COLS = 18;
const WATER_CHANNEL_ROWS = 8;

const FIREFLY_COUNT = 20;
const FIREFLY_MIN_SCALE = 0.18;
const FIREFLY_MAX_SCALE = 0.34;
const FIREFLY_WARM_TINT = 0xffd089;
const FIREFLY_TWINKLE_PERIOD = 3.4;
const FIREFLY_TWINKLE_AMP = 0.35;

const LANTERN_CENTERS: ReadonlyArray<readonly [number, number, number]> = [
  // x, y, radius (in source pixels)
  [160, 455, 38],
  [285, 608, 44],
  [395, 575, 36],
  [563, 613, 32],
];

const WINDOW_LIGHTS: ReadonlyArray<readonly [number, number, number]> = [
  [357, 512, 35], [625, 741, 22], [1215, 643, 26], [1264, 638, 24],
];

const LIGHT_TEXTURE_SIZE = 64;
const LIGHT_HALO_FALLOFF = 1.55;
const LANTERN_PULSE_PERIOD = 4.0;
const LANTERN_PULSE_AMP = 0.18;
const LANTERN_BASE_ALPHA = 0.10;

const HOTSPOT_RADIUS = 18;
const HOTSPOT_RING_WIDTH = 2;
const HOTSPOT_FILL = 0xfff3c2;
const HOTSPOT_STROKE = 0x6b4a1a;

const SELECTION_HALO = 0xfff3c2;
const SELECTION_INNER = 0x6b4a1a;

// ----------------- small helpers ---------------------------------------

function getPart(parts: readonly CoffeePart[], id: CoffeePart['id']): CoffeePart {
  for (const p of parts) if (p.id === id) return p;
  throw new Error(`coffee scene: manifest missing part '${id}'`);
}

function partFrame(part: CoffeePart): { fx: number; fy: number; fw: number; fh: number } {
  const [fx, fy, fw, fh] = part.frame;
  return { fx, fy, fw, fh };
}

function partOrigin(part: CoffeePart): { x: number; y: number } {
  const [x, y] = part.origin;
  return { x, y };
}

// Geometry owns the complement of the five contextual rectangles. Sampling
// opaque original pixels avoids bilinear alpha seams around raster holes.
function environmentGeometry(parts: readonly { id: string; origin: [number, number]; frame: [number, number, number, number] }[], width: number, height: number): MeshGeometry {
  const cuts = parts.filter(part => part.id !== 'environment');
  const xEdges = new Set<number>([0, width]);
  const yEdges = new Set<number>([0, height]);
  for (const cut of cuts) {
    xEdges.add(cut.origin[0]); xEdges.add(cut.origin[0] + cut.frame[2]);
    yEdges.add(cut.origin[1]); yEdges.add(cut.origin[1] + cut.frame[3]);
  }
  const xs = [...xEdges].sort((a, b) => a - b);
  const ys = [...yEdges].sort((a, b) => a - b);
  const positions = new Float32Array(xs.length * ys.length * 2);
  const uvs = new Float32Array(positions.length);
  for (let row = 0; row < ys.length; row++) {
    for (let col = 0; col < xs.length; col++) {
      const offset = (row * xs.length + col) * 2;
      positions[offset] = xs[col]!; positions[offset + 1] = ys[row]!;
      uvs[offset] = xs[col]! / width; uvs[offset + 1] = ys[row]! / height;
    }
  }
  const indices = new Uint32Array((xs.length - 1) * (ys.length - 1) * 6);
  let count = 0;
  for (let row = 0; row < ys.length - 1; row++) {
    for (let col = 0; col < xs.length - 1; col++) {
      const mx = (xs[col]! + xs[col + 1]!) / 2, my = (ys[row]! + ys[row + 1]!) / 2;
      if (cuts.some(cut => mx >= cut.origin[0] && mx < cut.origin[0] + cut.frame[2]
        && my >= cut.origin[1] && my < cut.origin[1] + cut.frame[3])) continue;
      const a = row * xs.length + col, b = a + 1, c = a + xs.length, d = c + 1;
      indices[count++] = a; indices[count++] = c; indices[count++] = b;
      indices[count++] = b; indices[count++] = c; indices[count++] = d;
    }
  }
  return new MeshGeometry({ positions, uvs, indices: indices.subarray(0, count) });
}

/**
 * Build a single soft radial-gradient texture used as the sprite
 * source for every lantern overlay. Auto-detects the appropriate
 * TextureSource for an HTMLCanvasElement (CanvasSource). Created
 * once per scene; destroyed once on dispose (texture.destroy(true)
 * tears down the owned source as well).
 */
function createLightTexture(): Texture {
  const size = LIGHT_TEXTURE_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('coffee scene: cannot acquire 2D context for lantern texture');
  const cx = size / 2;
  const cy = size / 2;
  const maxR = size / 2;
  const image = ctx.createImageData(size, size);
  const data = image.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) - cx;
      const dy = (y + 0.5) - cy;
      const r = Math.sqrt(dx * dx + dy * dy) / maxR;
      // 1 in the center, smoothly falling to 0 at the edge.
      const t = Math.max(0, 1 - r);
      const a = Math.pow(t, LIGHT_HALO_FALLOFF);
      const idx = (y * size + x) * 4;
      data[idx] = 255;
      data[idx + 1] = 226;
      data[idx + 2] = 156;
      data[idx + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(image, 0, 0);
  const source = TextureSource.from({
    resource: canvas,
    width: size,
    height: size,
    label: 'coffee-scene.lantern.source',
  });
  return new Texture({ source, label: 'coffee-scene.lantern.texture' });
}

// ----------------- scene factory ---------------------------------------

export function createCoffeeScene(
  resources: CoffeeResources,
  onSelect?: (place: PlaceId) => void,
): CoffeeScene {
  const { manifest, texture: atlasTexture } = resources;
  const parts = manifest.parts;
  const envPart = getPart(parts, 'environment');
  const horizonPart = getPart(parts, 'water-horizon');
  const channelPart = getPart(parts, 'water-channel');
  const cafePart = getPart(parts, 'cafe');
  const catPart = getPart(parts, 'cat');
  const castlePart = getPart(parts, 'castle');
  const backdropPart = resources.motion.manifest.parts.find(part => part.id === 'backdrop')!;
  const [backdropX, backdropY] = backdropPart.frame;
  const livingTexture = new Texture({ source: resources.motion.texture.source,
    frame: new Rectangle(...backdropPart.frame), label: 'coffee-scene.authored-backdrop' });
  const originalGeometry = environmentGeometry(parts, manifest.artboard[0], manifest.artboard[1]);
  const foliageCuts = FOLIAGE_REGIONS.map(([x, y, w, h], index) => ({
    id: `foliage-${index}`, origin: [x, y] as [number, number], frame: [0, 0, w, h] as [number, number, number, number],
  }));
  const livingGeometry = environmentGeometry([...parts, ...foliageCuts], manifest.artboard[0], manifest.artboard[1]);

  // ----- root hierarchy -------------------------------------------------
  const root = new Container({ label: 'coffee-scene.root' });

  // Only complement triangles render. The opaque sampling image may include
  // neighbor pixels, but it never draws behind the separately owned regions.
  const envFrame = partFrame(envPart);
  const envTexture = new Texture({
    source: atlasTexture.source,
    frame: new Rectangle(envFrame.fx, envFrame.fy, envFrame.fw, envFrame.fh),
    label: 'coffee-scene.environment.texture',
  });
  const environment = new Mesh({
    texture: envTexture,
    geometry: originalGeometry,
    label: 'coffee-scene.environment',
  });
  root.addChild(environment);

  // ----- water layer (Container; Sprite+Mesh pairs) ---------------------
  const water = new Container({ label: 'coffee-scene.water' });

  const horizonFrame = partFrame(horizonPart);
  const horizonOrigin = partOrigin(horizonPart);
  const horizon: WaterWindowHandle = createWaterWindow(
    water,
    atlasTexture,
    horizonFrame.fx, horizonFrame.fy,
    horizonFrame.fw, horizonFrame.fh,
    horizonOrigin.x, horizonOrigin.y,
    WATER_HORIZON_COLS, WATER_HORIZON_ROWS,
    WATER_HORIZON_AMP_U, WATER_HORIZON_AMP_V,
    WATER_HORIZON_OMEGA, WATER_HORIZON_PHASE,
    resources.motion.texture, backdropX + horizonOrigin.x, backdropY + horizonOrigin.y,
  );

  const channelFrame = partFrame(channelPart);
  const channelOrigin = partOrigin(channelPart);
  const channel: WaterWindowHandle = createWaterWindow(
    water,
    atlasTexture,
    channelFrame.fx, channelFrame.fy,
    channelFrame.fw, channelFrame.fh,
    channelOrigin.x, channelOrigin.y,
    WATER_CHANNEL_COLS, WATER_CHANNEL_ROWS,
    WATER_CHANNEL_AMP_U, WATER_CHANNEL_AMP_V,
    WATER_CHANNEL_OMEGA, WATER_CHANNEL_PHASE,
    resources.motion.texture, backdropX + channelOrigin.x, backdropY + channelOrigin.y,
  );
  const waves = createSurfaceWaves(water);

  // ----- interactive vignettes -----------------------------------------
  const vignetteTextures: Array<{ sprite: Sprite; original: Texture; living: Texture }> = [];
  function makeVignette(part: CoffeePart, place: PlaceId, label: string): Sprite {
    const f = partFrame(part);
    const o = partOrigin(part);
    const tex = new Texture({
      source: atlasTexture.source,
      frame: new Rectangle(f.fx, f.fy, f.fw, f.fh),
      label: `coffee-scene.${place}.texture`,
    });
    const sprite = new Sprite({ texture: tex, label: `coffee-scene.${label}` });
    sprite.x = o.x;
    sprite.y = o.y;
    const living = new Texture({ source: resources.motion.texture.source,
      frame: new Rectangle(backdropX + o.x, backdropY + o.y, f.fw, f.fh) });
    vignetteTextures.push({ sprite, original: tex, living });
    sprite.eventMode = onSelect ? 'static' : 'none';
    if (onSelect) {
      sprite.cursor = 'pointer';
      sprite.hitArea = new Rectangle(0, 0, f.fw, f.fh);
      sprite.on('pointertap', (event): void => {
        event.stopPropagation();
        onSelect(place);
      });
    }
    return sprite;
  }

  const cafe = makeVignette(cafePart, 'cafe', 'cafe');
  const catBackdrop = makeVignette(catPart, 'cat', 'cat-context');
  catBackdrop.position.set(0, 0);
  catBackdrop.removeAllListeners();
  catBackdrop.eventMode = 'none';
  function catSourceTexture(id: 'cat-body' | 'cat-tail'): Texture {
    const part = resources.motion.manifest.parts.find(part => part.id === id);
    if (!part) throw new Error(`Missing coffee motion part: ${id}`);
    return new Texture({ source: resources.motion.texture.source,
      frame: new Rectangle(...part.frame), label: `coffee-scene.${id}` });
  }
  const catTextures = { body: catSourceTexture('cat-body'), tail: catSourceTexture('cat-tail') };
  const catPuppet = createCatPuppet(catTextures);
  const cat = new Container({ label: 'coffee-scene.cat' });
  cat.position.set(...catPart.origin);
  cat.eventMode = onSelect ? 'static' : 'none';
  if (onSelect) {
    cat.cursor = 'pointer';
    cat.hitArea = new Rectangle(0, 0, catPart.frame[2], catPart.frame[3]);
    cat.on('pointertap', event => { event.stopPropagation(); onSelect('cat'); });
  }
  cat.addChild(catBackdrop, catPuppet.root);
  const castle = makeVignette(castlePart, 'castle', 'castle');
  root.addChild(cafe);
  root.addChild(cat);
  root.addChild(castle);
  // Water windows are disjoint; crests also sit above the contextual
  // castle rectangle that otherwise retains static bay pixels.
  root.addChild(water);
  const lightTexture = createLightTexture();
  const sky = createSky(resources, lightTexture);
  const boats = createBoats(resources);
  const foliage = createFoliage(resources);
  // Sky alpha preserves the observed foreground; foliage has no sky overlap.
  root.addChild(sky.root);
  root.addChild(foliage.root);
  root.addChild(boats.root);

  // The approved reconstructed sky changes independently; this veil grades the remaining painting.
  const lighting = new Graphics({ label: 'coffee-scene.night-grading' })
    .rect(0, 0, manifest.artboard[0], manifest.artboard[1]).fill(0x071329);
  lighting.eventMode = 'none';
  lighting.alpha = 0;
  root.addChild(lighting);

  // ----- lights layer (lantern glows) ----------------------------------
  const lights = new Container({ label: 'coffee-scene.lights' });
  root.addChild(lights);
  const lanternSprites: Sprite[] = [];
  const lanternBaseScales: number[] = [];
  for (const [lx, ly, lr] of [...LANTERN_CENTERS, ...WINDOW_LIGHTS]) {
    const s = new Sprite({ texture: lightTexture, label: 'coffee-scene.lantern' });
    s.x = lx;
    s.y = ly;
    s.width = lr * 2;
    s.height = lr * 2;
    s.anchor.set(0.5);
    s.alpha = LANTERN_BASE_ALPHA;
    s.blendMode = 'add';
    lanternSprites.push(s);
    lights.addChild(s);
    lanternBaseScales.push(s.scale.x);
  }

  // ----- fireflies (ParticleContainer) ---------------------------------
  const fireflies = new ParticleContainer({
    label: 'coffee-scene.fireflies',
    texture: lightTexture,
    dynamicProperties: {
      vertex: false,
      position: true,
      rotation: false,
      uvs: false,
      color: true,
    },
  });
  // Set a wide bounds area so culling never drops them off-canvas
  // while the host pans/zooms.
  fireflies.boundsArea = new Rectangle(-512, -512, manifest.artboard[0] + 1024, manifest.artboard[1] + 1024);
  root.addChild(fireflies);

  interface FireflyState {
    baseX: number;
    baseY: number;
    rx: number;
    ry: number;
    phaseX: number;
    phaseY: number;
    speedX: number;
    speedY: number;
    twinklePhase: number;
    baseScale: number;
    baseAlpha: number;
  }
  const fireflyStates: FireflyState[] = [];
  const fireflyParticles: Particle[] = new Array(FIREFLY_COUNT);
  // Approximate "vines / front garden" region: the foreground band
  // on the left side of the painting (around the cafe sign / porch
  // / chalkboard).
  const fireflyBounds = [
    { x0: 80, x1: 460, y0: 380, y1: 700 },
    { x0: 360, x1: 600, y0: 540, y1: 720 },
  ] as const;
  // Deterministic LCG (Mulberry32) so fireflies reproduce exactly
  // after setTime(0) and across reloads.
  let prng = 0x9e3779b1;
  function nextRand(): number {
    prng = (prng + 0x6d2b79f5) | 0;
    let t = prng;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  for (let i = 0; i < FIREFLY_COUNT; i++) {
    const band = fireflyBounds[i % fireflyBounds.length]!;
    const baseX = band.x0 + nextRand() * (band.x1 - band.x0);
    const baseY = band.y0 + nextRand() * (band.y1 - band.y0);
    const rx = 8 + nextRand() * 22;
    const ry = 6 + nextRand() * 16;
    const phaseX = nextRand() * Math.PI * 2;
    const phaseY = nextRand() * Math.PI * 2;
    const speedX = 0.35 + nextRand() * 0.4;
    const speedY = 0.25 + nextRand() * 0.3;
    const twinklePhase = nextRand() * Math.PI * 2;
    const baseScale = FIREFLY_MIN_SCALE + nextRand() * (FIREFLY_MAX_SCALE - FIREFLY_MIN_SCALE);
    const baseAlpha = 0.55 + nextRand() * 0.35;
    fireflyStates.push({ baseX, baseY, rx, ry, phaseX, phaseY, speedX, speedY, twinklePhase, baseScale, baseAlpha });
    const p = new Particle({
      texture: lightTexture,
      x: baseX,
      y: baseY,
      scaleX: baseScale,
      scaleY: baseScale,
      anchorX: 0.5,
      anchorY: 0.5,
      rotation: 0,
      tint: FIREFLY_WARM_TINT,
      alpha: baseAlpha,
    });
    fireflyParticles[i] = p;
    fireflies.addParticle(p);
  }

  // ----- hotspots (Graphics markers) -----------------------------------
  const hotspots = new Container({ label: 'coffee-scene.hotspots' });
  root.addChild(hotspots);
  const placeIds: readonly PlaceId[] = ['cafe', 'cat', 'castle'];
  const markerGraphics: Graphics[] = [];
  for (const place of placeIds) {
    const [px, py] = PLACES[place].point;
    const g = new Graphics({ label: `coffee-scene.marker.${place}` });
    // Restrained marker: filled dot with a thin ring and a tiny tail.
    g.circle(0, 0, HOTSPOT_RADIUS * 0.5)
      .fill({ color: HOTSPOT_FILL, alpha: 0.7 })
      .circle(0, 0, HOTSPOT_RADIUS * 0.5)
      .stroke({ color: HOTSPOT_STROKE, width: HOTSPOT_RING_WIDTH, alpha: 0.95 })
      .moveTo(0, 0)
      .lineTo(0, -HOTSPOT_RADIUS - 2)
      .stroke({ color: HOTSPOT_STROKE, width: HOTSPOT_RING_WIDTH, alpha: 0.9 });
    g.x = px;
    g.y = py;
    // The marker is a visual overlay only; pointer events pass
    // through to the underlying interactive Sprite (cafe/cat/castle)
    // which holds the canonical pointertap handler.
    g.eventMode = 'none';
    hotspots.addChild(g);
    markerGraphics.push(g);
  }
  hotspots.visible = false;

  // Selection outline: an owned Graphics that draws a thin frame
  // around the currently selected vignette's exact frame. select(null)
  // clears it; the host's reference capture calls select(null) to
  // guarantee the original frame is bit-exact.
  const selectionOutline = new Graphics({ label: 'coffee-scene.selection-outline' });
  selectionOutline.eventMode = 'none';
  root.addChild(selectionOutline);
  const vignetteByPlace: Record<PlaceId, { sprite: Container; frame: { fw: number; fh: number } }> = {
    cafe: { sprite: cafe, frame: { fw: cafePart.frame[2]!, fh: cafePart.frame[3]! } },
    cat: { sprite: cat, frame: { fw: catPart.frame[2]!, fh: catPart.frame[3]! } },
    castle: { sprite: castle, frame: { fw: castlePart.frame[2]!, fh: castlePart.frame[3]! } },
  };

  // ----- runtime state -------------------------------------------------
  let ambient = false;
  let disposed = false;
  let time = 0;
  const effects = createAnimationSettings().effects;
  const applyWater = (): void => {
    const effect = effects.water;
    const strength = effect.enabled ? effect.amount : 0;
    horizon.setStrength(strength); channel.setStrength(strength); waves.setStrength(strength);
    // Stopping water motion must not resurrect the baked source sun/boat pixels.
    horizon.setAmbient(ambient); channel.setAmbient(ambient);
    waves.setAmbient(ambient && effect.enabled);
  };
  const applyCat = (): void => {
    catPuppet.root.visible = ambient;
    catPuppet.setStrength(effects.cat.enabled ? effects.cat.amount : 0);
  };

  function applyAmbient(): void {
    environment.texture = ambient ? livingTexture : envTexture;
    environment.geometry = ambient ? livingGeometry : originalGeometry;
    for (const entry of vignetteTextures) entry.sprite.texture = ambient ? entry.living : entry.original;
    applyWater();
    applyCat();
    sky.setAmbient(ambient); boats.setAmbient(ambient); foliage.setAmbient(ambient);
    lighting.visible = ambient;
    lights.visible = ambient && effects.lamps.enabled;
    fireflies.visible = ambient && effects.fireflies.enabled;
  }
  applyAmbient();

  function setAmbient(enabled: boolean): void {
    if (disposed) return;
    ambient = enabled;
    applyAmbient();
  }


  function setEffect(id: EffectId, enabled: boolean, amount: number): void {
    if (disposed) return;
    const definition = EFFECTS[id];
    if (!definition || !Number.isFinite(amount)) throw new RangeError('Effect amount must be finite and effect must exist');
    const effect = effects[id];
    effect.enabled = enabled; effect.amount = Math.max(0, Math.min(definition.max, amount));
    if (id === 'water') applyWater();
    else if (id === 'cat') applyCat();
    else if (id === 'clouds') sky.setTime(time, enabled ? effect.amount : 0);
    else if (id === 'boats') boats.setTime(time, enabled ? effect.amount : 0);
    else if (id === 'foliage') foliage.setTime(time, enabled ? effect.amount : 0);
    else {
      lights.visible = ambient && effects.lamps.enabled;
      fireflies.visible = ambient && effects.fireflies.enabled;
      updateLights(time);
    }
  }
  function setMarkers(enabled: boolean): void {
    if (disposed) return;
    hotspots.visible = enabled;
  }

  function setTime(seconds: number): void {
    if (disposed) return;
    const t = Math.max(0, seconds);
    time = t;
    sky.setTime(t, effects.clouds.enabled ? effects.clouds.amount : 0);
    boats.setTime(t, effects.boats.enabled ? effects.boats.amount : 0);
    foliage.setTime(t, effects.foliage.enabled ? effects.foliage.amount : 0);
    horizon.setTime(t);
    channel.setTime(t);
    waves.setTime(t);
    catPuppet.setTime(t);
    updateLights(t);
  }

  function updateLights(t: number): void {
    const night = nightAtTime(t);
    lighting.alpha = night * 0.64;
    const lanternPulse = 1 + Math.sin((t / LANTERN_PULSE_PERIOD) * Math.PI * 2) * LANTERN_PULSE_AMP;
    for (let i = 0; i < lanternSprites.length; i++) {
      const s = lanternSprites[i]!;
      s.alpha = Math.min(1, (LANTERN_BASE_ALPHA + night * 0.72) * lanternPulse * effects.lamps.amount);
      s.scale.set(lanternBaseScales[i]! * (1 + night * 0.45));
    }
    // Fireflies — bounded deterministic bob and twinkle. We update
    // owned Particle instances (the typed IParticle interface hides
    // `alpha`/`tint`); the runtime Particle class exposes them.
    const count = fireflyParticles.length;
    for (let i = 0; i < count; i++) {
      const st = fireflyStates[i]!;
      const particle = fireflyParticles[i]!;
      particle.x = st.baseX + Math.sin(t * st.speedX + st.phaseX) * st.rx;
      particle.y = st.baseY + Math.cos(t * st.speedY + st.phaseY) * st.ry;
      const twinkle = 1 + Math.sin(t * (Math.PI * 2 / FIREFLY_TWINKLE_PERIOD) + st.twinklePhase) * FIREFLY_TWINKLE_AMP;
      particle.alpha = Math.max(0, Math.min(1, st.baseAlpha * twinkle * effects.fireflies.amount));
    }
  }

  function select(place: PlaceId | null): void {
    if (disposed) return;
    if (place === null) {
      selectionOutline.clear();
      selectionOutline.visible = false;
      return;
    }
    const entry = vignetteByPlace[place];
    const sx = entry.sprite.x;
    const sy = entry.sprite.y;
    const fw = entry.frame.fw;
    const fh = entry.frame.fh;
    selectionOutline.clear();
    // Outer halo then a thin inner stroke so the outline reads on
    // both bright and dark parts of the source region without
    // obscuring painting detail.
    selectionOutline
      .rect(sx - 3, sy - 3, fw + 6, fh + 6)
      .stroke({ color: SELECTION_HALO, width: 2, alpha: 0.6 })
      .rect(sx, sy, fw, fh)
      .stroke({ color: SELECTION_INNER, width: 2, alpha: 0.95 });
    selectionOutline.visible = true;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    // Factory owns the root. Detach first so the host's renderer-
    // first teardown sees a stage with no children to release; then
    // destroy every scene-owned node. Host performs the renderer
    // flush BEFORE this is called; we are only undoing the scene
    // graph and its GPU-side buffers/textures. The borrowed atlas
    // source is never destroyed.
    if (root.parent) root.parent.removeChild(root);
    // Water windows: their handle.dispose() releases the geometry
    // buffer set, framed texture (destroy(false) — borrowed source
    // untouched), and the neutral Sprite + Mesh.
    horizon.dispose();
    channel.dispose();
    waves.dispose();
    catPuppet.dispose();
    sky.dispose(); boats.dispose(); foliage.dispose();
    lighting.destroy();
    // Lantern sprites — each shares the generated light texture; we
    // destroy sprites only and tear the texture down once below.
    for (const s of lanternSprites) {
      s.removeAllListeners();
      s.destroy({ children: false, texture: false, textureSource: false });
    }
    // Fireflies — clear children; the container is destroyed with
    // its parent (root.destroy()).
    fireflies.particleChildren.length = 0;
    fireflies.update();
    // Marker Graphics — default destroy() tears down the owned
    // context.
    for (const g of markerGraphics) {
      g.removeAllListeners();
      g.destroy();
    }
    // Selection outline Graphics — also owns a context.
    selectionOutline.removeAllListeners();
    selectionOutline.destroy();
    // Scene-owned framed textures and environment buffers; atlas source borrowed.
    originalGeometry.destroy(true);
    livingGeometry.destroy(true);
    envTexture.destroy(false);
    livingTexture.destroy(false);
    for (const entry of vignetteTextures) { entry.original.destroy(false); entry.living.destroy(false); }
    catTextures.body.destroy(false); catTextures.tail.destroy(false);
    for (const child of [cafe, castle, environment]) {
      child.removeAllListeners();
      child.destroy({ children: false, texture: false, textureSource: false });
    }
    // Generated lantern texture — destroy(true) tears down its
    // CanvasSource as well.
    lightTexture.destroy(true);
    // The lights / water / hotspots / fireflies Containers and the
    // root itself still own their contexts and child refs; root's
    // destroy walks and releases them, including the still-attached
    // lantern Sprites' parents (lights) and ParticleContainer
    // (fireflies). We remove event listeners first to keep the
    // dispose idempotent and to avoid stray callback traffic.
    for (const node of [lights, fireflies, hotspots, water, root]) {
      node.removeAllListeners();
    }
    root.destroy({ children: true, texture: false, textureSource: false });
    // Clear references so GC can collect typed arrays.
    lanternSprites.length = 0;
    lanternBaseScales.length = 0;
    fireflyStates.length = 0;
    fireflyParticles.length = 0;
    markerGraphics.length = 0;
  }

  const scene: CoffeeScene = {
    root,
    layers: { environment, cafe, cat, castle, water, sky: sky.root, sun: sky.sun, moon: sky.moon,
      boats: boats.root, foliage: foliage.root, lights, lighting, fireflies, hotspots },
    waterMeshes: [horizon.mesh, channel.mesh],
    waveMeshes: waves.meshes,
    cloudSprites: sky.clouds,
    boatSprites: boats.sprites,
    foliageMeshes: foliage.meshes,
    catParts: catPuppet.parts,
    catPuppet: catPuppet.root,
    setEffect,
    setAmbient,
    setMarkers,
    setTime,
    select,
    dispose,
  };
  return scene;
}
