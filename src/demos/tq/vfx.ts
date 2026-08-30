import * as THREE from 'three';
import { SIGNATURE } from './characterPalette';

/**
 * Effects, written by hand.
 *
 * Said plainly, because the brief asked for it: img2threejs has NO particle subsystem. Nothing in
 * this file is generated, and no library provides it — every system below is `three` primitives,
 * `BufferGeometry` and GLSL written for this character. No dependency was added.
 *
 * Two rules hold throughout:
 *
 *   1. Every effect is anchored to a REAL socket on a REAL bone (see `sockets.ts`). Effects read a
 *      socket's world matrix each frame; not one of them carries a hand-typed stage coordinate.
 *   2. Every colour comes from `SIGNATURE`, which is the character's own measured palette. The
 *      crimson of a blade arc is the crimson measured off her lacquer, so the VFX reads as hers.
 *
 * Effects live in WORLD space rather than parented to the socket. That is deliberate: the figure
 * carries a 1.9 normalisation scale, and a child of a bone would inherit it and quietly scale every
 * particle. Reading the socket's world position each frame sidesteps that, and it is also what lets
 * embers and trails persist in the air after the hand that spawned them has moved on.
 */

/** Deterministic noise: the same run produces the same sparks, so a screenshot is reproducible. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}


/**
 * Keep an effect out of the model's part tree.
 *
 * The gallery builds its parts inspector and its explode layout by walking the model for named
 * meshes. An ember field or a trail ribbon is not a part of the character — listing it would claim
 * the reconstruction has pieces it does not, and the explode control would fling the effects across
 * the stage. `explodeWithParent` is the viewer's own flag for geometry that rides a shell rather
 * than standing alone, which is exactly what these are.
 */
function markAsEffect(object: THREE.Object3D): void {
  object.userData.explodeWithParent = true;
  object.traverse((child) => { child.userData.explodeWithParent = true; });
}

export interface Effect {
  object: THREE.Object3D;
  /** Advance by a frame delta. Returns false once the effect is finished and can be disposed. */
  update(dt: number, elapsed: number): boolean;
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// Ember field — rising sparks
// ---------------------------------------------------------------------------------------------

const EMBER_VERT = /* glsl */ `
  attribute float aBirth;
  attribute float aLife;
  attribute float aSize;
  attribute vec3 aVelocity;
  attribute float aSeed;
  uniform float uTime;
  uniform float uGravity;
  varying float vAge;
  varying float vSeed;

  void main() {
    float age = (uTime - aBirth) / aLife;
    vAge = age;
    vSeed = aSeed;
    // Ballistic drift with a little curl, so the sparks do not rise as a rigid column.
    vec3 drift = aVelocity * (uTime - aBirth);
    drift.y -= uGravity * pow(uTime - aBirth, 2.0);
    drift.x += sin((uTime - aBirth) * 3.1 + aSeed * 6.28) * 0.04;
    drift.z += cos((uTime - aBirth) * 2.7 + aSeed * 6.28) * 0.04;
    vec4 mv = modelViewMatrix * vec4(position + drift, 1.0);
    // Shrink as it burns out; the -mv.z term is standard size attenuation.
    gl_PointSize = aSize * (1.0 - age * 0.75) * (110.0 / max(0.001, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const EMBER_FRAG = /* glsl */ `
  uniform vec3 uHot;
  uniform vec3 uCool;
  varying float vAge;
  varying float vSeed;

  void main() {
    if (vAge < 0.0 || vAge > 1.0) discard;
    // Round sprite with a soft edge, built from the point coordinate — no texture needed.
    vec2 uv = gl_PointCoord * 2.0 - 1.0;
    float d = dot(uv, uv);
    if (d > 1.0) discard;
    float core = smoothstep(1.0, 0.0, d);
    // An ember cools as it rises: gold at birth, crimson as it dies.
    vec3 colour = mix(uHot, uCool, pow(vAge, 0.7));
    // Sparks overlap heavily under additive blending, so each one has to stay faint or the burst
    // fuses into a single bright mass — which is what the first render produced.
    float alpha = core * (1.0 - vAge) * 0.42 * (0.6 + 0.4 * sin(vSeed * 40.0 + vAge * 12.0));
    gl_FragColor = vec4(colour * (0.7 + core * 0.6), alpha);
  }
`;

export interface EmberOptions {
  count?: number;
  /** Metres per second, before the per-particle spread. */
  speed?: number;
  spread?: number;
  life?: number;
  size?: number;
  hot?: THREE.Color;
  cool?: THREE.Color;
  gravity?: number;
  /** Radius around the anchor that particles are born in. */
  radius?: number;
}

/**
 * A pool of embers that a socket can emit from continuously.
 *
 * The pool is fixed-size and recycled — a particle whose life has run out is re-seeded at the
 * anchor's CURRENT position. So one buffer, one draw call, and no allocation per spark.
 */
export class EmberField implements Effect {
  readonly object: THREE.Points;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly count: number;
  private readonly life: number;
  private readonly speed: number;
  private readonly spread: number;
  private readonly radius: number;
  private readonly random: () => number;
  private cursor = 0;
  private time = 0;
  /** Emission rate in particles per second; 0 pauses the field without destroying it. */
  rate: number;
  private carry = 0;
  private readonly anchor = new THREE.Vector3();

  constructor(options: EmberOptions & { rate?: number; seed?: number } = {}) {
    this.count = options.count ?? 220;
    this.life = options.life ?? 1.1;
    this.speed = options.speed ?? 0.9;
    this.spread = options.spread ?? 0.55;
    this.radius = options.radius ?? 0.06;
    this.rate = options.rate ?? 60;
    this.random = makeRandom(options.seed ?? 0x5eed);

    const position = new Float32Array(this.count * 3);
    const velocity = new Float32Array(this.count * 3);
    const birth = new Float32Array(this.count);
    const life = new Float32Array(this.count);
    const size = new Float32Array(this.count);
    const seed = new Float32Array(this.count);
    // Born already dead, so nothing is visible until the field actually emits.
    birth.fill(-1000);
    life.fill(this.life);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    this.geometry.setAttribute('aVelocity', new THREE.BufferAttribute(velocity, 3));
    this.geometry.setAttribute('aBirth', new THREE.BufferAttribute(birth, 1));
    this.geometry.setAttribute('aLife', new THREE.BufferAttribute(life, 1));
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    this.geometry.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    // The pool never leaves the anchor's neighbourhood by more than a couple of metres, and the
    // shader moves points the CPU never sees, so a generous manual bound beats a wrong computed one.
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 8);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uGravity: { value: options.gravity ?? 0.35 },
        uHot: { value: (options.hot ?? SIGNATURE.gold).clone() },
        uCool: { value: (options.cool ?? SIGNATURE.crimson).clone() },
      },
      vertexShader: EMBER_VERT,
      fragmentShader: EMBER_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.object = new THREE.Points(this.geometry, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 10;
    this.object.name = 'vfx:embers';
    markAsEffect(this.object);
  }

  /** Point the emitter at a socket's current world position. */
  setAnchor(worldPosition: THREE.Vector3): void {
    this.anchor.copy(worldPosition);
  }

  burst(n: number): void {
    for (let i = 0; i < n; i += 1) this.spawn();
  }

  private spawn(): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.count;

    const position = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const velocity = this.geometry.getAttribute('aVelocity') as THREE.BufferAttribute;
    const birth = this.geometry.getAttribute('aBirth') as THREE.BufferAttribute;
    const life = this.geometry.getAttribute('aLife') as THREE.BufferAttribute;
    const size = this.geometry.getAttribute('aSize') as THREE.BufferAttribute;
    const seed = this.geometry.getAttribute('aSeed') as THREE.BufferAttribute;

    // Born on a small sphere around the socket, not exactly at it, so the source is not a point.
    const theta = this.random() * Math.PI * 2;
    const phi = Math.acos(2 * this.random() - 1);
    const r = this.radius * Math.cbrt(this.random());
    position.setXYZ(
      i,
      this.anchor.x + r * Math.sin(phi) * Math.cos(theta),
      this.anchor.y + r * Math.cos(phi),
      this.anchor.z + r * Math.sin(phi) * Math.sin(theta),
    );
    velocity.setXYZ(
      i,
      (this.random() - 0.5) * this.spread,
      this.speed * (0.6 + this.random() * 0.8),
      (this.random() - 0.5) * this.spread,
    );
    birth.setX(i, this.time);
    life.setX(i, this.life * (0.7 + this.random() * 0.6));
    size.setX(i, 0.4 + this.random() * 1.0);
    seed.setX(i, this.random());

    position.needsUpdate = true;
    velocity.needsUpdate = true;
    birth.needsUpdate = true;
    life.needsUpdate = true;
    size.needsUpdate = true;
    seed.needsUpdate = true;
  }

  update(dt: number): boolean {
    this.time += dt;
    this.material.uniforms.uTime.value = this.time;
    if (this.rate > 0) {
      // Carry the fraction across frames so the rate does not depend on the frame length.
      this.carry += this.rate * dt;
      while (this.carry >= 1) {
        this.spawn();
        this.carry -= 1;
      }
    }
    return true; // a pooled field is persistent; the owner decides when it ends
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Trail ribbon — the arc a moving hand leaves behind
// ---------------------------------------------------------------------------------------------

const TRAIL_VERT = /* glsl */ `
  attribute float aAlong;
  attribute float aSide;
  varying float vAlong;
  varying float vSide;
  void main() {
    vAlong = aAlong;
    vSide = aSide;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const TRAIL_FRAG = /* glsl */ `
  uniform vec3 uInner;
  uniform vec3 uOuter;
  uniform float uOpacity;
  varying float vAlong;
  varying float vSide;
  void main() {
    // Hot core, cooler edge: across the ribbon's width, not along it.
    float edge = 1.0 - abs(vSide);
    vec3 colour = mix(uOuter, uInner, pow(edge, 1.6));
    // Fade toward the tail, and soften the outer edge so the ribbon has no hard border.
    float alpha = pow(vAlong, 1.4) * pow(edge, 0.7) * uOpacity;
    gl_FragColor = vec4(colour * (1.0 + edge * 1.8), alpha);
  }
`;

/**
 * A ribbon that follows a socket.
 *
 * Each frame the socket's world position is pushed onto a ring buffer, and the buffer is rebuilt
 * into a triangle strip two vertices wide. The ribbon's width direction is the cross product of the
 * direction of travel with the view direction, which is what keeps it facing the camera instead of
 * collapsing to a line when the swing comes at you.
 */
export class TrailRibbon implements Effect {
  readonly object: THREE.Mesh;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly samples: THREE.Vector3[] = [];
  private readonly maxSamples: number;
  private readonly width: number;
  private readonly position: Float32Array;
  private readonly along: Float32Array;
  private readonly side: Float32Array;
  /** 0 hides the ribbon; the swing ramps this up and down. */
  opacity = 0;

  constructor(options: { samples?: number; width?: number; inner?: THREE.Color; outer?: THREE.Color } = {}) {
    this.maxSamples = options.samples ?? 26;
    this.width = options.width ?? 0.075;

    this.position = new Float32Array(this.maxSamples * 2 * 3);
    this.along = new Float32Array(this.maxSamples * 2);
    this.side = new Float32Array(this.maxSamples * 2);

    const index: number[] = [];
    for (let i = 0; i < this.maxSamples - 1; i += 1) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.position, 3));
    this.geometry.setAttribute('aAlong', new THREE.BufferAttribute(this.along, 1));
    this.geometry.setAttribute('aSide', new THREE.BufferAttribute(this.side, 1));
    this.geometry.setIndex(index);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 8);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uInner: { value: (options.inner ?? SIGNATURE.gold).clone() },
        uOuter: { value: (options.outer ?? SIGNATURE.crimson).clone() },
        uOpacity: { value: 0 },
      },
      vertexShader: TRAIL_VERT,
      fragmentShader: TRAIL_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });

    this.object = new THREE.Mesh(this.geometry, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 11;
    this.object.name = 'vfx:trail';
    markAsEffect(this.object);
  }

  /** Push the socket's current world position onto the trail. */
  push(worldPosition: THREE.Vector3, cameraPosition: THREE.Vector3): void {
    this.samples.push(worldPosition.clone());
    while (this.samples.length > this.maxSamples) this.samples.shift();
    this.rebuild(cameraPosition);
  }

  private rebuild(cameraPosition: THREE.Vector3): void {
    const n = this.samples.length;
    const direction = new THREE.Vector3();
    const toCamera = new THREE.Vector3();
    const sideways = new THREE.Vector3();

    for (let i = 0; i < this.maxSamples; i += 1) {
      // Before the buffer has filled, pin the unused head to the oldest real sample so the ribbon
      // does not stretch back to the world origin.
      const clamped = Math.min(i, Math.max(0, n - 1));
      const point = this.samples[clamped] ?? new THREE.Vector3();
      const next = this.samples[Math.min(clamped + 1, n - 1)] ?? point;
      const previous = this.samples[Math.max(clamped - 1, 0)] ?? point;

      direction.subVectors(next, previous);
      if (direction.lengthSq() < 1e-12) direction.set(0, 1, 0);
      direction.normalize();
      toCamera.subVectors(cameraPosition, point).normalize();
      sideways.crossVectors(direction, toCamera);
      if (sideways.lengthSq() < 1e-12) sideways.set(1, 0, 0);
      sideways.normalize().multiplyScalar(this.width);

      // Taper: the tail is narrower than the head, which is what makes it read as a swing.
      const t = n <= 1 ? 0 : clamped / (n - 1);
      const taper = 0.25 + 0.75 * t;

      const a = i * 2;
      this.position[a * 3] = point.x - sideways.x * taper;
      this.position[a * 3 + 1] = point.y - sideways.y * taper;
      this.position[a * 3 + 2] = point.z - sideways.z * taper;
      this.position[(a + 1) * 3] = point.x + sideways.x * taper;
      this.position[(a + 1) * 3 + 1] = point.y + sideways.y * taper;
      this.position[(a + 1) * 3 + 2] = point.z + sideways.z * taper;
      this.along[a] = t;
      this.along[a + 1] = t;
      this.side[a] = -1;
      this.side[a + 1] = 1;
    }
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('aAlong') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('aSide') as THREE.BufferAttribute).needsUpdate = true;
  }

  clear(): void {
    this.samples.length = 0;
  }

  update(): boolean {
    this.material.uniforms.uOpacity.value = this.opacity;
    this.object.visible = this.opacity > 0.001;
    return true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Shock ring — the ground answering an impact
// ---------------------------------------------------------------------------------------------

const RING_FRAG = /* glsl */ `
  uniform vec3 uColour;
  uniform float uProgress;
  varying vec2 vUv;
  void main() {
    // Distance from the ring's centre line, in UV space.
    float r = length(vUv - 0.5) * 2.0;
    // A band that thins as it expands, like a real pressure wave losing energy.
    float band = smoothstep(0.55, 0.85, r) * (1.0 - smoothstep(0.9, 1.0, r));
    float fade = 1.0 - uProgress;
    gl_FragColor = vec4(uColour * (1.0 + band * 2.0), band * fade * fade);
  }
`;

/** An expanding ring on the ground plane. Lives for `duration` seconds, then reports it is done. */
export class ShockRing implements Effect {
  readonly object: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.PlaneGeometry;
  private age = 0;

  constructor(
    centre: THREE.Vector3,
    private readonly maxRadius: number,
    private readonly duration: number,
    colour: THREE.Color = SIGNATURE.gold,
  ) {
    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.material = new THREE.ShaderMaterial({
      uniforms: { uColour: { value: colour.clone() }, uProgress: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: RING_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.object = new THREE.Mesh(this.geometry, this.material);
    this.object.rotation.x = -Math.PI / 2;
    // A hair above the floor, or it z-fights with the shadow catcher.
    this.object.position.set(centre.x, centre.y + 0.012, centre.z);
    this.object.renderOrder = 9;
    this.object.name = 'vfx:shockring';
    markAsEffect(this.object);
  }

  update(dt: number): boolean {
    this.age += dt;
    const t = Math.min(1, this.age / this.duration);
    this.material.uniforms.uProgress.value = t;
    // Ease out: fast at the moment of impact, then settling.
    const radius = this.maxRadius * (1 - (1 - t) ** 3);
    this.object.scale.setScalar(Math.max(0.001, radius * 2));
    return t < 1;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Dragon sigil — the cast disc
// ---------------------------------------------------------------------------------------------

const SIGIL_FRAG = /* glsl */ `
  uniform vec3 uPrimary;
  uniform vec3 uSecondary;
  uniform float uTime;
  uniform float uProgress;
  varying vec2 vUv;

  // Cheap hash for the cloud band; no texture, no dependency.
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  void main() {
    vec2 p = vUv - 0.5;
    float r = length(p) * 2.0;
    float a = atan(p.y, p.x);

    if (r > 1.0) discard;

    // Two concentric rules, counter-rotating, as on the cuirass filigree.
    float ringOuter = smoothstep(0.02, 0.0, abs(r - 0.94));
    float ringInner = smoothstep(0.02, 0.0, abs(r - 0.62));

    // Radial spokes: 12, the count on the reference's skirt plates.
    float spokes = smoothstep(0.72, 1.0, abs(sin(a * 6.0 + uTime * 0.6))) * smoothstep(0.6, 0.63, r) * smoothstep(0.95, 0.9, r);

    // A cloud-scroll band between the rules, built from a rotating hash ridge.
    float band = smoothstep(0.62, 0.66, r) * smoothstep(0.94, 0.90, r);
    float scroll = hash(vec2(floor((a + uTime * 0.35) * 9.0), floor(r * 7.0)));
    float cloud = band * smoothstep(0.55, 0.95, scroll);

    // Glyph core: a slowly turning trefoil, standing in for the dragon roundel.
    float core = smoothstep(0.34, 0.0, r) * (0.6 + 0.4 * sin(a * 3.0 - uTime * 1.4));

    float mask = ringOuter + ringInner + spokes * 0.55 + cloud * 0.5 + core;
    // Sweep in from the rim, then hold, then fade with the caster's gesture.
    float sweep = smoothstep(uProgress - 0.25, uProgress, 1.0 - r);
    float alpha = clamp(mask, 0.0, 1.0) * sweep * (1.0 - smoothstep(0.75, 1.0, uProgress));

    vec3 colour = mix(uSecondary, uPrimary, clamp(ringOuter + ringInner + core, 0.0, 1.0));
    gl_FragColor = vec4(colour * 1.9, alpha);
  }
`;

/** The disc that blooms under a cast. Faces up by default; `orient` turns it to face the camera. */
export class DragonSigil implements Effect {
  readonly object: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.PlaneGeometry;
  private age = 0;

  constructor(
    private readonly duration: number,
    radius: number,
    primary: THREE.Color = SIGNATURE.gold,
    secondary: THREE.Color = SIGNATURE.crimson,
  ) {
    this.geometry = new THREE.PlaneGeometry(radius * 2, radius * 2);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uPrimary: { value: primary.clone() },
        uSecondary: { value: secondary.clone() },
        uTime: { value: 0 },
        uProgress: { value: 0 },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: SIGIL_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.object = new THREE.Mesh(this.geometry, this.material);
    this.object.renderOrder = 12;
    this.object.name = 'vfx:sigil';
    markAsEffect(this.object);
  }

  update(dt: number): boolean {
    this.age += dt;
    const t = Math.min(1, this.age / this.duration);
    this.material.uniforms.uTime.value = this.age;
    this.material.uniforms.uProgress.value = t;
    return t < 1;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Aura shell — a fresnel skin around the figure
// ---------------------------------------------------------------------------------------------

/**
 * The aura's vertex stage has to do its own skinning.
 *
 * `three` injects skinning into its OWN materials, but a `ShaderMaterial` gets only what its source
 * asks for. Without these chunks the shell drew the geometry in its BIND pose while the character
 * animated beside it — on screen that was a second, motionless figure standing behind the real one,
 * which is exactly what the first renders showed. `USE_SKINNING` is defined by the renderer because
 * the object is a `SkinnedMesh`, so the guarded branch is the one that compiles here.
 */
const AURA_VERT = /* glsl */ `
  #include <common>
  #include <skinning_pars_vertex>
  varying vec3 vNormalView;
  varying vec3 vViewDir;
  uniform float uInflate;

  void main() {
    vec3 objectNormal = vec3(normal);
    vec3 transformed = vec3(position);

    #include <skinbase_vertex>

    #ifdef USE_SKINNING
      mat4 skinMatrix = mat4(0.0);
      skinMatrix += skinWeight.x * boneMatX;
      skinMatrix += skinWeight.y * boneMatY;
      skinMatrix += skinWeight.z * boneMatZ;
      skinMatrix += skinWeight.w * boneMatW;
      skinMatrix = bindMatrixInverse * skinMatrix * bindMatrix;
      objectNormal = (skinMatrix * vec4(objectNormal, 0.0)).xyz;
      transformed = (skinMatrix * vec4(transformed, 1.0)).xyz;
    #endif

    // Push along the SKINNED normal, so the rim hugs the posed silhouette rather than the bind one.
    vec3 inflated = transformed + normalize(objectNormal) * uInflate;
    vec4 mv = modelViewMatrix * vec4(inflated, 1.0);
    vNormalView = normalize(normalMatrix * objectNormal);
    vViewDir = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const AURA_FRAG = /* glsl */ `
  uniform vec3 uColour;
  uniform float uStrength;
  uniform float uTime;
  varying vec3 vNormalView;
  varying vec3 vViewDir;
  void main() {
    // The shell is drawn BackSide, so the interpolated normal points away from the eye and the
    // dot product is negative across the whole surface. Clamping that to zero made fresnel evaluate
    // to 1.0 everywhere and painted a solid silhouette over the character instead of a rim — which
    // is exactly what the first render showed. Negating puts the normal back in the eye's frame.
    vec3 n = -normalize(vNormalView);
    float facing = clamp(dot(n, normalize(vViewDir)), 0.0, 1.0);
    // A tight exponent keeps the glow on the silhouette rather than washing over the armour.
    float fresnel = pow(1.0 - facing, 4.0);
    float pulse = 0.85 + 0.15 * sin(uTime * 3.4);
    gl_FragColor = vec4(uColour * fresnel * 1.9 * pulse, fresnel * uStrength);
  }
`;

/**
 * A rim glow that hugs the figure.
 *
 * It borrows the character's OWN geometry — the costume meshes, inflated along their normals — so
 * the rim traces the real silhouette of the armour rather than a capsule standing in for it. It is
 * skinned from the same skeleton, so it tracks every pose for free.
 */
export class AuraShell implements Effect {
  readonly object: THREE.Group;
  private readonly materials: THREE.ShaderMaterial[] = [];
  /** Each rim shell beside the mesh it traces, so it can follow that mesh being hidden. */
  private readonly pairs: { shell: THREE.SkinnedMesh; source: THREE.SkinnedMesh }[] = [];
  private time = 0;
  /** 0..1; the skills drive this. */
  strength = 0;

  constructor(source: THREE.SkinnedMesh[], colour: THREE.Color = SIGNATURE.crimson, inflate = 0.012) {
    this.object = new THREE.Group();
    this.object.name = 'vfx:aura';
    for (const mesh of source) {
      const material = new THREE.ShaderMaterial({
        uniforms: {
          uColour: { value: colour.clone() },
          uStrength: { value: 0 },
          uTime: { value: 0 },
          uInflate: { value: inflate },
        },
        vertexShader: AURA_VERT,
        fragmentShader: AURA_FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
      });
      // A second skinned mesh over the same geometry and the SAME skeleton: no extra skinning cost
      // beyond the draw, and it can never fall out of step with the body.
      const shell = new THREE.SkinnedMesh(mesh.geometry, material);
      shell.bind(mesh.skeleton, mesh.bindMatrix);
      // Match the source's bind mode, or the rim would be skinned in a different space from the
      // surface it traces and would sit somewhere else entirely.
      shell.bindMode = mesh.bindMode;
      shell.bindMatrixInverse.copy(mesh.bindMatrixInverse);
      shell.scale.copy(mesh.scale);
      shell.frustumCulled = false;
      shell.renderOrder = 8;
      this.materials.push(material);
      this.pairs.push({ shell, source: mesh });
      this.object.add(shell);
    }
    markAsEffect(this.object);
  }

  update(dt: number): boolean {
    this.time += dt;
    for (const material of this.materials) {
      material.uniforms.uTime.value = this.time;
      material.uniforms.uStrength.value = this.strength;
    }
    // A rim traces a surface, so it follows that surface: hidden when it is hidden, and moved when
    // an explode moves it. Without the position copy the rim stays behind while the piece flies out.
    for (const { shell, source } of this.pairs) {
      shell.visible = source.visible;
      shell.position.copy(source.position);
    }
    this.object.visible = this.strength > 0.001;
    return true;
  }

  dispose(): void {
    for (const material of this.materials) material.dispose();
  }
}
