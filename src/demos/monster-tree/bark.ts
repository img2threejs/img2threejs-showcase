import * as THREE from 'three';
import { LIFE_HUE, PALETTE } from './measured';

/**
 * The bark surface: grain, relief, cavity shading, moss, and the sap veins running under it.
 *
 * WHY THIS EXISTS AT ALL. The playground export drops the source normal map — `object-sculpt-spec`
 * records it as "source had a normal map; NOT carried (vertex normals only)". So the figure
 * arrives as 115,350 triangles of smooth shading with the bark painted on in vertex colour: the
 * silhouette is a tree, but every surface between the silhouettes is soft, and the deep vertical
 * grain that is most of what makes the reference read as wood is simply gone. No amount of
 * lighting recovers detail that is not in the surface. This module puts the relief back
 * procedurally.
 *
 * THE GRAIN FOLLOWS THE ANATOMY, and that is the part worth reading twice.
 *
 * Real wood grain runs along the limb it grew in. A single vertical noise field gives a figure that
 * looks like it was carved out of one plank — the forearms get horizontal banding, the shoulders
 * get grain running across them. So the grain direction is a per-vertex attribute taken from the
 * rig: each vertex's dominant bone contributes its own bind-space axis, measured bone-to-child
 * (see `grainDirections` in `rig.ts`). Measured on this skeleton, that gives
 *
 *     L_Forearm   [ 0.00,  0.00, -1.00]   along the arm
 *     R_Forearm   [ 0.30,  0.00,  0.95]   along the arm
 *     L_Thigh     [-0.09, -0.99, -0.11]   down the leg
 *     Spine02     [-0.02,  0.96, -0.29]   up the torso
 *
 * The noise coordinate is then squashed along that axis and stretched across it, so features
 * elongate into fibres running the length of each limb. The arms read as arms, the thighs as
 * thighs — the wood becomes body parts rather than a texture wrapped over a body.
 *
 * Everything is sampled in BIND-POSE space (`position`, `normal` — the raw attributes, before
 * skinning). Sample the skinned or world position instead and the grain, the moss and the veins
 * all swim across the surface the instant a clip runs, which reads as the bark flowing past the
 * character rather than being part of them.
 */

function hue(lightness: number, saturation: number): THREE.Color {
  return new THREE.Color().setHSL(LIFE_HUE, saturation, lightness);
}

export interface BarkSurface {
  /** Advance the sap flow. Call once per frame with elapsed seconds. */
  setTime(elapsed: number): void;
  /** 0 = dormant wood, 1 = fully lit. Raised while a power is gathering. */
  setCharge(charge: number): void;
  /** Debug/tuning knobs, so a suspect term can be switched off in the live page and looked at. */
  setVeinStrength(value: number): void;
  setBumpScale(value: number): void;
  setCavityStrength(value: number): void;
  /**
   * True once the injection was applied to the shader SOURCE.
   *
   * Deliberately not called "compiled": this flag only reports that the string replacements
   * matched. A patch can match perfectly and still fail to link — naming a variable `patch`, a
   * reserved word in GLSL ES 3.00, took the whole shell off screen while this flag read true and
   * three logged nothing but `useProgram: program not valid`. Verify compilation by hooking
   * `compileShader` and reading `getShaderInfoLog`, which is what `tools/check-bark-shader.mjs`
   * does; do not trust this for that.
   */
  readonly injected: boolean;
}

/** Shared noise + the grain-aligned height field the relief, cavity and veins all read from. */
const BARK_NOISE = /* glsl */ `
  varying vec3 vBindPosition;
  varying vec3 vBindNormal;
  varying vec3 vGrain;
  uniform float uBarkTime;
  uniform float uBarkCharge;
  uniform float uBumpScale;
  uniform float uVeinStrength;
  uniform float uCavityStrength;
  uniform vec3 uVeinColour;
  uniform vec3 uCoreColour;
  uniform vec3 uMossColour;
  uniform vec3 uCavityColour;

  float bHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123); }

  float bNoise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(bHash(i + vec3(0,0,0)), bHash(i + vec3(1,0,0)), f.x),
          mix(bHash(i + vec3(0,1,0)), bHash(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(bHash(i + vec3(0,0,1)), bHash(i + vec3(1,0,1)), f.x),
          mix(bHash(i + vec3(0,1,1)), bHash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }

  // Three octaves, not four. The fourth costs another eight hashed lattice samples per call and
  // is below a pixel at any framing this demo is shown at.
  float bFbm(vec3 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 3; i++) { s += a * bNoise(p); p *= 2.03; a *= 0.5; }
    return s;
  }

  /** Split a point into its component along the grain and the part across it. */
  void bSplit(vec3 p, vec3 g, out float along, out vec3 across) {
    along = dot(p, g);
    across = p - g * along;
  }

  /**
   * Bark relief, as TWO fields rather than one.
   *
   *   .x  coarse ridges — low frequency, smooth. Drives everything that changes COLOUR: cavity
   *       shading, where moss settles, where sap pools.
   *   .y  coarse + fibre — higher frequency. Drives the NORMAL only.
   *
   * Splitting them is the whole difference between bark and static. Albedo is sampled once per
   * pixel with no filtering, so a high-frequency field driving colour breaks into hard blotches
   * and crawling dotted chains along every contour. A normal can carry far more detail because
   * lighting integrates it. Driving both from one sharp field — which an earlier pass did — gives
   * a surface that is simultaneously noisy and flat.
   *
   * 10:1 anisotropy: the coordinate is squashed along the grain and stretched across it, so
   * features elongate into fibres running the length of whichever limb the vertex belongs to.
   */
  vec2 barkHeights(vec3 p, vec3 g) {
    float along; vec3 across;
    bSplit(p, g, along, across);
    // 4:1 anisotropy, not 10:1. Ten to one is corduroy: the fibres line up so exactly that a
    // strong bump turns the chest into zebra stripes. Four to one still reads unmistakably as
    // grain running the length of the limb, while leaving the field enough cross-grain variation
    // to break up into bark.
    vec3 q = across * 5.0 + g * (along * 1.25);
    float coarse = bFbm(q * 2.6);
    float fibre = bFbm(q * 6.0);
    return vec2(
      clamp(coarse * 1.18, 0.0, 1.0),
      clamp((coarse + 0.30 * fibre) * 0.86, 0.0, 1.0)
    );
  }
`;

export function patchBarkSurface(material: THREE.MeshStandardMaterial): BarkSurface {
  const uniforms = {
    uBarkTime: { value: 0 },
    uBarkCharge: { value: 0 },
    uBumpScale: { value: 0.040 },
    uVeinStrength: { value: 1 },
    uCavityStrength: { value: 1 },
    uVeinColour: { value: hue(0.5, 0.95) },
    uCoreColour: { value: hue(0.72, 0.75) },
    uMossColour: { value: new THREE.Color(PALETTE.mossDark).convertSRGBToLinear() },
    uCavityColour: { value: new THREE.Color(PALETTE.barkDark).convertSRGBToLinear() },
  };
  let injected = false;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aGrain;
        varying vec3 vBindPosition;
        varying vec3 vBindNormal;
        varying vec3 vGrain;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        // The raw attributes, before skinning — this is what locks grain, moss and sap to the wood.
        vBindPosition = position;
        vBindNormal = normal;
        vGrain = aGrain;`)
;

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${BARK_NOISE}`)

      // ---- relief. Restores the normal map the export dropped.
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        {
          // Derivative-based bump (three's own perturbNormalArb construction): the surface gradient
          // comes from screen-space derivatives of the height field and of the view position, which
          // needs neither UVs nor a tangent attribute — this mesh has neither.
          //
          // This costs one height evaluation per pixel. An analytic object-space gradient was tried
          // instead, at four evaluations per pixel, on the theory that the quantised 2x2 derivative
          // was what stippled the surface. It was not, and it cost half the frame rate to learn:
          // the artifact was a DISCONTINUOUS grain field seaming along every bone boundary, and it
          // survived the change untouched. Fixing the field in \`grainDirections\` fixed the shading.
          vec3 surf = -vViewPosition;
          vec3 dPdx = dFdx(surf);
          vec3 dPdy = dFdy(surf);
          float dHdx = dFdx(bH);
          float dHdy = dFdy(bH);
          vec3 r1 = cross(dPdy, normal);
          vec3 r2 = cross(normal, dPdx);
          float det = dot(dPdx, r1);

          // Fade the bump out where the height field still moves faster than the pixel grid can
          // sample it — the same idea as letting a normal map fall into its mips, using the one
          // signal available here: measured slope per pixel.
          float slope = max(abs(dHdx), abs(dHdy));
          float bumpFade = 1.0 - smoothstep(0.014, 0.062, slope);

          // At a grazing angle det collapses toward zero and normalize amplifies what is left.
          if (abs(det) > 1e-9 && bumpFade > 0.001) {
            vec3 grad = sign(det) * (dHdx * r1 + dHdy * r2);
            normal = normalize(abs(det) * normal - uBumpScale * bumpFade * grad);
          }
        }`)

      // ---- albedo: cavity shading and moss, after vertex colour has been applied.
      //
      // This is also where the shared height field is computed. three's fragment runs
      // color -> roughness -> normal -> emissive, and all four want the same value, so it is
      // declared here WITHOUT an enclosing scope and reused by the three injections below.
      // Recomputing it in each of them costs four evaluations of a two-octave fbm per fragment and
      // took the demo from 120 fps to 24 on a close framing.
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 bGrain = normalize(vGrain);
        vec2 bHeights = barkHeights(vBindPosition, bGrain);
        float bCoarse = bHeights.x;   // colour reads this
        float bH = bHeights.y;        // the normal reads this
        float bCavity = smoothstep(0.58, 0.18, bCoarse);
        {

          // Deep grain is in shadow from itself. A bump map alone cannot darken a crevice — it
          // only tilts the normal — so the occlusion has to be painted in, or the relief reads as
          // embossed foil rather than split wood.
          // DARKEN, do not tint. Mixing toward uCavityColour (#231f12, whose blue is a tenth of
          // its red) drags the blue channel to nothing wherever the grain is deep — measured on
          // the lit chest, blue sat at 7/255 against red 72, which is what actually made the wood
          // read as lime. A scalar multiply removes light without touching the hue the albedo
          // already has.
          diffuseColor.rgb *= mix(1.0, 0.40, bCavity * uCavityStrength);

          // Moss grows on what faces the sky, so it keys off the BIND-pose normal: it grew while
          // the tree stood in its rest pose and does not migrate when an arm swings.
          float up = clamp(vBindNormal.y, 0.0, 1.0);
          // Do NOT name this 'patch'. That is a reserved word in GLSL ES 3.00 (tessellation);
          // using it makes the whole program fail to link, and three reports nothing but
          // 'useProgram: program not valid' while the shell renders as absolutely nothing.
          float mossNoise = bFbm(vBindPosition * 4.4 + 11.3);
          float moss = smoothstep(0.34, 0.85, up) * smoothstep(0.44, 0.70, mossNoise);
          // Moss settles in the grain, not on the ridges.
          moss *= mix(0.45, 1.0, bCavity);
          diffuseColor.rgb = mix(diffuseColor.rgb, uMossColour, moss * 0.17);
        }`)

      // ---- roughness: ridges weather smooth, crevices and moss stay matte.
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor - (bCoarse - 0.5) * 0.22, 0.62, 1.0);`)

      // ---- sap, flowing ALONG the limb rather than straight up the world.
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          float along; vec3 across;
          bSplit(vBindPosition, bGrain, along, across);

          // Scrolling the coordinate along the grain makes the sap travel down the limb it is in —
          // out along an arm, up a leg — so it reads as circulation through a body rather than a
          // pattern crawling up the world's y axis.
          // Sap travels roughly twice as fast as it first did. At the old rate a seam took several
          // seconds to cross a limb, so on a static idle the surface looked almost still; the
          // effect existed but you had to wait for it.
          vec3 q = across * 7.0 + bGrain * (along * 1.6 - uBarkTime * 1.15);
          float n = bFbm(q);

          // Antialiased ridge. A raw pow(ridge, 14) is thinner than a pixel wherever the field is
          // busy, and thin-plus-bright is exactly what rasterises into a stair-stepped chain of
          // dashes crawling over the surface. fwidth gives the field's rate of change per pixel, so
          // the threshold can be widened to at least one pixel and the seam stays smooth at any
          // distance instead of only at the one the exponent was tuned for.
          float ridge = clamp(1.0 - abs(n - 0.5) * 4.2, 0.0, 1.0);
          float aa = max(fwidth(ridge), 0.012);
          float vein = smoothstep(0.62 - aa, 0.62 + aa, ridge);
          vein *= vein;

          // A slower field gates whole regions, so the glow migrates over seconds instead of
          // pulsing everywhere at once.
          // The region gate is what makes the glow MIGRATE around the body — it switches whole
          // areas on and off. Scrolled faster it re-lights a different part of the figure every few
          // seconds instead of every dozen, which is what "more often" actually means here.
          float region = bFbm(vBindPosition * 2.1 + vec3(0.0, uBarkTime * 0.20, 0.0));
          vein *= smoothstep(0.40, 0.70, region);

          // Sap pools in the deep grain, which is also where it would actually run.
          vein *= mix(0.35, 1.0, bCavity);

          float height = clamp(vBindPosition.y / 0.95, 0.0, 1.0);
          float rise = mix(1.0, 0.22, smoothstep(0.35, 1.0, height));
          // Two detuned breaths rather than one, so the pulse never settles into an obvious period.
          float breath = 0.70 + 0.20 * sin(uBarkTime * 2.1) + 0.10 * sin(uBarkTime * 3.7);
          float strength = vein * rise * breath * (0.15 + uBarkCharge * 2.1);

          vec3 sap = mix(uVeinColour, uCoreColour, clamp(strength * 0.9, 0.0, 1.0));
          totalEmissiveRadiance += sap * strength * 0.40 * uVeinStrength;
          totalEmissiveRadiance += uVeinColour * uBarkCharge * 0.038 * rise;
        }`);

    injected = shader.fragmentShader.includes('totalEmissiveRadiance += sap')
      && shader.fragmentShader.includes('uBumpScale * grad');
  };

  // Without this the renderer can reuse a program compiled from the unpatched source.
  material.customProgramCacheKey = () => 'monster-tree-bark-v2';
  material.needsUpdate = true;

  return {
    setTime: (elapsed: number) => { uniforms.uBarkTime.value = elapsed; },
    setVeinStrength: (v: number) => { uniforms.uVeinStrength.value = v; },
    setBumpScale: (v: number) => { uniforms.uBumpScale.value = v; },
    setCavityStrength: (v: number) => { uniforms.uCavityStrength.value = v; },
    setCharge: (charge: number) => { uniforms.uBarkCharge.value = charge; },
    get injected() { return injected; },
  };
}
