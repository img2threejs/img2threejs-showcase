import * as THREE from 'three';
import type { DecodedPart } from './meshCodec';
import { REGIONS, type RegionId } from './characterPalette';

/**
 * Split the ONE rigged shell into a mesh per region — costume separate from body — without
 * touching the skinning.
 *
 * Why this is safe when decimation is not. Decimation removes vertices, and `skinIndex` /
 * `skinWeight` are per-vertex, so a decimated shell has weights pointing at vertices that no longer
 * exist and the figure tears the moment a clip plays. A PARTITION removes nothing: every vertex
 * keeps its own position, normal, colour, joint indices and joint weights, and simply lands in a
 * different buffer. Boundary vertices are duplicated into both pieces with identical weights, so
 * the two sides deform identically and no seam can open.
 *
 * All pieces bind to the SAME `THREE.Skeleton` instance. One skeleton, one set of bone matrices,
 * five meshes reading them — so the costume cannot drift out of step with the body it sits on.
 *
 * `tools/splitGate.ts` measures this claim rather than trusting it: it compares every split vertex
 * against the same vertex skinned inside the original shell, across every clip.
 */

/** Region shares measured after classification; see `tools/regionProbe.ts`. */
export interface RegionSplitReport {
  region: RegionId;
  vertices: number;
  triangles: number;
  share: number;
}

function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 1e-9) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

/**
 * Classify one vertex.
 *
 * Hue alone is not enough on a dark bake — skin and gold sit 15 degrees apart, and crimson in
 * shadow reads as the same hue as skin. Height and value do the separating:
 *   hair    near-black, and only above mid-back, so a shadowed sole never becomes hair
 *   skin    warm hue, LOW saturation and HIGH value — the two axes crimson never satisfies
 *   gold    warm hue above 32 degrees, where the filigree histogram peaks (35-45)
 *   indigo  the 195-275 band, which nothing else in the costume occupies
 */
export function classifyVertex(rLin: number, gLin: number, bLin: number, heightFraction: number): RegionId {
  const [h, s, v] = rgbToHsv(linearToSrgb(rLin), linearToSrgb(gLin), linearToSrgb(bLin));

  // The height floor is 0.66, not 0.5. Dark-and-above-mid-back also catches the shadow lines
  // between the skirt plates, and isolating the outfit made that visible: hiding the armour left a
  // speckled ring of "hair" hanging at skirt height. Measured, 92% of hair vertices sit above 0.70,
  // so raising the floor loses very little real hair and drops the crevices back onto the lacquer
  // they belong to.
  if (v < 0.13 && heightFraction > 0.66) return 'hair';
  if (h >= 195 && h < 275) return 'cloth-indigo';
  if (h >= 32 && h < 60 && v >= 0.2) return 'filigree-gold';
  if (s < 0.5 && v > 0.45 && (h < 32 || h >= 340)) return 'skin';
  if (h < 32 || h >= 300) return 'lacquer-crimson';
  // Anything left is a dark transition pixel between plates; the crimson base is where it belongs.
  return 'lacquer-crimson';
}

export interface SplitRegion {
  id: RegionId;
  geometry: THREE.BufferGeometry;
  vertices: number;
  triangles: number;
}

/**
 * Partition the shell's triangles by region.
 *
 * A triangle goes wholly to the region most of its corners voted for — a triangle cannot be half in
 * two meshes. Ties fall to the first corner, which keeps the result deterministic.
 */
export function splitByRegion(part: DecodedPart): SplitRegion[] {
  const { position, normal, colour, index } = part;
  const vertexCount = position.length / 3;

  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < vertexCount; i += 1) {
    const y = position[i * 3 + 1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const spanY = maxY - minY || 1;

  const vertexRegion = new Array<RegionId>(vertexCount);
  for (let i = 0; i < vertexCount; i += 1) {
    vertexRegion[i] = classifyVertex(
      colour[i * 3],
      colour[i * 3 + 1],
      colour[i * 3 + 2],
      (position[i * 3 + 1] - minY) / spanY,
    );
  }

  const ids = Object.keys(REGIONS) as RegionId[];
  const buckets = new Map<RegionId, number[]>(ids.map((id) => [id, []]));

  const triangleCount = index.length / 3;
  for (let t = 0; t < triangleCount; t += 1) {
    const a = index[t * 3];
    const b = index[t * 3 + 1];
    const c = index[t * 3 + 2];
    const ra = vertexRegion[a];
    const rb = vertexRegion[b];
    const rc = vertexRegion[c];
    // Majority vote; with three distinct votes the first corner decides, which is deterministic.
    const winner = ra === rb || ra === rc ? ra : rb === rc ? rb : ra;
    const bucket = buckets.get(winner)!;
    bucket.push(a, b, c);
  }

  const out: SplitRegion[] = [];
  for (const id of ids) {
    const tris = buckets.get(id)!;
    if (!tris.length) continue;

    // Re-index: only the vertices this region actually touches are copied into its buffers.
    const remap = new Map<number, number>();
    const positions: number[] = [];
    const normals: number[] = [];
    const colours: number[] = [];
    const localIndex = new Uint32Array(tris.length);
    for (let i = 0; i < tris.length; i += 1) {
      const src = tris[i];
      let dst = remap.get(src);
      if (dst === undefined) {
        dst = positions.length / 3;
        remap.set(src, dst);
        positions.push(position[src * 3], position[src * 3 + 1], position[src * 3 + 2]);
        normals.push(normal[src * 3], normal[src * 3 + 1], normal[src * 3 + 2]);
        colours.push(colour[src * 3], colour[src * 3 + 1], colour[src * 3 + 2]);
      }
      localIndex[i] = dst;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
    geometry.setIndex(new THREE.BufferAttribute(localIndex, 1));
    // The source vertex each local vertex came from — the skin attributes are copied through this.
    geometry.userData.sourceVertices = [...remap.entries()].sort((a, b) => a[1] - b[1]).map(([src]) => src);

    out.push({ id, geometry, vertices: positions.length / 3, triangles: tris.length / 3 });
  }
  return out;
}

/**
 * Copy the shell's per-vertex joint indices and weights onto a split region, through the map of
 * which source vertex each local vertex came from. Nothing is recomputed: a vertex's weights in the
 * split are bit-for-bit the weights it had in the shell, which is the whole reason the split is
 * safe to make.
 */
export function copySkinAttributes(
  region: SplitRegion,
  skinIndex: Uint16Array,
  skinWeight: Float32Array,
): void {
  const source = region.geometry.userData.sourceVertices as number[];
  const outIndex = new Uint16Array(source.length * 4);
  const outWeight = new Float32Array(source.length * 4);
  for (let i = 0; i < source.length; i += 1) {
    const src = source[i];
    for (let c = 0; c < 4; c += 1) {
      outIndex[i * 4 + c] = skinIndex[src * 4 + c];
      outWeight[i * 4 + c] = skinWeight[src * 4 + c];
    }
  }
  region.geometry.setAttribute('skinIndex', new THREE.BufferAttribute(outIndex, 4));
  region.geometry.setAttribute('skinWeight', new THREE.BufferAttribute(outWeight, 4));
}

/** A recolourable region material: the uniforms the tint is driven through. */
export interface RegionTint {
  uTint: { value: THREE.Color };
  uTintMix: { value: number };
}

/**
 * The region's authored finish, built from the measured palette — and recolourable.
 *
 * Recolouring by simply setting `material.color` does not work here, because the surface detail IS
 * the vertex colour: the filigree scrollwork, the scale pattern on the skirt and the fabric weave
 * are all painted into it. Multiplying that by a new hue gives a muddy product of two colours
 * (crimson x blue reads as near-black), and turning `vertexColors` off flattens the armour into a
 * blank shape.
 *
 * So the shader is patched instead. The baked colour is reduced to its LUMINANCE — which is where
 * the pattern actually lives — and that luminance modulates the chosen hue. Ornament and shading
 * survive; only the colour changes. `uTintMix` at 0 leaves the measured original untouched, so the
 * as-measured look is always one click away.
 */
export function createRegionMaterial(id: RegionId): THREE.MeshPhysicalMaterial {
  const def = REGIONS[id];
  const material = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    metalness: def.material.metalness,
    roughness: def.material.roughness,
  });
  if (def.material.clearcoat !== undefined) {
    material.clearcoat = def.material.clearcoat;
    material.clearcoatRoughness = def.material.clearcoatRoughness ?? 0.3;
  }
  if (def.material.sheen !== undefined) {
    material.sheen = def.material.sheen;
    material.sheenColor = new THREE.Color(def.material.sheenColor ?? 0xffffff);
  }
  // The bake is dark because it carries its own lighting. Lifting it here keeps the measured hue
  // and only moves the level, which is the part the bake got wrong.
  material.color = new THREE.Color().setScalar(def.material.albedoGain);

  const tint: RegionTint = {
    uTint: { value: new THREE.Color(0xffffff) },
    uTintMix: { value: 0 },
  };
  material.onBeforeCompile = (shader): void => {
    shader.uniforms.uTint = tint.uTint;
    shader.uniforms.uTintMix = tint.uTintMix;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uTint;\nuniform float uTintMix;')
      .replace(
        '#include <color_fragment>',
        `#ifdef USE_COLOR
          // Luminance carries the ornament; the hue is what we are replacing.
          float bakedLuma = dot(vColor.rgb, vec3(0.2126, 0.7152, 0.0722));
          // 1.9 restores roughly the level the measured colour had at that luminance, so a tinted
          // piece sits at the same brightness as the original rather than reading washed out.
          vec3 tinted = uTint * bakedLuma * 1.9;
          diffuseColor.rgb *= mix(vColor.rgb, tinted, uTintMix);
        #endif`,
      );
  };
  // A material whose shader is patched needs its own program; without this every region would
  // share one compiled program and one region's tint uniforms would drive all five.
  material.customProgramCacheKey = () => `tq-region-${id}`;
  material.userData.tint = tint;
  return material;
}

/** Recolour a region. `null` restores the colour measured off the reference. */
export function setRegionTint(material: THREE.Material, hex: string | null): void {
  const tint = material.userData.tint as RegionTint | undefined;
  if (!tint) return;
  if (hex === null) {
    tint.uTintMix.value = 0;
    return;
  }
  tint.uTint.value.set(hex);
  tint.uTintMix.value = 1;
}
