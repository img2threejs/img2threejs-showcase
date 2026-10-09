/** Continuous 3D rigid-entry proxy: partial-volume buoyancy, growing added
 * mass with one-sided slamming, semi-implicit quadratic drag, slope-
 * relative closing speed, asymmetric drag torque at the wetted cap
 * centroid, immersed rotational drag, and a non-bouncy seabed contact.
 * The module is import-free so it loads through load-physics.mjs without
 * additional dependency wiring. */

export const WATER_DENSITY = 1000;
export const GRAVITY = 9.81;
export const SURFACE_TENSION = 0.072;

const DRY_FRACTION = 1e-6;
const QUADRATIC_DRAG = 0.8;
const ADDED_MASS_COEFFICIENT = 0.5;
const ROTATIONAL_DRAG = 4.0;
const BED_FRICTION = 0.55;
const BED_ANGULAR_DAMPING = 4.0;

export interface EntryBody {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  wx: number;
  wy: number;
  wz: number;
  radius: number;
  mass: number;
  volume: number;
  inertia: number;
  submergedVolume: number;
}

export interface EntryWater {
  height: number;
  depth: number;
  bed: number;
  slopeX: number;
  slopeZ: number;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
}

export interface EntryStep {
  impulseX: number;
  impulseY: number;
  impulseZ: number;
  work: number;
  displacedVolume: number;
  submerged: number;
  normalSpeed: number;
  grounded: boolean;
}

export function stepWaterEntry(
  body: EntryBody,
  water: EntryWater,
  bottom: number,
  top: number,
  dt: number,
  out: EntryStep,
): void {
  out.impulseX = 0;
  out.impulseY = 0;
  out.impulseZ = 0;
  out.work = 0;
  out.displacedVolume = 0;
  out.submerged = 0;
  out.normalSpeed = 0;
  out.grounded = false;
  if (!(dt > 0) || !Number.isFinite(dt)) return;

  const m = body.mass;
  const r = body.radius;
  const Ry = Math.max(1e-6, (top - bottom) / 2);
  const previousSubmergedVolume = body.submergedVolume;
  const oldAddedMass = ADDED_MASS_COEFFICIENT * WATER_DENSITY * body.submergedVolume;

  const vxOld = body.vx;
  const vyOld = body.vy;
  const vzOld = body.vz;
  const xOld = body.x;
  const yOld = body.y;
  const zOld = body.z;

  // Surface normal (upward) for incoming-speed projection and torque geometry.
  const nLen = Math.hypot(-water.slopeX, 1, -water.slopeZ);
  const nx = nLen > 1e-9 ? -water.slopeX / nLen : 0;
  const ny = nLen > 1e-9 ? 1 / nLen : 1;
  const nz = nLen > 1e-9 ? -water.slopeZ / nLen : 0;

  // Midpoint relative water-plane prediction: surface rises with its own
  // vertical velocity and with the body's motion along the slope.
  const predictedBodyY = body.y + 0.5 * dt * body.vy;
  const surfaceVy = water.velocityY
    + (body.vx - water.velocityX) * water.slopeX
    + (body.vz - water.velocityZ) * water.slopeZ;
  const predictedSurfaceY = water.height + 0.5 * dt * surfaceVy;
  const immersionRaw = predictedSurfaceY - (predictedBodyY + bottom);
  const h = water.depth > 1e-5 && immersionRaw > 0 ? Math.min(2 * Ry, immersionRaw) : 0;
  const s = h / (2 * Ry);
  let fraction = s * s * (3 - 2 * s);
  if (fraction < DRY_FRACTION) fraction = 0;
  if (fraction > 1) fraction = 1;

  const newWetVolume = body.volume * fraction;
  const newAddedMass = ADDED_MASS_COEFFICIENT * WATER_DENSITY * newWetVolume;

  // Wetted projected drag area tracks immersion, not the full disc.
  const wettedArea = Math.PI * r * r * fraction;

  // Spherical-cap centroid measured upward from the bottom of the cap.
  // Its offset below the proxy centre supplies the pressure/drag lever.
  let centroidDown = 0;
  if (h > 1e-9) {
    const denom = 4 * (3 * Ry - h);
    centroidDown = denom > 1e-9 ? Ry - h * (8 * Ry - 3 * h) / denom : Ry - h;
  }
  const leverX = -centroidDown * nx;
  const leverY = -centroidDown * ny;
  const leverZ = -centroidDown * nz;

  // Hydrodynamic (unconstrained) velocity update. Gravity is bundled into
  // the vertical external force so that buoyancy and weight operate on
  // the body mass only; the added mass tracks only the body's motion.
  let vxHydro: number;
  let vyHydro: number;
  let vzHydro: number;
  if (fraction === 0) {
    body.vx = vxOld;
    body.vy = vyOld - GRAVITY * dt;
    body.vz = vzOld;
    vxHydro = body.vx;
    vyHydro = body.vy;
    vzHydro = body.vz;
  } else {
    const vrelX = body.vx - water.velocityX;
    const vrelY = body.vy - water.velocityY;
    const vrelZ = body.vz - water.velocityZ;
    const vrelMag = Math.hypot(vrelX, vrelY, vrelZ);

    // Buoyancy is vertical (world +Y); the surface normal is used only
    // for the closing-speed projection and torque geometry.
    const buoyancyY = WATER_DENSITY * GRAVITY * newWetVolume;

    const dragK = 0.5 * QUADRATIC_DRAG * WATER_DENSITY * wettedArea * vrelMag;

    // Growing added mass decelerates the body; shrinking added mass
    // releases without kicking because the increment is one-sided.
    const deltaAdded = newAddedMass > oldAddedMass ? newAddedMass - oldAddedMass : 0;
    const baseEffective = m + (newAddedMass < oldAddedMass ? newAddedMass : oldAddedMass);
    const denom = baseEffective + deltaAdded + dt * dragK;

    body.vx = (baseEffective * body.vx
      + (deltaAdded + dt * dragK) * water.velocityX) / denom;
    body.vy = (baseEffective * body.vy
      + (deltaAdded + dt * dragK) * water.velocityY
      + dt * (buoyancyY - m * GRAVITY)) / denom;
    body.vz = (baseEffective * body.vz
      + (deltaAdded + dt * dragK) * water.velocityZ) / denom;

    vxHydro = body.vx;
    vyHydro = body.vy;
    vzHydro = body.vz;

    // Asymmetric drag torque at the cap centroid.
    const fxDrag = -dragK * vrelX;
    const fyDrag = -dragK * vrelY;
    const fzDrag = -dragK * vrelZ;
    const torqueX = leverY * fzDrag - leverZ * fyDrag;
    const torqueY = leverZ * fxDrag - leverX * fzDrag;
    const torqueZ = leverX * fyDrag - leverY * fxDrag;

    // Immersed rotational drag: ~0.5*rho*Crot*r^5*|omega|*fraction plus
    // a translational coupling ~r^4*relativeSpeed; implicit in inertia.
    const omegaMag = Math.hypot(body.wx, body.wy, body.wz);
    const rotDamp = ROTATIONAL_DRAG * WATER_DENSITY * fraction
      * (0.5 * r ** 5 * omegaMag + r ** 4 * vrelMag);
    const rotDenom = 1 + dt * rotDamp / Math.max(1e-9, body.inertia);
    body.wx = (body.wx + dt * torqueX / body.inertia) / rotDenom;
    body.wy = (body.wy + dt * torqueY / body.inertia) / rotDenom;
    body.wz = (body.wz + dt * torqueZ / body.inertia) / rotDenom;

    // Water impulse on water: closed BEFORE the seabed constraint so
    // terrain momentum never reaches the water reaction.
    out.impulseX = m * (vxOld - vxHydro);
    out.impulseY = m * (vyOld - vyHydro - GRAVITY * dt);
    out.impulseZ = m * (vzOld - vzHydro);
    out.normalSpeed = -(vrelX * nx + vrelY * ny + vrelZ * nz);
  }

  // Trapezoidal position update; seabed projection below constrains the
  // displacement used to measure hydrodynamic work.
  body.x = xOld + 0.5 * (vxOld + vxHydro) * dt;
  body.y = yOld + 0.5 * (vyOld + vyHydro) * dt;
  body.z = zOld + 0.5 * (vzOld + vzHydro) * dt;

  // Seabed contact: non-bouncy normal projection at bed-bottom, plus
  // Coulomb friction and rolling damping. None of this enters out.impulse.
  const restingY = water.bed - bottom;
  if (body.y < restingY) {
    body.y = restingY;
    if (body.vy < 0) body.vy = 0;
    const tangentSpeed = Math.hypot(body.vx, body.vz);
    if (tangentSpeed > 1e-9) {
      const frictionLimit = (BED_FRICTION * GRAVITY * dt)
        / (tangentSpeed + 1e-9);
      const reduce = frictionLimit < 1 ? frictionLimit : 1;
      body.vx *= 1 - reduce;
      body.vz *= 1 - reduce;
    }
    out.grounded = true;
  }
  if (out.grounded) {
    const rollDenom = 1 + dt * BED_ANGULAR_DAMPING;
    body.wx /= rollDenom;
    body.wy /= rollDenom;
    body.wz /= rollDenom;
  }

  // Extracted work is derived from the actual post-ground body velocity
  // (constrained displacement / dt) relative to the fluid, not from an
  // unconstrained hydrodynamic predictor. A body resting on the bed in
  // still water has zero displacement and therefore zero work even
  // though buoyancy continues to act.
  if (fraction > 0) {
    const actualVx = (body.x - xOld) / dt;
    const actualVy = (body.y - yOld) / dt;
    const actualVz = (body.z - zOld) / dt;
    const relVx = actualVx - water.velocityX;
    const relVy = actualVy - water.velocityY;
    const relVz = actualVz - water.velocityZ;
    const dot = out.impulseX * relVx + out.impulseY * relVy + out.impulseZ * relVz;
    out.work = dot > 0 ? dot : 0;
  }

  out.submerged = fraction;
  out.displacedVolume = newWetVolume > previousSubmergedVolume
    ? newWetVolume - previousSubmergedVolume
    : 0;
  body.submergedVolume = newWetVolume;
}