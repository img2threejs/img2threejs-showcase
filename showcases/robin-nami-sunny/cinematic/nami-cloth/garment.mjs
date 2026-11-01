// SPDX-License-Identifier: Apache-2.0
// Connected, skin-constrained garment motion. A separate render geometry keeps
// the soft-tissue solver's rest/topology contract intact; picking sees this geometry.
import { BufferAttribute, CanvasTexture, DoubleSide, Matrix3, Matrix4, Quaternion, SRGBColorSpace, Vector2, Vector3 } from 'three';
import { createClothContact } from './cloth-contact.mjs';
import { buildGraph, distanceField, falloff, geodesic } from './garment-field.mjs';

// Outfit ids are colorway ids supplied by the caller; the first one is the painted original.
// Release at the neck knot -> ribbon and a small cup flap fall together -> recolor -> lift -> reseat.
export const TRANSITION = Object.freeze({ duration: 3.8, release: [0, 0.4], fall: [0.4, 1.6], morph: [1.6, 2.7], lift: [2.8, 3.5], reseat: [3.5, 3.8] });
export const REDUCED_TRANSITION = Object.freeze({ duration: 0.4, morph: [0, 0.4] });
// Measured on the delivered BikiniTop: the halter ribbon leaves the cup apex at
// y≈1.425 m and reaches the neck loop at y≈1.49 m, |x| ≤ 0.083 m, z ≥ -0.02 m.
export const STRAP = Object.freeze({ yAttach: 1.425, yTop: 1.49, maxAbsX: 0.085, minZ: -0.02, maxPull: 0.035,
  grabMin: 0.08, grabMax: 0.95, frequency: 7, dampingRatio: 0.2, holdFrequency: 12, tension: 0.6 });
export const PANEL = Object.freeze({ maxPull: 0.024, frequency: 7, dampingRatio: 0.7 });
// A cup pull carries the nearest `share` of ALL garment vertices; full weight inside
// `plateau` of that reach, smooth falloff to zero at it.
export const PULL_PATCH = Object.freeze({ share: 0.5, plateau: 0.25 });
// The whole garment (cups, both ribbons, the neck loop) is one connected surface. A pull carries
// every vertex by a weight that depends only on the distance ALONG that surface from the grab, so
// neighbours always move almost together and nothing tears at a junction.
//  reachFactor: a ribbon pull reaches `reachFactor` x the distance (along the garment, through the
//    neck loop) to the mirror point on the other ribbon, so the other ribbon still follows by
//    about a quarter of the pull; fallbackReach / minReach apply when that distance is unknown.
//  pinRange: only the under band is held on the torso; the field fades to zero over this distance
//    from it (metres), which is also how the cup bottom meets the band without a seam.
export const STRAP_FIELD = Object.freeze({ reachFactor: 1.55, minReach: 0.08, fallbackReach: 0.2, pinRange: 0.035, liftFade: [0.55, 1] });
// Pulling a ribbon also lifts the garment off the skin by up to `gap` metres, more on the side the
// pull points toward (`lead` ramp over `extent` metres from the cup centre), weighted by the same
// distance field and fading out toward the neck so the loop stays on the neck.
export const CUP_LIFT = Object.freeze({ gap: 0.036, lead: [-0.35, 0.9], extent: 0.08 });
// Skin contact corrects each vertex by its own nearest-skin lookup, which can disagree between two
// neighbours across a crease. A vertex's correction may differ from its neighbours' average by at
// most `maxDisagreement` metres, so the cloth cannot fold apart there.
export const CONTACT_STEADY = Object.freeze({ maxDisagreement: 0.001 });
// The garment is the OUTER layer: after everything else no vertex may sit closer to the skin than
// `floor` metres (the contact step's own minimum rest gap, so the guard only acts on real breaches) and
// the centre of no triangle closer than max(centreMin, floor - sagFactor x the triangle's rest sag over
// a skin ridge): the skin must never show in front of the cloth. A violation is lifted along the skin
// normal only (never pushed toward the skin); the lift is spread to neighbours (half of the neighbour
// mean) so it stays smooth, overshooting each deficit by `relax` so the passes converge fast, and
// repeated up to `passes` times for creases. Cheap: a vertex that the
// contact step left at height h and the smoothing moved by s cannot be below h - s, so only vertices
// with h - s < floor + pruneSlack are measured (the slack covers the small difference between height
// along the interpolated normal and true distance on curved skin); a triangle centre is measured only
// when its lowest corner is within `centreSlack` of its requirement plus its rest sag; later passes only
// re-measure what the previous pass moved.
export const SKIN_GUARD = Object.freeze({ floor: 0.0008, passes: 6, relax: 1.6, sagFactor: 4, centreMin: 0.0004, centreSlack: 0.0003, pruneSlack: 0.0004 });
// The small piece of cloth that falls with each ribbon: the cup tip within `reach` of the
// ribbon's attachment, hinged `hinge` below it and bending over `bend`. The fold angle is
// derived per ribbon (up-and-back to hanging down); `lift` / `ribbonLift` keep the fallen
// cloth above the cup it lies on; the neck-end release hides the last `cutSpan` of each ribbon.
export const FLAP = Object.freeze({ hinge: 0.034, bend: 0.03, reach: 0.075, lift: 0.0022, ribbonLift: 0.0042, cutSpan: 0.12 });
const SUBSTEP = 1 / 240;
const CHEST = Object.freeze({ 1: 'chest-left', [-1]: 'chest-right' });

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const smooth = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const easeInOut = (t) => t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
const span = (t, [a, b]) => clamp01((t - a) / (b - a));

const FALL_TOUCHDOWN = 0.6;
/** Gravity fall with a small landing bounce: 0 -> 1 (touchdown at 60 % of the window), then settles. */
export function fallProfile(x) {
  const c = clamp01(x);
  if (c < FALL_TOUCHDOWN) { const r = c / FALL_TOUCHDOWN; return r * r; }
  const u = (c - FALL_TOUCHDOWN) / (1 - FALL_TOUCHDOWN);
  return 1 - 0.16 * Math.abs(Math.sin(2 * Math.PI * u)) * Math.exp(-3 * u);
}

/** Pure timeline. `fold` 0..1 = flap + ribbon fall, `cut` = neck-end release, `morph` = recolor. */
export function transitionPhase(t, reduced = false) {
  if (reduced) return { fold: 0, cut: 0, glow: 0, morph: easeInOut(span(t, REDUCED_TRANSITION.morph)), done: t >= REDUCED_TRANSITION.duration };
  const release = easeInOut(span(t, TRANSITION.release)), reseat = easeInOut(span(t, TRANSITION.reseat));
  const cut = release * (1 - reseat);
  const fold = fallProfile(span(t, TRANSITION.fall)) * (1 - easeInOut(span(t, TRANSITION.lift)));
  const morph = easeInOut(span(t, TRANSITION.morph));
  const flash = Math.sin(Math.PI * span(t, TRANSITION.release)) + Math.sin(Math.PI * span(t, TRANSITION.reseat));
  const glow = flash + (morph > 0 && morph < 1 ? Math.sin(Math.PI * morph) : 0);
  return { fold, cut, glow, morph, done: t >= TRANSITION.duration };
}

/** Halter-strap coordinate: side ±1 (0 = not strap) and s ∈ [0,1] from cup apex to neck. */
export function strapCoordinate(x, y, z) {
  if (y < STRAP.yAttach || Math.abs(x) > STRAP.maxAbsX || z < STRAP.minZ) return { side: 0, s: 0 };
  return { side: x >= 0 ? 1 : -1, s: clamp01((y - STRAP.yAttach) / (STRAP.yTop - STRAP.yAttach)) };
}

/** Pulled strap cannot enter the body and stretches with increasing resistance. */
export function limitPull(delta, normal, maxPull = STRAP.maxPull, out = new Vector3()) {
  out.copy(delta);
  const inward = out.dot(normal);
  if (inward < 0) out.addScaledVector(normal, -inward);
  const length = out.length();
  if (length > 0) out.multiplyScalar(maxPull * Math.tanh(length / maxPull) / length);
  return out;
}

function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 0) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, max === 0 ? 0 : d / max, max];
}
function hsvToRgb(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m];
}

/**
 * Re-hues the painted green fabric in place (design reference for the sunset colorway:
 * dinakarim's Nami outfit, CC BY 4.0). White stripes, shading and line work keep their
 * authored values. `spec` = { hue (degrees), sat (multiplier), val (multiplier) }.
 * RGBA bytes are edited in place.
 */
export function recolorPixels(data, spec) {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const [h, s, v] = rgbToHsv(r, g, b);
    const weight = smooth(0.08, 0.3, s) * smooth(85, 105, h) * (1 - smooth(195, 215, h));
    if (weight === 0) continue;
    const [nr, ng, nb] = hsvToRgb(spec.hue, Math.min(1, s * spec.sat), Math.min(1, v * spec.val));
    data[i] = Math.round((r + (nr - r) * weight) * 255);
    data[i + 1] = Math.round((g + (ng - g) * weight) * 255);
    data[i + 2] = Math.round((b + (nb - b) * weight) * 255);
  }
  return data;
}

const VERTEX_DECL = /* glsl */`
attribute vec3 aRest;
varying vec3 vGarmentPos;
`;
const VERTEX_BODY = /* glsl */`
vGarmentPos = aRest;
`;
const FRAGMENT_DECL = /* glsl */`
uniform sampler2D uVariant;
uniform vec2 uCropMin, uCropSize;
uniform float uMorph, uSpan, uFrom, uTo, uCut, uGlow;
uniform vec3 uOrigin;
varying vec3 vGarmentPos;
float gHash( vec3 p ) { p = fract( p * 0.3183099 + 0.1 ); p *= 17.0; return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) ); }
float gNoise( vec3 x ) {
  vec3 i = floor( x ), f = fract( x ); f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( mix( gHash( i ), gHash( i + vec3( 1, 0, 0 ) ), f.x ), mix( gHash( i + vec3( 0, 1, 0 ) ), gHash( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
              mix( mix( gHash( i + vec3( 0, 0, 1 ) ), gHash( i + vec3( 1, 0, 1 ) ), f.x ), mix( gHash( i + vec3( 0, 1, 1 ) ), gHash( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
}
`;
const FRAGMENT_MAP = /* glsl */`
// The release is only at the neck end of each ribbon: its last stretch is hidden, so there
// is no mid-ribbon slit and no stretched triangles toward the fixed neck loop.
float gRibbon = step( abs( vGarmentPos.x ), 0.1 ) * step( ${STRAP.yAttach}, vGarmentPos.y );
float gCutY = ${STRAP.yAttach} + ( 1.0 - ${FLAP.cutSpan} * uCut ) * ${STRAP.yTop - STRAP.yAttach};
if ( gRibbon > 0.5 && uCut > 0.0 && vGarmentPos.y > gCutY ) discard;
float gSpark = gRibbon * exp( -pow( ( vGarmentPos.y - gCutY ) / 0.006, 2.0 ) );
#ifdef USE_MAP
  vec4 gA = texture2D( map, vMapUv );
  vec2 gUv = ( vMapUv - uCropMin ) / uCropSize;
  float gInside = step( 0.0, gUv.x ) * step( gUv.x, 1.0 ) * step( 0.0, gUv.y ) * step( gUv.y, 1.0 );
  vec4 gB = mix( gA, texture2D( uVariant, clamp( gUv, 0.0, 1.0 ) ), gInside );
  float gFront = uMorph * ( uSpan + 0.06 ) - 0.03;
  float gD = distance( vGarmentPos, uOrigin ) + ( gNoise( vGarmentPos * 140.0 ) - 0.5 ) * 0.02;
  float gReveal = 1.0 - smoothstep( gFront - 0.012, gFront + 0.012, gD );
  diffuseColor *= mix( gA, gB, mix( uFrom, uTo, gReveal ) );
  // The wave exists only while the recolor runs, not during the release/reseat flashes.
  float gWave = exp( -pow( ( gD - gFront ) / 0.025, 2.0 ) ) * step( 0.001, uMorph ) * ( 1.0 - step( 0.999, uMorph ) );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 1.0, 0.78, 0.25 ), clamp( uGlow * ( gWave * 0.65 + gSpark ), 0.0, 0.85 ) );
#endif
`;

/**
 * Controller for the BikiniTop garment. Call update(dt) before rig.update(dt)
 * for tension, then apply() before rendering for contact and the pickable surface.
 */
export function createGarments({ bikini, rig, reducedMotion = false, membership = null, colorways }) {
  if (!colorways || typeof colorways !== 'object' || !Object.keys(colorways).length || Object.values(colorways)[0] !== null) {
    throw new Error('Garments: colorways must map ids to top specs, with the painted original (null) first');
  }
  const colorwayIds = Object.keys(colorways), originalId = colorwayIds[0];
  const entry = rig.meshes.get(bikini?.name);
  const bodyEntry = rig.meshes.get('Body');
  if (!entry || !bodyEntry) throw new Error('Garments: BikiniTop and Body must be configured soft meshes');
  const geometry = entry.geometry.clone(), rest = entry.rest, count = rest.length / 3;
  bikini.geometry = geometry;
  const positions = geometry.attributes.position.array;
  const strapAttr = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const c = strapCoordinate(rest[i * 3], rest[i * 3 + 1], rest[i * 3 + 2]);
    strapAttr[i * 2] = c.side; strapAttr[i * 2 + 1] = c.s;
  }
  geometry.setAttribute('aStrap', new BufferAttribute(strapAttr, 2));
  geometry.setAttribute('aRest', new BufferAttribute(rest, 3));

  // Separate semantic vertex sets; a shared atlas/UV does not join their mechanics.
  // Weld positions for border detection so UV seams are not mistaken for sewn edges.
  const cupAttr = new Int8Array(count), welded = new Map(), vertexKeys = [];
  // Vertices that share a position (UV seam duplicates) must end up at the same place, or the
  // mesh tears along the seam: compute the first of each group and copy it to the rest.
  const weldRep = new Uint32Array(count), firstAt = new Map();
  for (let i = 0; i < count; i++) {
    const key = `${Math.round(rest[i * 3] * 1e6)},${Math.round(rest[i * 3 + 1] * 1e6)},${Math.round(rest[i * 3 + 2] * 1e6)}`;
    if (!welded.has(key)) welded.set(key, welded.size);
    vertexKeys[i] = welded.get(key);
    if (!firstAt.has(key)) firstAt.set(key, i);
    weldRep[i] = firstAt.get(key);
    if (strapAttr[i * 2]) continue;
    const left = (membership?.[1] ?? entry.masks.get(CHEST[1]))[i], right = (membership?.[-1] ?? entry.masks.get(CHEST[-1]))[i];
    cupAttr[i] = Math.max(left, right) > 0.01 ? (left >= right ? 1 : -1) : 0;
  }
  const panelFaces = new Int8Array(entry.indices.length / 3);
  for (let t = 0; t < entry.indices.length; t += 3) {
    const side = cupAttr[entry.indices[t]];
    if (side && cupAttr[entry.indices[t + 1]] === side && cupAttr[entry.indices[t + 2]] === side) panelFaces[t / 3] = side;
  }
  // Cup membership per vertex (+1 / -1, 0 = not cup), for diagnostics and picking.
  geometry.setAttribute('aPanel', new BufferAttribute(Float32Array.from(cupAttr), 1));
  // Centre of each cup, to tell which side of it a pull points toward.
  const cupCenter = new Map([1, -1].map((side) => [side, new Vector3()]));
  for (const side of [1, -1]) {
    let members = 0;
    for (let i = 0; i < count; i++) {
      if (cupAttr[i] !== side) continue;
      cupCenter.get(side).x += rest[i * 3]; cupCenter.get(side).y += rest[i * 3 + 1]; cupCenter.get(side).z += rest[i * 3 + 2]; members++;
    }
    if (members) cupCenter.get(side).divideScalar(members);
  }

  // The garment as one surface: distances are measured along its edges (seam duplicates welded).
  // The under band (everything that is neither cup, ribbon nor neck loop) is the only part held
  // on the torso; pinFactor fades the pull to zero toward it.
  const graph = buildGraph(vertexKeys, welded.size, rest, entry.indices);
  const pinFactor = new Float32Array(count).fill(1), liftFade = new Float32Array(count);
  {
    const sources = [];
    for (let i = 0; i < count; i++) if (!strapAttr[i * 2] && !cupAttr[i] && rest[i * 3 + 1] < STRAP.yAttach) sources.push({ weld: vertexKeys[i], distance: 0 });
    if (sources.length) {
      const geo = geodesic(graph, sources);
      for (let i = 0; i < count; i++) { const d = geo[vertexKeys[i]]; pinFactor[i] = Number.isFinite(d) ? smooth(0, STRAP_FIELD.pinRange, d) : 1; }
    }
    for (let i = 0; i < count; i++) liftFade[i] = strapAttr[i * 2] ? 1 - smooth(STRAP_FIELD.liftFade[0], STRAP_FIELD.liftFade[1], strapAttr[i * 2 + 1]) : cupAttr[i] ? 1 : 0;
  }

  const originalMaterial = bikini.material;
  const material = originalMaterial.clone();
  material.name = `${originalMaterial.name || 'Material'} · garment`;
  // The flap folds over the cup, so its inside face shows; render both sides.
  material.side = DoubleSide;
  const uniforms = {
    uCut: { value: 0 }, uGlow: { value: 0 }, uMorph: { value: 0 }, uSpan: { value: 0.3 },
    uOrigin: { value: new Vector3() }, uFrom: { value: 0 }, uTo: { value: 0 },
    uVariant: { value: null }, uCropMin: { value: new Vector2() }, uCropSize: { value: new Vector2(1, 1) },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = VERTEX_DECL + shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERTEX_BODY}`);
    shader.fragmentShader = FRAGMENT_DECL + shader.fragmentShader.replace('#include <map_fragment>', FRAGMENT_MAP);
  };
  material.customProgramCacheKey = () => 'nami-garment-flap-v4';
  bikini.material = material;

  let prepared = false, variantTexture = null, outfit = originalId, transition = null, accumulator = 0;
  let dirty = true, appliedVersion = -1, contact = null, triSag = null;
  let fold = 0;
  const restNormals = Float32Array.from(geometry.attributes.normal.array);
  const flaps = new Map(), flapWeight = new Float32Array(count), flapSide = new Int8Array(count);
  const patchSorted = new Float32Array(count), spin = new Quaternion();
  const preContact = new Float32Array(count * 3), corrected = new Float32Array(count * 3), touched = new Uint8Array(count), weldFirst = new Int32Array(welded.size);
  for (let i = count - 1; i >= 0; i--) weldFirst[vertexKeys[i]] = i;
  const tension = new Map([[1, new Vector3()], [-1, new Vector3()]]), tensionNow = { 1: false, [-1]: false }, tensionWas = { 1: false, [-1]: false };
  const straps = new Map([1, -1].map((side) => [side, { side, grabbed: false, grab: 0.5, center: new Vector3(), offset: new Vector3(), velocity: new Vector3(),
    target: new Vector3(), normal: new Vector3(), anchor: new Vector3(), toBind: new Matrix3(),
    dist: new Float32Array(count), reach: 0, pull: 0, dir: new Vector3() }]));
  const panels = new Map([1, -1].map(side => [side, { side, grabbed: false, center: new Vector3(), offset: new Vector3(), reach: 0, reachCount: 0, share: 0, dist: new Float32Array(count),
    velocity: new Vector3(), target: new Vector3(), normal: new Vector3(), anchor: new Vector3(), toBind: new Matrix3() }]));
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), p = new Vector3(), q = new Vector3(), n = new Vector3();
  const blend = new Matrix4(), bone = new Matrix4(), world = new Matrix4();

  const variantCrop = { canvas: null, context: null, pristine: null };
  function prepareVariantCanvas() {
    const map = material.map, image = map?.image;
    if (!image) throw new Error('Garments: BikiniTop has no painted color map');
    const uv = geometry.getAttribute('uv');
    let u0 = 1, u1 = 0, v0 = 1, v1 = 0;
    for (let i = 0; i < uv.count; i++) { u0 = Math.min(u0, uv.getX(i)); u1 = Math.max(u1, uv.getX(i)); v0 = Math.min(v0, uv.getY(i)); v1 = Math.max(v1, uv.getY(i)); }
    const W = image.width, H = image.height, pad = 4;
    const x0 = Math.max(0, Math.floor(u0 * W) - pad), x1 = Math.min(W, Math.ceil(u1 * W) + pad);
    // glTF textures are not flipped: image row = v * height.
    const y0 = Math.max(0, Math.floor(v0 * H) - pad), y1 = Math.min(H, Math.ceil(v1 * H) + pad);
    const canvas = document.createElement('canvas');
    canvas.width = x1 - x0; canvas.height = y1 - y0;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, x0, y0, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    Object.assign(variantCrop, { canvas, context, pristine: context.getImageData(0, 0, canvas.width, canvas.height) });
    uniforms.uCropMin.value.set(x0 / W, y0 / H);
    uniforms.uCropSize.value.set((x1 - x0) / W, (y1 - y0) / H);
  }
  /** Repaints the variant endpoint (shader slot B) with the named colorway. */
  function setVariant(id) {
    const spec = colorways[id];
    if (!spec) throw new Error(`Garments: ${id} has no top recolor`);
    if (!variantCrop.canvas) prepareVariantCanvas();
    const { canvas, context, pristine } = variantCrop;
    const pixels = new ImageData(new Uint8ClampedArray(pristine.data), canvas.width, canvas.height);
    recolorPixels(pixels.data, spec); context.putImageData(pixels, 0, 0);
    variantTexture?.dispose();
    variantTexture = new CanvasTexture(canvas);
    variantTexture.flipY = false; variantTexture.colorSpace = SRGBColorSpace; variantTexture.anisotropy = material.map.anisotropy;
    uniforms.uVariant.value = variantTexture;
  }

  function buildContact() {
    if (contact) return;
    contact = createClothContact(entry, bodyEntry, strapAttr);
    triSag = contact.restSag(entry.indices, rest);
    buildFlaps();
    uniforms.uOrigin.value.set(0, 1.47, 0.04);
    let reach = 0;
    for (let i = 0; i < count; i++) reach = Math.max(reach, p.fromArray(rest, i * 3).distanceTo(uniforms.uOrigin.value));
    uniforms.uSpan.value = reach;
  }

  // Per ribbon: its attachment point A, the cup centre C, the outward normal at A, and a
  // hinge FLAP.hinge from A toward the cup. Ribbon vertices fold fully; cup vertices
  // between the hinge and A (within FLAP.reach of A) form the small flap that falls with it.
  function buildFlaps() {
    if (flaps.size) return;
    for (const side of [1, -1]) {
      const ribbon = [], cup = [];
      for (let i = 0; i < count; i++) {
        if (strapAttr[i * 2] === side) ribbon.push(i);
        else if (cupAttr[i] === side) cup.push(i);
      }
      if (!ribbon.length || !cup.length) continue;
      ribbon.sort((x, y) => strapAttr[x * 2 + 1] - strapAttr[y * 2 + 1]);
      const A = new Vector3(), C = new Vector3(), N = new Vector3(), root = Math.max(1, Math.floor(ribbon.length * 0.1));
      for (let k = 0; k < root; k++) A.add(p.fromArray(rest, ribbon[k] * 3));
      A.divideScalar(root);
      for (const i of cup) C.add(p.fromArray(rest, i * 3));
      C.divideScalar(cup.length);
      for (let i = 0; i < count; i++) if (p.fromArray(rest, i * 3).distanceTo(A) < 0.04) N.add(q.fromArray(restNormals, i * 3));
      if (N.lengthSq() === 0) N.set(0, 0, 1);
      N.normalize();
      if (N.z < 0) N.negate();
      const along = C.clone().sub(A);
      along.addScaledVector(N, -along.dot(N));
      if (along.lengthSq() < 1e-10) continue;
      along.normalize();
      // Gravity decides the pose: from where the ribbon leaves the cup (up and back over the
      // shoulder) it swings to hang straight down, a little forward so it clears the body,
      // and presses onto whatever cup it lands on. That is the shortest rotation between
      // the two directions; the hinge sits FLAP.hinge below the attachment on the cup.
      const top = new Vector3(), crown = ribbon.slice(-root);
      for (const i of crown) top.add(p.fromArray(rest, i * 3));
      top.divideScalar(crown.length).sub(A);
      if (top.lengthSq() < 1e-10) continue;
      const hang = new Vector3(0, -1, 0.2).normalize(), leave = top.normalize();
      const axis = new Vector3().crossVectors(leave, hang);
      if (axis.lengthSq() < 1e-10) continue;
      axis.normalize();
      const hinge = A.clone().addScaledVector(along, FLAP.hinge), angle = Math.acos(Math.max(-1, Math.min(1, leave.dot(hang))));
      // Fold plane: `g` is the way the cloth runs past the hinge toward the ribbon, `normalDir`
      // the way it folds, `axis` the hinge line. Cup cloth beyond the hinge within FLAP.reach of
      // the attachment forms the flap; its edge fades out so the flap has no hard boundary.
      flaps.set(side, { axis, hinge, angle, g: leave.clone(), normalDir: new Vector3().crossVectors(axis, leave) });
      for (const i of ribbon) { flapWeight[i] = 1; flapSide[i] = side; }
      for (const i of cup) {
        p.fromArray(rest, i * 3);
        const beyondHinge = q.subVectors(p, hinge).dot(leave), d = p.distanceTo(A);
        if (beyondHinge <= 0 || d >= FLAP.reach) continue;
        flapWeight[i] = 1 - smooth(FLAP.reach * 0.7, FLAP.reach, d);
        flapSide[i] = side;
      }
    }
  }

  function apply() {
    if (!dirty && appliedVersion === entry.geometry.attributes.position.version) return;
    dirty = false; appliedVersion = entry.geometry.attributes.position.version;
    positions.set(entry.positions);
    let moving = fold > 0;
    for (const part of straps.values()) moving ||= part.offset.lengthSq() > 0;
    for (const part of panels.values()) moving ||= part.offset.lengthSq() > 0;
    if (moving) {
      touched.fill(0);
      buildContact(); contact.refresh();
      for (const part of straps.values()) {
        part.pull = Math.min(1, part.offset.length() / STRAP.maxPull);
        if (part.pull > 0) part.dir.copy(part.offset).normalize();
      }
      for (let i = 0; i < count; i++) {
        const rep = weldRep[i];
        if (rep !== i) { positions[i * 3] = positions[rep * 3]; positions[i * 3 + 1] = positions[rep * 3 + 1]; positions[i * 3 + 2] = positions[rep * 3 + 2]; continue; }
        const side = strapAttr[i * 2];
        p.fromArray(rest, i * 3); q.set(0, 0, 0);
        // One continuous field: every grab carries every vertex by a weight of its distance ALONG
        // the garment (cups, ribbons and neck loop alike), faded to zero toward the pinned band.
        let gap = 0;
        for (const part of straps.values()) {
          if (part.pull === 0) continue;
          const k = falloff(part.dist[i], 0, part.reach);
          if (k <= 0) continue;
          q.addScaledVector(part.offset, k);
          // The pulled garment also stands off the skin, most toward the pull, and not at the neck.
          if (liftFade[i] > 0) {
            const cc = cupCenter.get(part.side);
            const lead = ((p.x - cc.x) * part.dir.x + (p.y - cc.y) * part.dir.y + (p.z - cc.z) * part.dir.z) / CUP_LIFT.extent;
            gap += CUP_LIFT.gap * part.pull ** 0.6 * k * k * liftFade[i] * smooth(CUP_LIFT.lead[0], CUP_LIFT.lead[1], lead);
          }
        }
        // A cup pull carries a patch holding half of all garment vertices, by the same distance.
        for (const part of panels.values()) {
          if (part.reach <= 0 || part.offset.lengthSq() === 0) continue;
          q.addScaledVector(part.offset, falloff(part.dist[i], PULL_PATCH.plateau * part.reach, part.reach));
        }
        q.multiplyScalar(pinFactor[i]); gap *= pinFactor[i];
        const fw = fold > 0 ? flapWeight[i] : 0;
        if (fw === 0 && q.lengthSq() < 1e-16 && gap < 1e-9) continue;
        p.fromArray(entry.positions, i * 3).add(q);
        if (fw > 0) {
          // Bend about the hinge along a circular arc of length FLAP.bend, then run straight.
          // Cloth length is preserved, so the crease cannot crumple; the result is then kept
          // above the cup it lies on.
          const flap = flaps.get(flapSide[i]), psi = fold * flap.angle;
          q.subVectors(p, flap.hinge);
          const x = q.dot(flap.g), y = q.dot(flap.normalDir), z = q.dot(flap.axis);
          if (x > 0) {
            const rho = FLAP.bend / psi;
            let along1, out1;
            if (x < FLAP.bend) {
              const th = psi * x / FLAP.bend, sn = Math.sin(th), cs = Math.cos(th);
              along1 = rho * sn - y * sn; out1 = rho * (1 - cs) + y * cs;
            } else {
              const sn = Math.sin(psi), cs = Math.cos(psi), run = x - FLAP.bend;
              along1 = rho * sn + run * cs - y * sn; out1 = rho * (1 - cs) + run * sn + y * cs;
            }
            a.copy(flap.hinge).addScaledVector(flap.g, along1).addScaledVector(flap.normalDir, out1).addScaledVector(flap.axis, z);
            p.lerp(a, fw);
          }
          // The folded flap keeps its own lift: no smoothing correction, but the skin guard applies.
          contact.lift(i, p, n, (side ? FLAP.ribbonLift : FLAP.lift) * smooth(0, 0.5, psi * fw)).toArray(positions, i * 3);
          settled[i] = contact.settledHeight(); touched[i] = 1;
          n.toArray(preContact, i * 3);
        } else {
          p.toArray(preContact, i * 3); touched[i] = 1;
          contact.project(i, p, n, gap).toArray(positions, i * 3);
          settled[i] = contact.settledHeight();
        }
      }
    }
    if (moving) steadyContact();
    geometry.attributes.position.needsUpdate = true;
    if (moving) geometry.computeVertexNormals();
    else { geometry.attributes.normal.array.set(entry.geometry.attributes.normal.array); geometry.attributes.normal.needsUpdate = true; }
  }
  /** Bounds how far one vertex's contact correction may disagree with its neighbours' average. */
  function steadyContact() {
    const limit = CONTACT_STEADY.maxDisagreement;
    for (let i = 0; i < count; i++) {
      if (!touched[i]) continue;
      const k = i * 3;
      let sx = 0, sy = 0, sz = 0, n0 = 0;
      const w = vertexKeys[i];
      for (let e = graph.start[w]; e < graph.start[w + 1]; e++) {
        const j = weldFirst[graph.neighbor[e]] * 3;
        if (touched[j / 3]) { sx += positions[j] - preContact[j]; sy += positions[j + 1] - preContact[j + 1]; sz += positions[j + 2] - preContact[j + 2]; }
        n0++;
      }
      if (n0 === 0) { corrected[k] = positions[k]; corrected[k + 1] = positions[k + 1]; corrected[k + 2] = positions[k + 2]; continue; }
      const mx = sx / n0, my = sy / n0, mz = sz / n0;
      let dx = positions[k] - preContact[k] - mx, dy = positions[k + 1] - preContact[k + 1] - my, dz = positions[k + 2] - preContact[k + 2] - mz;
      const len = Math.hypot(dx, dy, dz);
      if (len > limit) { const s = limit / len; dx *= s; dy *= s; dz *= s; }
      corrected[k] = preContact[k] + mx + dx; corrected[k + 1] = preContact[k + 1] + my + dy; corrected[k + 2] = preContact[k + 2] + mz + dz;
    }
    for (let i = 0; i < count; i++) {
      if (!touched[i]) continue;
      const k = i * 3;
      shiftNow[i] = Math.hypot(corrected[k] - positions[k], corrected[k + 1] - positions[k + 1], corrected[k + 2] - positions[k + 2]);
      positions[k] = corrected[k]; positions[k + 1] = corrected[k + 1]; positions[k + 2] = corrected[k + 2];
    }
    guardSkin();
    // Seam duplicates share their twin's final position.
    for (let i = 0; i < count; i++) {
      const rep = weldRep[i];
      if (rep !== i) { positions[i * 3] = positions[rep * 3]; positions[i * 3 + 1] = positions[rep * 3 + 1]; positions[i * 3 + 2] = positions[rep * 3 + 2]; }
    }
  }
  const raise = new Float32Array(count), raiseNormal = new Float32Array(count * 3), raiseSpread = new Float32Array(count);
  const settled = new Float32Array(count), shiftNow = new Float32Array(count), heightNow = new Float32Array(count), recheck = new Uint8Array(count);
  const faceIndex = entry.indices;
  /**
   * The garment is the outer layer: lift any vertex (and any triangle centre) nearer the skin than
   * SKIN_GUARD.floor, along the skin normal only, smoothly. Cheap: a vertex is measured only when the
   * contact step's height minus the smoothing shift could be below the floor; a triangle centre only
   * when its lowest corner is within the triangle's rest sag of the floor; later passes only re-measure
   * what the previous pass moved.
   */
  const guardStats = { measuredVertices: 0, measuredTriangles: 0, liftedVertices: 0, passes: 0, violations: [] };
  function guardSkin() {
    const floor = SKIN_GUARD.floor;
    guardStats.measuredVertices = 0; guardStats.measuredTriangles = 0; guardStats.liftedVertices = 0; guardStats.passes = 0; guardStats.violations = [];
    for (let pass = 0; pass < SKIN_GUARD.passes; pass++) {
      let violations = 0;
      guardStats.passes = pass + 1;
      for (let i = 0; i < count; i++) {
        raise[i] = 0;
        if (!touched[i]) continue;
        if (pass === 0) {
          const lower = settled[i] - shiftNow[i];
          if (lower >= floor + SKIN_GUARD.pruneSlack) { heightNow[i] = lower; continue; }
        } else if (!recheck[i]) continue;
        p.fromArray(positions, i * 3);
        const height = contact.measure(i, p, n);
        guardStats.measuredVertices++;
        heightNow[i] = height;
        raiseNormal[i * 3] = n.x; raiseNormal[i * 3 + 1] = n.y; raiseNormal[i * 3 + 2] = n.z;
        if (height < floor - 1e-6) { raise[i] = (floor - height) * SKIN_GUARD.relax; violations++; }
      }
      for (let t = 0; t < faceIndex.length; t += 3) {
        const ia = faceIndex[t], ib = faceIndex[t + 1], ic = faceIndex[t + 2], ra = weldRep[ia], rb = weldRep[ib], rc = weldRep[ic];
        if (!touched[ra] && !touched[rb] && !touched[rc]) continue;
        if (pass > 0 && !recheck[ra] && !recheck[rb] && !recheck[rc]) continue;
        const lowest = Math.min(touched[ra] ? heightNow[ra] : 0, touched[rb] ? heightNow[rb] : 0, touched[rc] ? heightNow[rc] : 0);
        const required = Math.max(SKIN_GUARD.centreMin, floor - SKIN_GUARD.sagFactor * triSag[t / 3]);
        if (lowest - required >= triSag[t / 3] * SKIN_GUARD.sagFactor + SKIN_GUARD.centreSlack) continue;
        p.set((positions[ia * 3] + positions[ib * 3] + positions[ic * 3]) / 3, (positions[ia * 3 + 1] + positions[ib * 3 + 1] + positions[ic * 3 + 1]) / 3, (positions[ia * 3 + 2] + positions[ib * 3 + 2] + positions[ic * 3 + 2]) / 3);
        const height = contact.measure(ra, p, n);
        guardStats.measuredTriangles++;
        if (height >= required) continue;
        const deficit = (required - height) * SKIN_GUARD.relax;
        for (const rv of [ra, rb, rc]) {
          if (deficit > raise[rv]) { raise[rv] = deficit; raiseNormal[rv * 3] = n.x; raiseNormal[rv * 3 + 1] = n.y; raiseNormal[rv * 3 + 2] = n.z; touched[rv] = 1; }
        }
        violations++;
      }
      guardStats.violations.push(violations);
      if (!violations) return;
      // Spread: a vertex is lifted at least by its own deficit, and by half the neighbour mean, so a
      // lifted patch rises smoothly instead of leaving a step at its border.
      recheck.fill(0);
      for (let i = 0; i < count; i++) {
        if (!touched[i]) { raiseSpread[i] = 0; continue; }
        const w = vertexKeys[i];
        let sum = 0, k = 0;
        for (let e = graph.start[w]; e < graph.start[w + 1]; e++) { sum += raise[weldFirst[graph.neighbor[e]]]; k++; }
        raiseSpread[i] = Math.max(raise[i], 0.5 * (raise[i] + (k ? sum / k : 0)));
      }
      for (let i = 0; i < count; i++) {
        const r = raiseSpread[i];
        if (r <= 0 || !touched[i]) continue;
        positions[i * 3] += raiseNormal[i * 3] * r; positions[i * 3 + 1] += raiseNormal[i * 3 + 1] * r; positions[i * 3 + 2] += raiseNormal[i * 3 + 2] * r;
        recheck[i] = 1; guardStats.liftedVertices++;
        const w = vertexKeys[i];
        for (let e = graph.start[w]; e < graph.start[w + 1]; e++) { const j = weldFirst[graph.neighbor[e]]; if (touched[j]) recheck[j] = 1; }
      }
    }
  }
  function prepare() {
    if (prepared) return;
    prepareVariantCanvas(); buildContact(); prepared = true;
  }

  function skinLinear(index, out) {
    const skin = geometry.getAttribute('skinIndex'), weight = geometry.getAttribute('skinWeight'), skeleton = bikini.skeleton;
    blend.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    for (let k = 0; k < 4; k++) {
      const w = weight.getComponent(index, k);
      if (!w) continue;
      const j = skin.getComponent(index, k);
      bone.multiplyMatrices(skeleton.bones[j].matrixWorld, skeleton.boneInverses[j]);
      for (let e = 0; e < 16; e++) blend.elements[e] += w * bone.elements[e];
    }
    world.copy(bikini.matrixWorld).multiply(bikini.bindMatrixInverse).multiply(blend).multiply(bikini.bindMatrix);
    return out.setFromMatrix4(world);
  }

  /** Returns ±1 when an actual ray hit lands on a grabbable part of a halter strap. */
  function strapSide(hit) {
    if (!hit || hit.object !== bikini || !hit.face || transition) return 0;
    const ids = [hit.face.a, hit.face.b, hit.face.c], side = strapAttr[ids[0] * 2];
    if (!side || ids.some((i) => strapAttr[i * 2] !== side)) return 0;
    const s = ids.reduce((sum, i) => sum + strapAttr[i * 2 + 1], 0) / 3;
    return s >= STRAP.grabMin && s <= STRAP.grabMax ? side : 0;
  }
  /** Distance along the garment from a grab (its face vertices) to every vertex. */
  function fieldFor(part, ids) { distanceField(graph, rest, ids, part.center, part.dist); }
  /**
   * How far a ribbon pull reaches, measured on the garment: the distance along the surface (through
   * the neck loop) to the mirror point on the other ribbon, times STRAP_FIELD.reachFactor.
   */
  function strapReach(part) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < count; i++) {
      if (strapAttr[i * 2] !== -part.side) continue;
      const d = Math.hypot(rest[i * 3] + part.center.x, rest[i * 3 + 1] - part.center.y, rest[i * 3 + 2] - part.center.z);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) return STRAP_FIELD.fallbackReach;
    return Math.max(STRAP_FIELD.minReach, STRAP_FIELD.reachFactor * part.dist[best]);
  }
  function grabStrap(hit, side, anchor = hit?.point) {
    const strap = straps.get(side);
    if (!strap || strap.grabbed || panels.get(side).grabbed || strapSide(hit) !== side) return false;
    const ids = [hit.face.a, hit.face.b, hit.face.c];
    strap.grab = Math.min(STRAP.grabMax, Math.max(STRAP.grabMin, ids.reduce((sum, i) => sum + strapAttr[i * 2 + 1], 0) / 3));
    a.fromArray(rest, ids[0] * 3); b.fromArray(rest, ids[1] * 3); c.fromArray(rest, ids[2] * 3);
    n.subVectors(b, a).cross(q.subVectors(c, a)).normalize();
    p.copy(a).add(b).add(c).divideScalar(3); strap.center.copy(p);
    fieldFor(strap, ids);
    strap.reach = strapReach(strap);
    // Outward = away from the neck/torso axis behind the strap.
    if (n.dot(q.set(p.x, 0, p.z + 0.03)) < 0) n.negate();
    strap.normal.copy(n); strap.anchor.copy(anchor);
    skinLinear(ids[0], strap.toBind).invert();
    strap.grabbed = true; strap.target.set(0, 0, 0);
    return true;
  }
  function dragStrap(side, worldPoint) {
    const strap = straps.get(side);
    if (!strap?.grabbed) return false;
    p.subVectors(worldPoint, strap.anchor).applyMatrix3(strap.toBind);
    limitPull(p, strap.normal, STRAP.maxPull, strap.target);
    return true;
  }
  function releaseStrap(side) {
    const strap = straps.get(side);
    if (!strap?.grabbed) return false;
    strap.grabbed = false; strap.target.set(0, 0, 0);
    // Dropping the tension lets the chest spring rebound from where the strap held it.
    rig.setTension(CHEST[side], null);
    return true;
  }
  function panelSide(hit) {
    if (!hit || hit.object !== bikini || transition || !Number.isInteger(hit.faceIndex)) return 0;
    return panelFaces[hit.faceIndex] || 0;
  }
  function grabPanel(hit, side, anchor = hit?.point) {
    const panel = panels.get(side);
    if (!panel || panel.grabbed || straps.get(side).grabbed || panel.offset.lengthSq() > 1e-12 || panelSide(hit) !== side) return false;
    const ids = [hit.face.a, hit.face.b, hit.face.c];
    a.fromArray(rest, ids[0] * 3); b.fromArray(rest, ids[1] * 3); c.fromArray(rest, ids[2] * 3);
    panel.center.copy(a).add(b).add(c).divideScalar(3);
    // The pulled patch: the nearest PULL_PATCH.share of ALL garment vertices (by distance along
    // the garment) follows the grab.
    fieldFor(panel, ids);
    patchSorted.set(panel.dist);
    patchSorted.sort();
    panel.reach = patchSorted[Math.min(count - 1, Math.floor(count * PULL_PATCH.share))];
    panel.reachCount = 0;
    for (let i = 0; i < count; i++) if (panel.dist[i] < panel.reach) panel.reachCount++;
    // How strongly that patch reaches the OTHER cup (the fabric across the chest).
    let reached = 0, other = 0;
    for (let i = 0; i < count; i++) {
      if (cupAttr[i] !== -side) continue;
      other++; reached += falloff(panel.dist[i], PULL_PATCH.plateau * panel.reach, panel.reach);
    }
    panel.share = other ? reached / other : 0;
    n.subVectors(b, a).cross(q.subVectors(c, a)).normalize();
    if (n.z < 0) n.negate();
    panel.normal.copy(n); panel.anchor.copy(anchor);
    skinLinear(ids[0], panel.toBind).invert();
    panel.grabbed = true; panel.target.set(0, 0, 0);
    return true;
  }
  function dragPanel(side, worldPoint) {
    const panel = panels.get(side);
    if (!panel?.grabbed) return false;
    p.subVectors(worldPoint, panel.anchor).applyMatrix3(panel.toBind);
    const along = p.dot(panel.normal);
    // Limit normal lift: this is a worn, connected garment, not a removable cup.
    p.addScaledVector(panel.normal, Math.min(0.002, Math.max(0, along)) - along);
    limitPull(p, panel.normal, PANEL.maxPull, panel.target);
    return true;
  }
  function releasePanel(side) {
    const panel = panels.get(side);
    if (!panel?.grabbed) return false;
    panel.grabbed = false; panel.target.set(0, 0, 0);
    rig.setTension(CHEST[side], null);
    return true;
  }
  function releaseAll() { for (const side of straps.keys()) { releaseStrap(side); releasePanel(side); } }

  function stepStraps(dt) {
    for (const strap of straps.values()) {
      const omega = 2 * Math.PI * (strap.grabbed ? STRAP.holdFrequency : STRAP.frequency);
      const zeta = strap.grabbed ? 1 : STRAP.dampingRatio;
      // Semi-implicit spring at a fixed 1/240 s sub-step; stable for both profiles.
      p.subVectors(strap.offset, strap.target).multiplyScalar(-omega * omega).addScaledVector(strap.velocity, -2 * zeta * omega);
      strap.velocity.addScaledVector(p, dt); strap.offset.addScaledVector(strap.velocity, dt);
      if (!strap.grabbed && strap.offset.lengthSq() < 1e-12 && strap.velocity.lengthSq() < 1e-10) { strap.offset.set(0, 0, 0); strap.velocity.set(0, 0, 0); }
    }
    for (const panel of panels.values()) {
      const omega = 2 * Math.PI * (panel.grabbed ? STRAP.holdFrequency : PANEL.frequency);
      const zeta = panel.grabbed ? 1 : PANEL.dampingRatio;
      p.subVectors(panel.offset, panel.target).multiplyScalar(-omega * omega).addScaledVector(panel.velocity, -2 * zeta * omega);
      panel.velocity.addScaledVector(p, dt); panel.offset.addScaledVector(panel.velocity, dt);
      const inward = panel.offset.dot(panel.normal);
      if (inward < 0) {
        panel.offset.addScaledVector(panel.normal, -inward);
        const speed = panel.velocity.dot(panel.normal);
        if (speed < 0) panel.velocity.addScaledVector(panel.normal, -speed);
      }
      if (!panel.grabbed && panel.offset.lengthSq() < 1e-12 && panel.velocity.lengthSq() < 1e-10) { panel.offset.set(0, 0, 0); panel.velocity.set(0, 0, 0); }
    }
  }
  function update(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    dirty = true;
    accumulator = Math.min(accumulator + dt, 0.1);
    while (accumulator >= SUBSTEP) { stepStraps(SUBSTEP); accumulator -= SUBSTEP; }
    // Tension on each chest region: its own ribbon, its own cup pull, and the share of the
    // other cup's pull that reaches it across the chest.
    for (const side of [1, -1]) { tension.get(side).set(0, 0, 0); tensionNow[side] = false; }
    for (const strap of straps.values()) {
      if (!strap.grabbed) continue;
      const region = rig.regions.get(CHEST[strap.side]);
      if (!region) continue;
      const ratio = Math.min(1, strap.offset.length() / STRAP.maxPull);
      if (ratio) tension.get(strap.side).add(p.copy(strap.offset).normalize().multiplyScalar(ratio * region.profile.cap * STRAP.tension));
      tensionNow[strap.side] = true;
    }
    for (const panel of panels.values()) {
      if (!panel.grabbed) continue;
      tension.get(panel.side).addScaledVector(panel.offset, 0.15); tensionNow[panel.side] = true;
      if (panel.share > 0) { tension.get(-panel.side).addScaledVector(panel.offset, 0.15 * panel.share); tensionNow[-panel.side] = true; }
    }
    for (const side of [1, -1]) {
      if (!tensionNow[side] && !tensionWas[side]) continue;
      if (rig.regions.has(CHEST[side])) rig.setTension(CHEST[side], tensionNow[side] ? tension.get(side) : null);
      tensionWas[side] = tensionNow[side];
    }
    if (transition) {
      transition.t += dt;
      const phase = transitionPhase(transition.t, reducedMotion);
      applyPhase(phase);
      if (phase.done) finishTransition();
    }
  }
  /** Sets the pose directly: fold 0..1 (flap + ribbons), neck-end cut, glow and recolor morph. */
  function applyPhase({ fold: f, cut, glow, morph }) {
    fold = f; uniforms.uCut.value = cut; uniforms.uGlow.value = glow; uniforms.uMorph.value = morph; dirty = true;
  }
  function finishTransition() {
    if (!transition) return;
    outfit = transition.to; transition = null;
    const index = outfit === originalId ? 0 : 1;
    uniforms.uFrom.value = index; uniforms.uTo.value = index;
    applyPhase({ fold: 0, cut: 0, glow: 0, morph: 0 });
  }
  function transformTo(target) {
    if (!colorwayIds.includes(target)) throw new Error(`Garments: unknown outfit ${target}`);
    if (transition || target === outfit) return false;
    for (const side of [1, -1]) if (straps.get(side).grabbed || panels.get(side).grabbed) return false;
    prepare();
    const fromIndex = outfit === originalId ? 0 : 1, toIndex = target === originalId ? 0 : 1;
    if (toIndex === 1) setVariant(target);
    if (fromIndex === 1 && toIndex === 1) {
      // Between two repaints there is no original endpoint to fold toward: swap the repaint in place.
      outfit = target; uniforms.uFrom.value = 1; uniforms.uTo.value = 1; dirty = true;
      return true;
    }
    uniforms.uFrom.value = fromIndex; uniforms.uTo.value = toIndex;
    transition = { t: 0, from: outfit, to: target };
    return true;
  }
  function reset() {
    releaseAll();
    contact?.reset();
    dirty = true;
    for (const strap of straps.values()) { strap.offset.set(0, 0, 0); strap.velocity.set(0, 0, 0); strap.target.set(0, 0, 0); }
    for (const panel of panels.values()) { panel.offset.set(0, 0, 0); panel.velocity.set(0, 0, 0); panel.target.set(0, 0, 0); }
    finishTransition();
    applyPhase({ fold: 0, cut: 0, glow: 0, morph: 0 });
  }
  function dispose() {
    reset();
    bikini.material = originalMaterial; material.dispose(); variantTexture?.dispose();
    bikini.geometry = entry.geometry; geometry.dispose();
  }
  /** Weight (0..1) each vertex receives from the last grab of this part, for inspection. */
  function influence(kind, side) {
    const part = (kind === 'strap' ? straps : panels).get(side), out = new Float32Array(count);
    if (!part || part.reach <= 0) return out;
    const plateau = kind === 'strap' ? 0 : PULL_PATCH.plateau * part.reach;
    for (let i = 0; i < count; i++) out[i] = falloff(part.dist[i], plateau, part.reach) * pinFactor[i];
    return out;
  }
  return { prepare, update, apply, applyPhase, influence, transformTo, reset, dispose, strapSide, grabStrap, dragStrap, releaseStrap, panelSide, grabPanel, dragPanel, releasePanel, releaseAll, uniforms,
    get outfit() { return outfit; }, get colorways() { return [...colorwayIds]; }, get transitioning() { return Boolean(transition); }, get prepared() { return prepared; },
    getState: () => ({ skinGuard: { ...guardStats }, outfit, fold, transition: transition && { ...transition, phase: transitionPhase(transition.t, reducedMotion) },
      panels: [...panels.values()].map(s => ({ side: s.side, grabbed: s.grabbed, reach: s.reach, reachCount: s.reachCount, share: s.share, center: s.center.toArray(), offset: s.offset.toArray(), velocity: s.velocity.toArray() })),
      straps: [...straps.values()].map((s) => ({ side: s.side, grabbed: s.grabbed, grab: s.grab, reach: s.reach, offset: s.offset.toArray(), velocity: s.velocity.toArray() })) }) };
}
