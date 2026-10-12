import * as THREE from 'three';
import type { SurfaceEvidence } from './measured/surfaceCodec';

export interface PalmWind {
  tick(elapsed: number, reducedMotion: boolean): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Wind shader (preserves public placement API).
//
// The measured static mesh has no leaf bones. Wind and botany are evaluated in
// normalized placement units; trunk coordinates are in half-unit mesh space
// but flow into the same `palmDisplace` helper via `palmToPlacement`.
// ---------------------------------------------------------------------------
const WIND_GLSL = `
  uniform float palmTime;
  uniform float palmPhase;
  uniform float palmCrownY;
  uniform float palmCrownBand;
  uniform mat4 palmToPlacement;
  uniform mat3 palmWorldToLocal;
  uniform vec2 palmCrown;
  uniform float palmLeaf;

  vec3 palmDisplace(vec3 p) {
    vec3 normalized = (palmToPlacement * vec4(p, 1.0)).xyz;
    float heightWeight = palmLeaf > 0.5 ? 1.0 : smoothstep(palmCrownY - palmCrownBand, palmCrownY, normalized.y);
    vec2 arm = normalized.xz - palmCrown;
    float radius = length(arm);
    float tipWeight = smoothstep(0.22, 0.85, radius);
    float weight = heightWeight * tipWeight * (0.55 + 0.85 * palmLeaf);
    float gust = 0.72 + 0.28 * sin(palmTime * 0.21 + palmPhase);
    float bend = sin(palmTime * 1.45 + palmPhase + radius * 2.3)
      * (0.65 + 0.20 * sin(palmTime * 2.9 + normalized.y));
    float flutter = sin(palmTime * 5.1 + arm.x * 4.7 + arm.y * 3.1 + palmPhase);
    vec3 worldOffset = vec3(0.92, 0.0, 0.39) * (0.13 * bend * gust);
    worldOffset += vec3(-0.39, 0.0, 0.92) * (0.018 * flutter * tipWeight);
    worldOffset.y -= 0.015 * abs(bend);
    return palmWorldToLocal * (worldOffset * weight);
  }
`;

interface FrondParams {
  /** Major fronds in the reference crown. */
  readonly count: number;
  /** Longest rachis length in placement units. */
  readonly length: number;
  /** Cross-section samples along the frond length (drives the leaf ribbon and slits). */
  readonly lengthSamples: number;
  /** Coarse edge cuts visible in the stylized reference. */
  readonly minSlits: number;
  /** Maximum slits per side. */
  readonly maxSlits: number;
  /** Maximum full-width of a single lamina at its widest point (scene units). */
  readonly maxWidth: number;
  /** Minimum full-width of a single lamina at its widest point (scene units). */
  readonly minWidth: number;
}

const DEFAULT_FRONDS: FrondParams = {
  count: 9,
  length: 1.45,
  lengthSamples: 64,
  minSlits: 5,
  maxSlits: 8,
  maxWidth: 0.58,
  minWidth: 0.40,
};

// ---------------------------------------------------------------------------
// Botany helpers
// ---------------------------------------------------------------------------

interface LeafScrubStats {
  /** Trunk triangles kept. */
  readonly kept: number;
  /** Leaf triangles removed. */
  readonly removed: number;
  /** Placement-space top of the RETAINED trunk crown (NOT the removed canopy). */
  readonly trunkTopY: number;
  /** Mean placement-space XZ of the RETAINED upper-trunk band. */
  readonly trunkCrown: THREE.Vector2;
  /** Bounding radius of the retained upper-trunk XZ (for crown size). */
  readonly trunkCrownRadius: number;
}

/**
 * Rebuild the source geometry keeping only trunk triangles. Per-original
 * triangle classification is read from the measured-surface evidence array on
 * `geometry.userData.surfaceEvidence.triangleClasses`:
 *
 *   bit 0 = leaf (!(r > g * 1.08 && r > b * 1.15)) at the source centroid UV
 *
 * Spatial decisions (canopy floor, normal-driven bark ring, retained-trunk
 * top) remain runtime — they derive from the original mesh's positions and
 * normals.
 *
 * The returned `trunkTopY` / `trunkCrown` describe the RETAINED upper trunk
 * band so the procedural fronds attach to the actual visible crown, not the
 * stripped canopy.
 */
function scrubPalmLeaves(
  mesh: THREE.Mesh,
  placement: THREE.Group,
): LeafScrubStats {
  const source = mesh.geometry;
  const pos = source.getAttribute('position');
  const norm = source.getAttribute('normal');
  const colourAttr = source.getAttribute('color');
  const index = source.getIndex();
  if (!pos || !index || !norm) {
    throw new Error('Palm scrub requires indexed geometry with normals.');
  }
  if (!(colourAttr instanceof THREE.BufferAttribute) || colourAttr.itemSize !== 3) {
    throw new Error('Palm scrub requires per-vertex colour (itemSize=3) on the source geometry.');
  }
  const evidence = (source.userData as { surfaceEvidence?: SurfaceEvidence }).surfaceEvidence;
  const flags = evidence?.triangleClasses;
  if (!(flags instanceof Uint8Array)) {
    throw new Error('Palm scrub requires measured triangleClasses on geometry.userData.');
  }

  placement.updateWorldMatrix(true, true);
  const toPlacement = new THREE.Matrix4().multiplyMatrices(
    placement.matrixWorld.clone().invert(), mesh.matrixWorld,
  );
  const point = new THREE.Vector3();
  const vertCount = pos.count;
  const triCount = Math.floor(index.count / 3);
  if (flags.length !== triCount) {
    throw new Error(
      `Palm scrub: triangleClasses length (${flags.length}) does not match the original triangle count (${triCount}).`,
    );
  }

  // First pass: placement-space height extents to define the canopy band.
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < vertCount; i += 1) {
    point.fromBufferAttribute(pos, i).applyMatrix4(toPlacement);
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  const canopyFloor = minY + (maxY - minY) * 0.45;

  // Classify triangles and accumulate the RETAINED upper-trunk crown.
  const keepTri = new Uint8Array(triCount);
  const vertKept = new Uint8Array(vertCount);
  let kept = 0;
  let removed = 0;
  let trunkTopY = -Infinity;
  for (let t = 0; t < triCount; t += 1) {
    const a = index.getX(t * 3);
    const b = index.getX(t * 3 + 1);
    const c = index.getX(t * 3 + 2);
    point.set(
      (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3,
      (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3,
      (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3,
    ).applyMatrix4(toPlacement);
    const flag = flags[t]!;
    const isLeaf = (flag & 0b01) !== 0;
    // Hard guard: a triangle below the canopy band is trunk even if a stray
    // leaf patch happens to sit there (seam / mismatch with the retained band).
    if (point.y >= canopyFloor && isLeaf) {
      removed += 1;
      continue;
    }
    keepTri[t] = 1;
    vertKept[a] = 1;
    vertKept[b] = 1;
    vertKept[c] = 1;
    kept += 1;
    trunkTopY = Math.max(trunkTopY, point.y);
  }

  if (kept === 0) {
    throw new Error('Palm scrub removed every triangle; refusing to clobber trunk.');
  }

  // A few leaf-flagged triangles can slip past the canopy floor (seams, sparse
  // fragments overhanging the retained trunk). Locate the highest trunk slab
  // with outward normals around its full circumference, rather than attaching
  // a crown to an isolated, often back-facing triangle.
  const ringMasks = new Uint8Array(64);
  const ringHeight = (trunkTopY - minY) / ringMasks.length;
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(toPlacement);
  const direction = new THREE.Vector3();
  for (let v = 0; v < vertCount; v += 1) {
    if (!vertKept[v]) continue;
    direction.fromBufferAttribute(norm, v).applyNormalMatrix(normalMatrix);
    if (direction.x * direction.x + direction.z * direction.z < 0.25) continue;
    point.fromBufferAttribute(pos, v).applyMatrix4(toPlacement);
    const row = Math.min(63, Math.floor((point.y - minY) / ringHeight));
    const sector = Math.min(7, Math.floor((Math.atan2(direction.z, direction.x) + Math.PI) * 4 / Math.PI));
    ringMasks[row] |= 1 << sector;
  }
  let crownRing = ringMasks.length - 1;
  while (crownRing >= 0 && ringMasks[crownRing] !== 0xff) crownRing -= 1;
  if (crownRing < 0) throw new Error('Palm leaf extraction left no complete bark circumference.');
  trunkTopY = minY + (crownRing + 0.5) * ringHeight;
  vertKept.fill(0);
  for (let t = 0; t < triCount; t += 1) {
    if (!keepTri[t]) continue;
    const a = index.getX(t * 3), b = index.getX(t * 3 + 1), c = index.getX(t * 3 + 2);
    point.set(
      (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3,
      (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3,
      (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3,
    ).applyMatrix4(toPlacement);
    if (point.y > trunkTopY) {
      keepTri[t] = 0;
      kept -= 1;
      removed += 1;
    } else {
      vertKept[a] = vertKept[b] = vertKept[c] = 1;
    }
  }

  // Compact vertex arrays. The measured build carries only position + normal
  // + colour; UVs and textures are deliberately absent.
  const remap = new Int32Array(vertCount);
  remap.fill(-1);
  let next = 0;
  for (let v = 0; v < vertCount; v += 1) {
    if (vertKept[v]) remap[v] = next++;
  }
  const newPos = new Float32Array(next * 3);
  const newNorm = new Float32Array(next * 3);
  const newColour = new Float32Array(next * 3);
  for (let v = 0; v < vertCount; v += 1) {
    const r = remap[v];
    if (r < 0) continue;
    newPos[r * 3] = pos.getX(v);
    newPos[r * 3 + 1] = pos.getY(v);
    newPos[r * 3 + 2] = pos.getZ(v);
    newNorm[r * 3] = norm.getX(v);
    newNorm[r * 3 + 1] = norm.getY(v);
    newNorm[r * 3 + 2] = norm.getZ(v);
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

  const cleaned = new THREE.BufferGeometry();
  cleaned.setAttribute('position', new THREE.BufferAttribute(newPos, 3));
  cleaned.setAttribute('normal', new THREE.BufferAttribute(newNorm, 3));
  cleaned.setAttribute('color', new THREE.BufferAttribute(newColour, 3));
  cleaned.setIndex(new THREE.BufferAttribute(newIndex, 1));
  cleaned.computeBoundingBox();
  cleaned.computeBoundingSphere();
  mesh.geometry = cleaned;

  // Re-derive the retained upper trunk centroid + radius from the cleaned
  // geometry (in placement space) so the value is exact, not from a pre-scrub
  // sample.
  const finalPosAttr = cleaned.getAttribute('position');
  if (!(finalPosAttr instanceof THREE.BufferAttribute)) {
    throw new Error('Palm scrub expected position BufferAttribute on cleaned geometry.');
  }
  const finalPos = finalPosAttr;
  const finalIndex = cleaned.getIndex()!;
  const finalTriCount = Math.floor(finalIndex.count / 3);
  let fx = 0, fz = 0, fN = 0;
  let fRadius = 0;
  const finalPoint = new THREE.Vector3();
  const finalMatrix = mesh.matrixWorld;
  const placementInv = placement.matrixWorld.clone().invert();
  for (let t = 0; t < finalTriCount; t += 1) {
    const ia = finalIndex.getX(t * 3);
    const ib = finalIndex.getX(t * 3 + 1);
    const ic = finalIndex.getX(t * 3 + 2);
    finalPoint.set(
      (finalPos.getX(ia) + finalPos.getX(ib) + finalPos.getX(ic)) / 3,
      (finalPos.getY(ia) + finalPos.getY(ib) + finalPos.getY(ic)) / 3,
      (finalPos.getZ(ia) + finalPos.getZ(ib) + finalPos.getZ(ic)) / 3,
    ).applyMatrix4(finalMatrix).applyMatrix4(placementInv);
    if (finalPoint.y >= trunkTopY - 0.18) {
      fx += finalPoint.x;
      fz += finalPoint.z;
      fN += 1;
    }
  }
  let crownX = fN ? fx / fN : 0;
  let crownZ = fN ? fz / fN : 0;
  for (let t = 0; t < finalTriCount; t += 1) {
    const ia = finalIndex.getX(t * 3);
    const ib = finalIndex.getX(t * 3 + 1);
    const ic = finalIndex.getX(t * 3 + 2);
    finalPoint.set(
      (finalPos.getX(ia) + finalPos.getX(ib) + finalPos.getX(ic)) / 3,
      (finalPos.getY(ia) + finalPos.getY(ib) + finalPos.getY(ic)) / 3,
      (finalPos.getZ(ia) + finalPos.getZ(ib) + finalPos.getZ(ic)) / 3,
    ).applyMatrix4(finalMatrix).applyMatrix4(placementInv);
    if (finalPoint.y >= trunkTopY - 0.18) {
      const r = Math.hypot(finalPoint.x - crownX, finalPoint.z - crownZ);
      if (r > fRadius) fRadius = r;
    }
  }

  return {
    kept,
    removed,
    trunkTopY,
    trunkCrown: new THREE.Vector2(crownX, crownZ),
    trunkCrownRadius: fRadius,
  };
}

// ---------------------------------------------------------------------------
// Procedural frond mesh (curved rachis + broad folded lamina, single BufferGeometry)
// ---------------------------------------------------------------------------

/**
 * Build the combined arching rachis tube and broad folded lamina for a palm.
 * The geometry lives in placement-local space with the trunk crown at the
 * origin of the parent group; each frond radiates outward, the rachis is a
 * thin curved tube and the lamina is a single continuous ribbon with a real
 * raised central rib, asymmetric V-shaped slit/notch groups along both edges,
 * a pointed tip and an attached base — NOT a comb of hundreds of thin pinnae.
 */
function buildFrondGeometry(
  topY: number,
  params: FrondParams,
  phase: number,
): THREE.BufferGeometry {
  // Single drawcall: every rachis + every lamina merged into one indexed mesh.
  //   rachis tube  : tubeSides × rachisRings verts, triangulated closed
  //   lamina       : 3 verts (wing/rib/wing) × (lengthSamples+1) cross-sections
  //                  forming one continuous ribbon with V-notch modulations.
  // The lamina is a SINGLE connected strip — slits are NOT detached quads;
  // they pinch the wing width toward zero near the rachis.
  const tubeSides = 3;
  const rachisRings = 14;
  const rachisVerts = tubeSides * rachisRings;
  const rachisTris = tubeSides * (rachisRings - 1) * 2;
  const lenSamples = params.lengthSamples;
  const laminaVerts = (lenSamples + 1) * 3;
  // 4 triangles per length tick: left quad (2 tris) + right quad (2 tris).
  const laminaTris = lenSamples * 4;
  const totalRachisVerts = params.count * rachisVerts;
  const totalRachisTris = params.count * rachisTris;
  const totalLaminaVerts = params.count * laminaVerts;
  const totalLaminaTris = params.count * laminaTris;
  const totalVerts = totalRachisVerts + totalLaminaVerts;
  const totalTris = totalRachisTris + totalLaminaTris;
  const positions = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const indices = new Uint32Array(totalTris * 3);

  const tmp = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const upWorld = new THREE.Vector3(0, 1, 0);
  const ringRight = new THREE.Vector3();
  const ringUp = new THREE.Vector3();
  const writeRachisRing = (
    center: THREE.Vector3,
    tDir: THREE.Vector3,
    radius: number,
    vBase: number,
  ): void => {
    if (Math.abs(tDir.y) < 0.95) {
      ringRight.copy(tDir).cross(upWorld).normalize();
    } else {
      ringRight.set(1, 0, 0);
    }
    ringUp.copy(ringRight).cross(tDir).normalize();
    for (let s = 0; s < tubeSides; s += 1) {
      const a = (s / tubeSides) * Math.PI * 2;
      const cx = Math.cos(a) * radius;
      const cy = Math.sin(a) * radius;
      const px = center.x + ringRight.x * cx + ringUp.x * cy;
      const py = center.y + ringRight.y * cx + ringUp.y * cy;
      const pz = center.z + ringRight.z * cx + ringUp.z * cy;
      const idx = vBase + s;
      positions[idx * 3] = px;
      positions[idx * 3 + 1] = py;
      positions[idx * 3 + 2] = pz;
      uvs[idx * 2] = s / tubeSides;
      uvs[idx * 2 + 1] = 0;
    }
  };

  // Deterministic per-call RNG so frond variation is reproducible without
  // pulling in a real RNG.
  let lcgState = ((phase * 1.6180339 + 1) >>> 0) || 1;
  const rand = (): number => {
    lcgState = (lcgState * 1664525 + 1013904223) >>> 0;
    return lcgState / 4294967296;
  };
  let vOff = 0;
  let iOff = 0;
  for (let f = 0; f < params.count; f += 1) {
    const azimuth = (f / params.count) * Math.PI * 2 + 0.18 * Math.sin(phase * 0.7 + f);
    const fx = Math.cos(azimuth);
    const fz = Math.sin(azimuth);
    // 2 upright younger fronds (f == 1 and f == 5) and the remaining 7
    // drooping outward in the standard canopy tier.
    const isYoung = f === 1 || f === 5;
    // Length 1.15..1.55; youngest shortest.
    const lengthFactor = isYoung ? (0.82 + rand() * 0.10) : (0.95 + rand() * 0.15);
    const frondLength = params.length * lengthFactor;
    // Max half-width 0.20..0.29 (full width 0.40..0.58).
    const maxHalfWidth = params.minWidth * 0.5
      + (params.maxWidth - params.minWidth) * 0.5 * rand();

    // Curved centerline: mature fronds arch outward then droop; young fronds
    // rise nearly straight up. The arc length is also shorter for young fronds
    // so the inner tier sits higher than the drooping outer tier.
    const rachis = new Array<THREE.Vector3>(rachisRings);
    const radii = new Float32Array(rachisRings);
    const archAlong = isYoung ? frondLength * 0.55 : frondLength;
    for (let s = 0; s < rachisRings; s += 1) {
      const t = s / (rachisRings - 1);
      const along = t * archAlong;
      const y = isYoung
        ? frondLength * (0.88 * t - 0.40 * t * t)
        : archAlong * (0.36 * Math.sin(Math.PI * t) - 0.40 * t * t);
      rachis[s] = new THREE.Vector3(fx * along, y, fz * along);
      radii[s] = 0.024 * Math.pow(1 - t, 0.85);
    }
    // Small ±0.04 overall tilt so adjacent fronds don't sit on identical planes.
    const tiltAxis = tmp.set(-fz, 0, fx).normalize();
    const baseTilt = (rand() - 0.5) * 0.08;
    const tiltQuat = new THREE.Quaternion().setFromAxisAngle(
      tiltAxis, baseTilt + 0.04 * Math.sin(phase + f),
    );
    const tiltMatrix = new THREE.Matrix4().makeRotationFromQuaternion(tiltQuat);
    for (const sample of rachis) sample.applyMatrix4(tiltMatrix);
    for (const sample of rachis) sample.y += topY;

    // --- Rachis tube -------------------------------------------------------
    const rachisVBase = vOff;
    for (let s = 0; s < rachisRings; s += 1) {
      if (s + 1 < rachisRings) {
        tangent.copy(rachis[s + 1]!).sub(rachis[s]!).normalize();
      } else {
        tangent.copy(rachis[s]!).sub(rachis[s - 1]!).normalize();
      }
      writeRachisRing(rachis[s]!, tangent, radii[s]!, rachisVBase + s * tubeSides);
    }
    for (let s = 0; s < rachisRings - 1; s += 1) {
      for (let side = 0; side < tubeSides; side += 1) {
        const a = rachisVBase + s * tubeSides + side;
        const b = rachisVBase + s * tubeSides + ((side + 1) % tubeSides);
        const c = rachisVBase + (s + 1) * tubeSides + side;
        const d = rachisVBase + (s + 1) * tubeSides + ((side + 1) % tubeSides);
        indices[iOff++] = a;
        indices[iOff++] = b;
        indices[iOff++] = c;
        indices[iOff++] = b;
        indices[iOff++] = d;
        indices[iOff++] = c;
      }
    }
    vOff += rachisVerts;

    // --- Continuous broad lamina -----------------------------------------
    // Connected lamina with independently placed left/right cuts. Keep a
    // broad central strip rather than reducing every notch to a bare rachis.
    const lenVerts = lenSamples + 1;
    const laminaVBase = vOff;
    const crossUp = new Array<THREE.Vector3>(lenVerts);
    const crossSide = new Array<THREE.Vector3>(lenVerts);
    const rachisAt = new Array<THREE.Vector3>(lenVerts);
    // Slit half-width ~0.020 keeps ~.08-spaced cuts narrow so the broad lamina
    // between them stays visible (not a sawtooth skeletal strip).
    const slitHalfWidth = 0.020;
    const slitCountL = params.minSlits + Math.floor(rand() * (params.maxSlits - params.minSlits + 1));
    const slitCountR = params.minSlits + Math.floor(rand() * (params.maxSlits - params.minSlits + 1));
    const slitsL = new Float32Array(slitCountL);
    const slitsR = new Float32Array(slitCountR);
    for (let i = 0; i < slitCountL; i += 1) {
      slitsL[i] = 0.10 + (0.80 * (i + 0.5 + 0.4 * (rand() - 0.5)) / slitCountL);
    }
    for (let i = 0; i < slitCountR; i += 1) {
      slitsR[i] = 0.10 + (0.80 * (i + 0.5 + 0.4 * (rand() - 0.5)) / slitCountR);
    }

    for (let li = 0; li < lenVerts; li += 1) {
      const lt = li / lenSamples;
      // Linear interpolation between adjacent rachis samples so the higher-density
      // lamina sections don't collapse onto the same centerline as the rachis.
      const fPos = lt * (rachisRings - 1);
      const i0 = Math.min(rachisRings - 1, Math.floor(fPos));
      const i1 = Math.min(rachisRings - 1, i0 + 1);
      const lerpT = fPos - i0;
      rachisAt[li] = new THREE.Vector3().copy(rachis[i0]!)
        .lerp(rachis[i1]!, lerpT);
      tangent.copy(rachis[i1]!).sub(rachis[i0]!);
      if (tangent.lengthSq() < 1e-8) {
        tangent.copy(rachis[i0]!).sub(rachis[Math.max(0, i0 - 1)]!);
      }
      tangent.normalize();
      // upAxis: perpendicular to tangent, biased toward world-up so the rib
      // spine of the leaf points upward. sideAxis: perpendicular to both,
      // i.e. the cross-width direction wings extend along.
      const upRef = Math.abs(tangent.y) < 0.95 ? upWorld : new THREE.Vector3(1, 0, 0);
      const upAxis = new THREE.Vector3().copy(upRef)
        .addScaledVector(tangent, -tangent.dot(upRef)).normalize();
      const sideAxis = new THREE.Vector3().crossVectors(tangent, upAxis).normalize();
      crossUp[li] = upAxis;
      crossSide[li] = sideAxis;
    }

    // Width envelope along the leaf: zero at base, peaks ~lt 0.32, narrows
    // smoothly to zero at exactly lt=1 (pointed apex).
    const widthEnv = (lt: number): number => {
      if (lt <= 0.04) return 0;
      const head = Math.sin(Math.min(1, lt / 0.34) * Math.PI * 0.5);
      const tail = 1.0 - Math.max(0, (lt - 0.32) / 0.68);
      return Math.max(0, head * tail);
    };
    // Narrow V-notches leave 35% of each wing connected at their deepest point.
    const slitMod = (lt: number, slits: Float32Array): number => {
      let modifier = 0;
      for (let i = 0; i < slits.length; i += 1) {
        const c = slits[i]!;
        const d = Math.abs(lt - c);
        if (d > slitHalfWidth) continue;
        const depthShape = 1.0 - (d / slitHalfWidth);
        modifier = Math.max(modifier, 0.65 * depthShape);
      }
      return modifier;
    };

    for (let li = 0; li < lenVerts; li += 1) {
      const lt = li / lenSamples;
      const env = widthEnv(lt);
      const envW = env * maxHalfWidth;
      const modL = slitMod(lt, slitsL);
      const modR = slitMod(lt, slitsR);
      const wL = envW * (1.0 - modL);
      const wR = envW * (1.0 - modR);
      const base = rachisAt[li]!;
      const upDir = crossUp[li]!;
      const sideDir = crossSide[li]!;
      // The lamina meets the rachis rather than floating above it. Fold the
      // wings down from its raised ridge; all three vertices meet at the tip.
      const ridge = 0.8 * 0.024 * Math.pow(1 - lt, 0.85);
      const fold = Math.sin(Math.PI * lt) * 0.035;
      const left = base.clone().addScaledVector(sideDir, -wL)
        .addScaledVector(upDir, ridge - fold * (1 - modL));
      const rib = base.clone().addScaledVector(upDir, ridge);
      const right = base.clone().addScaledVector(sideDir, wR)
        .addScaledVector(upDir, ridge - fold * (1 - modR));
      const i3 = laminaVBase + li * 3;
      positions[i3 * 3] = left.x;
      positions[i3 * 3 + 1] = left.y;
      positions[i3 * 3 + 2] = left.z;
      uvs[i3 * 2] = 0;
      uvs[i3 * 2 + 1] = lt;
      const i3p1 = i3 + 1;
      positions[i3p1 * 3] = rib.x;
      positions[i3p1 * 3 + 1] = rib.y;
      positions[i3p1 * 3 + 2] = rib.z;
      uvs[i3p1 * 2] = 0.5;
      uvs[i3p1 * 2 + 1] = lt;
      const i3p2 = i3 + 2;
      positions[i3p2 * 3] = right.x;
      positions[i3p2 * 3 + 1] = right.y;
      positions[i3p2 * 3 + 2] = right.z;
      uvs[i3p2 * 2] = 1;
      uvs[i3p2 * 2 + 1] = lt;
    }
    // Triangulate the continuous strip: 2 quads × 2 tris per length tick.
    // Winding keeps the DoubleSide normal readable from both faces.
    for (let li = 0; li < lenSamples; li += 1) {
      const a = laminaVBase + li * 3;            // left this
      const b = laminaVBase + li * 3 + 1;        // rib this
      const c = laminaVBase + li * 3 + 2;        // right this
      const d = laminaVBase + (li + 1) * 3;      // left next
      const e = laminaVBase + (li + 1) * 3 + 1;  // rib next
      const f = laminaVBase + (li + 1) * 3 + 2;  // right next
      indices[iOff++] = a;
      indices[iOff++] = b;
      indices[iOff++] = e;
      indices[iOff++] = a;
      indices[iOff++] = e;
      indices[iOff++] = d;
      indices[iOff++] = b;
      indices[iOff++] = c;
      indices[iOff++] = f;
      indices[iOff++] = b;
      indices[iOff++] = f;
      indices[iOff++] = e;
    }
    vOff += laminaVerts;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

// ---------------------------------------------------------------------------
// Frond material
// ---------------------------------------------------------------------------

/**
 * Build the procedural frond material. PBR green with midrib-vein darkening
 * across uv.x (cross-width), tip bleach along uv.y (length), and a real
 * backlight pass that reads the scene's actual `directionalLights[]` array
 * guarded by `#if NUM_DIR_LIGHTS > 0`. The material is DoubleSide so the
 * continuous lamina strip reads correctly from both faces.
 */
function buildFrondMaterial(uniforms: Record<string, THREE.IUniform>): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x386624),
    roughness: 0.62,
    metalness: 0,
    side: THREE.DoubleSide,
    transparent: false,
  });
  material.onBeforeCompile = (shader): void => {
    shader.uniforms.palmTime = uniforms.palmTime;
    shader.uniforms.palmPhase = uniforms.palmPhase;
    shader.uniforms.palmToPlacement = uniforms.palmToPlacement;
    shader.uniforms.palmWorldToLocal = uniforms.palmWorldToLocal;
    shader.uniforms.palmCrown = uniforms.palmCrown;
    shader.uniforms.palmCrownY = uniforms.palmCrownY;
    shader.uniforms.palmCrownBand = uniforms.palmCrownBand;
    shader.uniforms.palmLeaf = uniforms.palmLeaf;
    shader.vertexShader = 'varying vec2 palmUv;\n' + WIND_GLSL + shader.vertexShader;
    shader.fragmentShader = 'varying vec2 palmUv;\n' + shader.fragmentShader;
    shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', `
      #include <beginnormal_vertex>
      palmUv = uv;
      vec3 palmOffset = palmDisplace(position);
      vec3 palmTangent = normalize(cross(objectNormal,
        abs(objectNormal.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
      vec3 palmBitangent = cross(objectNormal, palmTangent);
      vec3 palmT = palmTangent + (palmDisplace(position + palmTangent * 0.001) - palmOffset) / 0.001;
      vec3 palmB = palmBitangent + (palmDisplace(position + palmBitangent * 0.001) - palmOffset) / 0.001;
      objectNormal = normalize(cross(palmT, palmB));
    `);
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      transformed += palmOffset;
    `);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_fragment_end>',
      `
      #include <lights_fragment_end>
      #if NUM_DIR_LIGHTS > 0
        // Real backlight: when a directional light is behind the frond lamina, brighten
        // the transmitted colour. vViewPosition and directionalLights[i].direction
        // are both in view space (set by Three.js per frame), and 'normal' has
        // already been transformed by normalMatrix, so the dot products are
        // self-consistent.
        vec3 viewDirN = normalize(vViewPosition);
        vec3 palmBack = vec3(0.0);
        for (int i = 0; i < NUM_DIR_LIGHTS; i++) {
          vec3 lDir = normalize(directionalLights[i].direction);
          float back = max(0.0, -dot(normal, lDir));
          float wrap = 0.35 + 0.65 * pow(max(0.0, dot(viewDirN, -lDir)), 3.0);
          palmBack += directionalLights[i].color * (back * wrap * 0.35);
        }
        reflectedLight.indirectDiffuse += diffuseColor.rgb * palmBack;
      #endif
      `,
    );
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
      #include <color_fragment>
      float palmMidrib = 1.0 - smoothstep(0.0, 0.04, abs(palmUv.x - 0.5));
      diffuseColor.rgb *= mix(1.0, 1.12, palmMidrib * smoothstep(0.0, 0.3, palmUv.y));
      float palmTip = smoothstep(0.65, 1.0, palmUv.y);
      diffuseColor.rgb *= mix(vec3(1.0), vec3(1.08, 1.02, 0.85), palmTip * 0.55);
    `);
  };
  material.customProgramCacheKey = (): string => 'island-palm-fronds:2:standard';
  return material;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createPalmWind(placement: THREE.Group, phase: number): PalmWind {
  placement.updateWorldMatrix(true, true);
  const placementInverse = placement.matrixWorld.clone().invert();
  const time = { value: 0 };
  const shadowMaterials: THREE.Material[] = [];
  const inverse = new THREE.Matrix4();
  let frondMesh: THREE.Mesh | null = null;
  const ownedFrondGeometry: THREE.BufferGeometry[] = [];
  const ownedFrondMaterial: THREE.Material[] = [];
  let disposed = false;
  let scrubbedTopY = 0;
  let scrubbedCrown = new THREE.Vector2();

  placement.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (object.userData.isRuntimeEffect) return;
    const mesh = object;
    const scrub = scrubPalmLeaves(mesh, placement);
    scrubbedTopY = scrub.trunkTopY;
    scrubbedCrown = scrub.trunkCrown;
    const source = mesh.geometry;
    const toPlacement = new THREE.Matrix4().multiplyMatrices(placementInverse, mesh.matrixWorld);
    const worldToLocal = new THREE.Matrix3().setFromMatrix4(inverse.copy(mesh.matrixWorld).invert());

    const trunkUniforms = {
      palmTime: time,
      palmPhase: { value: phase },
      palmToPlacement: { value: toPlacement },
      palmWorldToLocal: { value: worldToLocal },
      palmCrown: { value: scrub.trunkCrown.clone() },
      palmCrownY: { value: scrub.trunkTopY },
      palmCrownBand: { value: 0.45 },
      palmLeaf: { value: 0 }, // trunk stays stiff
    };
    const basis = worldToLocal.elements;
    const inflation = 0.17 * Math.sqrt(basis.reduce((sum, v) => sum + v * v, 0));
    source.boundingBox!.expandByScalar(inflation);
    source.boundingSphere!.radius += inflation;

    const decorate = (
      material: THREE.Material,
      visible: boolean,
      priorHook: typeof THREE.Material.prototype.onBeforeCompile | null,
      priorKey: string,
    ): void => {
      // Material.clone() does NOT copy `onBeforeCompile` or
      // `customProgramCacheKey`, so the source's hook is replayed here against
      // the clone (`this` = the cloned material that actually owns the uniforms
      // being patched). The source key is folded into the new key so the
      // trunk program invalidates whenever the source did.
      material.onBeforeCompile = function patchedOnBeforeCompile(shader, renderer): void {
        if (priorHook) priorHook.call(this, shader, renderer);
        Object.assign(shader.uniforms, trunkUniforms);
        shader.vertexShader = WIND_GLSL + shader.vertexShader;
        if (visible) {
          shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', `
            #include <beginnormal_vertex>
            vec3 palmOffset = palmDisplace(position);
            vec3 palmTangent = normalize(cross(objectNormal,
              abs(objectNormal.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
            vec3 palmBitangent = cross(objectNormal, palmTangent);
            vec3 palmT = palmTangent + (palmDisplace(position + palmTangent * 0.001) - palmOffset) / 0.001;
            vec3 palmB = palmBitangent + (palmDisplace(position + palmBitangent * 0.001) - palmOffset) / 0.001;
            objectNormal = normalize(cross(palmT, palmB));
          `);
        }
        shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
          #include <begin_vertex>
          transformed += ${visible ? 'palmOffset' : 'palmDisplace(position)'};
        `);
      };
      material.customProgramCacheKey = (): string =>
        `island-palm-trunk:${mesh.id}:${visible}:${material.type}:${priorKey}`;
    };

    const sources = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const materials = sources.map((sourceMaterial) => {
      // Capture the source hook + customProgramCacheKey BEFORE cloning because
      // Material.copy() does not transfer them.
      const priorHook = sourceMaterial.onBeforeCompile;
      const priorKey = typeof sourceMaterial.customProgramCacheKey === 'function'
        ? sourceMaterial.customProgramCacheKey.call(sourceMaterial)
        : '';
      const material = sourceMaterial.clone();
      decorate(material, true, priorHook, priorKey);
      return material;
    });
    mesh.material = Array.isArray(mesh.material) ? materials : materials[0]!;
    // Match the measured material's alpha test and sidedness in shadow passes.
    const alphaSource = sources[0] instanceof THREE.MeshStandardMaterial
      ? sources[0]
      : null;
    const shadowOptions = {
      alphaTest: alphaSource?.alphaTest,
      side: alphaSource?.shadowSide ?? alphaSource?.side,
    };
    const depth = new THREE.MeshDepthMaterial({ ...shadowOptions, depthPacking: THREE.RGBADepthPacking });
    const distance = new THREE.MeshDistanceMaterial(shadowOptions);
    // Fresh depth/distance materials carry no source hook; the empty hook
    // path still bakes in the wind displacement.
    decorate(depth, false, null, '');
    decorate(distance, false, null, '');
    mesh.customDepthMaterial = depth;
    mesh.customDistanceMaterial = distance;
    shadowMaterials.push(depth, distance);
  });

  // ------------------------------------------------------------------
  // Procedural fronds: one merged rachis + lamina mesh attached to the
  // placement wrapper as an anonymous authored part. It selects/explodes
  // with the Palm and is NOT a runtime effect or pointer-transparent shell.
  // ------------------------------------------------------------------
  // The frond geometry is authored with the rachis crown at the local origin
  // (we translate the geometry down by trunkTopY so position.y stays small),
  // and the mesh is then placed at (crown.x, trunkTopY, crown.y) so the
  // canopy sits on top of the visible trunk. `palmToPlacement` is therefore
  // a full translation matching that placement so the wind shader sees
  // placement-local coordinates.
  const frondToPlacement = new THREE.Matrix4().makeTranslation(
    scrubbedCrown.x, scrubbedTopY, scrubbedCrown.y,
  );
  const frondWorldToLocal = new THREE.Matrix3()
    .setFromMatrix4(placement.matrixWorld.clone().invert());
  const frondUniforms = {
    palmTime: time,
    palmPhase: { value: phase },
    palmToPlacement: { value: frondToPlacement },
    palmWorldToLocal: { value: frondWorldToLocal },
    palmCrown: { value: scrubbedCrown.clone() },
    palmCrownY: { value: scrubbedTopY },
    palmCrownBand: { value: 0.45 },
    palmLeaf: { value: 1 }, // leaf tips move more than the stiff rachis
  };
  const frondGeometry = buildFrondGeometry(scrubbedTopY, DEFAULT_FRONDS, phase);
  // The geometry is authored with the rachis crown at local y = topY; shift it
  // down so the mesh's position offset (set below) lands the canopy on the
  // visible trunk. `translate` also shifts the computed bounds, so we
  // re-inflate after the translation.
  frondGeometry.translate(0, -scrubbedTopY, 0);
  // Inflate bounds for wind (rachis tips reach past the static bounds when
  // displaced; do this once so frustum culling does not pop the canopy).
  frondGeometry.computeBoundingBox();
  frondGeometry.computeBoundingSphere();
  frondGeometry.boundingBox!.expandByScalar(0.25);
  frondGeometry.boundingSphere!.radius += 0.25;
  const frondMaterial = buildFrondMaterial(frondUniforms);
  frondMesh = new THREE.Mesh(frondGeometry, frondMaterial);
  frondMesh.castShadow = true;
  frondMesh.receiveShadow = true;
  frondMesh.name = '';
  // Anchored to the retained trunk crown XZ, lifted to the trunk top Y.
  frondMesh.position.set(scrubbedCrown.x, scrubbedTopY, scrubbedCrown.y);
  ownedFrondGeometry.push(frondGeometry);
  ownedFrondMaterial.push(frondMaterial);

  const frondDepth = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    side: THREE.DoubleSide,
  });
  const frondDistance = new THREE.MeshDistanceMaterial({ side: THREE.DoubleSide });
  const decorateFrondShadow = (material: THREE.Material): void => {
    // The frond depth/distance shadow materials are constructed fresh here,
    // so they carry no source hook. Bound as a method (not an arrow) so the
    // hook receives the material as `this`.
    material.onBeforeCompile = function patchedFrondShadowOnBeforeCompile(shader): void {
      Object.assign(shader.uniforms, frondUniforms);
      shader.vertexShader = WIND_GLSL + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
        #include <begin_vertex>
        transformed += palmDisplace(position);
      `);
    };
    material.customProgramCacheKey = (): string => `island-palm-fronds-shadow:${material.type}`;
  };
  decorateFrondShadow(frondDepth);
  decorateFrondShadow(frondDistance);
  frondMesh.customDepthMaterial = frondDepth;
  frondMesh.customDistanceMaterial = frondDistance;
  shadowMaterials.push(frondDepth, frondDistance);

  placement.add(frondMesh);

  return {
    tick(elapsed, reducedMotion) {
      if (disposed || reducedMotion) return;
      time.value = elapsed;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const material of shadowMaterials) material.dispose();
      for (const material of ownedFrondMaterial) material.dispose();
      for (const geometry of ownedFrondGeometry) geometry.dispose();
      // Detach the frond mesh from the placement tree before the viewer
      // disposes the placement; otherwise the viewer would attempt to
      // dispose our geometry/material again.
      if (frondMesh) {
        frondMesh.removeFromParent();
        frondMesh = null;
      }
    },
  };
}