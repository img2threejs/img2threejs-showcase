/** Hot-water contact steam: a soft, white-gray translucent condensed-vapor plume. */
import * as THREE from 'three';

// Plume lives inside one shared raymarch box. Base at y=0, top at yMax. The
// footprint is narrower than the height; height is the binding axis.
const STEAM_AABB = {
  xMin: -1.4,
  xMax: 1.4,
  yMin: 0.0,
  yMax: 3.2,
  zMin: -1.2,
  zMax: 1.2,
} as const;

// Raymarch step cap, per the contract.
const RAYMARCH_STEPS = 24;

// Prevailing wind in scene-local coordinates. Must match chimneySmoke.ts and
// palmWind.ts so the visible vapor lean agrees with the bent foliage.
const WIND_X = 0.92;
const WIND_Z = 0.39;

// Buoyant rise: parcel vertical position grows like AGE_V * log(1+AGE_K*t/AGE_V),
// matching chimneySmoke.ts. The inverse (travelAge from p.y) drives per-fragment
// parcel advection so the noise/wind/radius travel with the parcel, not with
// wall-clock age.
const AGE_V = 1.6;
const AGE_K = 1.2;

// Finite cooling curve. Source is zero at t=0, smooth ramp up to a pulse
// plateau, then tapers to zero by COOL_PULSE_END. Any parcel older than
// PARCEL_FADE_AGE contributes nothing. TOTAL_DURATION is COOL_PULSE_END plus
// the maximum remaining travelAge for a parcel to clear the box, and bounds
// the slot retirement check in tick.
const COOL_PULSE_END = 0.75;
const PARCEL_FADE_AGE = 2.8;
const TOTAL_DURATION = COOL_PULSE_END + PARCEL_FADE_AGE;

// Base radius scale; widens the visible impact footprint so the puff reads
// as a broad contact, not a thin thread.
const BASE_RADIUS = 0.4;

export interface EntrySteam {
  /** Group whose local origin sits at the hot-water contact site. */
  readonly group: THREE.Group;
  /** True once the plume has fully cooled and dissipated; caller can recycle. */
  readonly finished: boolean;
  /**
   * Start emission at the actual water contact site. `radius` widens the
   * initial contact footprint so a bigger splash reads as a bigger plume.
   * Resets the slot's physical clock to 0 and clears `finished`.
   */
  begin(x: number, y: number, z: number, radius: number): void;
  /**
   * Advance the shader clock. `relativeAge` is the physical contact age in
   * seconds measured from the most recent `begin()` (NOT wall-clock, NOT
   * cumulative across reuses). `daylight` is 1=full daylight / 0=night.
   * Marks the slot finished once the relative age has fully passed.
   */
  tick(relativeAge: number, daylight: number): void;
  /** Hide the volume and reset the slot for reuse. Does not detach. */
  hide(): void;
}

/**
 * Build a pool of independent hot-water contact steam plumes. The factory
 * owns one shared raymarch box geometry plus one ShaderMaterial per slot.
 *
 * Each slot's `group` is independent and can be added to the scene freely.
 * Repeated `begin` calls reuse a slot; a disposed factory cannot resurrect
 * any of its slots.
 */
export function createEntrySteams(count: number): {
  steams: EntrySteam[];
  dispose(): void;
} {
  const sharedGeometry = new THREE.BoxGeometry(
    STEAM_AABB.xMax - STEAM_AABB.xMin,
    STEAM_AABB.yMax - STEAM_AABB.yMin,
    STEAM_AABB.zMax - STEAM_AABB.zMin,
  );
  sharedGeometry.translate(
    (STEAM_AABB.xMin + STEAM_AABB.xMax) * 0.5,
    (STEAM_AABB.yMin + STEAM_AABB.yMax) * 0.5,
    (STEAM_AABB.zMin + STEAM_AABB.zMax) * 0.5,
  );

  const inverse = new THREE.Matrix4();
  const cameraLocal = new THREE.Vector3();
  const lightWorld = new THREE.Vector3(-7, 11, 4);
  const lightLocal = new THREE.Vector3();
  const materials: THREE.ShaderMaterial[] = [];
  const steams: EntrySteam[] = [];
  let disposed = false;

  for (let i = 0; i < count; i++) {
    const group = new THREE.Group();
    group.name = 'Entry steam';
    group.visible = false;
    group.userData.isRuntimeEffect = true;
    group.userData.isPointerTransparent = true;
    group.userData.explodeWithParent = true;

    const seed = i * 0.317 + 1.137;
    const uniforms = {
      uTime: { value: 0 },
      uDaylight: { value: 1 },
      uWindX: { value: WIND_X },
      uWindZ: { value: WIND_Z },
      uSeed: { value: seed },
      uFootprint: { value: 1 },
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
        uniform float uFootprint;
        uniform vec3 uCameraOrigin;
        uniform vec3 uLightDirection;

        varying vec3 vLocalPos;

        const vec3 BOX_MIN = vec3(${STEAM_AABB.xMin.toFixed(3)}, ${STEAM_AABB.yMin.toFixed(3)}, ${STEAM_AABB.zMin.toFixed(3)});
        const vec3 BOX_MAX = vec3(${STEAM_AABB.xMax.toFixed(3)}, ${STEAM_AABB.yMax.toFixed(3)}, ${STEAM_AABB.zMax.toFixed(3)});
        const vec3 BOX_SIZE = vec3(${(STEAM_AABB.xMax - STEAM_AABB.xMin).toFixed(3)},
                                   ${(STEAM_AABB.yMax - STEAM_AABB.yMin).toFixed(3)},
                                   ${(STEAM_AABB.zMax - STEAM_AABB.zMin).toFixed(3)});

        // Finite source envelope on emissionTime: smooth pulse, zero outside
        // [0, COOL_PULSE_END]. Cooling pulse is the visible burst that the
        // hot stone produces on contact; it dominates the early frame and
        // then the residual cloud (driven by parcel fade) carries the rest.
        const float COOL_PULSE_END = ${COOL_PULSE_END.toFixed(3)};
        const float PARCEL_FADE_AGE = ${PARCEL_FADE_AGE.toFixed(3)};
        const float BASE_RADIUS = ${BASE_RADIUS.toFixed(3)};

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
          float n011 = hash13(i + vec3(0.0, 1.0, 0.0));
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

        // Inverse of the buoyancy curve: given a local Y, how long has the
        // parcel that is currently at this Y been alive? travelAge=0 at y=0.
        float travelAgeFromY(float y) {
          float t = ${AGE_V.toFixed(3)} / ${AGE_K.toFixed(3)}
            * (exp(max(y, 0.0) / ${AGE_V.toFixed(3)}) - 1.0);
          return t;
        }

        // Smooth source envelope: rises from 0 to 1 over the first 0.18s of
        // emissionTime, then holds, then tapers to 0 by COOL_PULSE_END.
        // Outside [0, COOL_PULSE_END] the source contributes nothing.
        float sourceEnvelope(float emissionTime) {
          if (emissionTime < 0.0 || emissionTime > COOL_PULSE_END) return 0.0;
          float ramp = smoothstep(0.0, 0.18, emissionTime);
          float tail = 1.0 - smoothstep(COOL_PULSE_END - 0.30, COOL_PULSE_END, emissionTime);
          return ramp * tail;
        }

        // Smooth parcel fade for the residual cloud: full strength until the
        // parcel is half its lifetime, then a smooth ramp to zero by
        // PARCEL_FADE_AGE. Returns 0 outside [0, PARCEL_FADE_AGE].
        float parcelFade(float travelAge) {
          if (travelAge < 0.0 || travelAge > PARCEL_FADE_AGE) return 0.0;
          return 1.0 - smoothstep(0.5 * PARCEL_FADE_AGE, PARCEL_FADE_AGE, travelAge);
        }

        float steamDensity(vec3 p) {
          if (any(lessThan(p, BOX_MIN)) || any(greaterThan(p, BOX_MAX))) return 0.0;

          float travelAge = travelAgeFromY(p.y);
          float emissionTime = uTime - travelAge;
          if (emissionTime < 0.0) return 0.0;

          float source = sourceEnvelope(emissionTime);
          float fade = parcelFade(travelAge);
          if (source <= 0.0 || fade <= 0.0) return 0.0;

          // Wind-bent spine, advected by travelAge so it bends with the
          // parcel that is currently at this Y, not with wall-clock age.
          vec2 center = vec2(uWindX, uWindZ)
            * (0.18 * travelAge + 0.05 * travelAge * travelAge
               - 0.012 * travelAge * travelAge * travelAge);
          // Small parcel-coherent wiggle around the bent spine.
          center += 0.42 * BASE_RADIUS * smoothstep(0.0, 1.6, travelAge)
            * vec2(sin(emissionTime * 1.9 + uSeed * 1.3),
                   cos(emissionTime * 2.6 + uSeed * 0.7));

          // Parcel radius grows with travelAge so the column visibly expands
          // as it rises. uFootprint scales the entire visible body.
          float radius = (BASE_RADIUS * (1.0 + 1.2 * (1.0 - exp(-travelAge * 0.55))))
                         * clamp(uFootprint, 0.5, 2.0);

          vec2 rel = p.xz - center;
          float r = length(rel);

          // Domain-warped FBM sampled in emission-time space so the noise
          // travels with the parcel. q encodes the parcel's emission clock,
          // not the current frame, so reuses stay coherent.
          vec3 q = vec3(rel / max(radius, 0.05), emissionTime * 0.55)
                  + vec3(uSeed * 4.7, uSeed * 9.1, uSeed * 2.3);
          vec3 warp = vec3(
            vnoise3(q * 1.4 + vec3( 1.7, 9.3, uSeed * 3.1)) - 0.5,
            vnoise3(q * 1.4 + vec3( 8.2, 0.4, uSeed * 2.0)) - 0.5,
            vnoise3(q * 1.4 + vec3( 3.9, 5.5, uSeed * 5.7)) - 0.5
          ) * (0.55 + 0.4 * smoothstep(0.0, 1.5, travelAge));
          q += warp;

          float coarse = fbm2(q);
          float detail = fbm2(q * 2.8 + vec3(travelAge * 0.17, emissionTime * 0.6, 0.0));
          float fluffy = coarse * 0.8 + detail * 0.2;

          // Soft Gaussian radial profile so edges melt into the air.
          float profile = exp(-pow(r / radius, 2.2));

          // Billowing: dense cores near the spine, softer holes farther out
          // so vapor reads as cloud-shaped voids, not a solid wall.
          float softCore = profile * smoothstep(0.18, 0.78, fluffy + 0.08);
          float carve = smoothstep(0.62, 0.92, fluffy);
          float body = mix(softCore, softCore * (1.0 - carve * 0.55),
                           smoothstep(0.05, 0.45, travelAge));

          // Outer wisps: thin low-density cloud extending past the core.
          float wisp = exp(-pow(max(r - radius * 0.85, 0.0) / (radius * 0.85), 2.0))
                       * smoothstep(0.35, 1.4, fluffy - 0.25)
                       * smoothstep(0.25, 1.2, travelAge);

          // Source floor: nonzero radial support at the water surface for the
          // duration of the cooling pulse, so the plume visibly emerges from
          // the contact site. Travels with emissionTime, not travelAge.
          float sourceFloor = exp(-pow(r / max(radius, 0.05), 2.0))
                              * smoothstep(0.0, 0.10, emissionTime)
                              * (1.0 - smoothstep(COOL_PULSE_END - 0.20, COOL_PULSE_END, emissionTime))
                              * (1.0 - smoothstep(0.0, 0.6, p.y / radius));

          // Soft top wall: residual cloud thins out as it approaches the
          // ceiling so the box never reads as a sharp top cap.
          float topFade = smoothstep(0.0, 0.4, BOX_MAX.y - p.y);

          float density = (body + 0.32 * wisp + 0.55 * sourceFloor)
                          * source * fade * topFade;
          // Compress optical depth so overlapping parcels stay translucent.
          density = density / (1.0 + density * 1.6);

          vec3 boxUV = (p - BOX_MIN) / BOX_SIZE;
          // Soft lateral fade so the box walls never read as enclosure edges.
          float sideFade = min(min(boxUV.x, 1.0 - boxUV.x), min(boxUV.z, 1.0 - boxUV.z));
          float wallFade = smoothstep(0.0, 0.18, sideFade);
          return density * wallFade;
        }

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

          // Soft white/gray translucent vapor, brighter in daylight. No fire
          // palette; night reading is a cool, low-luminance vapor.
          vec3 dayCol = vec3(0.94, 0.95, 0.96);
          vec3 nightCol = vec3(0.46, 0.49, 0.55);
          vec3 baseCol = mix(nightCol, dayCol, clamp(uDaylight, 0.0, 1.0));

          float alpha = 0.0;
          vec3 col = vec3(0.0);
          for (int i = 0; i < ${RAYMARCH_STEPS}; i++) {
            float density = steamDensity(p);
            if (density > 0.001) {
              float opacity = 1.0 - exp(-density * stepLen * 3.0);
              // Forward-scatter sample toward the dominant light direction.
              float lit = exp(-steamDensity(p + uLightDirection * 0.14) * 1.1);
              // Density-dependent grey value: dense cores brighter, edges soft.
              float grey = mix(0.55, 0.98, smoothstep(0.08, 0.55, density));
              vec3 c2 = baseCol * grey * mix(0.62, 1.0, lit);

              col += (1.0 - alpha) * opacity * c2;
              alpha += (1.0 - alpha) * opacity;
            }

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

    const volume = new THREE.Mesh(sharedGeometry, material);
    volume.frustumCulled = false;
    volume.userData.isRuntimeEffect = true;
    volume.userData.isPointerTransparent = true;
    volume.userData.explodeWithParent = true;
    volume.renderOrder = 3;
    volume.castShadow = false;
    volume.receiveShadow = false;
    volume.name = '';
    volume.onBeforeRender = (_renderer, _scene, camera): void => {
      inverse.copy(volume.matrixWorld).invert();
      cameraLocal.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inverse);
      uniforms.uCameraOrigin.value.copy(cameraLocal);
      lightLocal.setFromMatrixPosition(volume.matrixWorld);
      lightWorld.sub(lightLocal).transformDirection(inverse);
      uniforms.uLightDirection.value.copy(lightWorld);
      lightWorld.set(-7, 11, 4);
    };
    group.add(volume);
    materials.push(material);

    let slotFinished = true;
    let active = false;

    steams.push({
      group,
      get finished(): boolean { return slotFinished; },
      begin(x: number, y: number, z: number, radius: number): void {
        if (disposed) return;
        group.position.set(x, y, z);
        group.visible = true;
        active = true;
        // The shader clock is physical contact age measured from this begin().
        // tick() will overwrite uTime each frame; setting it to 0 here
        // guarantees the first frame reads as t=0 even if tick() is delayed.
        uniforms.uTime.value = 0;
        // Footprint widens with the splash radius; clamped so the visible
        // body never escapes the shared box.
        uniforms.uFootprint.value = THREE.MathUtils.clamp(radius / 0.72, 0.5, 2.0);
        slotFinished = false;
      },
      tick(relativeAge: number, daylight: number): void {
        if (disposed || !active) return;
        uniforms.uTime.value = Math.max(0, relativeAge);
        uniforms.uDaylight.value = THREE.MathUtils.clamp(daylight, 0, 1);
        if (!slotFinished && relativeAge >= TOTAL_DURATION) {
          slotFinished = true;
          group.visible = false;
          active = false;
        }
      },
      hide(): void {
        active = false;
        slotFinished = true;
        group.visible = false;
        uniforms.uTime.value = 0;
        uniforms.uFootprint.value = 1;
      },
    });
  }

  return {
    steams,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      // A disposed factory cannot resurrect anything. Each slot's group is
      // detached from its parent; the shared geometry and every per-slot
      // material are disposed exactly once.
      for (const steam of steams) {
        steam.hide();
        steam.group.removeFromParent();
      }
      for (const material of materials) material.dispose();
      sharedGeometry.dispose();
    },
  };
}
