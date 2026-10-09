import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPhysicsModule } from './load-physics.mjs';

const { ShallowWater } = await loadPhysicsModule('shallowWater');
const { ShoreResponse } = await loadPhysicsModule('shoreResponse');
const bedAt = (x) => Math.max(-1.4, Math.min(0.8, x * 0.3));
const motion = () => ({ x: 0, z: 0, velocityX: 0, velocityZ: 0 });

test('open-water disturbance and a resting shore do not move inland objects', () => {
  for (const bed of [() => -1.4, bedAt]) {
    const water = new ShallowWater(bed);
    const ground = new ShoreResponse(water);
    if (bed !== bedAt) water.addImpulse(-1.8, 0, 1);
    for (let frame = 0; frame < 10; frame += 1) {
      water.advance(0.05);
      ground.advance(0.05);
    }
    assert.equal(ground.displacementX.some((value) => value !== 0), false);
    assert.equal(ground.displacementZ.some((value) => value !== 0), false);
  }
});

test('strong shore loads reach nearby ground before distant ground, and weak waves react less', () => {
  const strongWater = new ShallowWater(bedAt);
  const weakWater = new ShallowWater(bedAt);
  const strong = new ShoreResponse(strongWater);
  const weak = new ShoreResponse(weakWater);
  strongWater.addImpulse(-1.8, 0, 1);
  weakWater.addImpulse(-1.8, 0, 0);
  const near = motion(), far = motion(), weakNear = motion();
  let nearArrival = Infinity, farArrival = Infinity, nearPeak = 0, weakPeak = 0;
  for (let frame = 1; frame <= 80; frame += 1) {
    strongWater.advance(0.05);
    weakWater.advance(0.05);
    strong.advance(0.05);
    weak.advance(0.05);
    strong.sample(1.5, 0, near);
    strong.sample(4, 0, far);
    weak.sample(1.5, 0, weakNear);
    if (Math.abs(near.x) > 1e-4) nearArrival = Math.min(nearArrival, frame * 0.05);
    if (Math.abs(far.x) > 1e-4) farArrival = Math.min(farArrival, frame * 0.05);
    nearPeak = Math.max(nearPeak, Math.abs(near.x));
    weakPeak = Math.max(weakPeak, Math.abs(weakNear.x));
    assert.ok(Number.isFinite(near.x) && Number.isFinite(far.x));
  }
  assert.ok(nearArrival < farArrival && farArrival < Infinity,
    `spatial arrival near=${nearArrival}, far=${farArrival}`);
  assert.ok(nearPeak > 0.001 && nearPeak > weakPeak * 3,
    `strong/weak response ${nearPeak}/${weakPeak}`);
});

test('the propagated response damps to rest after the shoreline load stops', () => {
  const water = new ShallowWater(bedAt);
  const ground = new ShoreResponse(water);
  water.addImpulse(-1.8, 0, 1);
  let peak = 0;
  for (let frame = 0; frame < 30; frame += 1) {
    water.advance(0.05);
    ground.advance(0.05);
    for (const value of ground.displacementX) peak = Math.max(peak, Math.abs(value));
  }
  water.advance(0); // Clear last-frame shoreline impulse, without creating a new load.
  ground.advance(12);
  const settled = Math.max(...ground.displacementX.map(Math.abs), ...ground.displacementZ.map(Math.abs));
  assert.ok(peak > 0.001 && settled < peak * 0.001, `settling ${settled} vs peak ${peak}`);
});

test('a coarse frame retains short-lived peak impact instead of missing an extinguishing shock', () => {
  const water = new ShallowWater(bedAt);
  water.addImpulse(-1.8, 0, 1);
  water.advance(0.4);
  const coarse = new ShoreResponse(water);
  const reference = new ShoreResponse(water);
  const probe = { x: 1.5, z: 0 }, observed = motion();
  const peak = coarse.advance(4, probe);
  let referencePeak = 0;
  for (let step = 0; step < 200; step += 1) {
    reference.advance(0.02);
    water.advance(0); // Deposit the input impulse once, never replay it.
    reference.sample(probe.x, probe.z, observed);
    referencePeak = Math.max(referencePeak, Math.hypot(observed.x, observed.z));
  }
  coarse.sample(probe.x, probe.z, observed);
  const finalPose = Math.hypot(observed.x, observed.z);
  assert.ok(referencePeak > 0.001 && referencePeak > finalPose * 3,
    `the shock must be transient: peak=${referencePeak}, endpoint=${finalPose}`);
  assert.ok(Math.abs(peak - referencePeak) < 1e-9,
    `coarse-frame peak ${peak} must match substep observation ${referencePeak}`);
});
