import * as THREE from 'three';

/**
 * An authored walk cycle, because the rig does not ship one.
 *
 * The eighteen retargeted presets contain exactly one locomotion clip, `flee_02`, and it is a flee:
 * measured, it leaves both feet off the ground for 25% of its frames, lifts a foot to 0.91 of figure
 * height, and is the hardest clip in the set on the mesh (body 0.074, hair 0.024). Slowing it down
 * would not turn it into a walk — a walk is defined by always having a foot down, and retiming does
 * not add a contact that was never in the keyframes. So the walk is written here instead, which also
 * means every amplitude in it is a number this file chose rather than one it inherited.
 *
 * IT IS A GLIDE, NOT A GAIT
 * -------------------------
 * The bind pose holds the arms out and away from the body — measured arm span is 0.709 against a
 * height of 1.0 — and a naturalistic walk would have to swing them down some sixty degrees and hold
 * them there. That is the single deformation an auto-rigged shoulder handles worst, and this rig's
 * shoulders are auto-rigged. Rotating them that far to chase realism would buy a natural silhouette
 * at the cost of exactly the artefact this whole demo exists to remove.
 *
 * So the arms keep their bind carriage and take a small swing, and the walk is stately rather than
 * brisk: a measured, gliding step. On a character in a floor-length ceremonial gown that reads as
 * deliberate rather than as a limitation — and the gown covers the legs through most of the cycle
 * anyway, so the step reads through the hem and the weight shift more than through the knees.
 *
 * HOW THE POSE IS EXPRESSED
 * -------------------------
 * Angles here are authored in the figure's own space — forward is +X, up is +Y, lateral is ±Z, taken
 * from the measured bind bounds — and converted per joint by `L = Lbind * (Qbind⁻¹ · R · Qbind)`.
 * That identity puts the world-space rotation R onto a joint whose local axes point wherever the
 * auto-rig happened to leave them, so the code can say "swing the thigh forward" and mean it,
 * instead of guessing which local axis a twist joint calls forward.
 */

/** One stride, in seconds. Slow on purpose: this is a procession, not a commute. */
const PERIOD = 1.3;
const SAMPLES_PER_SECOND = 30;

/**
 * Amplitudes, in radians unless noted.
 *
 * Every one of these is deliberately below what a naturalistic walk would use. The gate measures the
 * result the same way it measures the preset clips, and this cycle has to come in under the gentlest
 * of them — a walk that tore the mesh would defeat its own purpose.
 */
const AMPLITUDE = {
  /** Thigh swing, fore and aft of vertical. */
  thigh: 0.2,
  /** Knee flexion. Always a bend, never a hyperextension. */
  calf: 0.42,
  /** Ankle, counter-rotated to keep the sole roughly level through the step. */
  foot: 0.45,
  /** Vertical travel of the pelvis, in figure heights. Twice per stride. */
  bob: 0.011,
  /** Pelvis roll, for the weight shift the pinned-in-place hip cannot show as sway. */
  hipRoll: 0.05,
  /** Shoulder swing, kept small for the reason in the header. */
  arm: 0.1,
  /** Counter-rotation through the spine, so the torso answers the legs. */
  spine: 0.045,
  /** Head, holding its line against the spine's counter-rotation. */
  head: 0.02,
};

const FORWARD = new THREE.Vector3(1, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);
const LATERAL = new THREE.Vector3(0, 0, 1);

/** World-space bind rotation of every bone, and its bind local transform. */
function bindPose(bones: THREE.Bone[]): Map<string, { local: THREE.Quaternion; world: THREE.Quaternion; position: THREE.Vector3 }> {
  const world = new Map<THREE.Bone, THREE.Quaternion>();
  const out = new Map<string, { local: THREE.Quaternion; world: THREE.Quaternion; position: THREE.Vector3 }>();
  for (const bone of bones) {
    const parent = bone.parent instanceof THREE.Bone ? world.get(bone.parent) : undefined;
    const worldQuaternion = parent ? parent.clone().multiply(bone.quaternion) : bone.quaternion.clone();
    world.set(bone, worldQuaternion);
    out.set(bone.name, { local: bone.quaternion.clone(), world: worldQuaternion, position: bone.position.clone() });
  }
  return out;
}

/**
 * Rotate a joint by `angle` about a FIGURE-space axis, returned as the local quaternion three needs.
 *
 * `Lbind · (Qbind⁻¹ · R · Qbind)` is the whole trick: conjugating the world rotation by the joint's
 * bind orientation re-expresses it in that joint's own frame, so the caller never has to know which
 * way the auto-rig pointed a given twist joint's local axes.
 */
function worldRotation(
  bind: { local: THREE.Quaternion; world: THREE.Quaternion },
  axis: THREE.Vector3,
  angle: number,
): THREE.Quaternion {
  const inWorld = new THREE.Quaternion().setFromAxisAngle(axis, angle);
  const inLocal = bind.world.clone().invert().multiply(inWorld).multiply(bind.world);
  return bind.local.clone().multiply(inLocal);
}

/** Knee flexion over one stride: a bend that peaks through the swing and vanishes at contact. */
function kneeBend(phase: number): number {
  // Shifted so the knee is straightest as the heel lands and deepest as the foot passes under.
  const swing = 0.5 - 0.5 * Math.cos(2 * Math.PI * (phase + 0.12));
  return -AMPLITUDE.calf * swing ** 1.3;
}

/**
 * Build the clip.
 *
 * `bones` must be in their bind pose — the conversion above reads their rest rotations, so calling
 * this after a mixer has posed the skeleton would bake that pose into the walk.
 */
export function createWalkClip(bones: THREE.Bone[], name = 'authored:walk'): THREE.AnimationClip {
  const bind = bindPose(bones);
  const frames = Math.round(PERIOD * SAMPLES_PER_SECOND);
  // One extra sample at exactly `PERIOD`, holding the pose the cycle started in, so the loop closes
  // without a seam rather than interpolating back across the whole stride.
  const times: number[] = [];
  for (let f = 0; f <= frames; f += 1) times.push((f / frames) * PERIOD);

  const tracks: THREE.KeyframeTrack[] = [];

  const rotationTrack = (
    boneName: string,
    axis: THREE.Vector3,
    angleAt: (phase: number) => number,
  ): void => {
    const rest = bind.get(boneName);
    if (!rest) return;
    const values: number[] = [];
    for (const time of times) {
      const q = worldRotation(rest, axis, angleAt((time / PERIOD) % 1));
      values.push(q.x, q.y, q.z, q.w);
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${boneName}.quaternion`, times, values));
  };

  // Legs. The right leg runs half a stride behind the left, which is what makes it a walk rather
  // than a hop: one foot is always on the ground.
  for (const [side, offset] of [['L', 0], ['R', 0.5]] as const) {
    rotationTrack(`${side}_Thigh`, LATERAL, (p) => AMPLITUDE.thigh * Math.sin(2 * Math.PI * (p + offset)));
    rotationTrack(`${side}_Calf`, LATERAL, (p) => kneeBend(p + offset));
    rotationTrack(`${side}_Foot`, LATERAL, (p) => (
      -AMPLITUDE.foot * (AMPLITUDE.thigh * Math.sin(2 * Math.PI * (p + offset)) + kneeBend(p + offset))
    ));
    // Arms answer the opposite leg, which is what stops a walk reading as a march.
    const armSign = side === 'L' ? -1 : 1;
    rotationTrack(`${side}_Upperarm`, UP, (p) => armSign * AMPLITUDE.arm * Math.sin(2 * Math.PI * (p + offset)));
  }

  // Pelvis roll: the weight shift, which the in-place pin removes from the hip's translation and
  // which the figure would otherwise walk without.
  rotationTrack('Hip', FORWARD, (p) => AMPLITUDE.hipRoll * Math.sin(2 * Math.PI * p));
  // Torso counter-rotation, and a head that holds its line against it.
  rotationTrack('Spine01', UP, (p) => -AMPLITUDE.spine * Math.sin(2 * Math.PI * p));
  rotationTrack('Spine02', UP, (p) => -AMPLITUDE.spine * 0.6 * Math.sin(2 * Math.PI * p));
  rotationTrack('Head', UP, (p) => AMPLITUDE.head * Math.sin(2 * Math.PI * p));

  // Vertical bob, twice a stride: the pelvis is lowest as each heel lands.
  const hip = bind.get('Hip');
  if (hip) {
    const values: number[] = [];
    for (const time of times) {
      const phase = (time / PERIOD) % 1;
      const rise = AMPLITUDE.bob * (0.5 - 0.5 * Math.cos(4 * Math.PI * phase));
      // The Hip's own local axes are not the figure's, so the offset is rotated into its parent's
      // frame the same way the rotations are — a bob authored straight onto local Y would travel
      // sideways on a rig whose root carries any tilt at all.
      const offset = new THREE.Vector3(0, rise, 0).applyQuaternion(hip.world.clone().invert());
      values.push(hip.position.x + offset.x, hip.position.y + offset.y, hip.position.z + offset.z);
    }
    tracks.push(new THREE.VectorKeyframeTrack('Hip.position', times, values));
  }

  const clip = new THREE.AnimationClip(name, PERIOD, tracks);
  clip.optimize();
  return clip;
}
