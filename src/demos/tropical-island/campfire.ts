import * as THREE from 'three';
import type { SurfaceEvidence } from './measured/surfaceCodec';

// Remove baked flame triangles by reading per-triangle evidence installed on
// `geometry.userData.surfaceEvidence` by the offline measurement step. The
// measured build carries no texture, so all classification goes through the
// per-original-triangle flag array.

/** Linear emission colours; procedural volume and particles need no texture uploads. */
const FIRE_COLORS = {
  hotCore: new THREE.Color(0xfff3a8),
  midFlame: new THREE.Color(0xffc066),
  outerFlame: new THREE.Color(0xff7a2b),
  ember: new THREE.Color(0xb53a08),
  smoke: new THREE.Color(0x222222),
} as const;

/** Wind direction in scene-local coordinates. Coherent with the palms (+X, slight +Z). */
const WIND_DIR = new THREE.Vector2(0.92, 0.39);

/** Deterministic PRNG seeded for a stable VFX layout across reloads. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Locate the single fused mesh inside a normalised campfire placement. */
function probeCampfireMesh(placement: THREE.Group): THREE.Mesh {
  let found: THREE.Mesh | null = null;
  placement.traverse((object) => {
    if (found) return;
    if (object instanceof THREE.Mesh) found = object;
  });
  if (!found) throw new Error('tropical-island/campfire: no mesh found in placement');
  return found;
}



/** Public result interface for the geometry scrubber. */
export interface CampfireCorrection {
  kept: number;
  removed: number;
  /** World-Y in normalised placement coordinates where the flame body begins. Main places
   *  the fire VFX group at this height. */
  emitterY: number;
}

/**
 * Remove baked flame triangles from the measured campfire mesh. The geometry
 * carries the original vertex/index order and normals, the source diffuse as
 * per-vertex colour and a per-original-triangle flag array on
 * `userData.surfaceEvidence`.
 *
 * Classification reads ONLY those flags:
 *   bit 0 = warm (originally r>=160,g>=60,r>=g*.95,b<g*.8 in byte sRGB)
 *   bit 1 = dark wood candidate (!warm, r<160,g<120,r>g*1.08)
 * Spatial decisions (placement-space y=0.16 trim, 0.20 cylinder for the emitter)
 * remain runtime.
 */
export function correctCampfireModel(placement: THREE.Group): CampfireCorrection {
  const mesh = probeCampfireMesh(placement);
  const source = mesh.geometry;
  const pos = source.getAttribute('position');
  const norm = source.getAttribute('normal');
  const index = source.getIndex();
  const colourAttr = source.getAttribute('color');
  if (!pos || !index) {
    throw new Error('Campfire correction requires the source indexed geometry.');
  }
  if (!(colourAttr instanceof THREE.BufferAttribute) || colourAttr.itemSize !== 3) {
    throw new Error('Campfire correction requires per-vertex colour (itemSize=3) on the source geometry.');
  }
  const evidence = (source.userData as { surfaceEvidence?: SurfaceEvidence }).surfaceEvidence;
  const flags = evidence?.triangleClasses;
  if (!(flags instanceof Uint8Array)) {
    throw new Error('Campfire correction requires measured triangleClasses on geometry.userData.');
  }
  const triCount = Math.floor(index.count / 3);
  if (flags.length !== triCount) {
    throw new Error(
      `Campfire correction: triangleClasses length (${flags.length}) does not match the original triangle count (${triCount}).`,
    );
  }
  placement.updateWorldMatrix(true, true);
  const toPlacement = new THREE.Matrix4().multiplyMatrices(
    placement.matrixWorld.clone().invert(), mesh.matrixWorld,
  );
  const centroid = new THREE.Vector3();
  let emitterY = 0;
  const vertCount = pos.count;

  const keepTri = new Uint8Array(triCount);
  const vertKept = new Uint8Array(vertCount);
  let kept = 0;
  for (let t = 0; t < triCount; t += 1) {
    const a = index.getX(t * 3);
    const b = index.getX(t * 3 + 1);
    const c = index.getX(t * 3 + 2);
    centroid.set(
      (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3,
      (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3,
      (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3,
    ).applyMatrix4(toPlacement);
    const flag = flags[t]!;
    const warm = (flag & 0b01) !== 0;
    const darkWood = (flag & 0b10) !== 0;
    // Source colour evidence starts separating bright flame from wood above 0.16.
    const isFlame = centroid.y > 0.16 && warm;
    if (!warm && darkWood && Math.hypot(centroid.x, centroid.z) < 0.20) {
      emitterY = Math.max(emitterY, centroid.y);
    }
    if (isFlame) continue;
    keepTri[t] = 1;
    vertKept[a] = 1;
    vertKept[b] = 1;
    vertKept[c] = 1;
    kept += 1;
  }

  // Compact: remap kept vertices into position + normal + colour arrays. The
  // measured build carries only these three vertex-count attributes; UVs and
  // any textures are deliberately absent.
  const remap = new Int32Array(vertCount);
  remap.fill(-1);
  let next = 0;
  for (let v = 0; v < vertCount; v += 1) {
    if (vertKept[v]) remap[v] = next++;
  }
  const newPos = new Float32Array(next * 3);
  const newNorm = norm ? new Float32Array(next * 3) : null;
  const newColour = new Float32Array(next * 3);
  for (let v = 0; v < vertCount; v += 1) {
    const r = remap[v];
    if (r < 0) continue;
    newPos[r * 3] = pos.getX(v);
    newPos[r * 3 + 1] = pos.getY(v);
    newPos[r * 3 + 2] = pos.getZ(v);
    if (norm) {
      newNorm![r * 3] = norm.getX(v);
      newNorm![r * 3 + 1] = norm.getY(v);
      newNorm![r * 3 + 2] = norm.getZ(v);
    }
    newColour[r * 3] = colourAttr.getX(v);
    newColour[r * 3 + 1] = colourAttr.getY(v);
    newColour[r * 3 + 2] = colourAttr.getZ(v);
  }
  const newIndex = new Uint32Array(kept * 3);
  let out = 0;
  for (let t = 0; t < triCount; t += 1) {
    if (!keepTri[t]) continue;
    newIndex[out++] = remap[index.getX(t * 3)];
    newIndex[out++] = remap[index.getX(t * 3 + 1)];
    newIndex[out++] = remap[index.getX(t * 3 + 2)];
  }

  // The measured geometry is shared across all placements. Build a fresh
  // BufferGeometry so the prepared cache stays pristine for other prop instances.
  const cleaned = new THREE.BufferGeometry();
  cleaned.setAttribute('position', new THREE.BufferAttribute(newPos, 3));
  if (newNorm) cleaned.setAttribute('normal', new THREE.BufferAttribute(newNorm, 3));
  cleaned.setAttribute('color', new THREE.BufferAttribute(newColour, 3));
  cleaned.setIndex(new THREE.BufferAttribute(newIndex, 1));
  cleaned.computeBoundingSphere();
  cleaned.computeBoundingBox();
  mesh.geometry = cleaned;

  return {
    kept,
    removed: triCount - kept,
    emitterY,
  };
}

// ============================================================================
// Procedural fire group (raymarched bounded volume + GPU-only updates)
// ============================================================================

/** Local-space flame bounding box (in the VFX group's local frame). Origin = log top. */
const FLAME_AABB = {
  xMin: -0.18, xMax: 0.18,
  yMin: 0.0, yMax: 0.55,
  zMin: -0.18, zMax: 0.18,
} as const;

/** Maximum ray-march step count. Bounded to keep cost predictable on mobile. */
const RAYMARCH_STEPS = 28;

/**
 * Build a raymarched bounded flame volume. Uses `BackSide` so a single hit per ray picks
 * the back face (exit point); combined with a separate `onBeforeRender`-fed camera origin
 * and a vertex-derived direction, the integration sums densities entry → exit.
 */
function buildFlameVolume(rand: () => number): THREE.Mesh {
  const w = FLAME_AABB.xMax - FLAME_AABB.xMin;
  const h = FLAME_AABB.yMax - FLAME_AABB.yMin;
  const d = FLAME_AABB.zMax - FLAME_AABB.zMin;
  const geometry = new THREE.BoxGeometry(w, h, d);
  geometry.translate(
    (FLAME_AABB.xMin + FLAME_AABB.xMax) * 0.5,
    (FLAME_AABB.yMin + FLAME_AABB.yMax) * 0.5,
    (FLAME_AABB.zMin + FLAME_AABB.zMax) * 0.5,
  );

  const uniforms = {
    uTime: { value: 0 },
    uNight: { value: 0 },
    uWindX: { value: WIND_DIR.x },
    uWindZ: { value: WIND_DIR.y },
    uHot: { value: FIRE_COLORS.hotCore },
    uMid: { value: FIRE_COLORS.midFlame },
    uOuter: { value: FIRE_COLORS.outerFlame },
    uSeed: { value: rand() * 100.0 },
    uCameraOrigin: { value: new THREE.Vector3() },
    uLit: { value: 1 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    premultipliedAlpha: true,
    side: THREE.BackSide,
    vertexShader: `
      varying vec3 vLocalPos;
      void main() {
        vLocalPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uNight;
      uniform float uWindX;
      uniform float uWindZ;
      uniform float uSeed;
      uniform float uLit;
      uniform vec3 uHot;
      uniform vec3 uMid;
      uniform vec3 uOuter;
      uniform vec3 uCameraOrigin;

      varying vec3 vLocalPos;

      float hash13(vec3 p) {
        p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }
      float vnoise3(vec3 p) {
        vec3 i = floor(p);
        vec3 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
        float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
        float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
        float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
        float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
        float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
        float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
        float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
        float nx00 = mix(n000, n100, f.x);
        float nx10 = mix(n010, n110, f.x);
        float nx01 = mix(n001, n101, f.x);
        float nx11 = mix(n011, n111, f.x);
        float nxy0 = mix(nx00, nx10, f.y);
        float nxy1 = mix(nx01, nx11, f.y);
        return mix(nxy0, nxy1, f.z);
      }
      float fbm(vec3 p) {
        float a = 0.0, w = 0.5;
        for (int i = 0; i < 4; i++) {
          a += w * vnoise3(p);
          p *= 2.02;
          w *= 0.5;
        }
        return a;
      }

      // Sample flame density at a local-space point. Returns a density in [0, 1].
      float flameDensity(vec3 p) {
        // Local-AABB test so the integrator never reaches past the volume walls.
        if (any(lessThan(p, vec3(${(FLAME_AABB.xMin).toFixed(3)}, ${(FLAME_AABB.yMin).toFixed(3)}, ${(FLAME_AABB.zMin).toFixed(3)}))) ||
            any(greaterThan(p, vec3(${(FLAME_AABB.xMax).toFixed(3)}, ${(FLAME_AABB.yMax).toFixed(3)}, ${(FLAME_AABB.zMax).toFixed(3)})))) {
          return 0.0;
        }
        // Map y to 0 (base) → 1 (top). Height-domain fading prevents the volume from
        // looking like a glowing cube.
        float yNorm = clamp((p.y - ${(FLAME_AABB.yMin).toFixed(3)}) / ${((FLAME_AABB.yMax - FLAME_AABB.yMin)).toFixed(3)}, 0.0, 1.0);

        // Hot core sphere at the base — small, narrow.
        float coreR = length(p.xz);
        float core = (1.0 - smoothstep(0.0, 0.14, coreR)) * (1.0 - smoothstep(0.0, 0.18, yNorm));

        // Advected turbulent column — wind tilts tongues upward and slightly to the side.
        vec2 wind = vec2(uWindX, uWindZ) * yNorm * 0.18;
        vec3 q = vec3((p.xz - wind) * 18.0, p.y * 10.0 - uTime * 3.3 + uSeed);
        float turb = fbm(q);
        float radius = mix(0.16, 0.04, yNorm);
        float body = 1.0 - smoothstep(max(0.0, radius - 0.12), radius, length(p.xz - wind));
        body *= (1.0 - smoothstep(0.4, 1.0, yNorm));
        float tongues = smoothstep(0.26 + yNorm * 0.16, 0.58 + yNorm * 0.18, turb);
        float density = max(core, body * tongues);
        density *= 1.0 - smoothstep(0.72, 1.0, yNorm);
        // Fade all six volume edges; no illuminated box silhouette.
        density *= 1.0 - smoothstep(0.14, 0.18, max(abs(p.x), abs(p.z)));
        return clamp(density, 0.0, 1.0);
      }

      void main() {
        if (uLit < 0.5) discard;
        vec3 rayDir = normalize(vLocalPos - uCameraOrigin);
        vec3 safeDir = sign(rayDir) * max(abs(rayDir), vec3(0.00001));
        // sign(0)=0: explicitly keep an exactly axial ray finite.
        safeDir += vec3(equal(safeDir, vec3(0.0))) * 0.00001;
        vec3 inv = 1.0 / safeDir;
        vec3 t0 = (vec3(-0.18, 0.0, -0.18) - uCameraOrigin) * inv;
        vec3 t1 = (vec3(0.18, 0.55, 0.18) - uCameraOrigin) * inv;
        vec3 lo = min(t0, t1), hi = max(t0, t1);
        float entry = max(0.0, max(lo.x, max(lo.y, lo.z)));
        float exit = min(hi.x, min(hi.y, hi.z));
        if (exit <= entry) discard;
        float stepLen = (exit - entry) / float(${RAYMARCH_STEPS});
        vec3 p = uCameraOrigin + rayDir * (entry + stepLen * 0.5);
        vec3 accumulated = vec3(0.0);
        float alpha = 0.0;
        for (int i = 0; i < ${RAYMARCH_STEPS}; i++) {
          float density = flameDensity(p);
          float opacity = 1.0 - exp(-density * stepLen * 18.0);
          vec3 colour = mix(uOuter, uMid, smoothstep(0.12, 0.6, density));
          colour = mix(colour, uHot, smoothstep(0.55, 0.9, density));
          accumulated += (1.0 - alpha) * opacity * colour * (1.1 + 0.2 * uNight);
          alpha += (1.0 - alpha) * opacity;
          p += rayDir * stepLen;
        }
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(accumulated, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });

  const flame = new THREE.Mesh(geometry, material);
  flame.frustumCulled = false;
  // The raymarch enclosure is not model geometry: never highlight/pick its solid box.
  flame.userData.isRuntimeEffect = true;
  flame.renderOrder = 3;
  flame.castShadow = false;
  flame.receiveShadow = false;
  return flame;
}

/** CPU-baked smoke/sparks/embers — fixed seeds, all movement computed in the shader. */
function buildFireParticles(
  rand: () => number,
  kind: 'spark' | 'smoke' | 'ember',
  count: number,
): THREE.Points {
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const a = rand() * Math.PI * 2;
    const r = (0.02 + rand() * 0.10) * (kind === 'smoke' ? 2.4 : 1.0);
    positions[i * 3] = Math.cos(a) * r;
    positions[i * 3 + 1] = 0.01 + (kind === 'ember' ? rand() * 0.04 : rand() * 0.18);
    positions[i * 3 + 2] = Math.sin(a) * r;
    seeds[i] = rand();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  geometry.computeBoundingSphere();

  const uniforms = {
    uTime: { value: 0 },
    uNight: { value: 0 },
    uWindX: { value: WIND_DIR.x },
    uWindZ: { value: WIND_DIR.y },
    uColor: { value: kind === 'smoke' ? FIRE_COLORS.smoke : kind === 'ember' ? FIRE_COLORS.ember : FIRE_COLORS.midFlame },
    uPixelScale: { value: kind === 'smoke' ? 520 : kind === 'ember' ? 260 : 220 },
    uLift: { value: kind === 'smoke' ? 0.55 : kind === 'ember' ? 0.05 : 0.45 },
    uSize: { value: kind === 'smoke' ? 0.16 : kind === 'ember' ? 0.05 : 0.04 },
    uLifetime: { value: kind === 'smoke' ? 2.6 : kind === 'ember' ? 1.2 : 1.5 },
    uReduced: { value: 0 },
    uLit: { value: 1 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: kind === 'smoke' ? THREE.NormalBlending : THREE.AdditiveBlending,
    vertexShader: `
      attribute float aSeed;
      uniform float uTime;
      uniform float uNight;
      uniform float uWindX;
      uniform float uWindZ;
      uniform float uPixelScale;
      uniform float uLift;
      uniform float uSize;
      uniform float uLifetime;
      uniform float uReduced;
      uniform float uLit;
      varying float vSeed;
      varying float vLife;

      void main() {
        if (uLit < 0.5) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          vSeed = 0.0;
          vLife = 0.0;
          return;
        }
        vSeed = aSeed;
        // Staggered life cycle from the per-particle seed.
        float t = mod(uTime + aSeed * uLifetime, uLifetime);
        float life = clamp(t / uLifetime, 0.0, 1.0);
        vLife = life;

        // Exponential drag rises fast then asymptotes — the trajectory of real embers.
        float tau = uLifetime * 0.5;
        float disp = uLift * (1.0 - exp(-t / tau));
        vec2 wind = vec2(uWindX, uWindZ) * disp * 0.45;
        vec3 displaced = position + vec3(wind.x, disp, wind.y);

        // Reduced motion: freeze to the spawn ring; no rise or drift.
        if (uReduced > 0.5) {
          displaced = position + vec3(wind.x * 0.05, 0.02, wind.y * 0.05);
          life = mix(0.5, 1.0, fract(aSeed * 7.31));
        }

        vec4 mv = modelViewMatrix * vec4(displaced, 1.0);
        float size = uSize * (1.0 + 0.4 * sin(aSeed * 12.31));
        gl_PointSize = size * uPixelScale / max(0.001, -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uNight;
      uniform float uLit;
      varying float vSeed;
      varying float vLife;

      void main() {
        if (uLit < 0.5) discard;
        if (vLife <= 0.0 || vLife >= 1.0) discard;
        vec2 uv = gl_PointCoord * 2.0 - 1.0;
        float d = dot(uv, uv);
        if (d > 1.0) discard;
        float alpha = ${kind === 'smoke' ? '0.13 * exp(-3.8 * d) * (1.0 - smoothstep(0.55, 1.0, d))' : 'pow(1.0 - d, 1.6)'};
        float fadeIn = smoothstep(0.0, 0.18, vLife);
        float fadeOut = 1.0 - smoothstep(0.55, 1.0, vLife);
        float env = fadeIn * fadeOut;

        vec3 col = mix(uColor * 1.6, uColor * 0.45, vLife);
        col *= mix(0.55, 1.0, mix(uNight, 1.0, 0.4));
        gl_FragColor = vec4(col, alpha * env);
      }
    `,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = kind === 'smoke' ? 2 : 3;
  return points;
}

/** Public result interface for the procedural fire VFX group. */
export interface CampfireVfx {
  readonly group: THREE.Group;
  /** True while the fire is producing visible effects and lighting the surroundings. */
  readonly lit: boolean;
  tick(elapsed: number, nightAmount: number, reducedMotion: boolean): void;
  /** Suppress flame/sparks/embers/smoke and zero the point light. Idempotent. */
  extinguish(): void;
  /** Restore flame/sparks/embers/smoke and re-light at a sun-correct intensity. Idempotent. */
  relight(): void;
  /** Detach tick callbacks so subsequent methods are no-ops. Idempotent. */
  dispose(): void;
}

/**
 * Build the procedural fire VFX group. The returned group's local origin sits exactly at
 * the log-top emission point: the flame volume base is at y=0, sparks/smoke/embers are
 * emitted at y=0, and the point-light is centred at y=0. Main places the group at
 * `ground + emitterY` and `.attach()`es it to the retained mesh.
 */
export function createCampfireVfx(): CampfireVfx {
  const rand = mulberry32(0xA1B2C3D4);
  const group = new THREE.Group();
  group.name = '';

  const flame = buildFlameVolume(rand);
  const sparks = buildFireParticles(rand, 'spark', 48);
  const embers = buildFireParticles(rand, 'ember', 32);
  const smoke = buildFireParticles(rand, 'smoke', 28);

  // All descendants are deliberately unnamed — they remain part of the single selectable
  // "Campfire" prop under the inspect panel and follow isolate/explode as a unit.
  flame.name = '';
  sparks.name = '';
  embers.name = '';
  smoke.name = '';

  // Warm point-light at the emitter origin. Lives at y=0 in the group's local frame.
  const light = new THREE.PointLight(FIRE_COLORS.outerFlame.getHex(), 1.4, 4.5, 1.7);
  light.position.set(0, 0.05, 0);
  light.castShadow = false;
  light.name = '';
  group.add(light);

  group.add(flame, sparks, embers, smoke);

  // Cache uniform refs so the tick closure mutates the same objects each frame — no
  // per-frame allocations.
  const flameUniforms = (flame.material as THREE.ShaderMaterial).uniforms;
  const sparkUniforms = (sparks.material as THREE.ShaderMaterial).uniforms;
  const emberUniforms = (embers.material as THREE.ShaderMaterial).uniforms;
  const smokeUniforms = (smoke.material as THREE.ShaderMaterial).uniforms;

  // Reusable world→local Matrix4 + Vector3 so onBeforeRender doesn't allocate.
  const tmpInv = new THREE.Matrix4();
  const tmpCam = new THREE.Vector3();
  const tmpLocal = new THREE.Vector3();

  flame.onBeforeRender = (_renderer, _scene, camera) => {
    tmpInv.copy(flame.matrixWorld).invert();
    tmpCam.setFromMatrixPosition(camera.matrixWorld);
    tmpLocal.copy(tmpCam).applyMatrix4(tmpInv);
    flameUniforms.uCameraOrigin.value.copy(tmpLocal);
  };

  let effectTime = 0;
  let lit = true;
  let disposed = false;

  const extinguish = (): void => {
    if (disposed || !lit) return;
    lit = false;
    // Hidden-individually so isolate/explode and inspector re-shows stay safe. The shader
    // discard is the authoritative off; per-object visibility gives correct occlusion
    // against other props when the viewer flips visibility back without re-issuing relight().
    flame.visible = false;
    sparks.visible = false;
    embers.visible = false;
    smoke.visible = false;
    flameUniforms.uLit.value = 0;
    sparkUniforms.uLit.value = 0;
    emberUniforms.uLit.value = 0;
    smokeUniforms.uLit.value = 0;
    light.intensity = 0;
  };

  const relight = (): void => {
    if (disposed || lit) return;
    lit = true;
    flame.visible = true;
    sparks.visible = true;
    embers.visible = true;
    smoke.visible = true;
    flameUniforms.uLit.value = 1;
    sparkUniforms.uLit.value = 1;
    emberUniforms.uLit.value = 1;
    smokeUniforms.uLit.value = 1;
    light.intensity = 0.55; // The next tick supplies day/night-correct flicker.
  };

  const tick = (elapsed: number, nightAmount: number, reducedMotion: boolean): void => {
    if (disposed) return;
    const night = THREE.MathUtils.clamp(nightAmount, 0, 1);
    if (!reducedMotion) effectTime = elapsed;
    flameUniforms.uTime.value = effectTime;
    flameUniforms.uNight.value = night;
    sparkUniforms.uTime.value = effectTime;
    sparkUniforms.uNight.value = night;
    sparkUniforms.uReduced.value = reducedMotion ? 1 : 0;
    emberUniforms.uTime.value = effectTime;
    emberUniforms.uNight.value = night;
    emberUniforms.uReduced.value = reducedMotion ? 1 : 0;
    smokeUniforms.uTime.value = effectTime;
    smokeUniforms.uNight.value = night;
    smokeUniforms.uReduced.value = reducedMotion ? 1 : 0;

    // While extinguished: never relight or raise intensity. Inspector re-show events will
    // see lit=false (per-object visibility + shader discard), so day/night ticks stay off.
    if (!lit) {
      if (light.intensity !== 0) light.intensity = 0;
      return;
    }

    const fast = 0.85 + 0.18 * Math.sin(effectTime * 9.3) * Math.sin(effectTime * 2.7 + 0.4);
    const slow = 0.92 + 0.10 * Math.sin(effectTime * 1.7 - 0.6);
    const flicker = THREE.MathUtils.clamp(fast * slow, 0.55, 1.25);
    flame.scale.set(
      0.97 + 0.05 * Math.sin(effectTime * 2.4),
      1.0 + 0.07 * (flicker - 0.85),
      0.97 + 0.05 * Math.cos(effectTime * 2.7),
    );

    const baseIntensity = THREE.MathUtils.lerp(0.55, 2.2, night);
    light.intensity = baseIntensity * (0.85 + 0.15 * flicker);
  };

  const dispose = (): void => {
    if (disposed) return;
    extinguish();
    disposed = true;
    // Geometry/material disposal belongs to Viewer.
    flame.onBeforeRender = () => {};
  };


  return {
    group,
    get lit(): boolean { return lit; },
    tick,
    extinguish,
    relight,
    dispose,
  };
}