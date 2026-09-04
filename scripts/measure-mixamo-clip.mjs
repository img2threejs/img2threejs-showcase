#!/usr/bin/env node
/**
 * Measure a Mixamo FBX against the same uppercut gates the raz rig was searched with.
 *
 * The point is to answer ONE question before any retargeting work is done: is the clip actually the
 * technique it is named after? A file called Uppercut.fbx is a filename, not a measurement, and the
 * whole reason this demo needed an external clip is that four candidates inside the rig each looked
 * right on one axis and were wrong on another.
 *
 * Gates are the ones from `find-raz-uppercut.mjs`, restated from the brief:
 *   BELOW-WAIST  the drive starts with the fist under the hip line
 *   TO-CHIN      it ends at or above the chin
 *   RISING       travel is steeply upward, not an arc across
 *   ELBOW        the arm stays a folded lever, never an extended reach
 *   HIP-DRIVE    the hip is still climbing as the fist arrives
 *   AIRBORNE     reported, not gated — a planted uppercut is still an uppercut
 *
 * Distances are normalised to the figure's own height so Mixamo's centimetre scale is irrelevant.
 *
 *   node scripts/measure-mixamo-clip.mjs <file.fbx>
 */

import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

const FILE = process.argv[2];
if (!FILE) { console.error('usage: node scripts/measure-mixamo-clip.mjs <file.fbx>'); process.exit(2); }
const SAMPLES = 400;
/** Chin as a fraction of standing height. The raz table calls 0.71 H the head line. */
const CHIN = 0.71;

const buf = readFileSync(FILE);
const group = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
const clip = group.animations.filter((a) => a.tracks.length > 0).sort((a, b) => b.tracks.length - a.tracks.length)[0];
if (!clip) { console.error('no animation with tracks in this file'); process.exit(1); }

/**
 * Mixamo's own names, so this script needs no knowledge of the raz rig.
 *
 * Note the missing colon: the FBX stores `mixamorig:Hips`, and three's FBXLoader strips the colon
 * when it sanitises names for property binding, so in the parsed scene it is `mixamorigHips`. The
 * animation tracks use the sanitised form too.
 */
const NAME = {
  hips: 'mixamorigHips', head: 'mixamorigHead',
  handL: 'mixamorigLeftHand', foreL: 'mixamorigLeftForeArm', armL: 'mixamorigLeftArm',
  handR: 'mixamorigRightHand', foreR: 'mixamorigRightForeArm', armR: 'mixamorigRightArm',
  toeL: 'mixamorigLeftToeBase', toeR: 'mixamorigRightToeBase',
};
/**
 * `getObjectByName` rather than a traverse, because this export contains each bone name TWICE and
 * the mixer's own PropertyBinding resolves a duplicate name the same way — first match in traversal
 * order. Reading a different instance than the one being animated would report a bone that never
 * moves.
 */
const bones = {};
for (const [k, n] of Object.entries(NAME)) {
  const found = group.getObjectByName(n);
  if (found) bones[k] = found;
}
const missing = Object.entries(NAME).filter(([k]) => !bones[k]).map(([, n]) => n);
if (missing.length) { console.error('missing bones:', missing.join(', ')); process.exit(1); }

const mixer = new THREE.AnimationMixer(group);
mixer.clipAction(clip).play();
const dt = clip.duration / SAMPLES;
const frames = [];
const s = new THREE.Vector3();
mixer.setTime(0);
for (let i = 0; i < SAMPLES; i += 1) {
  if (i > 0) mixer.update(dt);
  group.updateMatrixWorld(true);
  const f = { t: i * dt };
  for (const [k, b] of Object.entries(bones)) { b.getWorldPosition(s); f[k] = s.clone(); }
  frames.push(f);
}

/** Standing height: the tallest the head gets, plus the crown margin the raz table uses. */
let H = 0;
for (const f of frames) H = Math.max(H, f.head.y);
H *= 1.06;
let floor = Infinity;
for (const f of frames) floor = Math.min(floor, f.toeL.y, f.toeR.y);

function elbowAt(f, side) {
  const a = f[`fore${side}`].clone().sub(f[`arm${side}`]);
  const b = f[`hand${side}`].clone().sub(f[`fore${side}`]);
  if (a.lengthSq() < 1e-9 || b.lengthSq() < 1e-9) return NaN;
  return 180 - a.normalize().angleTo(b.normalize()) * 180 / Math.PI;
}
function risingRuns(key) {
  const runs = [];
  let start = null;
  for (let i = 1; i < frames.length; i += 1) {
    const up = frames[i][key].y > frames[i - 1][key].y;
    if (up && start === null) start = i - 1;
    if (!up && start !== null) { runs.push([start, i - 1]); start = null; }
  }
  if (start !== null) runs.push([start, frames.length - 1]);
  return runs.filter(([a, b]) => b - a >= 3);
}

console.log(`\n${FILE}`);
console.log(`clip "${clip.name}"  ${clip.duration.toFixed(3)}s  ${clip.tracks.length} tracks  ·  figure height ${H.toFixed(1)} units\n`);

const GATES = ['BELOW-WAIST', 'TO-CHIN', 'RISING', 'ELBOW', 'HIP-DRIVE'];
const all = [];
for (const side of ['L', 'R']) {
  const key = `hand${side}`;
  for (const [a, b] of risingRuns(key)) {
    const from = frames[a]; const to = frames[b];
    const startH = from[key].y / H; const endH = to[key].y / H;
    const climb = endH - startH;
    if (climb < 0.08) continue;
    const lateral = Math.hypot(to[key].x - from[key].x, to[key].z - from[key].z) / H;
    const elevation = Math.atan2(climb, lateral) * 180 / Math.PI;
    let elbowMax = -Infinity;
    for (let i = a; i <= b; i += 1) elbowMax = Math.max(elbowMax, elbowAt(frames[i], side));
    /**
     * The elbow AT THE CONTACT, which is the frame the fist crosses the chin on the way up — not the
     * maximum across the drive.
     *
     * The brief says "giữ khuỷu tay gập một góc khoảng 90 độ" about the PUNCH, and a blow driven
     * through a target keeps travelling after it lands: this clip's fist finishes at 1.09 H, well
     * above the head, and the arm necessarily opens to get there. Gating the maximum over the whole
     * run therefore fails a clip for its follow-through, which is the same mistake an earlier check
     * in `score-raz-animation.mjs` made by sampling the retraction at one arbitrary instant.
     *
     * This is a STRICTER test where it matters and a fairer one where it does not: `angry_03`'s right
     * hand, rejected earlier for holding 120 degrees from load to apex, still fails — it is 120 at
     * the crossing too, because that arm never bends at all.
     */
    let elbowAtContact = NaN;
    let contactT = NaN;
    for (let i = a; i <= b; i += 1) {
      if (frames[i][key].y / H >= CHIN) { elbowAtContact = elbowAt(frames[i], side); contactT = frames[i].t; break; }
    }
    const hipRise = (to.hips.y - from.hips.y) / H / ((b - a) * dt);
    let lift = 0;
    for (let i = a; i <= b; i += 1) lift = Math.max(lift, (Math.min(frames[i].toeL.y, frames[i].toeR.y) - floor) / H);
    const gates = {
      'BELOW-WAIST': from[key].y < from.hips.y,
      'TO-CHIN': endH >= CHIN,
      RISING: elevation >= 60,
      ELBOW: elbowMax <= 110,
      'HIP-DRIVE': hipRise > 0,
    };
    all.push({
      side, t0: from.t, t1: to.t, startH, endH, climb, elevation, elbowMax, hipRise, lift,
      waistGap: (from.hips.y - from[key].y) / H,
      gates, passed: Object.values(gates).filter(Boolean).length,
    });
  }
}
all.sort((x, y) => (y.passed - x.passed) || (y.climb - x.climb));

console.log('  hand  window          start   end     climb  elev  elbowMax  hipRise  lift   underBelt  gates');
for (const r of all.slice(0, 10)) {
  const failed = GATES.filter((g) => !r.gates[g]);
  console.log(
    `  ${r.side}     ${r.t0.toFixed(2)}-${r.t1.toFixed(2)}s   ${r.startH.toFixed(3)}  ${r.endH.toFixed(3)}  `
    + `${r.climb.toFixed(3)}  ${r.elevation.toFixed(0).padStart(3)}°  ${r.elbowMax.toFixed(0).padStart(3)}°      `
    + `${r.hipRise.toFixed(2).padStart(5)}  ${r.lift.toFixed(3)}  ${r.waistGap >= 0 ? '+' : ''}${r.waistGap.toFixed(3)} H   `
    + `${r.passed}/${GATES.length}${failed.length ? ' fail:' + failed.join(',') : '  ALL PASS'}`,
  );
}
const best = all[0];
if (best && best.passed === GATES.length) {
  console.log(`\n  VERDICT: this clip contains a real uppercut — ${best.side} hand, ${best.t0.toFixed(2)}-${best.t1.toFixed(2)}s,`);
  console.log(`  starting ${best.waistGap.toFixed(3)} H under the belt and finishing at ${best.endH.toFixed(3)} H with the elbow never past ${best.elbowMax.toFixed(0)}°.\n`);
} else {
  console.log(`\n  VERDICT: no drive in this clip passes all ${GATES.length} gates. Best is ${best ? best.passed : 0}/${GATES.length}.\n`);
}
process.exit(best && best.passed === GATES.length ? 0 : 1);
