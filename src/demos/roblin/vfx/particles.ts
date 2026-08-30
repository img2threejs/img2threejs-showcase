import * as THREE from 'three';
import { createRng, type Rng } from './rng';

/**
 * The particle field.
 *
 * WHY THIS IS INSTANCED QUADS AND NOT `THREE.Points`.
 *
 * The first version drew everything with `gl_PointSize` — one soft radial disc, scaled and tinted.
 * Every effect in the showcase was therefore made of the same shape, and no amount of colour work
 * fixed how that reads: a fast spark and a drifting spore and a puff of dirt were the same circle
 * at different sizes, so all of it looked like bokeh. Three things a point sprite cannot do, and
 * all three are what separate a real effect from confetti:
 *
 *   STRETCH   a spark travelling at ten units per second is a STREAK, not a dot. A point sprite is
 *             always an axis-aligned square, so it cannot be elongated along its own velocity.
 *   ROTATION  a point sprite cannot spin. Identical un-rotated puffs read as a repeated stamp.
 *   MASS      smoke and dust need alpha blending to occlude what is behind them. Additive can only
 *             ever brighten, so a dust cloud made of additive sprites is a glowing cloud — which is
 *             why every impact so far had light but no weight.
 *
 * So each particle is an instanced quad, billboarded in the vertex shader, optionally aligned and
 * elongated along its screen-space velocity. Two meshes share one CPU simulation: an ADDITIVE one
 * for anything that emits light, and an ALPHA-BLENDED one for anything that is matter. They are two
 * draw calls for the whole showcase.
 */

export type ParticleShape = 'soft' | 'streak' | 'smoke';

export interface EmitOptions {
  position: THREE.Vector3;
  /** Cone axis. Omit for an isotropic burst. */
  direction?: THREE.Vector3;
  /** Half-angle of the emission cone, radians. Pi for a full sphere. */
  spread?: number;
  count: number;
  speed: [number, number];
  life: [number, number];
  size: [number, number];
  colour: THREE.Color;
  /** Colour at the end of life; particles lerp toward it. Defaults to `colour`. */
  colourEnd?: THREE.Color;
  /** World units per second squared along -Y. Negative floats the particle upward. */
  gravity?: number;
  /** Fraction of velocity shed per second. */
  drag?: number;
  /** Tangential acceleration around the cone axis — what makes a plume curl. */
  swirl?: number;
  /** Extra offset randomised inside a sphere of this radius. */
  jitter?: number;
  /** Starting velocity added to every particle, e.g. the projectile's own. */
  inherit?: THREE.Vector3;
  /** 0 for a steady spark, 1 for a guttering ember. */
  flicker?: number;
  /** What it looks like. `streak` also aligns the quad to the direction of travel. */
  shape?: ParticleShape;
  /**
   * How far a `streak` elongates, as a multiple of how fast it is going. 0 keeps it round.
   * Only meaningful with `shape: 'streak'`.
   */
  stretch?: number;
  /** Radians per second of spin. Ignored by `streak`, which is aligned to its velocity. */
  spin?: number;
  /** `matter` is alpha-blended and has weight; `light` is additive and glows. */
  layer?: 'light' | 'matter';
  /** Peak opacity for a `matter` particle. Ignored on the additive layer. */
  opacity?: number;
}

const VERTEX = /* glsl */ `
  attribute vec3 iPosition;
  attribute vec3 iVelocity;
  attribute vec3 iColour;
  attribute vec3 iColourEnd;
  attribute vec2 iAgeLife;
  attribute vec4 iSizeSpinStretchSeed;
  attribute vec2 iShapeOpacity;

  varying vec3 vColour;
  varying float vFade;
  varying vec2 vQuad;
  varying float vShape;
  varying float vSeed;

  void main() {
    float age = iAgeLife.x;
    float life = iAgeLife.y;
    float t = clamp(age / max(life, 0.0001), 0.0, 1.0);
    float dead = step(life, age);

    float size = iSizeSpinStretchSeed.x;
    float spin = iSizeSpinStretchSeed.y;
    float stretch = iSizeSpinStretchSeed.z;
    vSeed = iSizeSpinStretchSeed.w;
    vShape = iShapeOpacity.x;

    // Fast in, slow out: a particle that fades linearly reads as a dot that switches off.
    vFade = pow(1.0 - t, 1.7) * (1.0 - dead);
    // Grow a little then shrink, so a puff reads as expanding gas rather than a shrinking dot.
    float grow = 1.0 + 0.9 * sin(t * 3.14159);
    vColour = mix(iColour, iColourEnd, t);

    vec4 mv = modelViewMatrix * vec4(iPosition, 1.0);
    vec2 corner = position.xy;
    vQuad = corner * 2.0;

    vec2 offset;
    if (stretch > 0.0) {
      // Align to the screen-space projection of the velocity and elongate along it. This is the
      // whole point of the rewrite: a spark becomes a line pointing where it is going.
      vec3 viewVel = mat3(modelViewMatrix) * iVelocity;
      vec2 along = viewVel.xy;
      float speed = length(along);
      along = speed > 1e-5 ? along / speed : vec2(1.0, 0.0);
      vec2 side = vec2(-along.y, along.x);
      float longAxis = size * grow * (1.0 + stretch * speed);
      offset = along * (corner.x * longAxis) + side * (corner.y * size * grow);
    } else {
      float a = spin * age + vSeed * 6.2831853;
      float c = cos(a), s = sin(a);
      vec2 turned = vec2(corner.x * c - corner.y * s, corner.x * s + corner.y * c);
      offset = turned * size * grow;
    }

    mv.xy += offset * (1.0 - dead);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAGMENT = /* glsl */ `
  varying vec3 vColour;
  varying float vFade;
  varying vec2 vQuad;
  varying float vShape;
  varying float vSeed;

  uniform float uTime;
  uniform float uAdditive;
  uniform float uOpacity;

  float hash(vec2 p) {
    p = mod(p, 128.0);
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
               mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }

  void main() {
    float r2 = dot(vQuad, vQuad);
    if (r2 > 1.0) discard;
    float falloff = 1.0 - r2;
    float alpha;
    vec3 colour = vColour;

    if (vShape < 0.5) {
      // SOFT: squared radial falloff with a hot core.
      alpha = pow(falloff, 3.0) + pow(falloff, 1.2) * 0.45;
    } else if (vShape < 1.5) {
      // STREAK: hot along the centreline, tapering to the ends, so the quad reads as a line of
      // light rather than as an oval.
      float body = pow(1.0 - abs(vQuad.y), 2.5);
      float tail = pow(1.0 - abs(vQuad.x), 1.1);
      alpha = body * tail;
      colour += vColour * pow(body, 6.0) * 0.8;
    } else {
      // SMOKE: broken up by noise so no two puffs are the same stamp, and soft enough at the rim
      // that a cloud of them merges instead of showing its individual discs.
      vec2 q = vQuad * 1.3 + vec2(vSeed * 37.0, vSeed * 19.0);
      float n = noise(q * 2.2) * 0.6 + noise(q * 5.1) * 0.4;
      // Smooth all the way from the middle to the rim, and low contrast on the noise. The first
      // version used smoothstep(0, 0.85, falloff), which holds full opacity across the inner 40%
      // and then drops — that gives every puff a defined edge, and a cloud of them reads as
      // popcorn rings rather than as one volume. A cloud only merges if its parts have no edges.
      alpha = pow(falloff, 1.5) * (0.5 + 0.5 * n) * 0.75;
    }

    alpha *= vFade;
    if (alpha <= 0.004) discard;
    // Additive wants premultiplied colour and an alpha of 1; alpha blending wants the real alpha.
    gl_FragColor = mix(vec4(colour, alpha * uOpacity), vec4(colour * alpha, 1.0), uAdditive);
  }
`;

const SHAPE_ID: Record<ParticleShape, number> = { soft: 0, streak: 1, smoke: 2 };

/**
 * Point-sprite sizes converted to world units, so every previously-tuned effect keeps its look.
 *
 * A point sprite was drawn at `aSize * uScale / depth` PIXELS, with `uScale = 0.32 * viewportHeight`.
 * Its world width is that pixel count times the world-per-pixel at its depth, which is
 * `2 * depth * tan(fov/2) / viewportHeight`. The depth and the viewport height both cancel:
 *
 *     world = aSize * 0.32 * H / depth * 2 * depth * tan(fov/2) / H
 *           = aSize * 0.64 * tan(fov/2)
 *
 * At this showcase's 32-degree vertical field of view that is `aSize * 0.1835`. Applying it here
 * rather than editing twenty call sites keeps the RELATIVE sizes that were tuned against renders,
 * and each effect can still be adjusted individually afterwards.
 */
const POINT_SIZE_TO_WORLD = 0.64 * Math.tan((32 * Math.PI) / 180 / 2);

interface Layer {
  mesh: THREE.Mesh;
  geometry: THREE.InstancedBufferGeometry;
  attributes: Record<string, THREE.InstancedBufferAttribute>;
}

export class ParticleField {
  readonly object = new THREE.Group();
  private readonly capacity: number;
  private readonly position: Float32Array;
  private readonly velocity: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly gravity: Float32Array;
  private readonly drag: Float32Array;
  private readonly swirl: Float32Array;
  private readonly axis: Float32Array;
  /** Which layer each slot belongs to; a slot only ever writes into its own layer's buffers. */
  private readonly layerOf: Uint8Array;
  private readonly slotIn: Uint32Array;
  private readonly layers: Layer[] = [];
  private readonly cursors = [0, 0];
  private readonly capacities: number[];
  private live = 0;
  private readonly rng: Rng;

  constructor(capacity = 6000, seed = 0x120b11) {
    this.capacity = capacity;
    this.rng = createRng(seed | 0);
    this.position = new Float32Array(capacity * 3);
    this.velocity = new Float32Array(capacity * 3);
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.gravity = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.swirl = new Float32Array(capacity);
    this.axis = new Float32Array(capacity * 3);
    this.layerOf = new Uint8Array(capacity);
    this.slotIn = new Uint32Array(capacity);

    // Two thirds light, one third matter: smoke is expensive to overdraw and there is much less of
    // it on screen at any moment.
    this.capacities = [Math.floor(capacity * 0.68), capacity - Math.floor(capacity * 0.68)];

    this.object.name = 'roblin-particles';
    for (let l = 0; l < 2; l += 1) this.layers.push(this.buildLayer(l, this.capacities[l]));

    // Assign every slot to a layer up front so emission never has to search.
    let a = 0;
    let b = 0;
    for (let i = 0; i < capacity; i += 1) {
      if (a < this.capacities[0] && (b >= this.capacities[1] || i % 3 !== 2)) {
        this.layerOf[i] = 0;
        this.slotIn[i] = a;
        a += 1;
      } else {
        this.layerOf[i] = 1;
        this.slotIn[i] = b;
        b += 1;
      }
    }
  }

  private buildLayer(layer: number, count: number): Layer {
    const additive = layer === 0;
    const quad = new THREE.PlaneGeometry(1, 1);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = quad.index;
    geometry.attributes.position = quad.attributes.position;
    geometry.instanceCount = count;

    const attributes: Record<string, THREE.InstancedBufferAttribute> = {
      iPosition: new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3),
      iVelocity: new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3),
      iColour: new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3),
      iColourEnd: new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3),
      iAgeLife: new THREE.InstancedBufferAttribute(new Float32Array(count * 2), 2),
      iSizeSpinStretchSeed: new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4),
      iShapeOpacity: new THREE.InstancedBufferAttribute(new Float32Array(count * 2), 2),
    };
    for (const [name, attribute] of Object.entries(attributes)) {
      attribute.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(name, attribute);
    }
    // Dead until emitted: life 0 with age 0 still reads as dead through `step(life, age)`.
    for (let i = 0; i < count; i += 1) attributes.iAgeLife.array[i * 2 + 1] = 0;

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uAdditive: { value: additive ? 1 : 0 },
        uOpacity: { value: 1 },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.name = additive ? 'roblin-particles-light' : 'roblin-particles-matter';
    // Matter first, so smoke sits behind the light it is being lit by.
    mesh.renderOrder = additive ? 3 : 2;
    this.object.add(mesh);
    quad.dispose();
    return { mesh, geometry, attributes };
  }

  get liveCount(): number { return this.live; }

  emit(options: EmitOptions): void {
    const {
      position, count, speed, life, size, colour,
      colourEnd = colour, gravity = 0, drag = 0, swirl = 0, jitter = 0, flicker = 0,
      spread = Math.PI, direction, inherit,
      shape = 'soft', stretch = 0, spin = 0, layer = 'light', opacity = 1,
    } = options;

    const wantLayer = layer === 'light' ? 0 : 1;
    const axis = (direction ?? new THREE.Vector3(0, 1, 0)).clone().normalize();
    const helper = Math.abs(axis.y) > 0.94 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const tangent = new THREE.Vector3().crossVectors(axis, helper).normalize();
    const bitangent = new THREE.Vector3().crossVectors(axis, tangent).normalize();
    const dir = new THREE.Vector3();
    const target = this.layers[wantLayer];
    const shapeId = SHAPE_ID[shape];

    for (let n = 0; n < count; n += 1) {
      // Walk to the next slot that belongs to the layer being emitted into.
      let i = -1;
      for (let probe = 0; probe < this.capacity; probe += 1) {
        const candidate = this.cursors[wantLayer];
        this.cursors[wantLayer] = (candidate + 1) % this.capacity;
        if (this.layerOf[candidate] === wantLayer) { i = candidate; break; }
      }
      if (i < 0) return;
      if (this.life[i] <= this.age[i]) this.live += 1;

      // Cosine-weighted direction inside the cone, so a wide cone is not denser at its rim.
      const cosTheta = 1 - this.rng() * (1 - Math.cos(spread));
      const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
      const phi = this.rng() * Math.PI * 2;
      dir.copy(axis).multiplyScalar(cosTheta)
        .addScaledVector(tangent, sinTheta * Math.cos(phi))
        .addScaledVector(bitangent, sinTheta * Math.sin(phi));

      const v = this.rng.range(speed[0], speed[1]);
      const i3 = i * 3;
      this.position[i3] = position.x + this.rng.spread(jitter);
      this.position[i3 + 1] = position.y + this.rng.spread(jitter);
      this.position[i3 + 2] = position.z + this.rng.spread(jitter);
      this.velocity[i3] = dir.x * v + (inherit?.x ?? 0);
      this.velocity[i3 + 1] = dir.y * v + (inherit?.y ?? 0);
      this.velocity[i3 + 2] = dir.z * v + (inherit?.z ?? 0);
      this.axis[i3] = axis.x;
      this.axis[i3 + 1] = axis.y;
      this.axis[i3 + 2] = axis.z;
      this.age[i] = 0;
      this.life[i] = this.rng.range(life[0], life[1]);
      this.gravity[i] = gravity;
      this.drag[i] = drag;
      this.swirl[i] = swirl;

      const s = this.slotIn[i];
      const a = target.attributes;
      a.iColour.array[s * 3] = colour.r;
      a.iColour.array[s * 3 + 1] = colour.g;
      a.iColour.array[s * 3 + 2] = colour.b;
      a.iColourEnd.array[s * 3] = colourEnd.r;
      a.iColourEnd.array[s * 3 + 1] = colourEnd.g;
      a.iColourEnd.array[s * 3 + 2] = colourEnd.b;
      a.iSizeSpinStretchSeed.array[s * 4] = this.rng.range(size[0], size[1]) * POINT_SIZE_TO_WORLD;
      a.iSizeSpinStretchSeed.array[s * 4 + 1] = spin === 0 ? this.rng.spread(1.2) : this.rng.spread(spin);
      a.iSizeSpinStretchSeed.array[s * 4 + 2] = stretch;
      a.iSizeSpinStretchSeed.array[s * 4 + 3] = this.rng();
      a.iShapeOpacity.array[s * 2] = shapeId;
      a.iShapeOpacity.array[s * 2 + 1] = opacity * (1 - flicker * 0.25);
    }
  }

  update(delta: number): void {
    for (const layer of this.layers) {
      (layer.mesh.material as THREE.ShaderMaterial).uniforms.uTime.value += delta;
    }
    if (this.live === 0) return;
    const dt = Math.min(delta, 1 / 20); // a backgrounded tab must not teleport the field
    let live = 0;
    const tangential = new THREE.Vector3();
    const radial = new THREE.Vector3();
    const axis = new THREE.Vector3();

    for (let i = 0; i < this.capacity; i += 1) {
      if (this.age[i] >= this.life[i]) continue;
      this.age[i] += dt;
      const s = this.slotIn[i];
      const a = this.layers[this.layerOf[i]].attributes;
      if (this.age[i] >= this.life[i]) {
        this.life[i] = 0;
        a.iAgeLife.array[s * 2] = 1;
        a.iAgeLife.array[s * 2 + 1] = 0;
        continue;
      }
      live += 1;
      const i3 = i * 3;
      const decay = Math.max(0, 1 - this.drag[i] * dt);
      this.velocity[i3] *= decay;
      this.velocity[i3 + 1] = this.velocity[i3 + 1] * decay - this.gravity[i] * dt;
      this.velocity[i3 + 2] *= decay;

      if (this.swirl[i] !== 0) {
        axis.set(this.axis[i3], this.axis[i3 + 1], this.axis[i3 + 2]);
        radial.set(this.velocity[i3], this.velocity[i3 + 1], this.velocity[i3 + 2]);
        tangential.crossVectors(axis, radial);
        const len = tangential.length();
        if (len > 1e-5) {
          tangential.multiplyScalar((this.swirl[i] * dt) / len);
          this.velocity[i3] += tangential.x;
          this.velocity[i3 + 1] += tangential.y;
          this.velocity[i3 + 2] += tangential.z;
        }
      }

      this.position[i3] += this.velocity[i3] * dt;
      this.position[i3 + 1] += this.velocity[i3 + 1] * dt;
      this.position[i3 + 2] += this.velocity[i3 + 2] * dt;

      a.iPosition.array[s * 3] = this.position[i3];
      a.iPosition.array[s * 3 + 1] = this.position[i3 + 1];
      a.iPosition.array[s * 3 + 2] = this.position[i3 + 2];
      a.iVelocity.array[s * 3] = this.velocity[i3];
      a.iVelocity.array[s * 3 + 1] = this.velocity[i3 + 1];
      a.iVelocity.array[s * 3 + 2] = this.velocity[i3 + 2];
      a.iAgeLife.array[s * 2] = this.age[i];
      a.iAgeLife.array[s * 2 + 1] = this.life[i];
    }

    this.live = live;
    for (const layer of this.layers) {
      for (const attribute of Object.values(layer.attributes)) attribute.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const layer of this.layers) {
      layer.geometry.dispose();
      (layer.mesh.material as THREE.Material).dispose();
    }
  }
}
