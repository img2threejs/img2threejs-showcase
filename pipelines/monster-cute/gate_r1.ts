/**
 * Gate R1 — prove the binding path reaches the node, and measure what each clip actually does.
 *
 * A clip that exists is not a clip that plays. A clip can load, hold an action and report a
 * duration while driving nothing at all, and no amount of reading the code shows it. The only
 * thing that distinguishes the two is seeking the clip and comparing the node's real transform
 * against the value its own track says it should have at that time.
 *
 *   Gate R1:  maxSampledBindingDelta <= 2^-23   (float32 epsilon), over >= 5 times x every clip
 *
 * The same pass also samples the Stage R3 feature vector, which is what the VFX director binds
 * against: an effect is attached to a clip because the clip measured as a jump, not because its
 * name contains "jump".
 *
 * Output: evidence/gate-r1.json.
 */
import * as THREE from 'three';
import { writeFileSync, mkdirSync } from 'node:fs';
import { buildRiggedModel } from '../../src/demos/monster-cute/meshCodec';
import { SURFACE_MODEL, SURFACE_STREAM } from '../../src/demos/monster-cute/surfaceData.high';
import { RIG } from '../../src/demos/monster-cute/rigData';

const EPSILON = 2 ** -23;
const SAMPLES_PER_CLIP = 9;   // the gate demands >= 5; 9 costs nothing and covers the ends
const FEATURE_SAMPLES = 25;   // fixed by the Stage R3 feature vector

const rigged = buildRiggedModel(SURFACE_MODEL, SURFACE_STREAM, RIG);
const { mixer, clips, group, mesh } = rigged;

/** Figure height, the unit every threshold below is expressed in. */
const H = SURFACE_MODEL.height;

const boneByName = new Map<string, THREE.Bone>();
mesh.skeleton.bones.forEach((b) => boneByName.set(b.name, b));

const restPose = RIG.bones.map((b) => ({
  position: new THREE.Vector3(...b.position),
  quaternion: new THREE.Quaternion(...b.quaternion),
  scale: new THREE.Vector3(...b.scale),
}));

/** The R5 contract's "restore the bind pose before each play" — without it clips bleed into one another. */
function restoreBindPose(): void {
  mesh.skeleton.bones.forEach((bone, i) => {
    bone.position.copy(restPose[i].position);
    bone.quaternion.copy(restPose[i].quaternion);
    bone.scale.copy(restPose[i].scale);
  });
  group.updateMatrixWorld(true);
}

function seek(action: THREE.AnimationAction, t: number): void {
  action.time = t;
  mixer.update(0);
  group.updateMatrixWorld(true);
}

const LANDMARKS = {
  hip: 'Hip',
  head: 'Head',
  'hand.l': 'L_Hand',
  'hand.r': 'R_Hand',
  'foot.l': 'L_Foot',
  'foot.r': 'R_Foot',
} as const;

const missingLandmarks = Object.entries(LANDMARKS).filter(([, bone]) => !boneByName.has(bone)).map(([k, b]) => `${k} -> ${b}`);

interface ClipReport {
  name: string;
  duration: number;
  tracks: number;
  status: 'measured' | 'unevaluated';
  missingInputs?: string[];
  sampledTimes?: number[];
  maxSampledBindingDelta?: number;
  bindingComparisons?: number;
  gateR1?: 'pass' | 'fail';
  features?: Record<string, number>;
  classes?: string[];
  loop?: boolean;
  loopReason?: string;
}

const reports: ClipReport[] = [];

for (const clip of clips) {
  const report: ClipReport = { name: clip.name, duration: clip.duration, tracks: clip.tracks.length, status: 'measured' };

  if (clip.tracks.length === 0) {
    report.status = 'unevaluated';
    report.missingInputs = ['the clip carries no tracks, so there is no value to compare a node against'];
    reports.push(report);
    continue;
  }

  try {
    mixer.stopAllAction();
    restoreBindPose();
    const action = mixer.clipAction(clip);
    action.reset();
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.play();
    action.paused = true;

    // ---- Gate R1: does the binding path reach the node? ----
    const times = Array.from({ length: SAMPLES_PER_CLIP }, (_, i) => (clip.duration * i) / (SAMPLES_PER_CLIP - 1));
    let maxDelta = 0;
    let comparisons = 0;
    const interpolants = clip.tracks.map((track) => ({ track, interpolant: track.createInterpolant() }));

    for (const t of times) {
      seek(action, t);
      for (const { track, interpolant } of interpolants) {
        const dot = track.name.lastIndexOf('.');
        const nodeName = track.name.slice(0, dot);
        const property = track.name.slice(dot + 1) as 'position' | 'quaternion' | 'scale';
        const node = boneByName.get(nodeName);
        if (!node) continue;
        const expected = interpolant.evaluate(t) as ArrayLike<number>;
        const actual = node[property];
        const got = property === 'quaternion'
          ? [actual.x, actual.y, actual.z, (actual as THREE.Quaternion).w]
          : [actual.x, actual.y, (actual as THREE.Vector3).z];
        for (let i = 0; i < got.length; i += 1) {
          maxDelta = Math.max(maxDelta, Math.abs(got[i] - expected[i]));
          comparisons += 1;
        }
      }
    }
    report.sampledTimes = times.map((t) => Number(t.toFixed(4)));
    report.maxSampledBindingDelta = maxDelta;
    report.bindingComparisons = comparisons;
    report.gateR1 = maxDelta <= EPSILON ? 'pass' : 'fail';

    // ---- Stage R3 feature vector ----
    if (missingLandmarks.length) {
      report.status = 'unevaluated';
      report.missingInputs = [`landmark joints absent from this rig: ${missingLandmarks.join(', ')}`];
      reports.push(report);
      continue;
    }

    const featureTimes = Array.from({ length: FEATURE_SAMPLES }, (_, i) => (clip.duration * i) / (FEATURE_SAMPLES - 1));
    const world: Record<string, THREE.Vector3[]> = {};
    for (const key of Object.keys(LANDMARKS)) world[key] = [];
    let scaleDelta = 0;
    let scaleDeltaFromRest = 0;
    const poseAt: { q: THREE.Quaternion[]; p: THREE.Vector3[] }[] = [];

    for (const t of featureTimes) {
      seek(action, t);
      for (const [key, boneName] of Object.entries(LANDMARKS)) {
        world[key].push(boneByName.get(boneName)!.getWorldPosition(new THREE.Vector3()));
      }
      mesh.skeleton.bones.forEach((bone, i) => {
        scaleDelta = Math.max(scaleDelta, Math.abs(bone.scale.x - 1), Math.abs(bone.scale.y - 1), Math.abs(bone.scale.z - 1));
        // The real question is not "is the scale 1" but "does the clip MOVE the scale". This rig
        // writes a scale channel on all 1,353 tracks, but every one of them holds the rest value,
        // and the rest value is itself 1 +/- 1e-5 of exporter noise. Measured against 1 the
        // tripwire fires on all 33 clips and means nothing; measured against the rest pose it
        // answers the question the gate is actually asking.
        const rest = restPose[i].scale;
        scaleDeltaFromRest = Math.max(scaleDeltaFromRest,
          Math.abs(bone.scale.x - rest.x), Math.abs(bone.scale.y - rest.y), Math.abs(bone.scale.z - rest.z));
      });
      if (t === featureTimes[0] || t === featureTimes[featureTimes.length - 1]) {
        poseAt.push({
          q: mesh.skeleton.bones.map((b) => b.quaternion.clone()),
          p: mesh.skeleton.bones.map((b) => b.position.clone()),
        });
      }
    }

    const hip = world.hip;
    const planar = (v: THREE.Vector3) => new THREE.Vector2(v.x, v.z);
    const travel = Math.max(...hip.map((v) => planar(v).distanceTo(planar(hip[0])))) / H;
    const rise = (Math.max(...hip.map((v) => v.y)) - Math.min(...hip.map((v) => v.y))) / H;
    const speed = travel / clip.duration;
    const headRise = (Math.max(...world.head.map((v) => v.y)) - Math.min(...world.head.map((v) => v.y))) / H;

    /**
     * Limb ranges are hip-relative, and that is not a detail. In world space a forward-travelling
     * gait carries its limbs with the body, so every limb range collapses to roughly `travel` and
     * the bands the classifier uses become unsatisfiable at any speed.
     */
    const relRange = (samples: THREE.Vector3[]) => {
      const rel = samples.map((v, i) => v.clone().sub(hip[i]));
      return Math.max(
        Math.max(...rel.map((v) => v.x)) - Math.min(...rel.map((v) => v.x)),
        Math.max(...rel.map((v) => v.y)) - Math.min(...rel.map((v) => v.y)),
        Math.max(...rel.map((v) => v.z)) - Math.min(...rel.map((v) => v.z)),
      ) / H;
    };
    const handRange = Math.max(relRange(world['hand.l']), relRange(world['hand.r']));
    const footRange = Math.max(relRange(world['foot.l']), relRange(world['foot.r']));

    const first = poseAt[0];
    const last = poseAt[poseAt.length - 1];
    let poseReturnDegrees = 0;
    let poseReturnPosition = 0;
    for (let i = 0; i < first.q.length; i += 1) {
      poseReturnDegrees = Math.max(poseReturnDegrees, THREE.MathUtils.radToDeg(first.q[i].angleTo(last.q[i])));
      poseReturnPosition = Math.max(poseReturnPosition, first.p[i].distanceTo(last.p[i]) / H);
    }
    const hipReturn = hip[0].distanceTo(hip[hip.length - 1]) / H;

    // Stage R3 section 2, verbatim. A clip can land in more than one of these.
    const classes: string[] = [];
    if (travel < 0.02 && rise < 0.02) classes.push('idle');
    if (travel < 0.30) classes.push('in-place');
    if (speed >= 0.30 && speed < 0.60) classes.push('walk');
    if (speed >= 0.60 && speed < 1.50) classes.push('run');
    if (speed >= 1.50) classes.push('dash');
    if (rise >= 0.15 && travel < 0.50) classes.push('jump');
    if (rise >= 0.15 && travel >= 0.50) classes.push('leap');
    if (footRange < 0.10) classes.push('planted');
    if (handRange >= 0.40 && travel < 0.30) classes.push('gesture');

    // Section 4: what makes a clip loop is that the last pose returns to the first, not that the
    // root stayed put.
    const loop = poseReturnDegrees <= 0.5 && hipReturn <= 0.01;

    report.features = {
      duration: Number(clip.duration.toFixed(4)),
      travel: Number(travel.toFixed(4)),
      rise: Number(rise.toFixed(4)),
      speed: Number(speed.toFixed(4)),
      handRange: Number(handRange.toFixed(4)),
      footRange: Number(footRange.toFixed(4)),
      headRise: Number(headRise.toFixed(4)),
      scaleDelta: Number(scaleDelta.toFixed(8)),
      scaleDeltaFromRest: Number(scaleDeltaFromRest.toFixed(8)),
      poseReturnDegrees: Number(poseReturnDegrees.toFixed(4)),
      poseReturnPosition: Number(poseReturnPosition.toFixed(6)),
      hipReturn: Number(hipReturn.toFixed(6)),
    };
    report.classes = classes;
    report.loop = loop;
    report.loopReason = loop
      ? `poseReturn ${poseReturnDegrees.toFixed(3)} deg <= 0.5 and hipReturn ${hipReturn.toFixed(5)}H <= 0.01H`
      : `poseReturn ${poseReturnDegrees.toFixed(3)} deg / hipReturn ${hipReturn.toFixed(5)}H — plays once`;
  } catch (error) {
    report.status = 'unevaluated';
    report.missingInputs = [`threw while sampling: ${(error as Error).message}`];
  }

  reports.push(report);
}

mixer.stopAllAction();
restoreBindPose();

const measured = reports.filter((r) => r.status === 'measured');
const unevaluated = reports.filter((r) => r.status === 'unevaluated');
const maxSampledBindingDelta = measured.length ? Math.max(...measured.map((r) => r.maxSampledBindingDelta ?? 0)) : null;
const failed = measured.filter((r) => r.gateR1 === 'fail');

// A tripwire, not a descriptor: a rig that scales joints changes what may legally be done to skin
// weights, and that has to surface before anything downstream trusts the weights.
const SCALE_TRIPWIRE_LIMIT = 1e-6;
const scaleTripwire = measured.filter((r) => (r.features?.scaleDeltaFromRest ?? 0) > SCALE_TRIPWIRE_LIMIT).map((r) => r.name);
const maxScaleFromRest = measured.length ? Math.max(...measured.map((r) => r.features?.scaleDeltaFromRest ?? 0)) : 0;
const maxScaleFromUnity = measured.length ? Math.max(...measured.map((r) => r.features?.scaleDelta ?? 0)) : 0;

const summary = {
  gate: 'R1 — sampled binding delta',
  criterion: 'maxSampledBindingDelta <= 2^-23 over >= 5 sampled times x every clip',
  epsilon: EPSILON,
  samplesPerClip: SAMPLES_PER_CLIP,
  clipsTotal: clips.length,
  clipsMeasured: measured.length,
  clipsUnevaluated: unevaluated.map((r) => ({ name: r.name, missingInputs: r.missingInputs })),
  maxSampledBindingDelta,
  verdict: unevaluated.length > 0
    ? 'incomplete — some clips were not measured'
    : failed.length === 0 && maxSampledBindingDelta !== null
      ? 'pass'
      : 'fail',
  failedClips: failed.map((r) => r.name),
  scaleDeltaTripwire: scaleTripwire.length
    ? { fired: true, clips: scaleTripwire, maxScaleFromRest }
    : {
        fired: false,
        note: `no clip moves a joint's scale away from its rest value (max ${maxScaleFromRest.toExponential(2)}, limit ${SCALE_TRIPWIRE_LIMIT.toExponential(0)}). Every one of the 1,353 tracks does carry a scale channel, but each holds the rest value; the rest pose itself is 1 +/- ${maxScaleFromUnity.toExponential(2)}, which is exporter quantisation, not animation.`,
        maxScaleFromRest,
        maxScaleFromUnity,
      },
  bones: RIG.bones.length,
  landmarks: LANDMARKS,
  clips: reports,
};

mkdirSync(new URL('../../src/demos/monster-cute/evidence/', import.meta.url), { recursive: true });
writeFileSync(new URL('../../src/demos/monster-cute/evidence/gate-r1.json', import.meta.url), JSON.stringify(summary, null, 2));

console.log(`Gate R1 over ${clips.length} clips, ${SAMPLES_PER_CLIP} seeks each`);
console.log(`  maxSampledBindingDelta = ${maxSampledBindingDelta?.toExponential(3)}  (limit ${EPSILON.toExponential(3)})`);
console.log(`  verdict: ${summary.verdict.toUpperCase()}`);
if (unevaluated.length) console.log(`  unevaluated: ${unevaluated.map((r) => r.name).join(', ')}`);
console.log(`  scaleDelta tripwire: ${summary.scaleDeltaTripwire.fired ? `FIRED on ${scaleTripwire.length} clip(s)` : `clean (max move from rest ${maxScaleFromRest.toExponential(2)}; rest pose itself is 1 +/- ${maxScaleFromUnity.toExponential(2)})`}`);
console.log(`  loopable by measurement: ${measured.filter((r) => r.loop).map((r) => r.name).join(', ') || 'none'}`);
console.log('\nclip                          dur    travel   rise   speed  hand   foot   loop  classes');
for (const r of reports) {
  if (r.status !== 'measured' || !r.features) { console.log(`  ${r.name.padEnd(28)} UNEVALUATED — ${r.missingInputs?.join('; ')}`); continue; }
  const f = r.features;
  console.log(`  ${r.name.padEnd(28)} ${f.duration.toFixed(2).padStart(5)} ${f.travel.toFixed(3).padStart(7)} ${f.rise.toFixed(3).padStart(6)} ${f.speed.toFixed(3).padStart(7)} ${f.handRange.toFixed(2).padStart(5)} ${f.footRange.toFixed(2).padStart(6)}  ${r.loop ? 'yes ' : 'no  '}  ${r.classes?.join('+') || '-'}`);
}
