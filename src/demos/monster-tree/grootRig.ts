import * as THREE from 'three';
import type { MonsterTreeRig } from './rig';

/** Extend, never reorder, the imported skin palette. The five digit lanes are inferred from
 * the existing hand surface, not claimed to be anatomically labelled source fingers. */
export function articulateGrootHands(rig: MonsterTreeRig): void {
  const { skeleton, shell } = rig;
  rig.group.updateMatrixWorld(true);
  const pos = shell.geometry.getAttribute('position');
  const indices = shell.geometry.getAttribute('skinIndex');
  const weights = shell.geometry.getAttribute('skinWeight');
  const p = new THREE.Vector3();
  for (const side of ['L', 'R']) {
    const hand = rig.bones[`${side}_Hand`];
    const handIndex = skeleton.bones.indexOf(hand);
    const inverse = skeleton.boneInverses[handIndex];
    const samples: THREE.Vector3[] = [];
    for (let i = 0; i < pos.count; i++) {
      for (let k = 0; k < 4; k++) {
        if (indices.array[i * 4 + k] === handIndex && weights.array[i * 4 + k] > 0.5) {
          p.fromBufferAttribute(pos, i).applyMatrix4(inverse);
          if (p.y > 0.065) samples.push(p.clone());
          break;
        }
      }
    }
    samples.sort((a, b) => a.z - b.z);
    const lanes = Array.from({ length: 5 }, (_, lane) => {
      const band = samples.slice(Math.floor(lane * samples.length / 5), Math.floor((lane + 1) * samples.length / 5));
      const mean = band.reduce((v, s) => v.add(s), new THREE.Vector3()).divideScalar(band.length);
      const reach = Math.max(0.09, ...band.map(s => s.y));
      const segment = (reach - 0.048) / 3;
      let parent = hand;
      const ids: number[] = [];
      for (let joint = 0; joint < 3; joint++) {
        const bone = new THREE.Bone();
        bone.name = `${side}_Digit${lane + 1}_${joint + 1}`;
        bone.position.set(joint === 0 ? mean.x : 0, joint === 0 ? 0.048 : segment, joint === 0 ? mean.z : 0);
        parent.add(bone);
        rig.group.updateMatrixWorld(true);
        ids.push(skeleton.bones.length);
        skeleton.bones.push(bone);
        // Existing inverses are in the source mesh's pre-normalisation bind space.
        skeleton.boneInverses.push(bone.matrixWorld.clone().invert().multiply(hand.matrixWorld).multiply(inverse));
        rig.bones[bone.name] = bone;
        parent = bone;
      }
      return { z: mean.z, segment, ids };
    });
    for (let i = 0; i < pos.count; i++) {
      let handWeight = 0;
      const influence = new Map<number, number>();
      for (let k = 0; k < 4; k++) {
        const id = indices.array[i * 4 + k], w = weights.array[i * 4 + k];
        if (id === handIndex) handWeight += w;
        else if (w > 0) influence.set(id, (influence.get(id) ?? 0) + w);
      }
      if (!handWeight) continue;
      // Keep every original non-hand influence. Dropping one during a top-four sort changes
      // the source bind silhouette because the imported inverse-bind matrices are not ideal.
      const originalOthers = [...influence];
      if (originalOthers.length >= 3) continue;
      influence.clear();
      p.fromBufferAttribute(pos, i).applyMatrix4(inverse);
      const growth = THREE.MathUtils.smoothstep(p.y, 0.035, 0.10);
      influence.set(handIndex, handWeight * (1 - growth));
      let lo = 0;
      while (lo < 3 && p.z > lanes[lo + 1].z) lo++;
      const hi = lo + 1;
      const blend = THREE.MathUtils.clamp((p.z - lanes[lo].z) / Math.max(0.001, lanes[hi].z - lanes[lo].z), 0, 1);
      for (const [laneIndex, across] of [[lo, 1 - blend], [hi, blend]]) {
        const lane = lanes[laneIndex];
        const along = THREE.MathUtils.clamp((p.y - 0.048) / lane.segment, 0, 2);
        const j = Math.min(1, Math.floor(along)), mix = along - j;
        influence.set(lane.ids[j], handWeight * growth * across * (1 - mix));
        influence.set(lane.ids[j + 1], handWeight * growth * across * mix);
      }
      const fingers = [...influence].sort((a, b) => b[1] - a[1]).slice(0, 4-originalOthers.length);
      const fingerSum = fingers.reduce((n,item)=>n+item[1],0);
      const sorted = [...originalOthers,...fingers.map(([id,w])=>[id,w/fingerSum*handWeight])];
      const sum = sorted.reduce((n, item) => n + item[1], 0);
      for (let k = 0; k < 4; k++) {
        indices.array[i * 4 + k] = sorted[k]?.[0] ?? 0;
        weights.array[i * 4 + k] = (sorted[k]?.[1] ?? 0) / sum;
      }
    }
  }
  skeleton.init();
  indices.needsUpdate = weights.needsUpdate = true;
  shell.userData.handRig = '30 inferred digit joints; original 41 palette entries preserved';
}
