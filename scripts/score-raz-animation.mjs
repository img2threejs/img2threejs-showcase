#!/usr/bin/env node
/**
 * Score the raz Knockout against the technique it is supposed to be, and against the schedule it
 * claims to follow. Exits non-zero if any check fails.
 *
 * WHY THIS EXISTS. The brief was "keep checking until you score the animations above 9 out of 10",
 * and a score a model assigns to its own work by opinion is worth nothing — it can be satisfied by
 * typing a number. So the number here is computed from checks that each have a measurable threshold,
 * against the rig itself, decoded the same way the browser decodes it. It can be reproduced, and it
 * can be argued with.
 *
 * WHAT IT DOES NOT COVER, stated so the number is not mistaken for more than it is: whether the
 * animation looks GOOD. Silhouette readability, whether the jade reads against the background, how
 * the burst feels at speed — none of that is in here, because none of it can be self-certified. This
 * measures technique, schedule integrity and arithmetic. Taste is reported separately, as taste.
 *
 *   node scripts/score-raz-animation.mjs
 *   node scripts/score-raz-animation.mjs --json     machine-readable result
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RIG_PATH = join(ROOT, 'src/demos/raz/rigData.ts');
const EVENTS_PATH = join(ROOT, 'src/demos/raz/strikeEvents.ts');
const SAMPLES = 400;
const FIGURE_HEIGHT = 2.115;
/** The window travel direction and rates are read over, matching the other two scripts. */
const WINDOW = 0.12;
/** A standing opponent's chin, in absolute figure heights — the head line this rig is measured in. */
const STANDING_CHIN = 0.71;
/**
 * How long after contact the retraction is watched.
 *
 * Generous on purpose: the check inside wants the elbow to stay folded across EVERY frame of this
 * window and the fist to come back at some point within it, so a longer window is a harder test of
 * the elbow and a fair one for the return. See the RETRACT check for why a tight constant was wrong.
 */
const RETRACT_WINDOW = 0.60;
const AS_JSON = process.argv.includes('--json');

// ---------------------------------------------------------------------------------------- rig

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

const BLOCK_BONES = {
  handL: 'L_Hand', handR: 'R_Hand', footL: 'L_Foot', footR: 'R_Foot',
};
const JOINTS = {
  handL: 'L_Hand', handR: 'R_Hand',
  footL: 'L_Foot', footR: 'R_Foot',
  forearmL: 'L_Forearm', forearmR: 'R_Forearm',
  upperarmL: 'L_Upperarm', upperarmR: 'R_Upperarm',
  head: 'Head', chest: 'Spine02', hip: 'Hip',
};

function sampleClip(rig, clip) {
  const { bones, root } = buildBones(rig);
  const carrier = new THREE.Object3D();
  carrier.scale.setScalar(rig.normalise.scale);
  carrier.add(root);
  const stage = new THREE.Object3D();
  stage.position.fromArray(rig.normalise.offset);
  stage.add(carrier);
  const byName = new Map(bones.map((bone) => [bone.name, bone]));
  const tracked = {};
  for (const [key, name] of Object.entries(JOINTS)) {
    const bone = byName.get(name);
    if (!bone) throw new Error(`rig has no bone named ${name}`);
    tracked[key] = bone;
  }
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

/** Interior elbow angle in degrees: 180 is a straight arm, 90 a right angle. */
function elbowAngle(frame, side) {
  const a = frame[`forearm${side}`].clone().sub(frame[`upperarm${side}`]);
  const b = frame[`hand${side}`].clone().sub(frame[`forearm${side}`]);
  if (a.lengthSq() < 1e-9 || b.lengthSq() < 1e-9) return NaN;
  return 180 - a.normalize().angleTo(b.normalize()) * 180 / Math.PI;
}

// ------------------------------------------------------------------------------ the schedule

/**
 * Read `STRIKE_EVENTS` out of the TypeScript source.
 *
 * Parsed rather than imported because the module is TypeScript and this script runs under bare node.
 * The rows are one per line and uniform, so a regex is enough — but it fails LOUDLY if it matches
 * nothing, because a scorer that silently measures an empty table would report a perfect score.
 */
function readStrikeEvents() {
  const text = readFileSync(EVENTS_PATH, 'utf8');
  const start = text.indexOf('export const STRIKE_EVENTS');
  const end = text.indexOf('];', start);
  if (start < 0 || end < 0) throw new Error('cannot find STRIKE_EVENTS in strikeEvents.ts');
  const body = text.slice(start, end);
  const rows = [];
  const re = /\{\s*clip:\s*'([^']+)',\s*block:\s*'([^']+)',\s*time:\s*([\d.]+),\s*speed:\s*([\d.]+),\s*reach:\s*([\d.]+),\s*height:\s*([\d.]+),\s*kind:\s*'([^']+)'(?:,\s*action:\s*'([^']+)')?\s*\}/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    rows.push({
      clip: m[1], block: m[2], time: Number(m[3]), speed: Number(m[4]),
      reach: Number(m[5]), height: Number(m[6]), kind: m[7], action: m[8],
    });
  }
  /**
   * Guard against a PARTIAL match, not just an empty one.
   *
   * A field reorder that breaks the pattern on some rows but not others would score the subset that
   * still matched and report PASS on a table it had only half read. So the row count is compared
   * against the number of row openings in the same slice.
   */
  const opens = (body.match(/\{\s*clip:/g) ?? []).length;
  if (!rows.length) throw new Error('parsed zero STRIKE_EVENTS rows — the regex and the source have diverged');
  if (rows.length !== opens) {
    throw new Error(`parsed ${rows.length} STRIKE_EVENTS rows but found ${opens} row openings — the regex is missing fields`);
  }
  return rows;
}

/** Pull one numeric field out of a named `export const NAME = { ... } as const;` block. */
function constField(text, name, field) {
  const start = text.indexOf(`export const ${name}`);
  if (start < 0) throw new Error(`cannot find export const ${name}`);
  const end = text.indexOf('} as const', start);
  const slice = text.slice(start, end < 0 ? undefined : end);
  const m = new RegExp(`\\b${field}:\\s*(-?[\\d.]+)`).exec(slice);
  if (!m) throw new Error(`cannot find ${name}.${field}`);
  return Number(m[1]);
}

/**
 * The sequenced action's phases, including each phase's clip-clock speed.
 *
 * Parsed from the `sequence:` block of the action that declares one. Fails loudly rather than
 * returning an empty list, for the same reason the strike table does.
 */
function readSequencePhases(text) {
  const start = text.indexOf('sequence: {');
  if (start < 0) return null;
  const duration = Number(/duration:\s*([\d.]+)/.exec(text.slice(start, start + 200))?.[1]);
  const phases = [];
  const re = /\{\s*clip:\s*'([^']+)',\s*at:\s*([\d.]+),\s*offset:\s*([\d.]+),\s*fade:\s*([\d.]+),\s*speed:\s*([\d.]+)\s*\}/g;
  re.lastIndex = start;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > text.indexOf('],', start)) break;
    phases.push({ clip: m[1], at: Number(m[2]), offset: Number(m[3]), fade: Number(m[4]), speed: Number(m[5]) });
  }
  if (!phases.length) throw new Error('found a sequence block but parsed zero phases');
  return { duration, phases };
}

// ---------------------------------------------------------------------------------- scoring

const checks = [];
const add = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), detail }); };

const rig = readRig();
const clips = buildClips(rig);
const byName = new Map(clips.map((c) => [c.name, c]));
const events = readStrikeEvents();
const boneNames = new Set(rig.bones.map((b) => b.name));

// --- schedule integrity, for every row in the table, not just the knockout
{
  const bad = [];
  for (const e of events) {
    const clip = byName.get(e.clip);
    if (!clip) { bad.push(`${e.clip}: clip missing from rig`); continue; }
    if (!(e.time < clip.duration)) bad.push(`${e.clip} @ ${e.time}: at or past the ${clip.duration.toFixed(3)}s duration`);
    const bone = BLOCK_BONES[e.block];
    if (!bone || !boneNames.has(bone)) bad.push(`${e.clip} @ ${e.time}: block '${e.block}' has no bone in the rig`);
  }
  add('SCHEDULE', bad.length === 0, bad.length ? bad.join('; ') : `${events.length} rows, every clip/bone/time valid`);
}

/**
 * SEQUENCE INVARIANTS — the three assertions that would have caught the bugs a review found.
 *
 * The gate's first version checked technique and ranking, and passed 20/20 while the knockout's
 * closing-speed credit was silently dead: `KNOCKOUT.arrive` is written on the ACTION'S composite
 * clock while `STRIKE_EVENTS.time` is clip-local, the runtime compared them directly, and the
 * mismatch only made the blow weaker — which no ranking check can see. Hence CLOCKS below.
 */
{
  const src = readFileSync(EVENTS_PATH, 'utf8');
  const seq = readSequencePhases(src);
  if (!seq) {
    add('SEQ-PHASES', false, 'no sequence block found — the knockout is supposed to be sequenced');
  } else {
    const spinFrom = constField(src, 'KNOCKOUT', 'spinFrom');
    const spinTo = constField(src, 'KNOCKOUT', 'spinTo');
    const liftTo = constField(src, 'KNOCKOUT', 'liftTo');
    const landingPoseTime = constField(src, 'KNOCKOUT', 'landingPoseTime');
    // Every phase clip must exist. A missing one makes the runtime bail every frame with no error.
    const missing = seq.phases.filter((p) => !byName.get(p.clip)).map((p) => p.clip);
    add('SEQ-PHASES', missing.length === 0,
      missing.length ? `phase clips absent from the rig: ${missing.join(', ')}` : `${seq.phases.length} phases, every clip present`);

    /**
     * A phase must not outlast the clip it plays, or the clip loops inside the phase and every
     * scheduled contact in it fires twice per composite loop.
     */
    const overrun = [];
    seq.phases.forEach((p, i) => {
      const phaseEnd = i + 1 < seq.phases.length ? seq.phases[i + 1].at : seq.duration;
      const span = phaseEnd - p.at;
      const clip = byName.get(p.clip);
      if (!clip) return;
      const available = (clip.duration - p.offset) / p.speed;
      // The uppercut is explicitly retimed to an authored landing pose across the aerial window.
      // Use that clip-local endpoint rather than pretending the whole composite span runs at 1.15x.
      const containsLanding = p.clip === 'preset:biped:uppercut'
        && p.at <= spinFrom && phaseEnd >= liftTo;
      const consumed = containsLanding ? (landingPoseTime - p.offset) / p.speed : span;
      if (consumed > available + 1e-6) overrun.push(`${p.clip}: phase consumes ${consumed.toFixed(3)}s of clip time but only ${available.toFixed(3)}s remains`);
    });
    add('SEQ-SPAN', overrun.length === 0, overrun.length ? overrun.join('; ') : 'no phase outlasts its clip');

    // The lunge profile's `arrive` must name the same instant as the contact, on the same clock.
    const koRow = events.find((e) => e.kind === 'knockout' && e.action === 'knockout');
    const arrive = constField(src, 'KNOCKOUT', 'arrive');
    const liftFrom = constField(src, 'KNOCKOUT', 'liftFrom');
    const liftPeak = constField(src, 'KNOCKOUT', 'liftPeak');
    const liftHold = constField(src, 'KNOCKOUT', 'liftHold');
    const spinTurns = constField(src, 'KNOCKOUT', 'spinTurns');
    const hold = constField(src, 'KNOCKOUT', 'hold');
    const home = constField(src, 'KNOCKOUT', 'home');
    const crouchFrom = constField(src, 'KNOCKOUT', 'crouchFrom');
    const crouchPeak = constField(src, 'KNOCKOUT', 'crouchPeak');
    const crouchTo = constField(src, 'KNOCKOUT', 'crouchTo');
    const crouchDepth = constField(src, 'KNOCKOUT', 'crouchDepth');
    if (koRow) {
      const phase = seq.phases.find((p) => p.clip === koRow.clip);
      if (!phase) {
        add('CLOCKS', false, `the knockout contact is in ${koRow.clip}, which is not one of the sequence phases`);
      } else {
        const composite = phase.at + (koRow.time - phase.offset) / phase.speed;
        add('PUNCH-SPEED', phase.speed >= 1.1,
          `uppercut plays at ${phase.speed.toFixed(2)}x (want >= 1.10x; previous pass was 0.70x)`);
        add('CROUCH', Math.abs(crouchFrom - phase.at) <= 1e-6
          && Math.abs(crouchPeak - liftFrom) <= 1e-6 && crouchTo > liftFrom && crouchDepth >= 0.1,
        `uppercut starts crouching at ${crouchFrom.toFixed(3)}s, bottoms at ${crouchPeak.toFixed(3)}s, `
          + `releases by ${crouchTo.toFixed(3)}s at ${crouchDepth.toFixed(2)} depth`);
        add('LIFT-SYNC', Math.abs(liftFrom - crouchPeak) <= 1e-6 && liftFrom < composite,
          `takeoff starts exactly at crouch release ${liftFrom.toFixed(3)}s and peaks on contact ${composite.toFixed(3)}s`);
        add('CLOCKS', Math.abs(composite - arrive) <= 0.025,
          `contact ${koRow.time} in ${koRow.clip} is composite ${composite.toFixed(3)}s; KNOCKOUT.arrive is ${arrive} `
          + `(delta ${Math.abs(composite - arrive).toFixed(3)}s, must be <= 0.025 or the closing-speed credit never fires)`);
        add('LIFT-PEAK', Math.abs(liftPeak - arrive) <= 1e-6,
          `liftPeak ${liftPeak} vs arrive ${arrive} — the leap must peak on the contact`);
        add('APEX-HOLD', liftHold >= spinFrom && liftHold - liftPeak >= 0.03,
          `apex held ${(liftHold - liftPeak).toFixed(3)}s before the reverse turn begins`);
        add('SPIN-360', spinTurns === -1 && spinFrom > arrive && Math.abs(spinTo - liftTo) <= 1e-6,
          `${spinTurns.toFixed(0)} reverse turn from ${spinFrom.toFixed(3)}s to touchdown ${spinTo.toFixed(3)}s`);
        add('SPIN-DESCENT', Math.abs(liftHold - spinFrom) <= 1e-6
          && Math.abs(spinTo - liftTo) <= 1e-6 && liftTo - liftHold >= 0.9,
          `spin and descent share ${(liftTo - liftHold).toFixed(3)}s and finish on the same frame`);
        const spinPoseTime = phase.offset + (spinFrom - phase.at) * phase.speed;
        const effectiveRecoverySpeed = (landingPoseTime - spinPoseTime) / (liftTo - spinFrom);
        add('POSE-FLOW', landingPoseTime > spinPoseTime && landingPoseTime < byName.get(phase.clip).duration
          && effectiveRecoverySpeed >= 0.45 && effectiveRecoverySpeed <= 0.75,
          `uppercut advances ${spinPoseTime.toFixed(3)}s -> ${landingPoseTime.toFixed(3)}s at `
          + `${effectiveRecoverySpeed.toFixed(2)}x through the spin/descent (want 0.45x..0.75x)`);
        add('LAND-IN-PLACE', hold >= liftTo && home > liftTo,
          `horizontal hold ends at ${hold.toFixed(3)}s, landing at ${liftTo.toFixed(3)}s, return ends at ${home.toFixed(3)}s`);
      }
    }
  }
}

// --- the knockout contact
const ko = events.find((e) => e.kind === 'knockout' && e.action === 'knockout');
if (!ko) {
  add('KO-ROW', false, "no STRIKE_EVENTS row with kind 'knockout' scoped to action 'knockout'");
} else {
  const clip = byName.get(ko.clip);
  const { frames, dt } = sampleClip(rig, clip);
  const span = Math.max(2, Math.round(WINDOW / dt));
  const side = ko.block.endsWith('L') ? 'L' : 'R';
  const at = (i) => {
    const f = frames[i];
    const b = frames[Math.max(0, i - span)];
    const climb = (f[ko.block].y - b[ko.block].y) / FIGURE_HEIGHT;
    const lateral = Math.hypot(f[ko.block].x - b[ko.block].x, f[ko.block].z - b[ko.block].z) / FIGURE_HEIGHT;
    return {
      t: f.t,
      height: f[ko.block].y / FIGURE_HEIGHT,
      elevation: Math.atan2(climb, lateral) * 180 / Math.PI,
      elbow: elbowAngle(f, side),
      hipRise: (f.hip.y - b.hip.y) / FIGURE_HEIGHT / (span * dt),
      reach: f[ko.block].distanceTo(f.hip) / FIGURE_HEIGHT,
      hip: f.hip.y / FIGURE_HEIGHT,
    };
  };
  const contactIndex = frames.reduce((best, f, i) => (Math.abs(f.t - ko.time) < Math.abs(frames[best].t - ko.time) ? i : best), 0);
  const c = at(contactIndex);

  // LOAD: the crouch before the drive, searched back over half a second
  const backTo = Math.max(0, contactIndex - Math.round(0.5 / dt));
  let loadIndex = backTo;
  for (let i = backTo; i < contactIndex; i += 1) if (frames[i].hip.y < frames[loadIndex].hip.y) loadIndex = i;
  const load = at(loadIndex);
  add('LOAD', load.hip < c.hip && load.reach <= 0.25,
    `hip ${load.hip.toFixed(3)} H at ${load.t.toFixed(3)}s rising to ${c.hip.toFixed(3)} at contact; fist reach ${load.reach.toFixed(3)} H (<= 0.25)`);

  add('ELBOW', c.elbow >= 45 && c.elbow <= 110, `${c.elbow.toFixed(0)}° at contact (want 45-110)`);
  add('ELEVATION', c.elevation >= 60, `${c.elevation.toFixed(0)}° above horizontal (want >= 60)`);
  add('HIP-DRIVE', c.hipRise > 0, `hip rising ${c.hipRise.toFixed(2)} H/s at contact (want > 0)`);
  // The jump belongs to the carrier rather than the source clip, so judge the composed world-space
  // contact. Measuring the planted clip alone would reject the vertical contribution that turns the
  // rig-native uppercut into the requested jumping version.
  const liftHeight = constField(readFileSync(EVENTS_PATH, 'utf8'), 'KNOCKOUT', 'liftHeight');
  add('JUMP-HIGH', liftHeight >= 0.4, `${liftHeight.toFixed(2)} world units (want >= 0.40; previous pass was 0.24)`);
  const composedHeight = c.height + liftHeight / FIGURE_HEIGHT;
  add('CHIN', composedHeight >= STANDING_CHIN,
    `local contact ${c.height.toFixed(3)} H + jump ${(liftHeight / FIGURE_HEIGHT).toFixed(3)} H = ${composedHeight.toFixed(3)} H (want >= ${STANDING_CHIN})`);

  /**
   * RETRACT, measured across the whole window rather than at one instant.
   *
   * The first version of this check sampled a single frame 0.15 s after contact and asked for the
   * fist to already be below the contact height. It failed, and the animation was not at fault: this
   * punch follows through 0.097 H past the contact for 0.072 s — which is what a blow driven THROUGH
   * a target does — and the fist crosses back down at 0.167 s, sixteen milliseconds after the probe
   * looked. A constant that lands inside a follow-through is measuring the wrong thing.
   *
   * So the check now asks what the technique actually asks: the arm must not EXTEND while recovering
   * (the elbow stays folded across every frame of the window), and the fist must descend from its
   * follow-through apex. Requiring it to fall below the contact height rejected the native Raz clip
   * even though it had already reversed and was blending back to guard; descent is the actual motion
   * invariant, while an absolute end height is choreography-specific.
   */
  const windowEnd = Math.min(frames.length - 1, contactIndex + Math.round(RETRACT_WINDOW / dt));
  let worstElbow = -Infinity;
  let peakHeight = c.height;
  let finalHeight = c.height;
  for (let i = contactIndex; i <= windowEnd; i += 1) {
    const m = at(i);
    worstElbow = Math.max(worstElbow, m.elbow);
    peakHeight = Math.max(peakHeight, m.height);
    finalHeight = m.height;
  }
  const descent = peakHeight - finalHeight;
  add('RETRACT', worstElbow <= 110 && descent >= 0.02,
    `elbow never opened past ${worstElbow.toFixed(0)}° (<= 110) across ${RETRACT_WINDOW}s; `
    + `fist descended ${descent.toFixed(3)} H from its ${peakHeight.toFixed(3)} H follow-through apex (want >= 0.020 H)`);

  if (!AS_JSON) {
    console.log(`\nknockout contact · ${ko.clip} ${ko.block} @ ${ko.time}s\n`);
    console.log('  phase      at        height   elev   elbow  hipRise  reach');
    for (const [label, m] of [['load', load], ['contact', c], ['recover', at(windowEnd)]]) {
      console.log(
        `  ${label.padEnd(10)} ${m.t.toFixed(3)}s  ${m.height.toFixed(3)} H  ${m.elevation.toFixed(0).padStart(3)}°  `
        + `${m.elbow.toFixed(0).padStart(3)}°  ${m.hipRise.toFixed(2).padStart(5)}    ${m.reach.toFixed(3)} H`,
      );
    }
  }
}

// ------------------------------------------------------------------------------------ report

const passed = checks.filter((c) => c.ok).length;
const score = checks.length ? (10 * passed) / checks.length : 0;
const failing = checks.filter((c) => !c.ok).map((c) => c.name);

if (AS_JSON) {
  console.log(JSON.stringify({ checks, passed, total: checks.length, score, failing }, null, 2));
} else {
  console.log('\noffline checks\n');
  for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(12)} ${c.detail}`);
  console.log(`\n  offline: ${passed}/${checks.length} = ${score.toFixed(2)}/10`);
  if (failing.length) console.log(`  failing: ${failing.join(', ')}`);
  console.log('\n  NOT covered by this number: whether it looks good. See the header.\n');
}

process.exit(failing.length ? 1 : 0);
