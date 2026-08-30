import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LIFE_HUE, LIFE_SATURATION, PALETTE } from './measured';
import { patchBarkSurface, type BarkSurface } from './bark';

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

/**
 * A ring of glyphs, painted once. Arcs, ticks and spokes at irregular angles read as script
 * without spelling anything — inventing a legible alphabet would be a claim the demo cannot back,
 * and a repeating one would read as a texture.
 */
function runeTexture(seed = 0x0d1e): THREE.Texture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const random = mulberry32(seed);
  const c = size / 2;
  ctx.strokeStyle = '#ffffff';
  ctx.lineCap = 'round';

  // Two hairline bounding circles for the band the glyphs sit in.
  for (const [r, w, a] of [[0.90, 2.5, 0.85], [0.74, 1.6, 0.55], [0.52, 1.2, 0.35]] as const) {
    ctx.globalAlpha = a;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.arc(c, c, c * r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Glyphs around the band.
  const glyphs = 34;
  for (let i = 0; i < glyphs; i += 1) {
    const angle = (i / glyphs) * Math.PI * 2;
    const rIn = c * 0.775;
    const rOut = c * 0.885;
    ctx.globalAlpha = 0.5 + random() * 0.5;
    ctx.lineWidth = 1.4 + random() * 2.2;
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate(angle);
    ctx.beginPath();
    const kind = Math.floor(random() * 3);
    if (kind === 0) {
      ctx.moveTo(rIn, 0);
      ctx.lineTo(rOut, 0);
      ctx.moveTo(rIn + (rOut - rIn) * 0.5, -c * 0.022);
      ctx.lineTo(rIn + (rOut - rIn) * 0.5, c * 0.022);
    } else if (kind === 1) {
      ctx.arc(0, 0, rIn + (rOut - rIn) * random(), -0.045, 0.045);
    } else {
      ctx.moveTo(rIn, -c * 0.018);
      ctx.lineTo(rOut, 0);
      ctx.lineTo(rIn, c * 0.018);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Spokes reaching into the middle, at irregular angles so the figure never looks like a dial.
  ctx.globalAlpha = 0.3;
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 9; i += 1) {
    const angle = random() * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(angle) * c * 0.52, c + Math.sin(angle) * c * 0.52);
    ctx.lineTo(c + Math.cos(angle) * c * 0.74, c + Math.sin(angle) * c * 0.74);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
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
    this.base = 0.38;
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
  private sampleClock = 0;
  private readonly view = new THREE.Vector3(0, 0, 1);
  /** Raised to 1 while the swing is live, then eased back so the ribbon dissolves behind the hand. */
  strength = 0;

  /**
   * How much the ribbon narrows along its length. 1 = a wedge that comes to a point, 0 = a band of
   * constant width that fades out on alpha alone.
   *
   * A swing trail wants a wedge — the fist is the wide end and the tail is where it came from. A
   * wisp wants the opposite: a LINE of light drawn through the air behind it. Tapered to a point
   * over a fast orbit it stops reading as a line at all and becomes a paper dart, which is exactly
   * what happened when the wisps were given the swing trail's profile.
   */
  private readonly taper: number;

  constructor(source: THREE.Object3D, segments: number, width: number, colour: THREE.Color, taper = 1) {
    this.source = source;
    this.width = width;
    this.taper = taper;
    this.history = Array.from({ length: segments }, () => new THREE.Vector3());

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segments * 6), 3));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(segments * 2), 1));
    // -1 and +1 on the two edges of every rib, so the fragment shader knows how far across the
    // ribbon it is. With only two vertices spanning the width this interpolates to a clean
    // gradient, which is all a soft edge needs.
    const side = new Float32Array(segments * 2);
    for (let i = 0; i < segments; i += 1) { side[i * 2] = -1; side[i * 2 + 1] = 1; }
    geometry.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
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
        attribute float aSide;
        varying float vAlpha;
        varying float vSide;
        void main() {
          vAlpha = aAlpha;
          vSide = aSide;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uColour;
        varying float vAlpha;
        varying float vSide;
        void main() {
          // Soft across the width with a hot core. A ribbon of flat colour with hard edges reads
          // as tape laid through the air; the falloff is what turns the same geometry into a line
          // of light.
          float across = 1.0 - abs(vSide);
          float body = pow(clamp(across, 0.0, 1.0), 0.85);
          float core = pow(clamp(across, 0.0, 1.0), 6.0);
          float a = vAlpha * body;
          if (a < 0.004) discard;
          gl_FragColor = vec4(uColour + core * 0.85, a);
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

    // Sampled on a FIXED timestep, not once per frame. Per-frame sampling makes the ribbon's
    // length depend on frame rate — the same trail spans a second at 45 fps and a third of one at
    // 135 — so the effect quietly changes shape on a faster machine.
    this.sampleClock += dt;
    let pushed = false;
    while (this.sampleClock >= TRAIL_STEP) {
      this.sampleClock -= TRAIL_STEP;
      this.head = (this.head + 1) % this.history.length;
      this.filled = Math.min(this.filled + 1, this.history.length);
      pushed = true;
    }
    void pushed;
    // The newest sample tracks the source every frame, so the ribbon's head never lags the sprite
    // it is trailing even between samples.
    this.history[(this.head - 1 + this.history.length) % this.history.length].copy(world);

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
      const narrow = 1 - this.taper * (1 - (1 - i / n) ** 1.4);
      offset.copy(side.normalize()).multiplyScalar(this.width * narrow * (i < this.filled ? 1 : 0));
      position.setXYZ(i * 2, p.x + offset.x, p.y + offset.y, p.z + offset.z);
      position.setXYZ(i * 2 + 1, p.x - offset.x, p.y - offset.y, p.z - offset.z);
      const a = i < this.filled ? (1 - i / n) ** (0.9 + this.taper * 1.5) * this.fade * 0.62 : 0;
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
/** One trail sample every 1/45 s: 45 samples is a second of history, whatever the frame rate. */
const TRAIL_STEP = 1 / 45;

const CONE_LOCAL = new THREE.Vector3();
const CONE_ROT = new THREE.Quaternion();
const CONE_AXIS = new THREE.Vector3(0, 0, 1);

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
    direction: THREE.Vector3 | null = null,
    cone = 0.5,
  ) {
    const random = mulberry32(seed);
    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    this.velocity = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      positions[i * 3] = origin.x;
      positions[i * 3 + 1] = origin.y;
      positions[i * 3 + 2] = origin.z;
      const v = speed * (0.35 + random() * 0.65);
      if (direction) {
        // A CONE about the given axis. Sampling cos(theta) uniformly between cos(cone) and 1 —
        // rather than sampling the angle — keeps the density even across the cap instead of
        // bunching it at the centre.
        const cosTheta = 1 - random() * (1 - Math.cos(cone));
        const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
        const phi = random() * Math.PI * 2;
        CONE_LOCAL.set(Math.cos(phi) * sinTheta, Math.sin(phi) * sinTheta, cosTheta);
        CONE_ROT.setFromUnitVectors(CONE_AXIS, direction);
        CONE_LOCAL.applyQuaternion(CONE_ROT).multiplyScalar(v);
        this.velocity[i * 3] = CONE_LOCAL.x;
        this.velocity[i * 3 + 1] = CONE_LOCAL.y;
        this.velocity[i * 3 + 2] = CONE_LOCAL.z;
      } else {
        // Uniform on a sphere, then squashed toward the horizontal by `spread`.
        const theta = random() * Math.PI * 2;
        const z = random() * 2 - 1;
        const r = Math.sqrt(1 - z * z);
        this.velocity[i * 3] = Math.cos(theta) * r * v;
        this.velocity[i * 3 + 1] = z * v * spread;
        this.velocity[i * 3 + 2] = Math.sin(theta) * r * v;
      }
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
 * Wisps: spirit lights that orbit the figure, each trailing its own tail.
 *
 * The ambient spore field says "alive". The wisps say "this thing is not only alive, something is
 * attending it" — they hold station around the character rather than drifting past, which is the
 * difference between atmosphere and presence.
 *
 * Each wisp rides its own Lissajous orbit: three sine terms at incommensurable rates, so a wisp
 * never retraces the same path and no two of them fall into step. Their trails reuse `Trail`,
 * sourced from a bare Object3D that this class moves, which is exactly what `Trail` already wants
 * — it only ever reads `source.matrixWorld`.
 */
class Wisps implements Tickable {
  readonly object: THREE.Group;
  private readonly nodes: THREE.Object3D[] = [];
  private readonly sprites: THREE.Sprite[] = [];
  private readonly trails: Trail[] = [];
  private readonly phase: number[] = [];
  private readonly rate: number[] = [];
  private readonly light: THREE.PointLight;
  private readonly centre: THREE.Vector3;
  private readonly radius: number;
  private readonly height: number;
  /** Raised while a power gathers: the wisps pull in and brighten. */
  gather = 0;

  constructor(bounds: THREE.Box3, count: number, texture: THREE.Texture) {
    this.object = new THREE.Group();
    this.object.name = 'vfx:wisps';
    const size = bounds.getSize(new THREE.Vector3());
    this.centre = bounds.getCenter(new THREE.Vector3());
    // Half the arm span, not most of it. The ribbons are meant to travel AROUND the body; at the
    // wider radius the long tail swings clear of the figure entirely and the line stops being
    // attached to anything.
    this.radius = Math.max(size.x, size.z) * 0.42;
    this.height = size.y;

    const random = mulberry32(0x5115);
    for (let i = 0; i < count; i += 1) {
      const node = new THREE.Object3D();
      node.name = `vfx:wisp:${i}`;
      this.object.add(node);
      this.nodes.push(node);

      // Alternate the two ends of the measured eye ramp so the swarm has cool and hot members
      // rather than one flat colour.
      const hot = i % 3 === 0;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: texture,
        color: lifeColour(hot ? 0.62 : 0.44, 1),
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }));
      sprite.scale.setScalar(this.height * (hot ? 0.030 : 0.021));
      node.add(sprite);
      this.sprites.push(sprite);

      // LONG and THIN — this is the effect, not a garnish on the sprite. 80 samples at 45 Hz is
      // roughly 1.8 seconds of orbit, which is a long enough arc that the ribbon reads as a curved
      // line of light travelling around the body. Too short and it does not matter how wide or
      // bright it is: the tail spans only a few degrees of the orbit, comes out straight, and
      // draws as a bar floating beside the character.
      const trail = new Trail(node, 64, this.height * 0.0060, lifeColour(0.42, 1), 0.35);
      trail.strength = 1;
      this.object.add(trail.object);
      this.trails.push(trail);

      this.phase.push(random() * Math.PI * 2);
      // Slower orbits. The ribbon has to be legible as a CURVE as it goes round; at the old rate
      // a half-second tail was flung out into something closer to a straight streak.
      this.rate.push(0.46 + random() * 0.34);
    }

    // One shared light for the whole swarm. Seven point lights would each cost a forward-render
    // pass over every lit fragment; one that rides the brightest wisp reads the same on screen.
    this.light = new THREE.PointLight(lifeColour(0.5, 1), 0.9, this.height * 0.9, 2);
    this.object.add(this.light);
  }

  tick(dt: number, elapsed: number): boolean {
    const pull = 1 - this.gather * 0.55;
    for (let i = 0; i < this.nodes.length; i += 1) {
      const t = elapsed * this.rate[i] + this.phase[i];
      const r = this.radius * pull * (0.72 + 0.28 * Math.sin(t * 0.73));
      this.nodes[i].position.set(
        this.centre.x + Math.cos(t) * r,
        this.centre.y + Math.sin(t * 1.31 + this.phase[i]) * this.height * 0.34 + this.height * 0.06,
        this.centre.z + Math.sin(t * 0.91) * r,
      );
      // A small fast wobble across the orbit. Without it the path is a clean Lissajous ellipse and
      // the ribbon is a smooth arc; with it the line undulates as it travels, which is what makes
      // it read as alive rather than as a wire hoop around the figure.
      const ripple = Math.sin(t * 6.3 + this.phase[i]) * this.height * 0.035;
      this.nodes[i].position.y += ripple;
      this.nodes[i].position.x += Math.cos(t * 5.1 + this.phase[i]) * this.height * 0.022;

      const flicker = 0.75 + 0.25 * Math.sin(elapsed * 3.1 + this.phase[i] * 2.0);
      this.sprites[i].material.opacity = flicker * (0.7 + this.gather * 0.5);
    }
    for (const trail of this.trails) trail.tick(dt, elapsed);
    this.light.position.copy(this.nodes[0].position);
    this.light.intensity = 1.4 + this.gather * 3.0;
    return true;
  }
}

/**
 * A rune circle: two counter-rotating glyph rings that bloom out of the ground and fade.
 *
 * This replaces a plain expanding ring for anything deliberate — a cast, a stomp. A ring says
 * "impact"; a ring with turning script in it says the impact was *called for*. The glyphs are
 * drawn into a canvas once at construction: arcs, ticks and radial spokes at irregular angles, so
 * they read as writing without being any real alphabet.
 */
class RuneCircle implements Tickable {
  readonly object: THREE.Group;
  private readonly inner: THREE.Mesh;
  private readonly outer: THREE.Mesh;
  private age = 0;

  constructor(
    private readonly duration: number,
    private readonly maxRadius: number,
    colour: THREE.Color,
    runeTexture: THREE.Texture,
    ringTexture: THREE.Texture,
  ) {
    this.object = new THREE.Group();
    this.object.name = 'vfx:rune-circle';
    this.object.rotation.x = -Math.PI / 2;

    const make = (map: THREE.Texture, opacity: number): THREE.Mesh => {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          map,
          color: colour,
          transparent: true,
          opacity,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        }),
      );
      mesh.renderOrder = 2;
      return mesh;
    };
    this.outer = make(runeTexture, 1);
    this.inner = make(ringTexture, 1);
    this.object.add(this.outer, this.inner);
  }

  tick(dt: number): boolean {
    this.age += dt;
    const t = this.age / this.duration;
    if (t >= 1) return false;
    // Snap open, then hold and fade — a rune circle is inscribed, not blown outward.
    const open = 1 - (1 - Math.min(t * 2.2, 1)) ** 3;
    const fade = t < 0.35 ? 1 : 1 - (t - 0.35) / 0.65;
    const r = this.maxRadius * open;
    this.outer.scale.set(r * 2, r * 2, 1);
    this.inner.scale.set(r * 1.35, r * 1.35, 1);
    this.outer.rotation.z += dt * 0.55;
    this.inner.rotation.z -= dt * 0.9;
    (this.outer.material as THREE.MeshBasicMaterial).opacity = fade * 0.95;
    (this.inner.material as THREE.MeshBasicMaterial).opacity = fade * 0.7;
    return true;
  }
}

/**
 * Roots that tear up out of the ground: forking branches built to the character's own proportions.
 *
 * The first version of this was a ring of plain tapered tubes with a green emissive, and it read
 * as lime drinking straws standing in the dirt — nothing to do with the figure they came from.
 * What makes a shape read as a ROOT is not that it is thin and pointed: it is that it FLARES where
 * it meets the ground, tapers as it rises, bends more than once, and FORKS.
 *
 * All four come from the mesh. The character's own trunk was measured for its taper — median
 * radius 0.078 at the foot flare falling to 0.037 at the top of the leg, so a root's base is
 * roughly twice its tip — and its shins for how far branch spurs stand off a limb, which is 2.1x
 * the limb radius. Those two numbers set `FLARE_RATIO` and how far a fork diverges.
 *
 * The geometry is a chain of tapered cylinders following a gnarled curve, forking twice, merged
 * into ONE buffer so an eruption of eight roots is one draw call rather than sixty. They carry an
 * `aGrain` attribute like the shell does — each vertex holds its own segment's axis — so the same
 * bark shader runs on them and the grain flows along each branch exactly as it flows along an arm.
 */
const FLARE_RATIO = 0.078 / 0.037;   // measured: trunk base radius over trunk top radius

/** One tapered cylinder, oriented from `a` to `b`, with grain running along its axis. */
function taperedSegment(a: THREE.Vector3, b: THREE.Vector3, rA: number, rB: number): THREE.BufferGeometry {
  const axis = new THREE.Vector3().subVectors(b, a);
  const length = axis.length();
  if (length < 1e-6) return new THREE.BufferGeometry();
  const geometry = new THREE.CylinderGeometry(rB, rA, length, 7, 1, true);
  // CylinderGeometry is built along +Y about its centre; stand it between the two points.
  const quaternion = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0), axis.clone().normalize(),
  );
  geometry.applyMatrix4(new THREE.Matrix4().compose(
    new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5),
    quaternion,
    new THREE.Vector3(1, 1, 1),
  ));
  const count = geometry.attributes.position.count;
  const grain = new Float32Array(count * 3);
  const unit = axis.normalize();
  for (let i = 0; i < count; i += 1) {
    grain[i * 3] = unit.x;
    grain[i * 3 + 1] = unit.y;
    grain[i * 3 + 2] = unit.z;
  }
  geometry.setAttribute('aGrain', new THREE.BufferAttribute(grain, 3));
  return geometry;
}

/** Grow one branch and its forks, returning every segment's geometry. */
function growBranch(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  length: number,
  baseRadius: number,
  depth: number,
  random: () => number,
  out: THREE.BufferGeometry[],
): void {
  const steps = depth === 2 ? 5 : 3;
  let point = origin.clone();
  let heading = direction.clone().normalize();
  const forkAt = 1 + Math.floor(random() * (steps - 1));

  for (let i = 0; i < steps; i += 1) {
    const t0 = i / steps;
    const t1 = (i + 1) / steps;
    // Taper from a flared base to a fine tip, on the trunk's own measured ratio.
    const r0 = baseRadius * (1 - t0 * (1 - 1 / FLARE_RATIO));
    const r1 = baseRadius * (1 - t1 * (1 - 1 / FLARE_RATIO));

    // Gnarl: the heading wanders every step, so no segment continues the last one exactly.
    // Gentle wander. At twice this the segments zigzag and the branch reads as bent wire rather
    // than as something that grew.
    heading = heading.clone().add(new THREE.Vector3(
      (random() - 0.5) * 0.28,
      (random() - 0.5) * 0.16,
      (random() - 0.5) * 0.28,
    )).normalize();

    const next = point.clone().addScaledVector(heading, length / steps);
    out.push(taperedSegment(point, next, r0, r1));

    if (depth > 0 && i === forkAt) {
      // A fork leaves at a wide angle — the measured spur stands 2.1x its limb's radius off the
      // axis, which is a branch leaving at roughly 40 degrees, not a twig hugging the trunk.
      const side = new THREE.Vector3(random() - 0.5, random() * 0.35, random() - 0.5).normalize();
      const forkDir = heading.clone().multiplyScalar(0.80).addScaledVector(side, 0.52).normalize();
      growBranch(next, forkDir, length * (0.42 + random() * 0.2), r1 * 0.72, depth - 1, random, out);
    }
    point = next;
  }
}

class RootEruption implements Tickable {
  readonly object: THREE.Group;
  private readonly roots: Array<{ mesh: THREE.Mesh; delay: number }> = [];
  private age = 0;

  constructor(
    origin: THREE.Vector3,
    count: number,
    spread: number,
    scale: number,
    private readonly duration: number,
    seed: number,
    material: THREE.Material,
  ) {
    this.object = new THREE.Group();
    this.object.name = 'vfx:root-eruption';
    const random = mulberry32(seed);

    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2 + random() * 0.7;
      const dist = spread * (0.35 + random() * 0.6);
      const length = scale * (0.10 + random() * 0.11);
      // Lean outward, away from the impact — the ground is being pushed up and apart.
      const lean = new THREE.Vector3(Math.cos(angle) * 0.42, 1, Math.sin(angle) * 0.42).normalize();

      const parts: THREE.BufferGeometry[] = [];
      growBranch(new THREE.Vector3(), lean, length, scale * 0.019, 2, random, parts);
      const geometry = mergeGeometries(parts);
      for (const g of parts) g.dispose();
      if (!geometry) continue;

      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(origin.x + Math.cos(angle) * dist, -length * 0.15, origin.z + Math.sin(angle) * dist);
      mesh.rotation.y = random() * Math.PI * 2;
      mesh.scale.setScalar(0.001);
      mesh.visible = false;
      mesh.castShadow = true;
      this.object.add(mesh);
      this.roots.push({ mesh, delay: random() * 0.22 });
    }
  }

  tick(dt: number): boolean {
    this.age += dt;
    if (this.age >= this.duration) return false;
    for (const root of this.roots) {
      const local = (this.age - root.delay) / (this.duration - root.delay);
      if (local <= 0) continue;
      root.mesh.visible = true;
      // Out fast, back slowly — the ground breaks in an instant and settles over half a second.
      // Scaled UNIFORMLY: squashing y alone would flatten the forks against the ground and undo
      // the branching that makes the shape a root at all.
      const rise = local < 0.26 ? 1 - (1 - local / 0.26) ** 3 : 1 - ((local - 0.26) / 0.74) ** 2;
      root.mesh.scale.setScalar(Math.max(0.001, rise));
    }
    return true;
  }
}

/**
 * Ground mist. A single large plane just above the floor, its alpha driven by two scrolling noise
 * fields so the fog curls instead of sliding. Cheap, and it does most of the work of putting the
 * figure in a place rather than on a backdrop.
 */
class GroundMist implements Tickable {
  readonly object: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;

  constructor(radius: number, colour: THREE.Color) {
    this.material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uColour: { value: colour } },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform float uTime;
        uniform vec3 uColour;
        varying vec2 vUv;
        float mHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float mNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mHash(i), mHash(i + vec2(1,0)), f.x),
                     mix(mHash(i + vec2(0,1)), mHash(i + vec2(1,1)), f.x), f.y);
        }
        void main() {
          vec2 p = vUv * 6.0;
          // Two fields at different rates and directions — one alone reads as a sliding texture.
          float n = mNoise(p + vec2(uTime * 0.045, uTime * 0.02));
          n = mix(n, mNoise(p * 2.3 - vec2(uTime * 0.03, uTime * 0.05)), 0.5);
          float edge = 1.0 - smoothstep(0.18, 0.5, distance(vUv, vec2(0.5)));
          float a = smoothstep(0.42, 0.86, n) * edge * 0.5;
          if (a < 0.004) discard;
          gl_FragColor = vec4(uColour, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.object = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * 2), this.material);
    this.object.name = 'vfx:ground-mist';
    this.object.rotation.x = -Math.PI / 2;
    this.object.position.y = 0.02;
    this.object.renderOrder = 1;
  }

  tick(_dt: number, elapsed: number): boolean {
    this.material.uniforms.uTime.value = elapsed;
    return true;
  }
}

/**
 * Canopy shafts: soft angled slabs of light from above, as though the figure were standing under a
 * broken forest roof. They drift and breathe on separate phases so the light never sits still.
 *
 * Front-side only and additive, so they brighten whatever is behind them and never occlude.
 */
class LightShafts implements Tickable {
  readonly object: THREE.Group;
  private readonly shafts: Array<{ mesh: THREE.Mesh; phase: number }> = [];

  constructor(count: number, height: number, colour: THREE.Color, seed: number) {
    this.object = new THREE.Group();
    this.object.name = 'vfx:canopy-shafts';
    const random = mulberry32(seed);
    const material = new THREE.ShaderMaterial({
      uniforms: { uColour: { value: colour }, uOpacity: { value: 1 } },
      vertexShader: `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform vec3 uColour; uniform float uOpacity;
        varying vec2 vUv;
        void main() {
          // Soft across the width, and fading out toward the floor where a real shaft disperses.
          float across = 1.0 - abs(vUv.x - 0.5) * 2.0;
          across = pow(clamp(across, 0.0, 1.0), 1.8);
          float down = smoothstep(0.0, 0.45, vUv.y) * (1.0 - smoothstep(0.55, 1.0, vUv.y) * 0.55);
          float a = across * down * 0.16 * uOpacity;
          if (a < 0.003) discard;
          gl_FragColor = vec4(uColour, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    for (let i = 0; i < count; i += 1) {
      const w = height * (0.16 + random() * 0.2);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, height * 2.1), material.clone());
      const angle = (i / count) * Math.PI * 2 + random();
      const dist = height * (0.2 + random() * 0.5);
      mesh.position.set(Math.cos(angle) * dist, height * 0.95, Math.sin(angle) * dist);
      mesh.rotation.set(random() * 0.24 - 0.12, angle + Math.PI / 2, random() * 0.3 - 0.15);
      this.object.add(mesh);
      this.shafts.push({ mesh, phase: random() * Math.PI * 2 });
    }
  }

  tick(_dt: number, elapsed: number): boolean {
    for (const shaft of this.shafts) {
      const m = shaft.mesh.material as THREE.ShaderMaterial;
      m.uniforms.uOpacity.value = 0.6 + 0.4 * Math.sin(elapsed * 0.34 + shaft.phase);
      shaft.mesh.rotation.z += Math.sin(elapsed * 0.15 + shaft.phase) * 0.00035;
    }
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
  /** The bark surface treatment — grain relief, cavity, moss and sap. Null if unpatched. */
  readonly veins: BarkSurface | null;
  readonly wisps: Wisps;
  private readonly spores: SporeField;
  private readonly mist: GroundMist;
  private readonly shafts: LightShafts;
  private readonly transient: Tickable[] = [];
  private readonly dot = dotTexture();
  private readonly ring = ringTexture();
  private readonly runes = runeTexture();
  /**
   * The roots' own bark. A separate material from the shell's — it needs no skinning and no vertex
   * colours — but patched by the SAME `patchBarkSurface`, so the grain, the cavity shading and the
   * sap all run on the erupting branches exactly as they do on the figure. That is what makes them
   * read as the character's wood coming up through the floor rather than as props placed near it.
   */
  private readonly rootMaterial: THREE.MeshStandardMaterial;
  private readonly rootBark: BarkSurface;
  private elapsed = 0;
  private readonly scale: number;
  /** 0 = dormant, 1 = a power fully gathered. Drives veins, wisps and the chest core together. */
  private chargeLevel = 0;

  constructor(rig: {
    group: THREE.Object3D;
    sockets: Record<string, THREE.Object3D>;
    bones: Record<string, THREE.Bone>;
    shell?: THREE.Mesh;
  }, bounds: THREE.Box3) {
    this.group.name = 'monster-tree-vfx';
    this.scale = bounds.getSize(new THREE.Vector3()).y;

    // Grain, relief, cavity, moss and sap, all on the shell's own material. Patched rather than
    // replaced so it keeps three's skinning and PBR lighting; `veins.injected` reports whether the
    // injection actually landed rather than leaving it to be assumed.
    const shellMaterial = rig.shell?.material;
    this.veins = shellMaterial instanceof THREE.MeshStandardMaterial ? patchBarkSurface(shellMaterial) : null;

    this.rootMaterial = new THREE.MeshStandardMaterial({
      // barkLIGHT, not barkMid. These are lit only by the rim and whatever the ground bounces, so
      // at the trunk's own mid tone they come up as black cut-outs against a dark floor. The
      // brighter tone is what lets the shape read at all.
      color: new THREE.Color(PALETTE.barkLight).convertSRGBToLinear(),
      roughness: 0.9,
      metalness: 0,
    });
    this.rootBark = patchBarkSurface(this.rootMaterial);

    this.spores = new SporeField(bounds, 340, this.dot);
    this.group.add(this.spores.object);

    this.wisps = new Wisps(bounds, 6, this.dot);
    this.group.add(this.wisps.object);

    this.mist = new GroundMist(this.scale * 1.7, lifeColour(0.20, 0.62));
    this.group.add(this.mist.object);

    this.shafts = new LightShafts(5, this.scale, lifeColour(0.54, 0.44), 0x5a71);
    this.group.add(this.shafts.object);

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

  /**
   * Gather or release a power, everywhere at once.
   *
   * The chest core, the sap veins and the wisps are one event seen three ways, so they take one
   * number. Driving them separately from the skill table is how they drift out of step.
   */
  set charge(value: number) {
    this.chargeLevel = value;
    this.core.charge = value;
    this.wisps.gather = value;
    this.veins?.setCharge(value);
    this.rootBark.setCharge(value);
  }

  get charge(): number {
    return this.chargeLevel;
  }

  /** A rune circle inscribed on the ground under a socket — for anything deliberate. */
  runeCircle(at: THREE.Object3D, radius = 1.2, duration = 1.5): void {
    const circle = new RuneCircle(duration, radius * this.scale * 0.62, lifeColour(0.55, 1), this.runes, this.ring);
    const world = new THREE.Vector3().setFromMatrixPosition(at.matrixWorld);
    circle.object.position.set(world.x, 0.016, world.z);
    circle.object.traverse((o) => { o.userData.isHighlight = true; });
    this.group.add(circle.object);
    this.transient.push(circle);
  }

  /** Roots torn up out of the ground around a socket. */
  roots(at: THREE.Object3D, options: { count?: number; spread?: number; duration?: number } = {}): void {
    const world = new THREE.Vector3().setFromMatrixPosition(at.matrixWorld);
    const eruption = new RootEruption(
      world,
      options.count ?? 8,
      (options.spread ?? 0.30) * this.scale,
      this.scale,
      options.duration ?? 1.1,
      (Math.random() * 1e9) | 0,
      this.rootMaterial,
    );
    eruption.object.traverse((o) => { o.userData.isHighlight = true; });
    this.group.add(eruption.object);
    this.transient.push(eruption);
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

  /**
   * A puff of motes at a socket.
   *
   * Pass `direction` to fire it as a CONE instead of a ball. A cast thrown out of an open hand
   * that sprays evenly in every direction reads as an explosion at the wrist, not as something the
   * character aimed — the motes go backwards through the forearm as readily as forwards. The
   * direction to use is never a constant: see `aim`, which reads it off the arm's own bones.
   */
  burst(at: THREE.Object3D, options: {
    count?: number; speed?: number; duration?: number; spread?: number;
    gravity?: number; lightness?: number; direction?: THREE.Vector3 | null; cone?: number;
  } = {}): void {
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
      options.direction ?? null,
      options.cone ?? 0.5,
    );
    this.group.add(burst.object);
    burst.object.userData.isHighlight = true;
    this.transient.push(burst);
  }

  /**
   * Mark every effect object as an overlay rather than a part of the model.
   *
   * The showcase's inspector treats any named mesh as a selectable part AND as a raycast target,
   * so without this the Parts list fills with `vfx:chest-core` and `vfx:trail:vfx:wisp:0` beside
   * the bark shell, and clicking the glow in front of the character's face selects the glow. A
   * wisp is not a component of the treant. `isHighlight` is the flag the viewer already uses for
   * "an overlay that is not part of the model", which is exactly what every object here is.
   *
   * Called at the end of the constructor, so it covers everything parented under `group`;
   * anything attached to a BONE instead (the eye sprites, the chest core) marks itself where it
   * is built, and the transient effects mark themselves as they are spawned.
   */
  private markAsOverlay(): void {
    this.group.traverse((object) => {
      object.userData.isHighlight = true;
    });
  }

  update(dt: number): void {
    this.elapsed += dt;
    this.veins?.setTime(this.elapsed);
    this.rootBark.setTime(this.elapsed);
    this.spores.tick(dt, this.elapsed);
    this.wisps.tick(dt, this.elapsed);
    this.mist.tick(dt, this.elapsed);
    this.shafts.tick(dt, this.elapsed);
    this.eyes.tick(dt, this.elapsed);
    this.core.tick(dt, this.elapsed);
    this.trails['grip-l'].tick(dt, this.elapsed);
    this.trails['grip-r'].tick(dt, this.elapsed);
    for (let i = this.transient.length - 1; i >= 0; i -= 1) {
      if (!this.transient[i].tick(dt, this.elapsed)) {
        const dead = this.transient[i].object;
        this.group.remove(dead);
        // Each eruption merges its own buffer, so the geometry has to go with it; a group only
        // carries geometry on its children.
        dead.traverse((o) => { (o as THREE.Mesh).geometry?.dispose(); });
        this.transient.splice(i, 1);
      }
    }
  }

  /** How many transient effects are alive — surfaced in the showcase HUD. */
  get liveEffects(): number {
    return this.transient.length;
  }
}
