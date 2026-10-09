/** Local face loads in metre/kg/second scene units. A reduced-order hull model,
 * not a rigid-body collision or two-way fluid/solid solver. */
export interface FluidField {
  readonly surfaceData: Float32Array;
  readonly flowData: Float32Array;
  sample(x: number, z: number, target: { x: number; y: number; z: number }): void;
  sampleChannel(data: Float32Array, x: number, z: number, channel: number): number;
}

export interface WaveContact {
  x: number;
  z: number;
  /** Bottom of the vertical face, relative to mean sea level. */
  baseY: number;
  width: number;
  height: number;
  /** Into the exposed face: an eastward incident flow loads a +X normal. */
  normalX: number;
  normalZ: number;
  velocityX: number;
  velocityZ: number;
}

export interface WaveLoad {
  forceX: number;
  forceZ: number;
  pressure: number;
  immersion: number;
  influence: number;
  breaking: number;
}

export interface BuoyantBodyParams {
  x: number;
  z: number;
  yaw: number;
  /** Hull-local Z half-length and X half-width, before Three's +Y yaw. */
  halfLength: number;
  halfWidth: number;
  draft: number;
  mass: number;
  /** Horizontal mooring stiffness, N/m. Zero permits free drift. */
  mooring: number;
}

export interface BuoyantBodyState {
  heave: number;
  /** Right-handed rotations about local +X and +Z, respectively. */
  pitch: number;
  roll: number;
  surgeX: number;
  surgeZ: number;
  velocityX: number;
  velocityZ: number;
  load: number;
}

const GRAVITY = 9.81;
const DENSITY = 1000;
const DRAG = 1.05;
const DRY = 1e-5;
const faceSurface = { x: 0, y: 0, z: 0 };

/** Incoming normal momentum determines drag; only actual wetted area receives
 * force. The descending front of a crest adds a bounded slamming multiplier.
 * The dimensionless influence compares pressure to a hydrostatic depth scale. */
export function sampleWaveLoad(water: FluidField, contact: WaveContact, out: WaveLoad): void {
  out.forceX = out.forceZ = out.pressure = out.immersion = out.influence = out.breaking = 0;
  if (contact.width <= 0 || contact.height <= 0) return;
  const depth = water.sampleChannel(water.surfaceData, contact.x, contact.z, 3);
  if (depth <= DRY) return;
  water.sample(contact.x, contact.z, faceSurface);
  const eta = faceSurface.x;
  const bottom = Math.max(contact.baseY, eta - depth);
  const top = Math.min(contact.baseY + contact.height, eta);
  const wettedHeight = Math.max(0, top - bottom);
  out.immersion = wettedHeight / contact.height;
  if (wettedHeight === 0) return;

  const normalLength = Math.hypot(contact.normalX, contact.normalZ);
  if (normalLength === 0) return;
  const nx = contact.normalX / normalLength, nz = contact.normalZ / normalLength;
  const ux = water.sampleChannel(water.flowData, contact.x, contact.z, 0) - contact.velocityX;
  const uz = water.sampleChannel(water.flowData, contact.x, contact.z, 1) - contact.velocityZ;
  const incoming = ux * nx + uz * nz;
  if (incoming <= 0) return;
  const incidence = incoming / Math.hypot(ux, uz);
  const frontSlope = Math.max(0, -faceSurface.y * nx - faceSurface.z * nz);
  const front = frontSlope / (frontSlope + 0.12);
  const froude = incoming / Math.sqrt(GRAVITY * depth);
  const breaking = front * froude / (1 + froude);
  const dynamic = 0.5 * DENSITY * DRAG * incoming * incoming;
  const hydrostatic = DENSITY * GRAVITY * Math.max(0, eta) * incidence * incidence;
  const pressure = dynamic * (1 + 0.35 * breaking) + hydrostatic;
  const force = pressure * contact.width * wettedHeight;
  out.forceX = nx * force;
  out.forceZ = nz * force;
  out.pressure = pressure;
  out.breaking = breaking;
  out.influence = out.immersion * pressure / (pressure + DENSITY * GRAVITY * depth);
}

/** Four waterplane supports supply buoyancy/torque, four vertical faces supply
 * flow drag. Waterplane area follows the supplied mass and equilibrium draft;
 * added mass and near-critical radiation damping approximate unresolved hull flow.
 * All positions/angles are offsets from rest. No hidden time cap or pose snapping. */
export class BuoyantBody {
  readonly state: BuoyantBodyState = {
    heave: 0, pitch: 0, roll: 0, surgeX: 0, surgeZ: 0, velocityX: 0, velocityZ: 0, load: 0,
  };
  private readonly cosYaw: number;
  private readonly sinYaw: number;
  private readonly supportArea: number;
  private readonly effectiveMass: number;
  private readonly pitchInertia: number;
  private readonly rollInertia: number;
  private readonly heaveDamping: number;
  private readonly pitchDamping: number;
  private readonly rollDamping: number;
  private readonly mooringDamping: number;
  private readonly maxStep: number;
  private heaveVelocity = 0;
  private pitchVelocity = 0;
  private rollVelocity = 0;
  private readonly surface = { x: 0, y: 0, z: 0 };
  private readonly contact: WaveContact = {
    x: 0, z: 0, baseY: 0, width: 0, height: 0, normalX: 0, normalZ: 0, velocityX: 0, velocityZ: 0,
  };
  private readonly faceLoad: WaveLoad = { forceX: 0, forceZ: 0, pressure: 0, immersion: 0, influence: 0, breaking: 0 };

  constructor(private readonly water: FluidField, private readonly params: BuoyantBodyParams) {
    this.cosYaw = Math.cos(params.yaw);
    this.sinYaw = Math.sin(params.yaw);
    this.supportArea = params.mass / (DENSITY * params.draft * 4);
    this.effectiveMass = params.mass * 1.3;
    this.pitchInertia = params.mass * (params.halfLength ** 2 + params.draft ** 2) / 3 * 1.3;
    this.rollInertia = params.mass * (params.halfWidth ** 2 + params.draft ** 2) / 3 * 1.3;
    const heaveStiffness = DENSITY * GRAVITY * this.supportArea * 4;
    const pitchStiffness = heaveStiffness * params.halfLength ** 2;
    const rollStiffness = heaveStiffness * params.halfWidth ** 2;
    this.heaveDamping = 1.7 * Math.sqrt(heaveStiffness * this.effectiveMass);
    this.pitchDamping = 1.7 * Math.sqrt(pitchStiffness * this.pitchInertia);
    this.rollDamping = 1.7 * Math.sqrt(rollStiffness * this.rollInertia);
    this.mooringDamping = 1.5 * Math.sqrt(params.mooring * this.effectiveMass);
    const fastest = Math.sqrt(Math.max(heaveStiffness / this.effectiveMass,
      pitchStiffness / this.pitchInertia, rollStiffness / this.rollInertia,
      params.mooring / this.effectiveMass));
    this.maxStep = Math.min(1 / 120, 0.15 / fastest);
  }

  advance(seconds: number, reducedMotion = false): void {
    if (reducedMotion || !Number.isFinite(seconds) || seconds <= 0) return;
    const p = this.params, s = this.state, c = this.cosYaw, sn = this.sinYaw;
    let remaining = seconds;
    while (remaining > 1e-12) {
      const dt = Math.min(remaining, this.maxStep);
      let upward = 0, pitchMoment = 0, rollMoment = 0;
      for (let i = 0; i < 4; i += 1) {
        const lx = (i & 1 ? 1 : -1) * p.halfWidth;
        const lz = (i & 2 ? 1 : -1) * p.halfLength;
        const x = p.x + s.surgeX + c * lx + sn * lz;
        const z = p.z + s.surgeZ - sn * lx + c * lz;
        this.water.sample(x, z, this.surface);
        const depth = this.water.sampleChannel(this.water.surfaceData, x, z, 3);
        const keel = s.heave + s.roll * lx - s.pitch * lz - p.draft;
        const column = depth > DRY ? Math.max(0, Math.min(this.surface.x - keel, depth, p.draft * 2.5)) : 0;
        const force = DENSITY * GRAVITY * this.supportArea * column;
        upward += force;
        pitchMoment -= lz * force;
        rollMoment += lx * force;
      }
      this.heaveVelocity = (this.heaveVelocity + dt * (upward - p.mass * GRAVITY) / this.effectiveMass)
        / (1 + dt * this.heaveDamping / this.effectiveMass);
      this.pitchVelocity = (this.pitchVelocity + dt * pitchMoment / this.pitchInertia)
        / (1 + dt * this.pitchDamping / this.pitchInertia);
      this.rollVelocity = (this.rollVelocity + dt * rollMoment / this.rollInertia)
        / (1 + dt * this.rollDamping / this.rollInertia);
      s.heave += dt * this.heaveVelocity;
      s.pitch += dt * this.pitchVelocity;
      s.roll += dt * this.rollVelocity;

      let forceX = 0, forceZ = 0;
      for (let i = 0; i < 4; i += 1) {
        const sign = i & 1 ? 1 : -1;
        const lx = i < 2 ? sign * p.halfWidth : 0;
        const lz = i < 2 ? 0 : sign * p.halfLength;
        const nx = i < 2 ? -sign : 0;
        const nz = i < 2 ? 0 : -sign;
        const contact = this.contact;
        contact.x = p.x + s.surgeX + c * lx + sn * lz;
        contact.z = p.z + s.surgeZ - sn * lx + c * lz;
        contact.baseY = s.heave + s.roll * lx - s.pitch * lz - p.draft;
        contact.width = i < 2 ? p.halfLength * 2 : p.halfWidth * 2;
        contact.height = p.draft * 2;
        contact.normalX = c * nx + sn * nz;
        contact.normalZ = -sn * nx + c * nz;
        contact.velocityX = s.velocityX;
        contact.velocityZ = s.velocityZ;
        sampleWaveLoad(this.water, contact, this.faceLoad);
        forceX += this.faceLoad.forceX;
        forceZ += this.faceLoad.forceZ;
      }
      s.velocityX = (s.velocityX + dt * (forceX - p.mooring * s.surgeX) / this.effectiveMass)
        / (1 + dt * this.mooringDamping / this.effectiveMass);
      s.velocityZ = (s.velocityZ + dt * (forceZ - p.mooring * s.surgeZ) / this.effectiveMass)
        / (1 + dt * this.mooringDamping / this.effectiveMass);
      s.surgeX += dt * s.velocityX;
      s.surgeZ += dt * s.velocityZ;
      s.load = Math.hypot(forceX, forceZ);
      remaining -= dt;
    }
  }
}
