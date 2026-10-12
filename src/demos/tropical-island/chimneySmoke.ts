import * as THREE from 'three';
import { DAY_NIGHT_SECONDS } from './environment';

// Analytic parcel transport: buoyant rise slows with entrainment, while the
// emission-time noise moves with the plume instead of boiling in a fixed tube.
// Bounds contain the wind-bent plume; its base remains at the chimney mouth.
const SMOKE_AABB = {
  xMin: -0.8,
  xMax: 2.5,
  yMin: 0.0,
  yMax: 3.2,
  zMin: -0.8,
  zMax: 1.5,
} as const;

// Bounded raymarch step count. Fixed to keep mobile cost predictable.
const RAYMARCH_STEPS = 30;

// Prevailing wind in scene-local coordinates — must match palmWind.ts so the
// visible lean agrees with the bent foliage.
const WIND_X = 0.92;
const WIND_Z = 0.39;

// y(age) = AGE_V * log(1 + AGE_K * age / AGE_V).
const AGE_V = 2.2;
const AGE_K = 1.4;

export interface ChimneySmoke {
  /** Group whose local origin sits at the chimney cap opening (parent places at .80). */
  readonly group: THREE.Group;
  /**
   * Advance the shader clocks. `elapsed` is the active-viewer time in seconds,
   * `daylight` is 1=full daylight / 0=night. `reducedMotion` HOLDS the clock so
   * the plume freezes; appearance is never swapped.
   */
  tick(elapsed: number, daylight: number, reducedMotion: boolean): void;
  /** Detach from parent and dispose owned geometry/material. Idempotent. */
  dispose(): void;
}

function buildSmokeVolume(seed: number): THREE.Mesh {
  const w = SMOKE_AABB.xMax - SMOKE_AABB.xMin;
  const h = SMOKE_AABB.yMax - SMOKE_AABB.yMin;
  const d = SMOKE_AABB.zMax - SMOKE_AABB.zMin;
  const geometry = new THREE.BoxGeometry(w, h, d);
  geometry.translate(
    (SMOKE_AABB.xMin + SMOKE_AABB.xMax) * 0.5,
    (SMOKE_AABB.yMin + SMOKE_AABB.yMax) * 0.5,
    (SMOKE_AABB.zMin + SMOKE_AABB.zMax) * 0.5,
  );

  const uniforms = {
    uTime: { value: 0 },
    uDaylight: { value: 1 },
    uWindX: { value: WIND_X },
    uWindZ: { value: WIND_Z },
    uSeed: { value: seed },
    uCameraOrigin: { value: new THREE.Vector3() },
    uLightDirection: { value: new THREE.Vector3(-0.4, 0.9, 0.3).normalize() },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
    side: THREE.BackSide,
    vertexShader: /* glsl */ `
      varying vec3 vLocalPos;
      void main() {
        vLocalPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;

      uniform float uTime;
      uniform float uDaylight;
      uniform float uWindX;
      uniform float uWindZ;
      uniform float uSeed;
      uniform vec3 uCameraOrigin;
      uniform vec3 uLightDirection;

      varying vec3 vLocalPos;

      const vec3 BOX_MIN = vec3(${SMOKE_AABB.xMin.toFixed(3)}, ${SMOKE_AABB.yMin.toFixed(3)}, ${SMOKE_AABB.zMin.toFixed(3)});
      const vec3 BOX_MAX = vec3(${SMOKE_AABB.xMax.toFixed(3)}, ${SMOKE_AABB.yMax.toFixed(3)}, ${SMOKE_AABB.zMax.toFixed(3)});
      const vec3 BOX_SIZE = vec3(${(SMOKE_AABB.xMax - SMOKE_AABB.xMin).toFixed(3)},
                                 ${(SMOKE_AABB.yMax - SMOKE_AABB.yMin).toFixed(3)},
                                 ${(SMOKE_AABB.zMax - SMOKE_AABB.zMin).toFixed(3)});

      // ----- noise primitives (kept very cheap) -----
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
        return mix(mix(nx00, nx10, f.y), mix(nx01, nx11, f.y), f.z);
      }
      float fbm2(vec3 p) {
        return 0.6 * vnoise3(p) + 0.3 * vnoise3(p * 2.03 + vec3(11.7));
      }

      float smokeDensity(vec3 p) {
        if (any(lessThan(p, BOX_MIN)) || any(greaterThan(p, BOX_MAX))) return 0.0;
        float age = (${AGE_V.toFixed(3)} / ${AGE_K.toFixed(3)})
          * (exp(max(p.y, 0.0) / ${AGE_V.toFixed(3)}) - 1.0);
        float emission = uTime - age + uSeed * 13.0;

        // Emission-coherent expansion makes rolling parcels, not a fixed tube.
        float radius = 0.10 + 0.32 * (1.0 - exp(-age * 0.55));
        radius *= 1.0 + 0.30 * sin(emission * 2.8) * smoothstep(0.0, 0.6, age);

        // Wind bending: cumulative lateral drift proportional to age (slows
        // near the top so the head dissipates rather than slingshots away).
        vec2 center = vec2(uWindX, uWindZ)
          * (0.22 * age + 0.05 * age * age - 0.012 * age * age * age);
        // Small parcel-coherent wiggle around the bent spine; bounded in radius.
        center += 0.42 * radius * smoothstep(0.0, 1.6, age)
          * vec2(sin(emission * 1.9 + uSeed * 1.3),
                 cos(emission * 2.6 + uSeed * 0.7));

        vec2 rel = p.xz - center;
        float r = length(rel);

        // Domain-warped FBM sampled in emission-time space so the noise pattern
        // travels with the parcel rather than boiling in a fixed tube. The warp
        // itself is bounded and only depends on local position + emission, so
        // the base of the column stays connected to the chimney mouth.
        vec3 q = vec3(rel / max(radius, 0.05), emission * 0.55)
                + vec3(uSeed * 4.7, uSeed * 9.1, uSeed * 2.3);
        vec3 warp = vec3(
          vnoise3(q * 1.4 + vec3( 1.7, 9.3, uSeed * 3.1)) - 0.5,
          vnoise3(q * 1.4 + vec3( 8.2, 0.4, uSeed * 2.0)) - 0.5,
          vnoise3(q * 1.4 + vec3( 3.9, 5.5, uSeed * 5.7)) - 0.5
        ) * (0.55 + 0.4 * smoothstep(0.0, 1.5, age));
        q += warp;

        float coarse = fbm2(q);
        float detail = fbm2(q * 2.8 + vec3(age * 0.17, emission * 0.6, 0.0));
        float fluffy = coarse * 0.8 + detail * 0.2;

        // Soft Gaussian-shaped column instead of a hard cylindrical body. The
        // outer envelope is wide and feathered so edges melt into air.
        float profile = exp(-pow(r / radius, 2.2));

        // Billowing: keep the densest cores near the spine, carve softer holes
        // farther out. Erosion lifts noise into cloud-shaped voids as the
        // parcel ages and entrains air.
        float softCore = profile * smoothstep(0.17, 0.78, fluffy + 0.08);
        float carve = smoothstep(0.62, 0.92, fluffy);
        float body = mix(softCore, softCore * (1.0 - carve * 0.55),
                         smoothstep(0.05, 0.45, age));

        // Nonzero radial support at the mouth blends into the eroded billows.
        float sourceFloor = exp(-pow(r / max(radius, 0.05), 2.0))
                            * (0.45 + 0.55 * smoothstep(0.0, 0.10, age))
                            * (1.0 - smoothstep(0.18, 0.55, age));
        // Outer wisps: thin tail of low-density cloud extending past the core.
        float wisp = exp(-pow(max(r - radius * 0.85, 0.0) / (radius * 0.85), 2.0))
                     * smoothstep(0.35, 1.4, fluffy - 0.25)
                     * smoothstep(0.25, 1.2, age);

        // Keep the source connected without adding a disk or hard base.
        float density = body + 0.32 * wisp + 0.55 * sourceFloor;

        // Slow thinning with altitude (buoyancy slows near top, disperses air).
        density *= 1.0 - smoothstep(2.0, 4.2, age);
        // Compress optical density so overlapping parcels remain translucent.
        density = density / (1.0 + density * 1.6);

        vec3 boxUV = (p - BOX_MIN) / BOX_SIZE;
        // Soft lateral fade instead of a sharp box wall — eliminates visible
        // enclosure edges without letting density bleed past the bounds.
        float sideFade = min(min(boxUV.x, 1.0 - boxUV.x), min(boxUV.z, 1.0 - boxUV.z));
        float topFade = smoothstep(0.0, 0.18, 1.0 - boxUV.y);
        float wallFade = smoothstep(0.0, 0.18, sideFade);
        return density * wallFade * topFade;
      }

      // (Forward-scatter sample is inlined into the main loop below — one
      // extra density evaluation per fragment step, no nested march.)

      void main() {
        vec3 rayDir = normalize(vLocalPos - uCameraOrigin);
        vec3 safeDir = sign(rayDir) * max(abs(rayDir), vec3(0.00001));
        safeDir += vec3(equal(safeDir, vec3(0.0))) * 0.00001;
        vec3 inv = 1.0 / safeDir;
        vec3 t0 = (BOX_MIN - uCameraOrigin) * inv;
        vec3 t1 = (BOX_MAX - uCameraOrigin) * inv;
        vec3 lo = min(t0, t1);
        vec3 hi = max(t0, t1);
        float entry = max(0.0, max(lo.x, max(lo.y, lo.z)));
        float exit = min(hi.x, min(hi.y, hi.z));
        if (exit <= entry) discard;

        float stepLen = (exit - entry) / float(${RAYMARCH_STEPS});
        vec3 p = uCameraOrigin + rayDir * (entry + stepLen * 0.5);

        vec3 dayCol = vec3(0.66, 0.66, 0.67);
        vec3 nightCol = vec3(0.18, 0.19, 0.22);
        vec3 baseCol = mix(nightCol, dayCol, clamp(uDaylight, 0.0, 1.0));

        float alpha = 0.0;
        vec3 col = vec3(0.0);
        for (int i = 0; i < ${RAYMARCH_STEPS}; i++) {
          float density = smokeDensity(p);
          if (density > 0.001) {
            // Beer-Lambert integration with low optical depth.
            float opacity = 1.0 - exp(-density * stepLen * 3.2);
            // Forward-scatter sampling toward the dominant light direction.
            float lit = exp(-smokeDensity(p + uLightDirection * 0.14) * 1.2);
            // Density-dependent grey value: dense cores brighter, edges soft.
            float grey = mix(0.46, 0.95, smoothstep(0.08, 0.55, density));
            vec3 c2 = baseCol * grey * mix(0.58, 1.0, lit);

            // Convert premultiplied accumulation to straight alpha once.
            col += (1.0 - alpha) * opacity * c2;
            alpha += (1.0 - alpha) * opacity;
          }

          // Bound work when several billows overlap.
          if (alpha > 0.96) break;

          p += rayDir * stepLen;
        }

        if (alpha < 0.01) discard;
        gl_FragColor = vec4(col / alpha, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });

  const volume = new THREE.Mesh(geometry, material);
  volume.frustumCulled = false;
  volume.userData.isRuntimeEffect = true;
  volume.userData.isPointerTransparent = true;
  volume.userData.explodeWithParent = true;
  volume.renderOrder = 2;
  volume.castShadow = false;
  volume.receiveShadow = false;
  volume.name = '';
  return volume;
}

/**
 * Build a procedural chimney smoke controller. The returned group's local origin
 * sits exactly at the chimney cap opening: the volume base is at y=0 and the
 * plume rises through SMOKE_AABB.yMax. Main places the group at parent-local
 * y=0.80 (just above the cap) and `.attach()`es it to the retained chimney
 * group, so explode/assemble, isolation, scale and parent transforms propagate.
 *
 * Optional `seed` lets main vary the deterministic plume phase; the same seed
 * always produces the same plume shape.
 */
export function createChimneySmoke(seed?: number): ChimneySmoke {
  const seedValue = seed ?? 1.37;
  const group = new THREE.Group();
  group.name = 'Chimney smoke';
  group.userData.isRuntimeEffect = true;
  group.userData.isPointerTransparent = true;
  group.userData.explodeWithParent = true;

  const volume = buildSmokeVolume(seedValue);
  group.add(volume);

  // Reusable world→local Matrix4 + Vector3 so onBeforeRender doesn't allocate.
  const tmpInv = new THREE.Matrix4();
  const tmpCam = new THREE.Vector3();
  const tmpLocal = new THREE.Vector3();
  const lightPosition = new THREE.Vector3(-7, 11, 4);

  const uniforms = (volume.material as THREE.ShaderMaterial).uniforms;
  volume.onBeforeRender = (_renderer, _scene, camera): void => {
    tmpInv.copy(volume.matrixWorld).invert();
    tmpCam.setFromMatrixPosition(camera.matrixWorld);
    tmpLocal.copy(tmpCam).applyMatrix4(tmpInv);
    uniforms.uCameraOrigin.value.copy(tmpLocal);
    tmpLocal.setFromMatrixPosition(volume.matrixWorld);
    uniforms.uLightDirection.value.copy(lightPosition).sub(tmpLocal).transformDirection(tmpInv);
  };

  let effectTime = 0;
  let disposed = false;

  return {
    group,
    tick(elapsed: number, daylight: number, reducedMotion: boolean): void {
      if (disposed) return;
      // Reduced motion holds the clock; appearance is never swapped.
      if (!reducedMotion) effectTime = elapsed;
      uniforms.uTime.value = effectTime;
      uniforms.uDaylight.value = THREE.MathUtils.clamp(daylight, 0, 1);
      const angle = effectTime / DAY_NIGHT_SECONDS * Math.PI * 2;
      const elevation = Math.cos(angle);
      const visibleLight = elevation >= 0 ? 1 : -1;
      lightPosition.set(-7 * elevation, 11 * elevation, 4 + 9 * Math.sin(angle)).multiplyScalar(visibleLight);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      volume.onBeforeRender = THREE.Object3D.prototype.onBeforeRender;
      // Detach from any parent; owned geometry/material are disposed here once.
      if (group.parent) group.parent.remove(group);
      volume.geometry.dispose();
      (volume.material as THREE.Material).dispose();
    },
  };
}
