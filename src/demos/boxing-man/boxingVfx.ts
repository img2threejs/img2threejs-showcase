import * as THREE from 'three';
import type { Glove, PunchKind } from './punchEvents';

/**
 * Ringside effects for the boxing figure — what a punch does to the air, the canvas and the light.
 *
 * WHAT BOXING ACTUALLY LOOKS LIKE, and what each layer here is for.
 *
 * Elite fist speed is 8-12 m/s and a landed cross measures around 3,000-3,200 N at the glove
 * (against roughly 1,000 N for a junior), so the interesting part of a punch is not the travel —
 * it is the 20 ms where all of that stops. Everything below is built around that instant:
 *
 *   glove trail    the only continuous layer. Speed-driven, so it appears when a hand is fast and
 *                  vanishes when it is not; a cross-section ribbon rather than a flat one, so it
 *                  keeps its body when the orbit swings behind the punch.
 *   wind tear      an open cone left along the punch axis. This is the layer that reads as speed,
 *                  and it is the one a hook shears sideways because a hook does not travel straight.
 *   flash + rings  the stop itself. A billboarded core flash for the first 60 ms, then rings that
 *                  expand ALONG the punch axis — a ring that expands in the screen plane reads as a
 *                  magic circle, one that expands along the axis reads as displaced air.
 *   speed lines    twelve tapered slivers in the plane across the punch. Not physical; this is the
 *                  ringside-photograph convention for a blow that landed, and the eye reads it
 *                  faster than anything physical would.
 *   sweat spray    the iconic frame. Droplets thrown off the contact in a forward cone, under real
 *                  gravity with drag, stretched along their own velocity in the shader so they read
 *                  as high-speed-camera streaks rather than as dots.
 *   canvas dust    rosin lifted off the canvas. Non-additive, buoyant, slow: dust occludes light,
 *                  it does not emit it, and dust that glows reads as fire.
 *   impact light   a real PointLight spiking for 120 ms. This is what stops the effects looking
 *                  stuck ON the figure — the flare has to land on the shoulders and the gloves.
 *   breath         cool vapour off the head between exchanges. Cheap, and it is what makes the
 *                  figure look like it is breathing rather than idling.
 *
 * COLOUR is drawn from the venue, not from an element wheel: broadcast ring light is a hard warm
 * top key with everything around it falling to black, so impacts run white-hot core -> amber ->
 * a crimson outer edge that borrows the glove leather. Sweat is the one cool thing in frame, which
 * is exactly why it reads.
 *
 * COST. Two pooled Points systems (360 hot, 240 dust) integrated on the CPU — at this count the
 * integration is nothing and it buys per-kind motion that a single shader cannot fake — plus 26
 * pooled meshes/sprites and 3 pooled lights. Nothing is allocated after construction, and every
 * object starts invisible so the viewer's one-shot framing pass never measures an effect.
 */

const HOT_CAPACITY = 360;
const DUST_CAPACITY = 240;
const TRAIL_SAMPLES = 14;

/** Ring-light warm, glove-leather crimson, and the one cool colour in the venue. */
const COLOURS = {
  core: new THREE.Color(0xfff6e8),
  amber: new THREE.Color(0xffb14a),
  crimson: new THREE.Color(0xe0402a),
  sweat: new THREE.Color(0xdff2ff),
  sweatCool: new THREE.Color(0x8fbfe8),
  rosin: new THREE.Color(0xdacdb2),
  rosinDeep: new THREE.Color(0x6e6252),
  breath: new THREE.Color(0xdfe9f2),
  trail: new THREE.Color(0xffe4bb),
};

/**
 * Per-punch shaping. The three punches differ in motion first and colour second — a jab that only
 * differs from a cross by being paler is still a cross.
 */
const PUNCH_SHAPE: Record<PunchKind, {
  /** Wind-tear length and radius, in world units. */
  tearLength: number; tearRadius: number;
  /** Sideways shear of the tear — a hook arcs, so its cone leans across the travel. */
  shear: number;
  flashScale: number; ringCount: number; ringSpan: number;
  sparks: number; spray: number; sprayCone: number;
  /** Radius of the speed-line rosette, in world units. */
  lineReach: number;
  light: number;
  /** Ground ripple radius; 0 for punches that do not put weight through the floor. */
  ripple: number;
  /** Seconds of hitstop — the animation slows here, which is most of the felt impact. */
  hitstop: number;
}> = {
  jab: {
    tearLength: 0.34, tearRadius: 0.055, shear: 0.0,
    flashScale: 0.20, ringCount: 1, ringSpan: 0.17,
    sparks: 12, spray: 14, sprayCone: 0.55,
    lineReach: 0.20,
    light: 5.0, ripple: 0, hitstop: 0.045,
  },
  cross: {
    tearLength: 0.52, tearRadius: 0.090, shear: 0.0,
    flashScale: 0.34, ringCount: 2, ringSpan: 0.26,
    sparks: 26, spray: 30, sprayCone: 0.72,
    lineReach: 0.32,
    light: 13.0, ripple: 0.85, hitstop: 0.085,
  },
  hook: {
    tearLength: 0.42, tearRadius: 0.105, shear: 0.55,
    flashScale: 0.28, ringCount: 2, ringSpan: 0.22,
    sparks: 20, spray: 26, sprayCone: 1.05,
    lineReach: 0.26,
    light: 10.0, ripple: 0.50, hitstop: 0.070,
  },
};

type HotKind = 'spray' | 'spark';
type DustKind = 'rosin' | 'breath';

/** Physics per kind. Water falls and streaks, embers stop dead, dust floats, breath climbs. */
const HOT_PHYSICS: Record<HotKind, {
  gravity: number; drag: number; life: [number, number]; size: [number, number];
  stretch: number; tint: number;
}> = {
  // Real gravity, because a droplet that floats reads as a spark. Drag keeps the far ones short.
  spray: { gravity: 7.2, drag: 1.5, life: [0.55, 0.95], size: [0.008, 0.019], stretch: 0.62, tint: 0 },
  // Heavy drag: an ember thrown off a stopping glove is gone in a third of a second.
  spark: { gravity: 2.4, drag: 6.5, life: [0.16, 0.36], size: [0.010, 0.024], stretch: 0.85, tint: 1 },
};

const DUST_PHYSICS: Record<DustKind, {
  gravity: number; drag: number; life: [number, number]; size: [number, number];
  growth: number; alpha: number; tint: number;
}> = {
  rosin: { gravity: -0.22, drag: 3.4, life: [0.70, 1.30], size: [0.035, 0.075], growth: 2.2, alpha: 0.52, tint: 0 },
  breath: { gravity: -0.38, drag: 2.1, life: [1.10, 1.90], size: [0.030, 0.075], growth: 2.8, alpha: 0.10, tint: 1 },
};

const bufferSize = new THREE.Vector2();

/** World-units-to-pixels for a point sprite one unit from the camera. */
function pixelScale(renderer: THREE.WebGLRenderer, camera: THREE.Camera): number {
  renderer.getDrawingBufferSize(bufferSize);
  const perspective = camera as THREE.PerspectiveCamera;
  if (!perspective.isPerspectiveCamera) return bufferSize.y;
  return bufferSize.y / (2 * Math.tan((perspective.fov * Math.PI) / 360));
}

function softTexture(coreBias: number): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(coreBias, 'rgba(255,255,255,0.72)');
  gradient.addColorStop(0.62, 'rgba(255,255,255,0.20)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** A hot core with a soft warm skirt — the flash and the charge glow both ride this. */
function flareTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.12, 'rgba(255,246,232,0.95)');
  g.addColorStop(0.30, 'rgba(255,177,74,0.55)');
  g.addColorStop(0.58, 'rgba(224,64,42,0.18)');
  g.addColorStop(1, 'rgba(224,64,42,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

interface Pool<T> { items: T[]; cursor: number }

function nextFrom<T>(pool: Pool<T>): T {
  const item = pool.items[pool.cursor];
  pool.cursor = (pool.cursor + 1) % pool.items.length;
  return item;
}

interface RingSlot {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  age: number;
  span: number;
  from: number;
  to: number;
  along: number;
  dir: THREE.Vector3;
  origin: THREE.Vector3;
}

interface TearSlot {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  age: number;
  span: number;
  length: number;
  radius: number;
  /** The apex is pinned here every frame — the cone grows backwards out of the contact. */
  origin: THREE.Vector3;
  dir: THREE.Vector3;
}

interface LineSlot {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  age: number;
  span: number;
  reach: number;
}

interface FlashSlot {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  age: number;
  span: number;
  scale: number;
}

interface RippleSlot {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  age: number;
  span: number;
  radius: number;
}

interface LightSlot {
  light: THREE.PointLight;
  age: number;
  span: number;
  peak: number;
}

interface Ribbon {
  mesh: THREE.Mesh;
  position: THREE.BufferAttribute;
  strength: THREE.BufferAttribute;
  history: THREE.Vector3[];
  filled: number;
  level: number;
}

export interface BoxingVfx {
  /** Add this under the model root; every child starts invisible. */
  readonly group: THREE.Group;
  /** Continuous per-frame glove trail. `strength` is 0-1, already gated by the caller. */
  glove(glove: Glove, at: THREE.Vector3, strength: number): void
  /** Windup glow on a glove, 0-1. Called every frame in the 0.22 s before a punch lands. */
  charge(glove: Glove, at: THREE.Vector3, amount: number): void
  /** A punch landing. `dir` is the travel direction, normalised. Returns the hitstop in seconds. */
  punch(kind: PunchKind, at: THREE.Vector3, dir: THREE.Vector3, power: number): number
  /** Weight arriving on the canvas. `drop` is the measured descent in figure heights per second. */
  footfall(at: THREE.Vector3, drop: number): void
  /** A blow this figure takes: inward rings, spray thrown BACK off the body, no glove flash. */
  absorb(at: THREE.Vector3, dir: THREE.Vector3, power: number): void
  /** Droplets flicked off a decelerating head or shoulder. */
  sweat(at: THREE.Vector3, count: number): void
  /** One breath from the head. */
  breathe(at: THREE.Vector3, forward: THREE.Vector3): void
  /**
   * Live pool occupancy. Published because "is the effect actually on screen" is otherwise
   * unanswerable from outside: a sub-pixel point sprite and an unfired one look identical in a
   * screenshot, and that cost a whole round of debugging.
   */
  counts(): { hot: number; dust: number; rings: number; tears: number; flashes: number }
  update(dt: number): void
  dispose(): void
}

export function createBoxingVfx(): BoxingVfx {
  const group = new THREE.Group();
  group.name = 'boxing-vfx';
  // Keeps the effects out of the parts list, out of the explode layout and out of the framing pass.
  group.userData.isHighlight = true;

  const spark = softTexture(0.18);
  const puff = softTexture(0.42);
  const flare = flareTexture();

  const scratchA = new THREE.Vector3();
  const scratchB = new THREE.Vector3();
  const scratchC = new THREE.Vector3();
  const scratchD = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const sideways = new THREE.Vector3(1, 0, 0);

  // ---------------------------------------------------------------- hot particles: spray + sparks
  const hot = {
    px: new Float32Array(HOT_CAPACITY), py: new Float32Array(HOT_CAPACITY), pz: new Float32Array(HOT_CAPACITY),
    vx: new Float32Array(HOT_CAPACITY), vy: new Float32Array(HOT_CAPACITY), vz: new Float32Array(HOT_CAPACITY),
    age: new Float32Array(HOT_CAPACITY), span: new Float32Array(HOT_CAPACITY),
    gravity: new Float32Array(HOT_CAPACITY), drag: new Float32Array(HOT_CAPACITY),
    cursor: 0,
  };
  hot.age.fill(1);
  hot.span.fill(1);

  const hotPosition = new Float32Array(HOT_CAPACITY * 3);
  const hotLife = new Float32Array(HOT_CAPACITY).fill(1);
  const hotSize = new Float32Array(HOT_CAPACITY);
  const hotTint = new Float32Array(HOT_CAPACITY);
  const hotVel = new Float32Array(HOT_CAPACITY * 3);
  const hotStretch = new Float32Array(HOT_CAPACITY);

  const hotGeometry = new THREE.BufferGeometry();
  const hotAttr = {
    position: new THREE.BufferAttribute(hotPosition, 3).setUsage(THREE.DynamicDrawUsage),
    life: new THREE.BufferAttribute(hotLife, 1).setUsage(THREE.DynamicDrawUsage),
    size: new THREE.BufferAttribute(hotSize, 1).setUsage(THREE.DynamicDrawUsage),
    tint: new THREE.BufferAttribute(hotTint, 1).setUsage(THREE.DynamicDrawUsage),
    vel: new THREE.BufferAttribute(hotVel, 3).setUsage(THREE.DynamicDrawUsage),
    stretch: new THREE.BufferAttribute(hotStretch, 1).setUsage(THREE.DynamicDrawUsage),
  };
  hotGeometry.setAttribute('position', hotAttr.position);
  hotGeometry.setAttribute('aLife', hotAttr.life);
  hotGeometry.setAttribute('aSize', hotAttr.size);
  hotGeometry.setAttribute('aTint', hotAttr.tint);
  hotGeometry.setAttribute('aVel', hotAttr.vel);
  hotGeometry.setAttribute('aStretch', hotAttr.stretch);

  /**
   * The stretch is what makes a droplet read as a droplet.
   *
   * A point sprite cannot be rotated, so the velocity is projected into view space in the vertex
   * shader and handed to the fragment shader as a 2D direction. The fragment then squashes
   * `gl_PointCoord` ACROSS that direction and stretches it along, which turns a round sprite into
   * a streak that points where the particle is going — the shape a high-speed camera records.
   */
  const hotMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uMap: { value: spark },
      uCore: { value: COLOURS.core },
      uAmber: { value: COLOURS.amber },
      uSweat: { value: COLOURS.sweat },
      uSweatCool: { value: COLOURS.sweatCool },
      uScale: { value: 340 },
    },
    vertexShader: `
      attribute float aLife;
      attribute float aSize;
      attribute float aTint;
      attribute vec3 aVel;
      attribute float aStretch;
      uniform float uScale;
      varying float vLife;
      varying float vTint;
      varying vec2 vDir;
      varying float vStretch;
      void main() {
        vLife = aLife;
        vTint = aTint;
        vStretch = aStretch;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 velView = (modelViewMatrix * vec4(aVel, 0.0)).xyz;
        float len = length(velView.xy);
        vDir = len > 1e-4 ? velView.xy / len : vec2(1.0, 0.0);
        // Sparks shrink as they die, droplets hold their size until they fade out.
        float shrink = mix(1.0, 1.0 - aLife * 0.55, aTint);
        gl_PointSize = aSize * uScale * shrink / max(0.001, -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform sampler2D uMap;
      uniform vec3 uCore;
      uniform vec3 uAmber;
      uniform vec3 uSweat;
      uniform vec3 uSweatCool;
      varying float vLife;
      varying float vTint;
      varying vec2 vDir;
      varying float vStretch;
      void main() {
        if (vLife >= 1.0) discard;
        vec2 uv = gl_PointCoord - 0.5;
        // Rotate into the streak frame, then squash across it.
        vec2 axis = vec2(dot(uv, vDir), dot(uv, vec2(-vDir.y, vDir.x)));
        float k = 1.0 + vStretch * 2.2;
        uv = vec2(axis.x / k, axis.y * (1.0 + vStretch * 0.6));
        float mask = texture2D(uMap, uv + 0.5).a;
        vec3 hotTone = mix(uCore, uAmber, vLife);
        vec3 coolTone = mix(uSweat, uSweatCool, vLife);
        vec3 tone = mix(coolTone, hotTone, vTint);
        float fade = 1.0 - vLife;
        // Droplets hold, then go; sparks decay from the first frame.
        float curve = mix(smoothstep(0.0, 0.32, fade), fade * fade, vTint);
        gl_FragColor = vec4(tone, mask * curve * mix(0.85, 1.0, vTint));
      }`,
  });

  const hotPoints = new THREE.Points(hotGeometry, hotMaterial);
  /**
   * gl_PointSize is in FRAMEBUFFER PIXELS, so the world-to-pixel factor has to come from the
   * projection: half the drawing-buffer height over tan(fov/2). Hard-coding it — which is what a
   * literal 340 was — made every droplet a quarter of a pixel on a 30-degree lens and the whole
   * spray invisible. Read per draw, so it survives a resize, a DPR change and a fov change.
   */
  hotPoints.onBeforeRender = (renderer, _scene, camera) => {
    hotMaterial.uniforms.uScale.value = pixelScale(renderer, camera);
  };
  hotPoints.frustumCulled = false;
  hotPoints.renderOrder = 5;
  hotPoints.userData.isHighlight = true;
  group.add(hotPoints);

  // ---------------------------------------------------------------- dust particles: rosin + breath
  const dust = {
    px: new Float32Array(DUST_CAPACITY), py: new Float32Array(DUST_CAPACITY), pz: new Float32Array(DUST_CAPACITY),
    vx: new Float32Array(DUST_CAPACITY), vy: new Float32Array(DUST_CAPACITY), vz: new Float32Array(DUST_CAPACITY),
    age: new Float32Array(DUST_CAPACITY), span: new Float32Array(DUST_CAPACITY),
    gravity: new Float32Array(DUST_CAPACITY), drag: new Float32Array(DUST_CAPACITY),
    base: new Float32Array(DUST_CAPACITY), growth: new Float32Array(DUST_CAPACITY),
    cursor: 0,
  };
  dust.age.fill(1);
  dust.span.fill(1);

  const dustPosition = new Float32Array(DUST_CAPACITY * 3);
  const dustLife = new Float32Array(DUST_CAPACITY).fill(1);
  const dustSize = new Float32Array(DUST_CAPACITY);
  const dustTint = new Float32Array(DUST_CAPACITY);
  const dustAlpha = new Float32Array(DUST_CAPACITY);
  const dustSpin = new Float32Array(DUST_CAPACITY);

  const dustGeometry = new THREE.BufferGeometry();
  const dustAttr = {
    position: new THREE.BufferAttribute(dustPosition, 3).setUsage(THREE.DynamicDrawUsage),
    life: new THREE.BufferAttribute(dustLife, 1).setUsage(THREE.DynamicDrawUsage),
    size: new THREE.BufferAttribute(dustSize, 1).setUsage(THREE.DynamicDrawUsage),
    tint: new THREE.BufferAttribute(dustTint, 1).setUsage(THREE.DynamicDrawUsage),
    alpha: new THREE.BufferAttribute(dustAlpha, 1).setUsage(THREE.DynamicDrawUsage),
    spin: new THREE.BufferAttribute(dustSpin, 1).setUsage(THREE.DynamicDrawUsage),
  };
  dustGeometry.setAttribute('position', dustAttr.position);
  dustGeometry.setAttribute('aLife', dustAttr.life);
  dustGeometry.setAttribute('aSize', dustAttr.size);
  dustGeometry.setAttribute('aTint', dustAttr.tint);
  dustGeometry.setAttribute('aAlpha', dustAttr.alpha);
  dustGeometry.setAttribute('aSpin', dustAttr.spin);

  /** Normal blending, not additive: rosin and breath BLOCK light, they do not emit it. */
  const dustMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    uniforms: {
      uMap: { value: puff },
      uRosin: { value: COLOURS.rosin },
      uRosinDeep: { value: COLOURS.rosinDeep },
      uBreath: { value: COLOURS.breath },
      uScale: { value: 340 },
    },
    vertexShader: `
      attribute float aLife;
      attribute float aSize;
      attribute float aTint;
      attribute float aAlpha;
      attribute float aSpin;
      uniform float uScale;
      varying float vLife;
      varying float vTint;
      varying float vAlpha;
      varying float vSpin;
      void main() {
        vLife = aLife;
        vTint = aTint;
        vAlpha = aAlpha;
        vSpin = aSpin;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uScale / max(0.001, -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform sampler2D uMap;
      uniform vec3 uRosin;
      uniform vec3 uRosinDeep;
      uniform vec3 uBreath;
      varying float vLife;
      varying float vTint;
      varying float vAlpha;
      varying float vSpin;
      void main() {
        if (vLife >= 1.0) discard;
        // A slow per-particle rotation, so a cloud of identical sprites does not read as a pattern.
        float a = vSpin + vLife * 1.4;
        vec2 uv = gl_PointCoord - 0.5;
        uv = vec2(uv.x * cos(a) - uv.y * sin(a), uv.x * sin(a) + uv.y * cos(a));
        float mask = texture2D(uMap, uv + 0.5).a;
        vec3 tone = mix(mix(uRosin, uRosinDeep, vLife), uBreath, vTint);
        // Rise in, hold, fall out — a puff that starts at full opacity pops.
        float fade = smoothstep(0.0, 0.18, vLife) * (1.0 - smoothstep(0.35, 1.0, vLife));
        gl_FragColor = vec4(tone, mask * fade * vAlpha);
      }`,
  });

  const dustPoints = new THREE.Points(dustGeometry, dustMaterial);
  dustPoints.onBeforeRender = (renderer, _scene, camera) => {
    dustMaterial.uniforms.uScale.value = pixelScale(renderer, camera);
  };
  dustPoints.frustumCulled = false;
  dustPoints.renderOrder = 4;
  dustPoints.userData.isHighlight = true;
  group.add(dustPoints);

  function emitHot(
    kind: HotKind, x: number, y: number, z: number,
    vx: number, vy: number, vz: number, sizeScale = 1,
  ): void {
    const physics = HOT_PHYSICS[kind];
    const i = hot.cursor;
    hot.cursor = (hot.cursor + 1) % HOT_CAPACITY;
    hot.px[i] = x; hot.py[i] = y; hot.pz[i] = z;
    hot.vx[i] = vx; hot.vy[i] = vy; hot.vz[i] = vz;
    hot.age[i] = 0;
    hot.span[i] = physics.life[0] + Math.random() * (physics.life[1] - physics.life[0]);
    hot.gravity[i] = physics.gravity;
    hot.drag[i] = physics.drag;
    hotSize[i] = (physics.size[0] + Math.random() * (physics.size[1] - physics.size[0])) * sizeScale;
    hotTint[i] = physics.tint;
    hotStretch[i] = physics.stretch;
  }

  function emitDust(
    kind: DustKind, x: number, y: number, z: number,
    vx: number, vy: number, vz: number, sizeScale = 1, alphaScale = 1,
  ): void {
    const physics = DUST_PHYSICS[kind];
    const i = dust.cursor;
    dust.cursor = (dust.cursor + 1) % DUST_CAPACITY;
    dust.px[i] = x; dust.py[i] = y; dust.pz[i] = z;
    dust.vx[i] = vx; dust.vy[i] = vy; dust.vz[i] = vz;
    dust.age[i] = 0;
    dust.span[i] = physics.life[0] + Math.random() * (physics.life[1] - physics.life[0]);
    dust.gravity[i] = physics.gravity;
    dust.drag[i] = physics.drag;
    dust.base[i] = (physics.size[0] + Math.random() * (physics.size[1] - physics.size[0])) * sizeScale;
    dust.growth[i] = physics.growth;
    dustTint[i] = physics.tint;
    dustAlpha[i] = physics.alpha * alphaScale;
    dustSpin[i] = Math.random() * Math.PI * 2;
  }

  // ---------------------------------------------------------------------------- glove trails
  const trailMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: { uColour: { value: COLOURS.trail.clone() }, uAlpha: { value: 0.15 } },
    vertexShader: `
      attribute float aStrength;
      varying float vStrength;
      void main() {
        vStrength = aStrength;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uColour;
      uniform float uAlpha;
      varying float vStrength;
      void main() {
        gl_FragColor = vec4(uColour, uAlpha * vStrength);
      }`,
  });

  /**
   * A CROSS-SECTION ribbon: two strips at right angles to each other along the path, instead of one
   * flat strip. A flat ribbon needs the camera to decide which way is "sideways", and this system
   * is driven from `userData.tick`, which never sees the camera — so an orbit that swings behind a
   * punch would edge-on a flat ribbon and delete it. Two crossed strips have no vanishing angle.
   */
  const ribbons = new Map<Glove, Ribbon>();
  for (const glove of ['left', 'right'] as Glove[]) {
    const geometry = new THREE.BufferGeometry();
    const position = new THREE.BufferAttribute(new Float32Array(TRAIL_SAMPLES * 4 * 3), 3)
      .setUsage(THREE.DynamicDrawUsage);
    const strength = new THREE.BufferAttribute(new Float32Array(TRAIL_SAMPLES * 4), 1)
      .setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', position);
    geometry.setAttribute('aStrength', strength);
    const index: number[] = [];
    for (let i = 0; i < TRAIL_SAMPLES - 1; i += 1) {
      const a = i * 4;
      index.push(a, a + 1, a + 4, a + 1, a + 5, a + 4);
      index.push(a + 2, a + 3, a + 6, a + 3, a + 7, a + 6);
    }
    geometry.setIndex(index);
    const mesh = new THREE.Mesh(geometry, trailMaterial.clone());
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    mesh.visible = false;
    mesh.userData.isHighlight = true;
    group.add(mesh);
    ribbons.set(glove, {
      mesh,
      position,
      strength,
      history: Array.from({ length: TRAIL_SAMPLES }, () => new THREE.Vector3()),
      filled: 0,
      level: 0,
    });
  }

  // ------------------------------------------------------------------------------ wind tears
  const tearMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: { uFade: { value: 0 }, uColour: { value: new THREE.Color(0xeaf4ff) } },
    vertexShader: `
      varying float vRim;
      varying float vAlong;
      void main() {
        // Cone geometry: apex at +Y, base at -Y. vAlong is 0 at the apex, 1 at the open mouth.
        vAlong = 0.5 - position.y;
        vec3 n = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        // Rim light: the silhouette edge of the shell is what reads, not the face of it.
        vRim = 1.0 - abs(dot(n, normalize(-mv.xyz)));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform float uFade;
      uniform vec3 uColour;
      varying float vRim;
      varying float vAlong;
      void main() {
        // A sharper rim: only the silhouette of the shell should carry light. At 1.6 the face of
        // the cone lit up too and the whole thing read as a solid slab of white across the chest.
        float edge = pow(clamp(vRim, 0.0, 1.0), 2.6);
        float taper = smoothstep(0.0, 0.30, vAlong) * (1.0 - smoothstep(0.50, 1.0, vAlong));
        gl_FragColor = vec4(uColour, edge * taper * uFade * 0.26);
      }`,
  });

  const tearPool: Pool<TearSlot> = { items: [], cursor: 0 };
  for (let i = 0; i < 4; i += 1) {
    const material = tearMaterial.clone();
    const mesh = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 26, 1, true), material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    mesh.visible = false;
    mesh.userData.isHighlight = true;
    group.add(mesh);
    tearPool.items.push({
      mesh, material, age: 1, span: 1, length: 1, radius: 1,
      origin: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, 1),
    });
  }

  // ----------------------------------------------------------------------------- shock rings
  const ringMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uFade: { value: 0 },
      uInner: { value: COLOURS.core },
      uOuter: { value: COLOURS.amber },
    },
    vertexShader: `
      varying float vBand;
      void main() {
        // RingGeometry is built in XY; radius carries the band coordinate.
        vBand = clamp((length(position.xy) - 0.72) / 0.28, 0.0, 1.0);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform float uFade;
      uniform vec3 uInner;
      uniform vec3 uOuter;
      varying float vBand;
      void main() {
        float band = sin(vBand * 3.14159);
        gl_FragColor = vec4(mix(uInner, uOuter, vBand), pow(band, 1.4) * uFade);
      }`,
  });

  const ringPool: Pool<RingSlot> = { items: [], cursor: 0 };
  for (let i = 0; i < 8; i += 1) {
    const material = ringMaterial.clone();
    const mesh = new THREE.Mesh(new THREE.RingGeometry(0.72, 1.0, 48, 1), material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;
    mesh.visible = false;
    mesh.userData.isHighlight = true;
    group.add(mesh);
    ringPool.items.push({
      mesh, material, age: 1, span: 1, from: 0, to: 1, along: 0,
      dir: new THREE.Vector3(0, 0, 1), origin: new THREE.Vector3(),
    });
  }

  // ------------------------------------------------------------------------------ speed lines
  /**
   * Twelve tapered slivers laid out in the mesh's XY plane, which is then aimed so that plane sits
   * ACROSS the punch. `aSeed` staggers their length and `aOut` is the outward coordinate the shader
   * pushes along, so one draw call snaps all twelve out from the contact.
   */
  function makeSpeedLines(count: number): THREE.BufferGeometry {
    const position: number[] = [];
    const seed: number[] = [];
    const out: number[] = [];
    const index: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.22;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const halfWidth = 0.030 + Math.random() * 0.022;
      const base = i * 4;
      // Inner edge (wide) then outer tip (pinched), in a frame where +X is outward.
      const nx = -sin;
      const ny = cos;
      position.push(cos * 0.18 + nx * halfWidth, sin * 0.18 + ny * halfWidth, 0);
      position.push(cos * 0.18 - nx * halfWidth, sin * 0.18 - ny * halfWidth, 0);
      position.push(cos + nx * halfWidth * 0.14, sin + ny * halfWidth * 0.14, 0);
      position.push(cos - nx * halfWidth * 0.14, sin - ny * halfWidth * 0.14, 0);
      const s = 0.55 + Math.random() * 0.45;
      seed.push(s, s, s, s);
      out.push(0, 0, 1, 1);
      index.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
    geometry.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 1));
    geometry.setAttribute('aOut', new THREE.Float32BufferAttribute(out, 1));
    geometry.setIndex(index);
    return geometry;
  }

  const lineMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uFade: { value: 0 }, uPush: { value: 0 }, uReach: { value: 0.4 },
      uColour: { value: new THREE.Color(0xfff1d0) },
    },
    vertexShader: `
      attribute float aSeed;
      attribute float aOut;
      uniform float uPush;
      uniform float uReach;
      varying float vOut;
      void main() {
        vOut = aOut;
        // Slide the whole sliver outward as the impact opens; the tip runs ahead of the root.
        vec3 p = position;
        float travel = uPush * aSeed * uReach;
        p.xy += normalize(p.xy + 1e-5) * travel * (0.45 + aOut * 0.55);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: `
      uniform float uFade;
      uniform vec3 uColour;
      varying float vOut;
      void main() {
        gl_FragColor = vec4(uColour, uFade * (1.0 - vOut * 0.85));
      }`,
  });

  const linePool: Pool<LineSlot> = { items: [], cursor: 0 };
  for (let i = 0; i < 4; i += 1) {
    const material = lineMaterial.clone();
    const mesh = new THREE.Mesh(makeSpeedLines(9), material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    mesh.visible = false;
    mesh.userData.isHighlight = true;
    group.add(mesh);
    linePool.items.push({ mesh, material, age: 1, span: 1, reach: 0.4 });
  }

  // ----------------------------------------------------------------------------- core flashes
  const flashPool: Pool<FlashSlot> = { items: [], cursor: 0 };
  for (let i = 0; i < 6; i += 1) {
    const material = new THREE.SpriteMaterial({
      map: flare, blending: THREE.AdditiveBlending, transparent: true,
      depthWrite: false, opacity: 0,
    });
    const sprite = new THREE.Sprite(material);
    sprite.visible = false;
    sprite.renderOrder = 6;
    sprite.userData.isHighlight = true;
    group.add(sprite);
    flashPool.items.push({ sprite, material, age: 1, span: 1, scale: 1 });
  }

  // ------------------------------------------------------------------------- canvas ripples
  const rippleMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: { uFade: { value: 0 }, uColour: { value: COLOURS.rosin } },
    vertexShader: `
      varying float vBand;
      void main() {
        vBand = clamp((length(position.xy) - 0.80) / 0.20, 0.0, 1.0);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform float uFade;
      uniform vec3 uColour;
      varying float vBand;
      void main() {
        gl_FragColor = vec4(uColour, sin(vBand * 3.14159) * uFade);
      }`,
  });

  const ripplePool: Pool<RippleSlot> = { items: [], cursor: 0 };
  for (let i = 0; i < 6; i += 1) {
    const material = rippleMaterial.clone();
    const mesh = new THREE.Mesh(new THREE.RingGeometry(0.80, 1.0, 56, 1), material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    mesh.visible = false;
    mesh.userData.isHighlight = true;
    group.add(mesh);
    ripplePool.items.push({ mesh, material, age: 1, span: 1, radius: 1 });
  }

  // -------------------------------------------------------------------------- impact lights
  const lightPool: Pool<LightSlot> = { items: [], cursor: 0 };
  for (let i = 0; i < 3; i += 1) {
    const light = new THREE.PointLight(0xffc27a, 0, 2.4, 2.0);
    light.visible = false;
    light.userData.isHighlight = true;
    group.add(light);
    lightPool.items.push({ light, age: 1, span: 1, peak: 0 });
  }

  // ---------------------------------------------------------------------------- charge glows
  const charges = new Map<Glove, { sprite: THREE.Sprite; material: THREE.SpriteMaterial; amount: number }>();
  for (const glove of ['left', 'right'] as Glove[]) {
    const material = new THREE.SpriteMaterial({
      map: flare, blending: THREE.AdditiveBlending, transparent: true,
      depthWrite: false, opacity: 0, color: COLOURS.amber,
    });
    const sprite = new THREE.Sprite(material);
    sprite.visible = false;
    sprite.renderOrder = 5;
    sprite.userData.isHighlight = true;
    group.add(sprite);
    charges.set(glove, { sprite, material, amount: 0 });
  }

  // ------------------------------------------------------------------------------------ api
  function spawnRing(
    origin: THREE.Vector3, dir: THREE.Vector3,
    from: number, to: number, along: number, span: number,
  ): void {
    const slot = nextFrom(ringPool);
    slot.age = 0;
    slot.span = span;
    slot.from = from;
    slot.to = to;
    slot.along = along;
    slot.dir.copy(dir);
    slot.origin.copy(origin);
    slot.mesh.visible = true;
    slot.mesh.position.copy(origin);
    // A ring whose plane is ACROSS the punch, so it expands as displaced air rather than as a sigil.
    slot.mesh.lookAt(scratchD.copy(origin).add(dir));
  }

  function spawnFlash(at: THREE.Vector3, scale: number, span: number): void {
    const slot = nextFrom(flashPool);
    slot.age = 0;
    slot.span = span;
    slot.scale = scale;
    slot.sprite.visible = true;
    slot.sprite.position.copy(at);
    slot.material.rotation = Math.random() * Math.PI;
  }

  function spawnLight(at: THREE.Vector3, peak: number, span: number): void {
    const slot = nextFrom(lightPool);
    slot.age = 0;
    slot.span = span;
    slot.peak = peak;
    slot.light.visible = true;
    slot.light.position.copy(at);
  }

  function spawnRipple(at: THREE.Vector3, radius: number, span: number): void {
    const slot = nextFrom(ripplePool);
    slot.age = 0;
    slot.span = span;
    slot.radius = radius;
    slot.mesh.visible = true;
    // Just off the canvas: coplanar with the floor disc it would z-fight.
    slot.mesh.position.set(at.x, 0.006, at.z);
  }

  /** Orthonormal frame around `dir`, so cones and spray cones can be aimed without a camera. */
  function frame(dir: THREE.Vector3, outA: THREE.Vector3, outB: THREE.Vector3): void {
    // No allocation: this runs 44 times a frame for the trails alone.
    outA.copy(Math.abs(dir.y) > 0.92 ? sideways : up).cross(dir);
    if (outA.lengthSq() < 1e-9) outA.copy(sideways);
    outA.normalize();
    outB.copy(dir).cross(outA).normalize();
  }

  const vfx: BoxingVfx = {
    group,

    glove(glove, at, strength) {
      const ribbon = ribbons.get(glove)!;
      ribbon.level = strength;
      for (let i = ribbon.history.length - 1; i > 0; i -= 1) {
        ribbon.history[i].copy(ribbon.history[i - 1]);
      }
      ribbon.history[0].copy(at);
      ribbon.filled = Math.min(ribbon.filled + 1, TRAIL_SAMPLES);
    },

    charge(glove, at, amount) {
      const slot = charges.get(glove)!;
      slot.amount = amount;
      slot.sprite.position.copy(at);
      if (amount > 0.02) {
        slot.sprite.visible = true;
        slot.material.opacity = amount * 0.5;
        const scale = 0.10 + amount * 0.16;
        slot.sprite.scale.set(scale, scale, scale);
        // Sparks drawn INWARD: the charge gathers rather than leaks, which is what makes the
        // release read as a release. Rate rises with the windup so the last frames crackle.
        if (Math.random() < amount * amount * 0.85) {
          const theta = Math.random() * Math.PI * 2;
          const radius = 0.13 + Math.random() * 0.10;
          const ox = Math.cos(theta) * radius;
          const oy = (Math.random() - 0.5) * 0.20;
          const oz = Math.sin(theta) * radius;
          // Velocity aimed back at the glove, timed to arrive as the punch lands.
          emitHot('spark', at.x + ox, at.y + oy, at.z + oz, -ox * 4.2, -oy * 4.2, -oz * 4.2, 0.7);
        }
      } else {
        slot.sprite.visible = false;
      }
    },

    punch(kind, at, dir, power) {
      const shape = PUNCH_SHAPE[kind];
      const scale = 0.75 + power * 0.5;

      // --- wind tear: an open cone left in the air along the travel, apex at the glove.
      const tear = nextFrom(tearPool);
      tear.age = 0;
      tear.span = 0.24;
      tear.length = shape.tearLength * scale;
      tear.radius = shape.tearRadius * scale;
      tear.mesh.visible = true;
      // Cone apex is +Y in local space; aim +Y down the punch so the shell opens behind the glove.
      tear.mesh.quaternion.setFromUnitVectors(up, dir);
      tear.origin.copy(at);
      tear.dir.copy(dir);
      if (shape.shear > 0) {
        // A hook arcs, so its tear leans across the travel instead of sitting square on it.
        frame(dir, scratchB, scratchC);
        tear.origin.addScaledVector(scratchB, tear.radius * shape.shear * 0.9);
      }

      // --- the stop itself.
      spawnFlash(at, shape.flashScale * scale, 0.16);
      for (let i = 0; i < shape.ringCount; i += 1) {
        const delay = i * 0.35;
        spawnRing(
          scratchA.copy(at).addScaledVector(dir, -0.02 - i * 0.05), dir,
          0.04 + i * 0.03, (shape.ringSpan + i * 0.06) * scale, (0.20 + i * 0.16) * scale,
          0.18 + delay * 0.08,
        );
      }
      const lines = nextFrom(linePool);
      lines.age = 0;
      lines.span = 0.15;
      lines.reach = shape.lineReach * scale;
      lines.mesh.visible = true;
      lines.mesh.position.copy(at);
      // The rosette is authored on a unit circle; the reach is its radius in world units.
      lines.mesh.scale.setScalar(lines.reach);
      lines.mesh.lookAt(scratchD.copy(at).add(dir));
      spawnLight(at, shape.light * (0.7 + power * 0.5), 0.15);

      // --- sparks off the knuckles, thrown forward and sideways out of the stop.
      frame(dir, scratchB, scratchC);
      for (let i = 0; i < Math.round(shape.sparks * scale); i += 1) {
        const theta = Math.random() * Math.PI * 2;
        const spread = Math.random() * 0.9 + 0.15;
        const speed = 1.4 + Math.random() * 3.4;
        scratchA.copy(dir).multiplyScalar(0.55 + Math.random() * 0.6)
          .addScaledVector(scratchB, Math.cos(theta) * spread)
          .addScaledVector(scratchC, Math.sin(theta) * spread)
          .normalize().multiplyScalar(speed);
        emitHot('spark', at.x, at.y, at.z, scratchA.x, scratchA.y, scratchA.z);
      }

      // --- sweat spray: a forward cone off the contact, wider for a hook.
      for (let i = 0; i < Math.round(shape.spray * scale); i += 1) {
        const theta = Math.random() * Math.PI * 2;
        const spread = Math.random() * shape.sprayCone;
        const speed = 1.1 + Math.random() * 2.6;
        scratchA.copy(dir).multiplyScalar(0.8)
          .addScaledVector(scratchB, Math.cos(theta) * spread)
          .addScaledVector(scratchC, Math.sin(theta) * spread)
          .normalize().multiplyScalar(speed);
        emitHot(
          'spray',
          at.x + (Math.random() - 0.5) * 0.05,
          at.y + (Math.random() - 0.5) * 0.05,
          at.z + (Math.random() - 0.5) * 0.05,
          scratchA.x, scratchA.y + 0.8, scratchA.z,
        );
      }

      // --- the floor. Only punches that put weight through the canvas get it.
      if (shape.ripple > 0) {
        spawnRipple(at, shape.ripple * scale, 0.55);
        for (let i = 0; i < 12; i += 1) {
          const theta = Math.random() * Math.PI * 2;
          const speed = 0.4 + Math.random() * 0.7;
          emitDust(
            'rosin',
            at.x + Math.cos(theta) * 0.1, 0.02, at.z + Math.sin(theta) * 0.1,
            Math.cos(theta) * speed, 0.25 + Math.random() * 0.3, Math.sin(theta) * speed,
            0.8, 0.7,
          );
        }
      }

      return shape.hitstop;
    },

    footfall(at, drop) {
      // Measured descent in figure heights per second: 0.2 is a rolling step, 2.0 a landed hop.
      const weight = Math.min(1, drop / 1.9);
      const count = 8 + Math.round(weight * 20);
      for (let i = 0; i < count; i += 1) {
        const theta = Math.random() * Math.PI * 2;
        const speed = (0.25 + Math.random() * 0.75) * (0.5 + weight);
        emitDust(
          'rosin',
          at.x + Math.cos(theta) * 0.05, Math.max(0.01, at.y * 0.4), at.z + Math.sin(theta) * 0.05,
          Math.cos(theta) * speed, 0.10 + Math.random() * 0.25 * weight, Math.sin(theta) * speed,
          0.7 + weight * 0.6, 0.55 + weight * 0.45,
        );
      }
      if (weight > 0.45) {
        spawnRipple(at, 0.28 + weight * 0.42, 0.42);
        // A heavy landing also flicks grit up as a few bright specks, which is what sells the weight.
        for (let i = 0; i < Math.round(weight * 8); i += 1) {
          const theta = Math.random() * Math.PI * 2;
          const speed = 0.6 + Math.random() * 1.2;
          emitHot('spark', at.x, 0.02, at.z,
            Math.cos(theta) * speed, 0.5 + Math.random() * 0.9, Math.sin(theta) * speed, 0.55);
        }
      }
    },

    absorb(at, dir, power) {
      // No knuckle flash and no speed lines: nothing here is being thrown. The blow arrives, the
      // body folds around it, and what leaves the figure is sweat going the way the punch went.
      spawnFlash(at, 0.22 + power * 0.14, 0.20);
      spawnRing(at, dir, 0.06, 0.46 + power * 0.2, 0.10, 0.34);
      spawnLight(at, 5.0 + power * 4.0, 0.20);
      frame(dir, scratchB, scratchC);
      for (let i = 0; i < 26; i += 1) {
        const theta = Math.random() * Math.PI * 2;
        const spread = 0.35 + Math.random() * 0.95;
        const speed = 0.9 + Math.random() * 2.2;
        scratchA.copy(dir).multiplyScalar(0.45)
          .addScaledVector(scratchB, Math.cos(theta) * spread)
          .addScaledVector(scratchC, Math.sin(theta) * spread)
          .normalize().multiplyScalar(speed);
        emitHot('spray', at.x, at.y, at.z, scratchA.x, scratchA.y + 1.1, scratchA.z);
      }
      for (let i = 0; i < 10; i += 1) {
        const theta = Math.random() * Math.PI * 2;
        emitHot('spark', at.x, at.y, at.z,
          Math.cos(theta) * (0.6 + Math.random()), 0.4 + Math.random(), Math.sin(theta) * (0.6 + Math.random()), 0.7);
      }
    },

    sweat(at, count) {
      for (let i = 0; i < count; i += 1) {
        const theta = Math.random() * Math.PI * 2;
        const speed = 0.35 + Math.random() * 0.9;
        emitHot(
          'spray',
          at.x + (Math.random() - 0.5) * 0.09,
          at.y + (Math.random() - 0.5) * 0.09,
          at.z + (Math.random() - 0.5) * 0.09,
          Math.cos(theta) * speed, 0.5 + Math.random() * 0.7, Math.sin(theta) * speed,
          0.8,
        );
      }
    },

    breathe(at, forward) {
      for (let i = 0; i < 5; i += 1) {
        scratchA.copy(forward).multiplyScalar(0.20 + Math.random() * 0.25);
        emitDust(
          'breath',
          at.x + forward.x * 0.09 + (Math.random() - 0.5) * 0.04,
          at.y + 0.01 + (Math.random() - 0.5) * 0.03,
          at.z + forward.z * 0.09 + (Math.random() - 0.5) * 0.04,
          scratchA.x, 0.10 + Math.random() * 0.10, scratchA.z,
          0.7 + Math.random() * 0.5, 1,
        );
      }
    },

    update(dt) {
      const step = Math.min(0.05, Math.max(0, dt));

      // --- hot particles
      let hotLive = false;
      for (let i = 0; i < HOT_CAPACITY; i += 1) {
        if (hot.age[i] >= 1) { hotLife[i] = 1; continue; }
        hotLive = true;
        const decay = Math.max(0, 1 - hot.drag[i] * step);
        hot.vx[i] *= decay;
        hot.vz[i] *= decay;
        hot.vy[i] = hot.vy[i] * decay - hot.gravity[i] * step;
        hot.px[i] += hot.vx[i] * step;
        hot.py[i] += hot.vy[i] * step;
        hot.pz[i] += hot.vz[i] * step;
        // The canvas is a floor, not a suggestion: droplets stop on it instead of falling through.
        if (hot.py[i] < 0.004) {
          hot.py[i] = 0.004;
          hot.vx[i] *= 0.35;
          hot.vz[i] *= 0.35;
          hot.vy[i] = 0;
          hot.age[i] = Math.max(hot.age[i], 0.78);
        }
        hot.age[i] += step / hot.span[i];
        const life = Math.min(1, hot.age[i]);
        hotLife[i] = life;
        hotPosition[i * 3] = hot.px[i];
        hotPosition[i * 3 + 1] = hot.py[i];
        hotPosition[i * 3 + 2] = hot.pz[i];
        hotVel[i * 3] = hot.vx[i];
        hotVel[i * 3 + 1] = hot.vy[i];
        hotVel[i * 3 + 2] = hot.vz[i];
      }
      hotPoints.visible = hotLive;
      if (hotLive) {
        hotAttr.position.needsUpdate = true;
        hotAttr.life.needsUpdate = true;
        hotAttr.size.needsUpdate = true;
        hotAttr.tint.needsUpdate = true;
        hotAttr.vel.needsUpdate = true;
        hotAttr.stretch.needsUpdate = true;
      }

      // --- dust
      let dustLive = false;
      for (let i = 0; i < DUST_CAPACITY; i += 1) {
        if (dust.age[i] >= 1) { dustLife[i] = 1; continue; }
        dustLive = true;
        const decay = Math.max(0, 1 - dust.drag[i] * step);
        dust.vx[i] *= decay;
        dust.vz[i] *= decay;
        dust.vy[i] = dust.vy[i] * decay - dust.gravity[i] * step;
        dust.px[i] += dust.vx[i] * step;
        dust.py[i] += dust.vy[i] * step;
        dust.pz[i] += dust.vz[i] * step;
        dust.age[i] += step / dust.span[i];
        const life = Math.min(1, dust.age[i]);
        dustLife[i] = life;
        dustSize[i] = dust.base[i] * (1 + life * (dust.growth[i] - 1));
        dustPosition[i * 3] = dust.px[i];
        dustPosition[i * 3 + 1] = dust.py[i];
        dustPosition[i * 3 + 2] = dust.pz[i];
      }
      dustPoints.visible = dustLive;
      if (dustLive) {
        dustAttr.position.needsUpdate = true;
        dustAttr.life.needsUpdate = true;
        dustAttr.size.needsUpdate = true;
        dustAttr.tint.needsUpdate = true;
        dustAttr.alpha.needsUpdate = true;
        dustAttr.spin.needsUpdate = true;
      }

      // --- glove trails
      for (const ribbon of ribbons.values()) {
        if (ribbon.filled < 3 || ribbon.level <= 0.001) {
          ribbon.mesh.visible = false;
          continue;
        }
        ribbon.mesh.visible = true;
        const positions = ribbon.position.array as Float32Array;
        const strengths = ribbon.strength.array as Float32Array;
        for (let i = 0; i < TRAIL_SAMPLES; i += 1) {
          const clamped = Math.min(i, ribbon.filled - 1);
          const point = ribbon.history[clamped];
          const ahead = ribbon.history[Math.max(0, clamped - 1)];
          const behind = ribbon.history[Math.min(ribbon.filled - 1, clamped + 1)];
          scratchA.copy(ahead).sub(behind);
          if (scratchA.lengthSq() < 1e-9) scratchA.set(0, 1, 0);
          scratchA.normalize();
          frame(scratchA, scratchB, scratchC);
          // Taper from the glove back along the trail, and thin the whole ribbon at low speed.
          const along = 1 - i / (TRAIL_SAMPLES - 1);
          const width = (0.006 + 0.020 * ribbon.level) * Math.pow(along, 0.80);
          const fade = ribbon.level * Math.pow(along, 1.35);
          const base = i * 4;
          for (let k = 0; k < 4; k += 1) {
            const side = k % 2 === 0 ? 1 : -1;
            const axis = k < 2 ? scratchB : scratchC;
            positions[(base + k) * 3] = point.x + axis.x * width * side;
            positions[(base + k) * 3 + 1] = point.y + axis.y * width * side;
            positions[(base + k) * 3 + 2] = point.z + axis.z * width * side;
            strengths[base + k] = fade;
          }
        }
        ribbon.position.needsUpdate = true;
        ribbon.strength.needsUpdate = true;
        // Decays on its own, so a trail left behind by a stopped hand retracts instead of freezing.
        ribbon.level = Math.max(0, ribbon.level - step * 3.6);
      }

      // --- wind tears
      for (const tear of tearPool.items) {
        if (tear.age >= 1) { tear.mesh.visible = false; continue; }
        tear.age += step / tear.span;
        const life = Math.min(1, tear.age);
        // Opens fast, then thins out as it dissipates.
        const open = Math.pow(life, 0.45);
        const height = tear.length * (0.55 + open * 0.85);
        const girth = tear.radius * (0.35 + open * 1.5);
        tear.mesh.scale.set(girth, height, girth);
        // Apex pinned to the contact: the local apex sits at +0.5 in a unit cone, so the centre has
        // to slide back by half the CURRENT height every frame, not by half the authored length.
        tear.mesh.position.copy(tear.origin).addScaledVector(tear.dir, -height * 0.5);
        tear.material.uniforms.uFade.value = Math.sin((1 - life) * Math.PI * 0.85);
      }

      // --- shock rings
      for (const ring of ringPool.items) {
        if (ring.age >= 1) { ring.mesh.visible = false; continue; }
        ring.age += step / ring.span;
        const life = Math.min(1, ring.age);
        const eased = 1 - Math.pow(1 - life, 2.2);
        const radius = ring.from + (ring.to - ring.from) * eased;
        ring.mesh.scale.set(radius, radius, radius);
        // Rings travel with the punch as they open, so the pressure wave leaves the glove behind.
        ring.mesh.position.copy(ring.origin).addScaledVector(ring.dir, ring.along * eased);
        // A collar of displaced air, not a sigil: it is gone before the eye can call it a circle.
        ring.material.uniforms.uFade.value = Math.pow(1 - life, 1.7) * 0.34;
      }

      // --- speed lines
      for (const lines of linePool.items) {
        if (lines.age >= 1) { lines.mesh.visible = false; continue; }
        lines.age += step / lines.span;
        const life = Math.min(1, lines.age);
        lines.material.uniforms.uPush.value = (1 - Math.pow(1 - life, 3)) * 1.0;
        // In LOCAL units now that the mesh carries the scale, so the push cannot double-apply it.
        lines.material.uniforms.uReach.value = 0.55;
        lines.material.uniforms.uFade.value = Math.pow(1 - life, 1.1) * 0.34;
      }

      // --- flashes
      for (const flash of flashPool.items) {
        if (flash.age >= 1) { flash.sprite.visible = false; continue; }
        flash.age += step / flash.span;
        const life = Math.min(1, flash.age);
        // Full brightness on the first frame, gone in six: this is the layer the eye reads as force.
        const scale = flash.scale * (0.55 + life * 1.15);
        flash.sprite.scale.set(scale, scale, scale);
        flash.material.opacity = Math.pow(1 - life, 1.8);
      }

      // --- canvas ripples
      for (const ripple of ripplePool.items) {
        if (ripple.age >= 1) { ripple.mesh.visible = false; continue; }
        ripple.age += step / ripple.span;
        const life = Math.min(1, ripple.age);
        const radius = ripple.radius * (0.18 + (1 - Math.pow(1 - life, 2.4)) * 0.9);
        ripple.mesh.scale.set(radius, radius, radius);
        ripple.material.uniforms.uFade.value = Math.pow(1 - life, 1.7) * 0.22;
      }

      // --- impact lights
      for (const slot of lightPool.items) {
        if (slot.age >= 1) { slot.light.visible = false; slot.light.intensity = 0; continue; }
        slot.age += step / slot.span;
        const life = Math.min(1, slot.age);
        // A 15 ms rise and a 130 ms fall — the shape of a strobe, not of a lamp.
        const shape = life < 0.1 ? life / 0.1 : Math.pow(1 - (life - 0.1) / 0.9, 2.0);
        slot.light.intensity = slot.peak * shape;
      }

      // --- charge glows decay unless the scheduler keeps feeding them
      for (const slot of charges.values()) {
        slot.amount = Math.max(0, slot.amount - step * 3.4);
        slot.material.opacity = slot.amount * 0.5;
        if (slot.amount <= 0.02) slot.sprite.visible = false;
      }
    },

    counts() {
      let hotLive = 0;
      for (let i = 0; i < HOT_CAPACITY; i += 1) if (hot.age[i] < 1) hotLive += 1;
      let dustLive = 0;
      for (let i = 0; i < DUST_CAPACITY; i += 1) if (dust.age[i] < 1) dustLive += 1;
      return {
        hot: hotLive,
        dust: dustLive,
        rings: ringPool.items.filter((slot) => slot.age < 1).length,
        tears: tearPool.items.filter((slot) => slot.age < 1).length,
        flashes: flashPool.items.filter((slot) => slot.age < 1).length,
      };
    },

    dispose() {
      group.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const material = (object as THREE.Mesh).material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else if (material) (material as THREE.Material).dispose();
      });
      spark.dispose();
      puff.dispose();
      flare.dispose();
    },
  };

  return vfx;
}
