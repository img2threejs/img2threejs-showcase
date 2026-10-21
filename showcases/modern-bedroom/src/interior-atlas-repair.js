// Baked-atlas rim repair.
//
// The ambient bake is denoised as a whole atlas. OIDN mixes the empty (exactly zero) texels around every UV island into the
// island's outermost texels, so each island is ringed by 3-4 texels that fade toward black (measured on the shipped atlases:
// ring 1 ~0 %, ring 2 ~45 %, ring 3 ~80 %, ring 4 ~92 % of the neighbouring interior). Bilinear sampling at an island border
// reads those texels and draws the dark, dotted outline along plank joints, the rug edge and pillow / duvet seams.
//
// This pass undoes that bleed at load time: every non-empty texel within RIM_TEXELS of an empty texel is replaced by the
// nearest deeper texel (nearest-copy, like Blender's EXTEND margin), working outward from the first trustworthy ring.
// Islands too thin to have a trustworthy ring keep what the bake gave them.
//
// Cost: the atlases are 2048-4096 px and most of their area is either empty or island interior, so the distance field is only
// computed in the 8x8 tiles that can hold a rim texel (a tile with an empty texel and its neighbours); the rest is final by
// construction (fully empty = 0, no empty texel within a tile = farther than RIM_TEXELS = FAR).
const RIM_TEXELS = 4;
const FAR = 255;
const TILE = 8;
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export function repairAtlasRims(data, width, height) {
  const half = data instanceof Uint16Array;
  // Two texels' worth of half floats per 32-bit read (r|g, b|a), little-endian layout only.
  const wide = half && LITTLE_ENDIAN && data.byteOffset % 4 === 0 ? new Uint32Array(data.buffer, data.byteOffset, data.length / 2) : null;
  const total = width * height;
  const dist = new Uint8Array(total).fill(FAR);
  const tilesX = Math.ceil(width / TILE), tilesY = Math.ceil(height / TILE);
  const tileEmpty = new Uint8Array(tilesX * tilesY);
  const tileFilled = new Uint8Array(tilesX * tilesY);

  // Pass 1: mark empty texels (dist 0) and which 8x8 tiles hold empty / non-empty texels.
  for (let y = 0; y < height; y++) {
    const row = y * width, tileRow = (y / TILE | 0) * tilesX;
    for (let tx = 0; tx < tilesX; tx++) {
      const x0 = tx * TILE, x1 = Math.min(width, x0 + TILE);
      let empties = 0;
      if (wide) {
        for (let x = x0, i = row + x0; x < x1; x++, i++) {
          if ((wide[2 * i] & 0x7fff7fff) === 0 && (wide[2 * i + 1] & 0x7fff) === 0) { dist[i] = 0; empties++; }
        }
      } else if (half) {
        for (let x = x0, i = row + x0; x < x1; x++, i++) {
          const o = i * 4;
          if (((data[o] | data[o + 1] | data[o + 2]) & 0x7fff) === 0) { dist[i] = 0; empties++; }
        }
      } else {
        for (let x = x0, i = row + x0; x < x1; x++, i++) {
          const o = i * 4;
          if (data[o] === 0 && data[o + 1] === 0 && data[o + 2] === 0) { dist[i] = 0; empties++; }
        }
      }
      if (empties) tileEmpty[tileRow + tx] = 1;
      if (empties < x1 - x0) tileFilled[tileRow + tx] = 1;
    }
  }

  // Texels within RIM_TEXELS of an empty texel lie in a tile that holds one, or in a neighbouring tile. Every other tile is
  // either fully empty (dist 0) or farther than RIM_TEXELS from any empty texel (dist FAR): already final.
  const candidate = new Uint8Array(tilesX * tilesY);
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      if (!tileEmpty[ty * tilesX + tx]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = ty + dy;
        if (yy < 0 || yy >= tilesY) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = tx + dx;
          if (xx >= 0 && xx < tilesX && tileFilled[yy * tilesX + xx]) candidate[yy * tilesX + xx] = 1;
        }
      }
    }
  }
  // Spans of consecutive candidate tiles per tile row: [x0, x1) pairs.
  const spans = [];
  for (let ty = 0; ty < tilesY; ty++) {
    const list = [];
    for (let tx = 0; tx < tilesX;) {
      if (!candidate[ty * tilesX + tx]) { tx++; continue; }
      const start = tx;
      while (tx < tilesX && candidate[ty * tilesX + tx]) tx++;
      list.push(start * TILE, Math.min(width, tx * TILE));
    }
    spans.push(list);
  }

  // Pass 2/3: 8-connected two-pass chamfer (Chebyshev distance) restricted to the candidate spans.
  for (let y = 0; y < height; y++) {
    const list = spans[y / TILE | 0];
    const row = y * width;
    for (let s = 0; s < list.length; s += 2) {
      for (let x = list[s], end = list[s + 1]; x < end; x++) {
        const i = row + x;
        let d = dist[i];
        if (d === 0) continue;
        if (x > 0) {
          const left = dist[i - 1] + 1;
          if (left < d) d = left;
          if (y > 0) { const upLeft = dist[i - width - 1] + 1; if (upLeft < d) d = upLeft; }
        }
        if (y > 0) {
          const up = dist[i - width] + 1;
          if (up < d) d = up;
          if (x < width - 1) { const upRight = dist[i - width + 1] + 1; if (upRight < d) d = upRight; }
        }
        dist[i] = d > FAR ? FAR : d;
      }
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    const list = spans[y / TILE | 0];
    const row = y * width;
    for (let s = list.length - 2; s >= 0; s -= 2) {
      for (let x = list[s + 1] - 1, start = list[s]; x >= start; x--) {
        const i = row + x;
        let d = dist[i];
        if (d === 0) continue;
        if (x < width - 1) {
          const right = dist[i + 1] + 1;
          if (right < d) d = right;
          if (y < height - 1) { const downRight = dist[i + width + 1] + 1; if (downRight < d) d = downRight; }
        }
        if (y < height - 1) {
          const down = dist[i + width] + 1;
          if (down < d) d = down;
          if (x > 0) { const downLeft = dist[i + width - 1] + 1; if (downLeft < d) d = downLeft; }
        }
        dist[i] = d > FAR ? FAR : d;
      }
    }
  }

  // Rim texels per level, only from the candidate spans.
  const counts = new Uint32Array(RIM_TEXELS + 1);
  for (let y = 0; y < height; y++) {
    const list = spans[y / TILE | 0];
    const row = y * width;
    for (let s = 0; s < list.length; s += 2) {
      for (let x = list[s], end = list[s + 1]; x < end; x++) { const d = dist[row + x]; if (d >= 1 && d <= RIM_TEXELS) counts[d]++; }
    }
  }
  const levels = [];
  for (let d = 0; d <= RIM_TEXELS; d++) levels.push(new Int32Array(counts[d]));
  const fill = new Uint32Array(RIM_TEXELS + 1);
  for (let y = 0; y < height; y++) {
    const list = spans[y / TILE | 0];
    const row = y * width;
    for (let s = 0; s < list.length; s += 2) {
      for (let x = list[s], end = list[s + 1]; x < end; x++) { const i = row + x, d = dist[i]; if (d >= 1 && d <= RIM_TEXELS) levels[d][fill[d]++] = i; }
    }
  }

  // Outermost trusted ring first: a texel at distance k copies its deepest 8-neighbour (distance > k, already repaired).
  const offsets = [-width - 1, -width, -width + 1, -1, 1, width - 1, width, width + 1];
  let repaired = 0;
  for (let k = RIM_TEXELS; k >= 1; k--) {
    const list = levels[k];
    for (let n = 0; n < list.length; n++) {
      const i = list[n];
      const x = i % width, y = (i - x) / width;
      let best = -1, bestDistance = k;
      if (x > 0 && x < width - 1 && y > 0 && y < height - 1) {
        for (let q = 0; q < 8; q++) { const j = i + offsets[q]; if (dist[j] > bestDistance) { bestDistance = dist[j]; best = j; } }
      } else {
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if ((dx === 0 && dy === 0) || xx < 0 || xx >= width) continue;
            const j = yy * width + xx;
            if (dist[j] > bestDistance) { bestDistance = dist[j]; best = j; }
          }
        }
      }
      if (best < 0) continue;
      if (wide) { wide[2 * i] = wide[2 * best]; wide[2 * i + 1] = wide[2 * best + 1]; }
      else { const to = i * 4, from = best * 4; data[to] = data[from]; data[to + 1] = data[from + 1]; data[to + 2] = data[from + 2]; data[to + 3] = data[from + 3]; }
      repaired++;
    }
  }
  return { repaired, rimTexels: RIM_TEXELS, texels: total };
}

// r180 EXRLoader decodes bottom-row-first; glTF UV1 uses a top origin. Only lightmap atlases cross this boundary (never the
// environment probe). Flips the RGBA rows of `data` in place.
export function orientAtlasRows(data, width, height) {
  const stride = width * 4;
  const rowScratch = new data.constructor(stride);
  for (let y = 0; y < Math.floor(height / 2); y++) {
    const top = y * stride;
    const bottom = (height - 1 - y) * stride;
    rowScratch.set(data.subarray(top, top + stride));
    data.copyWithin(top, bottom, bottom + stride);
    data.set(rowScratch, bottom);
  }
}

// Everything a decoded EXR atlas needs before it is a glTF lightmap: row orientation, then the rim repair. Runs on the main
// thread (prepareLightmaps) or inside the decode worker (workers/exr-decode.worker.js) with identical results.
export function prepareAtlasData(data, width, height) {
  orientAtlasRows(data, width, height);
  const started = performance.now();
  const repair = repairAtlasRims(data, width, height);
  return { ...repair, width, height, ms: Math.round(performance.now() - started) };
}
