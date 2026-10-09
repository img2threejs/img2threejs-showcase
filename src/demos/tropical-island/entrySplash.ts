/** Subgrid liquid parcels: conservative exchange with the height field, not a
 * resolved two-phase CFD solver. Sheet rupture is a subgrid closure. */
import * as THREE from 'three';
import type { OceanPlane } from './ocean';
import type { WaterParcel } from './shallowWater';
import { GRAVITY, WATER_DENSITY, SURFACE_TENSION, type EntryBody, type EntryStep, type EntryWater } from './waterEntryDynamics';
import { createEntryWaterOptics } from './entryWaterOptics';

const SECTORS = 32;
const ROWS = 14;
const SHEET_POINTS = SECTORS * ROWS;
const STRIDE = 10;
const AERATION_POINTS = 80;
const TAU = Math.PI * 2;
// Entrainment and unresolved energy partition are reduced-order closures. The
// actual volume/work comes from immersion and hydrodynamic work, not impact age.
const ENTRAINMENT = 0.06;
const EJECTA_WORK = 0.18;
const MAX_SHEET_ASPECT = 12;
const AIR_DENSITY = 1.225;
const AIR_DRAG = 0.47;

function geometry(points: number, indices: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(points * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setIndex(new THREE.BufferAttribute(new Uint16Array(indices), 1).setUsage(THREE.DynamicDrawUsage));
  g.setDrawRange(0, 0);
  return g;
}

function normals(g: THREE.BufferGeometry): void {
  const p = g.getAttribute('position').array;
  const n = g.getAttribute('normal').array as Float32Array;
  const indices = g.getIndex()!.array;
  n.fill(0);
  for (let i = 0; i < g.drawRange.count; i += 3) {
    const a = indices[i]! * 3, b = indices[i + 1]! * 3, c = indices[i + 2]! * 3;
    const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!;
    const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    n[a] += nx; n[a + 1] += ny; n[a + 2] += nz;
    n[b] += nx; n[b + 1] += ny; n[b + 2] += nz;
    n[c] += nx; n[c + 1] += ny; n[c + 2] += nz;
  }
  for (let i = 0; i < n.length; i += 3) {
    const length = Math.hypot(n[i]!, n[i + 1]!, n[i + 2]!) || 1;
    n[i] /= length; n[i + 1] /= length; n[i + 2] /= length;
  }
  g.getAttribute('position').needsUpdate = true;
  g.getAttribute('normal').needsUpdate = true;
  g.getIndex()!.needsUpdate = true;
}

export class EntrySplash {
  readonly group = new THREE.Group();
  readonly sheet: THREE.Mesh;
  readonly drops: THREE.InstancedMesh;
  readonly aeration: THREE.InstancedMesh;
  /** Added particle momentum to subtract from the body's reaction on the field. */
  impulseX = 0;
  impulseZ = 0;
  allocatedWork = 0;
  waveCredit = 0;
  private readonly data = new Float64Array(SHEET_POINTS * STRIDE);
  // 0 unused, 1 liquid sheet, 2 detached drop, 3 returned to the field.
  private readonly state = new Uint8Array(SHEET_POINTS);
  private readonly linked = new Uint8Array(SHEET_POINTS);
  private readonly cellArea = new Float64Array((ROWS - 1) * SECTORS);
  private readonly cellGrowth = new Float64Array((ROWS - 1) * SECTORS);
  private readonly bubbles = new Float64Array(AERATION_POINTS * 7);
  private bubbleCursor = 0;
  private bubblesAlive = 0;
  private readonly collar = new Float64Array(SECTORS);
  private readonly tangent = new Float64Array(SECTORS);
  private readonly cache: Float32Array;
  private readonly matrix = new THREE.Matrix4();
  private readonly hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly sample = new THREE.Vector3();
  private readonly water: EntryWater = { height: 0, depth: 0, bed: 0, slopeX: 0, slopeZ: 0, velocityX: 0, velocityY: 0, velocityZ: 0 };
  private readonly parcel: WaterParcel = { volume: 0, momentumX: 0, momentumZ: 0, kineticEnergy: 0, potentialEnergy: 0 };
  private age = 0;
  private renderedAge = 0;
  private rows = 0;
  private airborne = 0;
  private pendingVolume = 0;
  private pendingWork = 0;
  private entrained = 0;
  private originX = 0;
  private originZ = 0;
  private width = 0;
  private feeding = true;

  constructor(
    private readonly ocean: OceanPlane,
    private readonly rock: THREE.Mesh<THREE.BufferGeometry>,
    sheetMaterial: THREE.MeshPhysicalMaterial,
    dropGeometry: THREE.BufferGeometry,
    aerationGeometry: THREE.BufferGeometry,
    aerationMaterial: THREE.MeshStandardMaterial,
  ) {
    this.cache = new Float32Array(rock.geometry.getAttribute('position').count * 3);
    this.group.name = 'Water entry';
    this.group.userData.isRuntimeEffect = true;
    this.group.userData.isPointerTransparent = true;
    this.sheet = new THREE.Mesh(geometry(SHEET_POINTS, (ROWS - 1) * SECTORS * 6), sheetMaterial);
    this.drops = new THREE.InstancedMesh(dropGeometry, sheetMaterial, SHEET_POINTS);
    this.aeration = new THREE.InstancedMesh(aerationGeometry, aerationMaterial, AERATION_POINTS);
    this.sheet.name = 'Impact sheet';
    this.drops.name = 'Water droplets';
    this.aeration.name = 'Impact aeration';
    this.aeration.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.drops.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (const mesh of [this.sheet, this.drops, this.aeration]) {
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 20;
      mesh.userData.isRuntimeEffect = true;
      mesh.userData.isPointerTransparent = true;
      this.group.add(mesh);
    }
    this.aeration.renderOrder = 19;
    for (let i = 0; i < AERATION_POINTS; i++) this.aeration.setMatrixAt(i, this.hidden);
    for (let i = 0; i < SHEET_POINTS; i++) this.drops.setMatrixAt(i, this.hidden);
  }

  get finished(): boolean { return !this.feeding && this.airborne === 0 && this.bubblesAlive === 0; }

  begin(x: number, z: number, radius: number): void {
    this.reset(false);
    this.group.visible = true;
    this.originX = x;
    this.originZ = z;
    this.width = radius * 1.3;
    this.feeding = true;
  }

  /** Return represented water before cancelling an active entry. */
  reset(refund: boolean): void {
    if (refund) {
      for (let i = 0; i < SHEET_POINTS; i++) {
        if (this.state[i] !== 1 && this.state[i] !== 2) continue;
        const p = i * STRIDE;
        this.ocean.simulation.returnWater(this.originX, this.originZ, this.width,
          this.data[p + 6]!, this.data[p + 3]!, this.data[p + 5]!);
      }
    }
    this.age = this.renderedAge = this.rows = this.airborne = 0;
    this.pendingVolume = this.pendingWork = this.entrained = 0;
    this.impulseX = this.impulseZ = this.allocatedWork = this.waveCredit = 0;
    this.feeding = false;
    this.state.fill(0);
    this.cellArea.fill(0);
    this.cellGrowth.fill(0);
    this.bubbles.fill(-1);
    this.bubbleCursor = this.bubblesAlive = 0;
    this.aeration.visible = false;
    this.sheet.visible = this.drops.visible = false;
    this.sheet.geometry.setDrawRange(0, 0);
    for (let i = 0; i < SHEET_POINTS; i++) this.drops.setMatrixAt(i, this.hidden);
    this.drops.instanceMatrix.needsUpdate = true;
  }

  private buildCollar(height: number): void {
    const p = this.rock.geometry.getAttribute('position').array;
    const m = this.matrix.makeRotationFromQuaternion(this.rock.quaternion).elements;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i]!, y = p[i + 1]!, z = p[i + 2]!;
      this.cache[i] = m[0]! * x + m[4]! * y + m[8]! * z;
      this.cache[i + 1] = m[1]! * x + m[5]! * y + m[9]! * z;
      this.cache[i + 2] = m[2]! * x + m[6]! * y + m[10]! * z;
    }
    this.collar.fill(0);
    this.tangent.fill(0);
    const q = this.cache, indices = this.rock.geometry.getIndex()!.array;
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t]! * 3, b = indices[t + 1]! * 3, c = indices[t + 2]! * 3;
      const ay = q[a + 1]!, by = q[b + 1]!, cy = q[c + 1]!;
      if (Math.min(ay, by, cy) > height || Math.max(ay, by, cy) < height) continue;
      let hits = 0, x1 = 0, z1 = 0, x2 = 0, z2 = 0;
      for (let edge = 0; edge < 3; edge++) {
        const from = edge === 0 ? a : edge === 1 ? b : c;
        const to = edge === 0 ? b : edge === 1 ? c : a;
        const y0 = q[from + 1]!, y1 = q[to + 1]!;
        if ((y0 <= height) === (y1 <= height)) continue;
        const u = (height - y0) / (y1 - y0);
        const x = q[from]! + (q[to]! - q[from]!) * u;
        const z = q[from + 2]! + (q[to + 2]! - q[from + 2]!) * u;
        if (hits++ === 0) { x1 = x; z1 = z; } else { x2 = x; z2 = z; }
      }
      if (hits !== 2) continue;
      let angle1 = Math.atan2(z1, x1), angle2 = Math.atan2(z2, x2);
      if (angle2 - angle1 > Math.PI) angle2 -= TAU;
      else if (angle1 - angle2 > Math.PI) angle2 += TAU;
      const dx = x2 - x1, dz = z2 - z1;
      const ux = q[b]! - q[a]!, uy = by - ay, uz = q[b + 2]! - q[a + 2]!;
      const vx = q[c]! - q[a]!, vy = cy - ay, vz = q[c + 2]! - q[a + 2]!;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (let raw = Math.ceil(Math.min(angle1, angle2) * SECTORS / TAU);
        raw <= Math.floor(Math.max(angle1, angle2) * SECTORS / TAU); raw++) {
        const s = (raw % SECTORS + SECTORS) % SECTORS;
        const cosine = Math.cos(s * TAU / SECTORS), sine = Math.sin(s * TAU / SECTORS);
        const denominator = cosine * dz - sine * dx;
        if (Math.abs(denominator) < 1e-9) continue;
        const radius = (x1 * dz - z1 * dx) / denominator;
        const fraction = (x1 * sine - z1 * cosine) / denominator;
        if (radius <= this.collar[s]! || fraction < -1e-6 || fraction > 1 + 1e-6) continue;
        this.collar[s] = radius;
        this.tangent[s] = Math.abs(ny) > 1e-8 ? -(nx * cosine + nz * sine) / ny : 3;
      }
    }
  }

  feed(body: EntryBody, step: EntryStep, water: EntryWater): void {
    this.impulseX = this.impulseZ = this.allocatedWork = this.waveCredit = 0;
    if (!this.feeding) return;
    const room = Math.max(0, body.volume * ENTRAINMENT - this.entrained - this.pendingVolume);
    const volume = Math.min(room, step.displacedVolume * ENTRAINMENT);
    if (volume > 0 && step.normalSpeed > 0) {
      this.pendingVolume += volume;
      this.allocatedWork = step.work * EJECTA_WORK;
      this.pendingWork += this.allocatedWork;
    }
    const final = step.submerged > 0.995 || step.grounded || this.rows === ROWS;
    const quantum = body.volume * ENTRAINMENT / ROWS;
    if (this.rows < ROWS && this.pendingWork > 0 && this.pendingVolume > 1e-8
      && (this.pendingVolume >= quantum || final)) {
      this.emitRing(body, water);
    }
    if (final) {
      this.feeding = false;
      this.waveCredit += this.pendingWork;
      this.pendingWork = this.pendingVolume = 0;
    }
  }

  private emitRing(body: EntryBody, water: EntryWater): void {
    this.buildCollar(water.height - body.y);
    const row = this.rows++, d = this.data;
    const requested = this.pendingVolume / SECTORS;
    let a = 0, b = 0, c = 0, actualVolume = 0;
    const rx = body.vx - water.velocityX, ry = body.vy - water.velocityY, rz = body.vz - water.velocityZ;
    const normalVelocity = (ry - rx * water.slopeX - rz * water.slopeZ)
      / (1 + water.slopeX ** 2 + water.slopeZ ** 2);
    // Project onto the water tangent, then bound the bias below the radial
    // component. Grazing motion must not align every parcel along the path.
    const biasScale = 0.5 / Math.max(Math.hypot(rx, ry, rz), 1e-8);
    const biasX = (rx + normalVelocity * water.slopeX) * biasScale;
    const biasZ = (rz + normalVelocity * water.slopeZ) * biasScale;
    const capRadius = body.radius * Math.sqrt(Math.max(0, 1 - ((water.height - body.y) / body.radius) ** 2));
    for (let s = 0; s < SECTORS; s++) {
      const id = row * SECTORS + s, p = id * STRIDE;
      const cosine = Math.cos(s * TAU / SECTORS), sine = Math.sin(s * TAU / SECTORS);
      const radius = Math.max(0.05, this.collar[s]!, capRadius * 0.6) + 0.015;
      const x = body.x + cosine * radius, z = body.z + sine * radius;
      this.ocean.simulation.takeWater(x, z, Math.max(0.2, body.radius * 0.4), requested, this.parcel);
      const volume = this.parcel.volume;
      if (volume <= 1e-10) { this.state[id] = 3; continue; }
      const mass = WATER_DENSITY * volume;
      this.ocean.sampleSurface(x, z, this.sample);
      d[p] = x; d[p + 1] = this.sample.x + 0.012; d[p + 2] = z;
      const tangent = Math.max(0.25, Math.min(3, Math.abs(this.tangent[s]!)));
      const nx = cosine * tangent, ny = -1, nz = sine * tangent;
      const speed = Math.max(0, (rx * nx + ry * ny + rz * nz) / Math.sqrt(tangent * tangent + 1));
      // Dynamic head p=rho*v_n²/2 gives discharge speed sqrt(2p/rho).
      // The solid tangent redirects that velocity; its slope is not a speed
      // multiplier. This also stays bounded for almost-grazing entries.
      const tx = cosine + biasX, ty = tangent + 0.35, tz = sine + biasZ;
      const redirect = speed / Math.hypot(tx, ty, tz);
      d[p + 3] = redirect * tx;
      d[p + 4] = redirect * ty;
      d[p + 5] = redirect * tz;
      d[p + 6] = volume;
      d[p + 7] = Math.cbrt(3 * volume / (4 * Math.PI));
      d[p + 8] = this.parcel.momentumX / mass;
      d[p + 9] = this.parcel.momentumZ / mass;
      a += 0.5 * mass * (d[p + 3]! ** 2 + d[p + 4]! ** 2 + d[p + 5]! ** 2);
      b += mass * (d[p + 8]! * d[p + 3]! + d[p + 9]! * d[p + 5]!);
      c += 0.5 * mass * (d[p + 8]! ** 2 + d[p + 9]! ** 2) - this.parcel.kineticEnergy
        + mass * GRAVITY * d[p + 1]! - this.parcel.potentialEnergy;
      actualVolume += volume;
      this.state[id] = 1;
      this.airborne++;
    }
    const work = this.pendingWork * 0.85;
    if (c > work) {
      for (let s = 0; s < SECTORS; s++) {
        const id = row * SECTORS + s, p = id * STRIDE;
        if (this.state[id] !== 1) continue;
        this.ocean.simulation.returnWater(d[p]!, d[p + 2]!, Math.max(0.2, body.radius * 0.4),
          d[p + 6]!, d[p + 8]!, d[p + 9]!);
        this.state[id] = 3;
        this.airborne--;
      }
      this.waveCredit += this.pendingWork;
      this.pendingWork = this.pendingVolume = 0;
      return;
    }
    // Work is a ceiling, not a target to concentrate into a tiny parcel.
    const speedScale = a > 0 ? Math.min(1, Math.max(0,
      (-b + Math.sqrt(Math.max(0, b * b + 4 * a * (work - c)))) / (2 * a))) : 0;
    for (let s = 0; s < SECTORS; s++) {
      const id = row * SECTORS + s, p = id * STRIDE;
      if (this.state[id] !== 1) continue;
      const mass = WATER_DENSITY * d[p + 6]!;
      d[p + 3] *= speedScale; d[p + 4] *= speedScale; d[p + 5] *= speedScale;
      this.impulseX += mass * d[p + 3]!;
      this.impulseZ += mass * d[p + 5]!;
      d[p + 3] += d[p + 8]!; d[p + 5] += d[p + 9]!;
      if ((s + row) % 5 === 0) this.aerate(d[p]!, d[p + 2]!, d[p + 7]! * 0.6, d[p + 8]!, d[p + 9]!);
    }
    this.entrained += actualVolume;
    this.waveCredit += this.pendingWork - Math.max(0, a * speedScale * speedScale + b * speedScale + c);
    this.pendingWork = this.pendingVolume = 0;
    if (row > 0) {
      for (let s = 0; s < SECTORS; s++) {
        this.cellArea[(row - 1) * SECTORS + s] = this.quadArea((row - 1) * SECTORS + s);
      }
    }
  }

  advance(dt: number): void {
    this.age += dt;
    const d = this.data;
    for (let i = 0; i < SHEET_POINTS; i++) {
      if (this.state[i] !== 1 && this.state[i] !== 2) continue;
      const p = i * STRIDE, radius = d[p + 7]!;
      const oldVy = d[p + 4]!;
      const drag = 3 * AIR_DENSITY * AIR_DRAG / (8 * WATER_DENSITY * radius);
      const damping = 1 / (1 + drag * Math.hypot(d[p + 3]!, oldVy, d[p + 5]!) * dt);
      d[p + 3] *= damping;
      d[p + 4] = (oldVy - GRAVITY * dt) * damping;
      d[p + 5] *= damping;
      d[p] += d[p + 3]! * dt;
      d[p + 1] += (oldVy + d[p + 4]!) * 0.5 * dt;
      d[p + 2] += d[p + 5]! * dt;
      if (d[p + 4]! >= 0) continue;
      this.ocean.simulation.sampleKinematics(d[p]!, d[p + 2]!, this.water);
      if (d[p + 1]! > Math.max(this.water.height, this.water.bed)) continue;
      this.aerate(d[p]!, d[p + 2]!, radius * 0.5, this.water.velocityX, this.water.velocityZ);
      // The complete parcel survives until actual re-entry. There is no 1.4s
      // deletion; its volume and momentum go back to the physical grid.
      const x = Math.max(-99, Math.min(99, d[p]!));
      const z = Math.max(-99, Math.min(99, d[p + 2]!));
      this.ocean.simulation.returnWater(x, z, Math.max(0.16, radius * 3), d[p + 6]!, d[p + 3]!, d[p + 5]!);
      const energy = 0.5 * WATER_DENSITY * d[p + 6]! * d[p + 4]! ** 2;
      this.ocean.simulation.coupleBody(x, z, Math.max(0.2, radius * 3), 0, 0, 0, energy);
      this.state[i] = 3;
      this.airborne--;
    }
  }

  private aerate(x: number, z: number, radius: number, vx: number, vz: number): void {
    const p = (this.bubbleCursor++ % AERATION_POINTS) * 7;
    this.bubbles[p] = x; this.bubbles[p + 1] = z; this.bubbles[p + 2] = radius;
    this.bubbles[p + 3] = this.age; this.bubbles[p + 4] = 0.4 + radius * 12;
    this.bubbles[p + 5] = vx; this.bubbles[p + 6] = vz;
  }

  private renderAeration(): void {
    this.bubblesAlive = 0;
    for (let i = 0; i < AERATION_POINTS; i++) {
      const p = i * 7, born = this.bubbles[p + 3]!, age = this.age - born;
      if (born < 0 || age >= this.bubbles[p + 4]!) {
        this.aeration.setMatrixAt(i, this.hidden);
        continue;
      }
      const x = this.bubbles[p]! + age * this.bubbles[p + 5]!;
      const z = this.bubbles[p + 1]! + age * this.bubbles[p + 6]!;
      this.ocean.sampleSurface(x, z, this.sample);
      const radius = this.bubbles[p + 2]! * Math.sqrt(1 - age / this.bubbles[p + 4]!);
      this.matrix.makeScale(radius, radius * 0.35, radius).setPosition(x, this.sample.x + 0.014, z);
      this.aeration.setMatrixAt(i, this.matrix);
      this.bubblesAlive++;
    }
    this.aeration.instanceMatrix.needsUpdate = true;
    this.aeration.visible = this.bubblesAlive > 0;
  }

  private quadArea(cell: number): number {
    const row = (cell / SECTORS) | 0, s = cell % SECTORS;
    const a = cell * STRIDE, b = (row * SECTORS + (s + 1) % SECTORS) * STRIDE;
    const c = (cell + SECTORS) * STRIDE, d = this.data;
    const ux = d[b]! - d[a]!, uy = d[b + 1]! - d[a + 1]!, uz = d[b + 2]! - d[a + 2]!;
    const vx = d[c]! - d[a]!, vy = d[c + 1]! - d[a + 1]!, vz = d[c + 2]! - d[a + 2]!;
    return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }

  private distanceSquared(a: number, b: number): number {
    const d = this.data, p = a * STRIDE, q = b * STRIDE;
    return (d[p]! - d[q]!) ** 2 + (d[p + 1]! - d[q + 1]!) ** 2 + (d[p + 2]! - d[q + 2]!) ** 2;
  }

  render(): void {
    const dt = this.age - this.renderedAge;
    this.renderedAge = this.age;
    const d = this.data, p = this.sheet.geometry.getAttribute('position') as THREE.BufferAttribute;
    const indices = this.sheet.geometry.getIndex()!;
    this.linked.fill(0);
    let count = 0;
    for (let i = 0; i < this.rows * SECTORS; i++) p.setXYZ(i, d[i * STRIDE]!, d[i * STRIDE + 1]!, d[i * STRIDE + 2]!);
    for (let row = 0; row < this.rows - 1; row++) {
      for (let s = 0; s < SECTORS; s++) {
        const a = row * SECTORS + s, b = row * SECTORS + (s + 1) % SECTORS;
        const c = a + SECTORS, e = b + SECTORS;
        if (this.cellGrowth[a]! >= 1 || this.cellArea[a]! <= 1e-10
          || this.state[a] !== 1 || this.state[b] !== 1 || this.state[c] !== 1 || this.state[e] !== 1) continue;
        // Area growth alone accepts rows born far apart and long, thin cells.
        // Bound every edge and both diagonals to the body-scale collar width;
        // once separated, these material neighbours can never reconnect.
        const ab = this.distanceSquared(a, b), ac = this.distanceSquared(a, c);
        const ae = this.distanceSquared(a, e), bc = this.distanceSquared(b, c);
        const be = this.distanceSquared(b, e), ce = this.distanceSquared(c, e);
        const spanSquared = Math.max(ab, ac, ae, bc, be, ce);
        if (spanSquared > this.width * this.width) {
          this.cellGrowth[a] = 1;
          continue;
        }
        const area = this.quadArea(a);
        const bp = b * STRIDE, cp = c * STRIDE, ep = e * STRIDE;
        const ux = d[cp]! - d[bp]!, uy = d[cp + 1]! - d[bp + 1]!, uz = d[cp + 2]! - d[bp + 2]!;
        const vx = d[ep]! - d[bp]!, vy = d[ep + 1]! - d[bp + 1]!, vz = d[ep + 2]! - d[bp + 2]!;
        const secondArea = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
        // For each rendered triangle, longestEdge² / twiceArea is its
        // longest-edge/altitude ratio. Reject compressed and sheared slivers,
        // even when their area shrinks and capillary stretch cannot increase.
        if (Math.max(ab, ac, bc) > MAX_SHEET_ASPECT * area
          || Math.max(bc, be, ce) > MAX_SHEET_ASPECT * secondArea) {
          this.cellGrowth[a] = 1;
          continue;
        }
        const stretch = area / this.cellArea[a]!;
        const volume = (d[a * STRIDE + 6]! + d[b * STRIDE + 6]! + d[c * STRIDE + 6]! + d[e * STRIDE + 6]!) * 0.25;
        const thickness = volume / Math.max(area, 1e-8);
        const ligament = Math.sqrt(thickness * Math.sqrt(Math.max(area, 1e-8)) / Math.PI);
        const capillary = Math.sqrt(WATER_DENSITY * ligament ** 3 / SURFACE_TENSION);
        this.cellGrowth[a] += dt * Math.max(0, stretch - 1) / Math.max(capillary, 1e-4);
        if (this.cellGrowth[a]! >= 1) continue;
        indices.setX(count++, a); indices.setX(count++, c); indices.setX(count++, b);
        indices.setX(count++, b); indices.setX(count++, c); indices.setX(count++, e);
        this.linked[a] = this.linked[b] = this.linked[c] = this.linked[e] = 1;
      }
    }
    // The newest row may still receive its following material ring. Older
    // disconnected nodes become real drops carrying the same volume.
    for (let i = 0; i < Math.max(0, this.rows - Number(this.feeding)) * SECTORS; i++) {
      if (this.state[i] === 1 && !this.linked[i]) this.state[i] = 2;
    }
    this.sheet.geometry.setDrawRange(0, count);
    this.sheet.visible = count > 0;
    if (count > 0) normals(this.sheet.geometry);
    let visible = 0;
    for (let i = 0; i < SHEET_POINTS; i++) {
      const q = i * STRIDE;
      if (this.state[i] !== 2) { this.drops.setMatrixAt(i, this.hidden); continue; }
      const radius = d[q + 7]!;
      this.matrix.makeScale(radius, radius, radius).setPosition(d[q]!, d[q + 1]!, d[q + 2]!);
      this.drops.setMatrixAt(i, this.matrix);
      visible++;
    }
    this.drops.instanceMatrix.needsUpdate = true;
    this.drops.visible = visible > 0;
    this.renderAeration();
  }

  dispose(): void {
    this.group.removeFromParent();
    this.sheet.geometry.dispose();
    this.drops.dispose();
    this.aeration.dispose();
  }
}

export function createEntrySplashes(ocean: OceanPlane): {
  create(rock: THREE.Mesh<THREE.BufferGeometry>): EntrySplash;
  dispose(): void;
} {
  const optics = createEntryWaterOptics(ocean.mesh.material as THREE.MeshPhysicalMaterial);
  const material = optics.createMaterial(0.012);
  const dropGeometry = new THREE.SphereGeometry(1, 12, 8);
  const aerationGeometry = new THREE.SphereGeometry(1, 8, 6);
  const aerationMaterial = new THREE.MeshStandardMaterial({
    color: 0xeaf7f5, roughness: 0.8, transparent: true, opacity: 0.52, depthWrite: false,
  });
  return {
    create(rock) {
      const splash = new EntrySplash(ocean, rock, material, dropGeometry, aerationGeometry, aerationMaterial);
      splash.sheet.onBeforeRender = splash.drops.onBeforeRender = optics.beforeRender;
      return splash;
    },
    dispose() { dropGeometry.dispose(); aerationGeometry.dispose(); aerationMaterial.dispose(); material.dispose(); optics.dispose(); },
  };
}
