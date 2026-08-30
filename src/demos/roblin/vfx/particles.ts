import * as THREE from 'three';
import { createRng, type Rng } from './rng';

/**
 * A pooled additive particle field.
 *
 * HAND-WRITTEN. Three.js has no particle subsystem — no emitters, no pooling, no lifetimes — so
 * everything below is this showcase's own code on top of `THREE.Points`: a fixed-capacity ring of
 * particles, CPU integration, and a point-sprite shader that draws a soft disc procedurally rather
 * than sampling a texture (this pipeline emits no textures, and a texture would be a fetch).
 *
 * Capacity is fixed on purpose. Allocating during a cast is what turns a nice effect into a
 * frame-time spike; when the pool is full the oldest particle is recycled instead.
 */

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
  /**
   * 0 for a steady spark, 1 for a guttering ember. Embers do not glow evenly — they pulse as they
   * tumble, and a field of perfectly steady dots is what makes a fire effect read as confetti.
   */
  flicker?: number;
  /** Starting velocity added to every particle, e.g. the projectile's own. */
  inherit?: THREE.Vector3;
}

const VERTEX = /* glsl */ `
  attribute float aSize;
  attribute float aAge;
  attribute float aLife;
  attribute vec3 aColour;
  attribute vec3 aColourEnd;
  attribute float aFlicker;
  attribute float aSeed;
  varying vec3 vColour;
  varying float vFade;
  uniform float uScale;
  uniform float uTime;

  void main() {
    float t = clamp(aAge / max(aLife, 0.0001), 0.0, 1.0);
    // Fast in, slow out: a particle that fades linearly reads as a dot that switches off.
    vFade = pow(1.0 - t, 1.7);
    // Two detuned sines so the pulse never settles into an obvious rhythm across the field.
    float phase = aSeed * 6.2831853;
    float gutter = 0.62 + 0.38 * (0.5 + 0.5 * sin(uTime * 17.0 + phase))
                        * (0.65 + 0.35 * sin(uTime * 6.3 + phase * 2.7));
    vFade *= mix(1.0, gutter, aFlicker);
    vColour = mix(aColour, aColourEnd, t);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // Grow a little then shrink, so a spark reads as expanding gas rather than a shrinking dot.
    float grow = 1.0 + 0.9 * sin(t * 3.14159);
    gl_PointSize = aSize * grow * uScale / max(-mv.z, 0.001);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAGMENT = /* glsl */ `
  varying vec3 vColour;
  varying float vFade;

  void main() {
    // Procedural sprite: squared radial falloff with a hot core. No texture, no fetch.
    vec2 d = gl_PointCoord - vec2(0.5);
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;
    float falloff = 1.0 - r2 * 4.0;
    float core = pow(falloff, 3.0);
    float glow = pow(falloff, 1.2) * 0.45;
    gl_FragColor = vec4(vColour * (core + glow) * vFade, 1.0);
  }
`;

export class ParticleField {
  readonly points: THREE.Points;
  private readonly capacity: number;
  private readonly position: Float32Array;
  private readonly velocity: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly size: Float32Array;
  private readonly colour: Float32Array;
  private readonly colourEnd: Float32Array;
  private readonly gravity: Float32Array;
  private readonly drag: Float32Array;
  private readonly swirl: Float32Array;
  private readonly flicker: Float32Array;
  private readonly seed: Float32Array;
  private readonly axis: Float32Array;
  private cursor = 0;
  private live = 0;
  private readonly rng: Rng;
  private readonly geometry: THREE.BufferGeometry;

  constructor(capacity = 4000, seed = 0x120b11) {
    this.capacity = capacity;
    this.rng = createRng(seed | 0);
    this.position = new Float32Array(capacity * 3);
    this.velocity = new Float32Array(capacity * 3);
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.colour = new Float32Array(capacity * 3);
    this.colourEnd = new Float32Array(capacity * 3);
    this.gravity = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.swirl = new Float32Array(capacity);
    this.flicker = new Float32Array(capacity);
    this.seed = new Float32Array(capacity);
    this.axis = new Float32Array(capacity * 3);
    // Dead particles are parked with life 0; the shader fades them to nothing.
    this.life.fill(0);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.position, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    geometry.setAttribute('aAge', new THREE.BufferAttribute(this.age, 1));
    geometry.setAttribute('aLife', new THREE.BufferAttribute(this.life, 1));
    geometry.setAttribute('aColour', new THREE.BufferAttribute(this.colour, 3));
    geometry.setAttribute('aColourEnd', new THREE.BufferAttribute(this.colourEnd, 3));
    geometry.setAttribute('aFlicker', new THREE.BufferAttribute(this.flicker, 1));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(this.seed, 1));
    geometry.setDrawRange(0, capacity);
    this.geometry = geometry;

    const material = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 320 }, uTime: { value: 0 } },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      // Additive on purpose: overlapping sparks should build to white-hot, not average to mud.
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
    });

    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.name = 'roblin-particles';
    this.points.renderOrder = 3;
  }

  get liveCount(): number { return this.live; }

  /** Point size scales with the drawing buffer height so a resize does not change the look. */
  setViewportHeight(pixels: number): void {
    (this.points.material as THREE.ShaderMaterial).uniforms.uScale.value = pixels * 0.32;
  }

  emit(options: EmitOptions): void {
    const {
      position, count, speed, life, size, colour,
      colourEnd = colour, gravity = 0, drag = 0, swirl = 0, jitter = 0, flicker = 0,
      spread = Math.PI, direction, inherit,
    } = options;
    const axis = (direction ?? new THREE.Vector3(0, 1, 0)).clone().normalize();
    // Any vector not parallel to the axis gives a usable tangent basis for the cone.
    const helper = Math.abs(axis.y) > 0.94 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const tangent = new THREE.Vector3().crossVectors(axis, helper).normalize();
    const bitangent = new THREE.Vector3().crossVectors(axis, tangent).normalize();
    const dir = new THREE.Vector3();

    for (let n = 0; n < count; n += 1) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.capacity;
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
      this.size[i] = this.rng.range(size[0], size[1]);
      this.colour[i3] = colour.r;
      this.colour[i3 + 1] = colour.g;
      this.colour[i3 + 2] = colour.b;
      this.colourEnd[i3] = colourEnd.r;
      this.colourEnd[i3 + 1] = colourEnd.g;
      this.colourEnd[i3 + 2] = colourEnd.b;
      this.gravity[i] = gravity;
      this.drag[i] = drag;
      this.swirl[i] = swirl;
      this.flicker[i] = flicker;
      this.seed[i] = this.rng();
    }
  }

  update(delta: number): void {
    (this.points.material as THREE.ShaderMaterial).uniforms.uTime.value += delta;
    if (this.live === 0) return;
    const dt = Math.min(delta, 1 / 20); // a tab that was backgrounded must not teleport the field
    let live = 0;
    const tangential = new THREE.Vector3();
    const radial = new THREE.Vector3();
    const axis = new THREE.Vector3();

    for (let i = 0; i < this.capacity; i += 1) {
      if (this.age[i] >= this.life[i]) continue;
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        this.life[i] = 0;
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
    }

    this.live = live;
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.getAttribute('aAge').needsUpdate = true;
    this.geometry.getAttribute('aLife').needsUpdate = true;
    this.geometry.getAttribute('aSize').needsUpdate = true;
    this.geometry.getAttribute('aColour').needsUpdate = true;
    this.geometry.getAttribute('aColourEnd').needsUpdate = true;
    this.geometry.getAttribute('aFlicker').needsUpdate = true;
    this.geometry.getAttribute('aSeed').needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}
