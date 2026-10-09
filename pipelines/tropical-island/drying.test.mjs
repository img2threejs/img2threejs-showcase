import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPhysicsModule } from './load-physics.mjs';

const { ShallowWater, WET_FILM_DEPTH, WET_DEPTH_WET } = await loadPhysicsModule('shallowWater');
const centre = Math.floor(ShallowWater.size / 2) * (ShallowWater.size + 1);
const film = () => new ShallowWater(() => -WET_FILM_DEPTH * 0.75);

function sameHydraulics(a, b) {
  for (const key of ['depth', 'momentumX', 'momentumZ']) {
    for (let i = 0; i < a[key].length; i++) assert.equal(a[key][i], b[key][i], `${key}[${i}]`);
  }
  assert.equal(a.absorbedVolume, b.absorbedVolume);
}

test('never-wet sand stays dry and sustained inundation stays saturated', () => {
  const dry = new ShallowWater(() => 0.5);
  const flooded = new ShallowWater(() => -WET_DEPTH_WET * 2);
  dry.advance(0.6);
  flooded.advance(0.6);
  assert.ok(dry.wetness.every(w => w === 0));
  assert.ok(flooded.wetness.every(w => w === 1));
});

test('subvisual residual water no longer pins sand wetness after retreat', () => {
  const flow = film();
  const depths = flow.depth.slice();
  let previous = flow.wetness[centre];
  for (let step = 0; step < 12; step++) {
    flow.advance(0.5);
    const current = flow.wetness[centre];
    assert.ok(current > 0 && current < previous, 'wet sand dries continuously without disappearing at once');
    previous = current;
  }
  assert.ok(previous > 0.5 && previous < 0.7, `six-second drying residual ${previous}`);
  for (let i = 0; i < depths.length; i++) {
    assert.ok(Math.abs(flow.depth[i] - depths[i]) < 1e-12, 'visual drying must not evaporate solver volume');
  }
});

test('tiny returned drops cannot erase dampness, while fresh inundation rewets promptly', () => {
  const flow = film();
  flow.wetness.fill(0.4);
  const before = flow.wetness[centre];
  flow.returnWater(0, 0, 0.5, 0.0001, 0, 0);
  const immediately = flow.wetness[centre];
  assert.ok(immediately >= before - 1e-12 && immediately <= before + 0.01,
    'a tiny deposit cannot reset the affected cell dry or saturated');
  flow.advance(0.1);
  assert.ok(flow.wetness[centre] < before && flow.wetness[centre] > before * 0.98,
    'the subvisual film keeps drying gently on the physical clock');
  flow.returnWater(0, 0, 1, 1, 0, 0);
  flow.advance(0.5);
  assert.ok(flow.wetness[centre] > before + 0.2, 'a fresh wash visibly rewets the affected cell');
});

test('drying and rewetting agree across physical timestep subdivision', () => {
  const coarse = film(), fine = film();
  coarse.wetness.fill(0.4);
  fine.wetness.fill(0.4);
  coarse.advance(0.6);
  for (let i = 0; i < 12; i++) fine.advance(0.05);
  assert.ok(Math.abs(coarse.wetness[centre] - fine.wetness[centre]) < 1e-9);
  assert.ok(coarse.wetness[centre] < 0.4, 'the comparison must actually exercise drying');
  coarse.depth.fill(WET_DEPTH_WET * 2);
  fine.depth.fill(WET_DEPTH_WET * 2);
  coarse.advance(0.6);
  for (let i = 0; i < 12; i++) fine.advance(0.05);
  assert.ok(Math.abs(coarse.wetness[centre] - fine.wetness[centre]) < 1e-9);
  assert.ok(coarse.wetness[centre] > 0.9, 'the comparison must actually exercise rewetting');
});

test('different moisture histories cannot change water volume or either momentum component', () => {
  const bed = x => Math.max(-1.4, Math.min(0.4, x * 0.4));
  const a = new ShallowWater(bed), b = new ShallowWater(bed);
  a.wetness.fill(0.1);
  b.wetness.fill(0.9);
  a.addImpulse(-1.8, 0, 1);
  b.addImpulse(-1.8, 0, 1);
  a.advance(0.6);
  b.advance(0.6);
  sameHydraulics(a, b);
});

test('moisture does not advance on a frozen or invalid physical timestep', () => {
  const flow = new ShallowWater(() => 0.5);
  flow.wetness.fill(0.7);
  const before = flow.wetness.slice();
  for (const dt of [0, -1, NaN]) flow.advance(dt);
  assert.deepEqual(flow.wetness, before);
  flow.advance(0.2);
  assert.ok(flow.wetness[centre] < before[centre], 'resuming the same clock resumes drying');
});

function surfaceVolume(flow) {
  let volume = 0;
  for (let i = 0; i < flow.depth.length; i++) {
    volume += flow.depth[i] * flow.cellWidths[i % flow.size] * flow.cellWidths[(i / flow.size) | 0];
  }
  return volume;
}

test('standing shore puddles soak away without draining the sea or losing accounted water', () => {
  const land = new ShallowWater(() => 0.2);
  land.depth.fill(0.006);
  land.wetness.fill(1);
  const initial = surfaceVolume(land);
  land.advance(5);
  assert.ok(land.depth.every(h => h === 0), 'a stranded film must not remain permanently flooded');
  assert.ok(land.wetness[centre] > 0.4 && land.wetness[centre] < 0.95,
    'the drained surface keeps a fading damp stain instead of snapping dry');
  assert.ok(Math.abs(surfaceVolume(land) + land.absorbedVolume - initial) < 1e-6,
    'every removed surface parcel is accounted in the soil');
  const sea = new ShallowWater(() => -0.006);
  const seaBefore = surfaceVolume(sea);
  sea.advance(5);
  assert.equal(sea.absorbedVolume, 0, 'soil absorption never applies below resting sea level');
  assert.ok(Math.abs(surfaceVolume(sea) - seaBefore) < 1e-8);
});

test('soil absorption removes proportional momentum instead of accelerating the remaining water', () => {
  const flow = new ShallowWater(() => 0.2);
  flow.depth.fill(0.6);
  flow.momentumX.fill(0.6 * 0.25);
  flow.momentumZ.fill(0.6 * -0.1);
  flow.advance(0.2);
  assert.ok(flow.depth[centre] < 0.6);
  assert.ok(Math.abs(flow.momentumX[centre] / flow.depth[centre] - 0.25) < 1e-10);
  assert.ok(Math.abs(flow.momentumZ[centre] / flow.depth[centre] + 0.1) < 1e-10);
});
