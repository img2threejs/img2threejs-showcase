import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPhysicsModule } from './load-physics.mjs';

const { ShallowWater } = await loadPhysicsModule('shallowWater');
const gravity = 9.81;

function volume(flow) {
  let result = 0;
  for (let z = 0; z < flow.size; z += 1) {
    for (let x = 0; x < flow.size; x += 1) {
      result += flow.depth[z * flow.size + x] * flow.cellWidths[x] * flow.cellWidths[z];
    }
  }
  return result + flow.absorbedVolume;
}

function sample(flow, x, z) {
  flow.pack();
  const target = { x: 0, y: 0, z: 0 };
  flow.sample(x, z, target);
  return target;
}

function seedCounterWaves(flow, left, right) {
  const speed = Math.sqrt(gravity * 1.4);
  for (let z = 0; z < flow.size; z += 1) {
    for (let x = 0; x < flow.size; x += 1) {
      const i = z * flow.size + x;
      const a = left * Math.exp(-0.5 * ((flow.axis[x] + 1.2) / 0.45) ** 2);
      const b = right * Math.exp(-0.5 * ((flow.axis[x] - 1.2) / 0.45) ** 2);
      flow.depth[i] += a + b;
      flow.momentumX[i] = speed * (a - b);
    }
  }
}

test('a variable-depth lake at rest does not invent waves or foam, including dry terrain', () => {
  const flow = new ShallowWater((x, z) => Math.max(-1.4, 0.8 - Math.hypot(x, z) * 0.3));
  const before = flow.depth.slice();
  flow.advance(0.6);
  let depthError = 0, momentum = 0, foam = 0;
  for (let i = 0; i < before.length; i += 1) {
    depthError = Math.max(depthError, Math.abs(before[i] - flow.depth[i]));
    momentum = Math.max(momentum, Math.abs(flow.momentumX[i]), Math.abs(flow.momentumZ[i]));
    foam = Math.max(foam, flow.foam[i]);
  }
  assert.ok(depthError < 1e-10, `lake depth drift ${depthError}`);
  assert.ok(momentum < 1e-10, `spurious lake momentum ${momentum}`);
  assert.equal(foam, 0);
});

test('wet-cell impulses and coupled flux conserve water including soil absorption and measured boundary flow', () => {
  const flow = new ShallowWater((x, z) => Math.max(-1.4, 0.65 - Math.hypot(x, z) * 0.22));
  const initial = volume(flow);
  flow.addImpulse(3.8, 0, 1);
  flow.addImpulse(-5, 1, 0.6);
  flow.addImpulse(22, -20, 0.5);
  assert.ok(Math.abs(volume(flow) - initial) < 2e-7, 'impulses must add a crest AND remove equal trough volume');
  // SSP-RK2 averages both Euler-stage fluxes; measure each stage's physical
  // boundary momentum with its actual half-weight in the final volume.
  let boundaryOutflow = 0;
  const advanceStage = flow.computeStage.bind(flow);
  flow.computeStage = (dt) => {
    for (let k = 0; k < flow.size; k += 1) {
      boundaryOutflow += 0.5 * dt * flow.cellWidths[k] * (
        flow.momentumX[k * flow.size + flow.size - 1] - flow.momentumX[k * flow.size]
        + flow.momentumZ[(flow.size - 1) * flow.size + k] - flow.momentumZ[k]);
    }
    advanceStage(dt);
  };
  flow.advance(0.8);
  assert.ok(Math.abs(volume(flow) + boundaryOutflow - initial) < 2e-7,
    'surface plus absorbed water must balance the measured boundary flow');
  for (let i = 0; i < flow.depth.length; i += 1) {
    assert.ok(Number.isFinite(flow.depth[i]) && flow.depth[i] >= 0, `invalid depth at ${i}`);
    assert.ok(Number.isFinite(flow.momentumX[i]) && Number.isFinite(flow.momentumZ[i]), `invalid momentum at ${i}`);
  }
});

test('weak opposing crests interfere constructively, then transmit rather than bounce as objects', () => {
  const a = new ShallowWater(() => -1.4);
  const b = new ShallowWater(() => -1.4);
  const together = new ShallowWater(() => -1.4);
  seedCounterWaves(a, 0.001, 0);
  seedCounterWaves(b, 0, 0.001);
  seedCounterWaves(together, 0.001, 0.001);
  for (const flow of [a, b, together]) flow.advance(0.32);
  const expected = sample(a, 0, 0).x + sample(b, 0, 0).x;
  const crossing = sample(together, 0, 0).x;
  assert.ok(expected > 0.001, `test must observe overlapping crests, got ${expected}`);
  assert.ok(Math.abs(crossing - expected) < 2e-6, `constructive superposition error ${crossing - expected}`);
  for (const flow of [a, b, together]) flow.advance(0.5);
  const transmitted = sample(together, 1.8, 0).x;
  const expectedTransmitted = sample(a, 1.8, 0).x + sample(b, 1.8, 0).x;
  assert.ok(transmitted > 0.0003, `rightward crest must pass the crossing, got ${transmitted}`);
  assert.ok(Math.abs(transmitted - expectedTransmitted) < 3e-6);
  assert.ok(sample(together, 0, 0).x < transmitted * 0.6, 'crest must leave the crossing');
  assert.ok(Math.max(...together.foam) < 1e-8, 'tiny linear crossing must not manufacture whitecaps');
});

test('opposing crest and trough cancel at the crossing without erasing transmitted waves', () => {
  const flow = new ShallowWater(() => -1.4);
  seedCounterWaves(flow, 0.001, -0.001);
  flow.advance(0.32);
  assert.ok(Math.abs(sample(flow, 0, 0).x) < 3e-6);
  flow.advance(0.5);
  assert.ok(sample(flow, 1.8, 0).x > 0.0003);
  assert.ok(sample(flow, -1.8, 0).x < -0.0003);
});

test('strong counter-waves evolve nonlinearly rather than as independently summed packets', () => {
  const a = new ShallowWater(() => -1.4);
  const b = new ShallowWater(() => -1.4);
  const together = new ShallowWater(() => -1.4);
  seedCounterWaves(a, 0.2, 0);
  seedCounterWaves(b, 0, 0.2);
  seedCounterWaves(together, 0.2, 0.2);
  for (const flow of [a, b, together]) flow.advance(0.32);
  const independent = sample(a, 0, 0).x + sample(b, 0, 0).x;
  const coupled = sample(together, 0, 0).x;
  assert.ok(Math.abs(coupled - independent) > 0.002, `nonlinear interaction missing: ${coupled} vs ${independent}`);
});

test('residual foam moves with the solved current and decays instead of following a shore clock', () => {
  const flow = new ShallowWater(() => -1.4);
  let initialFoam = 0;
  for (let z = 0; z < flow.size; z += 1) {
    for (let x = 0; x < flow.size; x += 1) {
      const i = z * flow.size + x;
      flow.momentumX[i] = 1.4 * 0.75;
      flow.foam[i] = Math.exp(-(flow.axis[x] ** 2 + flow.axis[z] ** 2) / 0.5);
      initialFoam += flow.foam[i] * flow.cellWidths[x] * flow.cellWidths[z];
    }
  }
  flow.advance(1);
  let total = 0, centroid = 0;
  for (let z = 0; z < flow.size; z += 1) {
    for (let x = 0; x < flow.size; x += 1) {
      const i = z * flow.size + x;
      const weighted = flow.foam[i] * flow.cellWidths[x] * flow.cellWidths[z];
      total += weighted;
      centroid += flow.axis[x] * weighted;
    }
  }
  assert.ok(centroid / total > 0.6 && centroid / total < 0.85, `foam displacement ${centroid / total}`);
  assert.ok(Math.abs(total / initialFoam - Math.exp(-1 / 3)) < 0.02, `foam residual ${total / initialFoam}`);
  flow.pack();
  const materialOffset = flow.sampleChannel(flow.flowData, centroid / total, 0, 2);
  assert.ok(materialOffset < -0.6 && materialOffset > -0.85,
    `bubble pattern must travel with the foam, not remain world-fixed: ${materialOffset}`);
});

test('strong shore waves inundate initially dry sand, leave wetness and produce return flow', () => {
  const bedAt = (x) => Math.max(-1.4, Math.min(0.8, x * 0.3));
  const weak = new ShallowWater(bedAt);
  const strong = new ShallowWater(bedAt);
  weak.addImpulse(-1.8, 0, 0);
  strong.addImpulse(-1.8, 0, 1);
  let weakRunup = 0, strongRunup = 0, foamPeak = 0, outward = 0, inward = 0;
  let wetMemory = 0;
  for (let frame = 0; frame < 35; frame += 1) {
    weak.advance(0.1);
    strong.advance(0.1);
    for (let z = 0; z < strong.size; z += 1) {
      if (Math.abs(strong.axis[z]) > 2) continue;
      for (let x = 0; x < strong.size; x += 1) {
        const i = z * strong.size + x;
        if (strong.bed[i] > 0) {
          if (strong.depth[i] > 0.003) strongRunup = Math.max(strongRunup, strong.axis[x]);
          if (weak.depth[i] > 0.003) weakRunup = Math.max(weakRunup, weak.axis[x]);
          wetMemory = Math.max(wetMemory, strong.wetness[i]);
        }
        if (strong.axis[x] > -0.8 && strong.axis[x] < 0.6) {
          foamPeak = Math.max(foamPeak, strong.foam[i]);
          inward = Math.max(inward, strong.momentumX[i]);
          outward = Math.max(outward, -strong.momentumX[i]);
        }
      }
    }
  }
  assert.ok(strongRunup > weakRunup && strongRunup > 0.1, `run-up weak=${weakRunup}, strong=${strongRunup}`);
  assert.ok(foamPeak > 0.02, `breaking must create visible foam, peak=${foamPeak}`);
  assert.ok(wetMemory > 0.2, `inundation must leave wet sand, wetness=${wetMemory}`);
  assert.ok(inward > 0.01 && outward > 0.005, `shore flow must enter then return: ${inward}, ${outward}`);
  assert.ok(Math.abs(volume(strong) - volume(new ShallowWater(bedAt))) < 2e-7);
});

test('CPU height and slopes use the same physical-axis nonuniform cubic B-spline reconstruction', () => {
  const flow = new ShallowWater(() => -1.4);
  flow.addImpulse(5, 3, 0.8);
  flow.advance(0.2);
  const epsilon = 1e-5;
  for (const [x, z] of [[5.05, 3.07], [-10.13, 7.31], [21.7, -17.3]]) {
    const actual = sample(flow, x, z);
    const dx = (sample(flow, x + epsilon, z).x - sample(flow, x - epsilon, z).x) / (2 * epsilon);
    const dz = (sample(flow, x, z + epsilon).x - sample(flow, x, z - epsilon).x) / (2 * epsilon);
    assert.ok(Math.abs(actual.y - dx) < 1e-6, `X slope at ${x},${z}: ${actual.y} vs ${dx}`);
    assert.ok(Math.abs(actual.z - dz) < 1e-6, `Z slope at ${x},${z}: ${actual.z} vs ${dz}`);
  }
});

function maxAbs(array) {
  let peak = 0;
  for (let i = 0; i < array.length; i += 1) {
    const value = array[i];
    if (value > peak) peak = value;
    else if (-value > peak) peak = -value;
  }
  return peak;
}

function bandImpulsePeak(flow, bedMin, bedMax) {
  let peak = 0;
  for (let z = 0; z < flow.size; z += 1) {
    for (let x = 0; x < flow.size; x += 1) {
      const i = z * flow.size + x;
      const bed = flow.bed[i];
      if (bed < bedMin || bed > bedMax) continue;
      const mag = Math.hypot(flow.shoreImpulseX[i], flow.shoreImpulseZ[i]);
      if (mag > peak) peak = mag;
    }
  }
  return peak;
}

test('strongest click on flat deep bed produces a water disturbance but no foam and no shore impulses', () => {
  const flow = new ShallowWater(() => -1.4);
  flow.addImpulse(4, 0, 1);
  let disturbBefore = 0;
  for (let i = 0; i < flow.depth.length; i += 1) {
    const deviation = flow.depth[i] - 1.4;
    if (deviation > disturbBefore) disturbBefore = deviation;
    else if (-deviation > disturbBefore) disturbBefore = -deviation;
  }
  flow.advance(0.6);
  let disturbAfter = 0;
  for (let i = 0; i < flow.depth.length; i += 1) {
    const deviation = flow.depth[i] - 1.4;
    if (deviation > disturbAfter) disturbAfter = deviation;
    else if (-deviation > disturbAfter) disturbAfter = -deviation;
  }
  assert.ok(disturbAfter > 0.01 && disturbAfter < disturbBefore,
    `flat deep impulse must propagate/dissipate, not disappear: before=${disturbBefore}, after=${disturbAfter}`);
  assert.equal(maxAbs(flow.foam), 0, 'flat deep click must never manufacture foam');
  assert.equal(maxAbs(flow.shoreImpulseX), 0, 'flat deep click must not deposit any shore impulse X');
  assert.equal(maxAbs(flow.shoreImpulseZ), 0, 'flat deep click must not deposit any shore impulse Z');
});

test('strongest click on flat shallow bed produces a water disturbance but no foam and no shore impulses', () => {
  const flow = new ShallowWater(() => -0.2);
  flow.addImpulse(-2, 0, 1);
  let disturbBefore = 0;
  for (let i = 0; i < flow.depth.length; i += 1) {
    const deviation = flow.depth[i] - 0.2;
    if (deviation > disturbBefore) disturbBefore = deviation;
    else if (-deviation > disturbBefore) disturbBefore = -deviation;
  }
  flow.advance(0.6);
  let disturbAfter = 0;
  for (let i = 0; i < flow.depth.length; i += 1) {
    const deviation = flow.depth[i] - 0.2;
    if (deviation > disturbAfter) disturbAfter = deviation;
    else if (-deviation > disturbAfter) disturbAfter = -deviation;
  }
  assert.ok(disturbAfter > 0.01 && disturbAfter < disturbBefore,
    `flat shallow impulse must propagate/dissipate, not disappear: before=${disturbBefore}, after=${disturbAfter}`);
  assert.equal(maxAbs(flow.foam), 0, 'flat shallow click must never manufacture foam');
  assert.equal(maxAbs(flow.shoreImpulseX), 0, 'flat shallow click must not deposit any shore impulse X');
  assert.equal(maxAbs(flow.shoreImpulseZ), 0, 'flat shallow click must not deposit any shore impulse Z');
});

test('open-water counter-waves never birth foam on flat bed', () => {
  const flow = new ShallowWater(() => -1.4);
  seedCounterWaves(flow, 0.2, 0.2);
  flow.advance(0.6);
  assert.equal(maxAbs(flow.foam), 0, 'nonlinear counter-waves on flat bed must remain foam-free');
  assert.equal(maxAbs(flow.shoreImpulseX), 0, 'open-water counter-waves must not leak shore impulses');
  assert.equal(maxAbs(flow.shoreImpulseZ), 0, 'open-water counter-waves must not leak shore impulses');
});

test('strong shore impulse exceeds weak impulse, points inland, and resting water emits none', () => {
  const bedAt = (x) => Math.max(-1.4, Math.min(0.8, x * 0.3));
  // Resting slope with no disturbance: shore impulse arrays must remain exactly zero.
  const resting = new ShallowWater(bedAt);
  resting.advance(0.4);
  assert.equal(maxAbs(resting.shoreImpulseX), 0, 'resting water must not emit shore impulses');
  assert.equal(maxAbs(resting.shoreImpulseZ), 0, 'resting water must not emit shore impulses');

  // Weak vs strong click on the slope; advance lets the wave reach the beach.
  const weak = new ShallowWater(bedAt);
  const strong = new ShallowWater(bedAt);
  weak.addImpulse(-1.8, 0, 0);
  strong.addImpulse(-1.8, 0, 1);
  let weakPeak = 0, strongPeak = 0, inwardX = 0, outwardX = 0, transverse = 0;
  for (let frame = 0; frame < 35; frame += 1) {
    weak.advance(0.1);
    strong.advance(0.1);
    weakPeak = Math.max(weakPeak, bandImpulsePeak(weak, -0.35, 0.30));
    strongPeak = Math.max(strongPeak, bandImpulsePeak(strong, -0.35, 0.30));
    transverse = Math.max(transverse, maxAbs(strong.shoreImpulseZ));
    for (const impulse of strong.shoreImpulseX) {
      inwardX = Math.max(inwardX, impulse);
      outwardX = Math.max(outwardX, -impulse);
    }
  }
  assert.ok(strongPeak > weakPeak && strongPeak > 0,
    `strong impulse must dominate weak: strong=${strongPeak}, weak=${weakPeak}`);
  assert.equal(transverse, 0, 'a beach with no Z slope cannot emit transverse shore load');
  assert.ok(inwardX > 0 && inwardX > outwardX * 4,
    `shore impulse must point inland: inward=${inwardX}, outward=${outwardX}`);
});

test('shoreImpulse arrays are zeroed on every advance, including advance(0) and stale reload', () => {
  const bedAt = (x) => Math.max(-1.4, Math.min(0.8, x * 0.3));
  const flow = new ShallowWater(bedAt);
  flow.addImpulse(-1.8, 0, 1);
  flow.advance(0.5);
  assert.ok(maxAbs(flow.shoreImpulseX) > 0 || maxAbs(flow.shoreImpulseZ) > 0,
    'shore-band simulation should accumulate impulses before the reset');
  flow.advance(0);
  assert.equal(maxAbs(flow.shoreImpulseX), 0, 'advance(0) must still clear stale shore impulses');
  assert.equal(maxAbs(flow.shoreImpulseZ), 0, 'advance(0) must still clear stale shore impulses');
  flow.advance(NaN);
  assert.equal(maxAbs(flow.shoreImpulseX), 0, 'advance(NaN) must clear without replaying');
  assert.equal(maxAbs(flow.shoreImpulseZ), 0, 'advance(NaN) must clear without replaying');
  flow.advance(-1);
  assert.equal(maxAbs(flow.shoreImpulseX), 0, 'advance(negative) must clear without replaying');
  assert.equal(maxAbs(flow.shoreImpulseZ), 0, 'advance(negative) must clear without replaying');
});
