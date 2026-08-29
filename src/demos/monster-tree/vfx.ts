import * as THREE from 'three';
import { LIFE_HUE, LIFE_SATURATION, PALETTE } from './measured';

/**
 * Effects for the monster-tree showcase.
 *
 * WHAT THIS IS: hand-written plain-Three.js. The img2threejs skill has no particle subsystem, no
 * trail subsystem and no shader library, so every effect below — the spore field, the eye glow,
 * the palm trails, the ground rings, the chest core, the bursts — was written for this demo. No
 * dependency is added; everything is `THREE.Points`, `THREE.Mesh`, a `ShaderMaterial`, or a
 * texture painted into a `<canvas>` at build time.
 *
 * WHERE THINGS GO: every effect is anchored to a socket or a bone that actually exists on the rig
 * — `rig.sockets['eye-l']`, `rig.bones['R_ToeBase']` — and the sockets themselves are measured
 * centroids of real vertex clusters (see `measured.ts`). There are no magic coordinates in this
 * file. The only literals are radii, counts and durations, which are effect parameters rather than
 * placements.
 *
 * WHAT COLOUR THINGS ARE: everything emissive is built from `LIFE_HUE`, the hue measured off the
 * character's own iris in the reference photograph (82.5 degrees). Saturation and lightness are
 * pushed past the measured values because an emissive channel has to out-run the albedo it sits
 * on, but the hue never moves. Bark and moss tints come from `PALETTE`, also measured.
 */

/**
 * Eye halo diameter as a fraction of figure height. Small: an additively blended sprite saturates
 * to white long before it reaches its own edge, so a halo sized to "look like a glow" at full
 * opacity reads as a headlight instead of an eye.
 */
const EYE_SPRITE = 0.028;

/** Deterministic PRNG so a reload produces the same drift, not a different one. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The character's life-force colour at a given intensity. Hue is measured and never moves. */
export function lifeColour(lightness = 0.55, saturation = Math.min(1, LIFE_SATURATION * 1.9)): THREE.Color {
  return new THREE.Color().setHSL(LIFE_HUE, saturation, lightness);
}

/** A soft radial dot, painted once and shared by every point sprite. */
function dotTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** A soft-edged ring, for the ground shockwave. */
function ringTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,0)');
  g.addColorStop(0.62, 'rgba(255,255,255,0)');
  g.addColorStop(0.80, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.93, 'rgba(255,255,255,0.25)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

interface Tickable {
  object: THREE.Object3D;
  tick(dt: number, elapsed: number): boolean;
}

/**
 * The spore field: motes of drifting light around the figure, the ambient sign that the thing is
 * alive rather than a dead log. One `THREE.Points`, one draw call, positions advanced on the CPU
 * because there are only a few hundred of them and a GPU curl-noise pass would be more machinery
 * than the effect is worth.
 */
class SporeField implements Tickable {
  readonly object: THREE.Points;
  private readonly velocity: Float32Array;
  private readonly life: Float32Array;
  private readonly span: Float32Array;
  private readonly random: () => number;
  private readonly bounds: THREE.Box3;

  constructor(bounds: THREE.Box3, count: number, texture: THREE.Texture) {
    this.bounds = bounds;
    this.random = mulberry32(0x5eed);
    const positions = new Float32Array(count * 3);
    const colours = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    this.velocity = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.span = new Float32Array(count);

    const warm = lifeColour(0.62);
    const cool = new THREE.Color(PALETTE.mossLight).convertSRGBToLinear();
    for (let i = 0; i < count; i += 1) {
      this.respawn(i, positions, true);
      // Most motes are the character's own green; a minority take the moss tint, so the field
      // reads as two shades rather than one flat colour.
      const c = this.random() < 0.72 ? warm : cool;
      colours[i * 3] = c.r;
      colours[i * 3 + 1] = c.g;
      colours[i * 3 + 2] = c.b;
      sizes[i] = 0.012 + this.random() * 0.03;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    const material = new THREE.ShaderMaterial({
      uniforms: { map: { value: texture }, opacity: { value: 1 } },
      vertexShader: `
        attribute float size;
        varying vec3 vColour;
        varying float vFade;
        void main() {
          vColour = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          // Fade with distance so the far side of the field does not read as noise over the figure.
          vFade = clamp(1.0 - (-mv.z - 2.0) / 8.0, 0.15, 1.0);
          gl_PointSize = size * 320.0 / max(-mv.z, 0.001);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D map;
        uniform float opacity;
        varying vec3 vColour;
        varying float vFade;
        void main() {
          float a = texture2D(map, gl_PointCoord).a;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vColour, a * vFade * opacity);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
    });

    this.object = new THREE.Points(geometry, material);
    this.object.name = 'vfx:spore-field';
    this.object.frustumCulled = false;
  }

  private respawn(i: number, positions: Float32Array, initial: boolean): void {
    const r = this.random;
    const size = this.bounds.getSize(new THREE.Vector3());
    const centre = this.bounds.getCenter(new THREE.Vector3());
    positions[i * 3] = centre.x + (r() - 0.5) * size.x * 2.2;
    positions[i * 3 + 1] = this.bounds.min.y + r() * size.y * (initial ? 1 : 0.45);
    positions[i * 3 + 2] = centre.z + (r() - 0.5) * size.z * 1.15;
    this.velocity[i * 3] = (r() - 0.5) * 0.05;
    this.velocity[i * 3 + 1] = 0.04 + r() * 0.10;
    this.velocity[i * 3 + 2] = (r() - 0.5) * 0.05;
    this.span[i] = 4 + r() * 7;
    this.life[i] = initial ? r() * this.span[i] : 0;
  }

  tick(dt: number, elapsed: number): boolean {
    const attr = this.object.geometry.getAttribute('position') as THREE.BufferAttribute;
    const positions = attr.array as Float32Array;
    for (let i = 0; i < this.life.length; i += 1) {
      this.life[i] += dt;
      if (this.life[i] > this.span[i]) this.respawn(i, positions, false);
      // A slow lateral sway keyed off the mote's own index, so no two drift in step.
      positions[i * 3] += (this.velocity[i * 3] + Math.sin(elapsed * 0.6 + i) * 0.02) * dt;
      positions[i * 3 + 1] += this.velocity[i * 3 + 1] * dt;
      positions[i * 3 + 2] += (this.velocity[i * 3 + 2] + Math.cos(elapsed * 0.5 + i * 1.7) * 0.02) * dt;
    }
    attr.needsUpdate = true;
    return true;
  }
}

/**
 * The eye glow. Two additive quads that always face the camera, plus one real point light so the
 * green actually lands on the bark around the brow instead of floating in front of it.
 */
class EyeGlow implements Tickable {
  readonly object: THREE.Group;
  private readonly sprites: THREE.Sprite[];
  private readonly light: THREE.PointLight;
  private readonly base: number;
  private readonly scale: number;

  constructor(anchors: THREE.Object3D[], texture: THREE.Texture, scale: number) {
    this.scale = scale;
    this.object = new THREE.Group();
    this.object.name = 'vfx:eye-glow';
    const material = new THREE.SpriteMaterial({
      map: texture,
      // Additive blending sums toward white, so the sprite's own colour has to sit well below
      // full lightness or the glow loses the hue it was measured from.
      color: lifeColour(0.42, 1),
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    // 0.045 of figure height is about 8 cm of glow around a ~4 cm eye. Sized off the figure rather
    // than in absolute units so the halo stays proportionate if the model is ever rescaled.
    this.sprites = anchors.map((anchor) => {
      const sprite = new THREE.Sprite(material);
      sprite.scale.setScalar(EYE_SPRITE * scale);
      sprite.userData.isHighlight = true;
      anchor.add(sprite);
      return sprite;
    });
    this.base = 0.55;
    // Short range: the glow should pick out the brow ridge and the bridge of the nose, not light
    // the whole head from the front like a lamp.
    this.light = new THREE.PointLight(lifeColour(0.5, 1), this.base, 0.32 * scale, 2);
    this.light.name = 'vfx:eye-light';
    if (anchors[0]?.parent) anchors[0].parent.add(this.light);
    this.light.position.copy(anchors[0]?.position ?? new THREE.Vector3());
  }

  /** Raised by the skill system while a power is charging. */
  intensity = 1;

  tick(_dt: number, elapsed: number): boolean {
    // Two detuned sines so the flicker never settles into an obvious loop.
    const flicker = 0.86 + Math.sin(elapsed * 2.3) * 0.09 + Math.sin(elapsed * 5.7) * 0.05;
    const k = flicker * this.intensity;
    for (const sprite of this.sprites) sprite.scale.setScalar(EYE_SPRITE * this.scale * k);
    this.light.intensity = this.base * k * k;
    return true;
  }
}

/**
 * A ribbon that follows a socket.
 *
 * The strip is a fixed-length triangle band whose vertices are rewritten each frame from a ring
 * buffer of past world positions, so nothing is reallocated while it runs.
 *
 * Two details that are easy to get wrong and both look spectacular when you do:
 *
 *   - The unfilled tail is COLLAPSED onto the oldest real sample, not left wherever the buffer
 *     happened to be. A freshly allocated ring buffer holds the origin, so a ribbon that simply
 *     hides its tail with alpha still stretches a full-width quad from the character's fist to
 *     world zero — and since the band is additive, "hidden" is only ever as hidden as the alpha
 *     plumbing actually is. Degenerate triangles cannot draw at all.
 *   - The ribbon is oriented against the REAL camera, taken from `onBeforeRender`, not against a
 *     fixed world axis. With a fixed axis the band turns edge-on and vanishes exactly when the
 *     swing comes toward the viewer, which is the frame the effect exists for.
 */
class Trail implements Tickable {
  readonly object: THREE.Mesh;
  private readonly history: THREE.Vector3[];
  private readonly source: THREE.Object3D;
  private readonly width: number;
  private head = 0;
  private filled = 0;
  private fade = 0;
  private readonly view = new THREE.Vector3(0, 0, 1);
  /** Raised to 1 while the swing is live, then eased back so the ribbon dissolves behind the hand. */
  strength = 0;

  constructor(source: THREE.Object3D, segments: number, width: number, colour: THREE.Color) {
    this.source = source;
    this.width = width;
    this.history = Array.from({ length: segments }, () => new THREE.Vector3());

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segments * 6), 3));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(segments * 2), 1));
    const index: number[] = [];
    for (let i = 0; i < segments - 1; i += 1) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geometry.setIndex(index);

    // A ShaderMaterial rather than a patched MeshBasicMaterial. The ribbon needs exactly one
    // thing a stock material will not give it — per-vertex alpha — and threading that through
    // `onBeforeCompile` means depending on the internal names of three's shader chunks, which is
    // both fragile and silent when it breaks: the injection simply does not apply and the ribbon
    // draws as one opaque untapered slab across the frame. Twelve lines of GLSL are cheaper.
    const material = new THREE.ShaderMaterial({
      uniforms: { uColour: { value: colour } },
      vertexShader: `
        attribute float aAlpha;
        varying float vAlpha;
        void main() {
          vAlpha = aAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uColour;
        varying float vAlpha;
        void main() {
          if (vAlpha < 0.004) discard;
          gl_FragColor = vec4(uColour, vAlpha);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.object = new THREE.Mesh(geometry, material);
    this.object.name = `vfx:trail:${source.name}`;
    this.object.frustumCulled = false;
    this.object.visible = false;
    this.object.renderOrder = 3;
    this.object.onBeforeRender = (_r, _s, camera) => {
      camera.getWorldDirection(this.view);
    };
  }

  /** Drop the tail on the current position, so a new swing does not draw in from the last one. */
  private restart(at: THREE.Vector3): void {
    for (const p of this.history) p.copy(at);
    this.head = 0;
    this.filled = 1;
  }

  tick(dt: number, _elapsed: number): boolean {
    const wasIdle = this.fade < 0.02 && this.strength === 0;
    this.fade += (this.strength - this.fade) * Math.min(1, dt * 9);
    if (this.fade < 0.02 && this.strength === 0) {
      this.object.visible = false;
      this.filled = 0;
      return true;
    }

    const world = new THREE.Vector3().setFromMatrixPosition(this.source.matrixWorld);
    if (wasIdle || this.filled === 0) this.restart(world);
    this.object.visible = true;

    this.history[this.head].copy(world);
    this.head = (this.head + 1) % this.history.length;
    this.filled = Math.min(this.filled + 1, this.history.length);

    const position = this.object.geometry.getAttribute('position') as THREE.BufferAttribute;
    const alpha = this.object.geometry.getAttribute('aAlpha') as THREE.BufferAttribute;
    const n = this.history.length;
    const dir = new THREE.Vector3();
    const side = new THREE.Vector3();
    const offset = new THREE.Vector3();

    for (let i = 0; i < n; i += 1) {
      // Past the filled length every vertex sits on the oldest real sample, so those triangles are
      // degenerate and cannot rasterise whatever the alpha does.
      const step = Math.min(i, this.filled - 1);
      const at = (this.head - 1 - step + n * 2) % n;
      const previous = (at - 1 + n) % n;
      const p = this.history[at];
      dir.subVectors(p, this.history[previous]);
      if (dir.lengthSq() < 1e-12) dir.subVectors(p, this.history[(at + 1) % n]);
      if (dir.lengthSq() < 1e-12) dir.set(0, 1, 0);
      side.crossVectors(dir.normalize(), this.view);
      if (side.lengthSq() < 1e-12) side.set(1, 0, 0);
      offset.copy(side.normalize()).multiplyScalar(this.width * (1 - i / n) ** 1.4 * (i < this.filled ? 1 : 0));
      position.setXYZ(i * 2, p.x + offset.x, p.y + offset.y, p.z + offset.z);
      position.setXYZ(i * 2 + 1, p.x - offset.x, p.y - offset.y, p.z - offset.z);
      const a = i < this.filled ? (1 - i / n) ** 2.4 * this.fade * 0.85 : 0;
      alpha.setX(i * 2, a);
      alpha.setX(i * 2 + 1, a);
    }
    position.needsUpdate = true;
    alpha.needsUpdate = true;
    return true;
  }
}

/**
 * The ground shockwave: a flat additive ring that expands and fades. Drawn on a disc rather than a
 * torus so it can be a single quad with a painted profile — the shape lives in the texture.
 */
class GroundRing implements Tickable {
  readonly object: THREE.Mesh;
  private age = 0;

  constructor(
    private readonly duration: number,
    private readonly maxRadius: number,
    colour: THREE.Color,
    texture: THREE.Texture,
  ) {
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      color: colour,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.object = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    this.object.name = 'vfx:ground-ring';
    this.object.rotation.x = -Math.PI / 2;
    this.object.renderOrder = 2;
  }

  tick(dt: number): boolean {
    this.age += dt;
    const t = this.age / this.duration;
    if (t >= 1) return false;
    // Fast out, slow settle — a shockwave does not expand linearly.
    const radius = this.maxRadius * (1 - (1 - t) ** 3);
    this.object.scale.set(radius * 2, radius * 2, 1);
    (this.object.material as THREE.MeshBasicMaterial).opacity = (1 - t) ** 1.5;
    return true;
  }
}

/** A one-shot puff of motes, thrown outward from a point and pulled back down by gravity. */
class Burst implements Tickable {
  readonly object: THREE.Points;
  private readonly velocity: Float32Array;
  private age = 0;

  constructor(
    origin: THREE.Vector3,
    count: number,
    speed: number,
    private readonly duration: number,
    colour: THREE.Color,
    texture: THREE.Texture,
    private readonly gravity = -1.6,
    spread = 1,
    seed = 1,
  ) {
    const random = mulberry32(seed);
    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    this.velocity = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      positions[i * 3] = origin.x;
      positions[i * 3 + 1] = origin.y;
      positions[i * 3 + 2] = origin.z;
      // Uniform on a sphere, then squashed toward the horizontal by `spread`.
      const theta = random() * Math.PI * 2;
      const z = random() * 2 - 1;
      const r = Math.sqrt(1 - z * z);
      const v = speed * (0.35 + random() * 0.65);
      this.velocity[i * 3] = Math.cos(theta) * r * v;
      this.velocity[i * 3 + 1] = z * v * spread;
      this.velocity[i * 3 + 2] = Math.sin(theta) * r * v;
      sizes[i] = 0.02 + random() * 0.05;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    const material = new THREE.ShaderMaterial({
      uniforms: { map: { value: texture }, uColour: { value: colour }, uOpacity: { value: 1 } },
      vertexShader: `
        attribute float size;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * 420.0 / max(-mv.z, 0.001);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D map; uniform vec3 uColour; uniform float uOpacity;
        void main() {
          float a = texture2D(map, gl_PointCoord).a;
          if (a < 0.01) discard;
          gl_FragColor = vec4(uColour, a * uOpacity);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.object = new THREE.Points(geometry, material);
    this.object.name = 'vfx:burst';
    this.object.frustumCulled = false;
  }

  tick(dt: number): boolean {
    this.age += dt;
    const t = this.age / this.duration;
    if (t >= 1) return false;
    const attr = this.object.geometry.getAttribute('position') as THREE.BufferAttribute;
    const positions = attr.array as Float32Array;
    for (let i = 0; i < positions.length / 3; i += 1) {
      this.velocity[i * 3 + 1] += this.gravity * dt;
      positions[i * 3] += this.velocity[i * 3] * dt;
      positions[i * 3 + 1] += this.velocity[i * 3 + 1] * dt;
      positions[i * 3 + 2] += this.velocity[i * 3 + 2] * dt;
    }
    attr.needsUpdate = true;
    (this.object.material as THREE.ShaderMaterial).uniforms.uOpacity.value = (1 - t) ** 1.4;
    return true;
  }
}

/** The chest core: a sphere that swells and brightens while a power is being gathered. */
class CoreGlow implements Tickable {
  readonly object: THREE.Mesh;
  private readonly light: THREE.PointLight;
  /** 0 = dormant, 1 = fully charged. Driven by the skill system. */
  charge = 0;

  constructor(anchor: THREE.Object3D, scale: number) {
    const material = new THREE.MeshBasicMaterial({
      color: lifeColour(0.6, 1),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.object = new THREE.Mesh(new THREE.SphereGeometry(0.09 * scale, 20, 14), material);
    this.object.name = 'vfx:chest-core';
    this.object.userData.isHighlight = true;
    anchor.add(this.object);
    this.light = new THREE.PointLight(lifeColour(0.5, 1), 0, 2.2 * scale, 2);
    this.light.name = 'vfx:chest-core-light';
    anchor.add(this.light);
  }

  tick(_dt: number, elapsed: number): boolean {
    const pulse = 0.82 + Math.sin(elapsed * 9) * 0.18;
    const k = this.charge * pulse;
    (this.object.material as THREE.MeshBasicMaterial).opacity = Math.min(1, k * 0.9);
    this.object.scale.setScalar(0.6 + k * 0.8);
    this.light.intensity = k * 3.2;
    return true;
  }
}

/**
 * The VFX system. Owns the shared textures, the persistent effects and the transient ones, and
 * runs them all from a single `update`.
 */
export class MonsterTreeVfx {
  readonly group = new THREE.Group();
  readonly eyes: EyeGlow;
  readonly core: CoreGlow;
  readonly trails: Record<'grip-l' | 'grip-r', Trail>;
  private readonly spores: SporeField;
  private readonly transient: Tickable[] = [];
  private readonly dot = dotTexture();
  private readonly ring = ringTexture();
  private elapsed = 0;
  private readonly scale: number;

  constructor(rig: {
    group: THREE.Object3D;
    sockets: Record<string, THREE.Object3D>;
    bones: Record<string, THREE.Bone>;
  }, bounds: THREE.Box3) {
    this.group.name = 'monster-tree-vfx';
    this.scale = bounds.getSize(new THREE.Vector3()).y;

    this.spores = new SporeField(bounds, 340, this.dot);
    this.group.add(this.spores.object);

    this.eyes = new EyeGlow([rig.sockets['eye-l'], rig.sockets['eye-r']], this.dot, this.scale);
    this.group.add(this.eyes.object);

    this.core = new CoreGlow(rig.sockets['chest-core'], this.scale);

    const trailColour = lifeColour(0.5, 1);
    this.trails = {
      // 28 segments is roughly a quarter-second of history, which covers the fast part of a punch
      // without dragging the whole swing behind the fist. The width is a fraction of figure height
      // rather than an absolute: 0.024 puts the ribbon at about 9 cm across on a 1.9 m figure —
      // the width of the fist making it. Twice that reads as a painted stripe across the torso,
      // not a swing.
      'grip-l': new Trail(rig.sockets['grip-l'], 28, 0.024 * this.scale, trailColour),
      'grip-r': new Trail(rig.sockets['grip-r'], 28, 0.024 * this.scale, trailColour),
    };
    this.group.add(this.trails['grip-l'].object, this.trails['grip-r'].object);
    this.markAsOverlay();
  }

  /** A shockwave on the ground, centred under a socket rather than at a guessed origin. */
  shockwave(at: THREE.Object3D, radius = 1.1, duration = 0.85): void {
    const ring = new GroundRing(duration, radius * this.scale * 0.6, lifeColour(0.55, 1), this.ring);
    const world = new THREE.Vector3().setFromMatrixPosition(at.matrixWorld);
    ring.object.position.set(world.x, 0.012, world.z);
    this.group.add(ring.object);
    ring.object.userData.isHighlight = true;
    this.transient.push(ring);
  }

  /** A puff of motes at a socket. `spread` < 1 flattens it toward the ground. */
  burst(at: THREE.Object3D, options: { count?: number; speed?: number; duration?: number; spread?: number; gravity?: number; lightness?: number } = {}): void {
    const world = new THREE.Vector3().setFromMatrixPosition(at.matrixWorld);
    const burst = new Burst(
      world,
      options.count ?? 60,
      (options.speed ?? 1.1) * this.scale * 0.5,
      options.duration ?? 0.9,
      lifeColour(options.lightness ?? 0.6, 1),
      this.dot,
      (options.gravity ?? -1.6) * this.scale * 0.5,
      options.spread ?? 1,
      (Math.random() * 1e9) | 0,
    );
    this.group.add(burst.object);
    burst.object.userData.isHighlight = true;
    this.transient.push(burst);
  }

  /**
   * Mark every effect object as an overlay rather than a part of the model.
   *
   * The showcase's inspector treats any named mesh as a selectable part and as a raycast target, so
   * without this the Parts list fills up with `vfx:chest-core` and `vfx:trail:socket:grip-l` beside
   * the bark shell, and clicking the glow in front of the character's face selects the glow. An
   * additive halo is not a component of the treant, and `isHighlight` is exactly the flag the viewer
   * already uses for "an overlay that is not part of the model".
   */
  private markAsOverlay(): void {
    this.group.traverse((object) => {
      object.userData.isHighlight = true;
    });
  }

  update(dt: number): void {
    this.elapsed += dt;
    this.spores.tick(dt, this.elapsed);
    this.eyes.tick(dt, this.elapsed);
    this.core.tick(dt, this.elapsed);
    this.trails['grip-l'].tick(dt, this.elapsed);
    this.trails['grip-r'].tick(dt, this.elapsed);
    for (let i = this.transient.length - 1; i >= 0; i -= 1) {
      if (!this.transient[i].tick(dt, this.elapsed)) {
        this.group.remove(this.transient[i].object);
        (this.transient[i].object as THREE.Mesh).geometry?.dispose();
        this.transient.splice(i, 1);
      }
    }
  }

  /** How many transient effects are alive — surfaced in the showcase HUD. */
  get liveEffects(): number {
    return this.transient.length;
  }
}
