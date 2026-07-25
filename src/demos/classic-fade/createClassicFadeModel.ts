/**
 * Classic Knife | Fade (Minimal Wear) — procedural CS2 reconstruction.
 *
 * Route: reference-projection.  Exactness tier: image-only.
 *
 * Geometry is the alpha trace of the two supplied broadside references (`geo.json`,
 * produced by the img2threejs intake stage): the 6-notch spine jimping, the deep
 * semicircular choil, the hammer-head guard, the 5-step staircase butt and the
 * drop-point tip are all real silhouette samples, not hand-drawn curves.
 *
 * The Fade finish is NOT a procedural gradient. Each broad face carries the de-lit
 * reference crop for that side, projected through one shared planar UV map so every
 * painted detail — gradient stops, the wavy lower-zone boundary, the grind tonal
 * break, the screws, the gold ferrule — lands exactly where the reference has it.
 * Roughness / metalness / AO / normal are separate authored channels; none of them
 * is derived from albedo.
 *
 * Frame: +X = tip, +Y = spine, Z = thickness.
 *   +Z face = FRONT reference (blade points RIGHT; a camera on +Z reproduces it)
 *   -Z face = BACK  reference (blade points LEFT)
 *
 * Z thickness is INFERRED (confidence 0.45): both supplied views are broadside and
 * neither resolves depth. See geo.thickness.basis.
 *
 * Structure — every part is a solid, not a picture on a plate:
 *   - a through-tang runs the length of the handle and the furniture is nested on it,
 *     so `attachment.parentSocket = 'tang'` resolves to a real object;
 *   - cross-sections roll over a FINITE-radius edge instead of feathering to zero
 *     thickness, and the rim is welded to the faces so the roll shades smoothly;
 *   - screws, the lanyard bore, the ferrule beads and the quilt are real geometry at
 *     the coordinates measured in `geo.features`, not just albedo and normal maps.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import geo from './geo.json';
// Imported as Vite assets rather than served from public/, so the whole demo — geometry,
// projection textures and factory — lives in this one folder and the URLs are bundler-resolved.
import frontAlbedoUrl from './front-albedo.png';
import backAlbedoUrl from './back-albedo.png';
import roughnessUrl from './roughness.png';
import metalnessUrl from './metalness.png';
import aoUrl from './ao.png';
import normalUrl from './normal.png';

export interface ClassicFadeOptions {
  shadows?: boolean;
}

type Row = [number, number, number]; // [worldX, yTop, yBot]
type Outline = Row[];

/** Texture crop bounds in world units — the shared planar UV frame for every part. */
const UV = (() => {
  const { scale, xc, yc, textureCrop: c } = geo.meta;
  return {
    x0: (c.x0 - xc) * scale,
    x1: (c.x1 - xc) * scale,
    y1: (yc - c.y0) * scale, // image top row -> larger world Y
    y0: (yc - c.y1) * scale,
  };
})();

function planarUV(x: number, y: number): [number, number] {
  return [(x - UV.x0) / (UV.x1 - UV.x0), (y - UV.y0) / (UV.y1 - UV.y0)];
}

// ---------------------------------------------------------------- outline conditioning
/**
 * Moving average over the traced top/bottom edges. The raw trace carries ±1px sampling
 * noise; because the grind ramps z as a function of the row spacing, that noise showed up
 * as per-column normal jitter (σ of the face normal's z rose 0 → 0.11 from spine to edge)
 * and rendered as dense vertical striping down the blade. Window 3 removes the noise and
 * still preserves the 6 jimping notches, which are ~7 columns wide and 0.02 deep.
 */
function smoothOutline(o: Outline, win: number): Outline {
  const n = o.length;
  const h = (win - 1) >> 1;
  return o.map((row, i) => {
    if (i < h || i >= n - h) return [row[0], row[1], row[2]] as Row;
    let sT = 0;
    let sB = 0;
    for (let k = -h; k <= h; k++) {
      sT += o[i + k][1];
      sB += o[i + k][2];
    }
    return [row[0], sT / win, sB / win] as Row;
  });
}

/**
 * Ramer–Douglas–Peucker: keep the columns that actually carry shape.
 *
 * Uniform decimation (e.g. 648 → 160 columns) would have destroyed the jimping — at a
 * 0.058 pitch that leaves 3.6 columns per scallop. RDP instead keeps columns where the
 * outline deviates and drops them along the long straight runs, so the notches, the choil
 * and the staircase survive by construction while the flat spans get cheap.
 */
function rdpKeep(pts: [number, number][], eps: number): Set<number> {
  const keep = new Set<number>([0, pts.length - 1]);
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1e-9;
    let best = -1;
    let bestD = 0;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len;
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (bestD > eps && best > 0) {
      keep.add(best);
      stack.push([a, best], [best, b]);
    }
  }
  return keep;
}

/**
 * Smooth, then RDP-decimate on the union of the two edges' kept columns.
 *
 * `protect` lists x spans that are exempt from BOTH steps. The jimping needs it: window-3
 * smoothing rounds a 6-column scallop noticeably, and even RDP turns the run of scallops
 * into a zigzag once it is allowed to pick its own corners. Inside a protected span every
 * traced column survives verbatim.
 */
function conditionOutline(
  o: Outline,
  eps: number,
  protect: [number, number][] = [],
  win = 3,
): Outline {
  const inProtected = (x: number) => protect.some(([a, b]) => x >= a && x <= b);
  const s = smoothOutline(o, win).map((r, i) => (inProtected(o[i][0]) ? o[i] : r));
  const top = rdpKeep(s.map((r) => [r[0], r[1]] as [number, number]), eps);
  const bot = rdpKeep(s.map((r) => [r[0], r[2]] as [number, number]), eps);
  const keep = new Set([...top, ...bot]);
  s.forEach((r, i) => { if (inProtected(r[0])) keep.add(i); });
  return [...keep].sort((a, b) => a - b).map((i) => s[i]);
}

/** x span covering the 6 spine scallops, from their measured centres plus a half pitch. */
const JIMPING_SPAN: [number, number] = (() => {
  const j = geo.features.jimping;
  const { scale, xc } = geo.meta;
  const pad = j.pitchPx * 0.75;
  return [
    (j.centresPx[0] - pad - xc) * scale,
    (j.centresPx[j.centresPx.length - 1] + pad - xc) * scale,
  ];
})();

/**
 * A tenon: extend a part past its traced end so it genuinely interpenetrates its
 * neighbour instead of butting against it. Inset in Y, so the stub stays strictly inside
 * the neighbour's silhouette and cannot change silhouette IoU. Interior joinery is
 * inferred — neither reference shows inside the handle.
 */
function tenon(o: Outline, len: number, inset: number, atStart: boolean): Outline {
  if (len <= 0) return o;
  const src = atStart ? o[0] : o[o.length - 1];
  const dir = atStart ? -1 : 1;
  const steps = 2;
  const stub: Outline = [];
  for (let i = 1; i <= steps; i++) {
    const f = i / steps;
    stub.push([src[0] + dir * len * f, src[1] - inset, src[2] + inset] as Row);
  }
  return atStart ? [...stub.reverse(), ...o] : [...o, ...stub];
}

// ---------------------------------------------------------------- z cross-sections
/**
 * Half-thickness across a wedge-ground blade. `t` is 0 at the spine and 1 at the cutting
 * edge; `xf` is 0 at the ricasso and 1 at the tip.
 *
 * Two changes from the flat-plate version: the spine now rolls over a finite radius
 * instead of ending in a full-thickness 90° band (which read as a stack of laminations),
 * and the whole section carries a distal taper so the tip is thinner than the ricasso.
 */
function bladeZ(t: number, xf: number, ht: number): number {
  const h = ht * (1 - geo.thickness.bladeDistalTaper * xf * xf);
  const g = geo.features.grind;
  const c = geo.chamfer;
  const gs = g.startFracAtRicasso + (g.startFracAtTip - g.startFracAtRicasso) * xf;
  const eb = g.edgeBevelFrac;
  const sr = c.bladeSpineRollFrac;
  if (t < sr) {
    const k = 1 - t / sr; // 1 at the spine outline, 0 where the roll meets the face
    return h * (c.bladeSpineEdgeFrac +
      (1 - c.bladeSpineEdgeFrac) * Math.sqrt(Math.max(0, 1 - k * k)));
  }
  if (t < gs) return h * (1 - 0.12 * (t - sr) / Math.max(gs - sr, 1e-4));
  if (t < eb) return h * (0.88 - 0.74 * (t - gs) / Math.max(eb - gs, 1e-4));
  return h * (0.14 - 0.115 * (t - eb) / Math.max(1 - eb, 1e-4));
}

/**
 * Furniture cross-section: a flat broad face that rolls over a finite-radius edge and
 * still has real thickness AT the outline.
 *
 * The previous superellipse returned exactly 0 at t=0 and t=1, so every handle part
 * feathered to a zero-thickness knife edge along its entire outline. That is why the
 * guard and bolsters read as bent sheet metal the moment the camera left the broadside.
 */
function slabZ(t: number, ht: number): number {
  const c = geo.chamfer;
  const d = Math.min(t, 1 - t) / c.handleRollFrac;
  if (d >= 1) return ht;
  const k = 1 - d;
  return ht * (c.handleEdgeFrac +
    (1 - c.handleEdgeFrac) * Math.sqrt(Math.max(0, 1 - k * k)));
}

/**
 * Row parameter with cosine grading, so samples bunch up at t=0 and t=1 where the
 * edge roll lives. One of the graded rows lands near 0.92 of half-thickness — that ring
 * is the chamfer facet, and because it is just another row of the same grid its vertices
 * are shared and `computeVertexNormals` shades across it smoothly.
 */
function gradedT(r: number, rows: number): number {
  return 0.5 - 0.5 * Math.cos(Math.PI * (r / rows));
}

// ---------------------------------------------------------------- lofted solid
/**
 * Loft an outline into a WELDED solid: +Z face (group 0), -Z face (group 1), rim (group 2).
 *
 * The rim reuses the face grids' boundary vertices rather than duplicating them, so the
 * face → roll → rim transition shares normals and reads as one rolled edge instead of a
 * hard 90° crease. Both broad faces share the global planar UV map, so the projected
 * reference pixels register with the traced geometry automatically.
 */
function loft(
  outline: Outline,
  zAt: (t: number, xf: number) => number,
  rows: number,
): THREE.BufferGeometry {
  const cols = outline.length;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const groups: { start: number; count: number; mat: number }[] = [];

  const x0 = outline[0][0];
  const x1 = outline[cols - 1][0];
  const span = Math.max(x1 - x0, 1e-6);
  const faceVerts = cols * (rows + 1);
  const at = (side: number, c: number, r: number) => side * faceVerts + c * (rows + 1) + r;

  for (let side = 0; side < 2; side++) {
    const sign = side === 0 ? 1 : -1;
    for (let c = 0; c < cols; c++) {
      const [x, yT, yB] = outline[c];
      const xf = (x - x0) / span;
      for (let r = 0; r <= rows; r++) {
        const t = gradedT(r, rows);
        const y = yT + (yB - yT) * t;
        pos.push(x, y, sign * zAt(t, xf));
        const [u, v] = planarUV(x, y);
        uv.push(u, v);
      }
    }
  }

  // ---- broad faces ----
  for (let side = 0; side < 2; side++) {
    const start = idx.length;
    for (let c = 0; c < cols - 1; c++) {
      for (let r = 0; r < rows; r++) {
        const a = at(side, c, r);
        const b = at(side, c + 1, r);
        // Grid runs +x across columns and -y down rows, so (a, a+1, b) yields +Z and the
        // reverse order yields -Z.
        if (side === 0) idx.push(a, a + 1, b, b, a + 1, b + 1);
        else idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    groups.push({ start, count: idx.length - start, mat: side });
  }

  // ---- rim: welded to the face boundary rows, closing the solid on all four sides ----
  const rimStart = idx.length;
  for (let c = 0; c < cols - 1; c++) {
    // spine edge (r = 0), outward +Y
    const p0 = at(0, c, 0);
    const p1 = at(0, c + 1, 0);
    const m0 = at(1, c, 0);
    const m1 = at(1, c + 1, 0);
    idx.push(p0, p1, m0, p1, m1, m0);
    // cutting/bottom edge (r = rows), outward -Y
    const q0 = at(0, c, rows);
    const q1 = at(0, c + 1, rows);
    const n0 = at(1, c, rows);
    const n1 = at(1, c + 1, rows);
    idx.push(q0, n0, q1, q1, n0, n1);
  }
  for (let r = 0; r < rows; r++) {
    // butt end cap (c = 0), outward -X
    const a0 = at(0, 0, r);
    const a1 = at(0, 0, r + 1);
    const b0 = at(1, 0, r);
    const b1 = at(1, 0, r + 1);
    idx.push(a0, b0, a1, b0, b1, a1);
    // tip end cap (c = cols-1), outward +X
    const c0 = at(0, cols - 1, r);
    const c1 = at(0, cols - 1, r + 1);
    const d0 = at(1, cols - 1, r);
    const d1 = at(1, cols - 1, r + 1);
    idx.push(c0, c1, d0, d0, c1, d1);
  }
  groups.push({ start: rimStart, count: idx.length - rimStart, mat: 2 });

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  for (const gr of groups) g.addGroup(gr.start, gr.count, gr.mat);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------- textures
function projected(url: string, srgb: boolean): THREE.Texture {
  const t = new THREE.TextureLoader().load(url);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 16;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Fine axial brush/grain, used as the rim's own normal so rims are not mirror-flat. */
function brushedNormal(): THREE.CanvasTexture {
  const w = 512;
  const h = 128;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const c = cv.getContext('2d')!;
  const img = c.createImageData(w, h);
  let seed = 20260725;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const lanes = new Float32Array(h);
  for (let y = 0; y < h; y++) lanes[y] = rnd();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const n = (lanes[y] - 0.5) * 0.6 + (rnd() - 0.5) * 0.12;
      const i = (y * w + x) * 4;
      img.data[i] = 128 + n * 40;
      img.data[i + 1] = 128;
      img.data[i + 2] = 255;
      img.data[i + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(8, 1);
  return t;
}

interface Maps {
  front: THREE.Texture;
  back: THREE.Texture;
  rough: THREE.Texture;
  metal: THREE.Texture;
  ao: THREE.Texture;
  normal: THREE.Texture;
  rimNormal: THREE.CanvasTexture;
}

function loadMaps(): Maps {
  return {
    front: projected(frontAlbedoUrl, true),
    back: projected(backAlbedoUrl, true),
    rough: projected(roughnessUrl, false),
    metal: projected(metalnessUrl, false),
    ao: projected(aoUrl, false),
    normal: projected(normalUrl, false),
    rimNormal: brushedNormal(),
  };
}

/**
 * Broad-face material. `map` is the de-lit projection for that side; every other
 * channel comes from its own authored texture — albedo is never reused.
 *
 * `metalness`/`roughness` are scalars that MULTIPLY the zone maps, which hold absolute
 * per-zone values (metalness 1.0 on every steel zone and 0.047 on the grip; roughness
 * 0.166 on the blade, 0.718 on the grip). Roughness is therefore left at 1.0 so the map
 * owns it outright. Metalness is the one scalar that is genuinely tuned: 0.45 on the steel
 * parts, solved against the reference rather than guessed.
 *
 * The previous build used 0.14, which made the anodized blade nearly dielectric — the Fade
 * moved only 2.6% in luma across a 45° incidence swing and read as a printed decal. Pushing
 * it to the map's full 1.0 went too far the other way (metals have no diffuse term, so the
 * blade went to half the reference's brightness at 1.53x its saturation). 0.45 keeps a
 * diffuse base carrying the Fade plus a real specular layer: luma 63.33 against the
 * reference's 63.39, and 9.0% luma swing across the same orbit.
 *
 * There is deliberately no `envMapIntensity` here. It was measured to be a complete no-op
 * for these materials in this three.js version (identical output at 0, 3 and 10 with the
 * lamps off) because the IBL arrives via `scene.environment`; the real exposure control is
 * `scene.environmentIntensity`, which the registry entry owns.
 */
function faceMaterial(m: Maps, side: 'front' | 'back', p: PartSpec): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    map: side === 'front' ? m.front : m.back,
    roughnessMap: m.rough,
    metalnessMap: m.metal,
    aoMap: m.ao,
    aoMapIntensity: 0.6,
    normalMap: m.normal,
    normalScale: new THREE.Vector2(p.normalScale, p.normalScale),
    metalness: p.metalness,
    roughness: p.roughness,
    clearcoat: p.clearcoat,
    clearcoatRoughness: 0.3,
    // No alphaTest: the mesh IS the traced silhouette and the albedo's colour is dilated
    // past the mask, so there is nothing to cut out and nothing to fringe.
  });
}

/**
 * Rolled-edge material. Neither reference resolves the edge band, so it is authored
 * rather than projected — real metal, but darker and rougher than the polished faces so
 * it does not read as a bright outline tracing the whole silhouette.
 */
function rimMaterial(rim: RimFinish, m: Maps): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: rim.color,
    roughness: rim.roughness,
    metalness: rim.metalness,
    normalMap: m.rimNormal,
    normalScale: new THREE.Vector2(0.25, 0.25),
  });
}

// ---------------------------------------------------------------- part table
/** Finish for the rolled edge band, which neither reference resolves. */
interface RimFinish {
  color: number;
  roughness: number;
  metalness: number;
}

interface PartSpec {
  id: string;
  ht: number;
  rim: RimFinish;
  z: (t: number, xf: number, ht: number) => number;
  normalScale: number;
  /** scalars multiplying the zone maps — see faceMaterial */
  metalness: number;
  roughness: number;
  /** anodized lacquer only; the polymer grip gets none */
  clearcoat: number;
  /** RDP tolerance in world units; the blade carries the fine spine detail */
  eps: number;
  rows: number;
  /** tenon length added at the butt-facing / tip-facing end */
  tenon: [number, number];
}

const STEEL: RimFinish = { color: 0x8a8f96, roughness: 0.34, metalness: 1.0 };
const DARK: RimFinish = { color: 0x3d434b, roughness: 0.44, metalness: 1.0 };
const J = geo.joinery.tenonLength;
/**
 * Metalness scalar for the steel zones, solved against the reference's own luma and
 * saturation (see faceMaterial). The grip keeps 1.0 because its map already carries 0.047.
 */
const STEEL_METAL = 0.45;

const PARTS: PartSpec[] = [
  {
    id: 'blade', ht: geo.thickness.blade, rim: STEEL,
    z: bladeZ, normalScale: 0.35,
    metalness: STEEL_METAL, roughness: 1.0, clearcoat: 0.3,
    eps: 0.0011, rows: 20, tenon: [0, 0],
  },
  {
    id: 'guard', ht: geo.thickness.guard, rim: DARK,
    z: (t, _x, ht) => slabZ(t, ht), normalScale: 0.5,
    metalness: STEEL_METAL, roughness: 1.0, clearcoat: 0.06,
    eps: 0.0016, rows: 16, tenon: [J.default, 0],
  },
  {
    id: 'ferrule', ht: geo.thickness.ferrule, rim: { ...DARK, color: 0x4a4133, roughness: 0.4 },
    z: (t, _x, ht) => slabZ(t, ht), normalScale: 1.15,
    metalness: STEEL_METAL, roughness: 0.95, clearcoat: 0.05,
    eps: 0.0016, rows: 16, tenon: [J.default, J.default],
  },
  {
    id: 'foreBolster', ht: geo.thickness.foreBolster, rim: DARK,
    z: (t, _x, ht) => slabZ(t, ht), normalScale: 0.8,
    metalness: STEEL_METAL, roughness: 1.0, clearcoat: 0.06,
    eps: 0.0016, rows: 16, tenon: [J.default, J.default],
  },
  {
    id: 'grip', ht: geo.thickness.grip, rim: { color: 0x1a1c1f, roughness: 0.86, metalness: 0.1 },
    z: (t, _x, ht) => slabZ(t, ht), normalScale: 0.95,
    metalness: 1.0, roughness: 1.0, clearcoat: 0.0,
    eps: 0.0018, rows: 16, tenon: [J.grip, J.grip],
  },
  {
    id: 'rearBolster', ht: geo.thickness.rearBolster, rim: DARK,
    z: (t, _x, ht) => slabZ(t, ht), normalScale: 0.8,
    metalness: STEEL_METAL, roughness: 1.0, clearcoat: 0.06,
    eps: 0.0016, rows: 16, tenon: [J.default, J.default],
  },
  {
    id: 'buttPlate', ht: geo.thickness.buttPlate, rim: { ...DARK, color: 0x3a3f45 },
    z: (t, _x, ht) => slabZ(t, ht), normalScale: 0.7,
    metalness: STEEL_METAL, roughness: 1.0, clearcoat: 0.06,
    eps: 0.0016, rows: 16, tenon: [0, J.default],
  },
];

// ---------------------------------------------------------------- cross-section sampling
/** Interpolate a conditioned outline's top/bottom edge at an arbitrary x. */
function edgeAt(o: Outline, x: number): [number, number] {
  if (x <= o[0][0]) return [o[0][1], o[0][2]];
  const last = o[o.length - 1];
  if (x >= last[0]) return [last[1], last[2]];
  let i = 0;
  while (i < o.length - 2 && o[i + 1][0] < x) i++;
  const a = o[i];
  const b = o[i + 1];
  const f = (x - a[0]) / Math.max(b[0] - a[0], 1e-9);
  return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/**
 * A point on a part's closed cross-section perimeter, plus its outward normal.
 * `p` walks the whole ring: 0..0.5 down the +Z face, 0.5..1 back up the -Z face. Values
 * of `p` near 0, 0.5 and 1 land on the rolled edge, which is where surface detail has to
 * sit if it is going to break the silhouette.
 */
function perimeter(
  o: Outline,
  x: number,
  p: number,
  ht: number,
): { pos: THREE.Vector3; nrm: THREE.Vector3 } {
  const [yT, yB] = edgeAt(o, x);
  const front = p < 0.5;
  const t = front ? p * 2 : 1 - (p - 0.5) * 2;
  const sign = front ? 1 : -1;
  const y = yT + (yB - yT) * t;
  const z = sign * slabZ(t, ht);
  // central difference along t for the in-section tangent
  const dt = 0.01;
  const t0 = Math.max(0, t - dt);
  const t1 = Math.min(1, t + dt);
  const dy = (yB - yT) * (t1 - t0);
  const dz = sign * (slabZ(t1, ht) - slabZ(t0, ht));
  const n = new THREE.Vector3(0, dz, -dy).normalize();
  if (n.dot(new THREE.Vector3(0, y - (yT + yB) / 2, z)) < 0) n.negate();
  return { pos: new THREE.Vector3(x, y, z), nrm: n };
}

// ---------------------------------------------------------------- detail geometry
/**
 * One countersunk hex-socket screw, axis along +Z, unit-scaled to `r`.
 * A lathed countersink + head seat, plus a real hex recess — so at a three-quarter angle
 * the fastener shows a recessed cone and a rim instead of reading as a printed disc.
 */
function screwGeometry(r: number): THREE.BufferGeometry {
  const prof = [
    new THREE.Vector2(r * 1.2, 0),
    new THREE.Vector2(r * 0.8, -r * 0.4),
    new THREE.Vector2(r * 0.76, -r * 0.46),
    new THREE.Vector2(r * 0.3, -r * 0.5),
    new THREE.Vector2(0, -r * 0.44),
  ];
  const body = new THREE.LatheGeometry(prof, 20);
  const socket = new THREE.CylinderGeometry(r * 0.34, r * 0.34, r * 0.36, 6, 1, true);
  socket.translate(0, -r * 0.62, 0);
  const g = mergeGeometries([body, socket], false)!;
  g.rotateX(Math.PI / 2); // lathe axis +Y -> the countersink descends into -Z
  g.computeVertexNormals();
  return g;
}

/** Fill an InstancedMesh from a list of matrices. */
function instanced(
  g: THREE.BufferGeometry,
  mat: THREE.Material,
  ms: THREE.Matrix4[],
  name: string,
  shadows: boolean,
): THREE.InstancedMesh {
  const im = new THREE.InstancedMesh(g, mat, ms.length);
  ms.forEach((m, i) => im.setMatrixAt(i, m));
  im.instanceMatrix.needsUpdate = true;
  im.name = name;
  im.castShadow = shadows;
  im.receiveShadow = shadows;
  return im;
}

/**
 * The four countersunk bolster screws, at the cx/cy/r measured in `geo.features.screws`,
 * one instance per visible face. Placed on the measured coordinates so the real
 * countersink lands on top of the albedo's own painted screw rather than beside it.
 */
function screws(shadows: boolean): THREE.InstancedMesh {
  const r = geo.features.screws[0].r;
  const g = screwGeometry(r);
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0x6e747c, metalness: 1.0, roughness: 0.31,
  });
  const ms: THREE.Matrix4[] = [];
  for (const s of geo.features.screws) {
    const fore = s.id.startsWith('fore');
    const host = fore ? 'foreBolster' : 'rearBolster';
    const ht = fore ? geo.thickness.foreBolster : geo.thickness.rearBolster;
    const o = OUTLINES[host];
    const [yT, yB] = edgeAt(o, s.cx);
    const t = (s.cy - yT) / Math.max(yB - yT, 1e-9);
    const z = slabZ(Math.min(Math.max(t, 0), 1), ht);
    for (const sign of [1, -1]) {
      const m = new THREE.Matrix4();
      if (sign < 0) m.makeRotationY(Math.PI);
      m.setPosition(s.cx, s.cy, sign * (z - r * 0.06));
      ms.push(m);
    }
  }
  return instanced(g, mat, ms, 'screws', shadows);
}

/**
 * The gold beaded ferrule band, as instanced spheres along the collar's rolled edge.
 *
 * Edge band only, for the same reason as the quilt: the faces already carry the beads in
 * the projected albedo, and a first pass that put real beads over the whole collar read as
 * a gold bead curtain at 1.53x the reference's saturation. On the edge the relief adds the
 * one thing a map cannot — it breaks the ferrule's outline, which was dead straight.
 * Bead layout is an APPROXIMATION: the trace records a 0.032 pitch and the x range, but
 * the braid is stochastic (geo.features.ferruleBeads.confidence 0.7).
 */
function ferruleBeads(shadows: boolean): THREE.InstancedMesh {
  const f = geo.features.ferruleBeads;
  const { scale, xc } = geo.meta;
  const x0 = (f.xRangePx[0] - xc) * scale;
  // Stop short of the guard: the traced bead range ends at -0.714 and the guard starts at
  // -0.720, so running the band to its full extent threw beads in front of the guard.
  const x1 = Math.min((f.xRangePx[1] - xc) * scale, geo.parts.guard.xRangeWorld[0] - 0.02);
  const pitch = f.pitchPx * scale;
  const ht = geo.thickness.ferrule;
  const o = OUTLINES.ferrule;
  const rad = pitch * 0.26;
  const g = new THREE.SphereGeometry(rad, 6, 4);
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xb99a49, metalness: 1.0, roughness: 0.27,
  });
  const ms: THREE.Matrix4[] = [];
  const nx = Math.max(2, Math.round(((x1 - x0) / pitch) * 1.6));
  // Two tight rows straddling each rolled edge. A wider spread read as scattered dots
  // rather than a braid, and the middle of each face is already painted by the albedo.
  const band = [0.03, 0.08, 0.42, 0.47, 0.53, 0.58, 0.92, 0.97];
  for (let i = 0; i <= nx; i++) {
    const x = x0 + ((x1 - x0) * i) / nx;
    for (let j = 0; j < band.length; j++) {
      // half-step stagger per column reads as a braid rather than a grid
      const p = (band[j] + (i % 2) * 0.02) % 1;
      const { pos, nrm } = perimeter(o, x, p, ht);
      ms.push(new THREE.Matrix4().setPosition(
        pos.x + nrm.x * rad * 0.45,
        pos.y + nrm.y * rad * 0.45,
        pos.z + nrm.z * rad * 0.45,
      ));
    }
  }
  return instanced(g, mat, ms, 'ferruleBeads', shadows);
}

/**
 * The diamond quilt, as instanced pyramids along the grip's rolled edge.
 *
 * Deliberately only on the edge band: the broad faces already carry the quilt in the
 * projected albedo and its normal map, so adding relief there would double the detail and
 * risk beating against the painted grid, whose phase the trace does not record. On the
 * edge the relief adds what no map can — it breaks the grip's outline, which was a
 * perfectly straight rectangle in the top-down view.
 */
function quiltRelief(shadows: boolean): THREE.InstancedMesh {
  const q = geo.features.quilt;
  const { scale, xc } = geo.meta;
  const x0 = (q.xRangePx[0] - xc) * scale;
  const x1 = (q.xRangePx[1] - xc) * scale;
  const pitch = q.pitchXPx * scale;
  const ht = geo.thickness.grip;
  const o = OUTLINES.grip;
  const s = pitch * 0.24;
  const g = new THREE.ConeGeometry(s, s * 0.55, 4);
  g.rotateX(Math.PI / 2); // cone axis +Y -> +Z, then oriented per instance
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0x1b1d20, metalness: 0.1, roughness: 0.78,
  });
  const ms: THREE.Matrix4[] = [];
  const nx = Math.max(2, Math.round(((x1 - x0) / pitch) * 2));
  // edge band only: p values that sit on the roll-over, both edges, both faces
  const band = [0.03, 0.07, 0.42, 0.46, 0.54, 0.58, 0.93, 0.97];
  const up = new THREE.Vector3(0, 0, 1);
  for (let i = 0; i <= nx; i++) {
    const x = x0 + ((x1 - x0) * i) / nx;
    for (const p of band) {
      const { pos, nrm } = perimeter(o, x, p, ht);
      const m = new THREE.Matrix4();
      m.makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(up, nrm));
      m.setPosition(
        pos.x + nrm.x * s * 0.1,
        pos.y + nrm.y * s * 0.1,
        pos.z + nrm.z * s * 0.1,
      );
      ms.push(m);
    }
  }
  return instanced(g, mat, ms, 'quiltRelief', shadows);
}

/**
 * Butt plate as an extruded solid with a REAL lanyard perforation.
 *
 * The previous build lofted the traced outline and faked the bore with two flat
 * RingGeometry annuli plus the albedo's own dark pixels — its own comment admitted the
 * hole "is not a real perforation". ExtrudeGeometry with a hole path punches it through
 * and generates the bore wall, and the bevel gives the plate a real chamfer.
 *
 * UVs are overwritten with the same planar projection every other part uses, so the
 * staircase and the bore stay registered to the reference pixels.
 */
function buttPlateSolid(o: Outline, ht: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(o[0][0], o[0][1]);
  for (let i = 1; i < o.length; i++) shape.lineTo(o[i][0], o[i][1]);
  for (let i = o.length - 1; i >= 0; i--) shape.lineTo(o[i][0], o[i][2]);
  shape.closePath();

  const L = geo.features.lanyardHole;
  const hole = new THREE.Path();
  hole.absarc(L.cx, L.cy, L.r, 0, Math.PI * 2, true);
  shape.holes.push(hole);

  const bevel = ht * 0.16;
  const depth = 2 * ht - 2 * bevel;
  const g = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel * 0.7,
    bevelSegments: 2,
    curveSegments: 18,
    steps: 1,
  });
  g.translate(0, 0, -depth / 2);

  // planar-project UVs so the projection still registers, and rebuild the groups as
  // [+Z face, -Z face, rim] — ExtrudeGeometry emits only [caps, walls].
  const pos = g.getAttribute('position');
  const uvs: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const [u, v] = planarUV(pos.getX(i), pos.getY(i));
    uvs.push(u, v);
  }
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));

  // ExtrudeGeometry emits a non-indexed triangle soup in two groups ([caps, walls]), so the
  // split is done by sorting whole triangles on their centroid z and rebuilding the buffers.
  const src = pos.array as ArrayLike<number>;
  const suv = g.getAttribute('uv').array as ArrayLike<number>;
  const tris = src.length / 9;
  const cut = (depth / 2 + bevel) * 0.55;
  const buckets: number[][] = [[], [], []];
  for (let t = 0; t < tris; t++) {
    const z = (src[t * 9 + 2] + src[t * 9 + 5] + src[t * 9 + 8]) / 3;
    buckets[z > cut ? 0 : z < -cut ? 1 : 2].push(t);
  }
  const np = new Float32Array(src.length);
  const nu = new Float32Array(suv.length);
  let vi = 0;
  const groups: { start: number; count: number; mat: number }[] = [];
  buckets.forEach((b, mat) => {
    const start = vi;
    for (const t of b) {
      for (let k = 0; k < 3; k++) {
        np[vi * 3] = src[t * 9 + k * 3];
        np[vi * 3 + 1] = src[t * 9 + k * 3 + 1];
        np[vi * 3 + 2] = src[t * 9 + k * 3 + 2];
        nu[vi * 2] = suv[t * 6 + k * 2];
        nu[vi * 2 + 1] = suv[t * 6 + k * 2 + 1];
        vi++;
      }
    }
    if (vi > start) groups.push({ start, count: vi - start, mat });
  });
  g.setAttribute('position', new THREE.Float32BufferAttribute(np, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(nu, 2));
  g.clearGroups();
  for (const gr of groups) g.addGroup(gr.start, gr.count, gr.mat);
  g.computeVertexNormals();
  return g;
}

/** Crisp countersink chamfer around the bore mouth on each face. */
function lanyardChamfers(ht: number, shadows: boolean): THREE.Group {
  const L = geo.features.lanyardHole;
  const g = new THREE.Group();
  g.name = 'lanyardChamfer';
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0x9aa0a8, metalness: 1.0, roughness: 0.24,
  });
  const tor = new THREE.TorusGeometry(L.r * 1.1, L.r * 0.16, 8, 28);
  for (const s of [1, -1]) {
    const m = new THREE.Mesh(tor, mat);
    m.position.set(L.cx, L.cy, s * ht * 0.9);
    m.castShadow = shadows;
    m.receiveShadow = shadows;
    g.add(m);
  }
  return g;
}

/**
 * The bright liner layer that shows between the grip scales at the butt. Inferred: the
 * references only show it as a light edge, so it is modelled as a slightly proud inset
 * plate rather than measured. `channels.json` puts its zone at roughness 0.2, metalness 1.
 */
function buttLiner(o: Outline, ht: number, shadows: boolean): THREE.Mesh {
  const inset = 0.022;
  const trimmed: Outline = o.map((r) => [r[0], r[1] - inset, r[2] + inset] as Row);
  const g = loft(trimmed, (t) => slabZ(t, ht * 1.06), 10);
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xa8aeb6, metalness: 1.0, roughness: 0.2,
  });
  const m = new THREE.Mesh(g, mat);
  m.name = 'buttLiner';
  m.castShadow = shadows;
  m.receiveShadow = shadows;
  return m;
}

// ---------------------------------------------------------------- conditioned outlines
/** Conditioned (smoothed, RDP-decimated, tenoned) outline per part — built once. */
const OUTLINES: Record<string, Outline> = (() => {
  const src = geo.parts as Record<string, { outline: number[][] }>;
  const out: Record<string, Outline> = {};
  for (const p of PARTS) {
    let o = conditionOutline(src[p.id].outline as Outline, p.eps,
      p.id === 'blade' ? [JIMPING_SPAN] : []);
    o = tenon(o, p.tenon[0], geo.joinery.tenonInsetY, true);
    o = tenon(o, p.tenon[1], geo.joinery.tenonInsetY, false);
    out[p.id] = o;
  }
  return out;
})();

/**
 * The through-tang: one continuous spine under the whole handle, derived by insetting
 * whichever furniture outline covers each x. The furniture is nested on it, so the
 * handle is a stack clamped to a tang instead of seven plates parked side by side.
 */
function tangOutline(): Outline {
  const [xa, xb] = geo.joinery.tangXRange;
  const inset = geo.joinery.tangInsetY;
  const order = ['buttPlate', 'rearBolster', 'grip', 'foreBolster', 'ferrule', 'guard'];
  const o: Outline = [];
  const n = 64;
  for (let i = 0; i <= n; i++) {
    const x = xa + ((xb - xa) * i) / n;
    let yT = -Infinity;
    let yB = Infinity;
    for (const id of order) {
      const p = OUTLINES[id];
      if (x < p[0][0] || x > p[p.length - 1][0]) continue;
      const [t, b] = edgeAt(p, x);
      yT = Math.max(yT, t);
      yB = Math.min(yB, b);
    }
    if (!Number.isFinite(yT) || !Number.isFinite(yB)) continue;
    const mid = (yT + yB) / 2;
    const half = Math.max((yT - yB) / 2 - inset, 0.012);
    o.push([x, mid + half, mid - half] as Row);
  }
  return o;
}

// ---------------------------------------------------------------- factory
export function createClassicFadeModel(options: ClassicFadeOptions = {}): THREE.Group {
  const shadows = options.shadows ?? true;
  const maps = loadMaps();
  const root = new THREE.Group();
  root.name = 'ClassicKnifeFade';

  const nodes: Record<string, THREE.Object3D> = {};

  // ---- the tang, and the furniture nested onto it ----
  // Every transform in this hierarchy stays identity: the shared planar UV frame is
  // computed from WORLD x/y, so the tree expresses the assembly graph (what is clamped
  // to what) without a transform chain that would desynchronise the projection.
  const tang = new THREE.Mesh(
    loft(tangOutline(), (t) => slabZ(t, geo.thickness.tang), 12),
    new THREE.MeshPhysicalMaterial({
      color: 0x53585f, metalness: 1.0, roughness: 0.45,
    }),
  );
  tang.name = 'tang';
  tang.castShadow = shadows;
  tang.receiveShadow = shadows;
  root.add(tang);
  nodes.tang = tang;

  for (const p of PARTS) {
    const outline = OUTLINES[p.id];
    const g = p.id === 'buttPlate'
      ? buttPlateSolid(outline, p.ht)
      : loft(outline, (t, xf) => p.z(t, xf, p.ht), p.rows);
    // aoMap needs a second UV set; the projection UVs double as uv1.
    g.setAttribute('uv1', g.getAttribute('uv'));

    const mesh = new THREE.Mesh(g, [
      faceMaterial(maps, 'front', p), // group 0 -> +Z face = FRONT reference
      faceMaterial(maps, 'back', p),  // group 1 -> -Z face = BACK  reference
      rimMaterial(p.rim, maps),
    ]);
    mesh.name = p.id;
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    mesh.userData.attachment = {
      parentSocket: 'tang',
      localStart: outline[0][0],
      localEnd: outline[outline.length - 1][0],
      contactType: p.id === 'blade' ? 'forged-continuous' : 'clamped-on-tang',
      overlap: Math.max(...p.tenon),
    };
    // the blade is forged continuous with the tang, the furniture is clamped onto it
    (p.id === 'blade' ? root : tang).add(mesh);
    nodes[p.id] = mesh;
  }

  // ---- detail geometry: real form where the old build had only maps ----
  const detail: THREE.Object3D[] = [
    screws(shadows),
    ferruleBeads(shadows),
    quiltRelief(shadows),
    lanyardChamfers(geo.thickness.buttPlate, shadows),
    buttLiner(OUTLINES.buttPlate, geo.thickness.buttPlate * 0.42, shadows),
  ];
  for (const d of detail) {
    tang.add(d);
    nodes[d.name] = d;
  }

  // ---- action-ready runtime ----
  const bbox = new THREE.Box3().setFromObject(root);
  root.userData.sculptRuntime = {
    nodes,
    sockets: {
      grip: new THREE.Vector3(
        (geo.parts.grip.xRangeWorld[0] + geo.parts.grip.xRangeWorld[1]) / 2, -0.05, 0),
      tip: new THREE.Vector3(geo.parts.blade.xRangeWorld[1], -0.01, 0),
      lanyard: new THREE.Vector3(geo.features.lanyardHole.cx, geo.features.lanyardHole.cy, 0),
      guard: new THREE.Vector3(
        (geo.parts.guard.xRangeWorld[0] + geo.parts.guard.xRangeWorld[1]) / 2, 0, 0),
      tang: new THREE.Vector3(
        (geo.joinery.tangXRange[0] + geo.joinery.tangXRange[1]) / 2, 0, 0),
    },
    colliders: [{ type: 'box', min: bbox.min.clone(), max: bbox.max.clone() }],
    destructionGroups: {
      blade: ['blade'],
      furniture: ['guard', 'ferrule', 'foreBolster', 'grip', 'rearBolster', 'buttPlate',
                  'screws', 'ferruleBeads', 'quiltRelief', 'lanyardChamfer', 'buttLiner'],
      core: ['tang'],
    },
    provenance: {
      route: 'reference-projection',
      exactnessTier: 'image-only',
      thicknessConfidence: geo.thickness.confidence,
      inferred: ['z-thickness', 'interior joinery', 'bead layout', 'butt liner'],
    },
  };
  return root;
}

// ---------------------------------------------------------------- look-dev
/**
 * Three-point rig sized for a broadside hero framing. Routed through
 * DemoEntry.installLights so the Viewer skips its default studio rig.
 *
 * Intensities are lower than the flat-plate build's: with metalness back at the map's
 * real 1.0 the environment does much more of the shading, and the old grazing rim light
 * at 2.13 blew the grind facet out to milky white.
 */
export function createClassicFadeLookDevLights(): THREE.Group {
  const g = new THREE.Group();

  const key = new THREE.DirectionalLight(0xfff2e2, 3.3);
  key.position.set(-1.6, 3.4, 3.6);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 22;
  key.shadow.camera.left = -3.2;
  key.shadow.camera.right = 3.2;
  key.shadow.camera.top = 2.2;
  key.shadow.camera.bottom = -2.2;
  key.shadow.bias = -0.0004;

  const fill = new THREE.DirectionalLight(0xc4d6ff, 1.13);
  fill.position.set(2.6, 0.8, 2.8);

  // Grazing rim along the spine so the wedge grind and the jimping read in silhouette. This
  // is also the only lamp on the -Z side, i.e. the one that lights the BACK reference view.
  // It used to be blue (0xaec6ff), which left the back face 44.6° off the back reference's
  // hue; warm-neutral brings that to -5.1° and lifts back fidelity 0.8826 -> 0.8945 for
  // 0.001 on the front.
  const rim = new THREE.DirectionalLight(0xfff0e0, 1.35);
  rim.position.set(0.6, -1.8, -3.6);

  g.add(key, fill, rim, new THREE.AmbientLight(0x2a3040, 0.18));

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 24),
    new THREE.ShadowMaterial({ opacity: 0.38 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.55;
  ground.receiveShadow = true;
  g.add(ground);

  return g;
}

/** Near-black radial studio backdrop; the warm centre lift makes the Fade's amber band pop. */
export function makeClassicFadeBackground(): THREE.CanvasTexture {
  const size = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const c = cv.getContext('2d')!;
  const grad = c.createRadialGradient(
    size * 0.5, size * 0.48, size * 0.03,
    size * 0.5, size * 0.5, size * 0.74,
  );
  grad.addColorStop(0, '#191218');
  grad.addColorStop(0.55, '#0b0a0e');
  grad.addColorStop(1, '#030304');
  c.fillStyle = grad;
  c.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
