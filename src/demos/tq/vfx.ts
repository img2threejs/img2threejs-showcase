import * as THREE from 'three';
import { SIGNATURE } from './characterPalette';

/**
 * Effects, written by hand, in the visual language of Chinese animated features.
 *
 * Said plainly, because it matters: img2threejs has NO particle subsystem. Nothing in this file is
 * generated and no library provides it — every system below is `three` primitives, `BufferGeometry`
 * and GLSL written for this character. No dependency was added, and no texture is loaded: the seal
 * script, the trigrams, the scales, the paper and the ink are all drawn procedurally in the shader.
 *
 * The vocabulary is borrowed from the genre rather than from a generic engine sparkle kit:
 *
 *   法陣  FormationArray  the ground array — counter-rotating rules, the eight trigrams, seal blocks
 *   神龍  SpiritDragon    a dragon of light that coils around the caster and draws itself as it goes
 *   綢帶  SilkRibbon      flying-apsara ribbons that lag and undulate like cloth, not like a trail
 *   水墨  InkBurst        ink-wash bloom and gold sparks out of one pooled system
 *   符籙  TalismanSwarm   paper talismans, spinning outward and burning off at the edge
 *   蓮華  LotusBloom      petals opening under the feet on a landing
 *   筆鋒  BrushSlash      a calligraphic stroke with a real brush profile — heavy belly, dry tail
 *
 * Two rules hold throughout. Every effect is anchored to a REAL socket on a REAL bone (see
 * `sockets.ts`) — none carries a hand-typed stage coordinate. And every colour comes from
 * `SIGNATURE`, the character's own measured palette, so the work reads as hers rather than as
 * stock magic.
 *
 * Effects live in WORLD space and read socket world matrices each frame rather than being parented
 * to bones: a child of a bone inherits the figure's 1.9 normalisation and would quietly scale every
 * particle, and world space is also what lets ink and ribbons hang in the air after the hand that
 * threw them has moved on.
 */

/** Deterministic noise: the same run produces the same sparks, so a screenshot is reproducible. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function smootherstep(x: number, edge0: number, edge1: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Keep an effect out of the model's part tree.
 *
 * The gallery builds its parts inspector and its explode layout by walking the model for named
 * meshes. A ribbon is not a part of the character — listing it would claim the reconstruction has
 * pieces it does not, and the explode control would fling the effects across the stage.
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

/** Shared GLSL: a cheap hash, and the ru-yi cloud scroll the array is partly drawn from. */
const GLSL_COMMON = /* glsl */ `
  float hash11(float p) { return fract(sin(p * 127.1) * 43758.5453); }
  float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  // A ru-yi cloud scroll: a spiral that thickens toward its eye, which is the shape the whole
  // "auspicious cloud" motif is built from.
  float cloudScroll(vec2 p, float turns) {
    float r = length(p);
    float a = atan(p.y, p.x);
    float arm = fract((a / 6.28318) * turns - r * 2.4);
    float thickness = mix(0.34, 0.06, clamp(r * 1.6, 0.0, 1.0));
    float band = smoothstep(thickness, 0.0, abs(arm - 0.5) - 0.18);
    return band * smoothstep(1.0, 0.25, r);
  }
`;

// ---------------------------------------------------------------------------------------------
// 法陣 — the formation array
// ---------------------------------------------------------------------------------------------

const ARRAY_FRAG = /* glsl */ `
  uniform vec3 uPrimary;
  uniform vec3 uSecondary;
  uniform float uTime;
  uniform float uProgress;
  uniform float uSpin;
  varying vec2 vUv;

  ${GLSL_COMMON}

  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float r = length(p);
    if (r > 1.0) discard;
    float a = atan(p.y, p.x);

    float ink = 0.0;

    // --- two pairs of rules, the way a cast circle is always ruled first ------------------------
    float outer = smoothstep(0.012, 0.0, abs(r - 0.97));
    float outerIn = smoothstep(0.008, 0.0, abs(r - 0.92));
    float mid = smoothstep(0.010, 0.0, abs(r - 0.60));
    float inner = smoothstep(0.008, 0.0, abs(r - 0.30));
    ink += outer + outerIn + mid + inner;

    // --- 八卦: the eight trigrams ---------------------------------------------------------------
    //
    // The trigrams ARE the eight three-bit numbers, so the sector index doubles as the pattern:
    // bit set means a solid line, bit clear means a broken one. Nothing is looked up.
    float sectorF = floor((a + 3.14159) / 6.28318 * 8.0);
    float sectorMid = (sectorF + 0.5) / 8.0 * 6.28318 - 3.14159;
    float da = a - sectorMid;
    float band = smoothstep(0.62, 0.64, r) * smoothstep(0.92, 0.90, r);
    if (band > 0.0) {
      float across = da * r * 5.4;
      float along = (r - 0.66) / 0.22;
      float barIndex = floor(along * 3.0);
      float inBar = smoothstep(0.16, 0.10, abs(fract(along * 3.0) - 0.5));
      float solid = mod(floor(sectorF / pow(2.0, barIndex)), 2.0);
      // A broken line is the same bar with its middle removed.
      float gap = solid > 0.5 ? 1.0 : smoothstep(0.12, 0.17, abs(across));
      ink += step(abs(across), 0.42) * inBar * gap * band * 1.2;
    }

    // --- seal-script blocks around the outer rule ------------------------------------------------
    float ringBand = smoothstep(0.925, 0.935, r) * smoothstep(0.97, 0.96, r);
    float cell = floor((a + uTime * 0.18) / 6.28318 * 48.0);
    float glyph = step(0.45, hash11(cell)) * step(0.35, hash11(cell * 3.7 + floor(r * 60.0)));
    ink += ringBand * glyph * 0.9;

    // --- cloud scroll between the middle rules ---------------------------------------------------
    float cloudBand = smoothstep(0.31, 0.35, r) * smoothstep(0.60, 0.56, r);
    vec2 cp = vec2(cos(a - uTime * 0.3), sin(a - uTime * 0.3)) * (r - 0.3) / 0.3;
    ink += cloudBand * cloudScroll(cp * 1.8, 3.0) * 0.8;

    // --- radiating shafts -------------------------------------------------------------------------
    float shaft = pow(max(0.0, sin(a * 12.0 + uSpin)), 24.0) * smoothstep(0.30, 1.0, r);
    ink += shaft * 0.5;

    vec3 colour = mix(uSecondary, uPrimary, clamp(outer + mid + inner + shaft, 0.0, 1.0));

    // --- the array is INSCRIBED, not switched on ---------------------------------------------------
    // The sweep runs OUTWARD from the centre: everything inside it is inked, the leading edge is
    // the wet nib catching light, and nothing beyond it exists yet. Comparing against (1.0 - r)
    // instead of the radius ran this backwards - it drew the whole disc at once and then erased it
    // from the rim inward, which is why raising the rate made the array vanish rather than finish.
    float sweep = uProgress * 3.2;                 // finishes at ~31% of the life, then holds
    float draw = 1.0 - smoothstep(sweep - 0.28, sweep, r);
    float nib = smoothstep(0.10, 0.0, abs(r - sweep)) * 1.6;
    float fade = 1.0 - smoothstep(0.72, 1.0, uProgress);

    float alpha = clamp(ink, 0.0, 1.0) * draw * fade;
    gl_FragColor = vec4((colour + nib * uPrimary) * (1.3 + nib), alpha + nib * draw * fade * 0.35);
  }
`;

/** The ground array. Lies flat by default; stand it up with `object.rotation` for a cast seal. */
export class FormationArray implements Effect {
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
        uSpin: { value: 0 },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: ARRAY_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.object = new THREE.Mesh(this.geometry, this.material);
    this.object.rotation.x = -Math.PI / 2;
    this.object.renderOrder = 12;
    this.object.name = 'vfx:formation';
    markAsEffect(this.object);
  }

  update(dt: number): boolean {
    this.age += dt;
    const t = Math.min(1, this.age / this.duration);
    this.material.uniforms.uTime.value = this.age;
    this.material.uniforms.uProgress.value = t;
    // It keeps turning after it is drawn, slowing as it fades.
    this.material.uniforms.uSpin.value += dt * (1.4 - t);
    return t < 1;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// 神龍 — the spirit dragon
// ---------------------------------------------------------------------------------------------

const DRAGON_VERT = /* glsl */ `
  attribute float aAlong;
  attribute float aAngle;
  uniform float uTime;
  uniform float uReveal;
  uniform float uRadius;
  varying float vAlong;
  varying float vAngle;
  varying float vRidge;

  void main() {
    vAlong = aAlong;
    vAngle = aAngle;

    // The ring around the body is inflated here rather than baked, so the dragon can breathe and
    // taper without rebuilding geometry every frame.
    float head = uReveal;
    float behind = clamp((head - aAlong) * 6.0, 0.0, 1.0);
    // Thick just behind the head, tapering to nothing at the tail: a serpent, not a hose.
    float taper = smoothstep(0.0, 0.12, head - aAlong) * (1.0 - smoothstep(0.35, 1.0, head - aAlong));
    float breathe = 1.0 + 0.10 * sin(aAlong * 26.0 - uTime * 7.0);
    float ridge = pow(max(0.0, cos(aAngle)), 3.0);   // a dorsal ridge along the back
    vRidge = ridge;

    // The tail has to close to a point at exactly the age the fragment stage stops drawing it,
    // otherwise the body ends in an open tube and the flat cap is visible from the side.
    float tail = 1.0 - smoothstep(0.40, 0.62, head - aAlong);
    float radius = uRadius * (0.35 + taper) * breathe * (1.0 + ridge * 0.45) * behind * tail;
    vec3 offset = normal * radius;
    vec3 swim = vec3(0.0, sin(aAlong * 12.0 - uTime * 5.0) * 0.06, 0.0);

    gl_Position = projectionMatrix * modelViewMatrix * vec4(position + offset + swim, 1.0);
  }
`;

const DRAGON_FRAG = /* glsl */ `
  uniform vec3 uBody;
  uniform vec3 uGlow;
  uniform float uOpacity;
  uniform float uReveal;
  varying float vAlong;
  varying float vAngle;
  varying float vRidge;

  ${GLSL_COMMON}

  void main() {
    // Nothing ahead of the head exists yet — this is what makes the dragon draw itself.
    if (vAlong > uReveal) discard;
    float age = uReveal - vAlong;
    if (age > 0.62) discard;                       // and the tail dissolves behind it

    // Scales: a staggered lattice running along and around the body.
    vec2 scaleUv = vec2(vAlong * 240.0, vAngle / 6.28318 * 9.0);
    vec2 stagger = vec2(0.0, floor(scaleUv.x) * 0.5);
    float scale = smoothstep(0.42, 0.30, length(fract(scaleUv + stagger) - 0.5));
    float tint = 0.75 + 0.25 * hash21(floor(scaleUv + stagger));

    float heat = smoothstep(0.16, 0.0, age);       // molten at the head, cooling toward the tail
    // The whole forward third keeps some gold in it, so the dragon reads as lit from the head
    // rather than as a uniformly red tube.
    float warm = smoothstep(0.45, 0.02, age) * 0.45 + heat * 0.85;
    vec3 colour = mix(uBody * tint, uGlow, clamp(warm + vRidge * 0.25, 0.0, 1.0));
    float body = smoothstep(0.62, 0.36, age);
    float alpha = (0.35 + scale * 0.65) * body * uOpacity;
    gl_FragColor = vec4(colour * (1.1 + heat * 2.2 + vRidge * 0.6), alpha);
  }
`;

/**
 * A dragon of light that coils around the caster.
 *
 * The body is a helix built once as a tube of rings; the shader then decides how much of it exists,
 * so the dragon swims into being head-first and dissolves behind itself. `three` has no tube
 * primitive that carries "how far along am I", so the rings are generated here with an explicit
 * frame taken from the analytic tangent of the helix.
 */
export interface SpiritDragonOptions {
  /** How far it travels along its own axis. This is the reach of the attack. */
  length?: number;
  /** Radius of the corkscrew it flies in. */
  coil?: number;
  /** Radius of the body itself, in world units — not derived from the coil. */
  thickness?: number;
  body?: THREE.Color;
  glow?: THREE.Color;
}

/**
 * A dragon of light, thrown along an axis.
 *
 * The body is a helix built once as a tube of rings; the shader decides how much of it exists, so
 * the form swims into being head-first and dissolves behind itself. `three` has no tube primitive
 * carrying "how far along am I", so the rings are generated here with a frame taken from the
 * analytic tangent of the helix.
 *
 * There is no modelled head. One was built — snout, brow, horns, eyes, trailing whiskers — and it
 * did not read as a dragon at any size; it read as a cluster of gold solids stuck to the front of a
 * tube. The body already closes to a point at its leading edge because `behind` drives the ring
 * radius to zero there, and a tapered serpent of light is a better thing than a bad head on a good
 * body. Modelling a convincing dragon head procedurally is beyond what this file can do well, and
 * pretending otherwise made the effect worse rather than better.
 */
export class SpiritDragon implements Effect {
  readonly object: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.BufferGeometry;
  private readonly length: number;
  private readonly coil: number;
  private age = 0;

  private static readonly SEGMENTS = 260;
  private static readonly RING = 10;
  private static readonly TURNS = 3.4;

  /** Point and tangent on the helix at parameter `u`, in the dragon's own space. */
  private curveAt(u: number, point: THREE.Vector3, tangent: THREE.Vector3): void {
    const theta = u * Math.PI * 2 * SpiritDragon.TURNS;
    // The corkscrew opens slightly as it flies, so the far end reads as travelling rather than
    // converging to a point.
    const coil = this.coil * (0.75 + 0.45 * u);
    point.set(Math.cos(theta) * coil, u * this.length, Math.sin(theta) * coil);
    tangent.set(
      -Math.sin(theta) * coil * Math.PI * 2 * SpiritDragon.TURNS,
      this.length,
      Math.cos(theta) * coil * Math.PI * 2 * SpiritDragon.TURNS,
    ).normalize();
  }

  constructor(private readonly duration: number, options: SpiritDragonOptions = {}) {
    this.length = options.length ?? 7;
    this.coil = options.coil ?? 0.42;
    const thickness = options.thickness ?? 0.075;
    const body = options.body ?? SIGNATURE.crimson;
    const glow = options.glow ?? SIGNATURE.gold;

    const position: number[] = [];
    const normal: number[] = [];
    const along: number[] = [];
    const angle: number[] = [];
    const index: number[] = [];

    const centre = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const side = new THREE.Vector3();
    const nrm = new THREE.Vector3();
    const dir = new THREE.Vector3();

    for (let s = 0; s <= SpiritDragon.SEGMENTS; s += 1) {
      const u = s / SpiritDragon.SEGMENTS;
      this.curveAt(u, centre, tangent);
      side.crossVectors(tangent, up).normalize();
      nrm.crossVectors(side, tangent).normalize();
      for (let r = 0; r < SpiritDragon.RING; r += 1) {
        const a = (r / SpiritDragon.RING) * Math.PI * 2;
        dir.copy(side).multiplyScalar(Math.cos(a)).addScaledVector(nrm, Math.sin(a));
        position.push(centre.x, centre.y, centre.z);
        normal.push(dir.x, dir.y, dir.z);
        along.push(u);
        angle.push(a);
      }
    }
    for (let s = 0; s < SpiritDragon.SEGMENTS; s += 1) {
      for (let r = 0; r < SpiritDragon.RING; r += 1) {
        const a = s * SpiritDragon.RING + r;
        const b = s * SpiritDragon.RING + ((r + 1) % SpiritDragon.RING);
        const c = (s + 1) * SpiritDragon.RING + r;
        const d = (s + 1) * SpiritDragon.RING + ((r + 1) % SpiritDragon.RING);
        index.push(a, c, b, b, c, d);
      }
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
    this.geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
    this.geometry.setAttribute('aAlong', new THREE.Float32BufferAttribute(along, 1));
    this.geometry.setAttribute('aAngle', new THREE.Float32BufferAttribute(angle, 1));
    this.geometry.setIndex(index);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, this.length / 2, 0), this.length);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uReveal: { value: 0 },
        uRadius: { value: thickness },
        uOpacity: { value: 1 },
        uBody: { value: body.clone() },
        uGlow: { value: glow.clone() },
      },
      vertexShader: DRAGON_VERT,
      fragmentShader: DRAGON_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });

    this.object = new THREE.Mesh(this.geometry, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 13;
    this.object.name = 'vfx:dragon';
    markAsEffect(this.object);
  }

  update(dt: number): boolean {
    this.age += dt;
    const t = Math.min(1, this.age / this.duration);
    this.material.uniforms.uTime.value = this.age;
    // The leading edge runs past 1 so the tail has somewhere to finish dissolving into.
    this.material.uniforms.uReveal.value = t * 1.62;
    this.material.uniforms.uOpacity.value = 1 - smootherstep(t, 0.78, 1);
    // Roll about its OWN axis: `rotation.y +=` would rewrite the quaternion from Euler angles and
    // throw away an aim set with `setFromUnitVectors`.
    this.object.rotateY(dt * 0.5);
    return t < 1;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// 綢帶 — flying-apsara silk ribbons
// ---------------------------------------------------------------------------------------------

const SILK_FRAG = /* glsl */ `
  uniform vec3 uInner;
  uniform vec3 uOuter;
  uniform float uOpacity;
  uniform float uTime;
  varying float vAlong;
  varying float vSide;

  void main() {
    float edge = 1.0 - abs(vSide);
    // Silk catches light in bands that travel along it as it twists.
    float sheen = 0.55 + 0.45 * sin(vAlong * 22.0 - uTime * 6.0);
    vec3 colour = mix(uOuter, uInner, pow(edge, 1.5) * sheen);
    float alpha = pow(vAlong, 1.25) * pow(edge, 0.55) * uOpacity;
    gl_FragColor = vec4(colour * (0.9 + edge * 1.6 * sheen), alpha);
  }
`;

/**
 * A silk ribbon that follows a socket the way cloth follows a wrist — late, and with its own
 * momentum.
 *
 * A plain trail samples the socket every frame and draws that path exactly, which reads as a smear.
 * This one runs a little chain of springs: each node chases the one ahead of it, so the ribbon
 * arrives after the hand, overshoots the corners and settles. It is also twisted along its length,
 * so the light band travels — which is what makes flying-apsara ribbons read as cloth.
 */
export class SilkRibbon implements Effect {
  readonly object: THREE.Mesh;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly nodes: THREE.Vector3[] = [];
  private readonly velocity: THREE.Vector3[] = [];
  private readonly count: number;
  private readonly width: number;
  /** Fixed separation between links — the ribbon's length divided across its nodes. */
  private readonly restLength: number;
  private readonly position: Float32Array;
  private readonly along: Float32Array;
  private readonly side: Float32Array;
  private time = 0;
  private seeded = false;
  /** 0 hides the ribbon; a swing ramps this up and down. */
  opacity = 0;

  constructor(options: {
    nodes?: number;
    width?: number;
    /** Total length of the ribbon in world units. */
    length?: number;
    inner?: THREE.Color;
    outer?: THREE.Color;
  } = {}) {
    this.count = options.nodes ?? 34;
    this.width = options.width ?? 0.075;
    this.restLength = (options.length ?? 1.5) / Math.max(1, this.count - 1);

    for (let i = 0; i < this.count; i += 1) {
      this.nodes.push(new THREE.Vector3());
      this.velocity.push(new THREE.Vector3());
    }

    this.position = new Float32Array(this.count * 2 * 3);
    this.along = new Float32Array(this.count * 2);
    this.side = new Float32Array(this.count * 2);
    const index: number[] = [];
    for (let i = 0; i < this.count - 1; i += 1) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.position, 3));
    this.geometry.setAttribute('aAlong', new THREE.BufferAttribute(this.along, 1));
    this.geometry.setAttribute('aSide', new THREE.BufferAttribute(this.side, 1));
    this.geometry.setIndex(index);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 12);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uInner: { value: (options.inner ?? SIGNATURE.gold).clone() },
        uOuter: { value: (options.outer ?? SIGNATURE.crimson).clone() },
        uOpacity: { value: 0 },
        uTime: { value: 0 },
      },
      vertexShader: `
        attribute float aAlong;
        attribute float aSide;
        varying float vAlong;
        varying float vSide;
        void main() {
          vAlong = aAlong;
          vSide = aSide;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: SILK_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });

    this.object = new THREE.Mesh(this.geometry, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 11;
    this.object.name = 'vfx:silk';
    markAsEffect(this.object);
  }

  /** Drop the whole ribbon onto a point, so a new swing does not stream in from the last one. */
  reset(at: THREE.Vector3): void {
    for (let i = 0; i < this.count; i += 1) {
      // Laid out along its own length from the start; seeding every node at one point leaves the
      // first relaxation pass with no direction to work from.
      this.nodes[i].set(at.x, at.y - this.restLength * i, at.z);
      this.velocity[i].set(0, 0, 0);
    }
    this.seeded = true;
  }

  clear(): void {
    this.seeded = false;
  }

  /**
   * Advance the rope toward the socket, then rebuild the strip facing the camera.
   *
   * The nodes are integrated as damped springs and then pulled onto a fixed SEPARATION. That second
   * pass is what makes this a ribbon rather than a smear: springs alone have no rest length, so the
   * moment the hand slowed the whole chain collapsed onto it and the strip folded into a zigzag.
   * Constraining each link to a fixed length keeps the ribbon extended and trailing even at rest,
   * which is how cloth behaves.
   */
  follow(at: THREE.Vector3, cameraPosition: THREE.Vector3, dt: number): void {
    if (!this.seeded) this.reset(at);
    const step = Math.min(dt, 1 / 60);
    this.nodes[0].copy(at);

    for (let i = 1; i < this.count; i += 1) {
      const node = this.nodes[i];
      const v = this.velocity[i];
      // Gravity plus a light drag; the link constraint below supplies the tension.
      v.y -= 2.6 * step;
      v.multiplyScalar(Math.exp(-2.2 * step));
      node.addScaledVector(v, step);
    }

    // Two relaxation passes: enough to look taut without the cost of a full solver.
    const link = new THREE.Vector3();
    for (let pass = 0; pass < 2; pass += 1) {
      for (let i = 1; i < this.count; i += 1) {
        const previous = this.nodes[i - 1];
        const node = this.nodes[i];
        link.subVectors(node, previous);
        const length = link.length();
        if (length < 1e-6) {
          // Degenerate: nudge it off the anchor so the direction is defined next pass.
          node.set(previous.x, previous.y - this.restLength, previous.z);
          continue;
        }
        link.multiplyScalar(this.restLength / length);
        const corrected = previous.clone().add(link);
        // Fold the correction back into velocity so the ribbon keeps its swing.
        this.velocity[i].addScaledVector(corrected.sub(node), 1 / Math.max(step, 1e-4) * 0.12);
        node.copy(previous).add(link);
      }
    }
    this.rebuild(cameraPosition);
  }

  private rebuild(cameraPosition: THREE.Vector3): void {
    const direction = new THREE.Vector3();
    const toCamera = new THREE.Vector3();
    const sideways = new THREE.Vector3();

    for (let i = 0; i < this.count; i += 1) {
      const point = this.nodes[i];
      const next = this.nodes[Math.min(i + 1, this.count - 1)];
      const previous = this.nodes[Math.max(i - 1, 0)];

      direction.subVectors(next, previous);
      if (direction.lengthSq() < 1e-12) direction.set(0, 1, 0);
      direction.normalize();
      toCamera.subVectors(cameraPosition, point).normalize();
      sideways.crossVectors(direction, toCamera);
      if (sideways.lengthSq() < 1e-12) sideways.set(1, 0, 0);
      sideways.normalize();

      const t = i / (this.count - 1);
      // Widest a third of the way down, tapering to a point: that asymmetry is what separates
      // cloth from a tube.
      const profile = Math.sin(Math.pow(1 - t, 0.7) * Math.PI * 0.92);
      // Twist, so the sheen band travels along the ribbon as it flies.
      // Kept strictly positive: allowed through zero the two edges swap and the ribbon pinches
      // into a hard zigzag instead of turning edge-on.
      const twist = 0.18 + 0.82 * (0.5 + 0.5 * Math.cos(t * 5.2 + this.time * 3.0));
      const half = this.width * profile * twist;

      const a = i * 2;
      this.position[a * 3] = point.x - sideways.x * half;
      this.position[a * 3 + 1] = point.y - sideways.y * half;
      this.position[a * 3 + 2] = point.z - sideways.z * half;
      this.position[(a + 1) * 3] = point.x + sideways.x * half;
      this.position[(a + 1) * 3 + 1] = point.y + sideways.y * half;
      this.position[(a + 1) * 3 + 2] = point.z + sideways.z * half;
      this.along[a] = 1 - t;
      this.along[a + 1] = 1 - t;
      this.side[a] = -1;
      this.side[a + 1] = 1;
    }
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('aAlong') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('aSide') as THREE.BufferAttribute).needsUpdate = true;
  }

  update(dt: number): boolean {
    this.time += dt;
    this.material.uniforms.uTime.value = this.time;
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
// 水墨 — ink bloom and sparks
// ---------------------------------------------------------------------------------------------

const INK_VERT = /* glsl */ `
  attribute float aBirth;
  attribute float aLife;
  attribute float aSize;
  attribute float aKind;      // 0 = ink, 1 = spark
  attribute vec3 aVelocity;
  attribute float aSeed;
  uniform float uTime;
  uniform float uGravity;
  varying float vAge;
  varying float vSeed;
  varying float vKind;

  void main() {
    float age = (uTime - aBirth) / aLife;
    vAge = age;
    vSeed = aSeed;
    vKind = aKind;

    float t = uTime - aBirth;
    vec3 drift = aVelocity * t;
    drift.y -= uGravity * t * t;
    // Ink opens and stalls, like a drop spreading in water; a spark keeps its momentum.
    float spread = 1.0 - exp(-t * 2.2);
    drift *= mix(spread * 1.7, 1.0, aKind);
    drift.x += sin(t * 2.6 + aSeed * 6.28) * 0.05 * (1.0 - aKind);
    drift.z += cos(t * 2.2 + aSeed * 6.28) * 0.05 * (1.0 - aKind);

    vec4 mv = modelViewMatrix * vec4(position + drift, 1.0);
    // Ink blooms outward as it ages; a spark shrinks as it burns down.
    float grow = mix(0.5 + age * 2.4, 1.0 - age * 0.7, aKind);
    gl_PointSize = aSize * grow * (150.0 / max(0.001, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const INK_FRAG = /* glsl */ `
  uniform vec3 uInk;
  uniform vec3 uSpark;
  varying float vAge;
  varying float vSeed;
  varying float vKind;

  ${GLSL_COMMON}

  void main() {
    if (vAge < 0.0 || vAge > 1.0) discard;
    vec2 uv = gl_PointCoord * 2.0 - 1.0;
    float d = length(uv);
    if (d > 1.0) discard;

    if (vKind < 0.5) {
      // Ink: a soft blot with a torn edge, thinning as it spreads.
      float ragged = 0.80 + 0.20 * hash11(floor(atan(uv.y, uv.x) * 14.0) + vSeed * 31.0);
      float body = smoothstep(ragged, ragged * 0.25, d);
      gl_FragColor = vec4(uInk * (0.55 + body * 0.5), body * (1.0 - vAge) * (1.0 - vAge) * 0.34);
    } else {
      // Spark: a hot core with a short cross flare.
      float core = smoothstep(1.0, 0.0, d);
      float flare = pow(max(0.0, 1.0 - abs(uv.x) * 5.0), 3.0) + pow(max(0.0, 1.0 - abs(uv.y) * 5.0), 3.0);
      gl_FragColor = vec4(uSpark * (1.0 + core * 1.6), (core * 0.5 + flare * 0.14) * (1.0 - vAge));
    }
  }
`;

/**
 * One pooled system carrying both halves of the look: ink that blooms and stalls, and sparks that
 * fly. They share a buffer and a draw call because they are always used together — an impact throws
 * both — and splitting them would double the cost to no visual end.
 */
export class InkBurst implements Effect {
  readonly object: THREE.Points;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly count: number;
  private readonly random: () => number;
  private cursor = 0;
  private time = 0;
  private carry = 0;
  /** Particles per second while emitting; 0 pauses without destroying the pool. */
  rate = 0;
  /** Fraction of emitted particles that are sparks rather than ink. */
  sparkRatio = 0.45;
  private readonly anchor = new THREE.Vector3();

  constructor(options: { count?: number; seed?: number; ink?: THREE.Color; spark?: THREE.Color } = {}) {
    this.count = options.count ?? 1400;
    this.random = makeRandom(options.seed ?? 0x1a5e);

    const position = new Float32Array(this.count * 3);
    const velocity = new Float32Array(this.count * 3);
    const birth = new Float32Array(this.count).fill(-1000);
    const life = new Float32Array(this.count).fill(1);
    const size = new Float32Array(this.count);
    const kind = new Float32Array(this.count);
    const seed = new Float32Array(this.count);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    this.geometry.setAttribute('aVelocity', new THREE.BufferAttribute(velocity, 3));
    this.geometry.setAttribute('aBirth', new THREE.BufferAttribute(birth, 1));
    this.geometry.setAttribute('aLife', new THREE.BufferAttribute(life, 1));
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    this.geometry.setAttribute('aKind', new THREE.BufferAttribute(kind, 1));
    this.geometry.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 12);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uGravity: { value: 0.28 },
        uInk: { value: (options.ink ?? SIGNATURE.crimson).clone() },
        uSpark: { value: (options.spark ?? SIGNATURE.gold).clone() },
      },
      vertexShader: INK_VERT,
      fragmentShader: INK_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.object = new THREE.Points(this.geometry, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 10;
    this.object.name = 'vfx:ink';
    markAsEffect(this.object);
  }

  setAnchor(worldPosition: THREE.Vector3): void {
    this.anchor.copy(worldPosition);
  }

  burst(n: number, speed = 1.4, radius = 0.06): void {
    for (let i = 0; i < n; i += 1) this.spawn(speed, radius);
  }

  private spawn(speed: number, radius: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.count;
    const g = this.geometry;
    const position = g.getAttribute('position') as THREE.BufferAttribute;
    const velocity = g.getAttribute('aVelocity') as THREE.BufferAttribute;
    const birth = g.getAttribute('aBirth') as THREE.BufferAttribute;
    const life = g.getAttribute('aLife') as THREE.BufferAttribute;
    const size = g.getAttribute('aSize') as THREE.BufferAttribute;
    const kind = g.getAttribute('aKind') as THREE.BufferAttribute;
    const seed = g.getAttribute('aSeed') as THREE.BufferAttribute;

    const isSpark = this.random() < this.sparkRatio;
    const theta = this.random() * Math.PI * 2;
    const phi = Math.acos(2 * this.random() - 1);
    const r = radius * Math.cbrt(this.random());
    position.setXYZ(
      i,
      this.anchor.x + r * Math.sin(phi) * Math.cos(theta),
      this.anchor.y + r * Math.cos(phi),
      this.anchor.z + r * Math.sin(phi) * Math.sin(theta),
    );
    const s = speed * (isSpark ? 0.8 + this.random() * 1.2 : 0.25 + this.random() * 0.5);
    velocity.setXYZ(
      i,
      Math.sin(phi) * Math.cos(theta) * s,
      Math.abs(Math.cos(phi)) * s * (isSpark ? 1.1 : 0.55) + (isSpark ? 0.5 : 0.25),
      Math.sin(phi) * Math.sin(theta) * s,
    );
    birth.setX(i, this.time);
    life.setX(i, isSpark ? 0.7 + this.random() * 0.5 : 1.3 + this.random() * 0.9);
    size.setX(i, isSpark ? 0.7 + this.random() * 1.0 : 2.2 + this.random() * 3.4);
    kind.setX(i, isSpark ? 1 : 0);
    seed.setX(i, this.random());

    for (const attr of [position, velocity, birth, life, size, kind, seed]) attr.needsUpdate = true;
  }

  update(dt: number): boolean {
    this.time += dt;
    this.material.uniforms.uTime.value = this.time;
    if (this.rate > 0) {
      this.carry += this.rate * dt;
      while (this.carry >= 1) {
        this.spawn(1.1, 0.05);
        this.carry -= 1;
      }
    }
    return true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// 符籙 — talismans
// ---------------------------------------------------------------------------------------------

const TALISMAN_VERT = /* glsl */ `
  attribute vec3 aOrigin;
  attribute vec3 aAxis;
  attribute float aBirth;
  attribute float aSpin;
  attribute float aSeed;
  uniform float uTime;
  uniform float uLife;
  varying vec2 vUv;
  varying float vAge;
  varying float vSeed;

  mat3 rotate(vec3 axis, float a) {
    float s = sin(a), c = cos(a), t = 1.0 - c;
    return mat3(
      t*axis.x*axis.x + c,        t*axis.x*axis.y - s*axis.z, t*axis.x*axis.z + s*axis.y,
      t*axis.x*axis.y + s*axis.z, t*axis.y*axis.y + c,        t*axis.y*axis.z - s*axis.x,
      t*axis.x*axis.z - s*axis.y, t*axis.y*axis.z + s*axis.x, t*axis.z*axis.z + c
    );
  }

  void main() {
    vUv = uv;
    vSeed = aSeed;
    float t = max(0.0, uTime - aBirth);
    vAge = t / uLife;

    // Thrown outward on its own axis, tumbling, slowing as it goes.
    vec3 flight = aOrigin + aAxis * (1.0 - exp(-t * 2.0)) * 0.7;
    flight.y += t * 0.3 - 0.34 * t * t;
    vec3 local = rotate(normalize(aAxis + vec3(0.0, 0.35, 0.0)), aSpin * t) * position;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(flight + local, 1.0);
  }
`;

const TALISMAN_FRAG = /* glsl */ `
  uniform vec3 uPaper;
  uniform vec3 uSeal;
  uniform float uOpacity;
  varying vec2 vUv;
  varying float vAge;
  varying float vSeed;

  ${GLSL_COMMON}

  void main() {
    if (vAge < 0.0 || vAge > 1.0) discard;

    // The strip of paper, with the edges charring inward as it ages.
    float burn = vAge * 0.55;
    vec2 p = vUv;
    float edge = min(min(p.x, 1.0 - p.x), min(p.y, 1.0 - p.y));
    float charred = hash21(floor(p * vec2(9.0, 26.0)) + vSeed * 17.0);
    if (edge < burn * charred) discard;

    // A single vertical column of seal script: blocky strokes, not letters.
    float col = smoothstep(0.30, 0.34, p.x) * smoothstep(0.70, 0.66, p.x);
    float row = floor(p.y * 15.0);
    float stroke = step(0.42, hash11(row * 2.3 + vSeed * 7.0));
    float bar = smoothstep(0.36, 0.26, abs(fract(p.y * 15.0) - 0.5)) * col * stroke;
    // A cinnabar seal near the foot of the column.
    float seal = step(abs(p.x - 0.5), 0.13) * step(abs(p.y - 0.16), 0.07);

    vec3 colour = mix(uPaper, uSeal, clamp(bar + seal * 1.4, 0.0, 1.0));
    // The burning edge glows just before it goes.
    float ember = smoothstep(burn * charred + 0.05, burn * charred, edge);
    float alpha = (0.62 + bar * 0.3) * (1.0 - smoothstep(0.7, 1.0, vAge)) * uOpacity;
    gl_FragColor = vec4(colour + uSeal * ember * 1.8, alpha);
  }
`;

/** A fan of paper talismans thrown outward from a socket, tumbling and burning off. */
export class TalismanSwarm implements Effect {
  readonly object: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private age = 0;

  constructor(origin: THREE.Vector3, count: number, private readonly duration: number, seed = 0x7a1) {
    const random = makeRandom(seed);
    const base = new THREE.PlaneGeometry(0.075, 0.2);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = base.index;
    this.geometry.attributes.position = base.attributes.position;
    this.geometry.attributes.uv = base.attributes.uv;
    this.geometry.instanceCount = count;

    const originArr = new Float32Array(count * 3);
    const axis = new Float32Array(count * 3);
    const birth = new Float32Array(count);
    const spin = new Float32Array(count);
    const seedArr = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      originArr[i * 3] = origin.x;
      originArr[i * 3 + 1] = origin.y;
      originArr[i * 3 + 2] = origin.z;
      const theta = (i / count) * Math.PI * 2 + random() * 0.4;
      axis[i * 3] = Math.cos(theta);
      axis[i * 3 + 1] = 0.25 + random() * 0.7;
      axis[i * 3 + 2] = Math.sin(theta);
      // Staggered, so the fan opens instead of appearing all at once.
      birth[i] = random() * duration * 0.22;
      spin[i] = (random() * 2 - 1) * 7;
      seedArr[i] = random();
    }
    this.geometry.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(originArr, 3));
    this.geometry.setAttribute('aAxis', new THREE.InstancedBufferAttribute(axis, 3));
    this.geometry.setAttribute('aBirth', new THREE.InstancedBufferAttribute(birth, 1));
    this.geometry.setAttribute('aSpin', new THREE.InstancedBufferAttribute(spin, 1));
    this.geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seedArr, 1));
    this.geometry.boundingSphere = new THREE.Sphere(origin.clone(), 6);
    base.dispose();

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uLife: { value: duration * 0.85 },
        uOpacity: { value: 1 },
        uPaper: { value: new THREE.Color(0xf0d89a) },
        uSeal: { value: SIGNATURE.crimson.clone() },
      },
      vertexShader: TALISMAN_VERT,
      fragmentShader: TALISMAN_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.object = new THREE.Mesh(this.geometry, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 12;
    this.object.name = 'vfx:talisman';
    markAsEffect(this.object);
  }

  update(dt: number): boolean {
    this.age += dt;
    this.material.uniforms.uTime.value = this.age;
    return this.age < this.duration;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// 蓮華 — the lotus
// ---------------------------------------------------------------------------------------------

const LOTUS_VERT = /* glsl */ `
  attribute float aPetal;
  attribute float aRow;
  uniform float uOpen;
  uniform float uPetals;
  varying vec2 vUv;

  void main() {
    vUv = uv;
    float a = (aPetal / uPetals) * 6.28318 + aRow * 0.4;
    // Rows open in sequence, outer first, so the flower unfolds instead of popping.
    float open = clamp((uOpen - aRow * 0.16) * 1.7, 0.0, 1.0);
    float lean = mix(0.06, 1.35, open);    // from closed bud to laid flat
    float reach = mix(0.15, 1.0, open);

    // The petal is built in its own frame — length along y, width along x — then swung out around
    // the flower's axis by its own angle.
    float curl = sin(uv.y * 1.5708) * (1.0 - open) * 0.7;
    vec3 local = vec3(
      position.x * (0.35 + 0.65 * open) * (1.0 - uv.y * 0.55),
      cos(lean) * position.y * reach + curl * 0.25 + 0.02 * aRow,
      sin(lean) * position.y * reach
    );
    vec3 world = vec3(cos(a) * local.z, local.y, sin(a) * local.z)
               + vec3(-sin(a) * local.x, 0.0, cos(a) * local.x);

    gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
  }
`;

const LOTUS_FRAG = /* glsl */ `
  uniform vec3 uPetal;
  uniform vec3 uHeart;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    // Petal outline: wide at the base, pointed at the tip.
    float halfWidth = sin((1.0 - vUv.y) * 1.948) * 0.5 + 0.02;
    if (abs(vUv.x - 0.5) > halfWidth) discard;
    float edge = 1.0 - abs(vUv.x - 0.5) / halfWidth;
    vec3 colour = mix(uHeart, uPetal, smoothstep(0.0, 0.55, vUv.y));
    // Thirty-six petals meet at the heart, and under additive blending every base stacked on every
    // other one until the centre was a white disc. Fading the base out keeps the flower a flower.
    float heart = smoothstep(0.0, 0.30, vUv.y);
    float alpha = (0.06 + edge * 0.15) * heart * (1.0 - smoothstep(0.75, 1.0, vUv.y) * 0.4) * uOpacity;
    gl_FragColor = vec4(colour * (0.5 + edge * 0.5), alpha);
  }
`;

/** A lotus opening under the feet. Rows unfold outer-first, then the flower lifts and fades. */
export class LotusBloom implements Effect {
  readonly object: THREE.Mesh;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private age = 0;

  constructor(centre: THREE.Vector3, scale: number, private readonly duration: number) {
    const PETALS = 12;
    const ROWS = 3;
    const SEG_U = 6;
    // The petal is BENT in the vertex stage, so its curve is only as smooth as its segment count.
    // At six it terraced into visible chevrons once the flower was scaled up for the ultimate.
    const SEG_V = 16;
    const position: number[] = [];
    const uv: number[] = [];
    const petal: number[] = [];
    const row: number[] = [];
    const index: number[] = [];
    let vertex = 0;

    for (let r = 0; r < ROWS; r += 1) {
      for (let p = 0; p < PETALS; p += 1) {
        const start = vertex;
        for (let v = 0; v <= SEG_V; v += 1) {
          for (let u = 0; u <= SEG_U; u += 1) {
            const fu = u / SEG_U;
            const fv = v / SEG_V;
            position.push((fu - 0.5) * scale * 0.55, fv * scale * (1 - r * 0.18), 0);
            uv.push(fu, fv);
            petal.push(p + r * 0.5);
            row.push(r);
            vertex += 1;
          }
        }
        for (let v = 0; v < SEG_V; v += 1) {
          for (let u = 0; u < SEG_U; u += 1) {
            const a = start + v * (SEG_U + 1) + u;
            index.push(a, a + (SEG_U + 1), a + 1, a + 1, a + (SEG_U + 1), a + (SEG_U + 2));
          }
        }
      }
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
    this.geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    this.geometry.setAttribute('aPetal', new THREE.Float32BufferAttribute(petal, 1));
    this.geometry.setAttribute('aRow', new THREE.Float32BufferAttribute(row, 1));
    this.geometry.setIndex(index);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), scale * 3);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uOpen: { value: 0 },
        uOpacity: { value: 1 },
        uPetals: { value: PETALS },
        uPetal: { value: SIGNATURE.crimson.clone() },
        uHeart: { value: SIGNATURE.gold.clone() },
      },
      vertexShader: LOTUS_VERT,
      fragmentShader: LOTUS_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });

    this.object = new THREE.Mesh(this.geometry, this.material);
    this.object.position.copy(centre);
    this.object.frustumCulled = false;
    this.object.renderOrder = 11;
    this.object.name = 'vfx:lotus';
    markAsEffect(this.object);
  }

  update(dt: number): boolean {
    this.age += dt;
    const t = Math.min(1, this.age / this.duration);
    this.material.uniforms.uOpen.value = smootherstep(t, 0, 0.45);
    this.material.uniforms.uOpacity.value = 1 - smootherstep(t, 0.55, 1);
    // The flower lifts a little as it fades, the way the films float them off the ground.
    this.object.position.y += dt * 0.25 * smootherstep(t, 0.4, 1);
    this.object.rotation.y += dt * 0.35;
    return t < 1;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// 筆鋒 — the calligraphic slash
// ---------------------------------------------------------------------------------------------

const SLASH_FRAG = /* glsl */ `
  uniform vec3 uInk;
  uniform vec3 uEdge;
  uniform float uProgress;
  uniform float uOpacity;
  varying vec2 vUv;

  ${GLSL_COMMON}

  void main() {
    // A brush stroke: pressed hard through the belly, lifted at both ends.
    float s = vUv.x;
    float belly = sin(pow(s, 0.8) * 3.14159);
    float halfWidth = belly * 0.5;
    float dy = abs(vUv.y - 0.5);
    if (dy > halfWidth) discard;

    // 飛白 "flying white": the streaks a dry brush leaves as it is dragged off. Keyed on position
    // ALONG the stroke as well as across it — keyed on the cross axis alone the gaps ran the whole
    // length as clean parallel stripes, which reads as a printing artefact rather than as bristles.
    float dry = smoothstep(0.5, 1.0, s);
    float bristle = hash21(vec2(floor(vUv.y * 30.0), floor(s * 7.0)));
    if (dry > 0.12 && bristle < dry * 0.95) discard;

    // Laid down nib-first over the swing rather than existing all at once.
    if (s > uProgress) discard;
    float nib = smoothstep(0.10, 0.0, uProgress - s);
    float edge = 1.0 - dy / max(halfWidth, 1e-4);

    vec3 colour = mix(uInk, uEdge, pow(edge, 2.2) * 0.6 + nib);
    gl_FragColor = vec4(colour * (1.0 + nib * 3.0 + edge * 0.6), (0.5 + edge * 0.5) * belly * uOpacity);
  }
`;

/**
 * The cut, drawn as a single brush stroke through the air.
 *
 * Sampled from the socket like a ribbon, but shaped like calligraphy: the stroke swells where the
 * brush presses and frays into flying white as it is dragged off.
 */
export class BrushSlash implements Effect {
  readonly object: THREE.Mesh;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly samples: THREE.Vector3[] = [];
  private readonly maxSamples: number;
  private readonly width: number;
  private readonly position: Float32Array;
  private readonly uv: Float32Array;
  opacity = 0;

  constructor(options: { samples?: number; width?: number; ink?: THREE.Color; edge?: THREE.Color } = {}) {
    this.maxSamples = options.samples ?? 30;
    this.width = options.width ?? 0.26;
    this.position = new Float32Array(this.maxSamples * 2 * 3);
    this.uv = new Float32Array(this.maxSamples * 2 * 2);
    const index: number[] = [];
    for (let i = 0; i < this.maxSamples - 1; i += 1) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.position, 3));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2));
    this.geometry.setIndex(index);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 12);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uInk: { value: (options.ink ?? SIGNATURE.crimson).clone() },
        uEdge: { value: (options.edge ?? SIGNATURE.gold).clone() },
        uProgress: { value: 0 },
        uOpacity: { value: 0 },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: SLASH_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });

    this.object = new THREE.Mesh(this.geometry, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 12;
    this.object.name = 'vfx:slash';
    markAsEffect(this.object);
  }

  clear(): void {
    this.samples.length = 0;
  }

  push(at: THREE.Vector3, cameraPosition: THREE.Vector3, progress: number): void {
    this.samples.push(at.clone());
    while (this.samples.length > this.maxSamples) this.samples.shift();
    this.material.uniforms.uProgress.value = progress;
    this.rebuild(cameraPosition);
  }

  private rebuild(cameraPosition: THREE.Vector3): void {
    const n = this.samples.length;
    const direction = new THREE.Vector3();
    const toCamera = new THREE.Vector3();
    const sideways = new THREE.Vector3();
    for (let i = 0; i < this.maxSamples; i += 1) {
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
      sideways.normalize().multiplyScalar(this.width * 0.5);

      const t = this.maxSamples === 1 ? 0 : i / (this.maxSamples - 1);
      const a = i * 2;
      this.position[a * 3] = point.x - sideways.x;
      this.position[a * 3 + 1] = point.y - sideways.y;
      this.position[a * 3 + 2] = point.z - sideways.z;
      this.position[(a + 1) * 3] = point.x + sideways.x;
      this.position[(a + 1) * 3 + 1] = point.y + sideways.y;
      this.position[(a + 1) * 3 + 2] = point.z + sideways.z;
      this.uv[a * 2] = 1 - t;
      this.uv[a * 2 + 1] = 0;
      this.uv[(a + 1) * 2] = 1 - t;
      this.uv[(a + 1) * 2 + 1] = 1;
    }
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('uv') as THREE.BufferAttribute).needsUpdate = true;
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
// Aura shell — a fresnel rim on the character's own silhouette
// ---------------------------------------------------------------------------------------------

/**
 * The aura's vertex stage has to do its own skinning.
 *
 * `three` injects skinning into its OWN materials, but a `ShaderMaterial` gets only what its source
 * asks for. Without these chunks the shell drew the geometry in its BIND pose while the character
 * animated beside it — on screen that was a second, motionless figure standing behind the real one.
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
    // The shell is drawn BackSide, so the interpolated normal points away from the eye and the dot
    // product is negative across the whole surface. Clamping that to zero made fresnel evaluate to
    // 1.0 everywhere and painted a solid silhouette over the character instead of a rim.
    vec3 n = -normalize(vNormalView);
    float facing = clamp(dot(n, normalize(vViewDir)), 0.0, 1.0);
    float fresnel = pow(1.0 - facing, 4.0);
    float pulse = 0.85 + 0.15 * sin(uTime * 3.4);
    gl_FragColor = vec4(uColour * fresnel * 1.9 * pulse, fresnel * uStrength);
  }
`;

/**
 * A rim glow that hugs the figure, borrowing the character's OWN geometry so the rim traces the
 * real silhouette of the armour rather than a capsule standing in for it.
 */
export class AuraShell implements Effect {
  readonly object: THREE.Group;
  private readonly materials: THREE.ShaderMaterial[] = [];
  /** Each rim shell beside the mesh it traces, so it can follow that mesh being hidden or moved. */
  private readonly pairs: { shell: THREE.SkinnedMesh; source: THREE.SkinnedMesh }[] = [];
  private time = 0;
  /** 0..1; the skills drive this. */
  strength = 0;

  constructor(source: THREE.SkinnedMesh[], colour: THREE.Color = SIGNATURE.crimson, inflate = 0.0035) {
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

  /** Recolour the rim — the skills tint it to whatever the moment calls for. */
  setColour(colour: THREE.Color): void {
    for (const material of this.materials) material.uniforms.uColour.value.copy(colour);
  }

  update(dt: number): boolean {
    this.time += dt;
    for (const material of this.materials) {
      material.uniforms.uTime.value = this.time;
      material.uniforms.uStrength.value = this.strength;
    }
    // A rim traces a surface, so it follows it: hidden when it is hidden, moved when it is moved.
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

// ---------------------------------------------------------------------------------------------
// 空間裂痕 — the air, cracked
// ---------------------------------------------------------------------------------------------

const FRACTURE_FRAG = /* glsl */ `
  uniform vec3 uCore;
  uniform vec3 uRim;
  uniform float uProgress;
  uniform float uSeed;
  varying vec2 vUv;

  ${GLSL_COMMON}

  /**
   * Distance to the nearest crack.
   *
   * The branch is WALKED as a polyline — each step turns a little off the last and the distance is
   * taken to the segment, so the fissure is one connected zigzag. Perturbing a bearing per radial
   * ring instead, which is the obvious shortcut, leaves each ring's fragment unaware of the ring
   * before it: the result is a set of dashes strung along straight rays, and on screen that reads as
   * a firework rather than as broken glass.
   */
  float crackDistance(vec2 p, float branches) {
    float best = 10.0;
    for (int i = 0; i < 9; i++) {
      if (float(i) >= branches) break;
      float id = float(i) * 13.7 + uSeed;
      vec2 cur = vec2(0.0);
      float bearing = hash11(id) * 6.28318;
      for (int s = 0; s < 6; s++) {
        // Turn, then step. The turn shrinks as the branch runs out so tips stay straighter.
        bearing += (hash11(id + float(s) * 3.1) - 0.5) * (0.95 - float(s) * 0.1);
        vec2 next = cur + vec2(cos(bearing), sin(bearing)) * 0.2;
        vec2 e = next - cur;
        vec2 w = p - cur;
        float h = clamp(dot(w, e) / max(dot(e, e), 1e-6), 0.0, 1.0);
        best = min(best, length(w - e * h));
        cur = next;
      }
    }
    return best;
  }

  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float r = length(p);
    if (r > 1.0) discard;
    // The fracture runs outward, then knits shut from the rim back in.
    float open = smoothstep(0.0, 0.34, uProgress);
    float heal = smoothstep(0.62, 1.0, uProgress);
    float reach = open * 1.05 - heal * 0.85;
    if (r > reach) discard;

    float d = crackDistance(p, 5.0);
    // Widest at the origin, closing to a hairline at the tip.
    float width = mix(0.05, 0.008, r / max(reach, 1e-3));
    float line = smoothstep(width, 0.0, d);
    if (line <= 0.001) discard;

    // Light leaks through the split: a hot seam with a coloured bleed either side.
    float seam = smoothstep(width * 0.3, 0.0, d);
    vec3 colour = uRim * (line - seam) + uCore * seam;

    float front = smoothstep(0.16, 0.0, abs(r - reach));
    float alpha = (line * 0.5 + seam * 0.6) * (1.0 - heal) * (0.5 + front * 0.8);
    gl_FragColor = vec4(colour * (0.9 + front), alpha);
  }
`;

/**
 * A tear in the air.
 *
 * Drawn on a camera-facing quad rather than as geometry: a crack in space has no thickness to model,
 * and what sells it is the seam of light and the hard angular branching, both of which live in the
 * fragment stage. It opens outward, holds, then knits shut from the rim inward.
 */
export class AirFracture implements Effect {
  readonly object: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.PlaneGeometry;
  private age = 0;

  constructor(
    centre: THREE.Vector3,
    radius: number,
    private readonly duration: number,
    seed = Math.random() * 100,
    core: THREE.Color = new THREE.Color(0xfff2d0),
    rim: THREE.Color = SIGNATURE.crimson,
  ) {
    this.geometry = new THREE.PlaneGeometry(radius * 2, radius * 2);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uCore: { value: core.clone() },
        uRim: { value: rim.clone() },
        uProgress: { value: 0 },
        uSeed: { value: seed },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: FRACTURE_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.object = new THREE.Mesh(this.geometry, this.material);
    this.object.position.copy(centre);
    this.object.renderOrder = 14;
    this.object.name = 'vfx:fracture';
    markAsEffect(this.object);
  }

  /** Turn the tear to face the viewer; a crack seen edge-on is not a crack. */
  face(cameraPosition: THREE.Vector3): void {
    this.object.lookAt(cameraPosition);
  }

  update(dt: number): boolean {
    this.age += dt;
    const t = Math.min(1, this.age / this.duration);
    this.material.uniforms.uProgress.value = t;
    return t < 1;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// 焚身火焰 — stylised flame
// ---------------------------------------------------------------------------------------------

const FLAME_VERT = /* glsl */ `
  attribute vec3 aSeat;       // where on the ring this tongue stands
  attribute float aPhase;     // its offset within the rise cycle
  attribute float aScale;
  attribute float aSeed;
  uniform float uTime;
  uniform float uIntensity;
  uniform float uHeight;
  varying vec2 vUv;
  varying float vLife;
  varying float vSeed;

  void main() {
    vUv = uv;
    vSeed = aSeed;

    // Each tongue runs its own rise cycle, staggered by its phase.
    float life = fract(uTime * 0.85 + aPhase);
    vLife = life;

    vec3 seat = aSeat;
    seat.y += life * uHeight;
    // Tongues lean inward as they climb, the way a fire draws toward its own column.
    seat.xz *= 1.0 - life * 0.45;

    // Billboard in view space so every tongue faces the camera without a lookAt per instance.
    vec4 mv = modelViewMatrix * vec4(seat, 1.0);
    float grow = sin(life * 3.14159) * aScale * uIntensity;
    // Curl: the tip drifts sideways as it rises, which is what makes the hooked ru-yi shape.
    float curl = sin(life * 4.2 + aSeed * 6.28) * 0.35 * uv.y;
    // TALLER THAN WIDE. On a square quad each tongue came out as broad as it was high, and forty of
    // them stacked read as a terrace of horizontal bars rather than as fire. A flame is a slender
    // thing; the aspect is what carries that.
    mv.xy += vec2((position.x + curl) * 0.52, position.y * 1.85) * grow;
    gl_Position = projectionMatrix * mv;
  }
`;

const FLAME_FRAG = /* glsl */ `
  uniform vec3 uHot;
  uniform vec3 uCool;
  uniform float uIntensity;
  varying vec2 vUv;
  varying float vLife;
  varying float vSeed;

  ${GLSL_COMMON}

  void main() {
    // A stylised tongue, not a soft plume: wide at the foot, drawn to a point, with the whole
    // silhouette leaning into a hook. This is the flame of a painted 火焰紋 rather than a photograph.
    float y = vUv.y;
    float lean = pow(y, 1.6) * 0.30;
    float dx = (vUv.x - 0.5) - lean * sin(vSeed * 6.28);
    // A gentle waist rather than a nine-cycle ripple: at that frequency the discard edge
    // serrated the tongue into visible stair steps instead of reading as a drawn flame.
    float halfWidth = pow(1.0 - y, 0.62) * 0.40 * (0.92 + 0.08 * sin(y * 3.0 + vSeed * 20.0));
    if (abs(dx) > halfWidth) discard;

    float edge = 1.0 - abs(dx) / max(halfWidth, 1e-4);
    // Hot at the heart and the base, cooling toward the tip.
    vec3 colour = mix(uCool, uHot, clamp(pow(edge, 1.7) * 0.95, 0.0, 1.0));
    // Fade in off the ground, out at the top of the rise.
    float fade = smoothstep(0.0, 0.12, vLife) * (1.0 - smoothstep(0.55, 1.0, vLife));
    float alpha = edge * fade * 0.34 * uIntensity;
    gl_FragColor = vec4(colour * (0.7 + edge * 1.0), alpha);
  }
`;

/**
 * A ring of stylised flame standing around the figure.
 *
 * Persistent and pooled: the tongues cycle continuously and `intensity` decides how much of that is
 * visible, so a skill can bring the fire up and down without spawning anything. Each tongue is an
 * instanced quad billboarded in VIEW space — cheaper and steadier than orienting every instance on
 * the CPU, and it keeps the painted silhouette square to the viewer where it reads best.
 */
export class SpiritFlame implements Effect {
  readonly object: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private time = 0;
  /** 0..1; the skills drive this. */
  intensity = 0;
  private readonly anchor = new THREE.Vector3();

  constructor(options: { count?: number; radius?: number; height?: number; seed?: number } = {}) {
    const count = options.count ?? 44;
    const radius = options.radius ?? 0.46;
    const random = makeRandom(options.seed ?? 0xf1a3);

    const base = new THREE.PlaneGeometry(1, 1);
    // The quad grows from its foot, so the origin sits at the bottom edge rather than the centre.
    base.translate(0, 0.5, 0);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = base.index;
    this.geometry.attributes.position = base.attributes.position;
    this.geometry.attributes.uv = base.attributes.uv;
    this.geometry.instanceCount = count;

    const seat = new Float32Array(count * 3);
    const phase = new Float32Array(count);
    const scale = new Float32Array(count);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      const theta = random() * Math.PI * 2;
      // Scattered through a shell rather than on a circle, so the ring has depth to it.
      const r = radius * (0.55 + random() * 0.65);
      seat[i * 3] = Math.cos(theta) * r;
      seat[i * 3 + 1] = random() * 0.12;
      seat[i * 3 + 2] = Math.sin(theta) * r;
      phase[i] = random();
      scale[i] = 0.26 + random() * 0.34;
      seed[i] = random();
    }
    this.geometry.setAttribute('aSeat', new THREE.InstancedBufferAttribute(seat, 3));
    this.geometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    this.geometry.setAttribute('aScale', new THREE.InstancedBufferAttribute(scale, 1));
    this.geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 1));
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 6);
    base.dispose();

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 0 },
        uHeight: { value: options.height ?? 1.5 },
        uHot: { value: SIGNATURE.gold.clone() },
        uCool: { value: SIGNATURE.crimson.clone() },
      },
      vertexShader: FLAME_VERT,
      fragmentShader: FLAME_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });

    this.object = new THREE.Mesh(this.geometry, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 9;
    this.object.name = 'vfx:flame';
    markAsEffect(this.object);
  }

  /** Stand the fire around a world position — the figure's feet. */
  setAnchor(worldPosition: THREE.Vector3): void {
    this.anchor.copy(worldPosition);
    this.object.position.copy(worldPosition);
  }

  update(dt: number): boolean {
    this.time += dt;
    this.material.uniforms.uTime.value = this.time;
    this.material.uniforms.uIntensity.value = this.intensity;
    this.object.visible = this.intensity > 0.001;
    return true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
