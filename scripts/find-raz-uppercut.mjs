#!/usr/bin/env node
/**
 * Find the uppercut in this rig, against EVERY criterion at once.
 *
 * Three earlier attempts picked a clip on one criterion each and each was wrong, which is the whole
 * reason this script exists:
 *
 *   1. `front_kick_02` — picked for being the fastest measured event. A knockout is not whatever is
 *      quickest; it is a punch.
 *   2. `box_03` handL — picked for finishing highest of the measured hands. Measured for DIRECTION
 *      afterwards it travels 20 degrees above horizontal: an arc, which is what `hook` means.
 *   3. `angry_03` handR — picked for rising steeply, 81 degrees. But its ELBOW holds 120 degrees from
 *      load to apex without ever bending: a fist carried up by the torso, not punched up.
 *   4. `preset:jump` handL — picked for elevation plus a bent elbow plus the hardest hip drive. It
 *      starts at 0.433 H with the hip at 0.431 H: level with the waist, not BELOW it.
 *
 * Every one of those was a true statement about a measurement and a wrong conclusion, because the
 * search space was filtered on one axis at a time. So this filters on all of them simultaneously and
 * ranks what survives. The brief, restated as gates on a rising hand segment:
 *
 *   BELOW-WAIST   the drive STARTS with the fist under the hip line — "móc từ dưới eo"
 *   TO-CHIN       it ENDS at or above the chin line — "lên cằm của đối thủ"
 *   RISING        the travel is steeply upward rather than an arc across
 *   ELBOW         the arm is a folded lever throughout, never an extended reach
 *   HIP-DRIVE     the hip is still climbing as the fist arrives — power from the legs
 *   AIRBORNE      the body leaves the floor during the drive — "đồng thời nhảy lên"
 *
 *   node scripts/find-raz-uppercut.mjs            ranked survivors
 *   node scripts/find-raz-uppercut.mjs --all      also show what each gate rejected, and why
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RIG_PATH = join(ROOT, 'src/demos/raz/rigData.ts');
const SAMPLES = 400;
const FIGURE_HEIGHT = 2.115;
/** A standing opponent's chin, absolute figure heights — the head line this rig is measured in. */
const CHIN = 0.71;
const SHOW_ALL = process.argv.includes('--all');

function readRig() {
  const text = readFileSync(RIG_PATH, 'utf8');
  const start = text.indexOf('{', text.indexOf('export const RIG'));
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('cannot find the RIG object literal');
  return JSON.parse(text.slice(start, end + 1));
}
function floats(b64) {
  const bytes = Buffer.from(b64, 'base64');
  const out = new Float32Array(bytes.byteLength / 4);
  Buffer.from(out.buffer).set(bytes);
  return out;
}
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
function buildClips(rig) {
  return rig.clips.map((clip) => {
    const tracks = [];
    for (const t of clip.tracks) {
      const name = rig.bones[t.bone]?.name;
      if (!name) continue;
      const times = floats(t.times);
      if (t.position) tracks.push(new THREE.VectorKeyframeTrack(`${name}.position`, times, floats(t.position)));
      if (t.quaternion) tracks.push(new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, times, floats(t.quaternion)));
      if (t.scale) tracks.push(new THREE.VectorKeyframeTrack(`${name}.scale`, times, floats(t.scale)));
    }
    return new THREE.AnimationClip(clip.name, clip.duration, tracks);
  });
}

const JOINTS = {
  handL: 'L_Hand', handR: 'R_Hand',
  forearmL: 'L_Forearm', forearmR: 'R_Forearm',
  upperarmL: 'L_Upperarm', upperarmR: 'R_Upperarm',
  toeL: 'L_ToeBase', toeR: 'R_ToeBase',
  head: 'Head', hip: 'Hip',
};

function sampleClip(rig, clip) {
  const { bones, root } = buildBones(rig);
  const carrier = new THREE.Object3D();
  carrier.scale.setScalar(rig.normalise.scale);
  carrier.add(root);
  const stage = new THREE.Object3D();
  stage.position.fromArray(rig.normalise.offset);
  stage.add(carrier);
  const byName = new Map(bones.map((b) => [b.name, b]));
  const tracked = {};
  for (const [k, n] of Object.entries(JOINTS)) {
    const b = byName.get(n);
    if (!b) throw new Error(`no bone ${n}`);
    tracked[k] = b;
  }
  const mixer = new THREE.AnimationMixer(carrier);
  mixer.clipAction(clip).play();
  const dt = clip.duration / SAMPLES;
  const frames = [];
  const s = new THREE.Vector3();
  mixer.setTime(0);
  for (let i = 0; i < SAMPLES; i += 1) {
    if (i > 0) mixer.update(dt);
    stage.updateMatrixWorld(true);
    const f = { t: i * dt };
    for (const [k, b] of Object.entries(tracked)) { b.getWorldPosition(s); f[k] = s.clone(); }
    frames.push(f);
  }
  return { frames, dt };
}

function elbow(f, side) {
  const a = f[`forearm${side}`].clone().sub(f[`upperarm${side}`]);
  const b = f[`hand${side}`].clone().sub(f[`forearm${side}`]);
  if (a.lengthSq() < 1e-9 || b.lengthSq() < 1e-9) return NaN;
  return 180 - a.normalize().angleTo(b.normalize()) * 180 / Math.PI;
}

/**
 * Every maximal RISING RUN of the hand: a stretch of consecutive frames over which the fist only
 * gains height. A run is the natural unit here — a punch is one continuous drive, and slicing the
 * motion into fixed windows (what the earlier probe did) can start a "drive" halfway up, which is
 * precisely how a fist that begins at the waist got mistaken for one that begins below it.
 */
function risingRuns(frames, key) {
  const runs = [];
  let start = null;
  for (let i = 1; i < frames.length; i += 1) {
    const climbing = frames[i][key].y > frames[i - 1][key].y;
    if (climbing && start === null) start = i - 1;
    if (!climbing && start !== null) { runs.push([start, i - 1]); start = null; }
  }
  if (start !== null) runs.push([start, frames.length - 1]);
  return runs.filter(([a, b]) => b - a >= 3);
}

const rig = readRig();
const clips = buildClips(rig);
const rows = [];

for (const clip of clips) {
  const { frames, dt } = sampleClip(rig, clip);
  // The floor this clip stands on: the lowest either toe ever gets. Airborne is measured against it.
  let floor = Infinity;
  for (const f of frames) floor = Math.min(floor, f.toeL.y, f.toeR.y);

  for (const side of ['L', 'R']) {
    const key = `hand${side}`;
    for (const [a, b] of risingRuns(frames, key)) {
      const from = frames[a];
      const to = frames[b];
      const startH = from[key].y / FIGURE_HEIGHT;
      const endH = to[key].y / FIGURE_HEIGHT;
      const climb = endH - startH;
      if (climb < 0.12) continue; // not a drive at all

      const lateral = Math.hypot(to[key].x - from[key].x, to[key].z - from[key].z) / FIGURE_HEIGHT;
      const elevation = Math.atan2(climb, lateral) * 180 / Math.PI;
      // Elbow across the whole drive: an uppercut is folded throughout, not folded on one frame.
      let elbowMax = -Infinity;
      let elbowAtEnd = NaN;
      for (let i = a; i <= b; i += 1) {
        const e = elbow(frames[i], side);
        elbowMax = Math.max(elbowMax, e);
        if (i === b) elbowAtEnd = e;
      }
      const hipRise = (to.hip.y - from.hip.y) / FIGURE_HEIGHT / ((b - a) * dt);
      // Airborne: both toes clear of this clip's own floor at any point during the drive.
      let lift = 0;
      for (let i = a; i <= b; i += 1) {
        lift = Math.max(lift, (Math.min(frames[i].toeL.y, frames[i].toeR.y) - floor) / FIGURE_HEIGHT);
      }

      const gates = {
        'BELOW-WAIST': from[key].y < from.hip.y,
        'TO-CHIN': endH >= CHIN,
        RISING: elevation >= 60,
        ELBOW: elbowMax <= 110,
        'HIP-DRIVE': hipRise > 0,
        AIRBORNE: lift >= 0.02,
      };
      const passed = Object.values(gates).filter(Boolean).length;
      rows.push({
        clip: clip.name, hand: key, t0: from.t, t1: to.t,
        startH, endH, climb, elevation, elbowMax, elbowAtEnd, hipRise, lift,
        waistGap: (from.hip.y - from[key].y) / FIGURE_HEIGHT,
        gates, passed,
      });
    }
  }
}

rows.sort((x, y) => (y.passed - x.passed) || (y.climb - x.climb));

const GATES = ['BELOW-WAIST', 'TO-CHIN', 'RISING', 'ELBOW', 'HIP-DRIVE', 'AIRBORNE'];
const full = rows.filter((r) => r.passed === GATES.length);

console.log(`\nuppercut search · ${clips.length} clips × 2 hands · ${rows.length} rising drives of >= 0.12 H\n`);
console.log(`gates: ${GATES.join(', ')}  (chin line ${CHIN} H)\n`);

if (!full.length) {
  console.log('  NOTHING passes all six gates.\n');
} else {
  console.log(`  ${full.length} drive(s) pass ALL SIX:\n`);
}
const show = full.length ? full : rows.slice(0, 12);
console.log('  clip                            hand   window          start   end     climb  elev  elbowMax  hipRise  lift   gates');
for (const r of show) {
  const failed = GATES.filter((g) => !r.gates[g]);
  console.log(
    `  ${r.clip.padEnd(30)} ${r.hand.padEnd(6)} ${r.t0.toFixed(2)}-${r.t1.toFixed(2)}s   `
    + `${r.startH.toFixed(3)}  ${r.endH.toFixed(3)}  ${r.climb.toFixed(3)}  ${r.elevation.toFixed(0).padStart(3)}°  `
    + `${r.elbowMax.toFixed(0).padStart(3)}°      ${r.hipRise.toFixed(2).padStart(5)}  ${r.lift.toFixed(3)}  `
    + `${r.passed}/6${failed.length ? ' fail:' + failed.join(',') : ''}`,
  );
}

if (SHOW_ALL) {
  console.log('\n  how many drives each gate rejects, over all candidates\n');
  for (const g of GATES) {
    const kept = rows.filter((r) => r.gates[g]).length;
    console.log(`    ${g.padEnd(12)} keeps ${String(kept).padStart(3)} / ${rows.length}`);
  }
  console.log('\n  the four clips previously chosen, and which gate each one fails\n');
  for (const want of ['preset:jump', 'preset:biped:angry_03', 'preset:biped:box_03', 'preset:biped:front_kick_02']) {
    const mine = rows.filter((r) => r.clip === want).sort((a, b) => b.passed - a.passed)[0];
    if (!mine) { console.log(`    ${want}: no rising drive over 0.12 H`); continue; }
    const failed = GATES.filter((g) => !mine.gates[g]);
    console.log(`    ${want.padEnd(30)} ${mine.hand} best ${mine.passed}/6${failed.length ? '  fails ' + failed.join(', ') : ''}`);
  }
}
console.log('');
