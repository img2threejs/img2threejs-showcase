/**
 * A pooled point-sprite field.
 *
 * HAND-WRITTEN. img2threejs has no particle subsystem — nothing in the skill emits one — so this
 * and everything else under `src/vfx/` is authored code, not generated output.
 *
 * Points rather than instanced quads because a soft round sprite is all any of these effects need,
 * and `gl_PointCoord` gives that for free without a texture: this package ships no image files, so
 * a sprite atlas would have to be a data URI or a canvas draw. The circle is cut in the fragment
 * shader instead.
 *
 * The pool never allocates during play. Dead particles are swapped to the end of the live range
 * and the draw range shrinks, so a burst costs no garbage and the vertex count the GPU walks is
 * the number of particles actually alive.
 */
import * as THREE from 'three';

const VERTEX = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  attribute float aShape;
  attribute float aSpin;
  uniform float uPixelScale;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vShape;
  varying float vSpin;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vShape = aShape;
    vSpin = aSpin;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // Perspective size: worldSize * (viewportHeight / 2 tan(fov/2)) / distance.
    gl_PointSize = aSize * uPixelScale / max(-mv.z, 0.0001);
    gl_Position = projectionMatrix * mv;
  }
`;

/**
 * The twinkle itself, shared so that anything drawing a sprite draws the SAME star.
 *
 * Worth exporting rather than copying: a `THREE.PointsMaterial` with no texture draws a hard
 * square, and a single square among a field of twinkles is instantly the thing your eye goes to.
 */
export const TWINKLE_GLSL = /* glsl */ `
  float twinkleShape(vec2 uv, float spin, float shape) {
    vec2 d = uv - 0.5;

    // ---- soft round mote ----
    float r2 = dot(d, d) * 4.0;
    float roundish = max(1.0 - r2, 0.0);
    roundish *= roundish;

    // ---- four-point twinkle ----
    float c = cos(spin);
    float s = sin(spin);
    vec2 q = mat2(c, -s, s, c) * d;
    float ax = abs(q.x);
    float ay = abs(q.y);
    float spikeX = max(0.0, 1.0 - (ax * 11.0 + ay * 1.6));
    float spikeY = max(0.0, 1.0 - (ay * 11.0 + ax * 1.6));
    float core = max(0.0, 1.0 - length(d) * 3.4);
    float star = clamp(max(spikeX, spikeY) * 0.85 + core * core * 1.5, 0.0, 1.0);

    return mix(roundish, star, shape);
  }
`;

const FRAGMENT = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  varying float vShape;
  varying float vSpin;

  ${TWINKLE_GLSL}

  void main() {
    // Spun per particle so a field of them shimmers instead of all pointing the same way.
    float a = twinkleShape(gl_PointCoord, vSpin, vShape);
    if (a <= 0.002) discard;
    gl_FragColor = vec4(vColor * (0.6 + 0.9 * a), a * vAlpha);
  }
`;

export interface ParticleSpawn {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  colour: THREE.Color;
  /** World-space diameter at birth. */
  size: number;
  life: number;
  /** Fraction of velocity kept per second; 1 is frictionless. */
  drag?: number;
  /** World units per second squared, applied on Y. Negative falls. */
  gravity?: number;
  /** Size multiplier at death — above 1 the particle swells as it fades. */
  growth?: number;
  alpha?: number;
  /** 0 draws a soft round mote, 1 draws a four-point twinkle. Values between blend. */
  shape?: number;
  /** Starting rotation of the twinkle, radians. */
  spin?: number;
  /** Rotation speed, radians per second. */
  spinRate?: number;
}

export class ParticleField {
  readonly points: THREE.Points;
  private readonly capacity: number;
  private alive = 0;

  private readonly position: Float32Array;
  private readonly colour: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;

  private readonly velocity: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly drag: Float32Array;
  private readonly gravity: Float32Array;
  private readonly birthSize: Float32Array;
  private readonly growth: Float32Array;
  private readonly birthAlpha: Float32Array;
  private readonly shape: Float32Array;
  private readonly spin: Float32Array;
  private readonly spinRate: Float32Array;

  private readonly material: THREE.ShaderMaterial;

  constructor(capacity: number, blending: THREE.Blending = THREE.AdditiveBlending) {
    this.capacity = capacity;
    this.position = new Float32Array(capacity * 3);
    this.colour = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.velocity = new Float32Array(capacity * 3);
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.gravity = new Float32Array(capacity);
    this.birthSize = new Float32Array(capacity);
    this.growth = new Float32Array(capacity);
    this.birthAlpha = new Float32Array(capacity);
    this.shape = new Float32Array(capacity);
    this.spin = new Float32Array(capacity);
    this.spinRate = new Float32Array(capacity);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.position, 3));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colour, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    geometry.setAttribute('aShape', new THREE.BufferAttribute(this.shape, 1));
    geometry.setAttribute('aSpin', new THREE.BufferAttribute(this.spin, 1));
    geometry.setDrawRange(0, 0);
    // The pool's bounds change every frame and a Points bounding sphere is recomputed from the
    // whole buffer, so give it one big enough to never cull and skip the recompute entirely.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 40);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: { uPixelScale: { value: 600 } },
      transparent: true,
      blending,
      depthWrite: false,
      depthTest: true,
    });

    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
  }

  /**
   * Point size is in world units, so the shader needs the pixels-per-world-unit-at-one-metre
   * constant for the current camera and canvas. Without this the particles change apparent size
   * when the window resizes.
   */
  setViewport(pixelHeight: number, fovDegrees: number): void {
    this.material.uniforms.uPixelScale.value = pixelHeight / (2 * Math.tan(THREE.MathUtils.degToRad(fovDegrees) / 2));
  }

  get liveCount(): number { return this.alive; }

  spawn(p: ParticleSpawn): void {
    if (this.alive >= this.capacity) return;   // a full pool drops the newest, silently and cheaply
    const i = this.alive;
    this.alive += 1;
    this.position[i * 3] = p.position.x;
    this.position[i * 3 + 1] = p.position.y;
    this.position[i * 3 + 2] = p.position.z;
    this.velocity[i * 3] = p.velocity.x;
    this.velocity[i * 3 + 1] = p.velocity.y;
    this.velocity[i * 3 + 2] = p.velocity.z;
    this.colour[i * 3] = p.colour.r;
    this.colour[i * 3 + 1] = p.colour.g;
    this.colour[i * 3 + 2] = p.colour.b;
    this.birthSize[i] = p.size;
    this.size[i] = p.size;
    this.growth[i] = p.growth ?? 1;
    this.birthAlpha[i] = p.alpha ?? 1;
    this.alpha[i] = p.alpha ?? 1;
    this.age[i] = 0;
    this.life[i] = p.life;
    this.drag[i] = p.drag ?? 1;
    this.gravity[i] = p.gravity ?? 0;
    this.shape[i] = p.shape ?? 0;
    this.spin[i] = p.spin ?? Math.random() * Math.PI;
    this.spinRate[i] = p.spinRate ?? 0;
  }

  private swapToEnd(i: number): void {
    const last = this.alive - 1;
    if (i !== last) {
      for (let k = 0; k < 3; k += 1) {
        this.position[i * 3 + k] = this.position[last * 3 + k];
        this.velocity[i * 3 + k] = this.velocity[last * 3 + k];
        this.colour[i * 3 + k] = this.colour[last * 3 + k];
      }
      this.size[i] = this.size[last];
      this.alpha[i] = this.alpha[last];
      this.age[i] = this.age[last];
      this.life[i] = this.life[last];
      this.drag[i] = this.drag[last];
      this.gravity[i] = this.gravity[last];
      this.birthSize[i] = this.birthSize[last];
      this.growth[i] = this.growth[last];
      this.birthAlpha[i] = this.birthAlpha[last];
      this.shape[i] = this.shape[last];
      this.spin[i] = this.spin[last];
      this.spinRate[i] = this.spinRate[last];
    }
    this.alive -= 1;
  }

  update(dt: number): void {
    for (let i = 0; i < this.alive; ) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) { this.swapToEnd(i); continue; }

      const decay = this.drag[i] === 1 ? 1 : this.drag[i] ** dt;
      this.velocity[i * 3] *= decay;
      this.velocity[i * 3 + 1] = this.velocity[i * 3 + 1] * decay + this.gravity[i] * dt;
      this.velocity[i * 3 + 2] *= decay;

      this.position[i * 3] += this.velocity[i * 3] * dt;
      this.position[i * 3 + 1] += this.velocity[i * 3 + 1] * dt;
      this.position[i * 3 + 2] += this.velocity[i * 3 + 2] * dt;

      this.spin[i] += this.spinRate[i] * dt;

      const t = this.age[i] / this.life[i];
      this.size[i] = this.birthSize[i] * (1 + (this.growth[i] - 1) * t);
      // Fade in over the first tenth of life so a spawn does not pop, then out over the rest.
      this.alpha[i] = this.birthAlpha[i] * Math.min(1, t / 0.1) * (1 - t) * (1 - t);
      i += 1;
    }

    const geometry = this.points.geometry;
    geometry.setDrawRange(0, this.alive);
    if (this.alive > 0) {
      for (const name of ['position', 'aColor', 'aSize', 'aAlpha', 'aShape', 'aSpin']) {
        const attribute = geometry.getAttribute(name) as THREE.BufferAttribute;
        attribute.clearUpdateRanges();
        attribute.addUpdateRange(0, this.alive * attribute.itemSize);
        attribute.needsUpdate = true;
      }
    }
  }

  clear(): void { this.alive = 0; this.points.geometry.setDrawRange(0, 0); }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
