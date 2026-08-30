import * as THREE from 'three';
import { LIFE_HUE } from './measured';

/**
 * Bioluminescent sap veins running through the bark.
 *
 * This is the effect that turns the figure from a dead log into something alive: light travelling
 * up inside the wood, brightest in the deep grain, fading out across the shoulders and the crown.
 * It is the character's own surface glowing, not a decal laid over it.
 *
 * WHY A PATCHED MeshStandardMaterial AND NOT A ShaderMaterial. The veins have to survive skinning
 * and stay lit by the scene, and reimplementing three's skinning plus its PBR lighting in a raw
 * ShaderMaterial to add one emissive term would be a large amount of code to keep in sync with the
 * renderer. `onBeforeCompile` keeps both for free. The hook is `<emissivemap_fragment>`, which is
 * where three assigns `totalEmissiveRadiance` — adding to it afterwards is the supported way to
 * put light into a standard material.
 *
 * WHY THE NOISE IS SAMPLED IN BIND-POSE SPACE. `position` is the pre-skinning attribute, so the
 * pattern is fixed to the wood. Sampling the skinned or world position instead makes the veins
 * swim across the surface the moment a clip runs — the bark would look like it was flowing past
 * the character rather than glowing inside them.
 *
 * `patchBarkVeins` returns a per-frame `setTime`; nothing here animates on its own.
 */

/** Deep, saturated version of the measured iris hue — this is sap, not a lamp. */
function veinColour(lightness: number, saturation: number): THREE.Color {
  return new THREE.Color().setHSL(LIFE_HUE, saturation, lightness);
}

export interface BarkVeins {
  /** Advance the flow. Call once per frame with elapsed seconds. */
  setTime(elapsed: number): void;
  /** 0 = dormant wood, 1 = fully lit. Raised while a power is gathering. */
  setCharge(charge: number): void;
  /** True once the shader has actually been compiled with the patch in it. */
  readonly patched: boolean;
}

export function patchBarkVeins(material: THREE.MeshStandardMaterial): BarkVeins {
  const uniforms = {
    uVeinTime: { value: 0 },
    uVeinCharge: { value: 0 },
    uVeinColour: { value: veinColour(0.5, 0.95) },
    uCoreColour: { value: veinColour(0.72, 0.75) },
  };
  let patched = false;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vBindPosition;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        // The raw attribute, before skinning — this is what locks the pattern to the wood.
        vBindPosition = position;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vBindPosition;
        uniform float uVeinTime;
        uniform float uVeinCharge;
        uniform vec3 uVeinColour;
        uniform vec3 uCoreColour;

        // Cheap value noise. Gradient noise would be smoother, but the bark is already high
        // frequency and the veins are thresholded to thin ridges, so the difference does not
        // survive to the screen.
        float vHash(vec3 p) {
          return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
        }

        float vNoise(vec3 p) {
          vec3 i = floor(p);
          vec3 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(mix(vHash(i + vec3(0,0,0)), vHash(i + vec3(1,0,0)), f.x),
                mix(vHash(i + vec3(0,1,0)), vHash(i + vec3(1,1,0)), f.x), f.y),
            mix(mix(vHash(i + vec3(0,0,1)), vHash(i + vec3(1,0,1)), f.x),
                mix(vHash(i + vec3(0,1,1)), vHash(i + vec3(1,1,1)), f.x), f.y),
            f.z);
        }

        float vFbm(vec3 p) {
          float sum = 0.0;
          float amp = 0.5;
          for (int i = 0; i < 4; i++) {
            sum += amp * vNoise(p);
            p *= 2.02;
            amp *= 0.5;
          }
          return sum;
        }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          // Sap rises: the noise field is scrolled DOWN in y so the pattern appears to travel up
          // through the trunk and out along the branches.
          vec3 p = vBindPosition * 9.0;
          p.y -= uVeinTime * 0.22;
          float n = vFbm(p);

          // A ridge, not a blob: thin bright seams where the field crosses its own midline, which
          // is what reads as a vein rather than a stain. The exponent is high on purpose — at
          // pow 7 with a wide ridge the seams merge and the whole figure floods to flat neon,
          // losing the bark relief that is the character's entire silhouette up close.
          float ridge = 1.0 - abs(n - 0.5) * 4.2;
          ridge = clamp(ridge, 0.0, 1.0);
          float vein = pow(ridge, 14.0);

          // A slower, coarser field gates whole regions on and off, so the glow migrates around
          // the body over several seconds instead of pulsing everywhere at once.
          float region = vFbm(vBindPosition * 2.1 + vec3(0.0, uVeinTime * 0.06, 0.0));
          vein *= smoothstep(0.46, 0.74, region);

          // Brightest low in the trunk, fading out toward the crown — light rising from the roots.
          float height = clamp(vBindPosition.y / 0.95, 0.0, 1.0);
          float rise = mix(1.0, 0.22, smoothstep(0.35, 1.0, height));

          float breath = 0.72 + 0.28 * sin(uVeinTime * 1.35);
          float strength = vein * rise * breath * (0.30 + uVeinCharge * 1.9);

          // The hot core sits inside the vein; the wider falloff spills onto the bark around it.
          vec3 sap = mix(uVeinColour, uCoreColour, clamp(strength * 0.9, 0.0, 1.0));
          totalEmissiveRadiance += sap * strength * 0.85;
          // A dim wash over the whole surface while charging, so a power reads on the silhouette
          // and not only on the seams.
          totalEmissiveRadiance += uVeinColour * uVeinCharge * 0.055 * rise;
        }`,
      );

    patched = shader.fragmentShader.includes('totalEmissiveRadiance += sap');
  };

  // Changing the injected source after a program is cached would otherwise reuse the old compile.
  material.customProgramCacheKey = () => 'monster-tree-bark-veins-v1';
  material.needsUpdate = true;

  return {
    setTime: (elapsed: number) => {
      uniforms.uVeinTime.value = elapsed;
    },
    setCharge: (charge: number) => {
      uniforms.uVeinCharge.value = charge;
    },
    get patched() {
      return patched;
    },
  };
}
