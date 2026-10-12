import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPhysicsModule } from './load-physics.mjs';

const { ShallowWater } = await loadPhysicsModule('shallowWater');

const RHO = 1000;
const GRAVITY = 9.81;

function totalVolume(flow) {
  let v = 0;
  for (let i = 0; i < flow.depth.length; i += 1) v += flow.depth[i] * flow.cellWidths[i % flow.size] * flow.cellWidths[(i / flow.size) | 0];
  return v + flow.absorbedVolume;
}

function maxAbs(array) {
  let peak = 0;
  for (let i = 0; i < array.length; i += 1) {
    const v = array[i];
    if (v > peak) peak = v;
    else if (-v > peak) peak = -v;
  }
  return peak;
}

function sampleAt(flow, x, z) {
  flow.pack();
  const target = { x: 0, y: 0, z: 0 };
  flow.sample(x, z, target);
  return target;
}

function totalMomentum(flow) {
  let mx = 0, mz = 0;
  for (let i = 0; i < flow.depth.length; i += 1) {
    const area = flow.cellWidths[i % flow.size] * flow.cellWidths[(i / flow.size) | 0];
    mx += RHO * flow.momentumX[i] * area;
    mz += RHO * flow.momentumZ[i] * area;
  }
  return { mx, mz };
}

function totalEnergy(flow) {
  let energy = 0;
  for (let i = 0; i < flow.depth.length; i++) {
    const h = flow.depth[i], area = flow.cellWidths[i % flow.size] * flow.cellWidths[(i / flow.size) | 0];
    // Omitting the constant -rho*g*bed²/2 avoids cancellation in a rest lake.
    energy += 0.5 * RHO * GRAVITY * area * (h + flow.bed[i]) ** 2;
    if (h > 0) energy += 0.5 * RHO * area * (flow.momentumX[i] ** 2 + flow.momentumZ[i] ** 2) / h;
  }
  return energy;
}

const emptyParcel = () => ({ volume: 0, momentumX: 0, momentumZ: 0, kineticEnergy: 0, potentialEnergy: 0 });
const emptyWater = () => ({ height: 0, depth: 0, bed: 0, slopeX: 0, slopeZ: 0, velocityX: 0, velocityY: 0, velocityZ: 0 });
const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

/** Apply a body impact at (x, z) that displaces a cavity consistent with
 *  the splash radius, deposits the body's opposite horizontal impulse into
 *  the wet-mass-weighted momentum field, and converts the rest of the
 *  work into a zero-net-momentum radial wave. */
function applyImpact(flow, x, z, radius, verticalSpeed, impulseX = 0, impulseZ = 0) {
  const restingDepth = sampleAt(flow, x, z).x - flow.sampleScalar(flow.bed, x, z);
  const cavityDepth = Math.min(radius * 0.9, Math.max(0.05, restingDepth * 0.85));
  const displacedVolume = cavityDepth * Math.PI * radius * radius;
  const work = 0.5 * RHO * displacedVolume * verticalSpeed * verticalSpeed
    + RHO * GRAVITY * displacedVolume * radius;
  return flow.coupleBody(x, z, radius, displacedVolume, impulseX, impulseZ, work);
}

test('coupleBody carves a depression that dips below sea level but stays above bed', () => {
  const flow = new ShallowWater(() => -1.4);
  const before = totalVolume(flow);
  applyImpact(flow, 5, 1, 0.72, Math.sqrt(2 * GRAVITY * 4));
  const surface = sampleAt(flow, 5, 1).x;
  assert.ok(surface < -0.1, `centre must dip below resting sea level: ${surface}`);
  assert.ok(surface >= -1.4, `centre must stay above bed: ${surface}`);
  assert.ok(Math.abs(totalVolume(flow) - before) < 1e-6,
    `impact must conserve volume: ${totalVolume(flow)} vs ${before}`);
  for (const depth of flow.depth) assert.ok(depth > 0, 'deep impact must not drain a cell dry');
});

test('coupleBody on shallow shore stays nonnegative and conserves volume', () => {
  const bedAt = (x, z) => Math.max(-0.4, Math.min(0.8, x * 0.25));
  const flow = new ShallowWater(bedAt);
  const before = totalVolume(flow);
  applyImpact(flow, -1.5, 0, 0.72, Math.sqrt(2 * GRAVITY * 4));
  assert.ok(Math.abs(totalVolume(flow) - before) < 1e-6,
    `shallow impact must conserve volume: ${totalVolume(flow)} vs ${before}`);
  for (let i = 0; i < flow.depth.length; i += 1) {
    assert.ok(flow.depth[i] >= -1e-9, `depth stays nonnegative at cell ${i}: ${flow.depth[i]}`);
  }
});

test('meteor-speed entries conserve water and remain finite across deep and wet/dry shore cells', () => {
  for (const bedAt of [() => -1.4, (x) => Math.max(-0.4, Math.min(0.8, x * 0.25))]) {
    const flow = new ShallowWater(bedAt);
    const before = totalVolume(flow);
    applyImpact(flow, -1.5, 0, 0.72, 15);
    for (let frame = 0; frame <= 8; frame += 1) {
      assert.ok(Math.abs(totalVolume(flow) - before) < 1e-6,
        `fast entry must conserve volume at frame ${frame}`);
      assert.ok(flow.depth.every(depth => Number.isFinite(depth) && depth >= 0),
        `fast entry must retain finite nonnegative depth at frame ${frame}`);
      assert.ok(flow.momentumX.every(Number.isFinite) && flow.momentumZ.every(Number.isFinite),
        `fast entry must retain finite momentum at frame ${frame}`);
      if (frame < 8) flow.advance(0.05);
    }
  }
});

test('coupleBody on flat open water still produces no foam and no shore impulse after advance', () => {
  const flow = new ShallowWater(() => -1.4);
  applyImpact(flow, 7, -2, 0.72, Math.sqrt(2 * GRAVITY * 4));
  flow.advance(0.4);
  assert.equal(maxAbs(flow.foam), 0,
    `flat deep impact must not birth foam after advance: ${maxAbs(flow.foam)}`);
  assert.equal(maxAbs(flow.shoreImpulseX), 0,
    `flat deep impact must not leak shore impulses after advance: ${maxAbs(flow.shoreImpulseX)}`);
  assert.equal(maxAbs(flow.shoreImpulseZ), 0,
    `flat deep impact must not leak shore impulses after advance: ${maxAbs(flow.shoreImpulseZ)}`);
});

test('coupleBody cavity + rim is C2-continuous through dense/far spacing joins', () => {
  const axisProbe = new ShallowWater(() => -1.4);
  const denseWidth = axisProbe.cellWidths[axisProbe.size >> 1];
  const firstDense = axisProbe.cellWidths.findIndex(width => Math.abs(width - denseWidth) < 1e-9);
  const joins = [axisProbe.axis[firstDense], axisProbe.axis[axisProbe.size - 1 - firstDense]];
  const epsilon = 1e-5;
  for (const joinX of joins) {
    const flow = new ShallowWater(() => -1.4);
    applyImpact(flow, joinX - Math.sign(joinX) * 0.65, 0, 0.72, Math.sqrt(2 * GRAVITY * 4));
    const left = sampleAt(flow, joinX - epsilon, 0);
    const at = sampleAt(flow, joinX, 0);
    const right = sampleAt(flow, joinX + epsilon, 0);
    assert.ok(Math.abs(at.y) > 1e-4, 'probe must cross a non-flat part of the wave');
    const leftHeightLimit = left.x + epsilon * left.y;
    const rightHeightLimit = right.x - epsilon * right.y;
    assert.ok(Math.abs(leftHeightLimit - rightHeightLimit) < 1e-9, `height jumps at ${joinX}`);
    assert.ok(Math.abs(left.y - right.y) < 1e-4, `slope jumps at ${joinX}`);
    assert.ok(Math.abs(at.y - (right.x - left.x) / (2 * epsilon)) < 1e-6,
      `analytic slope disagrees with finite differences at ${joinX}`);
    const leftCurvature = (at.y - left.y) / epsilon;
    const rightCurvature = (right.y - at.y) / epsilon;
    assert.ok(Math.abs(leftCurvature - rightCurvature) < 1e-4,
      `curvature jumps at ${joinX}: ${leftCurvature} vs ${rightCurvature}`);
  }
});

test('analytic sample gradient matches FD to within 1e-6 across dense uniform brackets', () => {
  const flow = new ShallowWater(() => -1.4);
  applyImpact(flow, 5, 1, 0.72, Math.sqrt(2 * GRAVITY * 4));
  flow.advance(0.05);
  const epsilon = 1e-5;
  // Pick five x positions spread across dense uniform cells and probe both
  // sides of every bracket boundary by epsilon=1e-5.
  for (const x of [5.12, 5.41, 5.70, 5.99, 6.28]) {
    const eta = sampleAt(flow, x, 1);
    const fdX = (sampleAt(flow, x + epsilon, 1).x - sampleAt(flow, x - epsilon, 1).x) / (2 * epsilon);
    const fdZ = (sampleAt(flow, x, 1 + epsilon).x - sampleAt(flow, x, 1 - epsilon).x) / (2 * epsilon);
    assert.ok(Math.abs(eta.y - fdX) < 1e-6,
      `X gradient analytic vs FD at x=${x}: analytic=${eta.y}, FD=${fdX}`);
    assert.ok(Math.abs(eta.z - fdZ) < 1e-6,
      `Z gradient analytic vs FD at x=${x}: analytic=${eta.z}, FD=${fdZ}`);
  }
});

test('coupleBody inside a narrow shallow wet patch never clips the rim below zero depth', () => {
  const bedAt = (x, z) => Math.max(-0.15, Math.abs(x - 5) > 1.5 ? 0.5 : -0.15);
  const flow = new ShallowWater(bedAt);
  const before = totalVolume(flow);
  applyImpact(flow, 5, 0, 0.72, Math.sqrt(2 * GRAVITY * 4));
  assert.ok(Math.abs(totalVolume(flow) - before) < 1e-6,
    `narrow patch impact must conserve volume: ${totalVolume(flow)} vs ${before}`);
  for (let i = 0; i < flow.depth.length; i += 1) {
    assert.ok(flow.depth[i] >= -1e-9, `depth stays nonnegative at cell ${i}: ${flow.depth[i]}`);
  }
});

test('incremental displacement, net impulse and work are conservative on an asymmetric wet shore', () => {
  const flow = new ShallowWater(x => Math.max(-1.4, Math.min(0.4, x * 0.25)));
  for (let i = 0; i < flow.depth.length; i++) {
    flow.momentumX[i] = flow.depth[i] * 0.3;
    flow.momentumZ[i] = flow.depth[i] * -0.15;
  }
  const depths = flow.depth.slice(), beforeV = totalVolume(flow);
  const beforeM = totalMomentum(flow), beforeE = totalEnergy(flow);
  const displaced = flow.coupleBody(-1.5, 0, 0.72, 0.6, 1750, -820, 12000);
  let removed = 0, added = 0;
  for (let i = 0; i < depths.length; i++) {
    const dv = (flow.depth[i] - depths[i]) * flow.cellWidths[i % flow.size] * flow.cellWidths[(i / flow.size) | 0];
    removed += Math.max(0, -dv); added += Math.max(0, dv);
    assert.ok(flow.depth[i] >= 0);
  }
  assert.ok(displaced > 0 && displaced <= 0.6);
  near(removed, displaced); near(added, displaced); near(totalVolume(flow), beforeV);
  near(totalMomentum(flow).mx - beforeM.mx, 1750);
  near(totalMomentum(flow).mz - beforeM.mz, -820);
  assert.ok(totalEnergy(flow) - beforeE <= 12000 + 1e-5, 'displacement and radial wave must debit the same work budget');
});

test('immersed drag deposits physical impulse without new displacement or a wave-work budget', () => {
  const flow = new ShallowWater(() => -1.4);
  const before = flow.depth.slice();
  flow.coupleBody(15.2, 0, 0.72, 0, 2000, -450, 0);
  near(totalMomentum(flow).mx, 2000);
  near(totalMomentum(flow).mz, -450);
  assert.deepEqual(flow.depth, before);
});

test('radial work includes current cross-terms and introduces no net momentum', () => {
  const flow = new ShallowWater(() => -0.4);
  for (let i = 0; i < flow.depth.length; i++) {
    flow.momentumX[i] = flow.depth[i] * (0.7 + 0.02 * flow.axis[i % flow.size]);
    flow.momentumZ[i] = flow.depth[i] * -0.3;
  }
  const beforeM = totalMomentum(flow), beforeE = totalEnergy(flow);
  flow.coupleBody(15.2, 1, 0.72, 0, 0, 0, 4000);
  near(totalEnergy(flow) - beforeE, 4000, 1e-5);
  near(totalMomentum(flow).mx, beforeM.mx);
  near(totalMomentum(flow).mz, beforeM.mz);
});

test('withdrawal carries the measured volume, momentum and signed energy and can round-trip', () => {
  const flow = new ShallowWater(() => -1.4), parcel = emptyParcel();
  for (let i = 0; i < flow.depth.length; i++) {
    flow.momentumX[i] = flow.depth[i] * 1.2;
    flow.momentumZ[i] = flow.depth[i] * -0.5;
  }
  const beforeV = totalVolume(flow), beforeM = totalMomentum(flow), beforeE = totalEnergy(flow);
  flow.takeWater(15.2, 1, 0.72, 0.6, parcel);
  near(parcel.volume, 0.6);
  near(beforeV - totalVolume(flow), parcel.volume);
  near(beforeM.mx - totalMomentum(flow).mx, parcel.momentumX);
  near(beforeM.mz - totalMomentum(flow).mz, parcel.momentumZ);
  near(beforeE - totalEnergy(flow), parcel.kineticEnergy + parcel.potentialEnergy, 1e-5);
  const withdrawnEnergy = totalEnergy(flow);
  const cost = flow.returnWater(15.2, 1, 0.72, parcel.volume,
    parcel.momentumX / (RHO * parcel.volume), parcel.momentumZ / (RHO * parcel.volume));
  near(totalEnergy(flow) - withdrawnEnergy, cost, 1e-5);
  near(totalVolume(flow), beforeV);
  near(totalMomentum(flow).mx, beforeM.mx); near(totalMomentum(flow).mz, beforeM.mz);
});

test('overdraw is limited by the real wet cells without draining their reserve', () => {
  const flow = new ShallowWater(x => Math.abs(x) > 0.2 ? 0.4 : -0.02), parcel = emptyParcel();
  const before = flow.depth.slice(), beforeV = totalVolume(flow);
  flow.takeWater(0, 0, 0.5, 50, parcel);
  assert.ok(parcel.volume > 0 && parcel.volume < 50);
  near(beforeV - totalVolume(flow), parcel.volume);
  for (let i = 0; i < before.length; i++) {
    if (before[i] > 0) assert.ok(flow.depth[i] >= before[i] * 0.05 - 1e-12);
    else assert.equal(flow.depth[i], 0);
  }
});

test('a returned parcel wets a raised dry beach and retains all its mass and horizontal momentum', () => {
  const flow = new ShallowWater(() => 0.6);
  const beforeE = totalEnergy(flow);
  const cost = flow.returnWater(0, 0, 0.72, 0.2, 0.4, 0.1);
  near(totalVolume(flow), 0.2);
  near(totalMomentum(flow).mx, 80); near(totalMomentum(flow).mz, 20);
  near(totalEnergy(flow) - beforeE, cost, 1e-5);
  assert.ok(cost > RHO * GRAVITY * 0.2 * 0.6, 'landing above sea level must include gravitational potential');
});

test('parcel mixing reports actual grid energy rather than assuming all incident KE survives', () => {
  const flow = new ShallowWater(() => -1.4), beforeE = totalEnergy(flow);
  const cost = flow.returnWater(0, 0, 0.72, 0.3, 1.2, 0.5);
  near(totalVolume(flow), 1.4 * 200 * 200 + 0.3);
  near(totalMomentum(flow).mx, 360); near(totalMomentum(flow).mz, 150);
  near(totalEnergy(flow) - beforeE, cost);
  assert.ok(cost < 0.5 * RHO * 0.3 * (1.2 ** 2 + 0.5 ** 2), 'mixing into still water dissipates relative motion');
});

test('continuity raises a converging surface at the physical rate across nonuniform cell joins', () => {
  const flow = new ShallowWater(() => -1.4), out = emptyWater();
  for (let i = 0; i < flow.depth.length; i++) {
    flow.momentumX[i] = -0.2 * flow.depth[i] * flow.axis[i % flow.size];
    flow.momentumZ[i] = -0.1 * flow.depth[i] * flow.axis[(i / flow.size) | 0];
  }
  flow.pack();
  flow.sampleKinematics(14.15, 0.4, out);
  near(out.velocityY, 1.4 * (0.2 + 0.1));
  near(out.velocityX, -0.2 * 14.15); near(out.velocityZ, -0.1 * 0.4);
});

test('surface material velocity accounts for horizontal advection, not just height change', () => {
  const flow = new ShallowWater(() => -1.4), out = emptyWater();
  for (let i = 0; i < flow.depth.length; i++) {
    flow.depth[i] = 1.4 + 0.002 * flow.axis[i % flow.size];
    flow.momentumX[i] = 1.4 * flow.depth[i];
  }
  flow.pack();
  flow.sampleKinematics(5, 1, out);
  near(out.slopeX, 0.002);
  near(out.velocityY, 0);
});