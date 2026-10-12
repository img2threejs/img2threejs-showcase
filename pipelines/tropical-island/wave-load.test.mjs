// Numeric invariants for the wave-forces / buoyant-body layer.
// Real ShallowWater + real sampleWaveLoad + real BuoyantBody, no mocks.
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPhysicsModule } from './load-physics.mjs';

const { ShallowWater } = await loadPhysicsModule('shallowWater');
const { sampleWaveLoad, BuoyantBody } = await loadPhysicsModule('waveForces');

const FACE_HEIGHT = 0.6;
const FACE_BASE_Y = -0.3;
const BODY_DT = 1 / 120;
const MOORING_ROPE = 100; // N/m, physical rope stiffness

function buildWater(bedAt) { return new ShallowWater(bedAt); }

// Half immersed at mean sea level: base -0.3..0.3 in 0.6 m of water.
function halfImmersed(normalX, normalZ) {
  return {
    x: 5,
    z: 0,
    baseY: FACE_BASE_Y,
    width: 1,
    height: FACE_HEIGHT,
    normalX,
    normalZ,
    velocityX: 0,
    velocityZ: 0,
  };
}

function measure(surface, contact) {
  const out = { forceX: 0, forceZ: 0, pressure: 0, immersion: 0, influence: 0, breaking: 0 };
  sampleWaveLoad(surface, contact, out);
  return out;
}

function setUniformCurrent(flow, ux, uz) {
  const N = flow.size * flow.size;
  for (let i = 0; i < N; i += 1) {
    flow.momentumX[i] = ux * Math.max(0.001, flow.depth[i]);
    flow.momentumZ[i] = uz * Math.max(0.001, flow.depth[i]);
  }
  flow.pack();
}

function snapshot(body) {
  return {
    heave: body.state.heave,
    pitch: body.state.pitch,
    roll: body.state.roll,
    surgeX: body.state.surgeX,
    surgeZ: body.state.surgeZ,
    velocityX: body.state.velocityX,
    velocityZ: body.state.velocityZ,
    load: body.state.load,
  };
}

// Calm field: reset momentum, restore dry-bed depth, repack. Static waves
// are erased; pack refreshes surfaceData/flowData so the body sees still water.
function calmPack(flow) {
  for (let i = 0; i < flow.depth.length; i += 1) {
    flow.depth[i] = Math.max(0, -flow.bed[i]);
    flow.momentumX[i] = flow.momentumZ[i] = 0;
  }
  flow.pack();
}

// ---------------------------------------------------------------------------
// sampleWaveLoad invariants on a packed uniform-current field.

test('head-on load exceeds grazing load on the same wet field', () => {
  const flow = buildWater(() => -1.4);
  setUniformCurrent(flow, 1.4, 0);
  const head = measure(flow, halfImmersed(1, 0));
  const grazing = measure(flow, halfImmersed(0.1736, 0.9848)); // ~10° from grazing
  assert.ok(head.immersion > 0, `head-on must be wet: ${head.immersion}`);
  assert.ok(Math.abs(head.forceX) > Math.abs(grazing.forceX) + 1e-6,
    `head-on |Fx|=${Math.abs(head.forceX)} must exceed grazing ${Math.abs(grazing.forceX)}`);
});

test('flipping both current and normal flips load sign and preserves magnitude', () => {
  const flowA = buildWater(() => -1.4), flowB = buildWater(() => -1.4);
  setUniformCurrent(flowA, 1.4, 0);
  setUniformCurrent(flowB, -1.4, 0);
  const a = measure(flowA, halfImmersed(1, 0));
  const b = measure(flowB, halfImmersed(-1, 0));
  assert.ok(a.immersion > 0 && b.immersion > 0,
    `both wet: a=${a.immersion} b=${b.immersion}`);
  assert.ok(a.forceX * b.forceX < -1e-6, `loads must oppose: ${a.forceX} vs ${b.forceX}`);
  const ratio = Math.abs(a.forceX) / Math.abs(b.forceX);
  assert.ok(ratio > 0.95 && ratio < 1.05, `magnitudes must match: ${ratio}`);
});

test('back-facing contact against incoming current sees no incoming load', () => {
  const flow = buildWater(() => -1.4);
  setUniformCurrent(flow, 1.4, 0);
  const back = measure(flow, halfImmersed(-1, 0));
  assert.ok(Math.abs(back.forceX) < 1e-6, `Fx must be 0: ${back.forceX}`);
  assert.ok(Math.abs(back.forceZ) < 1e-6, `Fz must be 0: ${back.forceZ}`);
});

test('doubling velocity multiplies wet pressure by ~4×', () => {
  const slow = buildWater(() => -1.4), fast = buildWater(() => -1.4);
  setUniformCurrent(slow, 1.4, 0);
  setUniformCurrent(fast, 2.8, 0);
  const a = measure(slow, halfImmersed(1, 0));
  const b = measure(fast, halfImmersed(1, 0));
  assert.ok(a.pressure > 0 && b.pressure > 0, `pressures positive: ${a.pressure} ${b.pressure}`);
  const ratio = b.pressure / a.pressure;
  assert.ok(ratio > 3.5 && ratio < 4.5, `quadratic ratio ${ratio}`);
});

test('raising contact.baseY reduces immersion and force on a fixed wet field', () => {
  const flow = buildWater(() => -1.4);
  setUniformCurrent(flow, 1.4, 0);
  const deep = measure(flow, { ...halfImmersed(1, 0), baseY: -0.9 });
  const mid = measure(flow, halfImmersed(1, 0));
  const shallow = measure(flow, { ...halfImmersed(1, 0), baseY: 0.4 });
  assert.ok(deep.immersion > mid.immersion + 1e-6, `deep immersion ${deep.immersion}`);
  assert.ok(mid.immersion > shallow.immersion + 1e-6, `mid immersion ${mid.immersion}`);
  assert.ok(Math.abs(deep.forceX) > Math.abs(mid.forceX) + 1e-6, `deep |Fx| ${Math.abs(deep.forceX)}`);
  assert.ok(Math.abs(mid.forceX) > Math.abs(shallow.forceX) + 1e-6, `mid |Fx| ${Math.abs(mid.forceX)}`);
});

test('a dry grid produces zero immersion and zero force', () => {
  const flow = buildWater(() => 0.6);
  const out = measure(flow, halfImmersed(1, 0));
  assert.equal(out.immersion, 0, `dry immersion ${out.immersion}`);
  assert.equal(out.pressure, 0, `dry pressure ${out.pressure}`);
  assert.equal(out.forceX, 0, `dry Fx ${out.forceX}`);
  assert.equal(out.forceZ, 0, `dry Fz ${out.forceZ}`);
});

test('rotating current and normal by 90° rotates the load by 90°', () => {
  const flowA = buildWater(() => -1.4), flowB = buildWater(() => -1.4);
  setUniformCurrent(flowA, 1.4, 0);
  setUniformCurrent(flowB, 0, 1.4);
  const east = measure(flowA, halfImmersed(1, 0));
  const north = measure(flowB, halfImmersed(0, 1));
  const eastMag = Math.hypot(east.forceX, east.forceZ);
  const northMag = Math.hypot(north.forceX, north.forceZ);
  assert.ok(eastMag > 1e-6 && northMag > 1e-6, `both nonzero: east=${eastMag} north=${northMag}`);
  const ratio = Math.max(eastMag, northMag) / Math.min(eastMag, northMag);
  assert.ok(ratio < 1.05, `magnitude invariant: ${ratio}`);
  assert.ok(Math.abs(east.forceX) > Math.abs(east.forceZ), `east on X: ${east.forceX}, ${east.forceZ}`);
  assert.ok(Math.abs(north.forceZ) > Math.abs(north.forceX), `north on Z: ${north.forceX}, ${north.forceZ}`);
});

// ---------------------------------------------------------------------------
// BuoyantBody at-rest equilibrium: no current, flat lake. Real buoyancy on a
// packed field should settle to neutral draft; angular states are zero.

test('a BuoyantBody at rest settles to neutral draft on a still flat lake', () => {
  const flow = buildWater(() => -2.0);
  flow.pack();
  const body = new BuoyantBody(flow, {
    x: 0, z: 0, yaw: 0,
    halfLength: 0.5, halfWidth: 0.5,
    draft: 0.4, mass: 100, mooring: MOORING_ROPE,
  });
  let tailHeave = 0, tailRoll = 0, tailPitch = 0;
  for (let step = 0; step < 600; step += 1) {
    body.advance(1 / 60);
    if (step >= 360) {
      tailHeave = Math.max(tailHeave, Math.abs(body.state.heave));
      tailRoll = Math.max(tailRoll, Math.abs(body.state.roll));
      tailPitch = Math.max(tailPitch, Math.abs(body.state.pitch));
    }
  }
  assert.ok(tailHeave < 5e-3, `steady heave must be neutral: ${tailHeave}`);
  assert.ok(tailRoll < 5e-3, `steady roll must be neutral: ${tailRoll}`);
  assert.ok(tailPitch < 5e-3, `steady pitch must be neutral: ${tailPitch}`);
});

// ---------------------------------------------------------------------------
// BuoyantBody on a uniform-current lake: drift, then freeze ALL state
// (heave/pitch/roll/surge/velocity/load) under reduced motion and zero dt.

test('BuoyantBody drifts under uniform current, then freezes under reduced motion / zero dt', () => {
  const flow = buildWater(() => -1.4);
  setUniformCurrent(flow, 1.4, 0);
  const body = new BuoyantBody(flow, {
    x: 0, z: 0, yaw: 0,
    halfLength: 0.5, halfWidth: 0.5,
    draft: 0.4, mass: 100, mooring: 0,
  });
  for (let step = 0; step < 600; step += 1) body.advance(1 / 60);
  assert.ok(Math.hypot(body.state.surgeX, body.state.surgeZ) > 1e-3,
    `body must drift under current: surgeX=${body.state.surgeX} surgeZ=${body.state.surgeZ}`);
  const snap = snapshot(body);
  for (let step = 0; step < 30; step += 1) body.advance(1 / 60, true);
  for (const key of Object.keys(snap)) {
    assert.equal(body.state[key], snap[key], `reduced-motion must freeze ${key}`);
  }
  body.advance(0);
  for (const key of Object.keys(snap)) {
    assert.equal(body.state[key], snap[key], `zero-dt must freeze ${key}`);
  }
});

// ---------------------------------------------------------------------------
// Propagated crest: actual pack before body. Crests travel along world +X
// and +Z. Yaw covariance: rotating the hull by π/2 (Three.js +Y) maps
// the tilt axis from roll to pitch. Mooring restores rest after calm.

function runCrest(bedAt, impactX, impactZ, bodyX, bodyZ, yaw, duration) {
  const flow = buildWater(bedAt);
  // Contract fixture for the wave-load test: physical incremental entry with
  // an explicit cavity/impulse/work tuple so the propagated crest is
  // reproducible across revisions.
  flow.coupleBody(impactX, impactZ, 0.72, 0.65, 0, 0, 15000);
  const body = new BuoyantBody(flow, {
    x: bodyX, z: bodyZ, yaw,
    halfLength: 0.5, halfWidth: 0.5,
    draft: 0.12, mass: 100, mooring: MOORING_ROPE,
  });
  let firstReaction = -1, peakHeave = 0, peakSurge = 0, peakRoll = 0, peakPitch = 0;
  const steps = Math.max(1, Math.round(duration / BODY_DT));
  for (let frame = 0; frame < steps; frame += 1) {
    flow.advance(BODY_DT);
    flow.pack();
    body.advance(BODY_DT);
    if (firstReaction < 0 && Math.hypot(body.state.surgeX, body.state.surgeZ) > 1e-3) firstReaction = frame;
    peakHeave = Math.max(peakHeave, Math.abs(body.state.heave));
    peakSurge = Math.max(peakSurge, Math.hypot(body.state.surgeX, body.state.surgeZ));
    peakRoll = Math.max(peakRoll, Math.abs(body.state.roll));
    peakPitch = Math.max(peakPitch, Math.abs(body.state.pitch));
  }
  return { flow, body, firstReaction, peakHeave, peakSurge, peakRoll, peakPitch };
}

test('a crest along world +X rolls a yaw-0 hull, then yaw=π/2 maps it to pitch', () => {
  // Wave from -2 on X reaches (4,0) ≈6 m at √g·1.4≈3.7 m/s, ≈1.6 s = 195 frames.
  const yaw0 = runCrest(() => -1.4, -2, 0, 4, 0, 0, 4.0);
  assert.ok(yaw0.firstReaction > 0 && yaw0.firstReaction < 360,
    `yaw=0 arrival frame ${yaw0.firstReaction}`);
  assert.ok(yaw0.peakHeave > 1e-3, `heave ${yaw0.peakHeave}`);
  assert.ok(yaw0.peakSurge > 1e-3, `surge ${yaw0.peakSurge}`);
  assert.ok(yaw0.peakRoll > 1e-3, `yaw=0 roll ${yaw0.peakRoll}`);
  assert.ok(yaw0.peakRoll > yaw0.peakPitch,
    `yaw=0 crest-along-X must roll > pitch: roll=${yaw0.peakRoll} pitch=${yaw0.peakPitch}`);

  const yaw90 = runCrest(() => -1.4, -2, 0, 4, 0, Math.PI / 2, 4.0);
  assert.ok(yaw90.peakPitch > 1e-3, `yaw=π/2 pitch ${yaw90.peakPitch}`);
  assert.ok(yaw90.peakPitch > yaw90.peakRoll,
    `yaw=π/2 must pitch > roll (covariance): pitch=${yaw90.peakPitch} roll=${yaw90.peakRoll}`);

  // Calm: mooring restores rest after pack-erase.
  calmPack(yaw0.flow);
  for (let i = 0; i < 25; i += 1) {
    yaw0.body.advance(1);
  }
  assert.ok(Math.hypot(yaw0.body.state.surgeX, yaw0.body.state.surgeZ) < yaw0.peakSurge * 0.05,
    `restored surge ${yaw0.body.state.surgeX}`);
  assert.ok(Math.abs(yaw0.body.state.heave) < yaw0.peakHeave * 0.05,
    `restored heave ${yaw0.body.state.heave}`);
  assert.ok(Math.abs(yaw0.body.state.roll) < yaw0.peakRoll * 0.05,
    `restored roll ${yaw0.body.state.roll}`);
});

test('a crest along world +Z pitches a yaw-0 hull, then yaw=π/2 maps it to roll', () => {
  // Wave from (0,-2) reaches (0,4) at body-local +Z side, ≈1.6 s = 195 frames.
  const yaw0 = runCrest(() => -1.4, 0, -2, 0, 4, 0, 4.0);
  assert.ok(yaw0.firstReaction > 0 && yaw0.firstReaction < 360,
    `yaw=0 arrival frame ${yaw0.firstReaction}`);
  assert.ok(yaw0.peakHeave > 1e-3, `heave ${yaw0.peakHeave}`);
  assert.ok(yaw0.peakSurge > 1e-3, `surge ${yaw0.peakSurge}`);
  assert.ok(yaw0.peakPitch > 1e-3, `yaw=0 pitch ${yaw0.peakPitch}`);
  assert.ok(yaw0.peakPitch > yaw0.peakRoll,
    `yaw=0 crest-along-Z must pitch > roll: pitch=${yaw0.peakPitch} roll=${yaw0.peakRoll}`);

  const yaw90 = runCrest(() => -1.4, 0, -2, 0, 4, Math.PI / 2, 4.0);
  assert.ok(yaw90.peakRoll > 1e-3, `yaw=π/2 roll ${yaw90.peakRoll}`);
  assert.ok(yaw90.peakRoll > yaw90.peakPitch,
    `yaw=π/2 must roll > pitch (covariance): roll=${yaw90.peakRoll} pitch=${yaw90.peakPitch}`);
});

// ---------------------------------------------------------------------------
// Static-slope body: real wet production field, depth gradient that crosses
// the body draft across the hull length. The body must tilt such that the
// deeper end sits higher in the column; the actual sampled field drives a
// real signed pitch.

test('a body on a real sloping bed tilts toward deeper water without a mock forwarder', () => {
  // depth at -Z = 0.2 (less than draft), depth at +Z = 1.0 (more than draft).
  // At heave=0 the -Z corners are depth-clamped, +Z corners are draft-clamped,
  // so the buoyancy asymmetry comes straight from the wet production field.
  const halfLength = 0.6, halfWidth = 0.4;
  const flow = buildWater((x, z) => -0.2 - (2 / 3) * (z + halfLength));
  flow.pack();
  const body = new BuoyantBody(flow, {
    x: 0, z: 0, yaw: 0,
    halfLength, halfWidth,
    draft: 0.4, mass: 100, mooring: 0,
  });
  let tailPitch = 0, tailRoll = 0;
  for (let step = 0; step < 1200; step += 1) {
    body.advance(BODY_DT);
    if (step >= 800) {
      tailPitch = Math.max(tailPitch, Math.abs(body.state.pitch));
      tailRoll = Math.max(tailRoll, Math.abs(body.state.roll));
    }
  }
  assert.ok(tailPitch > 1e-3, `slope must drive pitch: ${tailPitch}`);
  assert.ok(tailPitch > tailRoll,
    `pitch must dominate on Z-slope: pitch=${tailPitch} roll=${tailRoll}`);
  // Sign convention: keel = heave + roll*lx - pitch*lz - draft. Deeper at
  // +Z lifts that corner (keel y higher) ⇒ -pitch*halfLength > 0 ⇒ pitch<0.
  assert.ok(body.state.pitch < 0,
    `deeper +Z must sign pitch negative: ${body.state.pitch}`);
});

// ---------------------------------------------------------------------------
// Coarse vs subdivided equivalence on a fixed packed fluid field. Elapsed
// > 0.32 s catches dropped/superstep bugs now that the main step is 1/120.

test('coarse vs subdivided advance agrees on a fixed packed fluid field', () => {
  const flow = buildWater(() => -1.4);
  setUniformCurrent(flow, 1.4, 0);
  const a = new BuoyantBody(flow, { x: 0, z: 0, yaw: 0, halfLength: 0.5, halfWidth: 0.5, draft: 0.4, mass: 100, mooring: MOORING_ROPE });
  const b = new BuoyantBody(flow, { x: 0, z: 0, yaw: 0, halfLength: 0.5, halfWidth: 0.5, draft: 0.4, mass: 100, mooring: MOORING_ROPE });
  const total = 0.6; // > 0.32
  // A single frame longer than the former 0.32 s cap must retain all elapsed time.
  a.advance(total);
  // Subdivided: 72 × 1/120 s at the main step.
  for (let step = 0; step < 72; step += 1) b.advance(BODY_DT);
  const tol = 1e-4;
  assert.ok(Math.abs(a.state.heave - b.state.heave) < tol,
    `heave must agree: a=${a.state.heave} b=${b.state.heave}`);
  assert.ok(Math.abs(a.state.surgeX - b.state.surgeX) < tol,
    `surgeX must agree: a=${a.state.surgeX} b=${b.state.surgeX}`);
  assert.ok(Math.abs(a.state.surgeZ - b.state.surgeZ) < tol,
    `surgeZ must agree: a=${a.state.surgeZ} b=${b.state.surgeZ}`);
});