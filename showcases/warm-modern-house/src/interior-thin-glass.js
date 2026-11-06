// SPDX-License-Identifier: Apache-2.0
// Runtime-only substitution for window glass.
//
// The exported portable GLB keeps KHR_materials_transmission, so the delivered asset is
// unchanged. The runtime does not use it: three.js implements a transmissive material by
// rendering EVERY opaque object a second time into a transmission target, and that second
// scene render is vertex-bound, not pixel-bound. On the real Oak/Linen room the transmission
// pass re-rendered 660,718 triangles (1.2 M triangle instances) and cost 17.8 ms of a 25.8 ms
// 1080p frame and 45.5 ms of a 64.3 ms 4K frame, so no target-size reduction removes it.
//
// The rule has two branches, and BOTH keep the material out of three.js's transmission pass:
//
//  1. A THIN pane (transmission >= THIN_GLASS_MIN_TRANSMISSION and no volume thickness) is a
//     nearly clear sheet: refracting the room behind it changes almost nothing visually, while
//     its own specular reflection, its roughness and the sun's shadow-ray transmittance are
//     what the eye reads as "glass". Such a pane becomes a transparent surface with a low
//     opacity inside [MIN_OPACITY, MAX_OPACITY], derived from the material's own transmission
//     factor and colour.
//
//  2. Any OTHER transmissive material must NOT become a see-through sheet. It becomes a plain
//     alpha blend with opacity = 1 - transmission, so a weak transmission factor stays almost
//     opaque (0.01 -> 0.99). A material that declares a VOLUME THICKNESS (KHR_materials_volume)
//     is a solid block of glass, not a pane: it stays fully opaque and keeps writing depth.
//
// Three properties of the substitution are deliberate and each has its own mechanism:
//
//  - REFLECTION. A plain alpha blend multiplies the whole lit colour, specular included, by the
//    pane's opacity, which would erase the very cue that reads as glass (a clear pane would keep
//    4 % of its 4 % Fresnel reflectance). The substituted material is therefore composited so that
//    only its body colour is weighted by the opacity and its specular reflection is added in full
//    (see COMPOSITE_FRAGMENT).
//  - COVERAGE. An authored alpha mask (alphaTest) is evaluated against the coverage the material
//    renders with, which includes the opacity. The cutoff is rescaled by newOpacity / authoredOpacity
//    (rescaledAlphaCutoff), so the mask keeps cutting out exactly the fragments it cut out before.
//  - SHADOWS. Only a thin pane lets the sun through. Every other material, including a weak
//    transmission factor that became almost opaque and a volume that became a solid block, still
//    blocks the sun. The decision is made per material (material.userData.thinGlass), so a mesh
//    that mixes a pane with opaque parts keeps casting a shadow for those parts only.
//
// The authored state is recorded on the material itself (material.userData.thinGlass,
// material.userData.glassTransmission, material.userData.glassAlphaTest), never on the mesh that
// happens to be visited first, so every mesh that shares the material gets the same decision
// regardless of traversal order.
import { AddEquation, CustomBlending, OneFactor, OneMinusSrcAlphaFactor } from 'three';

// A pane at or above this transmission factor is treated as thin glazing.
export const THIN_GLASS_MIN_TRANSMISSION = 0.5;
// The lower bound is the opacity of a clear pane: what a viewer reads as "a sheet of glass"
// rather than "no glass at all".
export const MIN_OPACITY = 0.04;
// The upper bound keeps the pane visible as a surface over a bright room.
export const MAX_OPACITY = 0.25;

/**
 * The runtime opacity of a thin glass pane.
 *
 * @param {number} transmission the material's KHR_materials_transmission factor (0..1)
 * @param {THREE.Color} [color] the material's base colour
 * @returns {number} the opacity the runtime renders the pane with
 */
export function thinGlassOpacity(transmission, color = null) {
  if (!Number.isFinite(transmission) || transmission <= 0) {
    throw new RangeError('Thin glass needs a positive, finite transmission factor.');
  }
  // A fully transmissive pane is the clearest one; a partly transmissive pane is denser.
  let opacity = MIN_OPACITY + (1 - transmission) * (MAX_OPACITY - MIN_OPACITY);
  // A dark or saturated tint reads as thicker glass.
  if (color) {
    const [r, g, b] = [color.r ?? 0, color.g ?? 0, color.b ?? 0];
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    opacity += (1 - Math.min(1, Math.max(0, luminance))) * (MAX_OPACITY - MIN_OPACITY) * 0.5;
  }
  return Math.min(MAX_OPACITY, Math.max(MIN_OPACITY, opacity));
}

/**
 * The thickness a material declares for its volume, in metres.
 *
 * @param {THREE.Material} material the material to inspect
 * @returns {number} the declared thickness, 0 when the material declares none
 */
export function declaredThickness(material) {
  const thickness = material?.thickness ?? 0;
  if (!Number.isFinite(thickness) || thickness <= 0) return 0;
  return thickness;
}

/**
 * True when the material is thin glazing: a strong transmission factor and no volume thickness.
 *
 * @param {THREE.Material} material the material to inspect
 * @returns {boolean}
 */
export function isThinGlazing(material) {
  const transmission = material?.transmission ?? 0;
  if (!(transmission > 0)) return false;
  if (transmission < THIN_GLASS_MIN_TRANSMISSION) return false;
  return declaredThickness(material) === 0;
}

/**
 * The alphaTest cutoff that keeps an authored mask cutting exactly the same fragments after the
 * opacity changed.
 *
 * A fragment survives when `opacity * texelAlpha >= alphaTest` (three.js discards when
 * `diffuseColor.a < alphaTest`, and diffuseColor.a already carries the opacity). Before the
 * substitution that is `authoredOpacity * texel >= authoredCutoff`; afterwards it is
 * `newOpacity * texel >= cutoff'`, so cutoff' = authoredCutoff * newOpacity / authoredOpacity keeps
 * the survival of every texel unchanged.
 *
 * An authored opacity of 0 gives every fragment a coverage of 0, which is below any positive
 * cutoff: the authored material discarded every fragment. The ratio is undefined there, so the
 * cutoff becomes one no texel can reach (above newOpacity, the largest coverage), and the material
 * keeps discarding every fragment instead of dividing by zero.
 *
 * @param {number} cutoff the authored alphaTest, > 0
 * @param {number} authoredOpacity the authored opacity
 * @param {number} newOpacity the opacity the runtime renders with
 * @returns {number} the cutoff to render with
 */
export function rescaledAlphaCutoff(cutoff, authoredOpacity, newOpacity) {
  if (!(cutoff > 0)) return 0;
  if (authoredOpacity > 0) return cutoff * newOpacity / authoredOpacity;
  return newOpacity > 0 ? 2 * newOpacity : 1;
}

// three.js ends the lit fragment with `gl_FragColor = vec4( outgoingLight, diffuseColor.a )` and,
// for MeshPhysicalMaterial, has already split the light into totalDiffuse and totalSpecular. With
// the blend below (source x 1, destination x (1 - alpha)) the framebuffer receives
//
//     source.rgb + destination.rgb * (1 - a)
//
// so a source of  outgoingLight * a + totalSpecular * (1 - a)  is
//
//     a * (outgoingLight - totalSpecular) + totalSpecular
//
// that is: the body colour weighted by the pane's opacity, and the specular reflection in full.
const COMPOSITE_TOKEN = '#include <opaque_fragment>';
export const COMPOSITE_FRAGMENT = 'gl_FragColor.rgb = outgoingLight * diffuseColor.a + totalSpecular * ( 1.0 - diffuseColor.a );';
const COMPOSITE_MARK = Symbol('interior-thin-glass-composite');
const COMPOSITE_KEY = '|interior-thin-glass-composite-r180';

function requireToken(source, token) {
  if (!source.includes(token)) {
    throw new Error(`The three.js physical fragment shader no longer contains ${token}; the thin-glass compositing must be re-validated.`);
  }
}

/**
 * Composite a substituted material so that its specular reflection is not weighted by its
 * opacity. Idempotent: the shader hook and the blend are installed once per material instance.
 *
 * @param {THREE.MeshPhysicalMaterial} material a substituted, transparent material
 */
function compositeReflection(material) {
  material.blending = CustomBlending;
  material.blendEquation = AddEquation;
  material.blendSrc = OneFactor;
  material.blendDst = OneMinusSrcAlphaFactor;
  material.blendSrcAlpha = null;
  material.blendDstAlpha = null;
  // The source below is already weighted by the opacity exactly once. three.js would multiply the
  // colour by alpha again (premultiplied_alpha_fragment) for a premultipliedAlpha material, so the
  // compositing owns the premultiplication and the flag is cleared.
  material.premultipliedAlpha = false;
  material.userData.glassComposite = true;
  if (material.onBeforeCompile[COMPOSITE_MARK]) return;
  const previousCompile = material.onBeforeCompile;
  const programKey = `${material.customProgramCacheKey()}${COMPOSITE_KEY}`;
  const compile = function (shader, renderer) {
    previousCompile.call(this, shader, renderer);
    requireToken(shader.fragmentShader, COMPOSITE_TOKEN);
    requireToken(shader.fragmentShader, 'totalSpecular');
    shader.fragmentShader = shader.fragmentShader.replace(COMPOSITE_TOKEN, () => `${COMPOSITE_TOKEN}\n${COMPOSITE_FRAGMENT}`);
  };
  compile[COMPOSITE_MARK] = true;
  material.onBeforeCompile = compile;
  material.customProgramCacheKey = () => programKey;
}

/**
 * Replace a transmissive material with a glass material that three.js renders as a plain
 * transparent surface.
 *
 * The specular response, roughness, envMap and the base colour survive, and so does the
 * reflection itself (see compositeReflection); only the refraction becomes an alpha blend.
 *
 * A glTF material with KHR_materials_transmission becomes a MeshPhysicalMaterial in three.js,
 * so both material kinds are accepted.
 *
 * A material that was already substituted (a clone of one) is not decided again; only its
 * shader hook is restored, because Material.clone() does not copy it.
 *
 * @param {THREE.Material} material the material to convert, in place
 * @returns {boolean} true when the material was converted
 */
export function substituteThinGlass(material) {
  if (!material?.isMeshStandardMaterial && !material?.isMeshPhysicalMaterial) return false;
  const transmission = material.transmission ?? 0;
  if (transmission <= 0) {
    if (material.userData?.glassComposite) compositeReflection(material);
    return false;
  }
  // The original state is recorded on the material, so the shadow decision and any later
  // inspection read the authored values and not the substituted ones.
  material.userData = { ...material.userData, glassTransmission: transmission };
  const authoredAlphaTest = material.alphaTest > 0 ? material.alphaTest : 0;
  const authoredOpacity = material.opacity;
  if (authoredAlphaTest > 0) material.userData.glassAlphaTest = authoredAlphaTest;
  let opacity;
  if (isThinGlazing(material)) {
    material.userData.thinGlass = true;
    opacity = thinGlassOpacity(transmission, material.color);
    material.transmission = 0;
    material.transparent = true;
    // A transparent surface must not write depth, or the room behind the pane is cut out.
    material.depthWrite = false;
  } else {
    // Not thin glazing: the material must not become a see-through sheet.
    material.userData.thinGlass = false;
    if (declaredThickness(material) > 0) {
      // A solid volume of glass (KHR_materials_volume with a thickness) is a block, not a pane:
      // it stays fully opaque and keeps writing depth.
      opacity = 1;
      material.transmission = 0;
      material.transparent = false;
      material.depthWrite = true;
    } else {
      // A plain alpha blend with opacity = 1 - transmission: a weak transmission factor stays
      // almost opaque (0.01 -> 0.99). A blend that is not fully opaque stops writing depth.
      opacity = Math.max(0, Math.min(1, 1 - transmission));
      material.transmission = 0;
      material.transparent = opacity < 1;
      material.depthWrite = opacity >= 1;
    }
  }
  material.opacity = opacity;
  if (authoredAlphaTest > 0) material.alphaTest = rescaledAlphaCutoff(authoredAlphaTest, authoredOpacity, opacity);
  if (material.transparent) compositeReflection(material);
  material.needsUpdate = true;
  return true;
}

/**
 * True when the material is a thin pane that lets the sun through: the only material the
 * runtime does not draw into the shadow map.
 *
 * @param {THREE.Material} material the material to inspect
 * @returns {boolean}
 */
export function isThinPane(material) {
  return material?.userData?.thinGlass === true;
}

/**
 * True when the runtime substituted this material (it was authored as transmissive).
 *
 * @param {THREE.Material} material the material to inspect
 * @returns {boolean}
 */
export function isSubstituted(material) {
  return (material?.userData?.glassTransmission ?? 0) > 0;
}

// three.js selects the shadow depth material per mesh, or per group of an array material, and
// calls these hooks around the draw with the depth material it chose. The hooks adjust only that
// draw: a thin pane's group writes neither colour nor depth into the shadow map, and a material
// whose alpha mask was rescaled for its opacity cuts the shadow with the authored cutoff.
function materialOf(mesh, group) {
  return Array.isArray(mesh.material) ? mesh.material[group?.materialIndex ?? 0] : mesh.material;
}

function beforeShadow(renderer, object, camera, shadowCamera, geometry, depthMaterial, group) {
  const material = materialOf(object, group);
  if (isThinPane(material)) {
    depthMaterial.colorWrite = false;
    depthMaterial.depthWrite = false;
  } else if (material?.userData?.glassAlphaTest > 0) {
    depthMaterial.alphaTest = material.userData.glassAlphaTest;
  }
}

function afterShadow(renderer, object, camera, shadowCamera, geometry, depthMaterial) {
  // The depth materials are shared between meshes: put back the defaults the next draw expects.
  depthMaterial.colorWrite = true;
  depthMaterial.depthWrite = true;
}

/**
 * Decide the shadow casting of a mesh from the classification of its own materials.
 *
 * The mesh casts a shadow when ANY of its materials is not a thin pane. A mesh made only of thin
 * panes does not. A mesh that mixes both casts, and its panes' groups are kept out of the shadow
 * pass by the depth-material hooks, so the opaque parts still block the sun.
 *
 * @param {THREE.Mesh} mesh the mesh whose materials were already substituted
 * @returns {boolean} the mesh's castShadow
 */
export function bindGlazingShadows(mesh) {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  mesh.castShadow = materials.some(material => !isThinPane(material));
  if (mesh.castShadow && materials.some(isSubstituted)) {
    mesh.onBeforeShadow = beforeShadow;
    mesh.onAfterShadow = afterShadow;
  }
  return mesh.castShadow;
}
