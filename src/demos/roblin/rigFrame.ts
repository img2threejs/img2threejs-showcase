import * as THREE from 'three';

/**
 * Where Roblin's body actually is, measured from the rig rather than assumed.
 *
 * This exists because the spec's `coordinateFrame` and the measured bounds disagree. The spec
 * says "subject faces -z", but `glb-parts.json` measures the figure at 0.45 wide by 1.90 tall by
 * 2.11 DEEP — and a 2.11-unit "depth" on a 1.9-unit figure is a T-pose arm span, not a body
 * depth. So the arms run along z and the body faces along x. Rather than pick a side from prose,
 * every axis below comes out of the bind pose of named bones.
 *
 * Chirality follows the skill's rule exactly: with `left` on +X and `up` on +Y in a right-handed
 * frame, forward is +Z, so `forward = left x up`. A left/right pair is a reflection of the lateral
 * axis and nothing else.
 */

/** Bone names are the RIG'S OWN, read out of rigData.ts. They are not bounds hypotheses. */
export const BONES = {
  root: 'Root',
  hip: 'Hip',
  pelvis: 'Pelvis',
  waist: 'Waist',
  spineLower: 'Spine01',
  spineUpper: 'Spine02',
  neck: 'NeckTwist02',
  head: 'Head',
  handL: 'L_Hand',
  handR: 'R_Hand',
  forearmL: 'L_Forearm',
  forearmR: 'R_Forearm',
  upperarmL: 'L_Upperarm',
  upperarmR: 'R_Upperarm',
  clavicleL: 'L_Clavicle',
  clavicleR: 'R_Clavicle',
  footL: 'L_Foot',
  footR: 'R_Foot',
  toeL: 'L_ToeBase',
  toeR: 'R_ToeBase',
} as const;

export interface RigFrame {
  bone(name: string): THREE.Bone;
  /** Every bone the rig ships, by its own name. */
  readonly all: ReadonlyMap<string, THREE.Bone>;
  /** Orthonormal body basis in world space, measured from the bind pose. */
  readonly left: THREE.Vector3;
  readonly up: THREE.Vector3;
  readonly forward: THREE.Vector3;
  /** Foot-to-head, world units. */
  readonly figureHeight: number;
  /** Fingertip to fingertip in the bind pose, world units. */
  readonly armSpan: number;
  /** Elbow to wrist. Effect radii are expressed as multiples of this so nothing is a magic number. */
  readonly forearmLength: number;
  /** Clavicle to clavicle. */
  readonly shoulderWidth: number;
  /** World position of the pelvis in the bind pose. */
  readonly hipHeight: number;
  /** Human-readable measurement log, for the report. */
  readonly log: string[];
}

function worldOf(bone: THREE.Bone, out = new THREE.Vector3()): THREE.Vector3 {
  return out.setFromMatrixPosition(bone.matrixWorld);
}

/**
 * Measure the frame from a bound skinned mesh. Call it AFTER `updateMatrixWorld(true)` and
 * BEFORE any clip has been advanced — the numbers describe the bind pose.
 */
export function measureRigFrame(mesh: THREE.SkinnedMesh): RigFrame {
  mesh.updateMatrixWorld(true);
  const all = new Map<string, THREE.Bone>();
  for (const bone of mesh.skeleton.bones) all.set(bone.name, bone);

  const need = (name: string): THREE.Bone => {
    const bone = all.get(name);
    if (!bone) {
      throw new Error(
        `rig frame: bone "${name}" is not in this skeleton. Bones present: ${[...all.keys()].join(', ')}`,
      );
    }
    return bone;
  };

  const handL = worldOf(need(BONES.handL));
  const handR = worldOf(need(BONES.handR));
  const head = worldOf(need(BONES.head));
  const hip = worldOf(need(BONES.hip));
  const footL = worldOf(need(BONES.footL));
  const footR = worldOf(need(BONES.footR));
  const forearmL = worldOf(need(BONES.forearmL));
  const clavL = worldOf(need(BONES.clavicleL));
  const clavR = worldOf(need(BONES.clavicleR));

  // Lateral first: in a T-pose the hands are the longest, least ambiguous lateral baseline there is.
  const left = handL.clone().sub(handR).normalize();
  // Up from the spine, then orthogonalised against lateral so the basis is exactly orthonormal.
  const upRaw = head.clone().sub(hip).normalize();
  const up = upRaw.clone().addScaledVector(left, -upRaw.dot(left)).normalize();
  // left x up = forward. See the chirality rule at the top of this file.
  const forward = new THREE.Vector3().crossVectors(left, up).normalize();

  const feetMid = footL.clone().add(footR).multiplyScalar(0.5);
  const figureHeight = Math.abs(head.clone().sub(feetMid).dot(up));
  const armSpan = handL.distanceTo(handR);
  const forearmLength = forearmL.distanceTo(handL);
  const shoulderWidth = clavL.distanceTo(clavR);
  const hipHeight = Math.abs(hip.clone().sub(feetMid).dot(up));

  const v = (x: THREE.Vector3) => `(${x.x.toFixed(3)}, ${x.y.toFixed(3)}, ${x.z.toFixed(3)})`;
  const log = [
    `bones ${all.size}, root "${mesh.skeleton.bones[0]?.name ?? '?'}"`,
    `left    ${v(left)}   from ${BONES.handL} - ${BONES.handR}`,
    `up      ${v(up)}   from ${BONES.head} - ${BONES.hip}, orthogonalised against left`,
    `forward ${v(forward)}   = left x up (right-handed: left +X, up +Y, forward +Z)`,
    `figureHeight ${figureHeight.toFixed(3)}  armSpan ${armSpan.toFixed(3)}  `
      + `forearm ${forearmLength.toFixed(3)}  shoulders ${shoulderWidth.toFixed(3)}  hip ${hipHeight.toFixed(3)}`,
  ];

  return {
    bone: need,
    all,
    left,
    up,
    forward,
    figureHeight,
    armSpan,
    forearmLength,
    shoulderWidth,
    hipHeight,
    log,
  };
}
