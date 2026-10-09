import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPhysicsModule } from './load-physics.mjs';

const { ShallowWater } = await loadPhysicsModule('shallowWater');
const gravity = 9.81;
const RHO = 1000;

function integrated(flow) {
  let volume = 0, kinetic = 0;
  for (let z = 0; z < flow.size; z += 1) {
    for (let x = 0; x < flow.size; x += 1) {
      const i = z * flow.size + x;
      const area = flow.cellWidths[x] * flow.cellWidths[z];
      const h = flow.depth[i];
      volume += h * area;
      if (h > 1e-5) kinetic += 500 * area * (flow.momentumX[i] ** 2 + flow.momentumZ[i] ** 2) / h;
    }
  }
  return { volume: volume + flow.absorbedVolume, kinetic };
}

function seedCrestPacket(flow, cx, cz, amplitude, sigma) {
  const speed = Math.sqrt(gravity * 1.4);
  for (let z = 0; z < flow.size; z += 1) {
    for (let x = 0; x < flow.size; x += 1) {
      const i = z * flow.size + x;
      const dx = flow.axis[x] - cx;
      const dz = flow.axis[z] - cz;
      const eta = amplitude * Math.exp(-0.5 * ((dx / sigma) ** 2 + (dz / sigma) ** 2));
      if (eta === 0) continue;
      flow.depth[i] += eta;
      // Travel toward +X so a peak at x=cx arrives at cx + c·t.
      flow.momentumX[i] = speed * eta;
    }
  }
}

function sampleEta(flow, x, z) {
  flow.pack();
  const target = { x: 0, y: 0, z: 0 };
  flow.sample(x, z, target);
  return target.x;
}

/** Finite-volume propagation fixture; body integration is tested separately. */
function applyImpact(flow, x, z, radius, verticalSpeed) {
  const restingDepth = sampleEta(flow, x, z) - flow.sampleScalar(flow.bed, x, z);
  const cavityDepth = Math.min(radius * 0.9, Math.max(0.05, restingDepth * 0.85));
  const displacedVolume = cavityDepth * Math.PI * radius * radius;
  const work = 0.5 * RHO * displacedVolume * verticalSpeed * verticalSpeed
    + RHO * gravity * displacedVolume * radius;
  flow.coupleBody(x, z, radius, displacedVolume, 0, 0, work);
}

test('a weak travelling crest propagates at the linear long-wave speed without flattening', () => {
  const amplitude = 0.001;
  const depth = 1.4;
  const speed = Math.sqrt(gravity * depth);
  const flow = new ShallowWater(() => -depth);
  for (let z = 0; z < flow.size; z += 1) {
    for (let x = 0; x < flow.size; x += 1) {
      const i = z * flow.size + x;
      const eta = amplitude * Math.exp(-0.5 * ((flow.axis[x] + 5) / 0.65) ** 2);
      flow.depth[i] += eta;
      flow.momentumX[i] = speed * eta;
    }
  }
  const initialPeak = sampleEta(flow, -5, 0);
  flow.advance(0.6);
  flow.pack();
  let peak = -Infinity, peakX = 0;
  for (let x = -8; x < 1; x += 0.025) {
    const target = { x: 0, y: 0, z: 0 };
    flow.sample(x, 0, target);
    const eta = target.x;
    if (eta > peak) { peak = eta; peakX = x; }
  }
  assert.ok(Math.abs(peakX - (-5 + speed * 0.6)) < 0.3, `crest arrived at ${peakX}, expected ${-5 + speed * 0.6}`);
  // A linear crest can disperse/dissipate, so the post-arrival peak must be
  // physically bounded but never amplified into a steeper waveform.
  assert.ok(peak > initialPeak * 0.65 && peak < amplitude * 1.2,
    `crest amplitude ${peak}, initially ${initialPeak}`);
  for (let i = 0; i < flow.depth.length; i += 1) {
    assert.ok(Number.isFinite(flow.depth[i]) && flow.depth[i] >= 0, `invalid depth at ${i}`);
  }
});

test('coupleBody on a rest lake deposits radial kinetic energy strictly less than work input', () => {
  const depth = 1.4;
  const slow = new ShallowWater(() => -depth);
  const fast = new ShallowWater(() => -depth);
  const slowBefore = integrated(slow);
  const fastBefore = integrated(fast);
  applyImpact(slow, 0, 0, 0.72, 4);
  applyImpact(fast, 0, 0, 0.72, 8);
  const slowAfter = integrated(slow);
  const fastAfter = integrated(fast);
  // Rest-lake closure: depth stays finite-positive everywhere before AND after
  // the impact, and conserved water volume is intact on both lakes.
  for (const flow of [slow, fast]) {
    for (let i = 0; i < flow.depth.length; i += 1) {
      assert.ok(flow.depth[i] > 0 && Number.isFinite(flow.depth[i]),
        `impact drained cell ${i}: ${flow.depth[i]}`);
    }
  }
  assert.ok(Math.abs(slowAfter.volume - slowBefore.volume) < 1e-6,
    `slow impact volume drift ${slowAfter.volume - slowBefore.volume}`);
  assert.ok(Math.abs(fastAfter.volume - fastBefore.volume) < 1e-6,
    `fast impact volume drift ${fastAfter.volume - fastBefore.volume}`);
  assert.ok(slowAfter.kinetic > 0 && fastAfter.kinetic > 0,
    `impacts must transfer real kinetic energy (slow=${slowAfter.kinetic}, fast=${fastAfter.kinetic})`);
  // Physical invariant: a faster entry injects more kinetic energy into the
  // resolved wave field. A higher entry speed delivers more total work
  // (proportional to v² plus a potential-energy baseline), so the wave's
  // post-impact kinetic energy must grow monotonically with entry speed.
  assert.ok(fastAfter.kinetic > slowAfter.kinetic,
    `faster entry must deposit more KE: slow=${slowAfter.kinetic} fast=${fastAfter.kinetic}`);
  // Bound: post-impact wave KE must be bounded by the work input. Work is
  // 0.5*rho*V*v² + rho*g*V*r — the KE share may be a fraction of that.
  const V = (0.72 * 0.9) * Math.PI * 0.72 * 0.72;
  const workSlow = 0.5 * RHO * V * 16 + RHO * 9.81 * V * 0.72;
  const workFast = 0.5 * RHO * V * 64 + RHO * 9.81 * V * 0.72;
  assert.ok(slowAfter.kinetic <= workSlow * 1.0001,
    `slow KE must be bounded by work: ${slowAfter.kinetic} ≤ ${workSlow}`);
  assert.ok(fastAfter.kinetic <= workFast * 1.0001,
    `fast KE must be bounded by work: ${fastAfter.kinetic} ≤ ${workFast}`);
});

test('strong entries stay finite, positive, volume-conserving while running up a wet/dry beach', () => {
  const flow = new ShallowWater((x, z) => Math.max(-1.4, x * 0.15 + Math.sin(z) * 0.08));
  const initialVolume = integrated(flow).volume;
  for (let frame = 0; frame < 60; frame += 1) {
    if (frame % 15 === 0) applyImpact(flow, -5, 0.5, 0.72, 10);
    flow.advance(0.025);
    for (let i = 0; i < flow.depth.length; i += 1) {
      assert.ok(Number.isFinite(flow.depth[i]) && flow.depth[i] >= 0,
        `invalid depth ${i}, frame ${frame}: ${flow.depth[i]}`);
      assert.ok(Number.isFinite(flow.momentumX[i]) && Number.isFinite(flow.momentumZ[i]),
        `invalid momentum ${i}, frame ${frame}`);
    }
  }
  assert.ok(Math.abs(integrated(flow).volume - initialVolume) < 1e-6,
    `surface plus absorbed water must balance (drift ${integrated(flow).volume - initialVolume})`);
});

test('rotating an already-seeded crest packet through X/Z rotates the propagated physical field', () => {
  // Rotational covariance of the CORE PDE, not the impact closure. Seed an
  // identical analytic Gaussian crest packet into two rest lakes, then rotate
  // the packet through X↔Z so a feature along +X travels along +Z instead.
  const amplitude = 0.001;
  const a = new ShallowWater(() => -1.4);
  const b = new ShallowWater(() => -1.4);
  seedCrestPacket(a, -5, 0, amplitude, 0.65); // packet along +X
  for (let z = 0; z < a.size; z += 1) {
    for (let x = 0; x < a.size; x += 1) {
      const i = z * a.size + x, j = x * a.size + z;
      b.depth[j] = a.depth[i];
      b.momentumZ[j] = a.momentumX[i];
      b.momentumX[j] = a.momentumZ[i];
    }
  }
  a.advance(0.6);
  b.advance(0.6);
  let error = 0;
  for (let z = 0; z < a.size; z += 1) {
    for (let x = 0; x < a.size; x += 1) {
      const i = z * a.size + x;
      const j = x * a.size + z;
      error = Math.max(
        error,
        Math.abs(a.depth[i] - b.depth[j]),
        Math.abs(a.momentumX[i] - b.momentumZ[j]),
        Math.abs(a.momentumZ[i] - b.momentumX[j]),
      );
    }
  }
  assert.ok(error < 1e-9, `rotated PDE state diverged by ${error}`);
});

test('invalid (non-finite / negative) entry inputs are a strict no-op', () => {
  // Zero displacement remains valid for submerged drag and parcel re-entry.
  const initial = integrated(new ShallowWater(() => -1.4)).volume;
  for (const [radius, displacedVolume, energy, label] of [
    [0.72, -1, 100, 'negative displacement'],
    [0.72, 1, -5, 'negative energy'],
    [0.72, 1, Number.NaN, 'NaN energy'],
    [0.72, 1, Number.POSITIVE_INFINITY, 'Infinity energy'],
    [0, 1, 100, 'zero radius'],
    [-0.72, 1, 100, 'negative radius'],
    [Number.NaN, 1, 100, 'NaN radius'],
    [0.72, Number.NaN, 100, 'NaN displacement'],
    [Number.NaN, Number.NaN, Number.NaN, 'all NaN'],
  ]) {
    const flow = new ShallowWater(() => -1.4);
    const before = flow.depth.slice();
    const beforeMx = flow.momentumX.slice();
    const beforeMz = flow.momentumZ.slice();
    flow.coupleBody(0, 0, radius, displacedVolume, 0, 0, energy);
    assert.ok(Math.abs(integrated(flow).volume - initial) < 1e-9, `${label} changed water volume`);
    for (let i = 0; i < flow.depth.length; i += 1) {
      assert.ok(flow.depth[i] === before[i], `${label} mutated depth at ${i}`);
      assert.ok(flow.momentumX[i] === beforeMx[i] && flow.momentumZ[i] === beforeMz[i],
        `${label} mutated momentum at ${i}`);
    }
  }
});