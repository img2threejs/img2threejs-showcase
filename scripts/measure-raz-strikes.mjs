#!/usr/bin/env node
/**
 * Sweep every clip embedded in the raz rig and print the strike, footfall and trail numbers
 * that `src/demos/raz/strikeEvents.ts` is written from.
 *
 * Nothing here is eyeballed off a scrub bar. The skeleton and the keyframes are decoded exactly the
 * way the browser decodes them — same base64, same bone order, same AnimationMixer — and every
 * joint is sampled through forward kinematics at 400 samples per clip. Distances are reported in
 * figure heights so no number in the table depends on the normalisation scale staying what it is.
 *
 *   node scripts/measure-raz-strikes.mjs            accepted events, per clip
 *   node scripts/measure-raz-strikes.mjs --rejected also print the candidates the floors threw out
 *
 * A STRIKE is three things at once, which is what separates a landed blow from a limb merely
 * reversing direction:
 *
 *   1. a local maximum in limb speed at or above 45% of that limb's 95th-percentile speed for the
 *      clip;
 *   2. that speed collapsing by at least 50% within 0.14 s — the fist or the foot is STOPPED, not
 *      curving through;
 *   3. the stop happening at EXTENSION: hip-to-limb distance in the top 30% of that limb's range
 *      for the clip. A gesture reverses close to the body; a strike ends reaching out.
 *
 * Percentiles rather than maxima, because one bad sample at `t = duration` — where the mixer snaps
 * the pose — would otherwise set the threshold for the whole clip and reject every real event in
 * it. And because test 3 is a percentile WITHIN a clip, a candidate must also clear two ABSOLUTE
 * floors, or a clip whose limbs never extend reports its least bent one as a strike.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/**
 * Which rig to sweep. Defaults to Raz; `--rig <path>` points it at any other rig that ships the same
 * 41 bone names — Roblin's does, so the duel's staging for BOTH fighters comes out of this one script.
 */
const rigArg = process.argv.indexOf('--rig');
const RIG_PATH = rigArg > 0 ? join(ROOT, process.argv[rigArg + 1]) : join(ROOT, 'src/demos/raz/rigData.ts');

const SAMPLES = 400;
/** Absolute floors, in figure heights and figure heights per second. */
const FLOORS = {
  hand: { reach: 0.30, speed: 1.9, extend: 0.6 },
  foot: { reach: 0.34, speed: 2.2, extend: 0.6 },
};

/** How far back from an extension apex the approach speed is read. */
const APPROACH_WINDOW = 0.12;

// ------------------------------------------------------------------------------------ decoding

/** `rigData.ts` is one `export const RIG: EncodedRig = {...};` — take the object literal verbatim. */
function readRig() {
  const text = readFileSync(RIG_PATH, 'utf8');
  const start = text.indexOf('{', text.indexOf('export const RIG'));
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('cannot find the RIG object literal in rigData.ts');
  return JSON.parse(text.slice(start, end + 1));
}

function floats(base64) {
  const bytes = Buffer.from(base64, 'base64');
  const out = new Float32Array(bytes.byteLength / 4);
  Buffer.from(out.buffer).set(bytes);
  return out;
}

/** Same construction as `buildSkeleton` in meshCodec: parents always come first. */
function buildBones(rig) {
  const bones = rig.bones.map((b) => {
    const bone = new THREE.Bone();
    bone.name = b.name;
    bone.position.fromArray(b.position);
    bone.quaternion.fromArray(b.quaternion);
    bone.scale.fromArray(b.scale);
    return bone;
  });
  let root = null;
  rig.bones.forEach((b, i) => {
    if (b.parent >= 0) bones[b.parent].add(bones[i]);
    else if (!root) root = bones[i];
  });
  return { bones, root: root ?? bones[0] };
}

/** Same construction as `buildClips` in meshCodec. */
function buildClips(rig) {
  return rig.clips.map((clip) => {
    const tracks = [];
    for (const track of clip.tracks) {
      const name = rig.bones[track.bone]?.name;
      if (!name) continue;
      const times = floats(track.times);
      if (track.position) tracks.push(new THREE.VectorKeyframeTrack(`${name}.position`, times, floats(track.position)));
      if (track.quaternion) tracks.push(new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, times, floats(track.quaternion)));
      if (track.scale) tracks.push(new THREE.VectorKeyframeTrack(`${name}.scale`, times, floats(track.scale)));
    }
    return new THREE.AnimationClip(clip.name, clip.duration, tracks);
  });
}

// ------------------------------------------------------------------------------------ sampling

const JOINTS = {
  handL: 'L_Hand', handR: 'R_Hand',
  toeL: 'L_ToeBase', toeR: 'R_ToeBase',
  footL: 'L_Foot', footR: 'R_Foot',
  head: 'Head', chest: 'Spine02', hip: 'Hip',
  shoulderL: 'L_Upperarm', shoulderR: 'R_Upperarm',
};

/**
 * Sample one clip. The bone tree is parented to a carrier scaled by `normalise.scale`, exactly the
 * way the runtime parents it to the skinned mesh, so world positions come out in the units the
 * browser renders in rather than in bind space.
 */
function sampleClip(rig, clip) {
  const { bones, root } = buildBones(rig);
  const carrier = new THREE.Object3D();
  carrier.scale.setScalar(rig.normalise.scale);
  carrier.add(root);
  const stage = new THREE.Object3D();
  stage.position.fromArray(rig.normalise.offset);
  stage.add(carrier);

  const byName = new Map(bones.map((bone) => [bone.name, bone]));
  const tracked = Object.fromEntries(
    Object.entries(JOINTS).map(([key, name]) => {
      const bone = byName.get(name);
      if (!bone) throw new Error(`rig has no bone named ${name}`);
      return [key, bone];
    }),
  );

  const mixer = new THREE.AnimationMixer(carrier);
  const action = mixer.clipAction(clip);
  action.play();

  const dt = clip.duration / SAMPLES;
  const frames = [];
  const scratch = new THREE.Vector3();
  // Step from zero rather than seeking: the mixer interpolates forward, and a seek to an arbitrary
  // time re-enters the clip at its own binding state.
  mixer.setTime(0);
  for (let i = 0; i < SAMPLES; i += 1) {
    if (i > 0) mixer.update(dt);
    stage.updateMatrixWorld(true);
    const frame = { t: i * dt };
    for (const [key, bone] of Object.entries(tracked)) {
      bone.getWorldPosition(scratch);
      frame[key] = scratch.clone();
    }
    frames.push(frame);
  }
  return { frames, dt };
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[index];
}

// ------------------------------------------------------------------------------------ detection

/**
 * A strike is an EXTENSION APEX arrived at fast, where the EXTENSION ITSELF was fast.
 *
 * Two earlier passes at this were wrong in instructive ways, and both are worth keeping written
 * down because the same mistakes are the obvious first guesses.
 *
 *   1. "speed collapses inside a fixed window". Right for a punch, wrong for a kick: a straight
 *      lead stops dead on contact, but `front_kick_02` crosses its furthest point still travelling
 *      5.22 H/s and is retracting at 3.7 H/s a frame later. It rejected every kick in the set.
 *   2. "speed at the apex is under three quarters of the approach". Same failure, softer: it let
 *      `box_02` through and still threw out both kicks, because a snap kick loses nothing at the
 *      apex — it whips through it.
 *
 * What separates a strike from a limb merely sweeping past its furthest point is not how fast the
 * limb is going, it is how fast it was GETTING LONGER. So the apex is found first — a local maximum
 * of hip-to-limb distance, which is where the limb reverses and therefore where contact is — and
 * the tests are applied to the approach into it: the limb must be moving (speed), it must be
 * reaching (reach), and the reach must have been OPENING fast (extend). A hook, a snap kick and a
 * cross all pass. An arm at the top of a running swing, which is long but not lengthening, does not.
 */
function detectStrikes(frames, dt, limbKey, family, height, clipName) {
  const speeds = new Array(frames.length).fill(0);
  const reaches = new Array(frames.length).fill(0);
  for (let i = 0; i < frames.length; i += 1) {
    reaches[i] = frames[i][limbKey].distanceTo(frames[i].hip) / height;
    // Not wrapped to the last sample: several clips do not close on their own first pose, and the
    // seam between the two reads as a 20 H/s limb — which is how `defeat_03` first reported a kick
    // 14 ms into a clip that has none.
    if (i > 0) speeds[i] = frames[i][limbKey].distanceTo(frames[i - 1][limbKey]) / dt / height;
  }
  speeds[0] = speeds[1] ?? 0;
  // Radial rate: how fast the limb is getting longer. Positive on the way out, negative on the
  // way back, and zero by definition at the apex — which is why it is read over the approach.
  const extending = new Array(frames.length).fill(0);
  for (let i = 1; i < frames.length; i += 1) extending[i] = (reaches[i] - reaches[i - 1]) / dt;

  const p95 = percentile(speeds, 0.95);
  const reachGate = percentile(reaches, 0.70);
  const floors = FLOORS[family];
  const approachWindow = Math.max(2, Math.round(APPROACH_WINDOW / dt));

  const accepted = [];
  const rejected = [];
  for (let i = 1; i < frames.length - 1; i += 1) {
    if (reaches[i] < reaches[i - 1] || reaches[i] < reaches[i + 1]) continue;
    let approach = 0;
    let extend = 0;
    for (let k = 1; k <= approachWindow && i - k >= 0; k += 1) {
      approach = Math.max(approach, speeds[i - k]);
      extend = Math.max(extend, extending[i - k]);
    }
    const event = {
      clip: clipName,
      limb: limbKey,
      time: Number(frames[i].t.toFixed(3)),
      speed: Number(approach.toFixed(2)),
      // How much of the approach speed is gone at the apex. A punch arrives at ~0.9, a kick ~0.6.
      decel: Number((approach > 0 ? 1 - speeds[i] / approach : 0).toFixed(2)),
      reach: Number(reaches[i].toFixed(3)),
      extend: Number(extend.toFixed(2)),
      /**
       * Where the limb IS, relative to the hip, in the rig's own unrotated frame and in world units.
       * A duel places a defender at the attacker's contact, and a bearing measured against the
       * fighter's FACING cannot do that — the torso is turned as much as 50 degrees off the line the
       * fist travels. This offset is the line the fist travels.
       */
      offset: [
        Number((frames[i][limbKey].x - frames[i].hip.x).toFixed(3)),
        Number(frames[i][limbKey].y.toFixed(3)),
        Number((frames[i][limbKey].z - frames[i].hip.z).toFixed(3)),
      ],
      height: Number((frames[i][limbKey].y / height).toFixed(3)),
    };
    if (reaches[i] < reachGate) { rejected.push({ ...event, why: 'reach-percentile' }); continue; }
    if (reaches[i] < floors.reach) { rejected.push({ ...event, why: 'reach-floor' }); continue; }
    if (approach < p95 * 0.45) { rejected.push({ ...event, why: 'speed-percentile' }); continue; }
    if (approach < floors.speed) { rejected.push({ ...event, why: 'speed-floor' }); continue; }
    if (extend < floors.extend) { rejected.push({ ...event, why: 'not-extending' }); continue; }
    // One event per apex: neighbouring samples on the same reversal are the same blow.
    const last = accepted[accepted.length - 1];
    if (last && event.time - last.time < 0.12) continue;
    accepted.push(event);
  }
  return { accepted, rejected, p95: Number(p95.toFixed(2)) };
}

/**
 * Ground contacts, as threshold CROSSINGS rather than height minima, with the gate set per clip and
 * per foot from that foot's own lift range. A fixed gate cannot serve both a running stride, which
 * lifts the toe far, and the shuffle of a fighter holding a stance.
 */
function detectFootfalls(frames, dt, toeKey, height, clipName) {
  const y = frames.map((f) => f[toeKey].y / height);
  const low = Math.min(...y);
  const high = Math.max(...y);
  const range = high - low;
  if (range < 1e-4) return [];
  const contact = low + range * 0.30;
  const armed = low + range * 0.65;
  const out = [];
  let ready = false;
  for (let i = 1; i < frames.length; i += 1) {
    if (y[i] > armed) ready = true;
    if (!ready || y[i] > contact || y[i - 1] <= contact) continue;
    ready = false;
    const from = Math.max(0, i - 4);
    const drop = (y[from] - y[i]) / ((i - from) * dt);
    if (drop < 0.18) continue;
    out.push({ clip: clipName, foot: toeKey === 'toeL' ? 'left' : 'right', time: Number(frames[i].t.toFixed(3)), drop: Number(drop.toFixed(2)) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------- main

const showRejected = process.argv.includes('--rejected');
const rig = readRig();
const clips = buildClips(rig);

// Figure height: the highest head the set reaches, plus a crown margin, so every normalised number
// below is against one constant rather than against whatever the active clip happens to do.
let crown = 0;
const sampled = new Map();
for (const clip of clips) {
  const data = sampleClip(rig, clip);
  sampled.set(clip.name, data);
  for (const frame of data.frames) crown = Math.max(crown, frame.head.y);
}
const HEIGHT = Number((crown * 1.06).toFixed(3));

console.log(`figure height H = ${HEIGHT} world units (highest head across ${clips.length} clips + 6% crown)\n`);

const strikes = [];
const footfalls = [];
const trailReference = {};
const rejectedAll = [];

for (const clip of clips) {
  const { frames, dt } = sampled.get(clip.name);
  const hands = [
    detectStrikes(frames, dt, 'handL', 'hand', HEIGHT, clip.name),
    detectStrikes(frames, dt, 'handR', 'hand', HEIGHT, clip.name),
  ];
  const feet = [
    detectStrikes(frames, dt, 'toeL', 'foot', HEIGHT, clip.name),
    detectStrikes(frames, dt, 'toeR', 'foot', HEIGHT, clip.name),
  ];
  trailReference[clip.name] = Number(Math.max(hands[0].p95, hands[1].p95, feet[0].p95, feet[1].p95).toFixed(2));

  for (const result of [...hands, ...feet]) {
    strikes.push(...result.accepted);
    rejectedAll.push(...result.rejected);
  }
  footfalls.push(
    ...detectFootfalls(frames, dt, 'toeL', HEIGHT, clip.name),
    ...detectFootfalls(frames, dt, 'toeR', HEIGHT, clip.name),
  );

  const mine = strikes.filter((s) => s.clip === clip.name);
  const label = `${clip.name} (${clip.duration.toFixed(2)}s)`;
  if (mine.length === 0) {
    console.log(`${label}  —  no strike clears the floors  ·  p95 ${trailReference[clip.name]} H/s`);
  } else {
    console.log(`${label}  ·  p95 ${trailReference[clip.name]} H/s`);
    for (const s of mine) {
      const flat = Math.hypot(s.offset[0], s.offset[2]);
      const bearing = Math.round((Math.atan2(s.offset[2], s.offset[0]) * 180) / Math.PI);
      console.log(`    ${s.limb.padEnd(5)} @ ${s.time.toFixed(3)}s  v ${s.speed.toFixed(2)} H/s  reach ${s.reach.toFixed(3)}  y ${s.height.toFixed(3)}  |  offsetFromHip ${flat.toFixed(3)} @ ${String(bearing).padStart(4)}deg  height ${s.offset[1].toFixed(3)}`);
    }
  }
}

console.log('\nfootfalls');
for (const f of footfalls) console.log(`    ${f.clip}  ${f.foot.padEnd(5)} @ ${f.time.toFixed(3)}s  drop ${f.drop.toFixed(2)} H/s`);

/**
 * Which way the figure FACES, per curated clip. The shoulder line gives the axis, the ankle-to-toe
 * vector gives the sign — the same construction the runtime uses. The demo camera is authored off
 * this: a download's default +Z framing watches a combination from behind if the figure turns.
 */
console.log('\nfacing yaw at each strike, degrees (0 = +X, 90 = +Z)');
for (const strike of strikes) {
  const { frames, dt } = sampled.get(strike.clip);
  const i = Math.min(frames.length - 1, Math.round(strike.time / dt));
  const f = frames[i];
  const sx = f.shoulderL.x - f.shoulderR.x;
  const sz = f.shoulderL.z - f.shoulderR.z;
  // facing = up x shoulder, then signed by the toes.
  let fx = -sz, fz = sx;
  const tx = (f.toeL.x - f.footL.x) + (f.toeR.x - f.footR.x);
  const tz = (f.toeL.z - f.footL.z) + (f.toeR.z - f.footR.z);
  if (fx * tx + fz * tz < 0) { fx = -fx; fz = -fz; }
  const yaw = (Math.atan2(fz, fx) * 180) / Math.PI;
  console.log(`    ${strike.clip.padEnd(30)} ${strike.limb.padEnd(5)} @ ${strike.time.toFixed(3)}s  yaw ${yaw.toFixed(0)}`);
}

console.log('\nroot drift over one loop, in figure heights (a clip over ~0.25 H walks out of frame)');
for (const clip of clips) {
  const { frames } = sampled.get(clip.name);
  const first = frames[0].hip;
  const last = frames[frames.length - 1].hip;
  const drift = Math.hypot(last.x - first.x, last.z - first.z) / HEIGHT;
  if (drift >= 0.05) console.log(`    ${clip.name.padEnd(30)} ${drift.toFixed(3)} H`);
}

console.log('\ntrail reference (p95 limb speed per clip, H/s)');
console.log(JSON.stringify(trailReference, null, 2));

if (showRejected) {
  console.log('\nrejected candidates');
  for (const r of rejectedAll) {
    console.log(`    ${r.clip}  ${r.limb.padEnd(5)} @ ${r.time.toFixed(3)}s  v ${r.speed.toFixed(2)}  extend ${r.extend.toFixed(2)}  reach ${r.reach.toFixed(3)}  -> ${r.why}`);
  }
}
