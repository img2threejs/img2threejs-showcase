import * as THREE from 'three';
import { validateRoomBounds, vector3 } from './interior-manifest.js';

const COLS = 50;
const ROWS = 16;
const STRIDE = COLS + 1;
const COUNT = STRIDE * (ROWS + 1);
const STEP = 1 / 60;
const clamp = THREE.MathUtils.clamp;
const FREE = ROWS * STRIDE; // particles below the pinned header row
// Never spend more than this catching up with the clock in one frame: the backlog is dropped instead (the cloth runs slower, the page never stalls).
const STEP_BUDGET_MS = 7;
// Identity matrix elements: a skinned mesh whose world matrix is the identity is written without a transform.
const IDENTITY = new THREE.Matrix4().elements;
// Per particle terms of the breeze, constant for the lifetime of the page.
const BREEZE_PHASE = new Float64Array(FREE), BREEZE_V = new Float64Array(FREE), BREEZE_FADE = new Float64Array(FREE);
for (let i = 0; i < FREE; i++) {
  const v = Math.floor(i / STRIDE) / ROWS;
  BREEZE_PHASE[i] = i % STRIDE * 0.075; BREEZE_V[i] = v * 2.4; BREEZE_FADE[i] = 1 - v;
}

// The skin loop reads plain Float32 attributes. Anything else (interleaved, normalised integers) is decoded once, here.
function ensureFloatAttributes(geometry) {
  for (const [name, size] of [['position', 3], ['normal', 3], ['tangent', 4]]) {
    const attribute = geometry.getAttribute(name);
    if (!attribute || (!attribute.isInterleavedBufferAttribute && !attribute.normalized && attribute.array instanceof Float32Array)) continue;
    const out = new Float32Array(attribute.count * attribute.itemSize);
    for (let i = 0; i < attribute.count; i++) {
      out[i * attribute.itemSize] = attribute.getX(i);
      if (attribute.itemSize > 1) out[i * attribute.itemSize + 1] = attribute.getY(i);
      if (attribute.itemSize > 2) out[i * attribute.itemSize + 2] = attribute.getZ(i);
      if (attribute.itemSize > 3) out[i * attribute.itemSize + 3] = attribute.getW(i);
    }
    const plain = new THREE.BufferAttribute(out, attribute.itemSize);
    plain.setUsage(attribute.usage);
    geometry.setAttribute(name, plain);
  }
}

// All simulation positions are world-space. UVs, including the glTF V flip,
// identify material points independently of split vertices and panel direction.
export function createCurtainInteraction({ root, camera, canvas, controls, roomBounds, onChange = () => {}, isInteractive = () => true }) {
  validateRoomBounds(roomBounds);
  const room = new THREE.Box3(new THREE.Vector3().fromArray(roomBounds.min), new THREE.Vector3().fromArray(roomBounds.max));
  const doc = canvas.ownerDocument;
  const win = doc.defaultView;
  const motion = win.matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = motion.matches;
  let windRequested = true;
  let wind = windRequested && !reduced;
  let enabled = true;
  let disposed = false;
  let inView = true;
  let paused = true;
  let accumulator = 0;
  let time = 0;
  let active = true;
  let quiet = 0;
  let geometryVersion = 0;
  let lastWakeTime = -Infinity;
  const clock = win.performance;
  let grip = null;
  const originalCursor = canvas.style.cursor;
  const panels = [];
  const panelById = new Map();
  const fabricBindings = new Map();
  const fabricMeshes = [];
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const hits = [];
  const point = new THREE.Vector3();
  const sample = new THREE.Vector3();
  const contactPoint = new THREE.Vector3();
  const identity = new THREE.Matrix4();
  const delta = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const inverse = new THREE.Matrix4();
  const blocked = new Set();
  const cornerIds = new Int32Array(4);
  const cornerWeights = new Float64Array(4);

  function metadata(mesh) {
    const result = {};
    for (let node = mesh; node; node = node.parent) {
      for (const key of Object.keys(node.userData)) {
        if (key.startsWith('curtain_') && result[key] === undefined) result[key] = node.userData[key];
      }
      if (node === root) break;
    }
    return result;
  }

  function weights(u, v, ids = cornerIds, values = cornerWeights) {
    const x = clamp(u, 0, 1) * COLS;
    const y = clamp(v, 0, 1) * ROWS;
    const i = Math.min(COLS - 1, Math.floor(x));
    const j = Math.min(ROWS - 1, Math.floor(y));
    const a = x - i;
    const b = y - j;
    ids[0] = j * STRIDE + i; ids[1] = ids[0] + 1;
    ids[2] = ids[0] + STRIDE; ids[3] = ids[2] + 1;
    values[0] = (1 - a) * (1 - b); values[1] = a * (1 - b);
    values[2] = (1 - a) * b; values[3] = a * b;
  }

  function interpolate(array, ids, values, out) {
    out.set(0, 0, 0);
    for (let k = 0; k < 4; k++) {
      const i = ids[k] * 3;
      out.x += array[i] * values[k];
      out.y += array[i + 1] * values[k];
      out.z += array[i + 2] * values[k];
    }
    return out;
  }

  root.updateWorldMatrix(true, true);
  const geometryUsers = new Map();
  root.traverse(node => {
    if (node.isMesh) geometryUsers.set(node.geometry, (geometryUsers.get(node.geometry) ?? 0) + 1);
  });
  const meshes = [];
  root.traverse(node => {
    if (!node.isMesh) return;
    const meta = metadata(node);
    if (meta.curtain_id === undefined && meta.curtain_part === undefined) return;
    if (typeof meta.curtain_id !== 'string' || !meta.curtain_id) throw new Error(`Curtain mesh ${node.name} requires a nonempty curtain_id.`);
    if (!['cloth', 'hem', 'hook', 'rail'].includes(meta.curtain_part)) throw new Error(`Curtain ${meta.curtain_id} has an unsupported curtain_part.`);
    meshes.push({ mesh: node, meta });
    if (['cloth', 'hem', 'hook'].includes(meta.curtain_part)) {
      if (!root.matrixWorld.elements.every((value, i) => Math.abs(value - identity.elements[i]) < 1e-8)) {
        throw new Error('Interactive curtains require an identity scene root. Apply root transforms in the authoring scene and re-export metadata in Y-up scene coordinates.');
      }
      if (geometryUsers.get(node.geometry) !== 1) throw new Error(`Curtain ${meta.curtain_id} shares geometry with another mesh; make deforming geometry single-user before export.`);
      const p = node.geometry.getAttribute('position');
      const uv = node.geometry.getAttribute('uv');
      if (!p || p.itemSize !== 3 || !uv || uv.itemSize !== 2 || uv.count !== p.count) throw new Error(`Curtain ${meta.curtain_id} requires complete position and material UV0 attributes.`);
      for (let i = 0; i < p.count; i++) {
        if (![p.getX(i), p.getY(i), p.getZ(i), uv.getX(i), uv.getY(i)].every(Number.isFinite)) throw new Error(`Curtain ${meta.curtain_id} has non-finite geometry or UV0.`);
      }
      if (meta.curtain_part === 'hook' && (!Number.isFinite(meta.curtain_u) || meta.curtain_u < 0 || meta.curtain_u > 1)) throw new Error(`Curtain ${meta.curtain_id} hook needs curtain_u in [0, 1].`);
      if (meta.curtain_part === 'hem' && (!Number.isFinite(meta.curtain_v) || meta.curtain_v < 0 || meta.curtain_v > 1)) throw new Error(`Curtain ${meta.curtain_id} hem needs curtain_v in [0, 1].`);
    }
    if (meta.curtain_part !== 'cloth') return;
    for (const key of ['curtain_tile', 'curtain_fabric_width', 'curtain_height', 'curtain_open_width', 'curtain_closed_width']) {
      if (!Number.isFinite(meta[key]) || meta[key] <= 0) throw new Error(`Curtain ${meta.curtain_id} requires positive ${key}.`);
    }
    if (meta.curtain_closed_width <= meta.curtain_open_width) throw new Error(`Curtain ${meta.curtain_id} closed width must exceed open width.`);
    for (const key of ['curtain_rail_axis', 'curtain_depth_axis', 'curtain_plane_origin']) {
      if (!vector3(meta[key])) throw new Error(`Curtain ${meta.curtain_id} requires explicit Y-up ${key}; re-export using the current curtain helper.`);
    }
    const rail = new THREE.Vector3().fromArray(meta.curtain_rail_axis);
    const depthAxis = new THREE.Vector3().fromArray(meta.curtain_depth_axis);
    const planeOrigin = new THREE.Vector3().fromArray(meta.curtain_plane_origin);
    if (Math.abs(rail.lengthSq()-1) > 1e-5 || Math.abs(depthAxis.lengthSq()-1) > 1e-5
        || Math.abs(rail.dot(depthAxis)) > 1e-5 || Math.abs(rail.y) > 1e-5 || Math.abs(depthAxis.y) > 1e-5) {
      throw new Error(`Curtain ${meta.curtain_id} rail/depth axes must be horizontal orthogonal unit vectors in Y-up scene space.`);
    }
    const existing = panelById.get(meta.curtain_id);
    if (existing) {
      const keys = ['curtain_tile', 'curtain_fabric_width', 'curtain_height', 'curtain_open_width', 'curtain_closed_width', 'curtain_rail_axis', 'curtain_depth_axis', 'curtain_plane_origin'];
      if (keys.some(key => JSON.stringify(existing.meta[key]) !== JSON.stringify(meta[key]))) throw new Error(`Curtain ${meta.curtain_id} primitives disagree on panel metadata.`);
      return;
    }
    const panel = {
      id: meta.curtain_id, meta, rail, closure: 0, targetClosure: 0,
      depthAxis, planeOrigin, pleatDepth: new Float64Array(COUNT),
      rest: new Float64Array(COUNT * 3), goal: new Float64Array(COUNT * 3),
      position: new Float64Array(COUNT * 3), previous: new Float64Array(COUNT * 3),
      counts: new Uint16Array(COUNT), bindings: [], speed: 0, displacement: 0,
    };
    panels.push(panel);
    panelById.set(panel.id, panel);
  });
  for (const { meta } of meshes) {
    if (meta.curtain_part !== 'rail' && !panelById.has(meta.curtain_id)) throw new Error(`Curtain ${meta.curtain_id} ${meta.curtain_part} has no cloth panel.`);
  }

  // Average front/back copies at each authored grid point, retaining the shell
  // offset separately when mapping the solver back onto the imported geometry.
  for (const { mesh, meta } of meshes) {
    if (meta.curtain_part !== 'cloth') continue;
    const panel = panelById.get(meta.curtain_id);
    const uv = mesh.geometry.getAttribute('uv');
    const positions = mesh.geometry.getAttribute('position');
    if (!uv) throw new Error(`Curtain ${panel.id} requires material UV0`);
    for (let i = 0; i < positions.count; i++) {
      const u = clamp(uv.getX(i) * meta.curtain_tile / meta.curtain_fabric_width, 0, 1);
      const v = clamp((1 - uv.getY(i)) * meta.curtain_tile / meta.curtain_height, 0, 1);
      const gridU = u*COLS, gridV = v*ROWS;
      const col = Math.round(gridU), row = Math.round(gridV);
      // The solver samples exact intersections of the denser authored mesh.
      // Averaging neighbouring material points would move rail pins and folds.
      if (Math.abs(gridU-col) > 1e-4 || Math.abs(gridV-row) > 1e-4) continue;
      const index = row*STRIDE + col;
      point.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
      panel.rest[index * 3] += point.x;
      panel.rest[index * 3 + 1] += point.y;
      panel.rest[index * 3 + 2] += point.z;
      panel.counts[index]++;
    }
  }
  for (const panel of panels) {
    for (let i = 0; i < COUNT; i++) {
      if (!panel.counts[i]) throw new Error(`Curtain ${panel.id} is missing material grid point ${i}`);
      for (let a = 0; a < 3; a++) panel.rest[i * 3 + a] /= panel.counts[i];
      point.fromArray(panel.rest, i * 3);
      panel.pleatDepth[i] = delta.copy(point).sub(panel.planeOrigin).dot(panel.depthAxis);
      if (i >= ROWS * STRIDE) {
        const travel = (i % STRIDE) / COLS * (panel.meta.curtain_closed_width-panel.meta.curtain_open_width);
        if (!room.containsPoint(point) || !room.containsPoint(point.addScaledVector(panel.rail, travel))) {
          throw new Error(`Curtain ${panel.id} pinned header leaves roomBounds at open or closed coverage; repair the rail metadata or authored bounds.`);
        }
      }
    }
    panel.goal.set(panel.rest);
    panel.position.set(panel.rest);
    panel.previous.set(panel.rest);
    const edges = [];
    const add = (a, b, stiffness) => edges.push(a, b, stiffness);
    for (let j = 0; j <= ROWS; j++) {
      for (let i = 0; i <= COLS; i++) {
        const a = j * STRIDE + i;
        if (i < COLS) add(a, a + 1, 0.85);
        if (j < ROWS) add(a, a + STRIDE, 0.95);
        if (i < COLS && j < ROWS) {
          add(a, a + STRIDE + 1, 0.55);
          add(a + 1, a + STRIDE, 0.55);
        }
        if (i + 2 <= COLS) add(a, a + 2, 0.18);
        if (j + 2 <= ROWS) add(a, a + 2 * STRIDE, 0.18);
      }
    }
    // Compact solver arrays. An edge between two pinned particles moves nothing, so it is dropped; the others keep their authored order
    // (the Gauss-Seidel sweep depends on it). `edgeWeight` is the stiffness already divided by the number of free ends (1 or 2: exact).
    const keep = [];
    for (let e = 0; e < edges.length; e += 3) if (edges[e] < FREE || edges[e + 1] < FREE) keep.push(e);
    panel.edgeCount = keep.length;
    panel.edgeA = new Int32Array(keep.length); panel.edgeB = new Int32Array(keep.length); panel.edgeWeight = new Float64Array(keep.length);
    panel.edgeFreeA = new Uint8Array(keep.length); panel.edgeFreeB = new Uint8Array(keep.length); panel.edgeLength = new Float64Array(keep.length);
    keep.forEach((e, c) => {
      const wa = edges[e] < FREE ? 1 : 0, wb = edges[e + 1] < FREE ? 1 : 0;
      panel.edgeA[c] = edges[e] * 3; panel.edgeB[c] = edges[e + 1] * 3;
      panel.edgeWeight[c] = edges[e + 2] / (wa + wb);
      panel.edgeFreeA[c] = wa; panel.edgeFreeB[c] = wb;
    });
    updateGoal(panel);
  }

  for (const { mesh, meta } of meshes) {
    const panel = panelById.get(meta.curtain_id);
    if (!panel || !['cloth', 'hem', 'hook'].includes(meta.curtain_part)) continue;
    const geometry = mesh.geometry;
    ensureFloatAttributes(geometry);
    const positions = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv');
    const binding = {
      panel, mesh, part: meta.curtain_part, ids: new Int32Array(positions.count * 4), ids3: new Int32Array(positions.count * 4),
      weights: new Float64Array(positions.count * 4), offsets: new Float64Array(positions.count * 3),
      original: positions.array.slice(), originalUsage: positions.usage,
      originalNormal: geometry.getAttribute('normal')?.array.slice() ?? null,
      originalTangent: geometry.getAttribute('tangent')?.array.slice() ?? null,
      tangent1: null, tangent2: null,
      count: positions.count, worldCache: new Float64Array(16).fill(NaN), inv: null, identity: true,
    };
    positions.setUsage(THREE.DynamicDrawUsage);
    if (!geometry.getAttribute('normal')) geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(positions.count * 3), 3));
    if (geometry.getAttribute('tangent')?.itemSize === 4) {
      binding.tangent1 = new Float64Array(positions.count * 3);
      binding.tangent2 = new Float64Array(positions.count * 3);
    }
    for (let i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
      let u;
      let v;
      if (meta.curtain_part === 'cloth') {
        u = uv.getX(i) * panel.meta.curtain_tile / panel.meta.curtain_fabric_width;
        v = (1 - uv.getY(i)) * panel.meta.curtain_tile / panel.meta.curtain_height;
      } else if (meta.curtain_part === 'hook') {
        u = meta.curtain_u; v = 1;
      } else {
        // Project onto the authored rail rather than raw local mesh axes.
        delta.copy(point).sub(sample.fromArray(panel.rest, ROWS * STRIDE * 3));
        u = delta.dot(panel.rail) / (panel.rail.lengthSq() * panel.meta.curtain_open_width);
        v = meta.curtain_v;
      }
      weights(u, v);
      interpolate(panel.rest, cornerIds, cornerWeights, sample);
      for (let k = 0; k < 4; k++) {
        binding.ids[i * 4 + k] = cornerIds[k];
        binding.ids3[i * 4 + k] = cornerIds[k] * 3;
        binding.weights[i * 4 + k] = cornerWeights[k];
      }
      binding.offsets[i * 3] = point.x - sample.x;
      binding.offsets[i * 3 + 1] = point.y - sample.y;
      binding.offsets[i * 3 + 2] = point.z - sample.z;
    }
    // Shading inputs that never change: triangle list and the UV derived factors of the tangent frame (zero for a degenerate UV triangle).
    const index = geometry.index?.array ?? null;
    binding.index = index;
    binding.triangles = Math.floor((index ? index.length : positions.count) / 3);
    binding.accNormal = new Float64Array(positions.count * 3);
    if (binding.tangent1) {
      const coef = new Float64Array(binding.triangles * 4);
      for (let t = 0; t < binding.triangles; t++) {
        const a = index ? index[t * 3] : t * 3, b = index ? index[t * 3 + 1] : t * 3 + 1, c = index ? index[t * 3 + 2] : t * 3 + 2;
        const s1 = uv.getX(b) - uv.getX(a), s2 = uv.getX(c) - uv.getX(a), t1 = uv.getY(b) - uv.getY(a), t2 = uv.getY(c) - uv.getY(a);
        const determinant = s1 * t2 - s2 * t1;
        if (Math.abs(determinant) > 1e-12) { const r = 1 / determinant; coef[t * 4] = t2 * r; coef[t * 4 + 1] = t1 * r; coef[t * 4 + 2] = s1 * r; coef[t * 4 + 3] = s2 * r; }
      }
      binding.tangentCoef = coef;
    }
    // The particles this skin reads, and where they were when the mesh was last written. NaN forces the first skin of every mesh (the
    // authored normals are replaced by the geometric ones, as before); after that a skin whose particles have not moved is exactly what is
    // already in the buffers.
    const watched = new Set();
    for (let i = 0; i < positions.count * 4; i++) if (binding.weights[i] !== 0) watched.add(binding.ids[i]);
    binding.watch = Int32Array.from(watched, id => id * 3);
    binding.seen = new Float64Array(binding.watch.length * 3).fill(NaN);
    panel.bindings.push(binding);
    if (binding.part === 'cloth' || binding.part === 'hem') {
      fabricBindings.set(mesh, binding);
      fabricMeshes.push(mesh);
    }
  }

  function updateGoal(panel) {
    const expansion = panel.closure * (panel.meta.curtain_closed_width - panel.meta.curtain_open_width);
    for (let i = 0; i < COUNT; i++) {
      const shift = (i % STRIDE) / COLS * expansion;
      // Unfold the gathered depth as the rail expands, leaving modest closed
      // pleats. The short pinned header retains its authored depth so hooks
      // and their cloth attachments translate only along the rail.
      const v = Math.floor(i / STRIDE) / ROWS;
      const headerBlend = clamp((1 - v) * 8, 0, 1);
      const unfold = -panel.pleatDepth[i] * 0.72 * panel.closure
        * headerBlend * headerBlend * (3 - 2 * headerBlend);
      panel.goal[i * 3] = panel.rest[i * 3] + panel.rail.x * shift + panel.depthAxis.x * unfold;
      panel.goal[i * 3 + 1] = panel.rest[i * 3 + 1] + panel.rail.y * shift + panel.depthAxis.y * unfold;
      panel.goal[i * 3 + 2] = panel.rest[i * 3 + 2] + panel.rail.z * shift + panel.depthAxis.z * unfold;
    }
    for (let c = 0; c < panel.edgeCount; c++) {
      const a = panel.edgeA[c], b = panel.edgeB[c];
      panel.edgeLength[c] = Math.hypot(panel.goal[b] - panel.goal[a], panel.goal[b + 1] - panel.goal[a + 1], panel.goal[b + 2] - panel.goal[a + 2]);
    }
  }

  function constrainGrip(panel) {
    if (!grip || grip.panel !== panel) return;
    interpolate(panel.position, grip.ids, grip.weights, sample);
    delta.copy(grip.target).sub(grip.offset).sub(sample);
    let denominator = 0;
    let largestWeight = 0;
    for (let k = 0; k < 4; k++) {
      if (grip.ids[k] < ROWS * STRIDE) {
        denominator += grip.weights[k] ** 2;
        largestWeight = Math.max(largestWeight, grip.weights[k]);
      }
    }
    if (denominator < 0.0001) return; // A point exactly on the rail remains pinned.
    delta.clampLength(0, Math.min(0.10, 0.04 * denominator / largestWeight));
    for (let k = 0; k < 4; k++) {
      if (grip.ids[k] >= ROWS * STRIDE) continue;
      const i = grip.ids[k] * 3;
      const w = grip.weights[k] / denominator * 0.9;
      panel.position[i] += delta.x * w;
      panel.position[i + 1] += delta.y * w;
      panel.position[i + 2] += delta.z * w;
    }
  }

  function clampToRoom(vector) {
    return room.clampPoint(vector, vector);
  }

  // The pinned header follows the goal exactly; every other particle is kept inside the room.
  function boundsAndPins(panel) {
    const p = panel.position, goal = panel.goal;
    const lo = room.min, hi = room.max, minX = lo.x, minY = lo.y, minZ = lo.z, maxX = hi.x, maxY = hi.y, maxZ = hi.z;
    for (let a = 0; a < FREE * 3; a += 3) {
      const x = p[a], y = p[a + 1], z = p[a + 2];
      if (x < minX) p[a] = minX; else if (x > maxX) p[a] = maxX;
      if (y < minY) p[a + 1] = minY; else if (y > maxY) p[a + 1] = maxY;
      if (z < minZ) p[a + 2] = minZ; else if (z > maxZ) p[a + 2] = maxZ;
    }
    for (let a = FREE * 3; a < COUNT * 3; a++) p[a] = goal[a];
  }

  function stepPanel(panel) {
    const difference = panel.targetClosure - panel.closure;
    if (Math.abs(difference) > 0.00001) {
      panel.closure += difference * (1 - Math.exp(-STEP * 9));
      if (Math.abs(panel.targetClosure - panel.closure) < 0.0001) panel.closure = panel.targetClosure;
      updateGoal(panel);
    }
    const p = panel.position;
    const prev = panel.previous;
    const goal = panel.goal;
    const damping = reduced ? 0.75 : 0.94;
    const dax = panel.depthAxis.x, day = panel.depthAxis.y, daz = panel.depthAxis.z;
    const windy = wind, windPhase = time * 1.15;
    for (let i = 0; i < FREE; i++) {
      const a = i * 3;
      const breeze = windy ? 0.19 * Math.sin(windPhase + BREEZE_PHASE[i] + BREEZE_V[i]) * BREEZE_FADE[i] : 0;
      let value = p[a];
      let velocity = (value - prev[a]) * damping;
      velocity = velocity < -0.035 ? -0.035 : velocity > 0.035 ? 0.035 : velocity;
      p[a] = value + velocity + ((goal[a] - value) * 14 + breeze * dax) * STEP * STEP;
      prev[a] = value;
      value = p[a + 1];
      velocity = (value - prev[a + 1]) * damping;
      velocity = velocity < -0.035 ? -0.035 : velocity > 0.035 ? 0.035 : velocity;
      p[a + 1] = value + velocity + ((goal[a + 1] - value) * 14 - 1.5 + breeze * day) * STEP * STEP;
      prev[a + 1] = value;
      value = p[a + 2];
      velocity = (value - prev[a + 2]) * damping;
      velocity = velocity < -0.035 ? -0.035 : velocity > 0.035 ? 0.035 : velocity;
      p[a + 2] = value + velocity + ((goal[a + 2] - value) * 14 + breeze * daz) * STEP * STEP;
      prev[a + 2] = value;
    }
    const edgeA = panel.edgeA, edgeB = panel.edgeB, edgeWeight = panel.edgeWeight, edgeLength = panel.edgeLength;
    const freeA = panel.edgeFreeA, freeB = panel.edgeFreeB, edgeCount = panel.edgeCount;
    const gripped = grip !== null && grip.panel === panel;
    for (let iteration = 0; iteration < 7; iteration++) {
      for (let c = 0; c < edgeCount; c++) {
        const a = edgeA[c], b = edgeB[c];
        const dx = p[b] - p[a]; const dy = p[b + 1] - p[a + 1]; const dz = p[b + 2] - p[a + 2];
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (!distance) continue;
        const correction = (distance - edgeLength[c]) / distance * edgeWeight[c];
        if (freeA[c]) { p[a] += dx * correction; p[a + 1] += dy * correction; p[a + 2] += dz * correction; }
        if (freeB[c]) { p[b] -= dx * correction; p[b + 1] -= dy * correction; p[b + 2] -= dz * correction; }
      }
      if (gripped) constrainGrip(panel);
      boundsAndPins(panel);
    }
    let speed = 0, displacement = 0;
    for (let a = 0; a < COUNT * 3; a += 3) {
      const vx = p[a] - prev[a], vy = p[a + 1] - prev[a + 1], vz = p[a + 2] - prev[a + 2];
      const dx = p[a] - goal[a], dy = p[a + 1] - goal[a + 1], dz = p[a + 2] - goal[a + 2];
      const v2 = vx * vx + vy * vy + vz * vz, d2 = dx * dx + dy * dy + dz * dz;
      if (v2 > speed) speed = v2;
      if (d2 > displacement) displacement = d2;
    }
    for (let a = FREE * 3; a < COUNT * 3; a++) prev[a] = p[a];
    panel.speed = Math.sqrt(speed) / STEP;
    panel.displacement = Math.sqrt(displacement);
  }

  // Local-to-world matrix of a skinned mesh; its inverse is only recomputed when the matrix changes.
  function refreshMatrix(binding) {
    const mesh = binding.mesh;
    mesh.updateWorldMatrix(true, false);
    const e = mesh.matrixWorld.elements, cache = binding.worldCache;
    for (let k = 0; k < 16; k++) {
      if (e[k] === cache[k]) continue;
      for (let j = 0; j < 16; j++) cache[j] = e[j];
      inverse.copy(mesh.matrixWorld).invert();
      binding.inv = inverse.elements.slice();
      binding.identity = binding.inv.every((value, j) => value === IDENTITY[j]);
      break;
    }
  }

  // True when a particle this skin reads has moved since the mesh was last written (and records where they are now).
  function moved(binding) {
    const P = binding.panel.position, watch = binding.watch, seen = binding.seen;
    let changed = false;
    for (let k = 0; k < watch.length; k++) {
      const a = watch[k], s = k * 3;
      if (P[a] !== seen[s] || P[a + 1] !== seen[s + 1] || P[a + 2] !== seen[s + 2]) { changed = true; break; }
    }
    if (changed) for (let k = 0; k < watch.length; k++) { const a = watch[k], s = k * 3; seen[s] = P[a]; seen[s + 1] = P[a + 1]; seen[s + 2] = P[a + 2]; }
    return changed;
  }

  // Writes the skinned positions, the normals and the tangents of one mesh straight into the geometry arrays (the old path went through
  // BufferAttribute accessors and recomputed the bounds from scratch).
  function skinBinding(binding) {
    const geometry = binding.mesh.geometry;
    const P = binding.panel.position, count = binding.count, ids = binding.ids3, weights = binding.weights, offsets = binding.offsets;
    const pos = geometry.getAttribute('position').array;
    refreshMatrix(binding);
    const identity = binding.identity, m = binding.inv;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < count; i++) {
      const i3 = i * 3, i4 = i * 4;
      let x = offsets[i3], y = offsets[i3 + 1], z = offsets[i3 + 2];
      let a = ids[i4], w = weights[i4]; x += P[a] * w; y += P[a + 1] * w; z += P[a + 2] * w;
      a = ids[i4 + 1]; w = weights[i4 + 1]; x += P[a] * w; y += P[a + 1] * w; z += P[a + 2] * w;
      a = ids[i4 + 2]; w = weights[i4 + 2]; x += P[a] * w; y += P[a + 1] * w; z += P[a + 2] * w;
      a = ids[i4 + 3]; w = weights[i4 + 3]; x += P[a] * w; y += P[a + 1] * w; z += P[a + 2] * w;
      if (!identity) {
        const iw = 1 / (m[3] * x + m[7] * y + m[11] * z + m[15]);
        const tx = (m[0] * x + m[4] * y + m[8] * z + m[12]) * iw, ty = (m[1] * x + m[5] * y + m[9] * z + m[13]) * iw, tz = (m[2] * x + m[6] * y + m[10] * z + m[14]) * iw;
        x = tx; y = ty; z = tz;
      }
      pos[i3] = x; pos[i3 + 1] = y; pos[i3 + 2] = z;
      x = pos[i3]; y = pos[i3 + 1]; z = pos[i3 + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const box = geometry.boundingBox ??= new THREE.Box3(), sphere = geometry.boundingSphere ??= new THREE.Sphere();
    box.min.set(minX, minY, minZ); box.max.set(maxX, maxY, maxZ);
    const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5, cz = (minZ + maxZ) * 0.5;
    let r2 = 0;
    for (let i = 0; i < count; i++) {
      const dx = pos[i * 3] - cx, dy = pos[i * 3 + 1] - cy, dz = pos[i * 3 + 2] - cz, d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) r2 = d2;
    }
    sphere.center.set(cx, cy, cz); sphere.radius = Math.sqrt(r2);
    shadeBinding(binding, pos);
    geometry.getAttribute('position').needsUpdate = true;
  }

  // Vertex normals (area weighted) and, when the mesh has them, tangents from the UV derivatives of every triangle.
  function shadeBinding(binding, pos) {
    const geometry = binding.mesh.geometry;
    const normal = geometry.getAttribute('normal'), tangent = binding.tangent1 ? geometry.getAttribute('tangent') : null;
    const nrm = normal.array, acc = binding.accNormal, index = binding.index, count = binding.count, triangles = binding.triangles;
    const t1 = binding.tangent1, t2 = binding.tangent2, coef = binding.tangentCoef;
    acc.fill(0);
    if (t1) { t1.fill(0); t2.fill(0); }
    for (let t = 0; t < triangles; t++) {
      const a = (index ? index[t * 3] : t * 3) * 3, b = (index ? index[t * 3 + 1] : t * 3 + 1) * 3, c = (index ? index[t * 3 + 2] : t * 3 + 2) * 3;
      const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
      const x1 = pos[b] - ax, y1 = pos[b + 1] - ay, z1 = pos[b + 2] - az;
      const x2 = pos[c] - ax, y2 = pos[c + 1] - ay, z2 = pos[c + 2] - az;
      const nx = y1 * z2 - z1 * y2, ny = z1 * x2 - x1 * z2, nz = x1 * y2 - y1 * x2;
      acc[a] += nx; acc[a + 1] += ny; acc[a + 2] += nz;
      acc[b] += nx; acc[b + 1] += ny; acc[b + 2] += nz;
      acc[c] += nx; acc[c + 1] += ny; acc[c + 2] += nz;
      if (t1) {
        const k = t * 4, ca = coef[k], cb = coef[k + 1], cc = coef[k + 2], cd = coef[k + 3];
        const sx = ca * x1 - cb * x2, sy = ca * y1 - cb * y2, sz = ca * z1 - cb * z2;
        const tx = cc * x2 - cd * x1, ty = cc * y2 - cd * y1, tz = cc * z2 - cd * z1;
        t1[a] += sx; t1[a + 1] += sy; t1[a + 2] += sz; t1[b] += sx; t1[b + 1] += sy; t1[b + 2] += sz; t1[c] += sx; t1[c + 1] += sy; t1[c + 2] += sz;
        t2[a] += tx; t2[a + 1] += ty; t2[a + 2] += tz; t2[b] += tx; t2[b + 1] += ty; t2[b + 2] += tz; t2[c] += tx; t2[c + 1] += ty; t2[c + 2] += tz;
      }
    }
    const tan = tangent ? tangent.array : null;
    for (let i = 0; i < count; i++) {
      const o = i * 3;
      let nx = acc[o], ny = acc[o + 1], nz = acc[o + 2];
      const il = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1);
      nx *= il; ny *= il; nz *= il;
      nrm[o] = nx; nrm[o + 1] = ny; nrm[o + 2] = nz;
      if (!tan) continue;
      let px = t1[o], py = t1[o + 1], pz = t1[o + 2];
      const d = nx * px + ny * py + nz * pz;
      px -= nx * d; py -= ny * d; pz -= nz * d;
      const pl = 1 / (Math.sqrt(px * px + py * py + pz * pz) || 1);
      px *= pl; py *= pl; pz *= pl;
      const cx = ny * pz - nz * py, cy = nz * px - nx * pz, cz = nx * py - ny * px;
      const k = i * 4;
      tan[k] = px; tan[k + 1] = py; tan[k + 2] = pz;
      tan[k + 3] = cx * t2[o] + cy * t2[o + 1] + cz * t2[o + 2] < 0 ? -1 : 1;
    }
    normal.needsUpdate = true;
    if (tangent) tangent.needsUpdate = true;
  }

  // Re-skins the meshes whose particles moved. Returns whether any buffer was rewritten.
  function renderGeometry() {
    let written = false;
    for (const panel of panels) for (const binding of panel.bindings) {
      if (!moved(binding)) continue;
      skinBinding(binding);
      written = true;
    }
    if (written) geometryVersion++;
    return written;
  }

  function available() {
    return !disposed && enabled && !doc.hidden && inView && isInteractive();
  }

  function wake() {
    active = true;
    quiet = 0;
    lastWakeTime = time;
    if (!disposed) onChange();
  }

  // The grab cursor needs a scene raycast: skipped while a button is held (orbiting, dragging something else).
  function hoverCursor(event) {
    if (event.buttons) return;
    canvas.style.cursor = available() && pick(event) ? 'grab' : originalCursor;
  }

  function setRay(event) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2);
    camera.updateWorldMatrix(true, false);
    raycaster.setFromCamera(pointer, camera);
    return true;
  }

  function visibleHit(hit) {
    if (!hit.object.isMesh || !camera.layers.test(hit.object.layers)) return false;
    if (hit.object.userData.occluderOnly !== true) for (let node = hit.object; node; node = node.parent) if (!node.visible) return false;
    const materials = hit.object.material;
    const material = Array.isArray(materials) ? materials[hit.face?.materialIndex ?? 0] : materials;
    return !!material?.visible && !(material.transparent && material.opacity === 0);
  }

  function pick(event) {
    if (!setRay(event)) return null;
    root.updateWorldMatrix(true, true);
    hits.length = 0;
    raycaster.intersectObjects(fabricMeshes, false, hits);
    let candidate = null;
    for (const hit of hits) {
      if (hit.uv && visibleHit(hit)) { candidate = hit; break; }
    }
    if (!candidate) return null;
    // Only pay for scene occlusion when the pointer actually reaches fabric.
    // Limit the second query to the candidate; geometry behind it is irrelevant.
    const previousFar = raycaster.far;
    raycaster.far = Math.min(previousFar, candidate.distance + 0.0001);
    hits.length = 0;
    try {
      raycaster.intersectObject(root, true, hits);
    } finally {
      raycaster.far = previousFar;
    }
    for (const hit of hits) {
      if (!visibleHit(hit)) continue;
      return fabricBindings.has(hit.object) && hit.uv ? hit : null;
    }
    return null;
  }

  function cancelGrip() {
    if (!grip) return;
    const old = grip;
    grip = null;
    win.removeEventListener('wheel', suppress, true);
    controls.enabled = old.controlsEnabled && enabled && isInteractive();
    canvas.style.cursor = originalCursor;
    if (canvas.hasPointerCapture(old.pointerId)) canvas.releasePointerCapture(old.pointerId);
    wake();
  }

  function suppress(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function pointerDown(event) {
    if (grip && event.pointerId !== grip.pointerId) {
      blocked.add(event.pointerId);
      blocked.add(grip.pointerId);
      cancelGrip();
      suppress(event);
      return;
    }
    if (event.target !== canvas || !available() || blocked.size || event.button !== 0 || event.isPrimary === false) return;
    const hit = pick(event);
    if (!hit) return;
    const binding = fabricBindings.get(hit.object);
    const panel = binding.panel;
    let u, v;
    if (binding.part === 'cloth') {
      u = hit.uv.x * panel.meta.curtain_tile / panel.meta.curtain_fabric_width;
      v = (1-hit.uv.y) * panel.meta.curtain_tile / panel.meta.curtain_height;
    } else {
      // Hem texture UVs describe the tube, not the parent fabric. Recover the
      // grabbed material point from the same vertex bindings used to deform it.
      u = v = 0;
      for (let corner = 0; corner < 3; corner++) {
        const vertex = corner === 0 ? hit.face.a : corner === 1 ? hit.face.b : hit.face.c;
        const barycentric = corner === 0 ? hit.barycoord.x : corner === 1 ? hit.barycoord.y : hit.barycoord.z;
        for (let k = 0; k < 4; k++) {
          const slot = vertex*4+k;
          const id = binding.ids[slot];
          const weight = barycentric*binding.weights[slot];
          u += id%STRIDE/COLS*weight;
          v += Math.floor(id/STRIDE)/ROWS*weight;
        }
      }
    }
    u = clamp(u, 0, 1); v = clamp(v, 0, 1);
    const ids = new Int32Array(4);
    const values = new Float64Array(4);
    weights(u, v, ids, values);
    interpolate(panel.position, ids, values, sample);
    camera.getWorldDirection(normal);
    grip = {
      panel, part: binding.part, pointerId: event.pointerId, ids, weights: values, uv: [u, v],
      offset: hit.point.clone().sub(sample), start: hit.point.clone(), target: hit.point.clone(),
      plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, hit.point),
      startClosure: panel.closure, controlsEnabled: controls.enabled,
    };
    controls.enabled = false;
    suppress(event);
    try { canvas.setPointerCapture(event.pointerId); } catch { cancelGrip(); return; }
    win.addEventListener('wheel', suppress, eventOptions);
    canvas.style.cursor = 'grabbing';
    wake();
  }

  function pointerMove(event) {
    if (blocked.has(event.pointerId)) { suppress(event); return; }
    if (!grip) {
      if (event.target === canvas && event.pointerType !== 'touch') hoverCursor(event);
      return;
    }
    if (event.pointerId !== grip.pointerId) return;
    suppress(event);
    if (!available()) { cancelGrip(); return; }
    if (!setRay(event) || !raycaster.ray.intersectPlane(grip.plane, point)) return;
    const panel = grip.panel;
    // Rail displacement is retained independently from elastic displacement.
    delta.copy(point).sub(grip.start);
    const travel = panel.meta.curtain_closed_width - panel.meta.curtain_open_width;
    const alongRail = delta.dot(panel.rail) / panel.rail.lengthSq();
    panel.targetClosure = clamp(grip.startClosure + alongRail / (Math.max(0.18, grip.uv[0]) * travel), 0, 1);
    sample.copy(panel.rail).multiplyScalar((panel.targetClosure - grip.startClosure) * travel * grip.uv[0]).add(grip.start);
    delta.copy(point).sub(sample).clampLength(0, 0.85);
    grip.target.copy(sample).add(delta);
    clampToRoom(grip.target);
    wake();
  }

  function pointerEnd(event) {
    if (blocked.delete(event.pointerId)) { suppress(event); return; }
    if (grip?.pointerId !== event.pointerId) return;
    suppress(event);
    cancelGrip();
  }

  function interrupt() {
    cancelGrip();
    blocked.clear();
    accumulator = 0;
    paused = true;
    for (const panel of panels) panel.previous.set(panel.position);
    canvas.style.cursor = originalCursor;
  }

  function visibilityChanged() {
    interrupt();
    if (available()) wake();
  }

  function preferenceChanged() {
    reduced = motion.matches;
    wind = windRequested && !reduced;
    wake();
  }

  function pointerLeave() { if (!grip) canvas.style.cursor = originalCursor; }
  function lostCapture(event) { if (grip?.pointerId === event.pointerId) cancelGrip(); }
  const eventOptions = { capture: true, passive: false };
  win.addEventListener('pointerdown', pointerDown, eventOptions);
  win.addEventListener('pointermove', pointerMove, eventOptions);
  win.addEventListener('pointerup', pointerEnd, eventOptions);
  win.addEventListener('pointercancel', pointerEnd, eventOptions);
  win.addEventListener('blur', interrupt);
  doc.addEventListener('visibilitychange', visibilityChanged);
  canvas.addEventListener('lostpointercapture', lostCapture);
  canvas.addEventListener('pointerleave', pointerLeave);
  motion.addEventListener('change', preferenceChanged);
  const observer = win.IntersectionObserver ? new win.IntersectionObserver(entries => {
    inView = entries[0].isIntersecting;
    visibilityChanged();
  }) : null;
  observer?.observe(canvas);

  function probe(panel, u, v, rect) {
    weights(u, v);
    interpolate(panel.position, cornerIds, cornerWeights, point);
    const world = point.toArray();
    point.project(camera);
    return { uv: [u, v], world, canvas: [(point.x + 1) * rect.width / 2, (1 - point.y) * rect.height / 2], inFrustum: Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1 && Math.abs(point.z) <= 1 };
  }

  return {
    get count() { return panels.length; },
    get closure() {
      let sum = 0;
      for (const panel of panels) sum += panel.closure;
      return panels.length ? sum / panels.length : 0;
    },
    get targetClosure() {
      let sum = 0;
      for (const panel of panels) sum += panel.targetClosure;
      return panels.length ? sum / panels.length : 0;
    },
    get wind() { return wind; },
    get reducedMotion() { return reduced; },
    get grabbing() { return !!grip; },
    // Counts the updates that rewrote any vertex buffer: the shadow map only has to follow when it changes.
    get geometryVersion() { return geometryVersion; },
    // True while the only motion is the idle breeze (no pointer grip, closure at its target, nothing disturbed for a while): the redraw may be throttled.
    get breezeOnly() { return wind && !grip && time - lastWakeTime > 1.5 && !panels.some(panel => Math.abs(panel.targetClosure - panel.closure) > 0.0001); },
    update(deltaSeconds, elapsedSeconds) {
      // Native lostpointercapture can wait for the next pointer event.
      if (grip && !canvas.hasPointerCapture(grip.pointerId)) cancelGrip();
      if (!available()) { if (!paused || grip) interrupt(); return false; }
      if (!panels.length) return false;
      if (paused) { paused = false; accumulator = 0; deltaSeconds = 0; }
      if (!active && !wind && !grip) return false;
      // Use simulation time, not wall-clock elapsedSeconds, so tab resumes never
      // jump the wind phase or integrate an accumulated background interval.
      accumulator += clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 0, 0, STEP * 4);
      let changed = false;
      const started = clock.now();
      while (accumulator >= STEP) {
        accumulator -= STEP;
        time += STEP;
        for (const panel of panels) stepPanel(panel);
        changed = true;
        const settling = panels.some(panel => panel.speed > 0.012 || Math.abs(panel.targetClosure - panel.closure) > 0.0001);
        quiet = settling || grip || wind ? 0 : quiet + STEP;
        if (quiet > (reduced ? 0.12 : 0.4)) {
          active = false;
          for (const panel of panels) { panel.previous.set(panel.position); panel.speed = 0; }
          break;
        }
        // A slow frame must not be followed by a longer one: whatever backlog is left after the budget is dropped.
        if (accumulator >= STEP && clock.now() - started > STEP_BUDGET_MS) { accumulator = 0; break; }
      }
      if (changed) renderGeometry();
      return active || wind || !!grip;
    },
    setClosure(value) {
      if (disposed || !Number.isFinite(value)) return;
      cancelGrip();
      for (const panel of panels) panel.targetClosure = clamp(value, 0, 1);
      wake();
    },
    setWind(value) {
      if (!disposed) { windRequested = !!value; wind = windRequested && !reduced; wake(); }
      return wind;
    },
    setEnabled(value) {
      if (disposed || enabled === !!value) return;
      enabled = !!value;
      if (!enabled) interrupt(); else wake();
    },
    reset() {
      if (disposed) return;
      interrupt();
      windRequested = true;
      wind = !reduced;
      time = 0;
      for (const panel of panels) {
        panel.closure = panel.targetClosure = 0;
        panel.position.set(panel.rest);
        panel.previous.set(panel.rest);
        panel.speed = panel.displacement = 0;
        updateGoal(panel);
      }
      renderGeometry();
      wake();
    },
    snapshot() {
      const rect = canvas.getBoundingClientRect();
      camera.updateWorldMatrix(true, false);
      const result = {
        closure: panels.length ? panels.reduce((sum, panel) => sum + panel.closure, 0) / panels.length : 0,
        wind, grabbing: !!grip, enabled, reducedMotion: reduced,
        panels: panels.map(panel => {
          let topAnchorError = 0;
          for (let i = ROWS * STRIDE * 3; i < COUNT * 3; i += 3) topAnchorError = Math.max(topAnchorError, Math.hypot(panel.position[i] - panel.goal[i], panel.position[i + 1] - panel.goal[i + 1], panel.position[i + 2] - panel.goal[i + 2]));
          return { id: panel.id, closure: panel.closure, targetClosure: panel.targetClosure,
            maxDisplacement: panel.displacement, maxSpeed: panel.speed, topAnchorError,
            probes: [probe(panel, 0.55, 0.25, rect), probe(panel, 0.7, 0.5, rect), probe(panel, 0.8, 0.8, rect), probe(panel, 0.9, 1, rect), probe(panel, 0.55, 0, rect)] };
        }),
        grip: null,
      };
      if (grip) {
        interpolate(grip.panel.position, grip.ids, grip.weights, point).add(grip.offset);
        result.grip = { panel: grip.panel.id, part: grip.part, uv: [...grip.uv], point: point.toArray(), target: grip.target.toArray(), error: point.distanceTo(grip.target) };
      }
      return result;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      interrupt();
      observer?.disconnect();
      win.removeEventListener('pointerdown', pointerDown, true);
      win.removeEventListener('pointermove', pointerMove, true);
      win.removeEventListener('pointerup', pointerEnd, true);
      win.removeEventListener('pointercancel', pointerEnd, true);
      win.removeEventListener('blur', interrupt);
      doc.removeEventListener('visibilitychange', visibilityChanged);
      canvas.removeEventListener('lostpointercapture', lostCapture);
      canvas.removeEventListener('pointerleave', pointerLeave);
      motion.removeEventListener('change', preferenceChanged);
      // Geometry belongs to the caller: restore it, never dispose shared assets.
      for (const panel of panels) for (const binding of panel.bindings) {
        const geometry = binding.mesh.geometry;
        const positions = geometry.getAttribute('position');
        positions.array.set(binding.original);
        positions.setUsage(binding.originalUsage);
        positions.needsUpdate = true;
        if (binding.originalNormal) {
          geometry.getAttribute('normal').array.set(binding.originalNormal);
          geometry.getAttribute('normal').needsUpdate = true;
        } else geometry.deleteAttribute('normal');
        if (binding.originalTangent) {
          geometry.getAttribute('tangent').array.set(binding.originalTangent);
          geometry.getAttribute('tangent').needsUpdate = true;
        }
        binding.mesh.geometry.computeBoundingBox();
        binding.mesh.geometry.computeBoundingSphere();
      }
      fabricBindings.clear();
      blocked.clear();
    },
  };
}
