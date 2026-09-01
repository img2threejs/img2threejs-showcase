import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ALBEDO_WHITE_BALANCE, LIFE_HUE, LIFE_SATURATION, PALETTE } from './measured';
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

/**
 * A leaf: a pointed blade with a midrib, painted once.
 *
 * The ambient field was round dots, which read as fireflies — fine anywhere, and nothing to do
 * with a forest. Mixing leaves into it is what makes the air around the character feel like
 * something is shedding into it.
 */
function leafTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const c = size / 2;
  const grad = ctx.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0, 'rgba(255,255,255,0.15)');
  grad.addColorStop(0.5, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0.15)');
  ctx.fillStyle = grad;
  // Two mirrored curves meeting at a point each end — a lanceolate blade.
  ctx.beginPath();
  ctx.moveTo(c, 3);
  ctx.quadraticCurveTo(size - 7, c, c, size - 3);
  ctx.quadraticCurveTo(7, c, c, 3);
  ctx.fill();
  // The midrib, which is what makes it read as a leaf rather than as a lens flare.
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(c, 5);
  ctx.lineTo(c, size - 5);
  ctx.stroke();
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

/** How many ten-second effects may be alive at once before the oldest is retired. */
const MAX_LINGERING = 5;

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

  constructor(bounds: THREE.Box3, count: number, texture: THREE.Texture, leaf: THREE.Texture) {
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

    // Which motes are leaves, and how fast each one turns. Roughly a third: all leaves reads as
    // falling litter, none reads as fireflies, and the mix reads as a wood.
    const kind = new Float32Array(count);
    const spin = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      kind[i] = this.random() < 0.34 ? 1 : 0;
      spin[i] = (this.random() - 0.5) * 2.4;
      if (kind[i] > 0.5) sizes[i] *= 2.1;   // a leaf has to be bigger than a spark to read at all
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('aKind', new THREE.BufferAttribute(kind, 1));
    geometry.setAttribute('aSpin', new THREE.BufferAttribute(spin, 1));

    const material = new THREE.ShaderMaterial({
      uniforms: { map: { value: texture }, leafMap: { value: leaf }, uTime: { value: 0 }, opacity: { value: 1 } },
      vertexShader: `
        attribute float size;
        attribute float aKind;
        attribute float aSpin;
        varying vec3 vColour;
        varying float vFade;
        varying float vKind;
        varying float vSpin;
        void main() {
          vColour = color;
          vKind = aKind;
          vSpin = aSpin;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          // Fade with distance so the far side of the field does not read as noise over the figure.
          vFade = clamp(1.0 - (-mv.z - 2.0) / 8.0, 0.15, 1.0);
          gl_PointSize = size * 320.0 / max(-mv.z, 0.001);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D map;
        uniform sampler2D leafMap;
        uniform float uTime;
        uniform float opacity;
        varying vec3 vColour;
        varying float vFade;
        varying float vKind;
        varying float vSpin;
        void main() {
          float a;
          if (vKind > 0.5) {
            // Leaves turn as they fall. Rotating the point's own coordinate is the whole trick —
            // a point sprite has no orientation of its own, so a static leaf texture reads as a
            // decal pinned to the screen rather than as something tumbling through the air.
            float ang = uTime * vSpin;
            float s = sin(ang), c = cos(ang);
            vec2 uv = gl_PointCoord - 0.5;
            uv = vec2(uv.x * c - uv.y * s, uv.x * s + uv.y * c) + 0.5;
            if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
            // Flatten it edge-on periodically, so a leaf turns through its own plane.
            float edge = abs(sin(ang * 0.5));
            a = texture2D(leafMap, uv).a * (0.25 + 0.75 * edge);
          } else {
            a = texture2D(map, gl_PointCoord).a;
          }
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
    (this.object.material as THREE.ShaderMaterial).uniforms.uTime.value = elapsed;
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
    // -1 and +1 on the two edges of every rib, and 0..1 along the length. With two vertices across
    // the width these interpolate to clean gradients, which is all the fragment shader needs to
    // shade the ribbon as a volume instead of a flat band.
    const side = new Float32Array(segments * 2);
    const along = new Float32Array(segments * 2);
    for (let i = 0; i < segments; i += 1) {
      side[i * 2] = -1; side[i * 2 + 1] = 1;
      along[i * 2] = i / segments; along[i * 2 + 1] = i / segments;
    }
    geometry.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    geometry.setAttribute('aAlong', new THREE.BufferAttribute(along, 1));
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
      uniforms: {
        uColour: { value: colour },
        uEmber: { value: new THREE.Color(PALETTE.eyeCore).convertSRGBToLinear() },
        uAsh: { value: new THREE.Color(PALETTE.barkDark).convertSRGBToLinear() },
        uTime: { value: 0 },
      },
      vertexShader: `
        attribute float aAlpha;
        attribute float aSide;
        attribute float aAlong;
        varying float vAlpha;
        varying float vSide;
        varying float vAlong;
        void main() {
          vAlpha = aAlpha;
          vSide = aSide;
          vAlong = aAlong;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uColour; uniform vec3 uEmber; uniform vec3 uAsh; uniform float uTime;
        varying float vAlpha;
        varying float vSide;
        varying float vAlong;
        float sHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float sNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(sHash(i), sHash(i + vec2(1,0)), f.x),
                     mix(sHash(i + vec2(0,1)), sHash(i + vec2(1,1)), f.x), f.y);
        }
        void main() {
          float across = clamp(1.0 - abs(vSide), 0.0, 1.0);

          // A HOT CORE inside a soft body. A single flat colour across the width is what makes a
          // trail read as a strip of tape; a bright thin centre falling away to nothing reads as
          // something burning through the air.
          float body = pow(across, 1.1);
          float core = pow(across, 7.0);

          // Break the edge up. Real embers do not have a clean outline, and a mathematically
          // perfect ribbon is the single strongest tell that a trail was drawn rather than shed.
          float grain = sNoise(vec2(vAlong * 34.0, vSide * 3.0 + uTime * 1.7));
          body *= 0.62 + 0.38 * grain;
          // Tear holes in the tail, where a real trail is already coming apart.
          body *= smoothstep(0.0, 0.35, 1.0 - vAlong) + 0.25;

          // Cools along its length: near-white at the fist, the sap green behind it, ash at the
          // tail. One colour end to end is the other half of why a trail looks like a light streak.
          vec3 colour = mix(uEmber, uColour, smoothstep(0.0, 0.32, vAlong));
          colour = mix(colour, uAsh, smoothstep(0.45, 1.0, vAlong));
          colour += core * 1.4;

          float a = vAlpha * body;
          if (a < 0.004) discard;
          gl_FragColor = vec4(colour, a);
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

  tick(dt: number, elapsed: number): boolean {
    (this.object.material as THREE.ShaderMaterial).uniforms.uTime.value = elapsed;
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
      offset.copy(side.normalize()).multiplyScalar(this.width * (1 - i / n) ** 0.7 * (i < this.filled ? 1 : 0));
      position.setXYZ(i * 2, p.x + offset.x, p.y + offset.y, p.z + offset.z);
      position.setXYZ(i * 2 + 1, p.x - offset.x, p.y - offset.y, p.z - offset.z);
      const a = i < this.filled ? (1 - i / n) ** 1.5 * this.fade * 0.95 : 0;
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
    this.radius = Math.max(size.x, size.z) * 0.78;
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

      // Hair-thin and SHORT. A wisp tail tapers from full width at the head to nothing at the
      // tail, so any real width turns a fast-moving orbit into a paper dart. Length matters just
      // as much: at 14 segments the orbit outruns the taper and the tail draws as a straight
      // bright scratch across the frame rather than a comet falling off behind the head.
      const trail = new Trail(node, 8, this.height * 0.0032, lifeColour(0.40, 1));
      trail.strength = 1;
      this.object.add(trail.object);
      this.trails.push(trail);

      this.phase.push(random() * Math.PI * 2);
      this.rate.push(0.62 + random() * 0.62);
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
 * Roots that tear up out of the ground and sink back.
 *
 * The one effect here that is real geometry rather than a billboard, because a shockwave you can
 * see the far side of is what makes a stomp feel like it moved earth. Each root is a tapered,
 * slightly bent tube on its own delay, so they erupt as a ragged burst rather than a fence.
 */
class RootEruption implements Tickable {
  readonly object: THREE.Group;
  private readonly roots: Array<{ mesh: THREE.Mesh; delay: number; full: number }> = [];
  private age = 0;

  constructor(origin: THREE.Vector3, count: number, spread: number, scale: number, private readonly duration: number, seed: number) {
    this.object = new THREE.Group();
    this.object.name = 'vfx:root-eruption';
    const random = mulberry32(seed);
    // Bark-dark and unlit-ish: the roots read as silhouette against the glow, which is what keeps
    // the effect from turning into another green blob.
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(PALETTE.barkDark).convertSRGBToLinear(),
      roughness: 0.95,
      metalness: 0,
      // Barely lit. A root is wet earth and dark wood catching the glow around it, not a neon
      // tube — at any real emissive the burst reads as lime plastic rather than torn ground.
      // Almost unlit. The stage key is 7.0 and both the fill and the rim are green, so a root with
      // any emissive at all comes back lime and matte — plastic straws standing round the figure
      // instead of earth torn open. It should read as silhouette with the glow behind it.
      emissive: lifeColour(0.03, 0.8),
      emissiveIntensity: 0.5,
    });

    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2 + random() * 0.7;
      const dist = spread * (0.35 + random() * 0.6);
      const full = scale * (0.09 + random() * 0.13);
      // A three-point curve gives the root a natural lean instead of a spike.
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3((random() - 0.5) * full * 0.4, full * 0.55, (random() - 0.5) * full * 0.4),
        new THREE.Vector3((random() - 0.5) * full * 0.9, full, (random() - 0.5) * full * 0.9),
      ]);
      const geometry = new THREE.TubeGeometry(curve, 6, full * 0.06, 5, false);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(origin.x + Math.cos(angle) * dist, 0, origin.z + Math.sin(angle) * dist);
      mesh.rotation.y = random() * Math.PI * 2;
      mesh.scale.y = 0.001;
      // Hidden until its own delay elapses. A root squashed flat against the floor still
      // rasterises, and a tube at zero height reads as a bright plate lying on the ground —
      // which is the entire effect, ruined, for the first fifth of a second.
      mesh.visible = false;
      mesh.castShadow = true;
      this.object.add(mesh);
      this.roots.push({ mesh, delay: random() * 0.22, full });
    }
  }

  tick(dt: number): boolean {
    this.age += dt;
    if (this.age >= this.duration) return false;
    for (const root of this.roots) {
      const local = (this.age - root.delay) / (this.duration - root.delay);
      if (local <= 0) continue;
      root.mesh.visible = true;
      // Out fast, back slowly: the ground breaks in an instant and settles over half a second.
      const rise = local < 0.28 ? 1 - (1 - local / 0.28) ** 3 : 1 - ((local - 0.28) / 0.72) ** 2;
      root.mesh.scale.y = Math.max(0.001, rise);
    }
    return true;
  }
}

/**
 * A fissure pattern, painted once: a few trunks radiating from the centre, each forking down to
 * hairlines. The same recursive shape a real crack makes as it relieves stress, and it is drawn
 * rather than modelled because a crack has no thickness worth giving geometry to.
 */
function crackTexture(seed = 0xcac): THREE.Texture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const random = mulberry32(seed);
  const c = size / 2;
  ctx.strokeStyle = '#ffffff';
  ctx.lineCap = 'round';

  const walk = (x: number, y: number, angle: number, length: number, width: number, depth: number): void => {
    if (depth <= 0 || length < 4) return;
    const steps = 4;
    let px = x;
    let py = y;
    let heading = angle;
    ctx.lineWidth = width;
    ctx.globalAlpha = Math.min(1, 0.35 + width * 0.32);
    ctx.beginPath();
    ctx.moveTo(px, py);
    for (let i = 0; i < steps; i += 1) {
      // A crack never runs straight; it jinks as it finds the weakest path.
      heading += (random() - 0.5) * 0.55;
      px += Math.cos(heading) * (length / steps);
      py += Math.sin(heading) * (length / steps);
      ctx.lineTo(px, py);
    }
    ctx.stroke();
    // Fork, and keep forking: one branch carries on, a second leaves at a wide angle.
    walk(px, py, heading + (random() - 0.5) * 0.4, length * 0.62, width * 0.62, depth - 1);
    if (random() < 0.75) {
      walk(px, py, heading + (random() < 0.5 ? -1 : 1) * (0.5 + random() * 0.6),
        length * 0.5, width * 0.5, depth - 1);
    }
  };

  const trunks = 7;
  for (let i = 0; i < trunks; i += 1) {
    walk(c, c, (i / trunks) * Math.PI * 2 + random() * 0.6, size * 0.15, 5.5, 4);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/**
 * Cracks torn open by an impact, glowing with sap and cooling over ten seconds.
 *
 * Two separate timescales, and that is what makes it read as damage rather than as a flash. The
 * crack OPENS almost instantly — a radial reveal that races outward in about a third of a second,
 * because a fracture propagates faster than the eye follows. It then COOLS slowly: the sap in the
 * fissure decays from hot to dark over about three seconds, and the decal itself only fades at the
 * very end of its life. Running all three on one curve reads as a light being turned down; split
 * apart it reads as something that happened and is still there.
 */
class GroundCracks implements Tickable {
  readonly object: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private age = 0;

  constructor(private readonly duration: number, radius: number, hot: THREE.Color, cold: THREE.Color, map: THREE.Texture) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: map },
        uGrow: { value: 0 },
        uHeat: { value: 1 },
        uFade: { value: 1 },
        uHot: { value: hot },
        uCold: { value: cold },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform sampler2D uMap;
        uniform float uGrow; uniform float uHeat; uniform float uFade;
        uniform vec3 uHot; uniform vec3 uCold;
        varying vec2 vUv;
        void main() {
          float crack = texture2D(uMap, vUv).a;
          if (crack < 0.02) discard;
          float d = distance(vUv, vec2(0.5)) * 2.0;
          float reveal = smoothstep(uGrow, uGrow - 0.12, d);
          // The leading edge is brightest — that is where the ground is giving way right now.
          float front = smoothstep(uGrow - 0.16, uGrow, d) * reveal;
          vec3 colour = mix(uCold, uHot, clamp(uHeat + front * 0.8, 0.0, 1.0));
          float a = crack * reveal * uFade * (0.45 + 0.55 * uHeat + front);
          if (a < 0.004) discard;
          gl_FragColor = vec4(colour, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.object = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * 2), this.material);
    this.object.name = 'vfx:ground-cracks';
    this.object.rotation.x = -Math.PI / 2;
    this.object.renderOrder = 2;
  }

  tick(dt: number): boolean {
    this.age += dt;
    const t = this.age / this.duration;
    if (t >= 1) return false;
    const u = this.material.uniforms;
    u.uGrow.value = 1 - (1 - Math.min(1, this.age / 0.35)) ** 3;
    u.uHeat.value = Math.max(0, 1 - this.age / 3.2);
    u.uFade.value = t < 0.72 ? 1 : 1 - (t - 0.72) / 0.28;
    return true;
  }
}

/**
 * Toxin: a stain that spreads from the impact, seethes, and drifts off as spores.
 *
 * The edge is displaced by a noise field that itself scrolls, so the stain creeps outward unevenly
 * and keeps moving after it has stopped growing. A clean expanding circle reads as a shockwave —
 * the demo already has one of those — and never as something contaminating the ground.
 *
 * The rising spores belong to this class rather than to a separate emitter because they have to
 * die WITH it. Motes still climbing out of a stain that has already faded is the giveaway that two
 * effects were bolted together, so replenishment stops at 70% of the life and the stragglers are
 * given time to rise and go out on their own.
 */
class ToxinBloom implements Tickable {
  readonly object: THREE.Group;
  private readonly material: THREE.ShaderMaterial;
  private readonly motes: THREE.Points;
  private readonly velocity: Float32Array;
  private readonly life: Float32Array;
  private readonly span: Float32Array;
  private readonly origin: THREE.Vector3;
  private readonly reach: number;
  private readonly random: () => number;
  private age = 0;

  constructor(origin: THREE.Vector3, private readonly duration: number, radius: number, colour: THREE.Color, dot: THREE.Texture, seed: number) {
    this.object = new THREE.Group();
    this.object.name = 'vfx:toxin';
    this.origin = origin.clone();
    this.reach = radius;
    this.random = mulberry32(seed);

    this.material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uSpread: { value: 0 }, uFade: { value: 1 }, uColour: { value: colour } },
      vertexShader: `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform float uTime; uniform float uSpread; uniform float uFade; uniform vec3 uColour;
        varying vec2 vUv;
        float tHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float tNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(tHash(i), tHash(i + vec2(1,0)), f.x),
                     mix(tHash(i + vec2(0,1)), tHash(i + vec2(1,1)), f.x), f.y);
        }
        float tFbm(vec2 p) {
          float s = 0.0, a = 0.5;
          for (int i = 0; i < 3; i++) { s += a * tNoise(p); p *= 2.05; a *= 0.5; }
          return s;
        }
        void main() {
          vec2 d = vUv - vec2(0.5);
          float r = length(d) * 2.0;
          float angle = atan(d.y, d.x);
          // Ragged, creeping edge: the radius itself is modulated by a scrolling field.
          float n = tFbm(vec2(cos(angle), sin(angle)) * 2.4 + vec2(uTime * 0.16, uTime * 0.1));
          float edge = r * (1.0 + (n - 0.5) * 0.85);
          float body = smoothstep(uSpread, uSpread - 0.34, edge);
          // A seething interior, so the stain never looks like a flat sticker.
          float boil = tFbm(vUv * 5.5 + vec2(-uTime * 0.22, uTime * 0.17));
          float a = body * uFade * (0.18 + 0.42 * boil);
          float rim = smoothstep(uSpread - 0.30, uSpread - 0.06, edge) * body;
          if (a < 0.004) discard;
          gl_FragColor = vec4(uColour * (0.7 + rim * 1.9), a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const stain = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * 2), this.material);
    stain.rotation.x = -Math.PI / 2;
    stain.position.set(origin.x, 0.02, origin.z);
    stain.renderOrder = 2;
    this.object.add(stain);

    const count = 90;
    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    this.velocity = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.span = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      this.spawn(i, positions, true);
      sizes[i] = 0.014 + this.random() * 0.03;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    this.motes = new THREE.Points(geometry, new THREE.ShaderMaterial({
      uniforms: { map: { value: dot }, uColour: { value: colour }, uOpacity: { value: 1 } },
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
    }));
    this.motes.name = 'vfx:toxin-motes';
    this.motes.frustumCulled = false;
    this.object.add(this.motes);
  }

  private spawn(i: number, positions: Float32Array, initial: boolean): void {
    const r = this.random;
    const angle = r() * Math.PI * 2;
    // sqrt keeps the spawn density even over the disc instead of clustering at the centre.
    const dist = this.reach * 0.9 * Math.sqrt(r());
    positions[i * 3] = this.origin.x + Math.cos(angle) * dist;
    positions[i * 3 + 1] = 0.02 + (initial ? r() * 0.2 : 0);
    positions[i * 3 + 2] = this.origin.z + Math.sin(angle) * dist;
    this.velocity[i * 3] = (r() - 0.5) * 0.05;
    this.velocity[i * 3 + 1] = 0.03 + r() * 0.09;
    this.velocity[i * 3 + 2] = (r() - 0.5) * 0.05;
    this.span[i] = 2.2 + r() * 3.4;
    this.life[i] = initial ? r() * this.span[i] : 0;
  }

  tick(dt: number, elapsed: number): boolean {
    this.age += dt;
    const t = this.age / this.duration;
    if (t >= 1) return false;
    const u = this.material.uniforms;
    u.uTime.value = elapsed;
    u.uSpread.value = 1 - (1 - Math.min(1, this.age / 2.0)) ** 2.2;
    u.uFade.value = t < 0.66 ? 1 : 1 - (t - 0.66) / 0.34;

    const attr = this.motes.geometry.getAttribute('position') as THREE.BufferAttribute;
    const positions = attr.array as Float32Array;
    const replenish = t < 0.7;
    for (let i = 0; i < this.life.length; i += 1) {
      this.life[i] += dt;
      if (this.life[i] > this.span[i]) {
        if (replenish) this.spawn(i, positions, false);
        else positions[i * 3 + 1] = -999;
        continue;
      }
      positions[i * 3] += this.velocity[i * 3] * dt;
      positions[i * 3 + 1] += this.velocity[i * 3 + 1] * dt;
      positions[i * 3 + 2] += this.velocity[i * 3 + 2] * dt;
    }
    attr.needsUpdate = true;
    (this.motes.material as THREE.ShaderMaterial).uniforms.uOpacity.value = u.uFade.value;
    return true;
  }
}

/**
 * The branch generator, shared by the erupting roots, the grove and the lance.
 *
 * A root, a young tree and a thrusting lance are the same structure at three scales and three
 * forking depths, so they come from one recursion. Keeping them separate let the three drift into
 * looking unrelated the first time round.
 *
 * Its proportions are the character's own: the trunk was measured at 0.078 radius where it meets
 * the ground falling to 0.037 at the top of the leg, so anything grown here is twice as thick at
 * its base as at its tip; and the shin spurs stand off 2.1x the limb radius, which is what sets
 * how wide a fork leaves its parent.
 */
/**
 * How thick a branch is at its base, as a fraction of its own length, and how much of that it
 * keeps at the tip. Both measured off the character's crown twigs by slicing the crown into
 * horizontal slabs and sizing each cross-section: 0.0140 radius at the base falling to 0.0038 at
 * the tips over roughly 0.13 of run.
 *
 * These are the numbers that decide whether grown wood reads as a BRANCH or as a post. The first
 * pass used 0.060 for roots and 0.130 for grove trunks — two to three times too thick — and no
 * amount of forking or gnarl rescued it, because a shape that stout is a trunk whatever is done to
 * its silhouette.
 */
const BRANCH_THICKNESS = 0.045;
const BRANCH_TIP_RATIO = 0.27;

/**
 * One continuous tapered tube along a polyline.
 *
 * This replaces a chain of separate cylinders, and the difference is not cosmetic. Each cylinder
 * carried its own end rings, so consecutive segments shared no vertices: wherever the branch
 * changed direction the two rings splayed apart and the joint opened, which is exactly the
 * "disjointed" look. The wander that makes a branch crooked made it worse, because the sharper the
 * turn the wider the gap.
 *
 * Rings are swept along the path with a PARALLEL TRANSPORT frame rather than a fresh
 * up-vector per ring. Rebuilding the frame from a fixed reference makes the ring spin about the
 * path as the tangent turns, and the tube twists visibly along its own length; transport carries
 * the previous frame forward and only rotates it by the change in tangent, which is the minimum
 * rotation that keeps it perpendicular.
 */
function taperedTube(
  points: THREE.Vector3[],
  radii: number[],
  radialSegments: number,
  colour: THREE.Color,
): THREE.BufferGeometry | null {
  const n = points.length;
  if (n < 2) return null;

  const tangents: THREE.Vector3[] = [];
  for (let i = 0; i < n; i += 1) {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(n - 1, i + 1)];
    const tangent = new THREE.Vector3().subVectors(b, a);
    if (tangent.lengthSq() < 1e-12) tangent.set(0, 1, 0);
    tangents.push(tangent.normalize());
  }

  // Seed a normal perpendicular to the first tangent, then transport it.
  const seed = Math.abs(tangents[0].y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  let normal = new THREE.Vector3().crossVectors(tangents[0], seed).normalize();
  if (normal.lengthSq() < 1e-8) normal.set(1, 0, 0);

  const position: number[] = [];
  const normals: number[] = [];
  const grain: number[] = [];
  const colours: number[] = [];
  const rotate = new THREE.Quaternion();

  for (let i = 0; i < n; i += 1) {
    if (i > 0) {
      rotate.setFromUnitVectors(tangents[i - 1], tangents[i]);
      normal.applyQuaternion(rotate).normalize();
      // Re-orthogonalise: small errors accumulate over a long path and the ring drifts off square.
      normal.addScaledVector(tangents[i], -normal.dot(tangents[i])).normalize();
    }
    const binormal = new THREE.Vector3().crossVectors(tangents[i], normal).normalize();
    for (let s = 0; s < radialSegments; s += 1) {
      const angle = (s / radialSegments) * Math.PI * 2;
      const out = new THREE.Vector3()
        .addScaledVector(normal, Math.cos(angle))
        .addScaledVector(binormal, Math.sin(angle));
      position.push(
        points[i].x + out.x * radii[i],
        points[i].y + out.y * radii[i],
        points[i].z + out.z * radii[i],
      );
      normals.push(out.x, out.y, out.z);
      grain.push(tangents[i].x, tangents[i].y, tangents[i].z);
      colours.push(colour.r, colour.g, colour.b);
    }
  }

  const index: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    for (let s = 0; s < radialSegments; s += 1) {
      const a = i * radialSegments + s;
      const b = i * radialSegments + ((s + 1) % radialSegments);
      const c = (i + 1) * radialSegments + s;
      const d = (i + 1) * radialSegments + ((s + 1) % radialSegments);
      index.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('aGrain', new THREE.Float32BufferAttribute(grain, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  geometry.setIndex(index);
  return geometry;
}



/** Bark mid, white-balanced the same way the shell's albedo is, for generated trunk segments. */
const TRUNK_COLOUR = new THREE.Color(PALETTE.barkMid).convertSRGBToLinear().multiply(
  new THREE.Color(ALBEDO_WHITE_BALANCE[0], ALBEDO_WHITE_BALANCE[1], ALBEDO_WHITE_BALANCE[2]),
);
/**
 * Grow one branch and its forks.
 *
 * Each branch is emitted as a SINGLE continuous tube rather than one geometry per segment. The
 * per-segment version left a seam at every joint — separate end rings, no shared vertices — and on
 * a crooked branch those seams opened into visible breaks, which is what made the grove look
 * disjointed. Building the whole path first and sweeping one surface along it removes the joints.
 */
interface BranchShape {
  /** How far the heading wanders per step. 0.52 is a crooked tree; near 0 is a shaft. */
  wander?: number;
  /** Steps along the run. More gives a longer, smoother trunk. */
  steps?: number;
  /** Close the last of the run to a point instead of stopping at the tip ratio. */
  sharpTip?: boolean;
  /** Length of a fork relative to its parent. Small values keep side branches as detail. */
  forkScale?: number;
  /** How much the shaft swells and pinches at its knots. Higher is rougher, more weathered wood. */
  knot?: number;
}

function growBranch(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  length: number,
  baseRadius: number,
  depth: number,
  random: () => number,
  out: THREE.BufferGeometry[],
  stock: THREE.BufferGeometry | null = null,
  shape: BranchShape = {},
): void {
  const wander = shape.wander ?? 0.52;
  const forkScale = shape.forkScale ?? 1;
  const steps = shape.steps ?? (depth >= 3 ? 5 : (depth === 2 ? 4 : 3));
  const forkAt = Math.max(1, Math.floor(random() * (steps - 1)));

  const knotPhase = random() * 6.28;
  const path: THREE.Vector3[] = [origin.clone()];
  const radii: number[] = [baseRadius];
  let point = origin.clone();
  let heading = direction.clone().normalize();

  for (let i = 0; i < steps; i += 1) {
    // Crooked. Dead wood is not straight, and a thin straight shaft reads as a pole however it is
    // shaded. The wander is biased sideways so a branch bends across its own line, not nods.
    heading = heading.clone().add(new THREE.Vector3(
      (random() - 0.5) * wander,
      (random() - 0.5) * wander * 0.42,
      (random() - 0.5) * wander,
    )).normalize();
    point = point.clone().addScaledVector(heading, length / steps);
    const t1 = (i + 1) / steps;
    path.push(point.clone());
    // A branch stops at the measured tip ratio; a spear closes to nothing over its last quarter.
    const taper = shape.sharpTip
      ? (1 - t1) ** 1.5
      : (1 - t1 * (1 - BRANCH_TIP_RATIO));
    // Wood thickens at its knots and narrows between them. Without this the shaft is a machined
    // cone, which is most of what separated the old spike from anything that had grown.
    const knot = 1 + (shape.knot ?? 0.16) * Math.sin(t1 * 11.0 + knotPhase);
    radii.push(Math.max(baseRadius * 0.008, baseRadius * taper * knot));

    // Real twigs off the character, near the tips.
    if (stock && depth <= 1 && i >= steps - 2) {
      const side = new THREE.Vector3(random() - 0.5, random() * 0.5 + 0.25, random() - 0.5).normalize();
      const lean = heading.clone().multiplyScalar(0.55).addScaledVector(side, 0.8).normalize();
      // Sized off the branch's RADIUS at this node, not its length. A twig is proportional to the
      // wood it grows from, and keying it to length meant the same code produced sensible twigs on
      // a short grove tree and metre-long claws on the lance, which is fourteen times longer.
      const here = radii[radii.length - 1];
      const size = here * (13 + random() * 9);
      const instance = stock.clone();
      instance.applyMatrix4(new THREE.Matrix4().compose(
        point.clone(),
        new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), lean),
        new THREE.Vector3(size, size, size),
      ));
      out.push(instance);
    }

    if (depth > 0 && i === forkAt) {
      // A wide fork. At a narrow angle the child hugs its parent and the pair reads as one
      // slightly thicker shaft; a fork has to be plainly visible to be a fork.
      const side = new THREE.Vector3(random() - 0.5, random() * 0.35, random() - 0.5).normalize();
      const forkDir = heading.clone().multiplyScalar(0.72).addScaledVector(side, 0.7).normalize();
      const r1 = radii[radii.length - 1];
      // Forks start ON the parent path, so the child tube begins inside the parent's surface and
      // the two read as joined rather than as two sticks meeting.
      growBranch(point, forkDir, length * (0.52 + random() * 0.2) * forkScale, r1 * 0.7, depth - 1, random, out, stock);
      // A second, smaller twig now and then. Kept to a third: two forks at every node of a deep
      // recursion is exponential, and the grove came up as a thicket that buried the character.
      if (random() < 0.30) {
        const twigSide = new THREE.Vector3(random() - 0.5, random() * 0.4, random() - 0.5).normalize();
        const twigDir = heading.clone().multiplyScalar(0.5).addScaledVector(twigSide, 0.92).normalize();
        growBranch(point, twigDir, length * (0.42 + random() * 0.22) * forkScale, r1 * 0.52, depth - 1, random, out, stock);
      }
    }
  }

  const tube = taperedTube(path, radii, 7, TRUNK_COLOUR);
  if (tube) out.push(tube);
}

/**
 * A grove erupting out of the ground: several trees growing at once, holding, then sinking back.
 *
 * The same `growBranch` recursion the root eruption uses, at four times the length and one more
 * level of forking, which is the whole difference between a root and a tree. Reusing it is not
 * laziness — a root and a young tree ARE the same structure at different scales, and building a
 * second generator would have let the two drift into looking unrelated.
 *
 * Growth is staggered per trunk and eased, so the grove comes up as a thicket rather than a row of
 * pistons. They stand for most of the ten seconds and only sink at the end.
 */
class GroveEruption implements Tickable {
  readonly object: THREE.Group;
  private readonly trees: Array<{ mesh: THREE.Mesh; delay: number; lean: number }> = [];
  private age = 0;

  constructor(
    origin: THREE.Vector3,
    count: number,
    spread: number,
    scale: number,
    private readonly duration: number,
    seed: number,
    material: THREE.Material,
    stock: THREE.BufferGeometry | null,
  ) {
    this.object = new THREE.Group();
    this.object.name = 'vfx:grove';
    const random = mulberry32(seed);

    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2 + random() * 0.9;
      const dist = spread * Math.sqrt(random());
      const height = scale * (0.30 + random() * 0.30);
      const lean = new THREE.Vector3((random() - 0.5) * 0.3, 1, (random() - 0.5) * 0.3).normalize();

      const parts: THREE.BufferGeometry[] = [];
      growBranch(new THREE.Vector3(), lean, height, height * BRANCH_THICKNESS, 3, random, parts, stock);
      const geometry = mergeGeometries(parts);
      for (const g of parts) g.dispose();
      if (!geometry) continue;

      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(origin.x + Math.cos(angle) * dist, 0, origin.z + Math.sin(angle) * dist);
      mesh.rotation.y = random() * Math.PI * 2;
      mesh.scale.setScalar(0.001);
      mesh.visible = false;
      mesh.castShadow = true;
      this.object.add(mesh);
      this.trees.push({ mesh, delay: random() * 0.55, lean: (random() - 0.5) * 0.06 });
    }
  }

  tick(dt: number, elapsed: number): boolean {
    this.age += dt;
    const t = this.age / this.duration;
    if (t >= 1) return false;
    for (const tree of this.trees) {
      const local = this.age - tree.delay;
      if (local <= 0) continue;
      tree.mesh.visible = true;
      // Grow fast, overshoot slightly, settle — then sink only in the last fifth of the life.
      const grow = local < 1.1 ? 1 - (1 - local / 1.1) ** 3 : 1;
      const overshoot = local < 1.1 ? 1 + Math.sin(Math.min(1, local / 1.1) * Math.PI) * 0.07 : 1;
      const sink = t > 0.8 ? 1 - (t - 0.8) / 0.2 : 1;
      tree.mesh.scale.setScalar(Math.max(0.001, grow * overshoot * sink));
      // A slow sway once standing, so the grove is alive rather than planted scenery.
      tree.mesh.rotation.z = Math.sin(elapsed * 0.9 + tree.delay * 6) * tree.lean * grow;
    }
    return true;
  }
}

/**
 * A spear the character hurls, rather than an effect held in its hand.
 *
 * The previous version grew out of the fist and stayed there, which made it a prop: nothing was
 * ever thrown, so nothing could arrive anywhere or do anything on arrival. This one leaves the
 * hand at the strike and flies, and everything that happens downrange happens because it got
 * there.
 *
 * Its shaft is the SAME `growBranch` recursion that raises the grove, posed long, knotted, and
 * closed to a point — the creature throws one of its own trees. It spins slowly about its axis in
 * flight, which is what stops a rigid object reading as a decal sliding across the screen, and it
 * sheds sparks the whole way so the flight path is legible even at speed.
 */
class HurledSpear implements Tickable {
  readonly object: THREE.Group;
  private readonly shaft: THREE.Mesh;
  /**
   * A light travelling WITH the spear.
   *
   * The alternative was raising the shaft's own emissive, and that is exactly what once turned
   * this move into "just a light streak" — an emissive strong enough to be seen against a black
   * stage stops the thing being wood. A carried light leaves the albedo alone: the spear is still
   * lit rather than glowing, it is visible while it moves, and it rakes the ground it passes over,
   * which sells the flight better than the shaft ever could on its own.
   */
  private readonly lamp: THREE.PointLight;
  private readonly heading = new THREE.Vector3();
  private readonly start = new THREE.Vector3();
  private readonly at = new THREE.Vector3();
  private age = 0;
  private landed = false;
  private sparkClock = 0;

  constructor(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    length: number,
    private readonly distance: number,
    private readonly flightTime: number,
    private readonly linger: number,
    seed: number,
    material: THREE.Material,
    private readonly onSpark: (at: THREE.Vector3) => void,
    private readonly onImpact: (at: THREE.Vector3) => void,
  ) {
    this.object = new THREE.Group();
    this.object.name = 'vfx:hurled-spear';
    const random = mulberry32(seed);

    const parts: THREE.BufferGeometry[] = [];
    // Depth 2 with short forks: the stubs are what make the shaft ROUGH. A clean taper is a
    // turned dowel; a thrown branch has the broken-off remains of its side growth all along it.
    // NO crown twigs on this one. The grove hangs them at its forks and they read as foliage,
    // which on a shaft in flight reads as a cloud of debris travelling with it rather than as one
    // thrown object. The short forks and the knotting carry the roughness on their own.
    growBranch(new THREE.Vector3(), new THREE.Vector3(0, 1, 0), length, length * 0.055, 2, random, parts, null, {
      steps: 13,
      wander: 0.10,
      sharpTip: true,
      forkScale: 0.20,
      knot: 0.34,
    });
    const geometry = mergeGeometries(parts) ?? new THREE.BufferGeometry();
    for (const g of parts) g.dispose();

    this.shaft = new THREE.Mesh(geometry, material);
    this.shaft.castShadow = true;
    // Built from the origin along +Y; shifted back so the spear's MIDDLE sits on the flight point,
    // otherwise it appears to trail its own launch position by its whole length.
    this.shaft.position.y = -length * 0.5;
    this.object.add(this.shaft);

    this.lamp = new THREE.PointLight(lifeColour(0.5, 1), 6, length * 3.4, 2);
    this.object.add(this.lamp);

    this.start.copy(origin);
    this.at.copy(origin);
    this.heading.copy(direction).setY(0);
    if (this.heading.lengthSq() < 1e-8) this.heading.set(1, 0, 0);
    this.heading.normalize();
    this.object.position.copy(origin);
    this.object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.heading);
  }

  tick(dt: number): boolean {
    this.age += dt;
    if (!this.landed) {
      const t = Math.min(1, this.age / this.flightTime);
      // Launches hard and holds its speed: a thrown spear does not ease out.
      const travelled = this.distance * (1 - (1 - t) ** 1.6);
      this.at.copy(this.start).addScaledVector(this.heading, travelled);
      this.object.position.copy(this.at);
      // Spin about the flight axis. Without it a rigid shaft slides across the frame like a decal.
      this.shaft.rotation.y += dt * 9;

      this.sparkClock += dt;
      if (this.sparkClock > 0.045) {
        this.sparkClock = 0;
        this.onSpark(this.at);
      }

      if (t >= 1) {
        this.landed = true;
        this.age = 0;
        // Bury the point and pitch it forward, so it reads as having struck rather than stopped.
        this.object.position.set(this.at.x, 0.0, this.at.z);
        const pitched = this.heading.clone().multiplyScalar(0.55).add(new THREE.Vector3(0, 0.83, 0)).normalize();
        this.object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), pitched);
        this.onImpact(this.at.clone());
      }
      return true;
    }

    if (this.age >= this.linger) return false;
    // Sinks back into the ground it opened, over the last third of its stay.
    const t = this.age / this.linger;
    // The light dies with the throw: a spear standing in the ground is spent, not still burning.
    this.lamp.intensity = 6 * Math.max(0, 1 - t * 2.2);
    if (t > 0.66) this.object.scale.setScalar(Math.max(0.001, 1 - (t - 0.66) / 0.34));
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
          float a = smoothstep(0.50, 0.90, n) * edge * 0.30;
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
          // Faint. A shaft is a hint of a canopy overhead; at any real opacity a handful of them
          // lift the whole background and the figure stops being the brightest thing in frame.
          float a = across * down * 0.085 * uOpacity;
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
  private readonly leaf = leafTexture();
  private readonly runes = runeTexture();
  private readonly cracksMap = crackTexture();
  /**
   * The bark the grown wood is made of — roots, grove and lance all share it.
   *
   * Patched by the SAME `patchBarkSurface` the figure's own shell uses, so the grain, the cavity
   * shading and the sap run on everything that grows out of the ground exactly as they do on the
   * character. That is what makes a grove read as this creature's doing rather than as scenery
   * that happened to appear.
   *
   * barkLIGHT rather than barkMid: grown wood is lit only by the rim and what the ground bounces,
   * and at the trunk's own mid tone it comes back as a black cut-out against a dark floor.
   */
  private readonly rootMaterial: THREE.MeshStandardMaterial;
  private readonly rootBark: BarkSurface;
  /** A branch taken off the character's shoulder; every grown thing instances it. */
  private readonly stock: THREE.BufferGeometry | null;
  /**
   * Effects that outlive the move that made them, oldest first.
   *
   * Cracks and toxin last ten seconds, which is roughly six times any other effect here, so they
   * accumulate: a viewer pressing attack buttons stacks decals on top of each other until the
   * ground is a solid sheet of glow and the frame rate goes with it. This list is capped and the
   * oldest is retired early to make room.
   */
  private readonly lingering: Tickable[] = [];
  /**
   * Cues queued on the EFFECT clock, not on setTimeout. A timer keeps running when the tab is
   * backgrounded and fires everything at once on return; this advances only while the demo does.
   */
  private readonly pending: Array<{ at: number; run: () => void }> = [];
  private elapsed = 0;
  private readonly scale: number;
  /** 0 = dormant, 1 = a power fully gathered. Drives veins, wisps and the chest core together. */
  private chargeLevel = 0;
  private flashLevel = 0;
  /**
   * The accent every impact effect is tinted with, and the single biggest thing this demo was
   * missing.
   *
   * Everything was built from LIFE_HUE — the 82.5 degrees measured off the character's iris —
   * which is right for the creature itself and wrong for everything it does. Sap, toxin, cracks,
   * sparks, shockwaves and rune circles all arriving in one hue means no effect can be told from
   * another, and a frame with six of them in it reads as a single green smear.
   *
   * The accents are still MEASURED. They are points on the reference's own eye ramp — the deep
   * #36581c, the iris #799d3d, the near-white core #d6faca — plus its moss and bark tones. Nothing
   * is invented; the palette is simply used across its range instead of at one point on it.
   */
  private accentColour = lifeColour(0.55, 1);

  constructor(rig: {
    group: THREE.Object3D;
    sockets: Record<string, THREE.Object3D>;
    bones: Record<string, THREE.Bone>;
    shell?: THREE.Mesh;
    branchStock?: THREE.BufferGeometry | null;
  }, bounds: THREE.Box3) {
    this.stock = rig.branchStock ?? null;
    this.group.name = 'monster-tree-vfx';
    this.scale = bounds.getSize(new THREE.Vector3()).y;

    // Grain, relief, cavity, moss and sap, all on the shell's own material. Patched rather than
    // replaced so it keeps three's skinning and PBR lighting; `veins.injected` reports whether the
    // injection actually landed rather than leaving it to be assumed.
    const shellMaterial = rig.shell?.material;
    this.veins = shellMaterial instanceof THREE.MeshStandardMaterial ? patchBarkSurface(shellMaterial) : null;

    this.rootMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      color: new THREE.Color(PALETTE.barkLight).convertSRGBToLinear(),
      roughness: 0.9,
      metalness: 0,
      // A little light of its own. Grown wood stands away from the figure, out where the key
      // barely reaches and the ground bounces almost nothing, so on albedo alone a grove comes up
      // as black cut-outs — the shape is there and none of it reads. This is the same sap that is
      // already running through the character, just enough of it to describe the trunks.
      emissive: new THREE.Color(PALETTE.mossDark).convertSRGBToLinear(),
      emissiveIntensity: 0.55,
    });
    this.rootBark = patchBarkSurface(this.rootMaterial);


    this.spores = new SporeField(bounds, 460, this.dot, this.leaf);
    this.group.add(this.spores.object);

    this.wisps = new Wisps(bounds, 9, this.dot);
    this.group.add(this.wisps.object);

    this.mist = new GroundMist(this.scale * 1.7, lifeColour(0.15, 0.55));
    this.group.add(this.mist.object);

    this.shafts = new LightShafts(5, this.scale, lifeColour(0.52, 0.34), 0x5a71);
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

  /** Register a long-lived effect, retiring the oldest if too many are alive at once. */
  private addLingering(effect: Tickable): void {
    while (this.lingering.length >= MAX_LINGERING) {
      const oldest = this.lingering.shift();
      if (!oldest) break;
      const index = this.transient.indexOf(oldest);
      if (index >= 0) this.transient.splice(index, 1);
      this.group.remove(oldest.object);
      oldest.object.traverse((o) => { (o as THREE.Mesh).geometry?.dispose(); });
    }
    this.lingering.push(effect);
    this.transient.push(effect);
    effect.object.traverse((o) => { o.userData.isHighlight = true; });
    this.group.add(effect.object);
  }

  /**
   * Cracks torn open under a socket. Ten seconds by default: they open instantly, cool over a few
   * seconds, and only fade at the very end.
   */
  cracks(at: THREE.Object3D, options: { radius?: number; duration?: number } = {}): void {
    const effect = new GroundCracks(
      options.duration ?? 10,
      (options.radius ?? 0.9) * this.scale * 0.6,
      this.accentColour,
      this.accentColour.clone().multiplyScalar(0.18),
      this.cracksMap,
    );
    const world = new THREE.Vector3().setFromMatrixPosition(at.matrixWorld);
    effect.object.position.set(world.x, 0.014, world.z);
    effect.object.rotation.z = Math.random() * Math.PI * 2;
    this.addLingering(effect);
  }

  /** A toxin stain that creeps outward from a socket and gives off spores as it seethes. */
  toxin(at: THREE.Object3D, options: { radius?: number; duration?: number } = {}): void {
    const world = new THREE.Vector3().setFromMatrixPosition(at.matrixWorld);
    const effect = new ToxinBloom(
      world,
      options.duration ?? 10,
      (options.radius ?? 1.0) * this.scale * 0.55,
      // The skill's accent, held down to a low acid value so it stays contamination rather than
      // becoming another light source. Tinting it per skill is what stops every move leaving the
      // same puddle behind it.
      this.accentColour.clone().multiplyScalar(0.42),
      this.dot,
      (Math.random() * 1e9) | 0,
    );
    this.addLingering(effect);
  }

  /**
   * A grove torn up out of the ground at a point, standing for ten seconds before it sinks.
   *
   * Takes a WORLD position rather than a socket, because the whole point of this one is that it
   * happens somewhere the character is not.
   */
  grove(at: THREE.Vector3, options: { count?: number; spread?: number; duration?: number } = {}): void {
    const effect = new GroveEruption(
      at,
      options.count ?? 7,
      (options.spread ?? 0.5) * this.scale,
      this.scale,
      options.duration ?? 10,
      (Math.random() * 1e9) | 0,
      this.rootMaterial,
      this.stock,
    );
    this.addLingering(effect);
  }

  /**
   * A shockwave running away underground: cracks opening in sequence along a line, then the
   * ground failing at the far end.
   *
   * The delay between links is what sells it. Spawned all at once they read as one big decal;
   * staggered, the eye follows the fracture outward and the distant eruption becomes something the
   * punch CAUSED rather than something that happened at the same time.
   */
  surge(from: THREE.Object3D, direction: THREE.Vector3, options: { distance?: number; links?: number; onArrive?: (at: THREE.Vector3) => void } = {}): void {
    const start = new THREE.Vector3().setFromMatrixPosition(from.matrixWorld);
    const flat = new THREE.Vector3(direction.x, 0, direction.z);
    if (flat.lengthSq() < 1e-8) flat.set(1, 0, 0);
    flat.normalize();
    const distance = (options.distance ?? 3.2) * this.scale * 0.5;
    const links = options.links ?? 5;

    for (let i = 1; i <= links; i += 1) {
      const at = start.clone().addScaledVector(flat, (distance * i) / links);
      at.y = 0;
      const delay = (i - 1) * 0.075;
      // Widening as it travels, so the surge reads as gathering force rather than dissipating.
      const radius = 0.5 + (i / links) * 0.7;
      this.delay(delay, () => {
        const crack = new GroundCracks(6, radius * this.scale * 0.6, lifeColour(0.66, 1), lifeColour(0.14, 0.9), this.cracksMap);
        crack.object.position.set(at.x, 0.014, at.z);
        crack.object.rotation.z = Math.random() * Math.PI * 2;
        this.addLingering(crack);
      });
    }

    const target = start.clone().addScaledVector(flat, distance);
    target.y = 0;
    this.delay(links * 0.075, () => options.onArrive?.(target));
  }

  /** A burst at a WORLD point rather than a socket — for things that happen away from the figure. */
  burstAt(at: THREE.Vector3, options: { count?: number; speed?: number; duration?: number; spread?: number; gravity?: number; lightness?: number } = {}): void {
    const burst = new Burst(
      at,
      options.count ?? 60,
      (options.speed ?? 1.1) * this.scale * 0.5,
      options.duration ?? 0.9,
      this.accentColour,
      this.dot,
      (options.gravity ?? -1.6) * this.scale * 0.5,
      options.spread ?? 1,
      (Math.random() * 1e9) | 0,
    );
    burst.object.userData.isHighlight = true;
    this.group.add(burst.object);
    this.transient.push(burst);
  }

  /**
   * Hurl a spear from a socket along a heading: it flies, it lands, and it does its damage where
   * it ARRIVES rather than where it was thrown.
   *
   * The previous version grew out of the fist and stayed there, which made it a prop — nothing was
   * ever thrown, so nothing could arrive anywhere or do anything on arrival.
   */
  hurlSpear(from: THREE.Object3D, direction: THREE.Vector3, options: {
    length?: number; distance?: number; flightTime?: number; linger?: number;
  } = {}): void {
    const origin = new THREE.Vector3().setFromMatrixPosition(from.matrixWorld);
    const spear = new HurledSpear(
      origin,
      direction,
      (options.length ?? 0.55) * this.scale,
      (options.distance ?? 3.4) * this.scale * 0.5,
      options.flightTime ?? 0.42,
      options.linger ?? 2.4,
      (Math.random() * 1e9) | 0,
      this.rootMaterial,
      // Sparks torn off along the flight path, so the throw is legible at speed.
      (at) => this.burstAt(at, { count: 5, speed: 0.5, duration: 0.5, gravity: -0.6, lightness: 0.7 }),
      (at) => {
        // What arriving means: the ground breaking open, and the toxin going into it. A bare
        // Object3D is parked at the landing point because the ground effects all take a socket.
        this.burstAt(at, { count: 150, speed: 2.0, spread: 0.55, gravity: -1.9 });
        const ground = new THREE.Object3D();
        ground.position.set(at.x, 0, at.z);
        ground.updateMatrixWorld(true);
        this.shockwave(ground, 1.35, 0.9);
        this.cracks(ground, { radius: 1.25 });
        this.toxin(ground, { radius: 1.15 });
      },
    );
    spear.object.traverse((o) => { o.userData.isHighlight = true; });
    this.group.add(spear.object);
    this.transient.push(spear);
  }
  /** Run something later, on the effect clock, so cues can be sequenced without setTimeout. */
  delay(seconds: number, run: () => void): void {
    this.pending.push({ at: this.elapsed + seconds, run });
  }

  /** Tint every impact effect spawned from now on. Set per skill; reset when the skill changes. */
  set accent(colour: THREE.Color) {
    this.accentColour = colour;
  }

  get accent(): THREE.Color {
    return this.accentColour;
  }

  /**
   * A hit registering ON the character.
   *
   * The creature's own sap spikes for a moment at the instant of contact, then falls back. Without
   * it every effect happens in front of a figure that never reacts to any of it — the impacts read
   * as something passing by rather than as something it did.
   */
  flash(strength = 1): void {
    this.flashLevel = Math.max(this.flashLevel, strength);
  }

  /** A short, bright light at a world point — the scene registering a hit. */
  impactFlash(at: THREE.Vector3, strength = 6, life = 0.28): void {
    const light = new THREE.PointLight(this.accentColour, strength, this.scale * 2.2, 2);
    light.position.copy(at);
    light.userData.isHighlight = true;
    this.group.add(light);
    let age = 0;
    this.transient.push({
      object: light,
      tick: (dt) => {
        age += dt;
        if (age >= life) return false;
        // Snap on, fall off fast — a flash that eases in is a lamp being turned up.
        light.intensity = strength * (1 - age / life) ** 2.2;
        return true;
      },
    });
  }

  /** A rune circle inscribed on the ground under a socket — for anything deliberate. */
  runeCircle(at: THREE.Object3D, radius = 1.2, duration = 1.5): void {
    const circle = new RuneCircle(duration, radius * this.scale * 0.62, this.accentColour, this.runes, this.ring);
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
    );
    eruption.object.traverse((o) => { o.userData.isHighlight = true; });
    this.group.add(eruption.object);
    this.transient.push(eruption);
  }

  /** A shockwave on the ground, centred under a socket rather than at a guessed origin. */
  shockwave(at: THREE.Object3D, radius = 1.1, duration = 0.85): void {
    const ring = new GroundRing(duration, radius * this.scale * 0.6, this.accentColour, this.ring);
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
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      if (this.pending[i].at > this.elapsed) continue;
      const cue = this.pending.splice(i, 1)[0];
      cue.run();
    }
    this.veins?.setTime(this.elapsed);
    this.rootBark.setTime(this.elapsed);
    // The flash decays on its own and rides ON TOP of whatever charge a skill has set, so a hit
    // landing during a cast brightens from where the cast already was instead of resetting it.
    if (this.flashLevel > 0) {
      this.flashLevel = Math.max(0, this.flashLevel - dt * 4.5);
      this.veins?.setCharge(Math.min(2, this.chargeLevel + this.flashLevel));
      this.rootBark.setCharge(Math.min(2, this.chargeLevel + this.flashLevel));
    }
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
