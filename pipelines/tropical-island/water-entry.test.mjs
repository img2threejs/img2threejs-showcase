import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPhysicsModule } from './load-physics.mjs';

const { stepWaterEntry, GRAVITY: g, WATER_DENSITY: rho } = await loadPhysicsModule('waterEntryDynamics');
const radius = 0.72, volume = 4 / 3 * Math.PI * radius ** 3;
const bottom = -0.3, top = 0.5;

function body(values = {}) {
  const mass = values.mass ?? 2650 * volume;
  return { x: 0, y: 1.5, z: 0, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0,
    radius, mass, volume, inertia: 0.4 * mass * radius ** 2, submergedVolume: 0, ...values };
}
function water(values = {}) {
  return { height: 0, depth: 20, bed: -20, slopeX: 0, slopeZ: 0,
    velocityX: 0, velocityY: 0, velocityZ: 0, ...values };
}
function result() {
  return { impulseX: 0, impulseY: 0, impulseZ: 0, work: 0, displacedVolume: 0,
    submerged: 0, normalSpeed: 0, grounded: false };
}
function advance(b, field, seconds, dt = 1 / 240) {
  const out = result();
  for (let remaining = seconds; remaining > 1e-9;) {
    const step = Math.min(dt, remaining);
    stepWaterEntry(b, field, bottom, top, step, out);
    remaining -= step;
  }
  return out;
}
function close(a, b, tolerance = 1e-8) { assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`); }

test('dry motion remains ballistic and cannot react to an empty water column', () => {
  const b = body({ y: 2, vx: 6, vy: -12, vz: -3, wy: 2 });
  const out = result(), dt = 0.08;
  stepWaterEntry(b, water(), bottom, top, dt, out);
  close(b.x, 6 * dt); close(b.z, -3 * dt);
  close(b.y, 2 - 12 * dt - 0.5 * g * dt ** 2);
  close(b.vy, -12 - g * dt); close(b.wy, 2);
  close(Math.hypot(out.impulseX, out.impulseY, out.impulseZ), 0);
  const dry = body({ y: -1, vx: 4, vy: -2 });
  stepWaterEntry(dry, water({ depth: 0 }), bottom, top, 1 / 240, out);
  close(out.submerged, 0); close(dry.vx, 4); close(out.work, 0);
});

test('actual asymmetric bounds control wetting, not the nominal sphere radius', () => {
  const b = body({ y: -bottom + 0.05, vy: -2 });
  const out = result();
  stepWaterEntry(b, water(), bottom, top, 1 / 240, out);
  close(out.submerged, 0); close(out.impulseY, 0);
  b.y = -bottom - 0.02;
  stepWaterEntry(b, water(), bottom, top, 1 / 240, out);
  assert.ok(out.submerged > 0 && out.submerged < 0.02);
  assert.ok(out.impulseY < 0, 'entry pushes water down');
});

test('oblique entry continues laterally and spinning instead of freezing at contact', () => {
  const b = body({ y: -bottom, vx: 7, vy: -14, vz: -3, wy: 2 });
  advance(b, water(), 0.12);
  assert.ok(b.x > 0.6 && b.z < -0.2, `continued path: ${b.x}, ${b.z}`);
  assert.ok(b.vx > 0 && b.vx < 7);
  assert.ok(b.vz < 0 && b.vz > -3);
  assert.ok(b.wy > 0 && b.wy < 2, `spin decays continuously: ${b.wy}`);
});

test('growing added mass supplies an entry load absent from already-entrained water', () => {
  const initial = body({ y: -0.1, vy: -10 });
  const fresh = { ...initial }, first = result();
  stepWaterEntry(fresh, water(), bottom, top, 1 / 240, first);
  const entrained = { ...initial, submergedVolume: fresh.submergedVolume }, second = result();
  stepWaterEntry(entrained, water(), bottom, top, 1 / 240, second);
  assert.ok(fresh.vy > entrained.vy + 0.2, 'fresh immersion must resist entrainment');
  assert.ok(Math.abs(first.impulseY) > Math.abs(second.impulseY));
  const exiting = body({ y: 0.1, vy: 4, submergedVolume: volume });
  stepWaterEntry(exiting, water(), bottom, top, 1 / 240, result());
  assert.ok(exiting.vy > 0 && exiting.vy < 4, 'shrinking added mass cannot kick the rock upward');
});

test('neutral co-motion has no relative drag or extracted work', () => {
  const b = body({ y: -2, vx: 2, vy: 0.3, vz: -1, mass: rho * volume, submergedVolume: volume });
  const field = water({ velocityX: 2, velocityY: 0.3, velocityZ: -1 });
  const out = result(), dt = 1 / 120;
  stepWaterEntry(b, field, bottom, top, dt, out);
  close(b.vx, 2); close(b.vy, 0.3); close(b.vz, -1);
  close(out.impulseX, 0); close(out.impulseZ, 0); close(out.work, 0, 1e-7);
  close(out.impulseY, -b.mass * g * dt, 1e-7);
});

test('closing speed follows the moving sloped surface and reaction closes momentum balance', () => {
  const b = body({ y: -0.1, vx: 3, vy: -7, vz: -2 });
  const before = { ...b }, dt = 1 / 240, out = result();
  const field = water({ slopeX: 0.6, slopeZ: -0.3, velocityX: 0.6, velocityY: 0.8, velocityZ: 0.2 });
  stepWaterEntry(b, field, bottom, top, dt, out);
  close(out.normalSpeed, (2.4 * 0.6 + 7.8 + (-2.2) * (-0.3)) / Math.hypot(0.6, 1, -0.3));
  close(out.impulseX + b.mass * (b.vx - before.vx), 0);
  close(out.impulseY + b.mass * (b.vy - before.vy + g * dt), 0, 1e-7);
  close(out.impulseZ + b.mass * (b.vz - before.vz), 0);
});

test('buoyancy reverses a light submerged body while a dense body continues sinking', () => {
  const light = body({ y: -2, mass: rho * volume * 0.5, submergedVolume: volume });
  const dense = body({ y: -2, mass: rho * volume * 2, submergedVolume: volume });
  advance(light, water(), 0.6);
  advance(dense, water(), 0.6);
  assert.ok(light.y > -2 && light.vy > 0);
  assert.ok(dense.y < -2 && dense.vy < 0);
});

test('water damps angular motion even without translational flow', () => {
  const b = body({ y: -2, mass: rho * volume, submergedVolume: volume, wy: 6 });
  advance(b, water(), 0.2);
  assert.ok(b.wy > 0 && b.wy < 6);
  close(b.vx, 0); close(b.vy, 0); close(b.vz, 0);
});

test('seabed support uses the actual bottom and never reports terrain impulse as water impulse', () => {
  const b = body({ y: -0.6, vx: 3, vy: -20, submergedVolume: volume });
  const free = { ...b }, hit = result(), noBed = result(), dt = 0.02;
  stepWaterEntry(b, water({ bed: -1, depth: 1 }), bottom, top, dt, hit);
  stepWaterEntry(free, water(), bottom, top, dt, noBed);
  assert.equal(hit.grounded, true);
  close(b.y + bottom, -1); close(b.vy, 0);
  assert.ok(free.y + bottom < -1);
  close(hit.impulseX, noBed.impulseX); close(hit.impulseY, noBed.impulseY); close(hit.impulseZ, noBed.impulseZ);
  const resting = body({ y: -1 - bottom, submergedVolume: volume });
  stepWaterEntry(resting, water({ bed: -1, depth: 1 }), bottom, top, 1 / 240, hit);
  close(hit.work, 0); close(resting.y + bottom, -1);
});

test('substep refinement converges across dry flight, entry and submerged drag', () => {
  const coarse = body({ y: 1.5, vx: 4, vy: -10, vz: -2 });
  const fine = { ...coarse };
  advance(coarse, water(), 0.5, 1 / 120);
  advance(fine, water(), 0.5, 1 / 480);
  assert.ok(Math.hypot(coarse.x - fine.x, coarse.y - fine.y, coarse.z - fine.z) < 0.025);
  assert.ok(Math.hypot(coarse.vx - fine.vx, coarse.vy - fine.vy, coarse.vz - fine.vz) < 0.1);
  close(coarse.submergedVolume, volume); close(fine.submergedVolume, volume);
});
