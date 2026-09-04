#!/usr/bin/env node
/**
 * Answer one question about the raz rig: does any embedded clip contain a real UPPERCUT?
 *
 * `measure-raz-strikes.mjs` finds where blows LAND, and it is deliberately blind to the shape of the
 * path into them — a hook and an uppercut both finish at the head line, and to that script they are
 * the same event with different bone names. So the knockout was built on `box_03` because its left
 * hand ends highest, and that is not the same claim as "the hand travels upward".
 *
 * An uppercut is a DIRECTION, not a destination:
 *
 *   1. the fist rises through the contact — the travel vector's elevation above horizontal is what
 *      separates a punch thrown up from a punch thrown around;
 *   2. it finishes at chin height or above;
 *   3. it is still rising AT the apex, not rising early and then swinging across.
 *
 * So this reports, for every hand in every clip, the steepest sustained rise it makes: the elevation
 * angle of travel over a 0.12 s window, where that window ends, and how high the hand is when it
 * gets there. Distances are figure heights, using the same H as `strikeEvents.ts`.
 *
 *   node scripts/probe-raz-rising-hands.mjs
 *   node scripts/probe-raz-rising-hands.mjs --all   every candidate, not just the best per hand
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RIG_PATH = join(ROOT, 'src/demos/raz/rigData.ts');
const SAMPLES = 400;
/** Same H as `strikeEvents.ts`, so every number here is comparable to that table. */
const FIGURE_HEIGHT = 2.115;
/** The window the travel direction is read over. Matches the script's APPROACH_WINDOW. */
const WINDOW = 0.12;
const SHOW_ALL = process.argv.includes('--all');

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

const JOINTS = {
  handL: 'L_Hand', handR: 'R_Hand',
  forearmL: 'L_Forearm', forearmR: 'R_Forearm',
  upperarmL: 'L_Upperarm', upperarmR: 'R_Upperarm',
  head: 'Head', chest: 'Spine02', hip: 'Hip',
};

/**
 * The interior angle at the elbow, in degrees. 180 is a straight arm, 90 is a right angle.
 *
 * This is the test that separates an UPPERCUT from a fist raised overhead, and nothing measured
 * before it in this file can tell the two apart: both send the hand upward, both finish high, and
 * both show a steep elevation. Only the elbow says whether the arm is driving as a short lever off
 * the hip — bent, around 90 — or simply reaching, which is an arm extending and carries no body.
 */
function elbowAngle(frame, side) {
  const upper = frame[`upperarm${side}`];
  const fore = frame[`forearm${side}`];
  const hand = frame[`hand${side}`];
  const a = fore.clone().sub(upper);
  const b = hand.clone().sub(fore);
  if (a.lengthSq() < 1e-9 || b.lengthSq() < 1e-9) return NaN;
  const between = a.normalize().angleTo(b.normalize()) * 180 / Math.PI;
  return 180 - between;
}

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
  mixer.clipAction(clip).play();

  const dt = clip.duration / SAMPLES;
  const frames = [];
  const scratch = new THREE.Vector3();
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

/**
 * Every rise this hand makes, as an elevation angle over `WINDOW` seconds.
 *
 * Reported at the END of the window — the frame the hand has arrived at — because that is the frame
 * a contact would be scheduled on. `elevation` is measured from horizontal, so 90 is straight up and
 * 0 is a level swing; `climb` and `lateral` are the two components in figure heights, kept so a
 * steep-but-tiny twitch can be told from a real drive.
 */
function risesFor(frames, dt, key) {
  const span = Math.max(2, Math.round(WINDOW / dt));
  const side = key.endsWith('L') ? 'L' : 'R';
  const out = [];
  for (let i = span; i < frames.length; i += 1) {
    const from = frames[i - span][key];
    const to = frames[i][key];
    const climb = (to.y - from.y) / FIGURE_HEIGHT;
    const lateral = Math.hypot(to.x - from.x, to.z - from.z) / FIGURE_HEIGHT;
    if (climb <= 0) continue;
    const elevation = Math.atan2(climb, lateral) * 180 / Math.PI;
    const chest = frames[i].chest.y;
    const head = frames[i].head.y;
    out.push({
      t: frames[i].t,
      elevation,
      climb,
      lateral,
      /** Interior elbow angle. An uppercut holds this near 90; a reach opens it toward 180. */
      elbow: elbowAngle(frames[i], side),
      /** Vertical hip speed, H/s — the "đạp đất" drive arriving from the floor. */
      hipRise: (frames[i].hip.y - frames[i - span].hip.y) / FIGURE_HEIGHT / (span * dt),
      /** Hand height in figure heights, and where it sits against this figure's own landmarks. */
      height: to.y / FIGURE_HEIGHT,
      aboveChest: to.y >= chest,
      aboveHead: to.y >= head,
      /** Still rising at the end of the window? A hook rises early then goes across. */
      risingAtEnd: i + 1 < frames.length ? frames[i + 1][key].y > to.y : false,
    });
  }
  return out;
}

const rig = readRig();
const clips = buildClips(rig);

console.log(`\nrising-hand probe · ${clips.length} clips · window ${WINDOW}s · H = ${FIGURE_HEIGHT}\n`);
console.log('An UPPERCUT wants elevation high (travel is upward), height at or over the chest line,');
console.log('and rising still true at the apex. A HOOK shows a modest elevation and a large lateral.\n');

const table = [];
for (const clip of clips) {
  const { frames, dt } = sampleClip(rig, clip);
  for (const key of ['handL', 'handR']) {
    const rises = risesFor(frames, dt, key);
    if (!rises.length) continue;
    // Rank by how much of the travel is vertical, but require the drive to be worth seeing at all.
    const real = rises.filter((r) => r.climb >= 0.10);
    const pool = real.length ? real : rises;
    const best = pool.reduce((m, r) => (r.elevation > m.elevation ? r : m), pool[0]);
    table.push({ clip: clip.name, hand: key, ...best });
    if (SHOW_ALL) {
      for (const r of real.filter((r) => r.elevation >= 55)) {
        console.log(`    ${clip.name.padEnd(30)} ${key}  @ ${r.t.toFixed(3)}s  elev ${r.elevation.toFixed(0).padStart(2)}°  climb ${r.climb.toFixed(3)} H  lat ${r.lateral.toFixed(3)} H  height ${r.height.toFixed(3)} H`);
      }
    }
  }
}

table.sort((a, b) => b.elevation - a.elevation);
console.log('steepest sustained rise per hand, best first\n');
console.log('  clip                            hand   at        elev   climb    lateral  height   elbow  hipRise  >chest >head rising');
for (const r of table) {
  console.log(
    `  ${r.clip.padEnd(30)} ${r.hand.padEnd(6)} ${r.t.toFixed(3)}s  ${r.elevation.toFixed(0).padStart(3)}°  `
    + `${r.climb.toFixed(3)} H  ${r.lateral.toFixed(3)} H  ${r.height.toFixed(3)} H  `
    + `${r.elbow.toFixed(0).padStart(3)}°  ${r.hipRise.toFixed(2).padStart(5)}  `
    + `${String(r.aboveChest).padEnd(6)} ${String(r.aboveHead).padEnd(5)} ${r.risingAtEnd}`,
  );
}

/**
 * The full technique test, applied to every rising frame in every clip rather than to one per hand.
 *
 * A rise alone is not an uppercut. All four of these have to hold at once:
 *
 *   elevation >= 60   the fist is going UP, not around;
 *   elbow 60..120     the arm is a short bent lever, not a reach. This is the test that rules out a
 *                     fist raised overhead, which passes every other check here;
 *   climb >= 0.10 H   the drive is worth seeing;
 *   hipRise > 0       the hips are still going up as the hand does, which is the floor driving the
 *                     punch rather than the shoulder throwing it.
 */
console.log('\nfull technique gate — elevation >= 60, elbow 60-120, climb >= 0.10 H, hip still rising\n');
const strict = [];
for (const clip of clips) {
  const { frames, dt } = sampleClip(rig, clip);
  for (const key of ['handL', 'handR']) {
    for (const r of risesFor(frames, dt, key)) {
      if (r.elevation < 60 || r.climb < 0.10) continue;
      if (!(r.elbow >= 60 && r.elbow <= 120)) continue;
      if (!(r.hipRise > 0)) continue;
      strict.push({ clip: clip.name, hand: key, ...r });
    }
  }
}
if (!strict.length) {
  console.log('  NOTHING PASSES. No clip in this rig throws a bent-elbow rising punch off a driving hip.');
} else {
  strict.sort((a, b) => b.climb - a.climb);
  console.log('  clip                            hand   at        elev  elbow  climb    hipRise  height');
  for (const r of strict.slice(0, 24)) {
    console.log(
      `  ${r.clip.padEnd(30)} ${r.hand.padEnd(6)} ${r.t.toFixed(3)}s  ${r.elevation.toFixed(0).padStart(3)}°  `
      + `${r.elbow.toFixed(0).padStart(3)}°  ${r.climb.toFixed(3)} H  ${r.hipRise.toFixed(2).padStart(5)}    ${r.height.toFixed(3)} H`,
    );
  }
  console.log(`\n  ${strict.length} frames pass in total.`);
}

/** The two clips the knockout has been built on, side by side, at their measured contacts. */
console.log('\nthe knockout candidates at their own measured contact times\n');
const CONTACTS = [
  { clip: 'preset:biped:box_03', hand: 'handL', time: 0.665, note: 'current knockout — typed `hook` in the table' },
  { clip: 'preset:biped:box_01', hand: 'handL', time: 0.619, note: 'lead / dash punch — typed `straight`' },
  { clip: 'preset:biped:box_02', hand: 'handR', time: 2.252, note: 'the cross — hardest measured hand' },
];
for (const c of CONTACTS) {
  const clip = clips.find((x) => x.name === c.clip);
  if (!clip) continue;
  const { frames, dt } = sampleClip(rig, clip);
  const rises = risesFor(frames, dt, c.hand);
  const at = rises.reduce((m, r) => (Math.abs(r.t - c.time) < Math.abs(m.t - c.time) ? r : m), rises[0]);
  if (!at) { console.log(`  ${c.clip} ${c.hand} @ ${c.time}s — the hand is DESCENDING here, no rise to report`); continue; }
  console.log(
    `  ${c.clip.padEnd(30)} ${c.hand} @ ${c.time}s -> elev ${at.elevation.toFixed(0)}°  `
    + `climb ${at.climb.toFixed(3)} H  lateral ${at.lateral.toFixed(3)} H  height ${at.height.toFixed(3)} H`,
  );
  console.log(`      ${c.note}`);
}

/**
 * The chosen uppercut, in the exact terms `STRIKE_EVENTS` is written in.
 *
 * Printed as a row rather than described, so the table entry can be copied instead of retyped, and
 * so a rerun after any rig change shows immediately whether the row still matches the rig.
 */
/**
 * The drive to report in full. Overridable so a candidate can be examined without editing the file:
 *   node scripts/probe-raz-rising-hands.mjs --pick preset:biped:angry_03 handL 2.60 3.10
 */
const pickArg = process.argv.indexOf('--pick');
const PICK = pickArg > 0
  ? {
    clip: process.argv[pickArg + 1],
    hand: process.argv[pickArg + 2],
    from: Number(process.argv[pickArg + 3]),
    to: Number(process.argv[pickArg + 4]),
  }
  : { clip: 'preset:biped:angry_03', hand: 'handR', from: 1.45, to: 1.95 };
{
  const clip = clips.find((x) => x.name === PICK.clip);
  const { frames, dt } = sampleClip(rig, clip);
  const span = Math.max(2, Math.round(WINDOW / dt));
  const inRange = frames.filter((f) => f.t >= PICK.from && f.t <= PICK.to);
  // The top of the drive: the highest the fist gets inside the window. An uppercut lands where it
  // stops rising, which is not where it is fastest.
  const apex = inRange.reduce((m, f) => (f[PICK.hand].y > m[PICK.hand].y ? f : m), inRange[0]);
  const index = frames.indexOf(apex);
  const back = frames[Math.max(0, index - span)];
  const climb = (apex[PICK.hand].y - back[PICK.hand].y) / FIGURE_HEIGHT;
  const lateral = Math.hypot(apex[PICK.hand].x - back[PICK.hand].x, apex[PICK.hand].z - back[PICK.hand].z) / FIGURE_HEIGHT;
  const travelled = apex[PICK.hand].distanceTo(back[PICK.hand]) / FIGURE_HEIGHT;
  const speed = travelled / (span * dt);
  const reach = apex[PICK.hand].distanceTo(apex.hip) / FIGURE_HEIGHT;
  const height = apex[PICK.hand].y / FIGURE_HEIGHT;
  const elevation = Math.atan2(climb, lateral) * 180 / Math.PI;
  console.log(`\nthe uppercut, as a STRIKE_EVENTS row (clip duration ${clip.duration.toFixed(3)}s)\n`);
  console.log(`  { clip: '${PICK.clip}', block: '${PICK.hand}', time: ${apex.t.toFixed(3)}, speed: ${speed.toFixed(2)}, reach: ${reach.toFixed(3)}, height: ${height.toFixed(3)}, kind: 'uppercut' },`);
  console.log(`\n  elevation ${elevation.toFixed(0)}°  ·  climb ${climb.toFixed(3)} H  ·  lateral ${lateral.toFixed(3)} H`);
  console.log(`  head at apex ${(apex.head.y / FIGURE_HEIGHT).toFixed(3)} H  ·  chest ${(apex.chest.y / FIGURE_HEIGHT).toFixed(3)} H`);
  /**
   * Why the extension detector threw this away, stated in its own units.
   *
   * NOT on reach — 0.388 H clears its 0.30 H floor comfortably. It failed on SPEED, against a floor
   * of 1.9 H/s, and that is the technique rather than a flaw in either measurement: an uppercut is a
   * short punch whose power comes up through the legs and hips, so the hand itself never reaches the
   * speed of a lead thrown from the shoulder. A detector that gates on hand speed cannot see one.
   */
  console.log(`  reach ${reach.toFixed(3)} H clears the 0.30 H floor; speed ${speed.toFixed(2)} H/s FAILS the 1.9 H/s floor -> why the sweep rejected it`);

  /**
   * The three moments the action is actually built on.
   *
   *   load    the lowest the fist gets before the drive — the "drop the elbow and shoulder" phase,
   *           and the frame the windup should start gathering on;
   *   contact where the rising fist crosses this figure's own head line, which is where an
   *           opponent's chin would be. An uppercut lands on the way UP, not at the top;
   *   apex    the top of the follow-through.
   */
  const load = inRange.filter((f) => f.t < apex.t).reduce((m, f) => (f[PICK.hand].y < m[PICK.hand].y ? f : m), inRange[0]);
  let contact = null;
  for (const f of frames) {
    if (f.t <= load.t || f.t > apex.t) continue;
    if (f[PICK.hand].y >= f.head.y) { contact = f; break; }
  }
  const at = (f) => {
    const i = frames.indexOf(f);
    const b = frames[Math.max(0, i - span)];
    const c = (f[PICK.hand].y - b[PICK.hand].y) / FIGURE_HEIGHT;
    const l = Math.hypot(f[PICK.hand].x - b[PICK.hand].x, f[PICK.hand].z - b[PICK.hand].z) / FIGURE_HEIGHT;
    return {
      t: f.t,
      height: f[PICK.hand].y / FIGURE_HEIGHT,
      elevation: Math.atan2(c, l) * 180 / Math.PI,
      speed: f[PICK.hand].distanceTo(b[PICK.hand]) / FIGURE_HEIGHT / (span * dt),
      reach: f[PICK.hand].distanceTo(f.hip) / FIGURE_HEIGHT,
      hip: f.hip.y / FIGURE_HEIGHT,
      elbow: elbowAngle(f, PICK.hand.endsWith('L') ? 'L' : 'R'),
      hipRise: (f.hip.y - b.hip.y) / FIGURE_HEIGHT / (span * dt),
    };
  };
  console.log('\n  phase          at        height   elev   elbow  hipRise  speed      reach    hip height');
  for (const [label, frame] of [['load', load], ['contact', contact], ['apex', apex]]) {
    if (!frame) { console.log(`  ${label.padEnd(14)} — not found`); continue; }
    const m = at(frame);
    console.log(
      `  ${label.padEnd(14)} ${m.t.toFixed(3)}s  ${m.height.toFixed(3)} H  ${m.elevation.toFixed(0).padStart(3)}°  `
      + `${m.elbow.toFixed(0).padStart(3)}°  ${m.hipRise.toFixed(2).padStart(5)}    `
      + `${m.speed.toFixed(2)} H/s  ${m.reach.toFixed(3)} H  ${m.hip.toFixed(3)} H`,
    );
  }
  console.log('\n  the technique wants the elbow near 90° through the drive, and the hip still rising with it.');

  /**
   * Frame by frame through the drive, so the contact can be CHOSEN against the technique rather than
   * inferred from one summary row. An uppercut lands while the fist is still rising, with the elbow
   * still bent, at the height of a chin — and those three peak at different moments, so the frame
   * has to be picked by looking at all of them together.
   */
  /**
   * The contact frame, chosen by a stated rule rather than by taste.
   *
   * Among the frames that are actually throwing a punch — rising at 60 degrees or steeper, with the
   * fist within 0.08 H of the chin — take the one whose ELBOW is closest to 90. The elbow decides
   * because it is the test the technique is most specific about and the one the previous two attempts
   * failed: a frame can rise steeply at chin height with a straight arm, and that is a reach.
   *
   * Ties never arise in practice, and if they did the earlier frame wins: a blow lands on the way up.
   */
  {
    /**
     * The target height is a STANDING OPPONENT'S CHIN, in absolute figure heights, and not the
     * puncher's own head.
     *
     * Those are the same thing only while both fighters have their feet on the floor. The moment the
     * puncher leaves the ground his own head goes up with the fist, so measuring the gap between them
     * says a jumping uppercut never reaches a chin — which is backwards: leaving the floor is how the
     * fist gets to a chin. 0.71 H is the head line this table already uses for a standing figure.
     */
    const STANDING_CHIN = 0.71;
    const candidates = inRange
      .map((f) => ({ f, m: at(f), chinGap: (f.head.y - f[PICK.hand].y) / FIGURE_HEIGHT }))
      .filter((c) => c.m.elevation >= 60 && c.m.height >= STANDING_CHIN);
    if (candidates.length) {
      const best = candidates.reduce((m, c) => (Math.abs(c.m.elbow - 90) < Math.abs(m.m.elbow - 90) ? c : m), candidates[0]);
      console.log('\n  the contact this rule picks, as a STRIKE_EVENTS row\n');
      console.log(`  { clip: '${PICK.clip}', block: '${PICK.hand}', time: ${best.m.t.toFixed(3)}, speed: ${best.m.speed.toFixed(2)}, reach: ${best.m.reach.toFixed(3)}, height: ${best.m.height.toFixed(3)}, kind: 'knockout' },`);
      console.log(`\n  elbow ${best.m.elbow.toFixed(0)}°  ·  elevation ${best.m.elevation.toFixed(0)}°  ·  hip rising ${best.m.hipRise.toFixed(2)} H/s  ·  ${best.chinGap.toFixed(3)} H under the chin`);
      console.log(`  ${candidates.length} frames met the gate; this is the one nearest a right angle at the elbow.`);
    } else {
      console.log('\n  NO frame in this window rises at 60°+ with the fist at chin height.');
    }
  }

  if (process.argv.includes('--trace')) {
    // `--hip` keeps the descending frames too, which is how the settle after a drive is found.
    const keepAll = process.argv.includes('--hip');
    console.log('\n  at        height   elev   elbow  hipRise  reach   chin gap  hip height');
    for (const f of inRange) {
      const m = at(f);
      if (!keepAll && m.elevation <= 0) continue;
      const chinGap = (f.head.y - f[PICK.hand].y) / FIGURE_HEIGHT;
      console.log(
        `  ${m.t.toFixed(3)}s  ${m.height.toFixed(3)} H  ${m.elevation.toFixed(0).padStart(3)}°  `
        + `${m.elbow.toFixed(0).padStart(3)}°  ${m.hipRise.toFixed(2).padStart(5)}    ${m.reach.toFixed(3)} H  ${chinGap.toFixed(3)} H  ${m.hip.toFixed(3)} H`,
      );
    }
  }
  console.log(`\n  the fist travels ${((apex[PICK.hand].y - load[PICK.hand].y) / FIGURE_HEIGHT).toFixed(3)} H upward from load to apex`);
}
console.log('');
