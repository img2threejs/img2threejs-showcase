import * as THREE from 'three';

/**
 * Ambient effects for Van Hi: a rune circle under her feet, drifting petals, rising motes, a soft
 * aura column and a ribbon off each sleeve.
 *
 * PURE THREE.JS AND NO ASSET. The single texture is a radial falloff drawn into a 64 px canvas at
 * construction. Nothing is fetched; there is no sprite sheet, no image and no shader file in the
 * repository. Everything else is `RingGeometry`, `PlaneGeometry`, `BufferGeometry` and four short
 * inline shaders.
 *
 * THE VIEWER HAS NO POST-PROCESSING, so none of this can lean on a bloom pass. Every glow is earned
 * with additive blending, `depthWrite: false` and a falloff that reaches zero at the quad's edge —
 * a hard-edged additive quad reads as a grey rectangle the moment two of them overlap. The layering
 * is deliberate for the same reason: the aura is a wide, very dim column that lifts the whole
 * silhouette, and the bright elements sit on top of it rather than trying to be bright alone.
 *
 * IT LIVES BESIDE THE MODEL, NOT INSIDE IT. The parts inspector and the explode layout walk the
 * model group and treat every mesh they find as a piece of the figure, so an effect parented under
 * it would be listed as a body part and would fly apart on explode. These attach to the model's
 * parent and read bone positions in world space, which already carry the model's display offset.
 *
 * The viewer skips every `userData.tick` in capture mode, so nothing here runs during headless
 * screenshot capture and the turntable plates stay byte-comparable between runs.
 */

/** Lavender silk, the gown's own dominant hue, measured from the reference at rgb(140,106,166). */
const LILAC = new THREE.Color('#8c6aa6');
/** The pale highlight side of the same silk, rgb(181,173,194). */
const MOONLIGHT = new THREE.Color('#b5adc2');
/** The cyan set into the bodice and the tiara. The only cool accent on the figure. */
const SPIRIT = new THREE.Color('#4fe3f0');
/** The gold filigree along the hems. */
const FILIGREE = new THREE.Color('#e0c070');

const PETAL_COUNT = 220;
const MOTE_COUNT = 320;
/** Points on each ribbon. Twenty-four spans about a second of hand travel at the dance clips' pace. */
const RIBBON_POINTS = 24;

/**
 * Ribbon half-width at the hand, as a fraction of figure height.
 *
 * The reference's sleeves are enormous — they reach the floor and are as wide as her shoulders — so
 * a hairline trail reads as a stray wire rather than silk. 0.055 is about 10 cm to a side on the
 * 1.9 m figure, which is the width of the visible sleeve edge in the reference.
 */
const RIBBON_HALF_WIDTH = 0.055;

/** Hand speed, in figure heights per second, at which the ribbon reaches full strength. */
const RIBBON_FULL_SPEED = 1.1;

/** Below this the hand is not moving enough for a trail, and drawing one looks permanently mid-swing. */
const RIBBON_MIN_SPEED = 0.18;

/**
 * Trail length, in figure heights, below which the ribbon stays hidden.
 *
 * With the figure pinned over one spot the hands can move fast without going far — through the run
 * cycle the right hand crosses the chest and comes back inside a third of a height. The trail then
 * holds twenty-four points inside a few centimetres, and the strip built through them opens into a
 * flat wedge in front of the waist that reads as a stray pink triangle rather than as silk.
 */
const RIBBON_MIN_SPAN = 0.55;

/** One shared radial falloff, drawn once. Linear in the middle, squared at the rim, so it fades out. */
function makeSpotTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export interface VanHiVfx {
  group: THREE.Group;
  /** Per frame: `delta` advances the simulation, the bones are read for the ribbons. */
  update: (delta: number) => void;
  /** 0 hides every effect without unbuilding it, for a capture run or a low-power device. */
  setIntensity: (intensity: number) => void;
  dispose: () => void;
}

export interface VanHiVfxOptions {
  /** Figure height in world units, so every effect is sized against the subject, not a constant. */
  height: number;
  /** Bones the ribbons trail from — the two hands. Omitted, the ribbons are simply not built. */
  ribbonBones?: THREE.Object3D[];
}

export function createVanHiVfx({ height, ribbonBones = [] }: VanHiVfxOptions): VanHiVfx {
  const group = new THREE.Group();
  group.name = 'van-hi-vfx';
  const spot = makeSpotTexture();
  const disposables: Array<{ dispose: () => void }> = [spot];
  const track = <T extends { dispose: () => void }>(item: T): T => { disposables.push(item); return item; };
  const intensity = { value: 1 };

  // ---- rune circle -------------------------------------------------------
  // Two counter-rotating rings. The glyphs are not glyphs: they are a hard step on the angular
  // coordinate, which at this radius and this brightness reads as script and costs one instruction.
  const runeUniforms = {
    uTime: { value: 0 },
    uIntensity: intensity,
    uInner: { value: LILAC },
    uOuter: { value: SPIRIT },
  };
  const runeMaterial = track(new THREE.ShaderMaterial({
    uniforms: runeUniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform float uTime;
      uniform float uIntensity;
      uniform vec3 uInner;
      uniform vec3 uOuter;
      varying vec2 vUv;
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float r = length(p);
        if (r > 1.0) discard;
        float angle = atan(p.y, p.x);
        // Three bands, each turning at its own rate and in its own direction.
        float ringA = smoothstep(0.012, 0.0, abs(r - 0.42));
        float ringB = smoothstep(0.008, 0.0, abs(r - 0.78));
        float ringC = smoothstep(0.020, 0.0, abs(r - 0.96));
        float glyphs = step(0.55, fract((angle + uTime * 0.20) * 5.7)) * smoothstep(0.07, 0.0, abs(r - 0.60));
        float ticks  = step(0.80, fract((angle - uTime * 0.34) * 14.0)) * smoothstep(0.05, 0.0, abs(r - 0.88));
        // A slow breath, so the circle is never quite static and never pulses on a countable beat.
        float breath = 0.72 + 0.28 * sin(uTime * 0.9);
        float glow = smoothstep(1.0, 0.0, r) * 0.10;
        float mask = (ringA * 0.9 + ringB * 0.7 + ringC * 0.5 + glyphs * 0.8 + ticks * 0.6) * breath + glow;
        vec3 tint = mix(uInner, uOuter, smoothstep(0.3, 1.0, r));
        gl_FragColor = vec4(tint * mask * uIntensity, mask * uIntensity);
      }`,
  }));
  const runeGeometry = track(new THREE.PlaneGeometry(height * 1.5, height * 1.5));
  const rune = new THREE.Mesh(runeGeometry, runeMaterial);
  rune.rotation.x = -Math.PI / 2;
  // Clear of the floor by a millimetre of figure height, so it never z-fights the shadow catcher.
  rune.position.y = height * 0.002;
  rune.renderOrder = -1;
  group.add(rune);

  // ---- aura column -------------------------------------------------------
  // Very dim and very wide: it is the floor the other effects stand on, not an effect itself.
  const auraUniforms = { uTime: { value: 0 }, uIntensity: intensity, uColour: { value: MOONLIGHT } };
  const auraMaterial = track(new THREE.ShaderMaterial({
    uniforms: auraUniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform float uTime;
      uniform float uIntensity;
      uniform vec3 uColour;
      varying vec2 vUv;
      void main() {
        // Bright at the hem, gone by the shoulders: light pooling around her, not a tube.
        float rise = pow(1.0 - vUv.y, 2.2);
        float shimmer = 0.85 + 0.15 * sin(uTime * 1.4 + vUv.x * 18.0);
        float mask = rise * 0.16 * shimmer;
        gl_FragColor = vec4(uColour * mask * uIntensity, mask * uIntensity);
      }`,
  }));
  const auraGeometry = track(new THREE.CylinderGeometry(height * 0.42, height * 0.52, height * 0.95, 40, 1, true));
  const aura = new THREE.Mesh(auraGeometry, auraMaterial);
  aura.position.y = height * 0.475;
  group.add(aura);

  // ---- petals ------------------------------------------------------------
  // One instanced quad per petal, spun on the GPU. The CPU touches nothing per frame but the clock.
  const petalGeometry = track(new THREE.InstancedBufferGeometry());
  {
    const quad = new THREE.PlaneGeometry(1, 1);
    petalGeometry.index = quad.index;
    petalGeometry.attributes.position = quad.attributes.position;
    petalGeometry.attributes.uv = quad.attributes.uv;
    quad.dispose();
    const seed = new Float32Array(PETAL_COUNT * 4);
    for (let i = 0; i < PETAL_COUNT; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      // Biased outward by a square root so the density per unit AREA is even, not per unit radius.
      const radius = Math.sqrt(Math.random()) * height * 0.55;
      seed[i * 4] = Math.cos(angle) * radius;
      seed[i * 4 + 1] = Math.sin(angle) * radius;
      seed[i * 4 + 2] = Math.random();             // phase down the fall
      seed[i * 4 + 3] = 0.5 + Math.random() * 0.9; // size and rate
    }
    petalGeometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
    petalGeometry.instanceCount = PETAL_COUNT;
  }
  const petalUniforms = {
    uTime: { value: 0 },
    uIntensity: intensity,
    uHeight: { value: height },
    uMap: { value: spot },
    uWarm: { value: MOONLIGHT },
    uCool: { value: LILAC },
  };
  const petalMaterial = track(new THREE.ShaderMaterial({
    uniforms: petalUniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute vec4 aSeed;
      uniform float uTime;
      uniform float uHeight;
      varying float vFade;
      varying vec2 vUv;
      varying float vTint;
      void main() {
        vUv = uv;
        float rate = 0.055 + aSeed.w * 0.05;
        // fract() gives each petal an endless fall with no respawn bookkeeping on the CPU.
        float fall = fract(aSeed.z + uTime * rate);
        float y = (1.0 - fall) * uHeight * 1.25;
        // Spiral in as it descends, the way a petal actually settles.
        float spin = uTime * (0.35 + aSeed.w * 0.3) + aSeed.z * 6.2831;
        float shrink = 0.55 + 0.45 * fall;
        vec3 centre = vec3(
          aSeed.x * shrink + sin(spin) * uHeight * 0.035,
          y,
          aSeed.y * shrink + cos(spin * 0.82) * uHeight * 0.035);
        // Fade in at the top and out at the floor, so nothing pops into or out of existence.
        vFade = smoothstep(0.0, 0.12, fall) * smoothstep(1.0, 0.82, fall);
        vTint = aSeed.w;
        float size = uHeight * 0.010 * aSeed.w;
        // Billboarded in view space: cheaper than a lookAt and always exactly facing.
        vec4 view = modelViewMatrix * vec4(centre, 1.0);
        view.xy += (uv - 0.5) * size * vec2(1.0, 2.2);
        gl_Position = projectionMatrix * view;
      }`,
    fragmentShader: `
      uniform sampler2D uMap;
      uniform float uIntensity;
      uniform vec3 uWarm;
      uniform vec3 uCool;
      varying float vFade;
      varying vec2 vUv;
      varying float vTint;
      void main() {
        float a = texture2D(uMap, vUv).a * vFade * uIntensity * 0.85;
        if (a < 0.004) discard;
        gl_FragColor = vec4(mix(uCool, uWarm, vTint) * a, a);
      }`,
  }));
  group.add(new THREE.Points(petalGeometry, petalMaterial));

  // ---- rising motes ------------------------------------------------------
  const moteGeometry = track(new THREE.BufferGeometry());
  {
    const seed = new Float32Array(MOTE_COUNT * 4);
    for (let i = 0; i < MOTE_COUNT; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.sqrt(Math.random()) * height * 0.42;
      seed[i * 4] = Math.cos(angle) * radius;
      seed[i * 4 + 1] = Math.sin(angle) * radius;
      seed[i * 4 + 2] = Math.random();
      seed[i * 4 + 3] = 0.4 + Math.random();
    }
    moteGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MOTE_COUNT * 3), 3));
    moteGeometry.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  }
  const moteUniforms = {
    uTime: { value: 0 },
    uIntensity: intensity,
    uHeight: { value: height },
    uMap: { value: spot },
    uColour: { value: SPIRIT },
    uScale: { value: 1 },
  };
  const moteMaterial = track(new THREE.ShaderMaterial({
    uniforms: moteUniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute vec4 aSeed;
      uniform float uTime;
      uniform float uHeight;
      uniform float uScale;
      varying float vFade;
      void main() {
        float rise = fract(aSeed.z + uTime * (0.030 + aSeed.w * 0.035));
        float sway = sin(uTime * 0.7 + aSeed.z * 12.0) * uHeight * 0.02;
        vec3 p = vec3(aSeed.x + sway, rise * uHeight * 1.05, aSeed.y + sway * 0.6);
        vFade = smoothstep(0.0, 0.15, rise) * smoothstep(1.0, 0.7, rise);
        vec4 view = modelViewMatrix * vec4(p, 1.0);
        // Perspective-correct point size, so a mote does not grow as the camera dollies in.
        gl_PointSize = uHeight * 6.0 * aSeed.w * uScale / max(-view.z, 0.001);
        gl_Position = projectionMatrix * view;
      }`,
    fragmentShader: `
      uniform sampler2D uMap;
      uniform float uIntensity;
      uniform vec3 uColour;
      varying float vFade;
      void main() {
        float a = texture2D(uMap, gl_PointCoord).a * vFade * uIntensity * 0.6;
        if (a < 0.004) discard;
        gl_FragColor = vec4(uColour * a, a);
      }`,
  }));
  group.add(new THREE.Points(moteGeometry, moteMaterial));

  // ---- sleeve ribbons ----------------------------------------------------
  // A strip per bone, its spine a ring buffer of past world positions. The width tapers to nothing
  // at the tail so the ribbon ends rather than being cut off, and the whole thing fades with speed:
  // a still hand should leave nothing, or the character looks permanently mid-swing.
  interface Ribbon {
    mesh: THREE.Mesh;
    bone: THREE.Object3D;
    trail: Float32Array;
    filled: number;
    speed: number;
  }
  const ribbons: Ribbon[] = [];
  const ribbonMaterial = track(new THREE.MeshBasicMaterial({
    color: MOONLIGHT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    vertexColors: true,
  }));
  for (const bone of ribbonBones) {
    const geometry = track(new THREE.BufferGeometry());
    const position = new Float32Array(RIBBON_POINTS * 2 * 3);
    const colour = new Float32Array(RIBBON_POINTS * 2 * 3);
    const index: number[] = [];
    for (let i = 0; i < RIBBON_POINTS - 1; i += 1) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colour, 3));
    geometry.setIndex(index);
    const mesh = new THREE.Mesh(geometry, ribbonMaterial);
    mesh.frustumCulled = false;
    group.add(mesh);
    ribbons.push({ mesh, bone, trail: new Float32Array(RIBBON_POINTS * 3), filled: 0, speed: 0 });
  }

  const world = new THREE.Vector3();
  const previous = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const side = new THREE.Vector3();
  const lastSide = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  const updateRibbons = (delta: number): void => {
    for (const ribbon of ribbons) {
      ribbon.bone.getWorldPosition(world);
      if (ribbon.filled > 0) {
        previous.set(ribbon.trail[0], ribbon.trail[1], ribbon.trail[2]);
        const travelled = world.distanceTo(previous) / Math.max(delta, 1e-4);
        // Low-passed, because a single fast frame should not flash the ribbon on for one frame.
        ribbon.speed += (travelled - ribbon.speed) * Math.min(1, delta * 8);
      }
      // Shift the ring buffer by one and write the new head.
      ribbon.trail.copyWithin(3, 0, (RIBBON_POINTS - 1) * 3);
      ribbon.trail[0] = world.x; ribbon.trail[1] = world.y; ribbon.trail[2] = world.z;
      if (ribbon.filled < RIBBON_POINTS) {
        ribbon.filled += 1;
        // Until the buffer fills, every point sits on the hand, so the strip has zero area.
        for (let i = ribbon.filled; i < RIBBON_POINTS; i += 1) {
          ribbon.trail[i * 3] = world.x; ribbon.trail[i * 3 + 1] = world.y; ribbon.trail[i * 3 + 2] = world.z;
        }
      }

      // Two gates, not one. Speed alone is not enough: with the figure pinned in place the hands
      // can be quick and still travel almost nowhere, and the trail then bunches into a handful of
      // near-coincident points that the strip below widens into a flat wedge across the waist.
      // Requiring real SPREAD as well is what removes it.
      const reach = (ribbon.speed / height - RIBBON_MIN_SPEED) / (RIBBON_FULL_SPEED - RIBBON_MIN_SPEED);
      let spread = 0;
      for (let i = 1; i < RIBBON_POINTS; i += 1) {
        spread += Math.hypot(
          ribbon.trail[i * 3] - ribbon.trail[(i - 1) * 3],
          ribbon.trail[i * 3 + 1] - ribbon.trail[(i - 1) * 3 + 1],
          ribbon.trail[i * 3 + 2] - ribbon.trail[(i - 1) * 3 + 2],
        );
      }
      const opened = Math.min(1, Math.max(0, spread / height / RIBBON_MIN_SPAN - 1));
      const strength = Math.min(1, Math.max(0, reach)) * opened * intensity.value;
      const geometry = ribbon.mesh.geometry;
      const position = geometry.attributes.position as THREE.BufferAttribute;
      const colour = geometry.attributes.color as THREE.BufferAttribute;
      // Carried between points so a segment whose direction is degenerate — a hand moving straight
      // up, where `forward` is parallel to `up` and their cross product is noise — keeps the
      // previous segment's side instead of flipping the ribbon inside out.
      lastSide.set(0, 0, 0);
      for (let i = 0; i < RIBBON_POINTS; i += 1) {
        const head = i * 3;
        world.set(ribbon.trail[head], ribbon.trail[head + 1], ribbon.trail[head + 2]);
        const nextIndex = Math.min(i + 2, RIBBON_POINTS - 1) * 3;
        forward.set(
          ribbon.trail[nextIndex] - ribbon.trail[head],
          ribbon.trail[nextIndex + 1] - ribbon.trail[head + 1],
          ribbon.trail[nextIndex + 2] - ribbon.trail[head + 2],
        );
        side.crossVectors(forward, up);
        if (side.lengthSq() < 1e-9) {
          if (lastSide.lengthSq() > 0) side.copy(lastSide);
          else side.set(1, 0, 0);
        }
        side.normalize();
        lastSide.copy(side);
        // Widest a third of the way down rather than at the hand: silk leaves the cuff narrow,
        // bells out behind it and then tapers away, which a straight taper from the hand does not.
        const along = i / (RIBBON_POINTS - 1);
        const taper = Math.sin(Math.min(1, along * 1.5) * Math.PI * 0.5) * (1 - along) ** 0.8;
        side.multiplyScalar(height * RIBBON_HALF_WIDTH * taper * strength);
        position.setXYZ(i * 2, world.x - side.x, world.y - side.y, world.z - side.z);
        position.setXYZ(i * 2 + 1, world.x + side.x, world.y + side.y, world.z + side.z);
        // Gold at the cuff into lavender at the tail: the reference's hems are gold-threaded silk.
        const fade = taper * strength * 0.7;
        const warm = 1 - along;
        const r = fade * (FILIGREE.r * warm + LILAC.r * (1 - warm));
        const g = fade * (FILIGREE.g * warm + LILAC.g * (1 - warm));
        const b = fade * (FILIGREE.b * warm + LILAC.b * (1 - warm));
        colour.setXYZ(i * 2, r, g, b);
        colour.setXYZ(i * 2 + 1, r, g, b);
      }
      position.needsUpdate = true;
      colour.needsUpdate = true;
      ribbon.mesh.visible = strength > 0.001;
    }
  };

  let elapsed = 0;
  return {
    group,
    update: (delta: number) => {
      const step = Math.min(delta, 1 / 20);
      elapsed += step;
      runeUniforms.uTime.value = elapsed;
      auraUniforms.uTime.value = elapsed;
      petalUniforms.uTime.value = elapsed;
      moteUniforms.uTime.value = elapsed;
      updateRibbons(step);
    },
    setIntensity: (value: number) => { intensity.value = value; },
    dispose: () => {
      group.removeFromParent();
      for (const item of disposables) item.dispose();
    },
  };
}
