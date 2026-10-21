import * as THREE from 'three';

// Every CPU-side lightmap lookup of the viewer (open ambient of a cloth, bake-hole fallbacks, starved-island repair) reads the
// nearest texel of the atlas at a vertex's UV1. The optimiser (scripts/optimize_runtime_assets.mjs) precomputes exactly those
// texels - half-float RGB of the oriented, rim-repaired atlas at every vertex of every lightmapped mesh - into
// lightmap-samples.bin/.json, so the viewer never fetches or decodes an atlas on the CPU. A function below that used to read
// `texture.image.data` at `floor(uv * size)` now reads the same value from `rgbFor(mesh)[3 * vertex ..]`: identical numbers.

// Half float bits -> value, exactly (every half is representable as a float32), through one 64 K-entry table.
let halfTable = null;
function halfToFloat(bits) {
  if (!halfTable) {
    halfTable = new Float32Array(65536);
    for (let value = 0; value < 65536; value++) {
      const exponent = (value >> 10) & 31, fraction = value & 1023, sign = value >> 15 ? -1 : 1;
      halfTable[value] = exponent === 0 ? sign * 2 ** -14 * (fraction / 1024)
        : exponent === 31 ? (fraction ? NaN : sign * Infinity)
        : sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
    }
  }
  return halfTable[bits];
}

// The per-vertex texel table of lightmap-samples.bin. `index` is lightmap-samples.json, `buffer` the .bin (little-endian Uint16
// half RGB per vertex, meshes concatenated, `offset` counted in Uint16 elements, vertex order = GLB accessor order).
// `rgbFor(mesh)` returns the mesh's live view (3 half values per vertex); repairStarvedVertices rewrites the rows of the vertices it
// re-points, so the view always equals "the texel under the vertex's current UV1".
export function createLightmapSamples(index, buffer) {
  if (index?.version !== 1 || index.format !== 'half-rgb-per-vertex' || !index.meshes || typeof index.meshes !== 'object') {
    throw new Error('lightmap-samples.json has an unknown format; re-run npm run optimize:assets.');
  }
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength % 6 !== 0) throw new Error('lightmap-samples.bin is not a half-float RGB table.');
  const data = new Uint16Array(buffer);
  return {
    meshCount: Object.keys(index.meshes).length,
    vertexCount: data.length / 3,
    // Null for a mesh without a lightmap; throws when the table does not describe this mesh (stale optimiser output).
    rgbFor(mesh) {
      const atlasId = mesh.userData.lightmap;
      if (atlasId === undefined) return null;
      const name = mesh.userData.name ?? mesh.name;
      const record = Object.hasOwn(index.meshes, name) ? index.meshes[name] : null;
      const count = mesh.geometry.attributes.uv1?.count;
      if (!record || record.atlas !== atlasId || record.count !== count || !(record.offset >= 0) || (record.offset + 3 * count) > data.length) {
        throw new Error(`lightmap-samples does not match mesh ${name}; re-run npm run optimize:assets after exporting.`);
      }
      return data.subarray(record.offset, record.offset + 3 * count);
    },
  };
}

// Nearest-texel lightmap reads for a mesh's vertices (UV1), in lightmap units; `up` marks vertices whose world normal points
// upward (y > 0.5), i.e. the surface the room's light falls on.
function vertexTexels(mesh, rgb, stride = 1) {
  const { uv1: uv, normal } = mesh.geometry.attributes;
  mesh.updateWorldMatrix(true, false);
  const direction = new THREE.Vector3();
  const samples = [];
  let holes = 0;
  for (let i = 0; i < uv.count; i += stride) {
    const r = halfToFloat(rgb[3 * i]), g = halfToFloat(rgb[3 * i + 1]), b = halfToFloat(rgb[3 * i + 2]);
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (luma > 0 && Number.isFinite(luma)) {
      const up = !!normal && direction.fromBufferAttribute(normal, i).transformDirection(mesh.matrixWorld).y > 0.5;
      samples.push({ r, g, b, luma, up });
    } else holes++;
  }
  return { samples, holes };
}

// Open light on the surface: the mean of the lit samples of the upward-facing vertices (all vertices when fewer than
// OPEN_AMBIENT_MIN_UP face up), ignoring the darkest 40 % (baked contact shadows, rim texels and starved islands).
// Averaging every vertex instead lets the hanging skirts and undersides of a cloth drag the level down by ~35 %: a relit
// duvet then reads 24 % greyer than the baked one (measured: sRGB 217 -> 173 at the lit top). Null without any lit sample.
const OPEN_AMBIENT_MIN_UP = 16;
function openAmbient(samples) {
  if (!samples.length) return null;
  const up = samples.filter(sample => sample.up);
  const pool = up.length >= OPEN_AMBIENT_MIN_UP ? up : samples;
  pool.sort((a, b) => a.luma - b.luma);
  const kept = pool.slice(Math.floor(pool.length * 0.4));
  const sum = kept.reduce((total, sample) => [total[0] + sample.r, total[1] + sample.g, total[2] + sample.b], [0, 0, 0]);
  return sum.map(value => value / kept.length);
}

// The ambient a lightmapped mesh receives on average, in lightmap units (see openAmbient).
// Used to relight a cloth that has left its baked rest pose.
export function ambientReference(mesh, samples) {
  const rgb = samples.rgbFor(mesh);
  if (!rgb) throw new Error(`Mesh ${mesh.name} has no lightmap.`);
  const ambient = openAmbient(vertexTexels(mesh, rgb, Math.max(1, Math.floor(mesh.geometry.attributes.uv1.count / 4096))).samples);
  if (!ambient) throw new Error(`Mesh ${mesh.name} has no lit lightmap texels.`);
  return ambient;
}

// Bake holes: texels the bake never wrote (sub-texel islands of welts, hems, cables; the empty rim of an island) are exactly
// zero and draw black dots on a lit surface. A mesh with such holes gets a per-vertex `lightFallback`: the open ambient of
// the mesh itself, or - when (almost) none of its own texels survived, as for tubes - of the meshes it belongs to: the ones
// sharing the longest dotted name prefix ("pillow.grey.front.0.welt.0" -> "pillow.grey.front.0", "rug.bound-fabric-edge" ->
// "rug.low-pile"). The baked-diffuse shader blends toward it wherever the sampled texel is a hole (interior-shading.js).
// Dynamic cloth has no lightmap and is skipped. Returns { meshes, vertices } counts of patched meshes / vertices.
//
// The lift is decided per vertex, not per mesh: only a vertex whose own texel really is a hole - its luma
// is at most HOLE_EPS of the mesh's open ambient - carries the ambient. A vertex the bake wrote carries
// zero, so its genuine baked shadow survives and the shader leaves it alone.
//
// A rebake that fills the holes therefore removes the lift by itself: the formerly black texels read as
// lit at load time, no vertex is a hole any more, and nothing is lifted twice.
const OWN_AMBIENT_MIN_LIT = 0.25;
const HOLE_EPS = 0.02;
export function applyLightFallbacks(entries, samples) {
  const records = [];
  for (const { mesh } of entries) {
    if (mesh.userData.curtain_id !== undefined) continue;
    const rgb = samples.rgbFor(mesh);
    if (!rgb) continue;
    const count = mesh.geometry.attributes.uv1.count;
    const { samples: lit, holes } = vertexTexels(mesh, rgb);
    records.push({ mesh, rgb, key: mesh.userData.physical_id ?? mesh.name, count, holes, litFraction: lit.length / count, ambient: openAmbient(lit) });
  }
  const donors = records.filter(record => record.ambient && record.litFraction >= OWN_AMBIENT_MIN_LIT);
  const stats = { meshes: 0, vertices: 0, holes: 0 };
  for (const record of records) {
    if (!record.holes) continue;
    let ambient = record.litFraction >= OWN_AMBIENT_MIN_LIT ? record.ambient : null;
    if (!ambient) {
      // Longest shared dotted prefix with at least one donor mesh.
      const parts = record.key.split('.');
      for (let length = parts.length - 1; length >= 1 && !ambient; length--) {
        const prefix = `${parts.slice(0, length).join('.')}.`;
        const pool = donors.filter(donor => donor !== record && (donor.key.startsWith(prefix) || `${donor.key}.` === prefix));
        if (pool.length) ambient = [0, 1, 2].map(channel => pool.reduce((sum, donor) => sum + donor.ambient[channel], 0) / pool.length);
      }
    }
    if (!ambient) continue;
    // The per-vertex fallback: the ambient where the vertex's own texel is a hole, zero elsewhere.
    const { rgb } = record;
    const ambientLuma = 0.2126 * ambient[0] + 0.7152 * ambient[1] + 0.0722 * ambient[2];
    const holeThreshold = HOLE_EPS * ambientLuma;
    const attribute = new Float32Array(record.count * 3);
    const isHole = new Uint8Array(record.count);
    for (let i = 0; i < record.count; i++) {
      const luma = 0.2126 * halfToFloat(rgb[3 * i]) + 0.7152 * halfToFloat(rgb[3 * i + 1]) + 0.0722 * halfToFloat(rgb[3 * i + 2]);
      if (luma > holeThreshold) continue;
      isHole[i] = 1;
      attribute.set(ambient, i * 3);
      stats.holes++;
    }
    // A triangle whose EVERY vertex is a hole is a hole itself, however its vertices are shaded.
    // The plank's top face is such a triangle: all four of its corners land in the atlas region the
    // bake never wrote, so the face is black from corner to corner. Lifting only the vertices is not
    // enough - the interpolated lightmap UV inside the triangle still points into the hole, and the
    // face draws black (measured on the final export: 5.2 % of the floor pixels were near-black in
    // whole-plank patches).
    //
    // The fix is to give such a triangle its own UVs: the lightmap lookup of a hole triangle is
    // replaced by the mesh's open ambient. The triangle's own UVs are kept for the base colour, so
    // the plank keeps its wood grain; only the lightmap channel changes.
    const index = record.mesh.geometry.index;
    if (index) {
      const triangles = index.count / 3;
      for (let t = 0; t < triangles; t++) {
        const a = index.getX(3 * t), b = index.getX(3 * t + 1), c = index.getX(3 * t + 2);
        if (!isHole[a] || !isHole[b] || !isHole[c]) continue;
        // The whole triangle is a hole: mark its vertices so the shader lifts the whole face.
        for (const i of [a, b, c]) {
          if (attribute[i * 3] || attribute[i * 3 + 1] || attribute[i * 3 + 2]) continue;
          attribute.set(ambient, i * 3);
        }
        stats.holeTriangles = (stats.holeTriangles ?? 0) + 1;
      }
    }
    record.mesh.geometry.setAttribute('lightFallback', new THREE.BufferAttribute(attribute, 3));
    stats.meshes++;
    stats.vertices += record.count;
  }
  return stats;
}

// Meshes may list vertices whose lightmap texel is (almost) black although the rest of the mesh is lit: the rounded edges
// and end faces of a plank live in sub-millimetre black islands. At the pixel grid those draw the dark, dotted joint line.
// A starved vertex that faces away from the mesh's surface (normal below SURFACE_COS against the surface normal, estimated
// below) takes the lightmap UV of the nearest surface-facing vertex of the same mesh (object-space distance, lit or not: the
// surface carries the baked light of the spot, even where that light is genuinely low) and its albedo is darkened by
// `groove`, so the joint stays a soft, continuous line instead of aliased black dots.
// Surface-facing vertices are never moved. A top-face corner that reads black sits on the island border (its texel floors
// into the empty ring) or in real baked shadow; pointing it at a distant lit vertex would smear the texture across its
// whole triangle, and pointing a rounded edge at the nearest *lit* vertex (a different spot) streaks it across the atlas.
// Returns the repaired count.
const SURFACE_COS = 0.92;

export function repairStarvedVertices(mesh, samples, { threshold, groove }) {
  const geometry = mesh.geometry;
  const { position, uv1, normal } = geometry.attributes;
  const rgb = samples.rgbFor(mesh);
  if (!rgb) throw new Error(`Mesh ${mesh.name} has no lightmap.`);
  const count = uv1.count;
  const luma = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    luma[i] = 0.2126 * halfToFloat(rgb[3 * i]) + 0.7152 * halfToFloat(rgb[3 * i + 1]) + 0.0722 * halfToFloat(rgb[3 * i + 2]);
  }
  const sorted = Float32Array.from(luma).sort();
  const top = Math.max(4, Math.ceil(count * 0.02));
  let reference = 0;
  for (let k = 0; k < Math.min(top, count); k++) reference += sorted[count - 1 - k];
  reference /= Math.min(top, count);
  const lit = [], starved = [];
  for (let i = 0; i < count; i++) (luma[i] >= threshold * reference ? lit : starved).push(i);
  // Surface normal = sum of triangle area-vectors weighted by the triangle's mean lit-ness. The big top face dominates; the
  // equally large but black underside, the sub-millimetre bevels and the end faces do not.
  //
  // The weighting by lit-ness is deliberate, and it is what repairs the floor: a plank's top face
  // is a hole in the bake, so it drops out of the sum and the estimate follows the plank's axis
  // instead of its normal. The top face then reads as "not facing the surface", and this repair
  // moves it onto a lit texel of the same plank. Estimating the normal from the geometry instead
  // (the area-weighted vertex normals) makes the top face "facing", which SKIPS it - and the face
  // then draws black from corner to corner (measured on the final export: 5.2 % of the floor
  // pixels near-black, in whole-plank patches).
  const index = geometry.index;
  let mx = 0, my = 0, mz = 0;
  for (let t = 0, triangles = (index ? index.count : count) / 3; t < triangles; t++) {
    const a = index ? index.getX(3 * t) : 3 * t, b = index ? index.getX(3 * t + 1) : 3 * t + 1, c = index ? index.getX(3 * t + 2) : 3 * t + 2;
    const weight = luma[a] + luma[b] + luma[c];
    if (weight <= 0) continue;
    const ux = position.getX(b) - position.getX(a), uy = position.getY(b) - position.getY(a), uz = position.getZ(b) - position.getZ(a);
    const vx = position.getX(c) - position.getX(a), vy = position.getY(c) - position.getY(a), vz = position.getZ(c) - position.getZ(a);
    mx += (uy * vz - uz * vy) * weight; my += (uz * vx - ux * vz) * weight; mz += (ux * vy - uy * vx) * weight;
  }
  const length = Math.hypot(mx, my, mz) || 1;
  mx /= length; my /= length; mz /= length;
  // Winding may not match the vertex normals; follow the normals.
  let side = 0;
  if (normal) for (const j of lit) side += normal.getX(j) * mx + normal.getY(j) * my + normal.getZ(j) * mz;
  if (side < 0) { mx = -mx; my = -my; mz = -mz; }
  const facing = i => normal.getX(i) * mx + normal.getY(i) * my + normal.getZ(i) * mz >= SURFACE_COS;
  const donors = normal && lit.length ? Array.from({ length: count }, (_, i) => i).filter(facing) : lit;
  const color = new Float32Array(count * 3).fill(1);
  let repaired = 0;
  if (reference > 0 && donors.length && starved.length && donors.length * starved.length <= 2e7) {
    for (const i of starved) {
      if (normal && facing(i)) continue;
      let best = donors[0], bestDistance = Infinity;
      for (const j of donors) {
        const dx = position.getX(i) - position.getX(j), dy = position.getY(i) - position.getY(j), dz = position.getZ(i) - position.getZ(j);
        const distance = dx * dx + dy * dy + dz * dz;
        if (distance < bestDistance) { bestDistance = distance; best = j; }
      }
      uv1.setXY(i, uv1.getX(best), uv1.getY(best));
      // The vertex now reads the texel of `best`; later lookups (applyLightFallbacks) must see that value.
      rgb.copyWithin(3 * i, 3 * best, 3 * best + 3);
      color.fill(groove, i * 3, i * 3 + 3);
      repaired++;
    }
    uv1.needsUpdate = true;
  }
  // Every mesh that shares the vertex-coloured material needs the attribute, repaired or not.
  geometry.setAttribute('color', new THREE.BufferAttribute(color, 3));
  return repaired;
}

// '*' matches within one dotted segment of a mesh key, '**' across segments, '?' one character; no wildcard is an exact match.
export function createMeshMatcher(patterns) {
  const tests = (patterns ?? []).map(pattern => {
    let out = '';
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];
      if (ch === '*') { if (pattern[i + 1] === '*') { out += '.*'; i++; } else out += '[^.]*'; }
      else if (ch === '?') out += '[^.]';
      else out += ch.replace(/[\\^$.|+(){}[\]]/g, '\\$&');
    }
    return new RegExp(`^${out}$`);
  });
  return key => tests.some(test => test.test(key));
}
