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
  /** The drifting colour bloom, 0..1. Held up while the figure is idle. */
  setAura(value: number): void;
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
  uniform float uAura;
  uniform vec3 uAuraDeep;
  uniform vec3 uAuraMid;
  uniform vec3 uAuraHot;
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
    uAura: { value: 1 },
    uAuraDeep: { value: new THREE.Color(PALETTE.eyeDeep).convertSRGBToLinear() },
    uAuraMid: { value: new THREE.Color(PALETTE.eyeIris).convertSRGBToLinear() },
    uAuraHot: { value: new THREE.Color(PALETTE.eyeCore).convertSRGBToLinear() },
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
          vec3 q = across * 7.0 + bGrain * (along * 1.6 - uBarkTime * 0.55);
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
          float region = bFbm(vBindPosition * 2.1 + vec3(0.0, uBarkTime * 0.06, 0.0));
          vein *= smoothstep(0.46, 0.74, region);

          // Sap pools in the deep grain, which is also where it would actually run.
          vein *= mix(0.35, 1.0, bCavity);

          float height = clamp(vBindPosition.y / 0.95, 0.0, 1.0);
          float rise = mix(1.0, 0.22, smoothstep(0.35, 1.0, height));
          float breath = 0.72 + 0.28 * sin(uBarkTime * 1.35);
          // Back up to the level the figure had before the white balance went in. The two are
          // independent: the balance fixes the ALBEDO, which is what made the wood lime, while
          // this is additive emissive on top of it — so the halo can be bright without the bark
          // going back to olive.
          float strength = vein * rise * breath * (0.30 + uBarkCharge * 2.0);

          vec3 sap = mix(uVeinColour, uCoreColour, clamp(strength * 0.9, 0.0, 1.0));
          totalEmissiveRadiance += sap * strength * 0.88 * uVeinStrength;

          // ---- the drifting bloom ----------------------------------------------------------
          //
          // A separate, much softer layer than the sap above, and the reason it is separate is
          // worth stating: the bloom and the fibres want opposite things. Widening the sap ridge
          // until it blooms floods the whole figure with flat emissive and takes the bark relief
          // with it — that is exactly what an earlier pass did. So the bloom gets its own field.
          //
          // LOW frequency and NO ridge: broad soft patches, not seams. Two fields at different
          // rates drifting up the body in world Y, which is what makes the colour bleed and
          // migrate across the torso over several seconds rather than sitting still or pulsing
          // everywhere at once.
          //
          // The COLOUR moves too. It is not one green: it walks the measured eye ramp — eyeDeep
          // #36581c through eyeIris #799d3d to the near-white eyeCore #d6faca — so the layer
          // shifts hue as it drifts instead of brightening a single tint. That is what reads as a
          // layer of colour rather than a glow.
          float drift = bFbm(vBindPosition * 2.6 + vec3(0.0, -uBarkTime * 0.085, 0.0));
          drift = mix(drift, bFbm(vBindPosition * 4.3 + vec3(uBarkTime * 0.05, -uBarkTime * 0.13, 0.0)), 0.45);
          // Deliberately narrow, and it never reaches 1. The bloom has to stay a LAYER over the
          // wood: at full coverage it hides the grain and cavity work underneath and the figure
          // goes back to being a flat green silhouette, which is the failure this whole surface
          // was rebuilt to escape. The floor keeps a trace of colour everywhere so the drift reads
          // as something moving across the body rather than switching on and off.
          float bloom = 0.12 + 0.78 * smoothstep(0.44, 0.92, drift);
          // Softest on the surfaces facing the viewer's light and strongest around the edges of
          // each mass, so it reads as sitting just off the body rather than painted onto it.
          float sheen = pow(1.0 - abs(dot(normalize(vBindNormal), normalize(vBindPosition))), 1.6);
          vec3 auraColour = mix(uAuraDeep, uAuraMid, smoothstep(0.0, 0.6, bloom));
          auraColour = mix(auraColour, uAuraHot, smoothstep(0.62, 1.0, bloom));
          totalEmissiveRadiance += auraColour * bloom * (0.30 + 0.46 * sheen) * uAura * 0.30;
          totalEmissiveRadiance += uVeinColour * uBarkCharge * 0.055 * rise;
        }`);

    injected = shader.fragmentShader.includes('totalEmissiveRadiance += sap')
      && shader.fragmentShader.includes('uBumpScale * grad');
  };

  // Without this the renderer can reuse a program compiled from the unpatched source.
  material.customProgramCacheKey = () => 'monster-tree-bark-v2';
  material.needsUpdate = true;

  return {
    setTime: (elapsed: number) => { uniforms.uBarkTime.value = elapsed; },
    setAura: (v: number) => { uniforms.uAura.value = v; },
    setVeinStrength: (v: number) => { uniforms.uVeinStrength.value = v; },
    setBumpScale: (v: number) => { uniforms.uBumpScale.value = v; },
    setCavityStrength: (v: number) => { uniforms.uCavityStrength.value = v; },
    setCharge: (charge: number) => { uniforms.uBarkCharge.value = charge; },
    get injected() { return injected; },
  };
}
