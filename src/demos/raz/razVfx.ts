import * as THREE from 'three';
import { MeshoptSimplifier } from 'meshoptimizer';
import type { JadeBlock, StrikeKind } from './strikeEvents';

/**
 * The jade effects layer: four crystals that burn all the time, and detonate when they land.
 *
 * WHAT THE REFERENCE ASKS FOR. The photograph the figure was measured from puts faceted emerald
 * crystal on the knuckles of both fists and under both boot soles, and nothing else on the model is
 * that colour. So the brief — every punch and kick detonates, and the crystals smoke green fire — is
 * really one idea in two states: the crystals are ALWAYS burning, and an impact is that same fire
 * arriving all at once. Everything here is built out of the same three greens for that reason. A
 * separate palette for the explosion would read as a second, unrelated effect stuck onto the model.
 *
 * WHY POINTS AND NOT SPRITES. Fire and smoke want hundreds of particles. Three hundred Sprites is
 * three hundred draw calls and three hundred matrix updates a frame; the two `THREE.Points` clouds
 * here are two draw calls and a handful of typed-array writes, which is what lets the plumes run at
 * full density on a phone. What Points cannot do is rotate, so the streak that makes a fast-moving
 * ember read as a streak is done in the shader: the velocity is projected into view space and the
 * fragment stretches `gl_PointCoord` along it.
 *
 * WHY THE PLUME IS ALSO THE TRAIL. An early pass drew a separate swept ribbon behind a moving fist.
 * It was redundant: emission is proportional to limb speed and every ember inherits a share of the
 * limb's velocity, so a fist at 2.6 H/s already lays down a comet of green fire on its own, in the
 * same particles, with the same light and the same fade. The ribbon was a second trail drawn over
 * the first one.
 *
 * NOTHING IS ALLOCATED AFTER CONSTRUCTION. Every pool is fixed-size and every object starts
 * invisible, so the viewer's one-shot framing pass never measures an effect and a long session
 * never grows. `group.userData.isHighlight` keeps the whole layer out of the parts list, out of the
 * explode layout and out of the capture framing.
 */

/**
 * Fire wants far more particles than smoke, and smoke lives three times longer than fire. These are
 * sized for a three-punch combination at 60 fps with all four crystals lit: measured in the browser,
 * the plumes alone hold 200-300 embers and 100-150 puffs at rest, and a snap kick peaks near 300
 * embers, 140 puffs and 31 shards — so the pools are set about three times the resting load, which
 * leaves room for two detonations overlapping without recycling a live particle.
 */
/**
 * Afterimages keep Raz's full skin weights but draw a coherent meshoptimizer reduction of the
 * surface. Four 36k-triangle ghosts peak at 144k extra triangles instead of the old five full-shell
 * copies adding 1.43M. Simplifying only the index buffer preserves the authored positions, skin
 * weights and frozen pose while keeping each echo readable as one continuous silhouette.
 */
const GHOST_COUNT = 4;
const GHOST_LIFE = 0.30;
const GHOST_TRIANGLE_BUDGET = 36_000;

const EMBER_CAPACITY = 720;
const SMOKE_CAPACITY = 400;
const SHARD_CAPACITY = 96;

/**
 * Combined radius two balls annihilate within, world units. Each core is about 0.2 across, and the
 * two leave limbs at different heights — Raz's boot reaches 1.86 and Roblin's 1.55 — so this has to
 * cover the height difference as well as the cores.
 */
const COLLIDE_RADIUS = 0.5;

/**
 * The three greens, sampled off the reference: the near-white heart of the crystal, the emerald the
 * knuckle blocks glow at, and the dark jade the smoke settles to.
 */
const COLOURS = {
  core: new THREE.Color(0xe8fff1),
  flame: new THREE.Color(0x3dff8c),
  jade: new THREE.Color(0x0c8a4c),
  // The smoke is alpha-blended, not additive, so its hot end has to be LIGHTER than the stage or it
  // cannot be seen against it at all — two passes at a dark jade smoke rendered as literally nothing.
  smokeHot: new THREE.Color(0x6ee0a4),
  smokeCold: new THREE.Color(0x17452c),
  shard: new THREE.Color(0x62ffae),
  /**
   * Roblin's half of the palette. The duel puts two fighters on one effects layer, and a ball thrown
   * by each has to be told apart in flight — so the projectile carries a tint, jade for Raz and the
   * lime his own exhibit is lit in for Roblin. Everything else stays one palette: an IMPACT is the
   * stage's, not a fighter's.
   */
  limeCore: new THREE.Color(0xd8ff9e),
  lime: new THREE.Color(0x9dff3c),
  limeDeep: new THREE.Color(0x3f7a0e),
};

export type Tint = 'jade' | 'lime';

/**
 * Per-kind shaping. The four kinds differ in GEOMETRY first and brightness second — an impact that
 * differs from another only by being brighter is the same impact twice.
 */
const STRIKE_SHAPE: Record<StrikeKind, {
  /** Expanding shock rings, and how far the last one gets, in world units. */
  rings: number; ringSpan: number;
  /** Roll of the ring plane away from the travel axis. A hook lands across, not along. */
  ringRoll: number;
  embers: number; smoke: number; shards: number;
  /** Half-angle of the ejection cone, radians. A hook fans, a straight drills. */
  cone: number;
  flash: number; light: number;
  /** Ground ripple radius; 0 for a blow that puts no weight through the floor. */
  ripple: number;
  /** Seconds of hitstop. The single largest contributor to how hard a blow reads. */
  hitstop: number;
}> = {
  straight: {
    rings: 1, ringSpan: 0.30, ringRoll: 0.0,
    embers: 42, smoke: 14, shards: 9,
    cone: 0.52, flash: 0.26, light: 7, ripple: 0, hitstop: 0.045,
  },
  cross: {
    rings: 2, ringSpan: 0.46, ringRoll: 0.0,
    embers: 78, smoke: 26, shards: 18,
    cone: 0.68, flash: 0.40, light: 15, ripple: 0.90, hitstop: 0.085,
  },
  hook: {
    rings: 2, ringSpan: 0.38, ringRoll: 0.85,
    embers: 62, smoke: 22, shards: 15,
    cone: 1.00, flash: 0.33, light: 11, ripple: 0.55, hitstop: 0.070,
  },
  kick: {
    // The heaviest of the four by every measure, because the sweep says so: the fastest limb event
    // in the whole set is a boot at 5.22 H/s, more than double the hardest punch.
    rings: 2, ringSpan: 0.58, ringRoll: 0.25,
    embers: 96, smoke: 34, shards: 24,
    cone: 0.80, flash: 0.48, light: 19, ripple: 0.95, hitstop: 0.100,
  },
  knockout: {
    /**
     * The finish, and it earns its size by COUNT and by REACH rather than by being turned up.
     *
     * Three rings where a kick throws two and a straight throws one, so the shock reads as arriving
     * in stages; the span past a figure height, so the outermost is still travelling when the first
     * has gone; a cone just under a right angle, which throws shrapnel almost sideways instead of
     * down the travel; and the deepest floor coupling in the table, because this is the one blow in
     * the demo thrown straight UP — 81 degrees of elevation through the head line — so its whole
     * reaction goes down the standing leg into the floor.
     *
     * The hitstop is 130 ms: still the longest impact in the set, but short enough that a 1.15x
     * uppercut does not look like the whole renderer stalled at contact.
     */
    rings: 3, ringSpan: 0.72, ringRoll: 0.18,
    embers: 140, smoke: 48, shards: 34,
    cone: 0.92, flash: 0.60, light: 26, ripple: 1.25, hitstop: 0.130,
  },
};

/** Build one shared, low-cost skinned surface for every speed echo. */
function buildGhostGeometry(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const geometry = source.clone();
  const index = source.index;
  if (!index) return geometry;
  const triangleCount = Math.floor(index.count / 3);
  if (triangleCount <= GHOST_TRIANGLE_BUDGET) return geometry;
  const sourceIndex = index.array instanceof Uint32Array
    ? index.array
    : new Uint32Array(index.array as ArrayLike<number>);
  const position = source.getAttribute('position');
  const positions = position.array instanceof Float32Array
    ? position.array
    : new Float32Array(position.array as ArrayLike<number>);
  const [reduced] = MeshoptSimplifier.simplify(
    sourceIndex,
    positions,
    position.itemSize,
    GHOST_TRIANGLE_BUDGET * 3,
    1e-2,
    ['LockBorder'],
  );
  geometry.setIndex(new THREE.BufferAttribute(reduced, 1));
  return geometry;
}

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
  gradient.addColorStop(coreBias, 'rgba(255,255,255,0.70)');
  gradient.addColorStop(0.64, 'rgba(255,255,255,0.18)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** A white-hot heart inside an emerald skirt — the flash, the crystal glow and the charge all ride this. */
function flareTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.13, 'rgba(232,255,241,0.94)');
  g.addColorStop(0.32, 'rgba(61,255,140,0.52)');
  g.addColorStop(0.60, 'rgba(12,138,76,0.16)');
  g.addColorStop(1, 'rgba(12,138,76,0)');
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
  delay: number;
}

interface RippleSlot {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  age: number;
  span: number;
  radius: number;
}

interface FlashSlot {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  age: number;
  span: number;
  scale: number;
}

interface LightSlot {
  light: THREE.PointLight;
  age: number;
  span: number;
  power: number;
}

/**
 * A thrown fireball: the crystal fire leaving the boot as a body of its own.
 *
 * FLAT AND FAST. An earlier pass lobbed it on a droop so it would land inside the frame, and a
 * lobbed fireball reads as a thrown object rather than as something fired — it loses the line. So
 * there is no gravity on it at all now: it leaves the boot at speed on a level line and holds it
 * until it detonates 0.55 s later.
 *
 * The short life is the framing, and it was set by tracking the ball's normalised device
 * coordinates rather than by eye. Aimed along the leg the kick actually extends — bearing -107
 * degrees — it recedes and drifts toward the right edge, crossing out of frame at 0.49 s. Two
 * metres of travel over 0.42 s puts the detonation at about 0.90 of the way to that edge: still
 * fully in shot, and still fast enough to read as fired rather than thrown.
 */
interface FireballSlot {
  core: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  halo: THREE.Sprite;
  haloMaterial: THREE.SpriteMaterial;
  position: THREE.Vector3;
  /** Where it was last frame, so a fast ball can lay its tail ALONG the gap instead of in clumps. */
  previous: THREE.Vector3;
  velocity: THREE.Vector3;
  age: number;
  span: number;
  power: number;
  emberDebt: number;
  smokeDebt: number;
  live: boolean;
  tint: Tint;
}

/**
 * One frozen copy of the figure.
 *
 * The trick is the skeleton. A ghost that merely shares the source's `THREE.Skeleton` tracks the
 * live pose and is invisible behind the real mesh — an afterimage has to be a SNAPSHOT. So each
 * ghost gets its own `Skeleton` over the same bones, its `update()` is replaced by a no-op so the
 * renderer's once-per-frame refresh cannot recompute it from the live bones, and capturing is one
 * `Float32Array.set` of the source's bone matrices plus a copy of its world matrix.
 */
interface GhostSlot {
  mesh: THREE.SkinnedMesh;
  skeleton: THREE.Skeleton;
  material: THREE.MeshBasicMaterial;
  age: number;
  /** Frames left to draw at zero opacity so the GPU work happens at load. See `bindGhosts`. */
  prime: number;
  /**
   * Per-capture opacity multiplier, set by the caller.
   *
   * A dash spaces its four captures over a whole push and they barely overlap, so each can afford
   * full strength. A knockout packs the same four into a short burst, where they land almost on top
   * of one another — and this material is ADDITIVE, so overlapping copies at dash strength sum into a
   * bright mass with the figure lost inside it. Turned down, the same four read as what they are: a
   * body the shutter could not resolve.
   */
  gain: number;
}

interface SplitSlot {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  age: number;
  span: number;
  scale: number;
}

interface GlowSlot {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  /** Driven every frame by the plume; decays on its own if the scheduler stops feeding it. */
  level: number;
}

/**
 * Something the projectile can hit.
 *
 * A CAPSULE, not a sphere, because the thing being aimed at is a person: a sphere big enough to
 * catch a ball crossing at chest height also catches one passing over the head, and one tight enough
 * to miss the overhead pass lets a chest-high shot through when the figures are not exactly level.
 * Horizontal radius and vertical half-height are separate for that reason.
 *
 * `at` is read every frame rather than copied, so a moving target needs no re-registration.
 */
export interface ProjectileTarget {
  readonly at: THREE.Vector3;
  readonly radius: number;
  readonly halfHeight: number;
  onHit(where: THREE.Vector3): void;
}

export interface RazVfx {
  group: THREE.Group;
  /**
   * The always-on fire at one crystal. Call it every frame with the block's world position, its
   * world velocity and a 0..1 intensity; emission, streak length and glow all scale from there.
   */
  plume(block: JadeBlock, at: THREE.Vector3, velocity: THREE.Vector3, intensity: number, dt: number): void;
  /** Windup: the crystal gathers light in the moments before a scheduled blow. 0..1. */
  charge(block: JadeBlock, at: THREE.Vector3, amount: number): void;
  /** The detonation. Returns the hitstop, in seconds, for the caller to apply to the mixer. */
  burst(kind: StrikeKind, at: THREE.Vector3, dir: THREE.Vector3, power: number): number;
  /** A crystal sole hitting the floor: embers scatter outward and a ring runs across the ground. */
  footfall(at: THREE.Vector3, drop: number): void;
  /** Throw a ball of fire along `dir`. It burns in flight and detonates where it lands. */
  fireball(at: THREE.Vector3, dir: THREE.Vector3, power: number, tint?: Tint): void;
  /**
   * Called when two balls in flight run into each other, at the point they met. The layer has already
   * detonated both by then; this is for the host to end whatever the two shots were part of.
   */
  onProjectilesCollide(handler: ((at: THREE.Vector3) => void) | null): void;
  /**
   * Two fists arriving at the same point: a rift torn between them, jade on one side and lime on the
   * other, with the crack running out across the floor underneath.
   */
  clash(at: THREE.Vector3, axis: THREE.Vector3, power: number): void;
  /** Give the projectile something to hit, or `null` for a shot that only burns out. */
  setProjectileTarget(target: ProjectileTarget | null): void;
  /**
   * The victory burst: rings out across the floor, a column of fire up the body, and the crystals
   * driven to full roar. Nothing is thrown and nothing is struck — this is the fight being over.
   */
  celebrate(at: THREE.Vector3, power: number): void;
  /**
   * Hand the effects layer the skinned figure so it can build its afterimage ghosts. Safe to call
   * more than once; only the first call builds anything.
   */
  bindGhosts(source: THREE.SkinnedMesh): void;
  /**
   * Freeze the figure's current pose as one afterimage. No-op until `bindGhosts` has run.
   *
   * `gain` scales this capture's opacity; pass below 1 when the captures are packed tightly enough to
   * overlap, because the material is additive and overlapping copies sum. See `GhostSlot.gain`.
   */
  afterimage(gain?: number): void;
  counts(): { embers: number; smoke: number; shards: number; rings: number; fireballs: number; ghosts: number };
  update(dt: number): void;
  dispose(): void;
}

export function createRazVfx(): RazVfx {
  const group = new THREE.Group();
  group.name = 'raz-vfx';
  // Keeps the effects out of the parts list, out of the explode layout and out of the framing pass.
  group.userData.isHighlight = true;

  const emberMap = softTexture(0.20);
  const smokeMap = softTexture(0.46);
  const flare = flareTexture();
  const disposables: Array<{ dispose(): void }> = [emberMap, smokeMap, flare];
  let disposed = false;

  const scratchA = new THREE.Vector3();
  const scratchB = new THREE.Vector3();
  const scratchC = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const forward = new THREE.Vector3(0, 0, 1);
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const matrix = new THREE.Matrix4();
  const instanceColour = new THREE.Color();

  /** A unit vector inside a cone of half-angle `spread` around `dir`. */
  function coneVector(dir: THREE.Vector3, spread: number, out: THREE.Vector3): THREE.Vector3 {
    axis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
    if (axis.lengthSq() < 1e-8) axis.set(1, 0, 0);
    axis.cross(dir);
    if (axis.lengthSq() < 1e-8) axis.set(1, 0, 0).cross(dir);
    axis.normalize();
    return out.copy(dir).applyAxisAngle(axis, (Math.random() * 2 - 1) * spread).normalize();
  }

  // --------------------------------------------------------------------------- embers: the fire
  const ember = {
    px: new Float32Array(EMBER_CAPACITY), py: new Float32Array(EMBER_CAPACITY), pz: new Float32Array(EMBER_CAPACITY),
    vx: new Float32Array(EMBER_CAPACITY), vy: new Float32Array(EMBER_CAPACITY), vz: new Float32Array(EMBER_CAPACITY),
    age: new Float32Array(EMBER_CAPACITY), span: new Float32Array(EMBER_CAPACITY),
    drag: new Float32Array(EMBER_CAPACITY), lift: new Float32Array(EMBER_CAPACITY),
    cursor: 0,
  };
  ember.age.fill(1);
  ember.span.fill(1);

  const emberPosition = new Float32Array(EMBER_CAPACITY * 3);
  const emberLife = new Float32Array(EMBER_CAPACITY).fill(1);
  const emberSize = new Float32Array(EMBER_CAPACITY);
  const emberVel = new Float32Array(EMBER_CAPACITY * 3);
  const emberStretch = new Float32Array(EMBER_CAPACITY);

  const emberGeometry = new THREE.BufferGeometry();
  const emberAttr = {
    position: new THREE.BufferAttribute(emberPosition, 3).setUsage(THREE.DynamicDrawUsage),
    life: new THREE.BufferAttribute(emberLife, 1).setUsage(THREE.DynamicDrawUsage),
    size: new THREE.BufferAttribute(emberSize, 1).setUsage(THREE.DynamicDrawUsage),
    vel: new THREE.BufferAttribute(emberVel, 3).setUsage(THREE.DynamicDrawUsage),
    stretch: new THREE.BufferAttribute(emberStretch, 1).setUsage(THREE.DynamicDrawUsage),
  };
  emberGeometry.setAttribute('position', emberAttr.position);
  emberGeometry.setAttribute('aLife', emberAttr.life);
  emberGeometry.setAttribute('aSize', emberAttr.size);
  emberGeometry.setAttribute('aVel', emberAttr.vel);
  emberGeometry.setAttribute('aStretch', emberAttr.stretch);
  disposables.push(emberGeometry);

  /**
   * The colour ramp is the whole look, and it runs in this order for a reason: a flame is hottest
   * and least saturated at its source and cools INTO its own hue as it rises, so a new ember starts
   * near-white, passes through emerald and dies dark jade. Ramping the other way — jade to white —
   * gives cold sparks that brighten as they leave, which reads as electricity, not fire.
   */
  const emberMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uMap: { value: emberMap },
      uCore: { value: COLOURS.core },
      uFlame: { value: COLOURS.flame },
      uJade: { value: COLOURS.jade },
      uScale: { value: 340 },
    },
    vertexShader: `
      attribute float aLife;
      attribute float aSize;
      attribute vec3 aVel;
      attribute float aStretch;
      uniform float uScale;
      varying float vLife;
      varying vec2 vDir;
      varying float vStretch;
      void main() {
        vLife = aLife;
        vStretch = aStretch;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 velView = (modelViewMatrix * vec4(aVel, 0.0)).xyz;
        float len = length(velView.xy);
        vDir = len > 1e-4 ? velView.xy / len : vec2(1.0, 0.0);
        // Fire tapers as it cools; it does not hold its width and then blink out.
        gl_PointSize = aSize * uScale * (1.0 - aLife * 0.45) / max(0.001, -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform sampler2D uMap;
      uniform vec3 uCore;
      uniform vec3 uFlame;
      uniform vec3 uJade;
      varying float vLife;
      varying vec2 vDir;
      varying float vStretch;
      void main() {
        if (vLife >= 1.0) discard;
        vec2 uv = gl_PointCoord - 0.5;
        // A point sprite cannot be rotated, so rotate the LOOKUP into the velocity frame instead
        // and squash across it. A fist at speed then leaves streaks rather than round dots.
        vec2 frame = vec2(dot(uv, vDir), dot(uv, vec2(-vDir.y, vDir.x)));
        float k = 1.0 + vStretch * 2.6;
        uv = vec2(frame.x / k, frame.y * (1.0 + vStretch * 0.5));
        float mask = texture2D(uMap, uv + 0.5).a;
        vec3 tone = mix(uCore, uFlame, smoothstep(0.0, 0.30, vLife));
        tone = mix(tone, uJade, smoothstep(0.30, 1.0, vLife));
        float fade = 1.0 - vLife;
        gl_FragColor = vec4(tone, mask * fade * fade);
      }`,
  });

  const emberPoints = new THREE.Points(emberGeometry, emberMaterial);
  /**
   * `gl_PointSize` is in FRAMEBUFFER PIXELS, so the world-to-pixel factor has to come from the
   * projection — half the drawing-buffer height over tan(fov/2). A hard-coded constant makes every
   * ember a fraction of a pixel on a 30-degree lens and the whole plume invisible. Read per draw,
   * so it survives a resize, a device-pixel-ratio change and a field-of-view change.
   */
  /**
   * Doubles as the hook that captures the renderer for shader pre-warming — see `warm` below. The
   * effects layer is handed a scene and a camera by the registry, never a renderer, and this is the
   * one callback that is given all three.
   */
  let warmRenderer: THREE.WebGLRenderer | null = null;
  let warmScene: THREE.Scene | null = null;
  let warmCamera: THREE.Camera | null = null;
  let warmPending = false;
  emberPoints.onBeforeRender = (renderer, scene, camera) => {
    emberMaterial.uniforms.uScale.value = pixelScale(renderer, camera);
    warmRenderer = renderer;
    warmScene = scene as THREE.Scene;
    warmCamera = camera;
  };
  emberPoints.frustumCulled = false;
  emberPoints.renderOrder = 6;
  emberPoints.userData.isHighlight = true;
  group.add(emberPoints);
  disposables.push(emberMaterial);

  // -------------------------------------------------------------------------- smoke: the plume
  const smoke = {
    px: new Float32Array(SMOKE_CAPACITY), py: new Float32Array(SMOKE_CAPACITY), pz: new Float32Array(SMOKE_CAPACITY),
    vx: new Float32Array(SMOKE_CAPACITY), vy: new Float32Array(SMOKE_CAPACITY), vz: new Float32Array(SMOKE_CAPACITY),
    age: new Float32Array(SMOKE_CAPACITY), span: new Float32Array(SMOKE_CAPACITY),
    base: new Float32Array(SMOKE_CAPACITY), growth: new Float32Array(SMOKE_CAPACITY),
    alpha: new Float32Array(SMOKE_CAPACITY), spin: new Float32Array(SMOKE_CAPACITY),
    cursor: 0,
  };
  smoke.age.fill(1);
  smoke.span.fill(1);

  const smokePosition = new Float32Array(SMOKE_CAPACITY * 3);
  const smokeLife = new Float32Array(SMOKE_CAPACITY).fill(1);
  const smokeSize = new Float32Array(SMOKE_CAPACITY);
  const smokeAlpha = new Float32Array(SMOKE_CAPACITY);
  const smokeSpin = new Float32Array(SMOKE_CAPACITY);

  const smokeGeometry = new THREE.BufferGeometry();
  const smokeAttr = {
    position: new THREE.BufferAttribute(smokePosition, 3).setUsage(THREE.DynamicDrawUsage),
    life: new THREE.BufferAttribute(smokeLife, 1).setUsage(THREE.DynamicDrawUsage),
    size: new THREE.BufferAttribute(smokeSize, 1).setUsage(THREE.DynamicDrawUsage),
    alpha: new THREE.BufferAttribute(smokeAlpha, 1).setUsage(THREE.DynamicDrawUsage),
    spin: new THREE.BufferAttribute(smokeSpin, 1).setUsage(THREE.DynamicDrawUsage),
  };
  smokeGeometry.setAttribute('position', smokeAttr.position);
  smokeGeometry.setAttribute('aLife', smokeAttr.life);
  smokeGeometry.setAttribute('aSize', smokeAttr.size);
  smokeGeometry.setAttribute('aAlpha', smokeAttr.alpha);
  smokeGeometry.setAttribute('aSpin', smokeAttr.spin);
  disposables.push(smokeGeometry);

  /**
   * The smoke is NOT additive, and that is the difference between smoke and more fire.
   *
   * Additive blending can only ever brighten what is behind it, so an additive puff in front of a
   * dark background is a glow and in front of the figure is a wash — it can never occlude. Smoke
   * has to darken: this is ordinary alpha blending onto a near-black jade, which lets a thick plume
   * genuinely hide the knuckle behind it, and that occlusion is what sells it as mass rather than
   * light. Depth writing stays off so the puffs still sort against each other softly.
   */
  const smokeMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    uniforms: {
      uMap: { value: smokeMap },
      uHot: { value: COLOURS.smokeHot },
      uCold: { value: COLOURS.smokeCold },
      uScale: { value: 340 },
    },
    vertexShader: `
      attribute float aLife;
      attribute float aSize;
      attribute float aAlpha;
      attribute float aSpin;
      uniform float uScale;
      varying float vLife;
      varying float vAlpha;
      varying float vSpin;
      void main() {
        vLife = aLife;
        vAlpha = aAlpha;
        vSpin = aSpin;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uScale / max(0.001, -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform sampler2D uMap;
      uniform vec3 uHot;
      uniform vec3 uCold;
      varying float vLife;
      varying float vAlpha;
      varying float vSpin;
      void main() {
        if (vLife >= 1.0) discard;
        // Every puff is rotated by its own angle. Without it a hundred copies of one round texture
        // stack into a visibly repeating pattern, which is the tell for a cheap smoke system.
        float a = vSpin + vLife * 1.4;
        vec2 uv = gl_PointCoord - 0.5;
        uv = vec2(uv.x * cos(a) - uv.y * sin(a), uv.x * sin(a) + uv.y * cos(a));
        float mask = texture2D(uMap, uv + 0.5).a;
        vec3 tone = mix(uHot, uCold, smoothstep(0.0, 0.55, vLife));
        // Fades in over the first eighth of its life so a puff never pops into being at full size.
        float envelope = smoothstep(0.0, 0.10, vLife) * (1.0 - smoothstep(0.45, 1.0, vLife));
        gl_FragColor = vec4(tone, mask * envelope * vAlpha);
      }`,
  });

  const smokePoints = new THREE.Points(smokeGeometry, smokeMaterial);
  smokePoints.onBeforeRender = (renderer, _scene, camera) => {
    smokeMaterial.uniforms.uScale.value = pixelScale(renderer, camera);
  };
  smokePoints.frustumCulled = false;
  // Under the embers: the fire is inside the smoke column, not painted on top of it.
  smokePoints.renderOrder = 4;
  smokePoints.userData.isHighlight = true;
  group.add(smokePoints);
  disposables.push(smokeMaterial);

  // --------------------------------------------------------------- shards: the crystal shrapnel
  /**
   * The only part of a detonation that is geometry rather than a sprite, because it is the only
   * part that is a SOLID: chips of the crystal itself, thrown off the knuckle and tumbling. Faceted
   * octahedra, stretched along their own flight so each one reads as a splinter, additive so they
   * glow like the block they came off.
   */
  const shardGeometry = new THREE.OctahedronGeometry(1, 0);
  const shardMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const shards = new THREE.InstancedMesh(shardGeometry, shardMaterial, SHARD_CAPACITY);
  shards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  shards.frustumCulled = false;
  shards.renderOrder = 6;
  shards.userData.isHighlight = true;
  shards.count = SHARD_CAPACITY;
  group.add(shards);
  disposables.push(shardGeometry, shardMaterial);

  const shard = {
    px: new Float32Array(SHARD_CAPACITY), py: new Float32Array(SHARD_CAPACITY), pz: new Float32Array(SHARD_CAPACITY),
    vx: new Float32Array(SHARD_CAPACITY), vy: new Float32Array(SHARD_CAPACITY), vz: new Float32Array(SHARD_CAPACITY),
    age: new Float32Array(SHARD_CAPACITY), span: new Float32Array(SHARD_CAPACITY),
    size: new Float32Array(SHARD_CAPACITY),
    tintR: new Float32Array(SHARD_CAPACITY), tintG: new Float32Array(SHARD_CAPACITY), tintB: new Float32Array(SHARD_CAPACITY),
    spinX: new Float32Array(SHARD_CAPACITY), spinY: new Float32Array(SHARD_CAPACITY),
    rotX: new Float32Array(SHARD_CAPACITY), rotY: new Float32Array(SHARD_CAPACITY),
    cursor: 0,
  };
  shard.age.fill(1);
  shard.span.fill(1);
  // Everything starts collapsed to nothing rather than merely dark: an additive instance at scale 0
  // cannot contribute a pixel, which is what keeps the framing pass from ever measuring it.
  matrix.makeScale(0, 0, 0);
  for (let i = 0; i < SHARD_CAPACITY; i += 1) {
    shards.setMatrixAt(i, matrix);
    shards.setColorAt(i, instanceColour.setRGB(0, 0, 0));
  }
  shards.instanceMatrix.needsUpdate = true;
  if (shards.instanceColor) shards.instanceColor.needsUpdate = true;

  // ------------------------------------------------------------------------------- shock rings
  /**
   * The ring plane's NORMAL is the travel direction, so the shock reads as pushed out of the
   * contact rather than drawn around it. `RingGeometry` lies in XY with a +Z normal, which is why
   * the orientation is one `setFromUnitVectors(+Z, travel)`.
   */
  const ringGeometry = new THREE.RingGeometry(0.62, 1.0, 64);
  disposables.push(ringGeometry);
  const rings: Pool<RingSlot> = { items: [], cursor: 0 };
  for (let i = 0; i < 10; i += 1) {
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uCore: { value: COLOURS.core },
        uFlame: { value: COLOURS.flame },
        uFade: { value: 0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uCore;
        uniform vec3 uFlame;
        uniform float uFade;
        varying vec2 vUv;
        void main() {
          // A shock front is bright at its leading edge and trails off inward.
          float band = smoothstep(0.0, 0.45, vUv.y) * (1.0 - smoothstep(0.72, 1.0, vUv.y));
          vec3 tone = mix(uFlame, uCore, smoothstep(0.5, 1.0, vUv.y));
          gl_FragColor = vec4(tone, band * uFade);
        }`,
    });
    const mesh = new THREE.Mesh(ringGeometry, material);
    mesh.visible = false;
    mesh.renderOrder = 7;
    mesh.userData.isHighlight = true;
    group.add(mesh);
    disposables.push(material);
    rings.items.push({ mesh, material, age: 1, span: 1, from: 0, to: 1, delay: 0 });
  }

  // --------------------------------------------------------------------------- ground ripples
  const rippleGeometry = new THREE.RingGeometry(0.55, 1.0, 72);
  disposables.push(rippleGeometry);
  const ripples: Pool<RippleSlot> = { items: [], cursor: 0 };
  for (let i = 0; i < 6; i += 1) {
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: { uFlame: { value: COLOURS.flame }, uFade: { value: 0 } },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uFlame;
        uniform float uFade;
        varying vec2 vUv;
        void main() {
          float band = smoothstep(0.0, 0.55, vUv.y) * (1.0 - smoothstep(0.80, 1.0, vUv.y));
          gl_FragColor = vec4(uFlame, band * uFade * 0.75);
        }`,
    });
    const mesh = new THREE.Mesh(rippleGeometry, material);
    mesh.rotation.x = -Math.PI / 2;
    // Clear of the shadow-catching floor, or the ring z-fights with it along its whole radius.
    mesh.position.y = 0.006;
    mesh.visible = false;
    mesh.renderOrder = 3;
    mesh.userData.isHighlight = true;
    group.add(mesh);
    disposables.push(material);
    ripples.items.push({ mesh, material, age: 1, span: 1, radius: 1 });
  }

  // ------------------------------------------------------------------ the clash rift and crack
  /**
   * Both are one quad with a two-tone shader rather than two meshes butted together: a seam drawn by
   * two objects shows the join the moment either one is even slightly transparent, and both of these
   * are additive. Split in UV space, the seam is a gradient the fragment shader owns, and it can be
   * made white-hot at the meeting line — which is where the eye goes.
   */
  function splitMaterial(vertical: boolean): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uLeft: { value: COLOURS.flame },
        uRight: { value: COLOURS.lime },
        uCore: { value: COLOURS.core },
        uFade: { value: 0 },
        uGrow: { value: 0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uLeft;
        uniform vec3 uRight;
        uniform vec3 uCore;
        uniform float uFade;
        uniform float uGrow;
        varying vec2 vUv;
        void main() {
          vec2 p = vUv - 0.5;
          ${vertical
            ? 'float across = p.x; float along = abs(p.y) * 2.0;'
            : 'float across = p.y; float along = length(p) * 2.0;'}
          // The seam: white-hot at the centre line, falling away into one colour on each side.
          float seam = 1.0 - smoothstep(0.0, 0.10, abs(across));
          vec3 tone = mix(uLeft, uRight, step(0.0, across));
          tone = mix(tone, uCore, seam);
          // Torn open from the middle outward, so the shape grows rather than fading in place.
          float open = smoothstep(uGrow, uGrow - 0.45, along);
          float body = open * (1.0 - smoothstep(0.0, 0.42, abs(across)));
          gl_FragColor = vec4(tone, body * uFade);
        }`,
    });
  }

  const riftGeometry = new THREE.PlaneGeometry(1, 1.6, 1, 1);
  const crackGeometry = new THREE.PlaneGeometry(1, 1, 1, 1);
  disposables.push(riftGeometry, crackGeometry);
  const rifts: Pool<SplitSlot> = { items: [], cursor: 0 };
  const cracks: Pool<SplitSlot> = { items: [], cursor: 0 };
  for (let i = 0; i < 2; i += 1) {
    const riftMaterial = splitMaterial(true);
    const rift = new THREE.Mesh(riftGeometry, riftMaterial);
    rift.visible = false;
    rift.renderOrder = 8;
    rift.userData.isHighlight = true;
    group.add(rift);
    disposables.push(riftMaterial);
    rifts.items.push({ mesh: rift, material: riftMaterial, age: 1, span: 1, scale: 1 });

    const crackMaterial = splitMaterial(false);
    const crack = new THREE.Mesh(crackGeometry, crackMaterial);
    crack.rotation.x = -Math.PI / 2;
    crack.visible = false;
    crack.renderOrder = 4;
    crack.userData.isHighlight = true;
    group.add(crack);
    disposables.push(crackMaterial);
    cracks.items.push({ mesh: crack, material: crackMaterial, age: 1, span: 1, scale: 1 });
  }

  // ---------------------------------------------------------------------------- contact flashes
  const flashes: Pool<FlashSlot> = { items: [], cursor: 0 };
  for (let i = 0; i < 6; i += 1) {
    const material = new THREE.SpriteMaterial({
      map: flare,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0,
    });
    const sprite = new THREE.Sprite(material);
    sprite.visible = false;
    sprite.renderOrder = 8;
    sprite.userData.isHighlight = true;
    group.add(sprite);
    disposables.push(material);
    flashes.items.push({ sprite, material, age: 1, span: 1, scale: 1 });
  }

  // ----------------------------------------------------------------------------- impact lights
  /**
   * Three, not one. A combination lands three blows inside 0.42 s and a single shared light would
   * be yanked from the first contact to the third mid-decay, which reads as a flicker rather than
   * as three separate detonations lighting the figure.
   *
   * NEVER TOGGLED WITH `visible`, AND THIS IS THE WHOLE REASON THE DEMO USED TO STUTTER.
   *
   * three.js builds a material's shader program around the number of lights it can see, and the
   * program cache is keyed on those counts. Hiding and showing a light changes the count, so every
   * material in the scene — including the 286,108-triangle figure's — has to be recompiled, on the
   * frame a blow lands. Profiled in the browser: the steady frame time is 8.3 ms everywhere, but the
   * worst frame was 30.3 ms on the combination and 25.9 ms on the dash, and the renderer's program
   * count climbed 13 -> 21 -> 23 -> 24 as new light counts appeared. Guard Down, the one action that
   * detonates nothing, never went above 9.7 ms.
   *
   * So the lights are visible for the lifetime of the layer and idle at intensity 0. A zero-intensity
   * point light costs a few instructions per fragment; a recompile costs 20 ms in the one frame the
   * viewer is most likely to be looking at.
   */
  const lights: Pool<LightSlot> = { items: [], cursor: 0 };
  for (let i = 0; i < 3; i += 1) {
    const light = new THREE.PointLight(COLOURS.flame.getHex(), 0, 3.2, 2);
    light.userData.isHighlight = true;
    group.add(light);
    lights.items.push({ light, age: 1, span: 1, power: 0 });
  }

  // -------------------------------------------------------------------------- the crystal glows
  /**
   * One persistent sprite per jade block, so the crystal itself is a light source and not merely a
   * place particles come from. It is driven every frame by `plume`, boosted by `charge`, and decays
   * on its own — so if the scheduler ever stops feeding it, it goes out instead of sticking on.
   */
  const glows = new Map<JadeBlock, GlowSlot>();
  for (const block of ['handL', 'handR', 'footL', 'footR'] as JadeBlock[]) {
    const material = new THREE.SpriteMaterial({
      map: flare,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0,
    });
    const sprite = new THREE.Sprite(material);
    sprite.visible = false;
    sprite.renderOrder = 7;
    sprite.userData.isHighlight = true;
    group.add(sprite);
    disposables.push(material);
    glows.set(block, { sprite, material, level: 0 });
  }

  // ------------------------------------------------------------------------------- fireballs
  /**
   * The projectile is a FLAME, not a ball.
   *
   * A sphere thrown at speed reads as a lit rock. What makes something read as fire in flight is an
   * ASYMMETRIC taper: blunt and full at the leading edge, drawn out to nothing behind. The first
   * attempt swept a symmetric teardrop and rendered as a leaf — a pointed ellipse with a hard edge
   * at both ends — so the profile below is built directly against the axis instead: a rounded cap
   * over the front fifth, the widest point just ahead of centre, and a tail four times longer than
   * the head that thins to a point.
   *
   * The hard silhouette is the other half of the problem, and vertex colour solves it. The tail
   * vertices are near-black, and under additive blending near-black contributes nothing — so the
   * tail DISSOLVES into the ember trail instead of ending on a visible edge. No alpha, no sorting.
   */
  const FLAME_SEGMENTS = 26;
  const FLAME_HEAD = 0.80;
  const FLAME_TAIL = -2.60;
  const FLAME_BULB = 0.25;
  const flameProfile: THREE.Vector2[] = [];
  for (let i = 0; i <= FLAME_SEGMENTS; i += 1) {
    const y = FLAME_HEAD - (i / FLAME_SEGMENTS) * (FLAME_HEAD - FLAME_TAIL);
    const radius = y >= FLAME_BULB
      // Front cap: a quarter cosine, so the nose is round rather than pointed.
      ? Math.cos(((y - FLAME_BULB) / (FLAME_HEAD - FLAME_BULB)) * Math.PI * 0.5)
      // Tail: a power curve, long and concave, reaching zero only at the very end. The ratio is
      // clamped at zero because the last step lands on y = -2.6000000000000005 rather than exactly
      // FLAME_TAIL, and `Math.pow` of that hair-negative ratio is NaN — which reaches the lathe's
      // positions, gives the mesh a NaN bounding sphere, and leaves the flame's frustum culling to
      // chance.
      : Math.pow(Math.max(0, (y - FLAME_TAIL) / (FLAME_BULB - FLAME_TAIL)), 1.7);
    flameProfile.push(new THREE.Vector2(Math.max(0.002, radius * 0.62), y));
  }
  /**
   * ONE profile, TWO tinted copies.
   *
   * The nose colour is baked into vertex colours rather than set on the material, because the tail
   * has to fade to nothing at the same time and an additive material with a single colour cannot do
   * both. Two geometries is the cheap way to get two fighters' fire out of one lathe: they share the
   * profile and differ only in the colour attribute, and a launch swaps which one the core points at.
   *
   * Both noses are PALE, not white. Additive blending sums, and three layers land on the same pixels
   * here — the near wall of the lathe, its far wall, and the halo sprite over the top. Tinted
   * near-white the head clipped every channel and came out a flat white blob with a coloured tail.
   */
  function tintedFlame(hot: THREE.Color, cool: THREE.Color): THREE.BufferGeometry {
    const geometry = new THREE.LatheGeometry(flameProfile, 26);
    const position = geometry.getAttribute('position');
    const colours = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i += 1) {
      // 1 at the nose, 0 at the tail tip. Cubed, so only the front third carries real brightness.
      const along = (position.getY(i) - FLAME_TAIL) / (FLAME_HEAD - FLAME_TAIL);
      const heat = Math.pow(along, 3);
      const dim = Math.pow(along, 1.6);
      colours[i * 3] = (cool.r + (hot.r - cool.r) * heat) * dim;
      colours[i * 3 + 1] = (cool.g + (hot.g - cool.g) * heat) * (0.25 + 0.75 * along) * dim;
      colours[i * 3 + 2] = (cool.b + (hot.b - cool.b) * heat) * dim;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    return geometry;
  }
  const FLAME_GEOMETRY: Record<Tint, THREE.BufferGeometry> = {
    jade: tintedFlame(new THREE.Color(0x7dffb4), COLOURS.jade),
    lime: tintedFlame(COLOURS.limeCore, COLOURS.limeDeep),
  };
  const fireballGeometry = FLAME_GEOMETRY.jade;
  disposables.push(FLAME_GEOMETRY.jade, FLAME_GEOMETRY.lime);
  const flameQuaternion = new THREE.Quaternion();
  const flameAxis = new THREE.Vector3();
  const fireballs: Pool<FireballSlot> = { items: [], cursor: 0 };
  for (let i = 0; i < 3; i += 1) {
    /**
     * The solid is JADE, not the near-white the crystals' core is. Additive blending sums, so a
     * white-ish icosahedron under the flare sprite — whose own centre is already white — clipped
     * every channel and the ball came out a flat white disc with a green tail. Green solid plus
     * white flare centre gives what was asked for: fire with a hot heart, in the body's colour.
     */
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      // Both sides: the tail is thin enough that the far wall reads through the near one, which is
      // what gives a swept profile any volume at all.
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      opacity: 0,
    });
    const core = new THREE.Mesh(fireballGeometry, material);
    core.visible = false;
    core.renderOrder = 7;
    core.userData.isHighlight = true;
    const haloMaterial = new THREE.SpriteMaterial({
      map: flare,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0,
    });
    const halo = new THREE.Sprite(haloMaterial);
    halo.visible = false;
    halo.renderOrder = 7;
    halo.userData.isHighlight = true;
    group.add(core, halo);
    disposables.push(material, haloMaterial);
    fireballs.items.push({
      core, material, halo, haloMaterial,
      position: new THREE.Vector3(), previous: new THREE.Vector3(), velocity: new THREE.Vector3(),
      age: 1, span: 1, power: 0, emberDebt: 0, smokeDebt: 0, live: false, tint: 'jade',
    });
  }
  /**
   * ONE light for the projectile, not one per slot. Three balls can exist in the pool but only ever
   * one is in the air — the launch fires once per 2.54 s loop and the ball lives 0.42 s — so three
   * lights would be two permanently dark ones on every material's shader for nothing. Like the impact
   * lights it is never hidden, only dimmed.
   */
  const flightLight = new THREE.PointLight(COLOURS.flame.getHex(), 0, 3.6, 2);
  flightLight.userData.isHighlight = true;
  group.add(flightLight);

  let projectileTarget: ProjectileTarget | null = null;
  let collideHandler: ((at: THREE.Vector3) => void) | null = null;
  function onProjectilesCollide(handler: ((at: THREE.Vector3) => void) | null): void {
    collideHandler = handler;
  }
  function setProjectileTarget(target: ProjectileTarget | null): void {
    projectileTarget = target;
  }

  // ------------------------------------------------------------------------------ afterimages
  const ghosts: Pool<GhostSlot> = { items: [], cursor: 0 };
  let ghostSource: THREE.SkinnedMesh | null = null;

  function bindGhosts(source: THREE.SkinnedMesh): void {
    if (ghostSource) return;
    ghostSource = source;
    // Simplification is WASM-backed. Build the pool when it is ready rather than blocking the rig's
    // first visible frame; calls to `afterimage` are already a safe no-op while the pool is empty.
    void MeshoptSimplifier.ready.then(() => {
      if (disposed) return;
      const ghostGeometry = buildGhostGeometry(source.geometry);
      disposables.push(ghostGeometry);
      for (let i = 0; i < GHOST_COUNT; i += 1) {
        const skeleton = new THREE.Skeleton(source.skeleton.bones, source.skeleton.boneInverses);
        // Built here rather than left to the renderer's first draw: `computeBoneTexture` REPLACES
        // `boneMatrices` with a larger padded array, and a capture written before that swap would be
        // copied into the new array only by luck of ordering.
        skeleton.computeBoneTexture();
        // Frozen. The renderer refreshes every skinned mesh's skeleton once a frame; without this the
        // ghost would recompute from the live bones and sit exactly inside the figure, invisible.
        skeleton.update = () => {};
        const material = new THREE.MeshBasicMaterial({
          color: COLOURS.flame,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          opacity: 0,
        });
        const mesh = new THREE.SkinnedMesh(ghostGeometry, material);
        mesh.bind(skeleton, source.bindMatrix);
        // The world matrix is copied wholesale at capture, so nothing may recompute it afterwards.
        mesh.matrixAutoUpdate = false;
        mesh.matrixWorldAutoUpdate = false;
        mesh.frustumCulled = false;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.visible = false;
        mesh.renderOrder = 5;
        mesh.userData.isHighlight = true;
        group.add(mesh);
        disposables.push(material);
        ghosts.items.push({ mesh, skeleton, material, age: 1, prime: 0, gain: 1 });
      }
    /**
     * Compile every material now rather than on the frame it is first drawn.
     *
     * Holding the light count constant removed the recompiles, and profiling then showed what was
     * left: the FIRST press of Fireball Kick still cost a 17.8 ms frame and the first Dash Punch 25 ms,
     * with the renderer's program count ticking up by one or two each time. Those are the two
     * materials that exist from construction but are not drawn until a button is pressed — the
     * projectile's vertex-coloured lathe and the ghosts' skinned basic material — compiling at the
     * exact moment they are supposed to appear.
     *
     * Deferred to `update` rather than run here because `bindGhosts` is called from `build`, before
     * a renderer exists. The flag is cleared on the first tick that has one.
     */
    warmPending = true;

    /**
     * Draw every ghost once, invisibly, before the viewer can ask for one.
     *
     * Compiling the shader was only half of the first-dash cost. Profiled over four consecutive
     * loops, the FIRST dash paid one 95 ms frame and five of about 25 ms, and every loop after it
     * had nothing over 14 ms at all — the shape of one-time per-mesh GPU setup (each ghost carries
     * its own bone texture), not of a per-frame cost. Four ghosts, four spikes.
     *
     * So each one is captured now and marked to render for two frames at zero opacity. The work
     * lands while the loader is still up instead of on the frame the effect is meant to appear.
     */
      ghosts.items.forEach((slot, index) => {
        afterimage();
        slot.age = 1;
        // STAGGERED, one ghost per frame. Primed together they merely move the whole cost into a
        // single frame at load, which is one hitch instead of several but still a visible one.
        slot.prime = index + 1;
        slot.mesh.visible = false;
        slot.material.opacity = 0;
      });
    }).catch(() => {});
  }

  function afterimage(gain = 1): void {
    const source = ghostSource;
    if (!source) return;
    const slot = nextFrom(ghosts);
    slot.gain = gain;
    // The renderer may not have refreshed the source skeleton yet this frame, and a capture is only
    // as current as the matrices it copies.
    source.skeleton.update();
    slot.skeleton.boneMatrices.set(source.skeleton.boneMatrices);
    if (slot.skeleton.boneTexture) slot.skeleton.boneTexture.needsUpdate = true;
    slot.mesh.matrixWorld.copy(source.matrixWorld);
    slot.mesh.bindMatrix.copy(source.bindMatrix);
    slot.mesh.bindMatrixInverse.copy(source.bindMatrixInverse);
    slot.age = 0;
    slot.mesh.visible = true;
  }

  // ---------------------------------------------------------------------------------- emitters
  /** Fractional emission carried between frames, so a low rate still emits at the right average. */
  const debt = new Map<JadeBlock, { ember: number; smoke: number }>();
  for (const block of ['handL', 'handR', 'footL', 'footR'] as JadeBlock[]) {
    debt.set(block, { ember: 0, smoke: 0 });
  }

  function spawnEmber(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    span: number, size: number, stretch: number, drag: number, lift: number,
  ): void {
    const i = ember.cursor;
    ember.cursor = (ember.cursor + 1) % EMBER_CAPACITY;
    ember.px[i] = x; ember.py[i] = y; ember.pz[i] = z;
    ember.vx[i] = vx; ember.vy[i] = vy; ember.vz[i] = vz;
    ember.age[i] = 0; ember.span[i] = span;
    ember.drag[i] = drag; ember.lift[i] = lift;
    emberSize[i] = size;
    emberStretch[i] = stretch;
  }

  function spawnSmoke(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    span: number, base: number, growth: number, alpha: number,
  ): void {
    const i = smoke.cursor;
    smoke.cursor = (smoke.cursor + 1) % SMOKE_CAPACITY;
    smoke.px[i] = x; smoke.py[i] = y; smoke.pz[i] = z;
    smoke.vx[i] = vx; smoke.vy[i] = vy; smoke.vz[i] = vz;
    smoke.age[i] = 0; smoke.span[i] = span;
    smoke.base[i] = base; smoke.growth[i] = growth;
    smoke.alpha[i] = alpha;
    smoke.spin[i] = Math.random() * Math.PI * 2;
  }

  function spawnShard(
    at: THREE.Vector3, dir: THREE.Vector3, speed: number, size: number,
    colour: THREE.Color = COLOURS.shard,
  ): void {
    const i = shard.cursor;
    shard.cursor = (shard.cursor + 1) % SHARD_CAPACITY;
    shard.px[i] = at.x; shard.py[i] = at.y; shard.pz[i] = at.z;
    shard.vx[i] = dir.x * speed; shard.vy[i] = dir.y * speed; shard.vz[i] = dir.z * speed;
    shard.age[i] = 0;
    shard.span[i] = 0.34 + Math.random() * 0.30;
    shard.size[i] = size;
    shard.tintR[i] = colour.r; shard.tintG[i] = colour.g; shard.tintB[i] = colour.b;
    shard.spinX[i] = (Math.random() - 0.5) * 22;
    shard.spinY[i] = (Math.random() - 0.5) * 22;
    shard.rotX[i] = Math.random() * Math.PI;
    shard.rotY[i] = Math.random() * Math.PI;
  }

  // --------------------------------------------------------------------------------------- api
  function plume(block: JadeBlock, at: THREE.Vector3, velocity: THREE.Vector3, intensity: number, dt: number): void {
    const strength = Math.min(1, Math.max(0, intensity));
    const carried = debt.get(block)!;
    const foot = block === 'footL' || block === 'footR';
    // A boot sole is a wider, flatter crystal than a knuckle block, and sits closer to the floor.
    const radius = foot ? 0.055 : 0.045;

    /**
     * Emission is quadratic in strength, not linear. A linear ramp spends most of its range looking
     * the same: the eye reads brightness and density logarithmically, so doubling the count at low
     * intensity is barely visible while the top of the range washes out. Squaring puts the visible
     * change where the motion actually is — the difference between a guard held still and a fist at
     * 2.6 H/s.
     */
    const drive = strength * strength;
    const emberRate = 56 + drive * 280;
    /**
     * The CONSTANT term is the brief, not a floor to be minimised: these crystals burn whether or
     * not the figure is moving, so a planted boot still throws 72 embers and 40 puffs a second. Only
     * the term multiplied by `drive` is the trail.
     *
     * Smoke is DENSE and SMALL rather than sparse and large. The first pass ran 14 puffs a second at
     * 0.09 world units with a 2 s life and 3.8x growth, and what came out was a dozen soft circles
     * drifting a metre away from the fist — bokeh, not smoke. A plume reads as a plume when the
     * puffs overlap, so the rate went up and everything else came down.
     */
    const smokeRate = 32 + drive * 78;

    carried.ember += emberRate * dt;
    carried.smoke += smokeRate * dt;

    const speed = velocity.length();
    // The streak comes from the crystal's own motion, so a still hand emits round embers.
    const stretch = Math.min(0.9, speed * 0.22);

    let count = Math.floor(carried.ember);
    carried.ember -= count;
    // A frame drop must not become a puff of two hundred embers in one place.
    count = Math.min(count, 22);
    for (let i = 0; i < count; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius;
      spawnEmber(
        at.x + Math.cos(angle) * r,
        at.y + (Math.random() - 0.5) * radius * 1.4,
        at.z + Math.sin(angle) * r,
        // A third of the limb's own velocity: enough to lay a comet behind a fast fist, little
        // enough that the fire still climbs off a slow one instead of being dragged sideways.
        velocity.x * 0.34 + (Math.random() - 0.5) * 0.30,
        velocity.y * 0.34 + 0.42 + Math.random() * 0.55,
        velocity.z * 0.34 + (Math.random() - 0.5) * 0.30,
        0.34 + Math.random() * 0.44,
        0.020 + Math.random() * 0.040 + drive * 0.022,
        stretch,
        3.1,
        // Buoyancy, not anti-gravity: this is hot gas leaving a hot crystal.
        1.35 + Math.random() * 0.9,
      );
    }

    let puffs = Math.floor(carried.smoke);
    carried.smoke -= puffs;
    puffs = Math.min(puffs, 8);
    for (let i = 0; i < puffs; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius * 1.3;
      spawnSmoke(
        at.x + Math.cos(angle) * r,
        at.y + (Math.random() - 0.5) * radius,
        at.z + Math.sin(angle) * r,
        velocity.x * 0.22 + (Math.random() - 0.5) * 0.16,
        velocity.y * 0.22 + 0.22 + Math.random() * 0.22,
        velocity.z * 0.22 + (Math.random() - 0.5) * 0.16,
        0.62 + Math.random() * 0.62,
        0.028 + Math.random() * 0.034,
        1.6 + Math.random() * 1.0,
        0.26 + drive * 0.22,
      );
    }

    const glow = glows.get(block)!;
    glow.sprite.position.copy(at);
    glow.level = Math.max(glow.level, 0.30 + drive * 0.70);
  }

  function charge(block: JadeBlock, at: THREE.Vector3, amount: number): void {
    const level = Math.min(1, Math.max(0, amount));
    const glow = glows.get(block)!;
    glow.sprite.position.copy(at);
    glow.level = Math.max(glow.level, 0.35 + level * 1.25);

    /**
     * The windup pulls INWARD. Embers are spawned on a shell around the crystal and given a
     * velocity pointing back at it, so the moment before a blow lands reads as the fire being
     * gathered rather than as more of the same fire leaking out.
     */
    const gathered = Math.round(level * 5);
    for (let i = 0; i < gathered; i += 1) {
      const dir = coneVector(up, Math.PI, scratchA);
      const r = 0.11 + Math.random() * 0.09;
      spawnEmber(
        at.x + dir.x * r, at.y + dir.y * r, at.z + dir.z * r,
        -dir.x * (0.7 + level * 1.4), -dir.y * (0.7 + level * 1.4), -dir.z * (0.7 + level * 1.4),
        0.14 + Math.random() * 0.12,
        0.010 + Math.random() * 0.012,
        0.55,
        1.4,
        0,
      );
    }
  }

  function burst(kind: StrikeKind, at: THREE.Vector3, dir: THREE.Vector3, power: number): number {
    const shape = STRIKE_SHAPE[kind];
    const force = 0.55 + Math.min(1, Math.max(0, power)) * 0.75;
    const travel = scratchC.copy(dir);
    if (travel.lengthSq() < 1e-8) travel.copy(forward);
    travel.normalize();

    // --- fire, thrown forward out of the contact
    const embers = Math.round(shape.embers * force);
    for (let i = 0; i < embers; i += 1) {
      const v = coneVector(travel, shape.cone, scratchA);
      const speed = 1.5 + Math.random() * 4.2 * force;
      spawnEmber(
        at.x + v.x * 0.02, at.y + v.y * 0.02, at.z + v.z * 0.02,
        v.x * speed, v.y * speed + 0.5, v.z * speed,
        0.28 + Math.random() * 0.48,
        0.022 + Math.random() * 0.042,
        0.75,
        4.4,
        0.9,
      );
    }

    // --- the smoke bloom, thrown wider and slower than the fire, which is what gives a detonation
    //     a body to expand into rather than a flash and nothing.
    const puffs = Math.round(shape.smoke * force);
    for (let i = 0; i < puffs; i += 1) {
      const v = coneVector(travel, shape.cone * 1.5, scratchA);
      const speed = 0.5 + Math.random() * 1.5 * force;
      spawnSmoke(
        at.x, at.y, at.z,
        v.x * speed, v.y * speed + 0.25, v.z * speed,
        0.78 + Math.random() * 0.80,
        0.042 + Math.random() * 0.048,
        2.0 + Math.random() * 1.2,
        0.42,
      );
    }

    // --- crystal shrapnel
    const chips = Math.round(shape.shards * force);
    for (let i = 0; i < chips; i += 1) {
      const v = coneVector(travel, shape.cone * 1.15, scratchA);
      // Kicks throw their chips down as well as out: the boot is driving through, not tapping.
      if (kind === 'kick') v.y -= Math.random() * 0.45;
      v.normalize();
      spawnShard(at, v, 2.0 + Math.random() * 4.5 * force, 0.014 + Math.random() * 0.022);
    }

    // --- shock rings
    quaternion.setFromUnitVectors(forward, travel);
    for (let i = 0; i < shape.rings; i += 1) {
      const slot = nextFrom(rings);
      slot.mesh.position.copy(at);
      slot.mesh.quaternion.copy(quaternion);
      // Reset: `clash` recolours whichever slots it takes, and the pool is shared.
      slot.material.uniforms.uCore.value = COLOURS.core;
      slot.material.uniforms.uFlame.value = COLOURS.flame;
      // A hook lands across its target, so its rings are rolled off the travel axis onto the swing
      // plane. Without the roll a hook's shock is indistinguishable from a straight's.
      if (shape.ringRoll !== 0) slot.mesh.rotateX(shape.ringRoll * (i === 0 ? 1 : -0.6));
      slot.age = 0;
      slot.span = 0.26 + i * 0.10;
      slot.delay = i * 0.045;
      slot.from = 0.05;
      slot.to = shape.ringSpan * force * (1 + i * 0.55);
      slot.mesh.scale.setScalar(slot.from);
      slot.mesh.visible = true;
    }

    // --- the flash and the light it casts
    const flash = nextFrom(flashes);
    flash.sprite.position.copy(at);
    flash.age = 0;
    flash.span = 0.16;
    flash.scale = shape.flash * force;
    flash.sprite.visible = true;

    const light = nextFrom(lights);
    light.light.position.copy(at);
    light.age = 0;
    light.span = 0.22;
    light.power = shape.light * force;

    // --- the floor, for blows that put weight through it
    if (shape.ripple > 0) {
      const ripple = nextFrom(ripples);
      ripple.mesh.position.set(at.x, 0.006, at.z);
      ripple.age = 0;
      ripple.span = 0.55;
      ripple.radius = shape.ripple * force;
      ripple.mesh.scale.setScalar(0.05);
      ripple.mesh.visible = true;
    }

    return shape.hitstop * (0.7 + force * 0.4);
  }

  function footfall(at: THREE.Vector3, drop: number): void {
    const force = Math.min(1, Math.max(0.15, drop / 2.0));
    const count = 6 + Math.round(force * 22);
    for (let i = 0; i < count; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.35 + Math.random() * 1.5 * force;
      spawnEmber(
        at.x, Math.max(at.y, 0.01), at.z,
        Math.cos(angle) * speed, 0.25 + Math.random() * 0.8 * force, Math.sin(angle) * speed,
        0.34 + Math.random() * 0.40,
        0.018 + Math.random() * 0.030,
        0.35,
        3.6,
        0.7,
      );
    }
    const puffs = 2 + Math.round(force * 7);
    for (let i = 0; i < puffs; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.20 + Math.random() * 0.75 * force;
      spawnSmoke(
        at.x, Math.max(at.y, 0.01), at.z,
        Math.cos(angle) * speed, 0.16 + Math.random() * 0.24, Math.sin(angle) * speed,
        0.68 + Math.random() * 0.66,
        0.036 + Math.random() * 0.040,
        1.9,
        0.32,
      );
    }
    const ripple = nextFrom(ripples);
    ripple.mesh.position.set(at.x, 0.006, at.z);
    ripple.age = 0;
    ripple.span = 0.48;
    ripple.radius = 0.20 + force * 0.42;
    ripple.mesh.scale.setScalar(0.04);
    ripple.mesh.visible = true;
  }

  function fireball(at: THREE.Vector3, dir: THREE.Vector3, power: number, tint: Tint = 'jade'): void {
    const force = 0.6 + Math.min(1, Math.max(0, power)) * 0.6;
    const travel = scratchC.copy(dir);
    /**
     * Pitch CLAMPED, not zeroed — and the difference is what lets the same shot serve two demos.
     *
     * The contact that throws the ball is the high boot at 0.881 H, and at that instant the foot is
     * travelling almost straight UP. Early passes aimed with the foot's own motion and the ball left
     * the top of the frame in a third of a second; keeping a fifth of the vertical still climbed at
     * 2.2 m/s and crossed out of frame at 0.28 s, measured in normalised device coordinates.
     *
     * Zeroing the vertical fixed that and then broke something else. The duel stands Roblin downrange
     * and Roblin is 1.502 units tall against a launch at 1.835: a perfectly level shot sails over his
     * head, every time, and the scenario never fires. A shot at an opponent has to be able to come
     * DOWN.
     *
     * So the vertical is clamped to a slope rather than removed. 35 degrees is well past the 23 the
     * duel actually asks for and nowhere near enough to lose the frame.
     */
    if (travel.lengthSq() < 1e-8) travel.copy(forward);
    travel.normalize();
    const MAX_PITCH = 0.5736; // sin(35 degrees)
    if (Math.abs(travel.y) > MAX_PITCH) {
      const level = Math.hypot(travel.x, travel.z);
      const scale = level > 1e-6 ? Math.sqrt(1 - MAX_PITCH * MAX_PITCH) / level : 0;
      travel.set(travel.x * scale, Math.sign(travel.y) * MAX_PITCH, travel.z * scale).normalize();
    }

    const slot = nextFrom(fireballs);
    slot.position.copy(at);
    slot.previous.copy(at);
    // Straight. No lift, no droop — the line is the whole point of a fired projectile.
    slot.velocity.copy(travel).multiplyScalar(8.0 * force);
    slot.age = 0;
    slot.span = 0.42;
    slot.power = force;
    slot.emberDebt = 0;
    slot.smokeDebt = 0;
    slot.live = true;
    slot.tint = tint;
    slot.core.geometry = FLAME_GEOMETRY[tint];
    slot.core.visible = true;
    slot.halo.visible = true;
    slot.core.position.copy(at);
    slot.halo.position.copy(at);

    // The moment of leaving the boot: a small forward spray, so the ball is thrown rather than
    // simply appearing.
    for (let i = 0; i < Math.round(26 * force); i += 1) {
      const v = coneVector(travel, 0.7, scratchA);
      const speed = 1.2 + Math.random() * 2.6 * force;
      spawnEmber(
        at.x, at.y, at.z,
        v.x * speed, v.y * speed + 0.4, v.z * speed,
        0.26 + Math.random() * 0.34,
        0.018 + Math.random() * 0.030,
        0.7, 4.0, 0.8,
      );
    }
  }

  /** The ball landing: the same detonation a boot makes, plus the ground it lands on. */
  function detonateFireball(slot: FireballSlot): void {
    slot.live = false;
    slot.core.visible = false;
    slot.halo.visible = false;
    slot.material.opacity = 0;
    slot.haloMaterial.opacity = 0;
    scratchB.copy(slot.velocity);
    if (scratchB.lengthSq() < 1e-8) scratchB.set(0, -1, 0);
    burst('kick', slot.position, scratchB.normalize(), slot.power);
  }

  /**
   * The celebration.
   *
   * Built out of the same parts an impact is, arranged the other way round, and that inversion is the
   * whole idea: an impact is fire thrown OUTWARD from a point at speed, so a victory is fire rising
   * UPWARD from the fighter and rings running out along the ground he is standing on. Same three
   * greens, same pools, no new palette — it has to read as the same character's fire, celebrating.
   *
   * Deliberately slower than a detonation. A blow is over in 200 ms because a blow is an instant;
   * this runs for the better part of a second on staggered rings, because it is a held beat.
   */
  function celebrate(at: THREE.Vector3, power: number): void {
    const force = 0.7 + Math.min(1, Math.max(0, power)) * 0.6;

    // Three rings out along the FLOOR, staggered, each further than the last.
    for (let i = 0; i < 3; i += 1) {
      const ripple = nextFrom(ripples);
      ripple.mesh.position.set(at.x, 0.006, at.z);
      ripple.age = 0;
      ripple.span = 0.8 + i * 0.22;
      ripple.radius = (0.9 + i * 0.75) * force;
      ripple.mesh.scale.setScalar(0.05);
      ripple.mesh.visible = true;
    }

    /**
     * The column. Spawned on a ring around the fighter's feet rather than at a point, and given
     * almost no outward velocity — the buoyancy in `update` does the rest. A column that is thrown
     * upward reads as a jet; one that is released and allowed to rise reads as fire.
     */
    const embers = Math.round(150 * force);
    for (let i = 0; i < embers; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * 0.42 * force;
      spawnEmber(
        at.x + Math.cos(angle) * r,
        at.y + Math.random() * 0.25,
        at.z + Math.sin(angle) * r,
        Math.cos(angle) * 0.35, 1.9 + Math.random() * 2.6 * force, Math.sin(angle) * 0.35,
        0.6 + Math.random() * 0.7,
        0.022 + Math.random() * 0.040,
        0.45,
        1.4,
        2.6,
      );
    }

    const puffs = Math.round(46 * force);
    for (let i = 0; i < puffs; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * 0.5 * force;
      spawnSmoke(
        at.x + Math.cos(angle) * r, at.y + 0.1, at.z + Math.sin(angle) * r,
        Math.cos(angle) * 0.42, 0.9 + Math.random() * 1.0, Math.sin(angle) * 0.42,
        1.0 + Math.random() * 0.9,
        0.048 + Math.random() * 0.055,
        2.6 + Math.random() * 1.3,
        0.34,
      );
    }

    // Crystal shrapnel thrown UP and out, so the shards fall back through the column.
    const chips = Math.round(26 * force);
    for (let i = 0; i < chips; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      scratchA.set(Math.cos(angle) * 0.55, 1, Math.sin(angle) * 0.55).normalize();
      spawnShard(at, scratchA, 2.4 + Math.random() * 3.4 * force, 0.016 + Math.random() * 0.024);
    }

    const flash = nextFrom(flashes);
    flash.sprite.position.set(at.x, at.y + 0.5, at.z);
    flash.age = 0;
    flash.span = 0.42;
    flash.scale = 0.7 * force;
    flash.sprite.visible = true;

    const light = nextFrom(lights);
    light.light.position.set(at.x, at.y + 0.8, at.z);
    light.age = 0;
    light.span = 0.9;
    light.power = 22 * force;
  }

  /**
   * THE CLASH: two forces arriving at one point, and neither of them winning.
   *
   * Every other effect in this layer is one fighter's, so it is one palette. This one is the only
   * thing on the stage that belongs to BOTH, and that is what it has to say — so it is built in two
   * colours down a seam, jade on the side the jade came from and lime on the other, meeting on a
   * white-hot line. Split by the AXIS the two forces met along, not by a screen direction, so the
   * seam stays between the fighters from any camera.
   *
   * Three parts. A rift standing in the air where the two met, which is the shape a plane of force
   * makes when it has nowhere to go; a crack running out across the floor beneath it; and the pair of
   * shockwave rings, one in each colour, which is the only place in the demo a ring is not jade.
   */
  function clash(at: THREE.Vector3, axis: THREE.Vector3, power: number): void {
    const force = 0.7 + Math.min(1, Math.max(0, power)) * 0.7;
    scratchC.copy(axis).setY(0);
    if (scratchC.lengthSq() < 1e-8) scratchC.set(1, 0, 0);
    scratchC.normalize();

    const rift = nextFrom(rifts);
    rift.mesh.position.copy(at);
    // The plane FACES along the axis, so the seam runs vertically between the two fighters.
    rift.mesh.quaternion.setFromUnitVectors(forward, scratchC);
    rift.age = 0;
    rift.span = 1.15;
    rift.scale = 1.5 * force;
    rift.mesh.visible = true;

    const crack = nextFrom(cracks);
    crack.mesh.position.set(at.x, 0.007, at.z);
    crack.mesh.rotation.set(-Math.PI / 2, 0, -Math.atan2(scratchC.z, scratchC.x));
    crack.age = 0;
    crack.span = 1.6;
    crack.scale = 2.3 * force;
    crack.mesh.visible = true;

    // One ring per palette, thrown out along the seam in both directions.
    for (let i = 0; i < 2; i += 1) {
      const slot = nextFrom(rings);
      slot.mesh.position.copy(at);
      slot.mesh.quaternion.setFromUnitVectors(forward, scratchC);
      slot.material.uniforms.uCore.value = i === 0 ? COLOURS.core : COLOURS.limeCore;
      slot.material.uniforms.uFlame.value = i === 0 ? COLOURS.flame : COLOURS.lime;
      slot.age = 0;
      slot.span = 0.42 + i * 0.12;
      slot.delay = i * 0.05;
      slot.from = 0.05;
      slot.to = (0.75 + i * 0.5) * force;
      slot.mesh.scale.setScalar(slot.from);
      slot.mesh.visible = true;
    }

    // Shrapnel in both colours, thrown along the seam rather than along the axis: the two forces
    // cancelled each other on the axis, so what escapes goes sideways.
    const chips = Math.round(46 * force);
    for (let i = 0; i < chips; i += 1) {
      scratchA.set(-scratchC.z, 0, scratchC.x)
        .multiplyScalar(i % 2 === 0 ? 1 : -1)
        .addScaledVector(up, Math.random() * 1.2 - 0.2);
      coneVector(scratchA.normalize(), 0.7, scratchB);
      spawnShard(at, scratchB, 2.6 + Math.random() * 4.2 * force, 0.016 + Math.random() * 0.026,
        i % 2 === 0 ? COLOURS.shard : COLOURS.lime);
    }

    const embers = Math.round(120 * force);
    for (let i = 0; i < embers; i += 1) {
      coneVector(up, Math.PI, scratchA);
      const speed = 1.4 + Math.random() * 4.0 * force;
      spawnEmber(at.x, at.y, at.z,
        scratchA.x * speed, scratchA.y * speed + 0.6, scratchA.z * speed,
        0.3 + Math.random() * 0.5, 0.018 + Math.random() * 0.034, 0.7, 3.8, 1.0);
    }
    const puffs = Math.round(40 * force);
    for (let i = 0; i < puffs; i += 1) {
      coneVector(up, Math.PI, scratchA);
      const speed = 0.5 + Math.random() * 1.6 * force;
      spawnSmoke(at.x, at.y, at.z, scratchA.x * speed, scratchA.y * speed + 0.3, scratchA.z * speed,
        0.9 + Math.random() * 0.9, 0.05 + Math.random() * 0.05, 2.4 + Math.random() * 1.2, 0.45);
    }

    const flash = nextFrom(flashes);
    flash.sprite.position.copy(at);
    flash.age = 0;
    flash.span = 0.34;
    flash.scale = 0.85 * force;
    flash.sprite.visible = true;

    const light = nextFrom(lights);
    light.light.position.copy(at);
    light.age = 0;
    light.span = 0.7;
    light.power = 30 * force;
  }

  // ------------------------------------------------------------------------------------ update
  function update(delta: number): void {
    const dt = Math.min(0.05, Math.max(0, delta));

    // Between ticks, never inside a render pass: `compile` sets up its own render state.
    if (warmPending && warmRenderer && warmScene && warmCamera) {
      warmPending = false;
      warmRenderer.compile(warmScene, warmCamera);
    }

    // --- embers
    for (let i = 0; i < EMBER_CAPACITY; i += 1) {
      if (ember.age[i] >= 1) { emberLife[i] = 1; continue; }
      const step = dt / ember.span[i];
      ember.age[i] = Math.min(1, ember.age[i] + step);
      const damping = Math.max(0, 1 - ember.drag[i] * dt);
      ember.vx[i] *= damping;
      ember.vz[i] *= damping;
      ember.vy[i] = ember.vy[i] * damping + ember.lift[i] * dt;
      ember.px[i] += ember.vx[i] * dt;
      ember.py[i] += ember.vy[i] * dt;
      ember.pz[i] += ember.vz[i] * dt;
      emberPosition[i * 3] = ember.px[i];
      emberPosition[i * 3 + 1] = ember.py[i];
      emberPosition[i * 3 + 2] = ember.pz[i];
      emberVel[i * 3] = ember.vx[i];
      emberVel[i * 3 + 1] = ember.vy[i];
      emberVel[i * 3 + 2] = ember.vz[i];
      emberLife[i] = ember.age[i];
    }
    emberAttr.position.needsUpdate = true;
    emberAttr.life.needsUpdate = true;
    emberAttr.size.needsUpdate = true;
    emberAttr.vel.needsUpdate = true;
    emberAttr.stretch.needsUpdate = true;

    // --- smoke
    for (let i = 0; i < SMOKE_CAPACITY; i += 1) {
      if (smoke.age[i] >= 1) { smokeLife[i] = 1; continue; }
      const step = dt / smoke.span[i];
      smoke.age[i] = Math.min(1, smoke.age[i] + step);
      const damping = Math.max(0, 1 - 1.8 * dt);
      smoke.vx[i] *= damping;
      smoke.vz[i] *= damping;
      // Smoke keeps climbing as it cools; only the horizontal push dies away.
      smoke.vy[i] = smoke.vy[i] * damping + 0.26 * dt;
      smoke.px[i] += smoke.vx[i] * dt;
      smoke.py[i] += smoke.vy[i] * dt;
      smoke.pz[i] += smoke.vz[i] * dt;
      smokePosition[i * 3] = smoke.px[i];
      smokePosition[i * 3 + 1] = smoke.py[i];
      smokePosition[i * 3 + 2] = smoke.pz[i];
      smokeSize[i] = smoke.base[i] * (1 + smoke.age[i] * smoke.growth[i]);
      smokeAlpha[i] = smoke.alpha[i];
      smokeSpin[i] = smoke.spin[i];
      smokeLife[i] = smoke.age[i];
    }
    smokeAttr.position.needsUpdate = true;
    smokeAttr.life.needsUpdate = true;
    smokeAttr.size.needsUpdate = true;
    smokeAttr.alpha.needsUpdate = true;
    smokeAttr.spin.needsUpdate = true;

    // --- shards
    let shardsMoved = false;
    for (let i = 0; i < SHARD_CAPACITY; i += 1) {
      if (shard.age[i] >= 1) continue;
      shardsMoved = true;
      shard.age[i] = Math.min(1, shard.age[i] + dt / shard.span[i]);
      const damping = Math.max(0, 1 - 5.0 * dt);
      shard.vx[i] *= damping;
      shard.vz[i] *= damping;
      // Chips of crystal are solid, so they fall. Nothing else in this layer does.
      shard.vy[i] = shard.vy[i] * damping - 6.4 * dt;
      shard.px[i] += shard.vx[i] * dt;
      shard.py[i] += shard.vy[i] * dt;
      shard.pz[i] += shard.vz[i] * dt;
      shard.rotX[i] += shard.spinX[i] * dt;
      shard.rotY[i] += shard.spinY[i] * dt;
      const fade = 1 - shard.age[i];
      const size = shard.size[i] * fade;
      scratchA.set(shard.vx[i], shard.vy[i], shard.vz[i]);
      const speed = scratchA.length();
      quaternion.setFromEuler(euler.set(shard.rotX[i], shard.rotY[i], 0));
      // Stretched along the tumble, more the faster it goes: a splinter, not a pebble.
      scratchB.set(size, size * (1 + Math.min(2.4, speed * 0.28)), size);
      matrix.compose(scratchA.set(shard.px[i], shard.py[i], shard.pz[i]), quaternion, scratchB);
      shards.setMatrixAt(i, matrix);
      instanceColour.setRGB(shard.tintR[i], shard.tintG[i], shard.tintB[i]).multiplyScalar(fade * fade);
      shards.setColorAt(i, instanceColour);
      if (shard.age[i] >= 1) {
        matrix.makeScale(0, 0, 0);
        shards.setMatrixAt(i, matrix);
      }
    }
    if (shardsMoved) {
      shards.instanceMatrix.needsUpdate = true;
      if (shards.instanceColor) shards.instanceColor.needsUpdate = true;
    }

    // --- shock rings
    for (const slot of rings.items) {
      if (slot.age >= 1) { if (slot.mesh.visible) slot.mesh.visible = false; continue; }
      if (slot.delay > 0) { slot.delay -= dt; continue; }
      slot.age = Math.min(1, slot.age + dt / slot.span);
      // Decelerating expansion: a shock front is fastest at the instant it leaves the contact.
      const eased = 1 - Math.pow(1 - slot.age, 2.4);
      slot.mesh.scale.setScalar(slot.from + (slot.to - slot.from) * eased);
      slot.material.uniforms.uFade.value = Math.pow(1 - slot.age, 1.7);
      if (slot.age >= 1) slot.mesh.visible = false;
    }

    // --- ground ripples
    for (const slot of ripples.items) {
      if (slot.age >= 1) { if (slot.mesh.visible) slot.mesh.visible = false; continue; }
      slot.age = Math.min(1, slot.age + dt / slot.span);
      const eased = 1 - Math.pow(1 - slot.age, 2.0);
      slot.mesh.scale.setScalar(0.04 + slot.radius * eased);
      slot.material.uniforms.uFade.value = Math.pow(1 - slot.age, 2.0);
      if (slot.age >= 1) slot.mesh.visible = false;
    }

    // --- flashes
    for (const slot of flashes.items) {
      if (slot.age >= 1) { if (slot.sprite.visible) slot.sprite.visible = false; continue; }
      slot.age = Math.min(1, slot.age + dt / slot.span);
      const fade = 1 - slot.age;
      slot.sprite.scale.setScalar(slot.scale * (0.55 + slot.age * 1.5));
      slot.material.opacity = fade * fade;
      if (slot.age >= 1) slot.sprite.visible = false;
    }

    // --- impact lights. Intensity only: see the pool above for why `visible` is never touched.
    for (const slot of lights.items) {
      if (slot.age >= 1) continue;
      slot.age = Math.min(1, slot.age + dt / slot.span);
      const fade = 1 - slot.age;
      slot.light.intensity = slot.age >= 1 ? 0 : slot.power * fade * fade;
    }

    // --- fireballs in flight
    for (const slot of fireballs.items) {
      if (!slot.live) continue;
      slot.age = Math.min(1, slot.age + dt / slot.span);
      slot.previous.copy(slot.position);
      // No gravity term: it flies the line it was fired on.
      slot.position.addScaledVector(slot.velocity, dt);

      const pulse = 0.9 + Math.sin(slot.age * 34) * 0.1;
      const size = (0.19 + slot.power * 0.10) * pulse;
      slot.core.position.copy(slot.position);
      // The lathe is built around +Y, so point that axis down the line of flight — tip forward,
      // tail streaming behind. Then spin it about its own axis so the swept profile licks.
      flameAxis.copy(slot.velocity);
      if (flameAxis.lengthSq() > 1e-8) flameAxis.normalize(); else flameAxis.set(0, 1, 0);
      flameQuaternion.setFromUnitVectors(up, flameAxis);
      slot.core.quaternion.copy(flameQuaternion);
      slot.core.rotateY(slot.age * 26);
      // The profile is already four-to-one, so this only flickers it: a fast wobble across the axis
      // and a slower one along it, which is what keeps a swept solid from reading as a solid.
      const lick = 1 + Math.sin(slot.age * 61) * 0.09;
      slot.core.scale.set(size * lick, size * (1.15 + slot.power * 0.25) / lick, size * lick);
      slot.material.opacity = 0.7;
      slot.halo.position.copy(slot.position);
      // Sits over the nose rather than the centre, so the glow is where the fire is hottest.
      slot.halo.position.addScaledVector(flameAxis, size * 0.55);
      slot.halo.scale.setScalar(size * 3.4);
      slot.haloMaterial.opacity = 0.3;

      // The tail. Emitted here rather than by `plume` because a projectile has no crystal to hang
      // off — the ball IS the emitter, and it drags its own fire behind it.
      slot.emberDebt += (300 + slot.power * 340) * dt;
      let count = Math.min(30, Math.floor(slot.emberDebt));
      slot.emberDebt -= count;
      for (let i = 0; i < count; i += 1) {
        /**
         * Spawned ALONG the segment just travelled, not at the current position. At 9.5 m/s a
         * 60 fps frame moves the ball 16 cm; emitting every ember at the head leaves the tail as a
         * string of separated clumps, one per frame, which is the tell for a cheap projectile.
         */
        const along = Math.random();
        spawnEmber(
          slot.previous.x + (slot.position.x - slot.previous.x) * along + (Math.random() - 0.5) * 0.05,
          slot.previous.y + (slot.position.y - slot.previous.y) * along + (Math.random() - 0.5) * 0.05,
          slot.previous.z + (slot.position.z - slot.previous.z) * along + (Math.random() - 0.5) * 0.05,
          // Only a tenth of the ball's speed: the tail has to be LEFT BEHIND. Give the embers much
          // of its velocity and they fly with it, and the flame has no wake at all.
          slot.velocity.x * 0.10 + (Math.random() - 0.5) * 0.55,
          slot.velocity.y * 0.10 + 0.40 + Math.random() * 0.55,
          slot.velocity.z * 0.10 + (Math.random() - 0.5) * 0.55,
          0.30 + Math.random() * 0.40,
          0.020 + Math.random() * 0.036,
          0.8,
          3.0, 1.1,
        );
      }
      slot.smokeDebt += (80 + slot.power * 60) * dt;
      let puffs = Math.min(10, Math.floor(slot.smokeDebt));
      slot.smokeDebt -= puffs;
      for (let i = 0; i < puffs; i += 1) {
        const along = Math.random();
        spawnSmoke(
          slot.previous.x + (slot.position.x - slot.previous.x) * along,
          slot.previous.y + (slot.position.y - slot.previous.y) * along,
          slot.previous.z + (slot.position.z - slot.previous.z) * along,
          (Math.random() - 0.5) * 0.24, 0.22 + Math.random() * 0.20, (Math.random() - 0.5) * 0.24,
          0.66 + Math.random() * 0.62,
          0.034 + Math.random() * 0.038,
          1.8 + Math.random() * 1.0,
          0.34,
        );
      }

      /**
       * Three ways to end, tested in the order they matter.
       *
       * The target first, because a hit is the only ending that means anything to a caller. No swept
       * test is needed: the ball covers about 0.09 world units in a frame against a capsule radius
       * measured in tenths of a figure, so it cannot step over one. The floor stays as the second
       * test even though a level shot never reaches it — a future launch angled down should detonate
       * on contact rather than burrow — and burning out is the fallback.
       */
      if (projectileTarget) {
        const dx = slot.position.x - projectileTarget.at.x;
        const dz = slot.position.z - projectileTarget.at.z;
        const dy = slot.position.y - projectileTarget.at.y;
        if (dx * dx + dz * dz <= projectileTarget.radius * projectileTarget.radius
          && Math.abs(dy) <= projectileTarget.halfHeight) {
          const target = projectileTarget;
          detonateFireball(slot);
          target.onHit(slot.position);
          continue;
        }
      }
      if (slot.position.y <= 0.07 || slot.age >= 1) {
        if (slot.position.y < 0.07) slot.position.y = 0.07;
        detonateFireball(slot);
      }
    }

    /**
     * BALL MEETS BALL.
     *
     * Tested after every ball has moved, so both are on this frame's positions — testing inside the
     * flight loop would compare one ball's new position against the other's from last frame, which at
     * 8 m/s closing is a tenth of a unit of error in the meeting point.
     *
     * The pair detonates at the MIDPOINT rather than at either ball. Two shots that annihilate each
     * other have no winner, and firing the burst at one of them would pick one.
     */
    {
      /**
       * SWEPT, not sampled.
       *
       * Two balls closing head-on cover 16 m/s between them — 0.27 world units in a 60 fps frame,
       * against a combined radius of 0.5. A point test at each frame boundary therefore misses them
       * about as often as it catches them: they are 0.4 apart on one frame and 0.4 apart on the next,
       * having swapped sides in between. Measured, that is exactly what happened — two balls in
       * flight, every time, and a collision almost never.
       *
       * So the test is on the SEGMENTS both balls travelled this frame. In the pair's relative frame
       * one of them is stationary, and the closest approach is a quadratic minimum in `t` over [0, 1];
       * that is where they actually met, and the detonation goes there rather than at either
       * endpoint.
       */
      const live = fireballs.items.filter((slot) => slot.live);
      outer: for (let a = 0; a < live.length; a += 1) {
        for (let b = a + 1; b < live.length; b += 1) {
          const first = live[a];
          const second = live[b];
          // Relative start, and relative travel over this frame.
          scratchA.copy(first.previous).sub(second.previous);
          scratchB.copy(first.position).sub(first.previous)
            .sub(scratchC.copy(second.position).sub(second.previous));
          const travelSq = scratchB.lengthSq();
          const t = travelSq < 1e-9 ? 0 : Math.min(1, Math.max(0, -scratchA.dot(scratchB) / travelSq));
          scratchA.addScaledVector(scratchB, t);
          if (scratchA.lengthSq() > COLLIDE_RADIUS * COLLIDE_RADIUS) continue;

          // Where each ball was at that instant; the pair dies at the point between them.
          scratchA.copy(first.previous).lerp(first.position, t);
          scratchB.copy(second.previous).lerp(second.position, t);
          scratchC.copy(first.velocity).sub(second.velocity);
          if (scratchC.lengthSq() < 1e-6) scratchC.set(0, 1, 0);
          const meeting = scratchA.add(scratchB).multiplyScalar(0.5).clone();
          detonateFireball(first);
          detonateFireball(second);
          // Both palettes, because both shots died here.
          clash(meeting, scratchC.normalize(), 1);
          collideHandler?.(meeting);
          break outer;
        }
      }
    }

    // --- the projectile's light follows whichever ball is youngest, and idles dark when none is up.
    let leading: FireballSlot | null = null;
    for (const slot of fireballs.items) {
      if (slot.live && (!leading || slot.age < leading.age)) leading = slot;
    }
    if (leading) {
      flightLight.position.copy(leading.position);
      flightLight.intensity = 9 * leading.power;
    } else {
      flightLight.intensity = 0;
    }

    // --- the clash rift and its crack: torn open fast, held, then gone
    for (const pool of [rifts, cracks]) {
      for (const slot of pool.items) {
        if (slot.age >= 1) { if (slot.mesh.visible) slot.mesh.visible = false; continue; }
        slot.age = Math.min(1, slot.age + dt / slot.span);
        const open = 1 - Math.pow(1 - slot.age, 3);
        slot.mesh.scale.set(slot.scale * (0.25 + open * 0.85), slot.scale * (0.25 + open * 0.85), 1);
        slot.material.uniforms.uGrow.value = 0.15 + open * 1.1;
        // Held near full for the first third: a rift that starts fading the instant it opens reads as
        // a flash, and this is supposed to read as damage left behind.
        slot.material.uniforms.uFade.value = slot.age < 0.35 ? 1 : Math.pow(1 - (slot.age - 0.35) / 0.65, 1.6);
        if (slot.age >= 1) slot.mesh.visible = false;
      }
    }

    // --- afterimages
    for (const slot of ghosts.items) {
      if (slot.prime > 0) {
        slot.prime -= 1;
        slot.material.opacity = 0;
        // Drawn on exactly the frame its counter runs out; the age check hides it again next tick.
        slot.mesh.visible = slot.prime === 0;
        continue;
      }
      if (slot.age >= 1) { if (slot.mesh.visible) slot.mesh.visible = false; continue; }
      slot.age = Math.min(1, slot.age + dt / GHOST_LIFE);
      const fade = 1 - slot.age;
      // Quadratic, so the newest ghost is clearly the brightest and the tail reads as a direction of
      // travel rather than as five equal copies of the figure.
      slot.material.opacity = 0.38 * slot.gain * fade * fade;
      if (slot.age >= 1) {
        slot.material.opacity = 0;
        slot.mesh.visible = false;
      }
    }

    // --- the crystal glows. Decayed here rather than assigned, so the level a caller pushes in is
    //     a floor that falls away on its own the moment the caller stops pushing.
    for (const slot of glows.values()) {
      slot.level = Math.max(0, slot.level - dt * 4.2);
      if (slot.level <= 0.001) {
        if (slot.sprite.visible) slot.sprite.visible = false;
        slot.material.opacity = 0;
        continue;
      }
      slot.sprite.visible = true;
      slot.sprite.scale.setScalar(0.14 + slot.level * 0.26);
      slot.material.opacity = Math.min(1, slot.level * 0.85);
    }
  }

  function counts(): { embers: number; smoke: number; shards: number; rings: number; fireballs: number; ghosts: number } {
    let embers = 0;
    let puffs = 0;
    let chips = 0;
    let live = 0;
    let thrown = 0;
    let copies = 0;
    for (let i = 0; i < EMBER_CAPACITY; i += 1) if (ember.age[i] < 1) embers += 1;
    for (let i = 0; i < SMOKE_CAPACITY; i += 1) if (smoke.age[i] < 1) puffs += 1;
    for (let i = 0; i < SHARD_CAPACITY; i += 1) if (shard.age[i] < 1) chips += 1;
    for (const slot of rings.items) if (slot.age < 1) live += 1;
    for (const slot of fireballs.items) if (slot.live) thrown += 1;
    for (const slot of ghosts.items) if (slot.age < 1) copies += 1;
    return { embers, smoke: puffs, shards: chips, rings: live, fireballs: thrown, ghosts: copies };
  }

  function dispose(): void {
    disposed = true;
    for (const item of disposables) item.dispose();
  }

  return { group, plume, charge, burst, footfall, fireball, onProjectilesCollide, clash, setProjectileTarget, celebrate, bindGhosts, afterimage, counts, update, dispose };
}
