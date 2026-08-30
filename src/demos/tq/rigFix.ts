import * as THREE from 'three';
import type { EncodedRig } from './meshCodec';

/**
 * The measured animation defect, and its fix.
 *
 * WHAT WAS MEASURED (`tools/rootMotionProbe.ts`, all 24 clips, 9 samples each):
 *   - the bind is sound: at the rest pose the skin reproduces the bind geometry to 3.2e-8, and
 *     vertices pinned to a single bone land on that bone's rigid transform to 2.6e-8. So the
 *     figure is NOT mis-skinned, and re-binding would have fixed nothing.
 *   - `Root` never moves: rootTravel is 0.0000 in every clip.
 *   - of the 960 position tracks in the rig, only 24 vary over time — exactly one per clip, and
 *     always `Hip`.
 *   - that one track travels up to 7.61 units on a skeleton whose entire rest span is 1.0755.
 *
 * So the retarget baked locomotion onto `Hip` instead of onto `Root`. `Root` stays pinned at the
 * origin while `Hip` — and every one of the 39 bones descending from it, which is the whole figure —
 * translates metres away. On a stage with a fixed camera that reads exactly as reported: the figure
 * is dragged off its feet and smeared away from the ground plane.
 *
 * THE FIX: neutralise the horizontal component of that one track and keep everything else. The
 * pose is untouched — every rotation, the leg cycle, the crouch and the jump arc all still play —
 * so the clip still looks like running; it simply runs in place, which is what a showcase stage
 * wants. The removed travel is not discarded: it comes back as `RootMotion` so a locomotion system
 * can drive a character controller with it instead.
 *
 * Vertical motion is deliberately preserved. Zeroing the whole track would flatten the jump arc and
 * the dive, which are pose, not drag.
 */

export interface RootMotion {
  clip: string;
  /** Bone the locomotion was baked onto — measured, not assumed. */
  bone: string;
  /** Horizontal travel removed, in bind units, sampled at the track's own keyframe times. */
  travel: Float32Array;
  /** Largest horizontal displacement removed. */
  maxTravel: number;
}

export interface RootMotionResult {
  clips: THREE.AnimationClip[];
  motion: RootMotion[];
  /** Bones whose translation varied, per clip — the evidence the fix is aimed at the right track. */
  movingBones: string[];
}

/**
 * The figure's up axis expressed in the moving bone's PARENT frame.
 *
 * Derived rather than hardcoded: the hip of a standing figure sits directly above the root, so the
 * rest translation of the moving bone already points along up. On this rig that resolves to
 * +Z — the Tripo skeleton is authored Z-up and rotated into Y-up at the Root — which is why
 * assuming "y is vertical" here would have removed the crouch and kept the drag.
 */
function upAxisInParentFrame(restPosition: readonly number[]): THREE.Vector3 {
  const up = new THREE.Vector3(restPosition[0], restPosition[1], restPosition[2]);
  if (up.lengthSq() < 1e-12) return new THREE.Vector3(0, 1, 0);
  return up.normalize();
}

/** Which bone actually carries locomotion in this clip: the varying position track, measured. */
function findMotionTrack(clip: THREE.AnimationClip): THREE.VectorKeyframeTrack | null {
  let best: THREE.VectorKeyframeTrack | null = null;
  let bestVariance = 1e-5; // below this a track is a constant rest offset, not motion
  for (const track of clip.tracks) {
    if (!track.name.endsWith('.position')) continue;
    const values = track.values;
    const count = values.length / 3;
    let variance = 0;
    for (let i = 1; i < count; i += 1) {
      variance = Math.max(
        variance,
        Math.hypot(values[i * 3] - values[0], values[i * 3 + 1] - values[1], values[i * 3 + 2] - values[2]),
      );
    }
    if (variance > bestVariance) {
      bestVariance = variance;
      best = track as THREE.VectorKeyframeTrack;
    }
  }
  return best;
}

/**
 * Strip the baked travel from every clip, in place on freshly cloned tracks.
 *
 * Returns the clips to play and the travel that was taken out of them.
 */
export function neutraliseRootMotion(clips: THREE.AnimationClip[], rig: EncodedRig): RootMotionResult {
  const restByBone = new Map(rig.bones.map((b) => [b.name, b.position]));
  const motion: RootMotion[] = [];
  const movingBones: string[] = [];

  const fixed = clips.map((source) => {
    const clip = source.clone();
    const track = findMotionTrack(clip);
    if (!track) {
      motion.push({ clip: clip.name, bone: '(none)', travel: new Float32Array(0), maxTravel: 0 });
      return clip;
    }

    const bone = track.name.slice(0, -'.position'.length);
    movingBones.push(`${clip.name}:${bone}`);
    const up = upAxisInParentFrame(restByBone.get(bone) ?? [0, 1, 0]);

    const values = track.values;
    const count = values.length / 3;
    const p = new THREE.Vector3();
    const vertical = new THREE.Vector3();
    const horizontal = new THREE.Vector3();
    const horizontalAtStart = new THREE.Vector3();
    const travel = new Float32Array(count);
    let maxTravel = 0;

    for (let i = 0; i < count; i += 1) {
      p.set(values[i * 3], values[i * 3 + 1], values[i * 3 + 2]);
      vertical.copy(up).multiplyScalar(p.dot(up));
      horizontal.copy(p).sub(vertical);
      if (i === 0) horizontalAtStart.copy(horizontal);

      const drift = horizontal.distanceTo(horizontalAtStart);
      travel[i] = drift;
      if (drift > maxTravel) maxTravel = drift;

      // Keep the full vertical (crouch, jump arc, dive) and the pose's own starting offset;
      // remove only the horizontal DRIFT away from where the clip started.
      p.copy(vertical).add(horizontalAtStart);
      values[i * 3] = p.x;
      values[i * 3 + 1] = p.y;
      values[i * 3 + 2] = p.z;
    }

    motion.push({ clip: clip.name, bone, travel, maxTravel });
    return clip;
  });

  return { clips: fixed, motion, movingBones };
}
