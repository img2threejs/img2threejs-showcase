// Flowing-water VFX for Greenvale: three waterfalls, base foam and foam arcs,
// drifting pond/stream flow ripples, fountain droplets and basin rings.
//
// Exports `createWaterFlow(): WaterFlow`, the shared pixel-art frame-bank
// baker `bakeFrameBank`, and the small deterministic helpers the chimney
// smoke module reuses.
//
// Determinism: every animation is a pure function of the world time handed to
// `update(t, night)`. There is no PRNG state, no `Math.random`, and no
// dependence on step size: all randomness is seeded integer hashing of
// (slot, cycle) pairs, and cycle/frame boundaries are offset by an irrational
// phase so a 0.05 s step and five 0.01 s steps land on the same cell.
//
// Pixel art: every highlight is composed of 2x2 px cells at even world
// coordinates, baked into nearest-sampled frame banks (falls, arcs, rings) or
// drawn as scaled solid rectangles (dashes, foam cells, droplets). Nothing is
// bitmap-scaled to grow; growth is a baked frame swap.
//
// Confinement: ripples, foam cells and droplet landings are placed only where
// a 2 px zone grid (rasterised once at init from the traced polygons below,
// minus the bridge, boat envelope, dock layer, rocks, lily pads and HUD rects)
// says water is. Baked arcs and rings are clipped against the same polygons at
// bake time.
//
// Ownership: every Sprite, baked Texture and TextureSource created here is
// destroyed by `dispose()`; the borrowed `Texture.WHITE` is never destroyed.

import { Container, Rectangle, Sprite, Texture, TextureSource } from 'pixi.js';

import { HEIGHT, WIDTH } from './types.js';

// ---------- shared deterministic helpers ---------------------------------

/** Seeded integer hash of three integers -> uint32. */
export function hash3(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x85ebca6b) ^ Math.imul((b | 0) + 0x7f4a7c15, 0xc2b2ae35)
    ^ Math.imul((c | 0) + 0x165667b1, 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

/** uint32 -> [0, 1). */
export function u01(h: number): number {
  return h / 4294967296;
}

/** Snap a world coordinate down to the 2 px art grid. */
export function even(v: number): number {
  return Math.floor(v / 2) * 2;
}

export function lerpColor(a: number, b: number, k: number): number {
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const r = Math.round(ar + (((b >> 16) & 255) - ar) * k);
  const g = Math.round(ag + (((b >> 8) & 255) - ag) * k);
  const bl = Math.round(ab + ((b & 255) - ab) * k);
  return (r << 16) | (g << 8) | bl;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ---------- baked frame banks -------------------------------------------

export type CellPainter = (cx: number, cy: number, rgb: number) => void;

export interface FrameBank {
  readonly textures: readonly Texture[];
  readonly frameWidth: number;
  readonly frameHeight: number;
  destroy(): void;
}

/**
 * Bake `count` frames of `cellsW x cellsH` 2 px cells into one nearest-sampled
 * atlas. `paint(put, index)` writes opaque cells; everything else stays
 * transparent (hard alpha only, no gradients).
 */
export function bakeFrameBank(
  label: string,
  cellsW: number,
  cellsH: number,
  count: number,
  paint: (put: CellPainter, index: number) => void,
): FrameBank {
  const frameW = cellsW * 2;
  const frameH = cellsH * 2;
  const cols = Math.max(1, Math.min(count, Math.round(Math.sqrt((count * frameH) / frameW))));
  const rows = Math.ceil(count / cols);
  const width = cols * frameW;
  const height = rows * frameH;
  if (width > 4096 || height > 4096) throw new Error(`greenvale water-flow: ${label} atlas ${width}x${height} too large`);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(`greenvale water-flow: 2D canvas unavailable for ${label}`);
  const image = ctx.createImageData(width, height);
  const data = image.data;
  for (let index = 0; index < count; index++) {
    const ox = (index % cols) * frameW;
    const oy = Math.floor(index / cols) * frameH;
    const put: CellPainter = (cx, cy, rgb) => {
      if (cx < 0 || cy < 0 || cx >= cellsW || cy >= cellsH) return;
      const r = (rgb >> 16) & 255;
      const g = (rgb >> 8) & 255;
      const b = rgb & 255;
      for (let dy = 0; dy < 2; dy++) {
        let at = ((oy + cy * 2 + dy) * width + ox + cx * 2) * 4;
        for (let dx = 0; dx < 2; dx++) {
          data[at++] = r;
          data[at++] = g;
          data[at++] = b;
          data[at++] = 255;
        }
      }
    };
    paint(put, index);
  }
  ctx.putImageData(image, 0, 0);
  const source = TextureSource.from({ resource: canvas, label: `${label}.source`, scaleMode: 'nearest' });
  const textures: Texture[] = [];
  for (let index = 0; index < count; index++) {
    textures.push(new Texture({
      source,
      frame: new Rectangle((index % cols) * frameW, Math.floor(index / cols) * frameH, frameW, frameH),
      label: `${label}.${index}`,
    }));
  }
  let destroyed = false;
  return {
    textures,
    frameWidth: frameW,
    frameHeight: frameH,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const texture of textures) if (!texture.destroyed) texture.destroy(false);
      if (!source.destroyed) source.destroy();
    },
  };
}

// ---------- traced geometry (artboard px, reference working.png) ----------
//
// Every polygon is traced from `.img2pixi2d/greenvale/reference/working.png`
// at native zoom against the water/foam colour mask, inset 2-4 px from the
// shoreline so highlights never reach rock, bridge, dock, bank or HUD pixels.
// Flat [x0, y0, x1, y1, ...] lists; ellipse/rect lists are groups of four.

// BEGIN-TRACE
/** Upper-right waterfall body (x1154-1194, y0-86). */
const FALL1_BODY: readonly number[] = [1162, 0, 1194, 0, 1194, 86, 1156, 86, 1154, 66, 1154, 30, 1159, 14, 1161, 6];
/** Lower-left waterfall body incl. top lip pool (x142-202, y828-928). */
const FALL2_BODY: readonly number[] = [152, 828, 178, 828, 188, 836, 194, 846, 197, 858, 199, 872, 201, 888, 202, 928, 143, 928, 142, 860, 144, 848, 148, 838];
/** Mid-left slanted cascade body (x404-434, y788-870). */
const FALL3_BODY: readonly number[] = [422, 788, 434, 788, 432, 800, 428, 816, 425, 832, 422, 848, 420, 862, 418, 870, 404, 870, 404, 852, 407, 836, 410, 824, 414, 808, 417, 794];
/** Splash/foam zones at the base of each fall. */
const FOAM1_ZONE: readonly number[] = [1140, 92, 1160, 90, 1196, 90, 1206, 100, 1204, 116, 1186, 124, 1156, 124, 1136, 114, 1132, 102];
const FOAM2_ZONE: readonly number[] = [146, 934, 200, 930, 214, 936, 224, 944, 232, 952, 226, 962, 206, 966, 178, 968, 158, 964, 150, 956, 146, 946];
const FOAM3_ZONE: readonly number[] = [386, 882, 408, 874, 424, 874, 440, 880, 464, 884, 476, 890, 478, 900, 462, 906, 440, 906, 410, 904, 388, 900, 382, 892];
/** Upper pond below the right fall (also the fall-1 arc clip). */
const UPPER_POND: readonly number[] = [1136, 118, 1214, 118, 1240, 132, 1254, 146, 1254, 188, 1222, 190, 1208, 202, 1202, 210, 1202, 250, 1100, 250, 1092, 232, 1086, 214, 1092, 196, 1094, 152, 1102, 144, 1116, 132, 1136, 126];
/** Lower pond: left shelf below the shoreline plus the open water south of the boat/dock. */
const LOWER_POND: readonly number[] = [238, 938, 262, 930, 284, 936, 318, 936, 332, 928, 346, 918, 372, 914, 404, 912, 470, 914, 478, 906, 500, 902, 935, 902, 935, 1016, 238, 1016];
/** Arc clip for the fall-2 and fall-3 foam arcs (pond shelf incl. area under the falls). */
const LOWER_ARC_CLIP: readonly number[] = [158, 946, 238, 936, 262, 930, 284, 936, 318, 936, 332, 928, 346, 918, 372, 908, 392, 898, 470, 898, 480, 904, 500, 902, 520, 902, 520, 966, 158, 966];
/** Stream under the bridge arch (arch water + channel down to the fence posts). */
const STREAM: readonly number[] = [1090, 398, 1132, 398, 1135, 424, 1148, 432, 1150, 446, 1124, 452, 1122, 502, 1062, 502, 1054, 500, 1024, 500, 1018, 490, 1018, 476, 1052, 474, 1054, 442, 1076, 440, 1090, 430];
/** Boat hull envelope (hull polygon + 4 px bob + wave lines), excluded from ripples. */
const BOAT_ENVELOPE: readonly number[] = [504, 893, 536, 866, 593, 856, 655, 857, 698, 880, 700, 908, 682, 934, 640, 950, 580, 956, 534, 940, 514, 914];
/** Fountain basin water around the pedestal and the two mid-bowl water patches. */
const FOUNTAIN_BASIN: readonly number[] = [666, 236, 678, 230, 689, 229, 690, 246, 698, 252, 706, 256, 722, 256, 730, 252, 734, 246, 734, 232, 746, 229, 760, 232, 768, 238, 769, 248, 762, 254, 752, 260, 742, 264, 730, 266, 698, 266, 686, 262, 672, 256, 662, 248, 660, 242];
const FOUNTAIN_MID_LEFT: readonly number[] = [687, 205, 698, 205, 700, 217, 689, 217];
const FOUNTAIN_MID_RIGHT: readonly number[] = [727, 205, 741, 205, 741, 217, 727, 217];
/** Exclusion rects (x, y, w, h): HUD, bridge, dock layer, rocks. */
const HUD_RECTS: readonly number[] = [0, 970, 520, 54, 1135, 894, 360, 130, 1262, 0, 274, 338];
const BRIDGE_RECT: readonly number[] = [1000, 257, 214, 199];
const DOCK_RECT: readonly number[] = [681, 744, 326, 241];
const ROCK_RECTS: readonly number[] = [548, 990, 62, 34];
/** Lily pads (cx, cy, rx, ry incl. 3 px margin) the ripples must leave alone. */
const LILY_PADS: readonly number[] = [
  1146, 182, 19, 13, 1186, 165, 24, 15, 1178, 192, 20, 11, 1106, 221, 15, 8,
  1084, 468, 13, 11, 1104, 471, 19, 14, 1082, 487, 12, 11,
  491, 920, 17, 12, 458, 949, 17, 15, 440, 967, 11, 8, 650, 978, 18, 14, 620, 994, 18, 13,
  662, 1002, 16, 12, 639, 1010, 12, 9, 515, 992, 18, 16, 805, 1007, 18, 14, 825, 992, 18, 13, 843, 1010, 18, 13,
];
// END-TRACE

// ---------- tunables ------------------------------------------------------

const FALL_FRAMES = 72;
const FALL_FPS = 60; // 72 frames @ 60 fps -> 1.2 s loop; column speeds 90-140 px/s
const FALL_ALPHA = 0.66;
const FALL_COLS = [0xffffff, 0x9fe0ff, 0xdff6ff] as const;
const FALL_PERIOD_MIN = 54; // cells per loop -> 90 px/s
const FALL_PERIOD_STEPS = 6; // 54..84 cells -> 90..140 px/s

const FOAM_PER_FALL = 14;
const FOAM_ALPHA = 0.85;
const ARC_FRAMES = 8;
const ARC_PERIOD = 1.8;
const ARCS_PER_FALL = 3;
const ARC_ALPHA = 0.9;

const RIPPLE_ALPHA = 0.85;
const RIPPLE_ATTEMPTS = 16;

const DROP_GRAVITY = 340;
const DROP_SPLASH = 0.14;
const DROP_TRAIL_STEP = 0.04;
const DROP_ALPHA = 1;
const RING_FRAMES = 6;
const RING_PERIOD = 1.5;
const RING_ALPHA = 0.8;

const COOL = 0xa9c8f0;
const NIGHT_DIM = 0.4;
// Frame/cycle boundaries sit off round step multiples so a 0.05 s step and
// five 0.01 s steps always land on the same frame: fractions of a frame for
// the 60 fps fall loop, a few milliseconds of skew for the analytic cycles.
const PHASE_EPS = 0.3719;
const CLOCK_SKEW = 0.0037;

const BIT_LOWER = 1;
const BIT_UPPER = 2;
const BIT_STREAM = 4;
const BIT_FOAM1 = 8;
const BIT_FOAM2 = 16;
const BIT_FOAM3 = 32;
const BIT_FOUNTAIN = 64;
const RIPPLE_BITS = BIT_LOWER | BIT_UPPER | BIT_STREAM;

// ---------- zone grid -----------------------------------------------------

const GRID_W = WIDTH / 2;
const GRID_H = HEIGHT / 2;
const edgeXs = new Float64Array(128);

function paintPolygon(grid: Uint8Array, pts: readonly number[], bits: number, add: boolean): void {
  const n = pts.length >> 1;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const y = pts[i * 2 + 1]!;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const cy0 = Math.max(0, Math.floor(minY / 2));
  const cy1 = Math.min(GRID_H - 1, Math.ceil(maxY / 2));
  for (let cy = cy0; cy <= cy1; cy++) {
    const y = cy * 2 + 1;
    let m = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = pts[i * 2 + 1]!;
      const yj = pts[j * 2 + 1]!;
      if ((yi <= y) !== (yj <= y)) {
        const xi = pts[i * 2]!;
        const xj = pts[j * 2]!;
        edgeXs[m++] = xi + ((y - yi) * (xj - xi)) / (yj - yi);
      }
    }
    for (let a = 1; a < m; a++) {
      const v = edgeXs[a]!;
      let b = a - 1;
      while (b >= 0 && edgeXs[b]! > v) {
        edgeXs[b + 1] = edgeXs[b]!;
        b--;
      }
      edgeXs[b + 1] = v;
    }
    for (let a = 0; a + 1 < m; a += 2) {
      const cxa = Math.max(0, Math.ceil((edgeXs[a]! - 1) / 2));
      const cxb = Math.min(GRID_W - 1, Math.floor((edgeXs[a + 1]! - 1) / 2));
      const row = cy * GRID_W;
      for (let cx = cxa; cx <= cxb; cx++) {
        if (add) grid[row + cx] = grid[row + cx]! | bits;
        else grid[row + cx] = grid[row + cx]! & ~bits;
      }
    }
  }
}

function paintRect(grid: Uint8Array, x: number, y: number, w: number, h: number, bits: number, add: boolean): void {
  const cx0 = Math.max(0, Math.ceil((x - 1) / 2));
  const cx1 = Math.min(GRID_W - 1, Math.ceil((x + w - 1) / 2) - 1);
  const cy0 = Math.max(0, Math.ceil((y - 1) / 2));
  const cy1 = Math.min(GRID_H - 1, Math.ceil((y + h - 1) / 2) - 1);
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const at = cy * GRID_W + cx;
      if (add) grid[at] = grid[at]! | bits;
      else grid[at] = grid[at]! & ~bits;
    }
  }
}

function paintEllipse(grid: Uint8Array, ex: number, ey: number, rx: number, ry: number, bits: number): void {
  const cy0 = Math.max(0, Math.floor((ey - ry) / 2));
  const cy1 = Math.min(GRID_H - 1, Math.ceil((ey + ry) / 2));
  const cx0 = Math.max(0, Math.floor((ex - rx) / 2));
  const cx1 = Math.min(GRID_W - 1, Math.ceil((ex + rx) / 2));
  for (let cy = cy0; cy <= cy1; cy++) {
    const dy = (cy * 2 + 1 - ey) / ry;
    for (let cx = cx0; cx <= cx1; cx++) {
      const dx = (cx * 2 + 1 - ex) / rx;
      if (dx * dx + dy * dy <= 1) grid[cy * GRID_W + cx] = grid[cy * GRID_W + cx]! & ~bits;
    }
  }
}

/** Even-odd point-in-polygon (bake time only). */
function pointInPolygon(pts: readonly number[], x: number, y: number): boolean {
  const n = pts.length >> 1;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[i * 2]!;
    const yi = pts[i * 2 + 1]!;
    const xj = pts[j * 2]!;
    const yj = pts[j * 2 + 1]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inLilyPad(x: number, y: number): boolean {
  for (let i = 0; i < LILY_PADS.length; i += 4) {
    const dx = (x - LILY_PADS[i]!) / LILY_PADS[i + 2]!;
    const dy = (y - LILY_PADS[i + 1]!) / LILY_PADS[i + 3]!;
    if (dx * dx + dy * dy <= 1) return true;
  }
  return false;
}

function buildZoneGrid(): Uint8Array {
  const grid = new Uint8Array(GRID_W * GRID_H);
  paintPolygon(grid, LOWER_POND, BIT_LOWER, true);
  paintPolygon(grid, UPPER_POND, BIT_UPPER, true);
  paintPolygon(grid, STREAM, BIT_STREAM, true);
  paintPolygon(grid, FOAM1_ZONE, BIT_FOAM1, true);
  paintPolygon(grid, FOAM2_ZONE, BIT_FOAM2, true);
  paintPolygon(grid, FOAM3_ZONE, BIT_FOAM3, true);
  paintPolygon(grid, FOUNTAIN_BASIN, BIT_FOUNTAIN, true);
  paintPolygon(grid, FOUNTAIN_MID_LEFT, BIT_FOUNTAIN, true);
  paintPolygon(grid, FOUNTAIN_MID_RIGHT, BIT_FOUNTAIN, true);
  for (let i = 0; i < HUD_RECTS.length; i += 4) {
    paintRect(grid, HUD_RECTS[i]!, HUD_RECTS[i + 1]!, HUD_RECTS[i + 2]!, HUD_RECTS[i + 3]!, RIPPLE_BITS, false);
  }
  const land = BIT_LOWER | BIT_UPPER;
  paintRect(grid, BRIDGE_RECT[0]!, BRIDGE_RECT[1]!, BRIDGE_RECT[2]!, BRIDGE_RECT[3]!, land, false);
  paintRect(grid, DOCK_RECT[0]!, DOCK_RECT[1]!, DOCK_RECT[2]!, DOCK_RECT[3]!, land, false);
  for (let i = 0; i < ROCK_RECTS.length; i += 4) {
    paintRect(grid, ROCK_RECTS[i]!, ROCK_RECTS[i + 1]!, ROCK_RECTS[i + 2]!, ROCK_RECTS[i + 3]!, land, false);
  }
  paintPolygon(grid, BOAT_ENVELOPE, land, false);
  paintPolygon(grid, FOAM1_ZONE, land, false);
  paintPolygon(grid, FOAM2_ZONE, land, false);
  paintPolygon(grid, FOAM3_ZONE, land, false);
  for (let i = 0; i < LILY_PADS.length; i += 4) {
    paintEllipse(grid, LILY_PADS[i]!, LILY_PADS[i + 1]!, LILY_PADS[i + 2]!, LILY_PADS[i + 3]!, RIPPLE_BITS);
  }
  return grid;
}

// ---------- falls ---------------------------------------------------------

interface FallSpec {
  readonly label: string;
  readonly body: readonly number[];
  readonly slant: number; // cells of horizontal lean per cell of height
  readonly foamBit: number;
  readonly foamCx: number;
  readonly arcCx: number;
  readonly arcCy: number;
  readonly arcRx0: number;
  readonly arcRxMax: number;
  readonly arcClip: readonly number[];
}

const FALLS: readonly FallSpec[] = [
  {
    label: 'fall-upper-right', body: FALL1_BODY, slant: 0,
    foamBit: BIT_FOAM1, foamCx: 1172,
    arcCx: 1172, arcCy: 112, arcRx0: 16, arcRxMax: 62, arcClip: UPPER_POND,
  },
  {
    label: 'fall-lower-left', body: FALL2_BODY, slant: 0,
    foamBit: BIT_FOAM2, foamCx: 184,
    arcCx: 200, arcCy: 950, arcRx0: 16, arcRxMax: 60, arcClip: LOWER_ARC_CLIP,
  },
  {
    label: 'fall-mid-left', body: FALL3_BODY, slant: -0.2,
    foamBit: BIT_FOAM3, foamCx: 424,
    arcCx: 428, arcCy: 900, arcRx0: 16, arcRxMax: 64, arcClip: LOWER_ARC_CLIP,
  },
];

interface FallRuntime {
  readonly sprite: Sprite;
  readonly bank: FrameBank;
  frame: number;
}

function bakeFall(spec: FallSpec, index: number): { bank: FrameBank; x: number; y: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < spec.body.length; i += 2) {
    minX = Math.min(minX, spec.body[i]!);
    maxX = Math.max(maxX, spec.body[i]!);
    minY = Math.min(minY, spec.body[i + 1]!);
    maxY = Math.max(maxY, spec.body[i + 1]!);
  }
  const x0 = even(minX);
  const y0 = even(minY);
  const cellsW = Math.ceil((maxX - x0) / 2);
  const cellsH = Math.ceil((maxY - y0) / 2);
  const cover = new Uint8Array(cellsW * cellsH);
  for (let cy = 0; cy < cellsH; cy++) {
    for (let cx = 0; cx < cellsW; cx++) {
      if (pointInPolygon(spec.body, x0 + cx * 2 + 1, y0 + cy * 2 + 1)) cover[cy * cellsW + cx] = 1;
    }
  }
  // One streak pattern per source column; pattern length = loop length in
  // cells, so a column scrolls exactly one pattern per loop (90-140 px/s).
  const periods: number[] = [];
  const patterns: Uint8Array[] = [];
  for (let col = 0; col < cellsW; col++) {
    const period = FALL_PERIOD_MIN + 6 * Math.floor(u01(hash3(index + 1, col, 0x51)) * FALL_PERIOD_STEPS);
    const pattern = new Uint8Array(period);
    let at = Math.floor(u01(hash3(index + 1, col, 0x52)) * period);
    let used = 0;
    let segment = 0;
    while (used < period) {
      const gap = 3 + Math.floor(u01(hash3(index + 1, col, 0x100 + segment * 2)) * 10);
      const length = 4 + Math.floor(u01(hash3(index + 1, col, 0x101 + segment * 2)) * 7);
      used += gap + length;
      at += gap;
      const body = u01(hash3(index + 1, col, 0x300 + segment)) < 0.5 ? 1 : 2;
      for (let j = 0; j < length; j++) {
        const idx = (at + j) % period;
        pattern[idx] = j >= length - 2 ? 3 : j === 0 ? 1 : body;
      }
      at += length;
      segment++;
    }
    periods.push(period);
    patterns.push(pattern);
  }
  const bank = bakeFrameBank(`greenvale.water.${spec.label}`, cellsW, cellsH, FALL_FRAMES, (put, frame) => {
    for (let cy = 0; cy < cellsH; cy++) {
      for (let cx = 0; cx < cellsW; cx++) {
        if (cover[cy * cellsW + cx] === 0) continue;
        let src = cx - Math.round(spec.slant * cy);
        src = ((src % cellsW) + cellsW) % cellsW;
        const period = periods[src]!;
        const shift = Math.floor((frame * period) / FALL_FRAMES);
        const value = patterns[src]![(((cy - shift) % period) + period) % period]!;
        if (value !== 0) put(cx, cy, FALL_COLS[value - 1]!);
      }
    }
  });
  return { bank, x: x0, y: y0 };
}

/**
 * Bake expanding ellipse bands: lower half-ellipse arcs ('arc', foam spreading
 * from a fall base) or full ellipses ('ring', basin ripples). Band cells are
 * those within `halfWidth` px of the ellipse (gradient distance), clipped to
 * `clip` and the lily pads; the outer fringe is pale cyan, the core white.
 */
function bakeWaves(
  label: string,
  mode: 'arc' | 'ring',
  cx: number,
  cy: number,
  rx0: number,
  rxMax: number,
  frames: number,
  clip: readonly number[],
  yScale: number,
  halfWidth: number,
): { bank: FrameBank; x: number; y: number } {
  const ryMax = Math.max(3, rxMax * yScale);
  const x0 = even(cx - rxMax - 4);
  const y0 = even(cy - (mode === 'ring' ? ryMax + 4 : 4));
  const cellsW = Math.ceil((even(cx + rxMax + 4) + 2 - x0) / 2);
  const cellsH = Math.ceil(((mode === 'ring' ? even(cy + ryMax + 4) : even(cy + ryMax + 6)) + 2 - y0) / 2);
  return {
    bank: bakeFrameBank(label, cellsW, cellsH, frames, (put, frame) => {
      const rx = rx0 + ((rxMax - rx0) * frame) / (frames - 1);
      const ry = Math.max(3, rx * yScale);
      for (let ccy = 0; ccy < cellsH; ccy++) {
        for (let ccx = 0; ccx < cellsW; ccx++) {
          const wx = x0 + ccx * 2 + 1;
          const wy = y0 + ccy * 2 + 1;
          const dx = wx - cx;
          const dy = wy - cy;
          if (mode === 'arc' && dy < -1) continue;
          const f = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) - 1;
          const grad = Math.hypot((2 * dx) / (rx * rx), (2 * dy) / (ry * ry));
          if (grad === 0) continue;
          const dist = f / grad;
          if (Math.abs(dist) > halfWidth) continue;
          if (!pointInPolygon(clip, wx, wy) || inLilyPad(wx, wy)) continue;
          if (u01(hash3(ccx, ccy, frame + 0x700)) < 0.1) continue;
          put(ccx, ccy, dist > halfWidth * 0.35 ? 0xdff6ff : 0xffffff);
        }
      }
    }),
    x: x0,
    y: y0,
  };
}

// ---------- ripple / foam / droplet slot records ---------------------------

interface RippleZone {
  readonly bit: number;
  readonly count: number;
  readonly dirX: number;
  readonly dirY: number;
}

// Flow directions: lower pond drifts east away from the falls, the upper pond
// drains south toward the bridge arch, the stream runs south-west from the arch.
const RIPPLE_ZONES: readonly RippleZone[] = [
  { bit: BIT_LOWER, count: 16, dirX: 0.99, dirY: 0.12 },
  { bit: BIT_UPPER, count: 14, dirX: -0.24, dirY: 0.97 },
  { bit: BIT_STREAM, count: 10, dirX: -0.36, dirY: 0.93 },
];

interface Ripple {
  readonly sprite: Sprite;
  readonly bit: number;
  readonly dirX: number;
  readonly dirY: number;
  readonly id: number;
  readonly life: number;
  readonly cycle: number;
  readonly phase: number;
  readonly minX: number;
  readonly minY: number;
  readonly spanX: number;
  readonly spanY: number;
  key: number;
  shown: boolean;
  x0: number;
  y0: number;
  len: number;
  vx: number;
  vy: number;
  cyan: boolean;
}

interface Foam {
  readonly sprite: Sprite;
  readonly bit: number;
  readonly cx: number;
  readonly id: number;
  readonly life: number;
  readonly cycle: number;
  readonly phase: number;
  readonly minX: number;
  readonly minY: number;
  readonly spanX: number;
  readonly spanY: number;
  key: number;
  shown: boolean;
  x0: number;
  y0: number;
  dx: number;
  dy: number;
  size: number;
  cyan: boolean;
}

interface Arc {
  readonly sprite: Sprite;
  readonly fall: number;
  readonly phase: number;
}

interface DropGroup {
  readonly sx: number;
  readonly sy: number;
  readonly vxMin: number;
  readonly vxMax: number;
  readonly vyMin: number;
  readonly vyMax: number;
  readonly yMin: number;
  readonly yMax: number;
}

// Spouts traced from the fountain art: upper-bowl lip sheets (x697, x731 at
// y191) fall into the two mid-bowl water patches; the mid-bowl lip sheets
// (x684, x746 at y225) fall into the basin.
const DROP_GROUPS: readonly DropGroup[] = [
  { sx: 697, sy: 191, vxMin: -22, vxMax: -8, vyMin: -62, vyMax: -40, yMin: 207, yMax: 216 },
  { sx: 731, sy: 191, vxMin: 8, vxMax: 22, vyMin: -62, vyMax: -40, yMin: 207, yMax: 216 },
  { sx: 684, sy: 225, vxMin: -34, vxMax: -10, vyMin: -58, vyMax: -34, yMin: 238, yMax: 256 },
  { sx: 746, sy: 225, vxMin: 10, vxMax: 34, vyMin: -58, vyMax: -34, yMin: 238, yMax: 256 },
];
const DROPS_PER_GROUP = 5;

interface Drop {
  readonly head: Sprite;
  readonly trails: readonly Sprite[];
  readonly group: DropGroup;
  readonly id: number;
  readonly cycle: number;
  readonly phase: number;
  key: number;
  shown: boolean;
  vx: number;
  vy: number;
  flight: number;
  landY: number;
}

interface Ring {
  readonly sprite: Sprite;
  readonly phase: number;
}

const RING_CENTERS: readonly number[] = [673, 247, 757, 247, 714, 261];
const RING_RX_MIN = 4;
const RING_RX_MAX = 26;

// ---------- public interface -------------------------------------------------

export interface WaterFlow {
  readonly root: Container;
  update(t: number, night: number): void;
  reset(): void;
  dispose(): void;
}

function makeCell(parent: Container, label: string): Sprite {
  const sprite = new Sprite({ texture: Texture.WHITE, label });
  sprite.eventMode = 'none';
  sprite.visible = false;
  parent.addChild(sprite);
  return sprite;
}

export function createWaterFlow(): WaterFlow {
  const root = new Container({ label: 'greenvale-effects.water.flow' });
  root.eventMode = 'none';
  root.interactiveChildren = false;
  const grid = buildZoneGrid();
  const banks: FrameBank[] = [];
  let disposed = false;

  const zoneAt = (x: number, y: number): number => {
    const cx = x >> 1;
    const cy = y >> 1;
    if (cx < 0 || cy < 0 || cx >= GRID_W || cy >= GRID_H) return 0;
    return grid[cy * GRID_W + cx]!;
  };
  /** True when every 2 px cell touched by the rect carries `bit`. */
  const rectInZone = (bit: number, x: number, y: number, w: number, h: number): boolean => {
    const x0 = Math.floor(x / 2) * 2;
    const y0 = Math.floor(y / 2) * 2;
    const x1 = Math.ceil((x + w) / 2) * 2;
    const y1 = Math.ceil((y + h) / 2) * 2;
    for (let yy = y0; yy < y1; yy += 2) {
      for (let xx = x0; xx < x1; xx += 2) if ((zoneAt(xx, yy) & bit) === 0) return false;
    }
    return true;
  };
  const zoneBox = (bit: number): [number, number, number, number] => {
    let minX = GRID_W;
    let maxX = -1;
    let minY = GRID_H;
    let maxY = -1;
    for (let cy = 0; cy < GRID_H; cy++) {
      for (let cx = 0; cx < GRID_W; cx++) {
        if ((grid[cy * GRID_W + cx]! & bit) === 0) continue;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
      }
    }
    return [minX * 2, minY * 2, (maxX - minX + 1) * 2, (maxY - minY + 1) * 2];
  };

  // ---- ripples (underneath everything else) -------------------------------
  const ripples: Ripple[] = [];
  {
    let id = 0;
    for (const zone of RIPPLE_ZONES) {
      const [bx, by, bw, bh] = zoneBox(zone.bit);
      for (let i = 0; i < zone.count; i++, id++) {
        const life = 1.6 + u01(hash3(id, 0xa1, 1)) * 1.2;
        const cycle = life + u01(hash3(id, 0xa2, 1)) * 0.2;
        ripples.push({
          sprite: makeCell(root, 'greenvale-effects.water.ripple'),
          bit: zone.bit, dirX: zone.dirX, dirY: zone.dirY, id, life, cycle,
          phase: u01(hash3(id, 0xa3, 1)) * cycle,
          minX: bx, minY: by, spanX: bw, spanY: bh,
          key: -1, shown: false, x0: 0, y0: 0, len: 6, vx: 0, vy: 0, cyan: false,
        });
      }
    }
  }

  // ---- falls --------------------------------------------------------------
  const falls: FallRuntime[] = [];
  for (let i = 0; i < FALLS.length; i++) {
    const spec = FALLS[i]!;
    const baked = bakeFall(spec, i);
    banks.push(baked.bank);
    const sprite = new Sprite({ texture: baked.bank.textures[0]!, label: `greenvale-effects.water.${spec.label}` });
    sprite.position.set(baked.x, baked.y);
    sprite.alpha = FALL_ALPHA;
    sprite.eventMode = 'none';
    root.addChild(sprite);
    falls.push({ sprite, bank: baked.bank, frame: 0 });
  }

  // ---- foam cells ---------------------------------------------------------
  const foams: Foam[] = [];
  {
    let id = 0;
    for (const spec of FALLS) {
      const [bx, by, bw, bh] = zoneBox(spec.foamBit);
      for (let i = 0; i < FOAM_PER_FALL; i++, id++) {
        const life = 0.9 + u01(hash3(id, 0xb1, 2)) * 0.7;
        const cycle = life + u01(hash3(id, 0xb2, 2)) * 0.4;
        foams.push({
          sprite: makeCell(root, 'greenvale-effects.water.foam'),
          bit: spec.foamBit, cx: spec.foamCx, id, life, cycle,
          phase: u01(hash3(id, 0xb3, 2)) * cycle,
          minX: bx, minY: by, spanX: bw, spanY: bh,
          key: -1, shown: false, x0: 0, y0: 0, dx: 0, dy: 0, size: 2, cyan: false,
        });
      }
    }
  }

  // ---- foam arcs (baked expanding frames) -----------------------------------
  const arcBanks: FrameBank[] = [];
  const arcOrigins: Array<[number, number]> = [];
  for (let i = 0; i < FALLS.length; i++) {
    const spec = FALLS[i]!;
    const baked = bakeWaves(`greenvale.water.${spec.label}.arc`, 'arc', spec.arcCx, spec.arcCy, spec.arcRx0, spec.arcRxMax,
      ARC_FRAMES, spec.arcClip, 0.3, 2.0);
    banks.push(baked.bank);
    arcBanks.push(baked.bank);
    arcOrigins.push([baked.x, baked.y]);
  }
  const arcs: Arc[] = [];
  for (let i = 0; i < FALLS.length; i++) {
    for (let j = 0; j < ARCS_PER_FALL; j++) {
      const sprite = new Sprite({ texture: arcBanks[i]!.textures[0]!, label: 'greenvale-effects.water.arc' });
      sprite.position.set(arcOrigins[i]![0], arcOrigins[i]![1]);
      sprite.eventMode = 'none';
      sprite.visible = false;
      root.addChild(sprite);
      arcs.push({ sprite, fall: i, phase: j / ARCS_PER_FALL + i * 0.17 });
    }
  }

  // ---- fountain: droplets + basin rings -------------------------------------
  const drops: Drop[] = [];
  {
    let id = 0;
    for (const group of DROP_GROUPS) {
      for (let i = 0; i < DROPS_PER_GROUP; i++, id++) {
        const cycle = 0.9 + u01(hash3(id, 0xc1, 3)) * 0.25;
        drops.push({
          head: makeCell(root, 'greenvale-effects.water.drop'),
          trails: [
            makeCell(root, 'greenvale-effects.water.drop-trail'),
            makeCell(root, 'greenvale-effects.water.drop-trail'),
            makeCell(root, 'greenvale-effects.water.drop-trail'),
          ],
          group, id, cycle,
          phase: u01(hash3(id, 0xc2, 3)) * cycle,
          key: -1, shown: false, vx: 0, vy: 0, flight: 0, landY: 0,
        });
      }
    }
  }
  const ringBank: FrameBank[] = [];
  const rings: Ring[] = [];
  for (let i = 0; i < RING_CENTERS.length; i += 2) {
    const cx = RING_CENTERS[i]!;
    const cy = RING_CENTERS[i + 1]!;
    const baked = bakeWaves(`greenvale.water.fountain-ring-${i / 2}`, 'ring', cx, cy, RING_RX_MIN, RING_RX_MAX, RING_FRAMES,
      FOUNTAIN_BASIN, 0.42, 1.2);
    banks.push(baked.bank);
    ringBank.push(baked.bank);
    const sprite = new Sprite({ texture: baked.bank.textures[0]!, label: 'greenvale-effects.water.ring' });
    sprite.position.set(baked.x, baked.y);
    sprite.eventMode = 'none';
    sprite.visible = false;
    root.addChild(sprite);
    rings.push({ sprite, phase: (i / 2) * 0.47 });
  }

  // ---- per-cycle placement (pure functions of slot id + cycle index) -------
  function placeRipple(r: Ripple, k: number): void {
    r.shown = false;
    for (let a = 0; a < RIPPLE_ATTEMPTS; a++) {
      const h = hash3(r.id * 977 + 13, k, a);
      const len = 6 + 2 * Math.floor(u01(hash3(r.id, k, 0x40 + a)) * 6);
      const speed = 18 + 12 * u01(hash3(r.id, k, 0x80 + a));
      const x = even(r.minX + u01(h) * r.spanX);
      const y = even(r.minY + u01(hash3(r.id, k, 0xc0 + a)) * r.spanY);
      const vx = r.dirX * speed;
      const vy = r.dirY * speed;
      let ok = true;
      for (let s = 0; s <= 4 && ok; s++) {
        const age = (r.life * s) / 4;
        ok = rectInZone(r.bit, x + vx * age - 2, y + vy * age - 2, len + 4, 6);
      }
      if (!ok) continue;
      r.x0 = x;
      r.y0 = y;
      r.len = len;
      r.vx = vx;
      r.vy = vy;
      r.cyan = u01(hash3(r.id, k, 0xf0 + a)) < 0.45;
      r.shown = true;
      return;
    }
  }

  function placeFoam(f: Foam, k: number): void {
    f.shown = false;
    for (let a = 0; a < RIPPLE_ATTEMPTS; a++) {
      const size = u01(hash3(f.id, k, 0x41 + a)) < 0.6 ? 2 : 4;
      const x = even(f.minX + u01(hash3(f.id * 311 + 5, k, a)) * f.spanX);
      const y = even(f.minY + u01(hash3(f.id, k, 0x81 + a)) * f.spanY);
      const dx = (x - f.cx) * 0.22;
      const dy = -(6 + 8 * u01(hash3(f.id, k, 0xc1 + a)));
      let ok = true;
      for (let s = 0; s <= 2 && ok; s++) ok = rectInZone(f.bit, x + (dx * s) / 2, y + (dy * s) / 2, size, size);
      if (!ok) continue;
      f.x0 = x;
      f.y0 = y;
      f.dx = dx;
      f.dy = dy;
      f.size = size;
      f.cyan = u01(hash3(f.id, k, 0xf1 + a)) < 0.4;
      f.shown = true;
      return;
    }
  }

  function placeDrop(d: Drop, k: number): void {
    d.shown = false;
    const g = d.group;
    for (let a = 0; a < RIPPLE_ATTEMPTS; a++) {
      const vx = g.vxMin + (g.vxMax - g.vxMin) * u01(hash3(d.id, k, 0x21 + a));
      const vy = g.vyMin + (g.vyMax - g.vyMin) * u01(hash3(d.id, k, 0x61 + a));
      const landY = g.yMin + (g.yMax - g.yMin) * u01(hash3(d.id, k, 0xa1 + a));
      const flight = (-vy + Math.sqrt(vy * vy + 2 * DROP_GRAVITY * (landY - g.sy))) / DROP_GRAVITY;
      if (flight + DROP_SPLASH > d.cycle) continue;
      const landX = g.sx + vx * flight;
      if (!rectInZone(BIT_FOUNTAIN, landX - 2, even(landY) - 2, 4, 4)) continue;
      d.vx = vx;
      d.vy = vy;
      d.flight = flight;
      d.landY = landY;
      d.shown = true;
      return;
    }
  }

  // ---- update ---------------------------------------------------------------
  function render(t: number, night: number): void {
    const n = clamp01(night);
    const alphaK = 1 - NIGHT_DIM * n;
    const tintWhite = lerpColor(0xffffff, COOL, n);
    const tintCyan = lerpColor(0xbfefff, COOL, n);
    const tintPale = lerpColor(0xdff6ff, COOL, n);

    for (let i = 0; i < ripples.length; i++) {
      const r = ripples[i]!;
      const s = r.sprite;
      const clock = t + r.phase + CLOCK_SKEW;
      const k = Math.floor(clock / r.cycle);
      if (k !== r.key) {
        r.key = k;
        placeRipple(r, k);
      }
      const age = clock - k * r.cycle;
      if (!r.shown || age >= r.life) {
        s.visible = false;
        continue;
      }
      const p = age / r.life;
      const env = Math.min(1, p / 0.22, (1 - p) / 0.3);
      s.visible = true;
      s.position.set(even(r.x0 + r.vx * age), even(r.y0 + r.vy * age));
      s.scale.set(r.len, 2);
      s.tint = r.cyan ? tintCyan : tintWhite;
      s.alpha = RIPPLE_ALPHA * env * alphaK;
    }

    const frame = Math.floor(t * FALL_FPS + PHASE_EPS) % FALL_FRAMES;
    for (let i = 0; i < falls.length; i++) {
      const f = falls[i]!;
      if (f.frame !== frame) {
        f.frame = frame;
        f.sprite.texture = f.bank.textures[frame]!;
      }
      f.sprite.tint = tintWhite;
      f.sprite.alpha = FALL_ALPHA * alphaK;
    }

    for (let i = 0; i < foams.length; i++) {
      const f = foams[i]!;
      const s = f.sprite;
      const clock = t + f.phase + CLOCK_SKEW;
      const k = Math.floor(clock / f.cycle);
      if (k !== f.key) {
        f.key = k;
        placeFoam(f, k);
      }
      const age = clock - k * f.cycle;
      if (!f.shown || age >= f.life) {
        s.visible = false;
        continue;
      }
      const p = age / f.life;
      const env = Math.min(1, p / 0.2, (1 - p) / 0.5);
      s.visible = true;
      s.position.set(even(f.x0 + f.dx * p), even(f.y0 + f.dy * p));
      s.scale.set(f.size, f.size);
      s.tint = f.cyan ? tintPale : tintWhite;
      s.alpha = FOAM_ALPHA * env * alphaK;
    }

    for (let i = 0; i < arcs.length; i++) {
      const a = arcs[i]!;
      const cyc = (t + CLOCK_SKEW) / ARC_PERIOD + a.phase;
      const p = cyc - Math.floor(cyc);
      const bank = arcBanks[a.fall]!;
      const s = a.sprite;
      s.visible = true;
      s.texture = bank.textures[Math.min(ARC_FRAMES - 1, Math.floor(p * ARC_FRAMES))]!;
      s.tint = tintWhite;
      s.alpha = ARC_ALPHA * Math.min(1, p / 0.12) * (1 - 0.7 * p) * alphaK;
    }

    for (let i = 0; i < drops.length; i++) {
      const d = drops[i]!;
      const clock = t + d.phase + CLOCK_SKEW;
      const k = Math.floor(clock / d.cycle);
      if (k !== d.key) {
        d.key = k;
        placeDrop(d, k);
      }
      const u = clock - k * d.cycle;
      const trails = d.trails;
      if (!d.shown || u >= d.flight + DROP_SPLASH) {
        d.head.visible = false;
        for (let j = 0; j < trails.length; j++) trails[j]!.visible = false;
        continue;
      }
      const g = d.group;
      d.head.visible = true;
      if (u < d.flight) {
        d.head.position.set(even(g.sx + d.vx * u), even(g.sy + d.vy * u + 0.5 * DROP_GRAVITY * u * u));
        d.head.scale.set(2, 2);
        d.head.tint = tintWhite;
        d.head.alpha = DROP_ALPHA * Math.min(1, u / 0.05) * alphaK;
        for (let j = 0; j < trails.length; j++) {
          const tail = trails[j]!;
          const tu = u - DROP_TRAIL_STEP * (j + 1);
          tail.visible = tu > 0;
          if (tu <= 0) continue;
          tail.position.set(even(g.sx + d.vx * tu), even(g.sy + d.vy * tu + 0.5 * DROP_GRAVITY * tu * tu));
          tail.scale.set(2, 2);
          tail.tint = tintCyan;
          tail.alpha = (0.85 - 0.25 * j) * alphaK;
        }
      } else {
        const p = (u - d.flight) / DROP_SPLASH;
        for (let j = 0; j < trails.length; j++) trails[j]!.visible = false;
        d.head.position.set(even(g.sx + d.vx * d.flight) - 2, even(d.landY));
        d.head.scale.set(4, 2);
        d.head.tint = tintPale;
        d.head.alpha = DROP_ALPHA * (1 - p) * alphaK;
      }
    }

    for (let i = 0; i < rings.length; i++) {
      const ring = rings[i]!;
      const cyc = (t + CLOCK_SKEW) / RING_PERIOD + ring.phase;
      const p = cyc - Math.floor(cyc);
      const s = ring.sprite;
      s.visible = true;
      s.texture = ringBank[i]!.textures[Math.min(RING_FRAMES - 1, Math.floor(p * RING_FRAMES))]!;
      s.tint = tintWhite;
      s.alpha = RING_ALPHA * Math.min(1, p / 0.1) * (1 - p) * alphaK;
    }
  }

  function update(t: number, night: number): void {
    if (disposed) return;
    render(t, night);
  }

  function reset(): void {
    if (disposed) return;
    for (const r of ripples) r.key = -1;
    for (const f of foams) f.key = -1;
    for (const d of drops) d.key = -1;
    for (const f of falls) f.frame = -1;
    render(0, 0);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    root.destroy({ children: true });
    for (const bank of banks) bank.destroy();
  }

  render(0, 0);
  return { root, update, reset, dispose };
}
