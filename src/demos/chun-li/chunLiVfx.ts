import * as THREE from 'three';

/**
 * The effects layer: ki, dust, shock and light, pooled and driven from the showcase's schedule.
 *
 * EVERYTHING IS POOLED AND PREALLOCATED. Not a style preference — a punch fires eleven effects on
 * one frame, and allocating them there is the difference between a clean hit and a hitch exactly
 * where the eye is. Every pool below is a flat typed array with a write cursor; a spawn overwrites
 * the oldest slot and nothing is ever created after construction.
 *
 * FIVE DRAW CALLS DO ALL THE PARTICLES. Sparks, ki motes and the orb's wake share one additive
 * `Points`; dust and smoke share one alpha-blended `Points`; speed lines and impact streaks share
 * one `LineSegments`. The rings and the orb are meshes because they need a real orientation, and
 * there are at most twenty of them.
 *
 * COLOUR IS THE CHARACTER'S, NOT A DEFAULT. Chun-Li's ki reads blue-white against her cobalt
 * qipao, so the hot pool interpolates between a near-white core, a cyan mid and a deep blue edge,
 * with the gold of her trim reserved for the frame a strike actually lands. Dust is the neutral
 * warm grey of ground dust, deliberately NOT tinted blue: if the dust is blue too, nothing reads
 * as energy any more.
 *
 * ADDITIVE MEANS DEPTH-WRITE OFF, DEPTH-TEST ON. Effects must not erase each other in the depth
 * buffer (two overlapping sparks would punch a hole in one another) but must still be occluded by
 * the figure, or a kick's sparks show through her own thigh.
 */

// ------------------------------------------------------------------------------ palette
const KI_CORE = new THREE.Color('#eaf8ff');
const KI_MID = new THREE.Color('#4fc3ff');
const KI_DEEP = new THREE.Color('#1155d8');
const GOLD = new THREE.Color('#ffcf5c');
const DUST = new THREE.Color('#b3aa9a');

// ------------------------------------------------------------------------------ pool sizes
const HOT_CAPACITY = 1100;
const DUST_CAPACITY = 520;
const STREAK_CAPACITY = 160;
const RING_CAPACITY = 20;
const FLASH_CAPACITY = 8;
const LIGHT_CAPACITY = 3;
const TRAIL_SEGMENTS = 22;

export type Side = 'left' | 'right';
export type Limb = 'hand' | 'foot';

export interface ChunLiVfx {
  /** Add this under the model root. Every child starts invisible. */
  readonly group: THREE.Group;
  /** Continuous limb ribbon. `strength` is 0-1 and already gated by the caller. */
  trail(limb: Limb, side: Side, at: THREE.Vector3, strength: number): void;
  /** Ki gathering into a point, 0-1. Called every frame of a windup. */
  charge(at: THREE.Vector3, amount: number, warm?: boolean): void;
  /** A strike arriving. `dir` is the travel direction, normalised. Returns hitstop in seconds. */
  strike(limb: Limb, at: THREE.Vector3, dir: THREE.Vector3, power: number): number;
  /** A two-handed blow driven downward: rings down the blow's own axis, dust and a gold flash. */
  slam(at: THREE.Vector3, power: number): void;
  /** Weight arriving on the ground. `drop` is the measured descent in figure heights per second. */
  footfall(at: THREE.Vector3, drop: number): void;
  /** A stride pushing off: dust thrown BACKWARD along `dir`, no flash. */
  stride(at: THREE.Vector3, dir: THREE.Vector3, power: number): void;
  /** One motion streak trailing a fast-moving body point. */
  speedline(at: THREE.Vector3, dir: THREE.Vector3, amount: number): void;
  /** Aura motes rising around the figure, 0-1. Called every frame while a power-up runs. */
  aura(at: THREE.Vector3, amount: number): void;
  /** Ki venting off an idle guard, so the stance is never completely dead. */
  breathe(at: THREE.Vector3): void;
  /** The orb condensing between the palms, 0-1. Below 0.02 it is hidden. */
  formOrb(at: THREE.Vector3, amount: number): void;
  /** Release: the orb leaves the palms along `dir` and flies on its own from here. */
  fireOrb(at: THREE.Vector3, dir: THREE.Vector3, flightSeconds: number, range: number): void;
  /** A gather that does not become a projectile: it flares off the palms instead. */
  flare(at: THREE.Vector3, power: number): void;
  /** Put every effect back in its pool — used when the action changes under a live orb. */
  reset(): void;
  /**
   * Live pool occupancy. Published because "did the effect actually fire" is not answerable from a
   * screenshot: an unfired spark and a sub-pixel one look identical.
   */
  counts(): { hot: number; dust: number; streaks: number; rings: number; orb: boolean };
  update(dt: number): void;
  dispose(): void;
}

// ------------------------------------------------------------------------------ textures
/** A soft radial dot. `hardness` pushes the falloff toward the centre for a sharper spark. */
function dotTexture(hardness: number): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(size, size);
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - half) / half;
      const dy = (y + 0.5 - half) / half;
      const r = Math.sqrt(dx * dx + dy * dy);
      const a = r >= 1 ? 0 : Math.pow(1 - r, hardness);
      const i = (y * size + x) * 4;
      image.data[i] = 255;
      image.data[i + 1] = 255;
      image.data[i + 2] = 255;
      image.data[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// ------------------------------------------------------------------------------ shaders
/**
 * Both point pools share this pair. Size is per-particle and attenuated by distance, alpha is a
 * per-particle curve the CPU has already evaluated, and the colour is a per-particle mix so a
 * single draw call can hold cold ki motes and a gold impact spark at once.
 */
const POINT_VERTEX = `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColour;
varying float vAlpha;
varying vec3 vColour;
void main() {
  vAlpha = aAlpha;
  vColour = aColour;
  vec4 view = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (300.0 / max(0.001, -view.z));
  gl_Position = projectionMatrix * view;
}
`;

const POINT_FRAGMENT = `
uniform sampler2D uMap;
varying float vAlpha;
varying vec3 vColour;
void main() {
  if (vAlpha <= 0.0) discard;
  vec4 texel = texture2D(uMap, gl_PointCoord);
  gl_FragColor = vec4(vColour, texel.a * vAlpha);
}
`;

/** The orb's shell: bright on the silhouette, transparent through the middle, so it reads round. */
const SHELL_VERTEX = `
varying vec3 vNormal;
varying vec3 vView;
void main() {
  vNormal = normalize(normalMatrix * normal);
  vec4 view = modelViewMatrix * vec4(position, 1.0);
  vView = normalize(-view.xyz);
  gl_Position = projectionMatrix * view;
}
`;

const SHELL_FRAGMENT = `
uniform vec3 uInner;
uniform vec3 uOuter;
uniform float uOpacity;
varying vec3 vNormal;
varying vec3 vView;
void main() {
  float facing = abs(dot(normalize(vNormal), normalize(vView)));
  float rim = pow(1.0 - facing, 2.2);
  vec3 colour = mix(uInner, uOuter, rim);
  gl_FragColor = vec4(colour, uOpacity * (0.18 + rim * 1.25));
}
`;

interface PointPool {
  points: THREE.Points;
  position: Float32Array;
  size: Float32Array;
  alpha: Float32Array;
  colour: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  vz: Float32Array;
  age: Float32Array;
  span: Float32Array;
  gravity: Float32Array;
  drag: Float32Array;
  spin: Float32Array;
  peak: Float32Array;
  cursor: number;
}

function makePointPool(capacity: number, map: THREE.Texture, blending: THREE.Blending): PointPool {
  const geometry = new THREE.BufferGeometry();
  const position = new Float32Array(capacity * 3);
  const size = new Float32Array(capacity);
  const alpha = new Float32Array(capacity);
  const colour = new Float32Array(capacity * 3);
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
  geometry.setAttribute('aColour', new THREE.BufferAttribute(colour, 3));
  // The pool never changes length, and its points are scattered all over the stage, so a bounding
  // sphere computed from the buffer would be recomputed every frame for nothing. A large fixed one
  // costs one sphere test and can never cull a live particle.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 40);
  const material = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: map } },
    vertexShader: POINT_VERTEX,
    fragmentShader: POINT_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.userData.isHighlight = true;
  const pool: PointPool = {
    points, position, size, alpha, colour,
    vx: new Float32Array(capacity), vy: new Float32Array(capacity), vz: new Float32Array(capacity),
    age: new Float32Array(capacity), span: new Float32Array(capacity),
    gravity: new Float32Array(capacity), drag: new Float32Array(capacity),
    spin: new Float32Array(capacity), peak: new Float32Array(capacity),
    cursor: 0,
  };
  pool.age.fill(1);
  pool.span.fill(1);
  return pool;
}

export function createChunLiVfx(): ChunLiVfx {
  const group = new THREE.Group();
  group.name = 'chun-li-vfx';
  // Keeps every effect out of the parts list, the explode layout, the picker and the framing pass.
  group.userData.isHighlight = true;

  const sparkMap = dotTexture(2.6);
  const puffMap = dotTexture(0.85);

  const hot = makePointPool(HOT_CAPACITY, sparkMap, THREE.AdditiveBlending);
  const dust = makePointPool(DUST_CAPACITY, puffMap, THREE.NormalBlending);
  group.add(hot.points, dust.points);

  const scratchA = new THREE.Vector3();
  const scratchB = new THREE.Vector3();
  const scratchC = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const tintColour = new THREE.Color();

  // ------------------------------------------------------------------------ particle spawning
  /**
   * `tint` walks the ki ramp: 0 is the deep blue edge, 0.5 the cyan body, 1 the white core, and
   * anything above 1 crosses into the gold reserved for contact.
   */
  function rampColour(tint: number, out: THREE.Color): THREE.Color {
    if (tint >= 1) return out.copy(KI_CORE).lerp(GOLD, Math.min(1, tint - 1));
    if (tint >= 0.5) return out.copy(KI_MID).lerp(KI_CORE, (tint - 0.5) * 2);
    return out.copy(KI_DEEP).lerp(KI_MID, tint * 2);
  }

  interface SpawnOptions {
    size: number;
    span: number;
    tint: number;
    gravity?: number;
    drag?: number;
    peak?: number;
  }

  function spawn(pool: PointPool, at: THREE.Vector3, velocity: THREE.Vector3, options: SpawnOptions): void {
    const i = pool.cursor;
    pool.cursor = (pool.cursor + 1) % pool.age.length;
    pool.position[i * 3] = at.x;
    pool.position[i * 3 + 1] = at.y;
    pool.position[i * 3 + 2] = at.z;
    pool.vx[i] = velocity.x;
    pool.vy[i] = velocity.y;
    pool.vz[i] = velocity.z;
    pool.age[i] = 0;
    pool.span[i] = options.span;
    pool.size[i] = options.size;
    pool.gravity[i] = options.gravity ?? 0;
    pool.drag[i] = options.drag ?? 1.6;
    pool.peak[i] = options.peak ?? 0.12;
    if (pool === dust) {
      // Dust is one warm grey, varied only in value, so it never competes with the ki for the eye.
      const v = 0.72 + Math.random() * 0.28;
      pool.colour[i * 3] = DUST.r * v;
      pool.colour[i * 3 + 1] = DUST.g * v;
      pool.colour[i * 3 + 2] = DUST.b * v;
    } else {
      rampColour(options.tint, tintColour);
      pool.colour[i * 3] = tintColour.r;
      pool.colour[i * 3 + 1] = tintColour.g;
      pool.colour[i * 3 + 2] = tintColour.b;
    }
    pool.alpha[i] = 0;
  }

  /** A cone of `count` particles around `dir`, `spread` radians wide. */
  function burst(
    pool: PointPool,
    at: THREE.Vector3,
    dir: THREE.Vector3,
    count: number,
    speed: number,
    spread: number,
    options: SpawnOptions,
  ): void {
    for (let n = 0; n < count; n++) {
      scratchB.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
      if (scratchB.lengthSq() < 1e-6) scratchB.set(0, 1, 0);
      scratchB.normalize().multiplyScalar(spread);
      scratchC.copy(dir).add(scratchB).normalize().multiplyScalar(speed * (0.55 + Math.random() * 0.75));
      spawn(pool, at, scratchC, {
        ...options,
        size: options.size * (0.65 + Math.random() * 0.7),
        span: options.span * (0.7 + Math.random() * 0.6),
        tint: options.tint * (0.8 + Math.random() * 0.4),
      });
    }
  }

  function stepPool(pool: PointPool, dt: number): number {
    let live = 0;
    const n = pool.age.length;
    for (let i = 0; i < n; i++) {
      if (pool.age[i] >= 1) { pool.alpha[i] = 0; continue; }
      pool.age[i] += dt / pool.span[i];
      if (pool.age[i] >= 1) { pool.alpha[i] = 0; continue; }
      live++;
      const decay = Math.exp(-pool.drag[i] * dt);
      pool.vx[i] *= decay;
      pool.vy[i] = pool.vy[i] * decay + pool.gravity[i] * dt;
      pool.vz[i] *= decay;
      pool.position[i * 3] += pool.vx[i] * dt;
      pool.position[i * 3 + 1] += pool.vy[i] * dt;
      pool.position[i * 3 + 2] += pool.vz[i] * dt;
      // Rise to `peak` of its life then fall away: a particle that starts at full brightness pops.
      const t = pool.age[i];
      const p = pool.peak[i];
      pool.alpha[i] = t < p ? t / p : Math.pow(1 - (t - p) / (1 - p), 1.7);
    }
    const geometry = pool.points.geometry;
    geometry.getAttribute('position').needsUpdate = true;
    geometry.getAttribute('aAlpha').needsUpdate = true;
    geometry.getAttribute('aSize').needsUpdate = true;
    geometry.getAttribute('aColour').needsUpdate = true;
    return live;
  }

  // ------------------------------------------------------------------------------- streaks
  /**
   * Speed lines and the orb's wake. A `Points` cannot express direction — a point sprite is always
   * a square facing the camera — so anything that has to LEAN with the motion is a line segment
   * whose two ends are written directly.
   */
  const streakPosition = new Float32Array(STREAK_CAPACITY * 6);
  const streakColour = new Float32Array(STREAK_CAPACITY * 6);
  const streakAge = new Float32Array(STREAK_CAPACITY).fill(1);
  const streakSpan = new Float32Array(STREAK_CAPACITY).fill(1);
  const streakTint = new Float32Array(STREAK_CAPACITY);
  let streakCursor = 0;
  const streakGeometry = new THREE.BufferGeometry();
  streakGeometry.setAttribute('position', new THREE.BufferAttribute(streakPosition, 3));
  streakGeometry.setAttribute('color', new THREE.BufferAttribute(streakColour, 3));
  streakGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 40);
  const streaks = new THREE.LineSegments(
    streakGeometry,
    new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 1,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }),
  );
  streaks.frustumCulled = false;
  streaks.userData.isHighlight = true;
  group.add(streaks);

  function spawnStreak(at: THREE.Vector3, dir: THREE.Vector3, length: number, span: number, tint: number): void {
    const i = streakCursor;
    streakCursor = (streakCursor + 1) % STREAK_CAPACITY;
    const b = i * 6;
    streakPosition[b] = at.x;
    streakPosition[b + 1] = at.y;
    streakPosition[b + 2] = at.z;
    streakPosition[b + 3] = at.x - dir.x * length;
    streakPosition[b + 4] = at.y - dir.y * length;
    streakPosition[b + 5] = at.z - dir.z * length;
    streakAge[i] = 0;
    streakSpan[i] = span;
    streakTint[i] = tint;
  }

  function stepStreaks(dt: number): number {
    let live = 0;
    for (let i = 0; i < STREAK_CAPACITY; i++) {
      const b = i * 6;
      if (streakAge[i] >= 1) {
        for (let k = 0; k < 6; k++) streakColour[b + k] = 0;
        continue;
      }
      streakAge[i] += dt / streakSpan[i];
      if (streakAge[i] >= 1) {
        for (let k = 0; k < 6; k++) streakColour[b + k] = 0;
        continue;
      }
      live++;
      const fade = Math.pow(1 - streakAge[i], 1.6);
      rampColour(streakTint[i], tintColour);
      // Head bright, tail dark: the gradient is what makes a line read as motion rather than wire.
      streakColour[b] = tintColour.r * fade;
      streakColour[b + 1] = tintColour.g * fade;
      streakColour[b + 2] = tintColour.b * fade;
      streakColour[b + 3] = tintColour.r * fade * 0.1;
      streakColour[b + 4] = tintColour.g * fade * 0.1;
      streakColour[b + 5] = tintColour.b * fade * 0.1;
    }
    streakGeometry.getAttribute('color').needsUpdate = true;
    streakGeometry.getAttribute('position').needsUpdate = true;
    return live;
  }

  // --------------------------------------------------------------------------------- rings
  /**
   * Shock rings. Twenty meshes over one shared geometry; each carries its own material because the
   * opacity and the colour differ per ring, and twenty materials is a smaller price than the
   * per-instance uniform plumbing an InstancedMesh would need for the same thing.
   */
  interface Ring {
    mesh: THREE.Mesh;
    material: THREE.MeshBasicMaterial;
    age: number;
    span: number;
    from: number;
    to: number;
    strength: number;
  }
  // 0.90-1.0 is a THIN annulus on purpose. The first cut used 0.62-1.0, a band 38% of the radius
  // wide, and every ring big enough to read as a shock arrived as a solid white donut that hid the
  // pose behind it — and, seen edge-on, as a grey bar across the whole frame.
  const ringGeometry = new THREE.RingGeometry(0.9, 1, 96, 1);
  const rings: Ring[] = [];
  for (let i = 0; i < RING_CAPACITY; i++) {
    const material = new THREE.MeshBasicMaterial({
      color: KI_MID.clone(), transparent: true, opacity: 0,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(ringGeometry, material);
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.userData.isHighlight = true;
    group.add(mesh);
    rings.push({ mesh, material, age: 1, span: 1, from: 0, to: 1, strength: 0 });
  }
  let ringCursor = 0;

  /** `axis` is the ring's normal: the travel direction for an air shock, +Y for a ground ring. */
  function spawnRing(
    at: THREE.Vector3, axis: THREE.Vector3,
    from: number, to: number, span: number, colour: THREE.Color, strength: number,
  ): void {
    const ring = rings[ringCursor];
    ringCursor = (ringCursor + 1) % RING_CAPACITY;
    ring.mesh.position.copy(at);
    ring.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), scratchA.copy(axis).normalize());
    ring.material.color.copy(colour);
    ring.age = 0;
    ring.span = span;
    ring.from = from;
    ring.to = to;
    ring.strength = strength;
    ring.mesh.visible = true;
    ring.mesh.scale.setScalar(from);
  }

  function stepRings(dt: number): number {
    let live = 0;
    for (const ring of rings) {
      if (ring.age >= 1) {
        if (ring.mesh.visible) { ring.mesh.visible = false; ring.material.opacity = 0; }
        continue;
      }
      ring.age += dt / ring.span;
      if (ring.age >= 1) { ring.mesh.visible = false; ring.material.opacity = 0; continue; }
      live++;
      // Ease out: a ring at constant speed reads as an animation, one that decelerates as a shock.
      const t = 1 - Math.pow(1 - ring.age, 2.4);
      ring.mesh.scale.setScalar(ring.from + (ring.to - ring.from) * t);
      ring.material.opacity = ring.strength * Math.pow(1 - ring.age, 1.5);
    }
    return live;
  }

  // -------------------------------------------------------------------------- flashes + light
  /** Contact flares, billboarded by the renderer because a Sprite always faces the camera. */
  interface Flash { sprite: THREE.Sprite; material: THREE.SpriteMaterial; age: number; span: number; size: number; strength: number }
  const flashes: Flash[] = [];
  for (let i = 0; i < FLASH_CAPACITY; i++) {
    const material = new THREE.SpriteMaterial({
      map: sparkMap, color: KI_CORE.clone(), transparent: true,
      opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const sprite = new THREE.Sprite(material);
    sprite.visible = false;
    sprite.userData.isHighlight = true;
    group.add(sprite);
    flashes.push({ sprite, material, age: 1, span: 1, size: 1, strength: 0 });
  }
  let flashCursor = 0;

  function spawnFlash(at: THREE.Vector3, size: number, span: number, colour: THREE.Color, strength: number): void {
    const flash = flashes[flashCursor];
    flashCursor = (flashCursor + 1) % FLASH_CAPACITY;
    flash.sprite.position.copy(at);
    flash.material.color.copy(colour);
    flash.age = 0;
    flash.span = span;
    flash.size = size;
    flash.strength = strength;
    flash.sprite.visible = true;
  }

  /**
   * Three pooled point lights. This is the layer that makes a hit land: a flare is a bright sprite
   * in front of the figure, but a LIGHT puts that brightness onto her arm and the floor, and the eye
   * reads the second one as an event in the scene rather than a decal over it.
   */
  interface Pulse { light: THREE.PointLight; age: number; span: number; peak: number }
  const pulses: Pulse[] = [];
  for (let i = 0; i < LIGHT_CAPACITY; i++) {
    const light = new THREE.PointLight(KI_MID.getHex(), 0, 6, 2);
    light.visible = false;
    light.userData.isHighlight = true;
    group.add(light);
    pulses.push({ light, age: 1, span: 1, peak: 0 });
  }
  let pulseCursor = 0;

  function spawnPulse(at: THREE.Vector3, colour: THREE.Color, peak: number, span: number, distance: number): void {
    const pulse = pulses[pulseCursor];
    pulseCursor = (pulseCursor + 1) % LIGHT_CAPACITY;
    pulse.light.position.copy(at);
    pulse.light.color.copy(colour);
    pulse.light.distance = distance;
    pulse.age = 0;
    pulse.span = span;
    pulse.peak = peak;
    pulse.light.visible = true;
  }

  function stepFlashesAndLights(dt: number): void {
    for (const flash of flashes) {
      if (flash.age >= 1) { if (flash.sprite.visible) flash.sprite.visible = false; continue; }
      flash.age += dt / flash.span;
      if (flash.age >= 1) { flash.sprite.visible = false; flash.material.opacity = 0; continue; }
      // Snap open in the first eighth of its life, then fall away.
      const t = flash.age;
      const shape = t < 0.12 ? t / 0.12 : Math.pow(1 - (t - 0.12) / 0.88, 2.0);
      flash.material.opacity = flash.strength * shape;
      flash.sprite.scale.setScalar(flash.size * (0.55 + t * 1.1));
    }
    for (const pulse of pulses) {
      if (pulse.age >= 1) { if (pulse.light.visible) { pulse.light.visible = false; pulse.light.intensity = 0; } continue; }
      pulse.age += dt / pulse.span;
      if (pulse.age >= 1) { pulse.light.visible = false; pulse.light.intensity = 0; continue; }
      const t = pulse.age;
      pulse.light.intensity = pulse.peak * (t < 0.1 ? t / 0.1 : Math.pow(1 - (t - 0.1) / 0.9, 2.6));
    }
  }

  // ------------------------------------------------------------------------------- ribbons
  /**
   * One ribbon per striking limb. The strip is built ONCE and only its buffers are rewritten, and
   * the vertices are widened in the VERTEX SHADER rather than on the CPU: the offset that makes a
   * ribbon face the camera is `cross(tangent, eye)`, which needs the view matrix, and doing it in
   * the shader means the effects layer never has to be handed a camera.
   *
   * The trail is a FIFO of world positions with a per-point strength. It is NOT cleared when a limb
   * slows down — it fades from the tail forward, so the ribbon closes the way a real streak does
   * instead of vanishing on one frame.
   */
  const TRAIL_VERTEX = `
attribute vec3 aDir;
attribute float aSide;
attribute float aFade;
attribute vec3 aColour;
uniform float uWidth;
varying float vFade;
varying vec3 vColour;
void main() {
  vFade = aFade;
  vColour = aColour;
  vec4 view = modelViewMatrix * vec4(position, 1.0);
  vec3 tangent = (modelViewMatrix * vec4(aDir, 0.0)).xyz;
  vec3 side = cross(normalize(tangent), normalize(-view.xyz));
  float len = length(side);
  if (len > 0.0001) view.xyz += (side / len) * aSide * uWidth * aFade;
  gl_Position = projectionMatrix * view;
}
`;

  const TRAIL_FRAGMENT = `
varying float vFade;
varying vec3 vColour;
void main() {
  if (vFade <= 0.0) discard;
  gl_FragColor = vec4(vColour * vFade, vFade);
}
`;

  interface Trail {
    mesh: THREE.Mesh;
    material: THREE.ShaderMaterial;
    /** Newest first. */
    px: Float32Array;
    py: Float32Array;
    pz: Float32Array;
    strength: Float32Array;
    filled: number;
    tint: number;
    position: Float32Array;
    dir: Float32Array;
    fade: Float32Array;
    colour: Float32Array;
  }

  function makeTrail(width: number, tint: number): Trail {
    const verts = TRAIL_SEGMENTS * 2;
    const position = new Float32Array(verts * 3);
    const dir = new Float32Array(verts * 3);
    const side = new Float32Array(verts);
    const fade = new Float32Array(verts);
    const colour = new Float32Array(verts * 3);
    for (let i = 0; i < TRAIL_SEGMENTS; i++) {
      side[i * 2] = 1;
      side[i * 2 + 1] = -1;
    }
    const index: number[] = [];
    for (let i = 0; i < TRAIL_SEGMENTS - 1; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('aDir', new THREE.BufferAttribute(dir, 3));
    geometry.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    geometry.setAttribute('aFade', new THREE.BufferAttribute(fade, 1));
    geometry.setAttribute('aColour', new THREE.BufferAttribute(colour, 3));
    geometry.setIndex(index);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 40);
    const material = new THREE.ShaderMaterial({
      uniforms: { uWidth: { value: width } },
      vertexShader: TRAIL_VERTEX,
      fragmentShader: TRAIL_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.userData.isHighlight = true;
    group.add(mesh);
    return {
      mesh, material, position, dir, fade, colour, tint, filled: 0,
      px: new Float32Array(TRAIL_SEGMENTS),
      py: new Float32Array(TRAIL_SEGMENTS),
      pz: new Float32Array(TRAIL_SEGMENTS),
      strength: new Float32Array(TRAIL_SEGMENTS),
    };
  }

  const trails: Record<string, Trail> = {
    'hand:left': makeTrail(0.052, 0.82),
    'hand:right': makeTrail(0.052, 0.82),
    'foot:left': makeTrail(0.070, 0.95),
    'foot:right': makeTrail(0.070, 0.95),
  };

  function pushTrail(trail: Trail, at: THREE.Vector3, strength: number): void {
    for (let i = TRAIL_SEGMENTS - 1; i > 0; i--) {
      trail.px[i] = trail.px[i - 1];
      trail.py[i] = trail.py[i - 1];
      trail.pz[i] = trail.pz[i - 1];
      trail.strength[i] = trail.strength[i - 1];
    }
    trail.px[0] = at.x;
    trail.py[0] = at.y;
    trail.pz[0] = at.z;
    trail.strength[0] = strength;
    trail.filled = Math.min(trail.filled + 1, TRAIL_SEGMENTS);
  }

  function rebuildTrail(trail: Trail): boolean {
    let any = false;
    for (let i = 0; i < TRAIL_SEGMENTS; i++) {
      const live = i < trail.filled;
      // Tangent from the neighbours, so the ribbon's width is perpendicular to the path it took.
      const a = Math.max(0, i - 1);
      const b = Math.min(TRAIL_SEGMENTS - 1, i + 1);
      let dx = trail.px[a] - trail.px[b];
      let dy = trail.py[a] - trail.py[b];
      let dz = trail.pz[a] - trail.pz[b];
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-6) { dx = 0; dy = 1; dz = 0; } else { dx /= len; dy /= len; dz /= len; }
      // Taper along the trail AND by the strength the limb had when that point was recorded.
      const taper = live ? Math.pow(1 - i / TRAIL_SEGMENTS, 1.35) * trail.strength[i] : 0;
      if (taper > 0.002) any = true;
      rampColour(trail.tint + taper * 0.25, tintColour);
      for (let s = 0; s < 2; s++) {
        const v = i * 2 + s;
        trail.position[v * 3] = trail.px[i];
        trail.position[v * 3 + 1] = trail.py[i];
        trail.position[v * 3 + 2] = trail.pz[i];
        trail.dir[v * 3] = dx;
        trail.dir[v * 3 + 1] = dy;
        trail.dir[v * 3 + 2] = dz;
        trail.fade[v] = taper;
        trail.colour[v * 3] = tintColour.r;
        trail.colour[v * 3 + 1] = tintColour.g;
        trail.colour[v * 3 + 2] = tintColour.b;
      }
    }
    const geometry = trail.mesh.geometry;
    geometry.getAttribute('position').needsUpdate = true;
    geometry.getAttribute('aDir').needsUpdate = true;
    geometry.getAttribute('aFade').needsUpdate = true;
    geometry.getAttribute('aColour').needsUpdate = true;
    trail.mesh.visible = any;
    return any;
  }

  // ---------------------------------------------------------------------------- kikoken orb
  /**
   * The projectile. A hollow shell for the silhouette, a solid core for the centre, two crossed
   * halo rings so the thing has an axis, and a light of its own so it lifts the floor and her arm
   * as it goes past. It is the only effect here that OUTLIVES the frame it was fired on, so the
   * showcase owns its whole flight and the action switching has to be able to cancel it.
   */
  const orbGroup = new THREE.Group();
  orbGroup.visible = false;
  orbGroup.userData.isHighlight = true;
  const orbCore = new THREE.Mesh(
    new THREE.SphereGeometry(1, 24, 16),
    new THREE.MeshBasicMaterial({ color: KI_CORE.clone(), transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  orbCore.scale.setScalar(0.45);
  const orbShell = new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 24),
    new THREE.ShaderMaterial({
      uniforms: { uInner: { value: KI_MID.clone() }, uOuter: { value: KI_DEEP.clone() }, uOpacity: { value: 1 } },
      vertexShader: SHELL_VERTEX,
      fragmentShader: SHELL_FRAGMENT,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    }),
  );
  // Thin and tinted, not thick and white. A 1.05-1.32 band in KI_CORE went grey the moment it was
  // added over a dark background, and seen face-on it turned the orb into a flat target symbol.
  const orbHaloA = new THREE.Mesh(
    new THREE.RingGeometry(1.16, 1.28, 64, 1),
    new THREE.MeshBasicMaterial({ color: KI_MID.clone(), transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  const orbHaloB = orbHaloA.clone();
  orbHaloB.material = (orbHaloA.material as THREE.MeshBasicMaterial).clone();
  orbHaloB.rotation.set(Math.PI / 2, 0, 0);
  // Tipped off the axis so the two rings CROSS rather than nest, which is what gives the orb a
  // readable 3D axis instead of a set of concentric circles.
  orbHaloA.rotation.set(0, 0.5, 0);
  const orbLight = new THREE.PointLight(KI_MID.getHex(), 0, 5.5, 2);
  orbGroup.add(orbCore, orbShell, orbHaloA, orbHaloB, orbLight);
  for (const child of orbGroup.children) child.userData.isHighlight = true;
  group.add(orbGroup);

  const orb = {
    state: 'off' as 'off' | 'forming' | 'flight',
    radius: 0,
    target: 0,
    life: 0,
    span: 1,
    wake: 0,
    velocity: new THREE.Vector3(),
    direction: new THREE.Vector3(1, 0, 0),
  };

  function orbBurst(): void {
    const at = orbGroup.position;
    // The orb bursts about 2.3 units from the camera, where the visible frame is only 1.23 units
    // tall. A ring of radius 1.05 there is nearly twice the frame height — it filled half the shot
    // and cropped off the edge. These radii put the shock at roughly two-thirds of frame height.
    spawnRing(at, orb.direction, orb.radius * 1.2, 0.45, 0.52, KI_MID, 0.95);
    spawnRing(at, orb.direction, orb.radius * 0.8, 0.68, 0.72, KI_DEEP, 0.6);
    spawnFlash(at, 0.5, 0.32, KI_CORE, 1.0);
    spawnPulse(at, KI_MID, 26, 0.42, 7);
    burst(hot, at, orb.direction, 46, 5.4, 1.0, { size: 0.16, span: 0.62, tint: 0.95, gravity: -1.4, drag: 2.2 });
    burst(hot, at, up, 22, 2.6, 1.0, { size: 0.11, span: 0.9, tint: 0.55, gravity: -0.7, drag: 1.5 });
    for (let i = 0; i < 12; i++) {
      scratchB.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
      spawnStreak(at, scratchB, 0.5 + Math.random() * 0.5, 0.26, 0.9);
    }
    orbGroup.visible = false;
    orb.state = 'off';
    orb.radius = 0;
  }

  function stepOrb(dt: number): void {
    if (orb.state === 'off') return;
    if (orb.state === 'forming') {
      // Ease toward the size the caller asked for, so a charge that ramps looks like it condenses.
      orb.radius += (orb.target - orb.radius) * Math.min(1, dt * 9);
      orbGroup.visible = orb.radius > 0.012;
      orbCore.scale.setScalar(orb.radius * 0.5);
      orbShell.scale.setScalar(orb.radius);
      orbHaloA.scale.setScalar(orb.radius);
      orbHaloB.scale.setScalar(orb.radius);
      orbLight.intensity = orb.radius * 22;
      orbLight.distance = 2.2 + orb.radius * 6;
    } else {
      orb.life += dt;
      orbGroup.position.addScaledVector(orb.velocity, dt);
      // It grows slightly as it travels, which reads as "still burning" rather than "a moving ball".
      const t = orb.life / orb.span;
      orbCore.scale.setScalar(orb.radius * (0.5 + t * 0.22));
      orbShell.scale.setScalar(orb.radius * (1 + t * 0.34));
      orbHaloA.scale.setScalar(orb.radius * (1 + t * 0.5));
      orbHaloB.scale.setScalar(orb.radius * (1 + t * 0.5));
      orbLight.intensity = 20 + Math.sin(orb.life * 34) * 4;
      orb.wake -= dt;
      if (orb.wake <= 0) {
        orb.wake = 0.016;
        // Motes, not a line. A `LineSegments` is always ONE PIXEL wide in WebGL whatever the
        // material asks for, and behind a bright orb that read as a wire stretched across the shot.
        // Speed lines survive it because a dozen faint hairlines together read as motion; a single
        // one behind a solid object does not.
        for (let n = 0; n < 2; n++) {
          scratchB.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.75);
          scratchB.addScaledVector(orb.direction, -1.2);
          spawn(hot, orbGroup.position, scratchB, {
            size: 0.09 + Math.random() * 0.07, span: 0.34 + Math.random() * 0.2,
            tint: 0.7 + Math.random() * 0.35, drag: 2.6, gravity: 0.3,
          });
        }
      }
      if (orb.life >= orb.span) orbBurst();
    }
    orbHaloA.rotation.z += dt * 5.2;
    orbHaloB.rotation.y += dt * 4.1;
  }

  // ------------------------------------------------------------------------------- aura tick
  let auraEmit = 0;
  let auraRing = 0;
  let breathEmit = 0;

  // --------------------------------------------------------------------------------- API
  const api: ChunLiVfx = {
    group,

    trail(limb, side, at, strength) {
      const trail = trails[`${limb}:${side}`];
      pushTrail(trail, at, Math.min(1, Math.max(0, strength)));
      // A limb moving hard also sheds motes, which is what keeps the ribbon from looking like a
      // flat decal stuck to the hand.
      if (strength > 0.55 && Math.random() < strength * 0.55) {
        scratchB.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.55);
        spawn(hot, at, scratchB, { size: 0.055 + strength * 0.05, span: 0.24, tint: 0.6 + strength * 0.3, drag: 3.2, gravity: -0.4 });
      }
    },

    charge(at, amount, warm = false) {
      if (amount <= 0.01) return;
      const tint = warm ? 1.25 : 0.5 + amount * 0.45;
      // Motes spawn on a shell and fly INWARD, which is the whole read of "gathering".
      const count = amount > 0.6 ? 2 : 1;
      for (let n = 0; n < count; n++) {
        scratchB.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
        if (scratchB.lengthSq() < 1e-6) scratchB.set(1, 0, 0);
        scratchB.normalize();
        const radius = 0.22 + Math.random() * 0.3;
        scratchA.copy(at).addScaledVector(scratchB, radius);
        scratchC.copy(scratchB).multiplyScalar(-radius / 0.22 * (0.9 + amount));
        spawn(hot, scratchA, scratchC, { size: 0.05 + amount * 0.07, span: 0.24, tint, drag: 0.6, peak: 0.5 });
      }
      if (amount > 0.35) {
        spawnPulse(at, warm ? GOLD : KI_MID, amount * 5, 0.09, 1.6 + amount);
      }
    },

    strike(limb, at, dir, power) {
      const p = Math.min(1, Math.max(0, power));
      const heavy = limb === 'foot';
      // Ring down the travel axis: a shock leaving along the strike, not a decal facing the camera.
      // Radii are in world units against a 1.9-unit figure: a shock off a boot is a HAND's width
      // across, not a body's. The first pass used 3.0 and it read as scenery, not as a hit.
      spawnRing(at, dir, 0.06, heavy ? 0.34 + p * 0.30 : 0.24 + p * 0.22, 0.28 + p * 0.1, KI_MID, 0.6 + p * 0.25);
      spawnRing(at, dir, 0.04, heavy ? 0.2 + p * 0.18 : 0.14 + p * 0.14, 0.2, KI_CORE, 0.4 + p * 0.25);
      spawnFlash(at, (heavy ? 0.5 : 0.36) + p * 0.34, 0.2, GOLD, 0.8 + p * 0.2);
      spawnPulse(at, GOLD, (heavy ? 16 : 11) + p * 14, 0.2, 4.5);
      // Spray forward along the strike, plus a thin back-spray so the contact has two sides.
      burst(hot, at, dir, heavy ? 26 : 18, 3.4 + p * 3.4, 0.62, { size: 0.1 + p * 0.06, span: 0.36, tint: 1.1, gravity: -2.2, drag: 3.0 });
      scratchA.copy(dir).multiplyScalar(-1);
      burst(hot, at, scratchA, 7, 1.5 + p, 0.9, { size: 0.07, span: 0.3, tint: 0.7, gravity: -1.6, drag: 3.6 });
      for (let i = 0; i < (heavy ? 7 : 4); i++) {
        scratchB.copy(dir).add(scratchC.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.7)).normalize();
        spawnStreak(at, scratchB, 0.28 + p * 0.4, 0.17, 1.05);
      }
      // A kick close to the ground still throws debris up off it. There is no stage geometry in
      // this demo, so what used to be a flat ring lying at y=0 is gone: with nothing to lie ON it
      // read as a grey ellipse hanging in the air. Airborne dust needs no surface to be believable.
      if (at.y < 0.55) {
        scratchA.set(at.x, 0.012, at.z);
        burst(dust, scratchA, up, 11, 0.8 + p * 0.9, 1.0, { size: 0.2, span: 0.85, tint: 0, gravity: -0.5, drag: 2.1, peak: 0.25 });
      }
      // Hitstop, scaled by the measured power: 45 ms for a jab-weight arrival, 105 for a snap kick.
      return (heavy ? 0.055 : 0.04) + p * 0.05;
    },

    slam(at, power) {
      const p = Math.min(1, Math.max(0, power));
      scratchA.set(at.x, 0.014, at.z);
      // Rings on the DOWNWARD axis rather than lying flat. The blow travels into the ground, and
      // with no stage geometry to draw a ripple on, a ring expanding down the blow's own axis is
      // what still reads as force going somewhere.
      scratchB.set(0, -1, 0);
      spawnRing(at, scratchB, 0.1, 0.6 + p * 0.3, 0.6, KI_MID, 0.85);
      spawnRing(at, scratchB, 0.07, 0.36 + p * 0.2, 0.4, GOLD, 0.6);
      spawnRing(at, scratchB, 0.05, 0.22 + p * 0.15, 0.3, KI_CORE, 0.5);
      spawnFlash(at, 0.7 + p * 0.4, 0.26, GOLD, 1.0);
      // Half what it was. At 36 over a 6-unit radius this light sits at chest height right in front
      // of her and washed the whole figure to white on the contact frame — the flash stopped
      // reading as an impact and started reading as an exposure error.
      spawnPulse(at, GOLD, 13 + p * 7, 0.3, 4.5);
      // Everything a slam throws goes UP and outward off the floor, not forward.
      burst(dust, scratchA, up, 34, 2.2 + p * 1.6, 0.95, { size: 0.28, span: 1.25, tint: 0, gravity: -1.1, drag: 1.5, peak: 0.22 });
      burst(hot, scratchA, up, 26, 3.6 + p * 2.4, 0.7, { size: 0.11, span: 0.6, tint: 1.05, gravity: -3.2, drag: 2.2 });
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        scratchB.set(Math.cos(a), 0.28, Math.sin(a)).normalize();
        spawnStreak(scratchA, scratchB, 0.55, 0.28, 0.85);
      }
    },

    footfall(at, drop) {
      const p = Math.min(1, drop / 0.9);
      scratchA.set(at.x, 0.012, at.z);
      burst(dust, scratchA, up, 10 + Math.round(p * 12), 0.7 + p * 1.1, 1.0, { size: 0.22, span: 0.95, tint: 0, gravity: -0.8, drag: 1.9, peak: 0.24 });
      if (p > 0.5) spawnPulse(scratchA, KI_MID, 5 * p, 0.16, 2.2);
    },

    stride(at, dir, power) {
      const p = Math.min(1, Math.max(0, power));
      scratchA.set(at.x, 0.012, at.z);
      // Dust is thrown BACKWARD out of a stride: the foot pushes the floor the other way.
      scratchB.copy(dir).multiplyScalar(-1);
      scratchB.y = 0.55;
      scratchB.normalize();
      burst(dust, scratchA, scratchB, 9 + Math.round(p * 9), 1.1 + p * 1.5, 0.5, { size: 0.2, span: 0.8, tint: 0, gravity: -1.0, drag: 2.0, peak: 0.2 });
      if (p > 0.6) {
        burst(hot, at, scratchB, 4, 1.6, 0.6, { size: 0.06, span: 0.28, tint: 0.65, gravity: -1.2, drag: 3.0 });
      }
    },

    speedline(at, dir, amount) {
      if (amount <= 0.01) return;
      scratchB.copy(at);
      scratchB.x += (Math.random() - 0.5) * 0.22;
      scratchB.y += (Math.random() - 0.5) * 0.5;
      scratchB.z += (Math.random() - 0.5) * 0.22;
      spawnStreak(scratchB, dir, 0.35 + amount * 0.85, 0.2, 0.55 + amount * 0.3);
    },

    aura(at, amount) {
      if (amount <= 0.02) return;
      auraEmit -= amount;
      while (auraEmit <= 0) {
        auraEmit += 0.55;
        const a = Math.random() * Math.PI * 2;
        const radius = 0.2 + Math.random() * 0.34;
        scratchA.set(at.x + Math.cos(a) * radius, 0.02 + Math.random() * 0.25, at.z + Math.sin(a) * radius);
        // Rising and swirling: the tangential component is what stops it looking like a fountain.
        scratchB.set(-Math.sin(a) * 0.7, 1.5 + Math.random() * 1.4 + amount, Math.cos(a) * 0.7);
        spawn(hot, scratchA, scratchB, { size: 0.07 + amount * 0.05, span: 0.85, tint: 0.45 + amount * 0.5, drag: 0.5, gravity: 0.6, peak: 0.3 });
      }
      auraRing -= amount;
      if (auraRing <= 0) {
        auraRing = 1;
        scratchA.set(at.x, 0.012, at.z);
        spawnRing(scratchA, up, 0.2, 0.62 + amount * 0.42, 0.85, KI_MID, 0.28 + amount * 0.3);
        spawnPulse(scratchA, KI_MID, 6 + amount * 8, 0.5, 4);
      }
    },

    breathe(at) {
      breathEmit -= 1;
      if (breathEmit > 0) return;
      breathEmit = 14 + Math.floor(Math.random() * 14);
      scratchB.set((Math.random() - 0.5) * 0.4, 0.35 + Math.random() * 0.4, (Math.random() - 0.5) * 0.4);
      spawn(hot, at, scratchB, { size: 0.05, span: 1.05, tint: 0.4, drag: 1.1, gravity: 0.25, peak: 0.35 });
    },

    formOrb(at, amount) {
      orb.state = 'forming';
      orb.target = 0.06 + amount * 0.20;
      orbGroup.position.copy(at);
    },

    fireOrb(at, dir, flightSeconds, range) {
      orbGroup.position.copy(at);
      orb.direction.copy(dir).normalize();
      orb.state = 'flight';
      orb.life = 0;
      orb.span = flightSeconds;
      orb.radius = Math.max(orb.radius, 0.2);
      orb.velocity.copy(orb.direction).multiplyScalar(range / flightSeconds);
      // Point the orb's own +Z down the throw. Without this the halos keep the world's axes, so
      // whichever way she threw it they faced the camera and read as flat circles.
      orbGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), orb.direction);
      orbGroup.visible = true;
      // Muzzle: a ring down the throw axis, a hard flash at the palms and recoil dust at the feet.
      spawnRing(at, orb.direction, 0.1, 0.52, 0.38, KI_MID, 0.85);
      spawnRing(at, orb.direction, 0.07, 0.32, 0.26, GOLD, 0.55);
      spawnFlash(at, 0.6, 0.24, KI_CORE, 1.0);
      spawnPulse(at, KI_MID, 30, 0.28, 6);
      scratchA.copy(orb.direction).multiplyScalar(-1);
      burst(hot, at, scratchA, 20, 2.6, 0.85, { size: 0.09, span: 0.42, tint: 0.85, gravity: -1.8, drag: 3.0 });
      scratchC.set(at.x, 0.012, at.z);
      burst(dust, scratchC, up, 12, 1.3, 1.0, { size: 0.22, span: 0.9, tint: 0, gravity: -0.9, drag: 1.9, peak: 0.22 });
    },

    flare(at, power) {
      const p = Math.min(1, Math.max(0, power));
      spawnRing(at, up, 0.08, 0.42 + p * 0.32, 0.34, KI_MID, 0.55 + p * 0.3);
      spawnFlash(at, 0.42 + p * 0.3, 0.2, KI_CORE, 0.7 + p * 0.3);
      spawnPulse(at, KI_MID, 10 + p * 8, 0.2, 3.2);
      burst(hot, at, up, 16, 2.2 + p * 1.6, 1.0, { size: 0.08, span: 0.5, tint: 0.8, gravity: -1.5, drag: 2.4 });
      orb.state = 'off';
      orb.radius = 0;
      orb.target = 0;
      orbGroup.visible = false;
    },

    reset() {
      for (const pool of [hot, dust]) {
        pool.age.fill(1);
        pool.alpha.fill(0);
      }
      streakAge.fill(1);
      streakColour.fill(0);
      for (const ring of rings) { ring.age = 1; ring.mesh.visible = false; ring.material.opacity = 0; }
      for (const flash of flashes) { flash.age = 1; flash.sprite.visible = false; flash.material.opacity = 0; }
      for (const pulse of pulses) { pulse.age = 1; pulse.light.visible = false; pulse.light.intensity = 0; }
      for (const trail of Object.values(trails)) {
        trail.filled = 0;
        trail.strength.fill(0);
        trail.mesh.visible = false;
      }
      orb.state = 'off';
      orb.radius = 0;
      orb.target = 0;
      orbGroup.visible = false;
      orbLight.intensity = 0;
    },

    counts() {
      let ringCount = 0;
      for (const ring of rings) if (ring.age < 1) ringCount++;
      let hotCount = 0;
      for (let i = 0; i < HOT_CAPACITY; i++) if (hot.age[i] < 1) hotCount++;
      let dustCount = 0;
      for (let i = 0; i < DUST_CAPACITY; i++) if (dust.age[i] < 1) dustCount++;
      let streakCount = 0;
      for (let i = 0; i < STREAK_CAPACITY; i++) if (streakAge[i] < 1) streakCount++;
      return { hot: hotCount, dust: dustCount, streaks: streakCount, rings: ringCount, orb: orb.state !== 'off' };
    },

    update(dt) {
      stepPool(hot, dt);
      stepPool(dust, dt);
      stepStreaks(dt);
      stepRings(dt);
      stepFlashesAndLights(dt);
      stepOrb(dt);
      for (const trail of Object.values(trails)) rebuildTrail(trail);
    },

    dispose() {
      group.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const material = (mesh as unknown as { material?: THREE.Material | THREE.Material[] }).material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material?.dispose();
      });
      sparkMap.dispose();
      puffMap.dispose();
    },
  };

  return api;
}
