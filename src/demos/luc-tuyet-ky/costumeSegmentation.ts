import * as THREE from 'three';
import type { DecodedPart } from './meshCodec';

/**
 * Split the one fused Tripo shell into body / dress / hair meshes.
 *
 * WHY THIS EXISTS
 * ---------------
 * Tripo returns this character as a single watertight shell: welding coincident vertices collapses
 * all 285 raw index islands into exactly ONE connected component, so the gown is not a separate
 * surface that could simply be pulled out by topology — it is the outer skin of the same manifold
 * the body is. The auto-rig then weighted that shell per vertex, which produced two defects the
 * viewer sees as "the costume gets dragged":
 *
 *   1. 40% of all vertices are dominated by L/R_Thigh* and L/R_Calf* twist joints, and the measured
 *      radius of those vertices runs out to 0.13 of figure height where the leg itself is only
 *      ~0.05. Those are gown panels bound to the legs. A kick or a dance step therefore drags the
 *      skirt with the shin, and because the front panel spans BOTH legs, a split stance tears it.
 *   2. The waist-length hair is dominated by Spine01 and the two clavicles (7.5k vertices), so a
 *      shoulder roll shears the hair sideways instead of letting it hang.
 *
 * Rebinding cannot be done in place while everything is one mesh — a single SkinnedMesh has one
 * skeleton binding and one draw call, and the dress needs its own dynamics. So the shell is cut
 * into three meshes here, and `clothRig` rebinds the two costume meshes onto their own joints.
 *
 * HOW THE CUT IS PLACED
 * ---------------------
 * Not by guesswork: by the measured radial histogram of the shell. Between y=0.14 and y=0.36 the
 * distribution of radius-from-hip-axis is strongly bimodal — an inner lobe peaking at r≈0.065 (the
 * legs and their lining) and an outer lobe peaking at r≈0.12 (the gown panels), separated by a
 * trough at r≈0.085 that is 2-6x shallower than either lobe. That trough is the seed threshold.
 * Above y≈0.40 the two lobes merge, because that is where the gown actually meets the hip and there
 * is no longer a gap to find, so the seed is grown along mesh edges instead and stopped at the belt
 * line the reference shows at y≈0.52.
 *
 * Hair is seeded on luminance instead — it is the only near-black material on the figure — and grown
 * the same way, which recovers the strands that hang to y≈0.58 without swallowing the dark lash and
 * brow pixels on the face, since those are not edge-connected to the scalp mass.
 *
 * Growing a seed across the mesh graph rather than thresholding every vertex independently is what
 * keeps the boundary a single closed curve: an isolated vertex that happens to pass the radius test
 * is never picked up unless it is actually connected to the panel.
 */

export const REGIONS = ['body', 'dress', 'hair'] as const;
export type Region = (typeof REGIONS)[number];

/** Measured landmarks, in the model's own bind space (figure height normalised to 1.0). */
export const LANDMARKS = {
  /** Hip joint, from the rig's own bind pose — the axis every radius here is measured against. */
  hipAxis: { x: 0.0279, z: -0.0075 },
  hipY: 0.5669,
  /** Belt line in the reference: where the gown stops being gown and becomes bodice. */
  beltY: 0.52,
  /** Lowest gown vertex; below this is boot. */
  hemY: 0.085,
  /** Trough of the bimodal radial histogram between the legs and the gown panels. */
  splitRadius: 0.085,
  /** Radius below which a vertex is inside the leg envelope and cannot be gown. */
  legRadius: 0.07,
  /** Crown of the head. */
  headTopY: 1.0,
  /** Scalp line: hair above this is a cap on the skull and stays rigid to the head joint. */
  scalpY: 0.895,
} as const;

/** How many rings of body surface ease back from the costume's weights to their own. */
export const SEAM_FALLOFF_HOPS = 6;

const SEED_DRESS_Y = [0.12, 0.36] as const;
const SEED_HAIR_Y = [0.6, 0.99] as const;
const SEED_HAIR_LUMINANCE = 0.16;
const GROW_HAIR_LUMINANCE = 0.26;
const GROW_HAIR_MIN_Y = 0.3;

/** Rec.709 luminance of a linear-space vertex colour, in sRGB terms. */
function luminance(colour: Float32Array, i: number): number {
  const toSrgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
  return 0.2126 * toSrgb(colour[i * 3]) + 0.7152 * toSrgb(colour[i * 3 + 1]) + 0.0722 * toSrgb(colour[i * 3 + 2]);
}

/**
 * Map every vertex to the lowest index sharing its position.
 *
 * The stream stores the shell with split vertices at material and chart borders — 160,023 entries
 * for 147,128 distinct positions — so edge adjacency built on raw indices reports the gown as
 * hundreds of disconnected scraps and a flood fill dies immediately. Welding by exact quantised
 * position is safe here precisely because positions were quantised on the way in: two vertices that
 * were one vertex before the split are bit-identical after decode, so there is no epsilon to tune.
 */
function weldMap(position: Float32Array, count: number): Int32Array {
  const representative = new Int32Array(count);
  const seen = new Map<string, number>();
  for (let i = 0; i < count; i += 1) {
    // The 1e5 grid is finer than the 1/65535 quantisation step over this figure's extent, so it can
    // only ever merge vertices the encoder itself had already collapsed to the same sample.
    const key = `${Math.round(position[i * 3] * 1e5)},${Math.round(position[i * 3 + 1] * 1e5)},${Math.round(position[i * 3 + 2] * 1e5)}`;
    const hit = seen.get(key);
    if (hit === undefined) {
      seen.set(key, i);
      representative[i] = i;
    } else {
      representative[i] = hit;
    }
  }
  return representative;
}

/** Undirected vertex adjacency over welded representatives, in CSR form. */
function buildAdjacency(index: Uint32Array, representative: Int32Array, count: number): { offset: Int32Array; neighbour: Int32Array } {
  const degree = new Int32Array(count);
  const bump = (a: number, b: number): void => {
    const ra = representative[a];
    const rb = representative[b];
    if (ra !== rb) {
      degree[ra] += 1;
      degree[rb] += 1;
    }
  };
  for (let t = 0; t < index.length; t += 3) {
    bump(index[t], index[t + 1]);
    bump(index[t + 1], index[t + 2]);
    bump(index[t + 2], index[t]);
  }
  const offset = new Int32Array(count + 1);
  for (let i = 0; i < count; i += 1) offset[i + 1] = offset[i] + degree[i];
  const cursor = offset.slice(0, count);
  const neighbour = new Int32Array(offset[count]);
  const write = (a: number, b: number): void => {
    const ra = representative[a];
    const rb = representative[b];
    if (ra === rb) return;
    neighbour[cursor[ra]] = rb;
    cursor[ra] += 1;
    neighbour[cursor[rb]] = ra;
    cursor[rb] += 1;
  };
  for (let t = 0; t < index.length; t += 3) {
    write(index[t], index[t + 1]);
    write(index[t + 1], index[t + 2]);
    write(index[t + 2], index[t]);
  }
  return { offset, neighbour };
}

export interface SegmentationResult {
  /** One region id per vertex, indexed like the decoded part. */
  vertexRegion: Uint8Array;
  /**
   * Hops from the nearest costume vertex, over the welded mesh graph, for body vertices only.
   * 255 means "further than the falloff cares about". Costume vertices themselves are 0.
   */
  seamHop: Uint8Array;
  /** Which costume region each body vertex's nearest seam belongs to; 0 where there is none. */
  seamRegion: Uint8Array;
  /** Lowest vertex index sharing each vertex's position, so callers can weld without redoing it. */
  representative: Int32Array;
  /**
   * Welded vertex adjacency in CSR form, reused rather than rebuilt.
   *
   * Published because weight repairs need it too: the auto-rig's left/right leg boundary can only be
   * found by asking which vertices have a neighbour belonging to the other leg.
   */
  adjacency: { offset: Int32Array; neighbour: Int32Array };
  /** One region id per triangle, decided by majority of its three corners. */
  triangleRegion: Uint8Array;
  counts: Record<Region, { vertices: number; triangles: number }>;
  /** Triangles whose corners disagreed — reported so a reviewer can see how clean the cut is. */
  straddlingTriangles: number;
}

/**
 * Classify every vertex and triangle of the shell.
 *
 * Runs in about 90 ms on the full 160k-vertex level; the factory calls it once and caches.
 */
export function segmentCostume(part: DecodedPart): SegmentationResult {
  const count = part.meta.vertexCount;
  const { position, colour, index } = part;
  const representative = weldMap(position, count);
  const { offset, neighbour } = buildAdjacency(index, representative, count);

  const { hipAxis } = LANDMARKS;
  const radiusOf = (i: number): number => Math.hypot(position[i * 3] - hipAxis.x, position[i * 3 + 2] - hipAxis.z);
  const heightOf = (i: number): number => position[i * 3 + 1];

  const vertexRegion = new Uint8Array(count); // 0 = body

  /** Flood fill from every vertex passing `seed`, spreading only through vertices passing `grow`. */
  const grow = (region: number, seed: (i: number) => boolean, admits: (i: number) => boolean): void => {
    const stack: number[] = [];
    for (let i = 0; i < count; i += 1) {
      if (representative[i] !== i || vertexRegion[i] !== 0 || !seed(i)) continue;
      vertexRegion[i] = region;
      stack.push(i);
    }
    while (stack.length) {
      const v = stack.pop() as number;
      for (let k = offset[v]; k < offset[v + 1]; k += 1) {
        const w = neighbour[k];
        if (vertexRegion[w] !== 0 || !admits(w)) continue;
        vertexRegion[w] = region;
        stack.push(w);
      }
    }
  };

  grow(
    1,
    (i) => heightOf(i) >= SEED_DRESS_Y[0] && heightOf(i) <= SEED_DRESS_Y[1] && radiusOf(i) > LANDMARKS.splitRadius,
    (i) => heightOf(i) >= LANDMARKS.hemY && heightOf(i) <= LANDMARKS.beltY && radiusOf(i) > LANDMARKS.legRadius,
  );
  grow(
    2,
    (i) => heightOf(i) >= SEED_HAIR_Y[0] && heightOf(i) <= SEED_HAIR_Y[1] && luminance(colour, i) < SEED_HAIR_LUMINANCE,
    (i) => heightOf(i) >= GROW_HAIR_MIN_Y && luminance(colour, i) < GROW_HAIR_LUMINANCE,
  );

  // The fill only ever visited welded representatives; hand the label back to the split copies so a
  // triangle that references a duplicate sees the same region its twin was given.
  for (let i = 0; i < count; i += 1) {
    if (representative[i] !== i && vertexRegion[i] === 0) vertexRegion[i] = vertexRegion[representative[i]];
  }

  const triangleCount = index.length / 3;
  const triangleRegion = new Uint8Array(triangleCount);
  let straddlingTriangles = 0;
  const tally = new Uint8Array(REGIONS.length);
  for (let t = 0; t < triangleCount; t += 1) {
    const a = vertexRegion[index[t * 3]];
    const b = vertexRegion[index[t * 3 + 1]];
    const c = vertexRegion[index[t * 3 + 2]];
    if (a === b && b === c) {
      triangleRegion[t] = a;
      continue;
    }
    straddlingTriangles += 1;
    tally.fill(0);
    tally[a] += 1;
    tally[b] += 1;
    tally[c] += 1;
    // Majority, and on a three-way tie the lower region id wins so the choice is deterministic.
    let best = 0;
    for (let r = 1; r < tally.length; r += 1) if (tally[r] > tally[best]) best = r;
    triangleRegion[t] = best;
  }

  /*
   * Distance from the seam, in hops across the mesh graph.
   *
   * The split gives the two sides of a border DIFFERENT weights — that is the entire point — but a
   * vertex that sits on the border exists in both meshes, and if its two copies are driven
   * differently the surface pulls apart there and the viewer sees straight through the character.
   * Measured on the first cut: 1,094 vertices shared between body and gown, coincident in bind pose
   * and up to 0.25 of figure height apart four seconds into a dance.
   *
   * The fix is to make every copy of a vertex resolve to ONE weight set, and to hand the body side a
   * graded return to its own weights over the next few rings rather than a step. This field is that
   * grading: 0 on the costume, 1 on its immediate body neighbours, and so on outward.
   */
  const seamHop = new Uint8Array(count).fill(255);
  const seamRegion = new Uint8Array(count);
  {
    let frontier: number[] = [];
    for (let i = 0; i < count; i += 1) {
      if (vertexRegion[i] === 0) continue;
      seamHop[i] = 0;
      seamRegion[i] = vertexRegion[i];
      frontier.push(i);
    }
    for (let hop = 1; hop <= SEAM_FALLOFF_HOPS; hop += 1) {
      const next: number[] = [];
      for (const v of frontier) {
        for (let k = offset[v]; k < offset[v + 1]; k += 1) {
          const w = neighbour[k];
          if (vertexRegion[w] !== 0 || seamHop[w] !== 255) continue;
          seamHop[w] = hop;
          seamRegion[w] = seamRegion[v];
          next.push(w);
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }
    // The walk only ever visited welded representatives; split copies inherit their twin's grading.
    for (let i = 0; i < count; i += 1) {
      if (representative[i] !== i && seamHop[i] === 255) {
        seamHop[i] = seamHop[representative[i]];
        seamRegion[i] = seamRegion[representative[i]];
      }
    }
  }

  const counts = { body: { vertices: 0, triangles: 0 }, dress: { vertices: 0, triangles: 0 }, hair: { vertices: 0, triangles: 0 } };
  for (let i = 0; i < count; i += 1) counts[REGIONS[vertexRegion[i]]].vertices += 1;
  for (let t = 0; t < triangleCount; t += 1) counts[REGIONS[triangleRegion[t]]].triangles += 1;

  return { vertexRegion, seamHop, seamRegion, representative, adjacency: { offset, neighbour }, triangleRegion, counts, straddlingTriangles };
}

export interface RegionGeometry {
  region: Region;
  geometry: THREE.BufferGeometry;
  /** For each vertex of this geometry, the index it came from in the source shell. */
  sourceVertex: Uint32Array;
}

/**
 * Build one BufferGeometry per region.
 *
 * A vertex on the seam belongs to triangles in two regions, so it is COPIED into both rather than
 * shared. That is the whole point: once the copies are separate vertices in separate meshes, the
 * gown's copy can be re-weighted onto the skirt joints while the body's copy keeps the hip weights
 * it already had, and the leg can no longer reach across the seam and drag the panel. The two copies
 * start at the same position, so the figure still reads as one surface in the bind pose — and the
 * top ring of the gown is deliberately re-weighted back onto the same waist joints the bodice uses,
 * which is what keeps the seam closed once the skeleton moves.
 */

/**
 * Close a region's open boundaries.
 *
 * Cutting the shell leaves every region with holes where its neighbours used to be — measured on
 * this character, 2,556 open edges on the body alone, in loops of up to 920 vertices where the gown
 * was lifted off it. An open hole is what a viewer reads as the character going black: nothing is
 * drawn behind it, so you see the unlit inside of the far side of the model, or the background.
 *
 * That hole is the reason the first attempt at this welded the seam by giving both sides of a border
 * one weight set. It did close the hole, and it cost more than it bought: a vertex on the hem then
 * carried both a calf joint and a skirt joint, which point in completely different directions the
 * moment she kicks, and the edges around it stretched by up to 114x into the long slivers this
 * function exists to make unnecessary. With every region closed on its own, the gown is free to move
 * however the solver says and nothing shows through when it does.
 *
 * The caps reuse the loop's OWN vertices — a fan, no new points. That matters more than the slightly
 * awkward triangles it produces: a new vertex would need weights of its own, and any weights that
 * disagreed with the loop's would tear the cap open under exactly the poses it is there to cover.
 * Sharing them makes the cap deform identically to the rim it closes, by construction.
 */
function capBoundaryLoops(
  indices: number[],
  sourceVertex: number[],
  representative: Int32Array,
): number { 
  // Directed edge counts over welded positions: an edge the surface only uses once is a boundary.
  const directed = new Set<string>();
  const undirected = new Map<string, number>();
  const localOf = new Map<number, number>();
  const note = (a: number, b: number): void => {
    const ra = representative[sourceVertex[a]];
    const rb = representative[sourceVertex[b]];
    localOf.set(ra, a);
    localOf.set(rb, b);
    if (ra === rb) return;
    directed.add(`${ra}>${rb}`);
    const key = ra < rb ? `${ra}_${rb}` : `${rb}_${ra}`;
    undirected.set(key, (undirected.get(key) ?? 0) + 1);
  };
  for (let t = 0; t < indices.length; t += 3) {
    note(indices[t], indices[t + 1]);
    note(indices[t + 1], indices[t + 2]);
    note(indices[t + 2], indices[t]);
  }

  // Walk each boundary in the direction its own triangle used, so the cap can be wound against it.
  //
  // Edges are CONSUMED rather than looked up through a per-vertex successor: a vertex where two
  // holes meet has two boundary edges leaving it, and a single successor map silently keeps one and
  // drops the other. That is not hypothetical here — it left 232 of the body's 2,556 open edges
  // unclosed, which is 232 chances for the interior to show through.
  const outgoing = new Map<number, number[]>();
  let pending = 0;
  for (const [key, count] of undirected) {
    if (count !== 1) continue;
    const [x, y] = key.split('_').map(Number);
    const [from, to] = directed.has(`${x}>${y}`) ? [x, y] : [y, x];
    const list = outgoing.get(from);
    if (list) list.push(to);
    else outgoing.set(from, [to]);
    pending += 1;
  }

  let capped = 0;
  while (pending > 0) {
    let start = -1;
    for (const [vertex, list] of outgoing) {
      if (list.length) { start = vertex; break; }
      outgoing.delete(vertex);
    }
    if (start < 0) break;

    const loop: number[] = [];
    let at = start;
    for (;;) {
      const list = outgoing.get(at);
      if (!list || !list.length) break;
      const next = list.pop() as number;
      pending -= 1;
      loop.push(at);
      at = next;
      if (at === start) break;
      if (loop.length > 100000) break;
    }
    // Fewer than three vertices is not a hole, it is a stray edge the weld left behind.
    if (loop.length < 3) continue;
    const hub = localOf.get(loop[0]);
    if (hub === undefined) continue;
    for (let i = 1; i + 1 < loop.length; i += 1) {
      const a = localOf.get(loop[i]);
      const b = localOf.get(loop[i + 1]);
      if (a === undefined || b === undefined) continue;
      // Reversed against the rim's own winding, so the cap faces out of the volume it closes.
      indices.push(hub, b, a);
    }
    capped += 1;
  }
  return capped;
}

export function buildRegionGeometries(part: DecodedPart, segmentation: SegmentationResult): RegionGeometry[] {
  const { position, normal, colour, index } = part;
  const triangleCount = index.length / 3;
  const out: RegionGeometry[] = [];

  for (let region = 0; region < REGIONS.length; region += 1) {
    const remap = new Int32Array(part.meta.vertexCount).fill(-1);
    const sourceVertex: number[] = [];
    const indices: number[] = [];
    for (let t = 0; t < triangleCount; t += 1) {
      if (segmentation.triangleRegion[t] !== region) continue;
      for (let k = 0; k < 3; k += 1) {
        const source = index[t * 3 + k];
        let local = remap[source];
        if (local < 0) {
          local = sourceVertex.length;
          remap[source] = local;
          sourceVertex.push(source);
        }
        indices.push(local);
      }
    }
    if (!indices.length) continue;
    // Recorded so measurement can tell the character's own surface from the lids behind it: a cap
    // triangle spans an opening by design, and counting it as "the mesh stretched" would report an
    // artefact where there is only a lid doing its job.
    const visibleIndexCount = indices.length;
    /*
     * Only the body is capped, and only the body needs to be.
     *
     * A hole matters when there is nothing behind it. Behind the gown and behind the hair there is
     * the body, which this closes; behind the BODY there is only its own unlit interior, which is
     * the black the viewer was seeing through her hip.
     *
     * Capping all three was tried, and the hair made the case against it: hair is ribbons, not a
     * volume, and its long open edges ARE the strand silhouettes. Fanning a lid across 23 of those
     * buried the hair under flat sheets and turned a waist-length black fall into a pale bob.
     */
    const cappedLoops = REGIONS[region] === 'body'
      ? capBoundaryLoops(indices, sourceVertex, segmentation.representative)
      : 0;

    const n = sourceVertex.length;
    const positions = new Float32Array(n * 3);
    const normals = new Float32Array(n * 3);
    const colours = new Float32Array(n * 3);
    for (let i = 0; i < n; i += 1) {
      const s = sourceVertex[i];
      for (let a = 0; a < 3; a += 1) {
        positions[i * 3 + a] = position[s * 3 + a];
        normals[i * 3 + a] = normal[s * 3 + a];
        colours[i * 3 + a] = colour[s * 3 + a];
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    geometry.setIndex(new THREE.BufferAttribute(n > 65535 ? new Uint32Array(indices) : new Uint16Array(indices), 1));
    geometry.computeBoundingSphere();
    geometry.userData.cappedLoops = cappedLoops;
    geometry.userData.visibleIndexCount = visibleIndexCount;
    out.push({ region: REGIONS[region], geometry, sourceVertex: new Uint32Array(sourceVertex) });
  }
  return out;
}
