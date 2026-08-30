/**
 * Where can two clips be joined without a visible break?
 *
 * Every clip on this rig is a one-shot that ends a long way from where it began — `preset:dive`
 * finishes 1.47 figure-heights downrange, `preset:biped:run` 2.56 — so cutting between them at
 * arbitrary times means cross-fading between two unrelated poses. That is what a "break" is: the
 * blend has to travel a long way in joint space during the fade, and the figure visibly lurches.
 *
 * The fix is not a longer fade. A longer fade over a large pose gap is just a slower lurch. The fix
 * is to cut where the two clips already agree.
 *
 * So this samples both clips densely, compares every pose in A against every pose in B, and reports
 * the pair of times whose joint-space distance is smallest. Distance is the mean angle between
 * corresponding bone rotations, in degrees, which is the quantity a cross-fade actually has to
 * cover.
 *
 * Output: evidence/stitches.json.
 */
import * as THREE from 'three';
import { writeFileSync, mkdirSync } from 'node:fs';
import { buildRiggedModel } from '../../src/demos/monster-cute/meshCodec';
import { SURFACE_MODEL, SURFACE_STREAM } from '../../src/demos/monster-cute/surfaceData.high';
import { RIG } from '../../src/demos/monster-cute/rigData';

/** Samples per clip. 60 over a 2.75 s clip is a pose every ~46 ms, finer than a fade can resolve. */
const SAMPLES = 60;

const rigged = buildRiggedModel(SURFACE_MODEL, SURFACE_STREAM, RIG);
const { mixer, mesh, group, clips } = rigged;
const bones = mesh.skeleton.bones;

const restPose = RIG.bones.map((b) => ({
  position: new THREE.Vector3(...b.position),
  quaternion: new THREE.Quaternion(...b.quaternion),
  scale: new THREE.Vector3(...b.scale),
}));
function restoreBindPose(): void {
  bones.forEach((bone, i) => {
    bone.position.copy(restPose[i].position);
    bone.quaternion.copy(restPose[i].quaternion);
    bone.scale.copy(restPose[i].scale);
  });
  group.updateMatrixWorld(true);
}

interface Sampled {
  name: string;
  duration: number;
  times: number[];
  /** One quaternion per bone per sample. */
  poses: THREE.Quaternion[][];
  /** Hip world height per sample, for picking a water-entry moment. */
  hipY: number[];
  /** Planar hip travel from t=0, in figure heights. */
  travel: number[];
}

const H = SURFACE_MODEL.height;
const hip = bones.find((b) => b.name === 'Hip')!;

function sample(name: string): Sampled | null {
  const clip = clips.find((c) => c.name === name);
  if (!clip) return null;
  mixer.stopAllAction();
  restoreBindPose();
  const action = mixer.clipAction(clip);
  action.reset();
  action.play();
  action.paused = true;

  const times: number[] = [];
  const poses: THREE.Quaternion[][] = [];
  const hipY: number[] = [];
  const travel: number[] = [];
  const origin = new THREE.Vector3();

  for (let i = 0; i < SAMPLES; i += 1) {
    const t = (clip.duration * i) / (SAMPLES - 1);
    action.time = t;
    mixer.update(0);
    group.updateMatrixWorld(true);
    times.push(t);
    poses.push(bones.map((b) => b.quaternion.clone()));
    const world = hip.getWorldPosition(new THREE.Vector3());
    if (i === 0) origin.copy(world);
    hipY.push(world.y);
    travel.push(Math.hypot(world.x - origin.x, world.z - origin.z) / H);
  }
  return { name, duration: clip.duration, times, poses, hipY, travel };
}

/** Mean angle between corresponding bone rotations, in degrees. */
function poseDistance(a: THREE.Quaternion[], b: THREE.Quaternion[]): number {
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += a[i].angleTo(b[i]);
  return THREE.MathUtils.radToDeg(total / a.length);
}

interface Stitch {
  from: string;
  to: string;
  /** Time in `from` to leave at, and time in `to` to arrive at. */
  leaveAt: number;
  arriveAt: number;
  meanDegrees: number;
  /** The same measure at the naive join — end of A into the start of B — for comparison. */
  naiveDegrees: number;
}

function bestStitch(a: Sampled, b: Sampled, options: { leaveAfter?: number; leaveBefore?: number; arriveAfter?: number; arriveBefore?: number } = {}): Stitch {
  let best = { i: 0, j: 0, d: Infinity };
  for (let i = 0; i < SAMPLES; i += 1) {
    if (options.leaveAfter !== undefined && a.times[i] < options.leaveAfter) continue;
    if (options.leaveBefore !== undefined && a.times[i] > options.leaveBefore) continue;
    for (let j = 0; j < SAMPLES; j += 1) {
      if (options.arriveBefore !== undefined && b.times[j] > options.arriveBefore) continue;
      if (options.arriveAfter !== undefined && b.times[j] < options.arriveAfter) continue;
      const d = poseDistance(a.poses[i], b.poses[j]);
      if (d < best.d) best = { i, j, d };
    }
  }
  return {
    from: a.name,
    to: b.name,
    leaveAt: Number(a.times[best.i].toFixed(3)),
    arriveAt: Number(b.times[best.j].toFixed(3)),
    meanDegrees: Number(best.d.toFixed(2)),
    naiveDegrees: Number(poseDistance(a.poses[SAMPLES - 1], b.poses[0]).toFixed(2)),
  };
}

const RUN = 'preset:biped:run';
const JUMP = 'preset:jump';
const DIVE = 'preset:dive';

const run = sample(RUN)!;
const jump = sample(JUMP)!;
const dive = sample(DIVE)!;

// run -> jump: leave the run at any point, arrive early in the jump so the crouch and takeoff play.
const runToJump = bestStitch(run, jump, { arriveBefore: jump.duration * 0.45 });
// jump -> dive: leave the jump at or after its apex, so the character is already airborne.
const apex = jump.hipY.indexOf(Math.max(...jump.hipY));
// Arrive in the dive's own airborne phase, not near its end: constrained only by "after the jump's
// apex" the search picked 2.657 s, which is the dive's final standing pose and skips the entire
// descent the sequence exists to show.
const jumpToDive = bestStitch(jump, dive, { leaveAfter: jump.times[apex], arriveBefore: 1.45 });
/**
 * The swim loop.
 *
 * A self-stitch is degenerate unless the two times are forced apart — comparing a pose against
 * itself trivially scores zero, which is what the first run of this tool reported. So this searches
 * for the best pair inside a window with a minimum span between them, which is what a loop actually
 * needs: leave late, arrive earlier, and cover enough ground in between to be a stroke.
 */
function bestLoop(a: Sampled, windowStart: number, windowEnd: number, minSpan: number) {
  let best = { i: 0, j: 0, d: Infinity };
  for (let i = 0; i < SAMPLES; i += 1) {
    if (a.times[i] < windowStart || a.times[i] > windowEnd) continue;
    for (let j = 0; j < SAMPLES; j += 1) {
      if (a.times[j] < windowStart || a.times[j] > windowEnd) continue;
      if (a.times[i] - a.times[j] < minSpan) continue;
      const d = poseDistance(a.poses[i], a.poses[j]);
      if (d < best.d) best = { i, j, d };
    }
  }
  return {
    from: a.name, to: a.name,
    leaveAt: Number(a.times[best.i].toFixed(3)),
    arriveAt: Number(a.times[best.j].toFixed(3)),
    meanDegrees: Number(best.d.toFixed(2)),
    naiveDegrees: Number(poseDistance(a.poses[SAMPLES - 1], a.poses[0]).toFixed(2)),
    span: Number((a.times[best.i] - a.times[best.j]).toFixed(3)),
  };
}

// The submerged stretch, where a swim loop would live.
const diveLoop = bestLoop(dive, 1.6, dive.duration, 0.35);

/**
 * run -> dive, skipping the separate jump.
 *
 * `preset:dive` already contains its own crouch, leap, descent and entry, so routing the sequence
 * through `preset:jump` first only adds a seam and makes the character crouch twice. Arriving in
 * the dive's first 40% lands on its wind-up, which is the jump the sequence wants.
 */
const runToDive = bestStitch(run, dive, { arriveBefore: dive.duration * 0.4 });
/**
 * The exit the sequence actually uses.
 *
 * The unconstrained best join leaves the run at 0.285 s, which is outside the run's own loop window
 * — so a run phase that is cycling [0.438, 1.073] never reaches it. This one is constrained to
 * leave from inside that window, which is the only place the run phase can actually be when it is
 * time to go.
 */
const runLoopExit = bestStitch(run, dive, { leaveAfter: 0.438, leaveBefore: 1.073, arriveBefore: dive.duration * 0.4 });
/** And the run's own loop, so the run phase can repeat before the leap. */
const runLoop = bestLoop(run, 0, run.duration, run.duration * 0.4);

// Where does the dive stop descending? That is the frame the body meets the water.
let entry = 0;
for (let i = 1; i < SAMPLES; i += 1) {
  if (dive.hipY[i] < dive.hipY[entry]) entry = i;
}

const report = {
  measure: 'mean angle between corresponding bone rotations, degrees; lower is a smaller gap for the cross-fade to cover',
  samplesPerClip: SAMPLES,
  stitches: [runLoop, runToDive, runLoopExit, runToJump, jumpToDive, diveLoop],
  diveEntry: {
    time: Number(dive.times[entry].toFixed(3)),
    hipY: Number(dive.hipY[entry].toFixed(4)),
    travelAtEntry: Number(dive.travel[entry].toFixed(3)),
    note: 'lowest hip point of the dive; the moment the body meets the water',
  },
  diveProfile: {
    hipY: dive.hipY.map((v) => Number(v.toFixed(3))),
    times: dive.times.map((v) => Number(v.toFixed(3))),
  },
};

mkdirSync(new URL('../../src/demos/monster-cute/evidence/', import.meta.url), { recursive: true });
writeFileSync(new URL('../../src/demos/monster-cute/evidence/stitches.json', import.meta.url), JSON.stringify(report, null, 2));

console.log(`pose sampling: ${SAMPLES} per clip\n`);
for (const s of report.stitches) {
  const saved = (s.naiveDegrees - s.meanDegrees).toFixed(1);
  console.log(`${s.from}  ->  ${s.to}`);
  console.log(`   best join : leave ${s.leaveAt}s, arrive ${s.arriveAt}s   gap ${s.meanDegrees} deg`);
  console.log(`   naive join: end -> start                                gap ${s.naiveDegrees} deg   (${saved} deg worse)\n`);
}
console.log(`dive meets the water at ${report.diveEntry.time}s (hip low point, ${report.diveEntry.travelAtEntry}H downrange)`);

// Where does the hip cross a candidate water line on the way down?
for (const level of [0.30, 0.25, 0.22, 0.18]) {
  let crossed = -1;
  for (let i = 1; i < SAMPLES; i += 1) {
    if (dive.hipY[i - 1] > level && dive.hipY[i] <= level) { crossed = dive.times[i]; break; }
  }
  console.log(`  water at y=${level.toFixed(2)}: hip breaks the surface at ${crossed < 0 ? 'never' : crossed.toFixed(3) + 's'}`);
}
