import * as THREE from 'three';
import type { DecodedPart, EncodedRig } from './meshCodec';

/**
 * Sockets — the anchor points every effect in this showcase hangs from.
 *
 * A correction to the brief, stated plainly: `object-sculpt-spec.json` does NOT contain an
 * `actionProfile.sockets` block or a `destructionGroups` block. The playground's GLB fast lane
 * emitted a one-component tree and three generic `animationAnchors` strings ("root group supports
 * whole-object translation…"), nothing addressable. So the sockets below are AUTHORED here, and the
 * spec is updated to carry them.
 *
 * What keeps that honest is where the numbers come from. A socket is never a hand-typed coordinate.
 * Each one is:
 *   - parented to a REAL bone, by its real name, out of the 41-bone Tripo rig, and
 *   - offset by a position MEASURED from the shell itself — the centroid or the extremum of the
 *     vertices that bone actually owns, expressed in that bone's local space.
 *
 * So "the crown socket" is the highest point of the geometry the `Head` bone drives, not 1.75 units
 * up the Y axis. When the head moves, the socket moves with it, because it is a child of the bone.
 */

export type SocketKind = 'grip' | 'effect' | 'attachment';

export interface SocketDefinition {
  id: string;
  kind: SocketKind;
  /** A real bone name from the rig — verified against the skeleton at build time. */
  bone: string;
  /**
   * How to place the socket inside the cloud of vertices the bone owns. Every option is a measured
   * statistic of that cloud, so no option is a magic number.
   *
   * `joint` is the exception that proves the rule: it sits at the bone's own origin. `Hip` drives
   * the figure's centre of mass but owns almost no vertices outright — the skin there is shared
   * with `Pelvis`, `Waist` and the thighs — so there is no cloud to take a statistic of. The joint
   * position is still measured data (it is the rig's own), it just comes from the skeleton rather
   * than from the skin.
   */
  anchor: 'centroid' | 'top' | 'bottom' | 'forward' | 'outward' | 'joint';
  description: string;
}

/**
 * The socket set. Bone names are the rig's own — `Root`, `Hip`, `Spine02`, `R_Hand` and so on come
 * straight out of `RIG.bones` and are asserted at build time, so a typo fails loudly instead of
 * silently anchoring an effect to the origin.
 *
 * The rig has no finger bones: hands are a single `L_Hand` / `R_Hand` each. A grip socket therefore
 * sits at the measured palm centroid rather than between fingers, which is the honest resolution
 * this skeleton supports.
 */
export const SOCKETS: readonly SocketDefinition[] = [
  { id: 'grip.right', kind: 'grip', bone: 'R_Hand', anchor: 'centroid', description: 'right palm — where the conjured blade is held' },
  { id: 'grip.left', kind: 'grip', bone: 'L_Hand', anchor: 'centroid', description: 'left palm — the off-hand seal' },
  { id: 'effect.chest', kind: 'effect', bone: 'Spine02', anchor: 'forward', description: 'cuirass front — the dragon sigil core' },
  { id: 'effect.crown', kind: 'effect', bone: 'Head', anchor: 'top', description: 'headdress ribbon — crown embers' },
  { id: 'effect.waist', kind: 'effect', bone: 'Waist', anchor: 'forward', description: 'the dragon-head belt buckle' },
  { id: 'effect.shoulder.left', kind: 'effect', bone: 'L_Clavicle', anchor: 'outward', description: 'left pauldron' },
  { id: 'effect.shoulder.right', kind: 'effect', bone: 'R_Clavicle', anchor: 'outward', description: 'right pauldron' },
  { id: 'attachment.foot.left', kind: 'attachment', bone: 'L_Foot', anchor: 'bottom', description: 'left sole — ground contact' },
  { id: 'attachment.foot.right', kind: 'attachment', bone: 'R_Foot', anchor: 'bottom', description: 'right sole — ground contact' },
  { id: 'effect.pelvis', kind: 'effect', bone: 'Hip', anchor: 'joint', description: 'figure centre of mass — aura origin' },
];

export interface MeasuredSocket extends SocketDefinition {
  /** Offset in the bone's own local space, measured from the skin that bone drives. */
  offset: THREE.Vector3;
  /** How many vertices the bone dominantly owned; a low count means a weak measurement. */
  sampleCount: number;
  /** Extent of that vertex cloud, so a caller can scale an effect to the body part it sits on. */
  radius: number;
}

/**
 * Measure every socket against the shell.
 *
 * For each bone we collect the vertices it dominantly drives (top weight), transform them into the
 * bone's local frame with that bone's inverse bind matrix, and take the requested statistic. The
 * inverse bind matrix is exactly the bind-space to bone-space map, so this is the same space the
 * socket will live in once it is parented to the bone.
 */
export function measureSockets(part: DecodedPart, rig: EncodedRig, skinIndex: Uint16Array, skinWeight: Float32Array): MeasuredSocket[] {
  const boneIndexByName = new Map(rig.bones.map((b, i) => [b.name, i]));
  const wanted = new Map<number, SocketDefinition[]>();
  for (const socket of SOCKETS) {
    const index = boneIndexByName.get(socket.bone);
    if (index === undefined) {
      throw new Error(`socket "${socket.id}" names bone "${socket.bone}", which is not in the rig`);
    }
    const list = wanted.get(index) ?? [];
    list.push(socket);
    wanted.set(index, list);
  }

  // Gather the local-space vertex cloud for every bone a socket cares about.
  const clouds = new Map<number, THREE.Vector3[]>();
  for (const index of wanted.keys()) clouds.set(index, []);
  const inverseBinds = new Map<number, THREE.Matrix4>();
  for (const index of wanted.keys()) {
    inverseBinds.set(index, new THREE.Matrix4().fromArray(rig.bones[index].inverseBind));
  }

  const vertexCount = part.position.length / 3;
  const v = new THREE.Vector3();
  for (let i = 0; i < vertexCount; i += 1) {
    let dominant = -1;
    let best = 0;
    for (let c = 0; c < 4; c += 1) {
      const w = skinWeight[i * 4 + c];
      if (w > best) { best = w; dominant = skinIndex[i * 4 + c]; }
    }
    const cloud = clouds.get(dominant);
    if (!cloud || best < 0.5) continue; // a vertex shared between bones is nobody's landmark
    v.set(part.position[i * 3], part.position[i * 3 + 1], part.position[i * 3 + 2]);
    v.applyMatrix4(inverseBinds.get(dominant)!);
    cloud.push(v.clone());
  }

  const out: MeasuredSocket[] = [];
  for (const [boneIndex, definitions] of wanted) {
    const cloud = clouds.get(boneIndex)!;
    for (const definition of definitions) {
      if (definition.anchor === 'joint') {
        // The bone origin itself; no vertex cloud is consulted, and none is claimed.
        out.push({ ...definition, offset: new THREE.Vector3(), sampleCount: cloud.length, radius: 0 });
        continue;
      }
      if (!cloud.length) {
        // Say so rather than substituting the origin and pretending it was measured.
        out.push({ ...definition, offset: new THREE.Vector3(), sampleCount: 0, radius: 0 });
        continue;
      }
      const centroid = new THREE.Vector3();
      for (const p of cloud) centroid.add(p);
      centroid.divideScalar(cloud.length);

      let radius = 0;
      for (const p of cloud) radius = Math.max(radius, p.distanceTo(centroid));

      const offset = centroid.clone();
      if (definition.anchor !== 'centroid') {
        // The bone's local axes are the rig's, not the world's, so "top" is resolved by finding the
        // extreme vertex along the axis that best matches the requested direction after the bone's
        // bind rotation — measured, again, rather than assumed to be +Y.
        const bind = new THREE.Matrix4().copy(inverseBinds.get(boneIndex)!).invert();
        const toWorld = new THREE.Matrix3().setFromMatrix4(bind);
        const want = new THREE.Vector3(
          definition.anchor === 'outward' ? 1 : 0,
          definition.anchor === 'top' ? 1 : definition.anchor === 'bottom' ? -1 : 0,
          definition.anchor === 'forward' ? -1 : 0,
        );
        // Express the desired world direction in bone-local space.
        const localDir = want.clone().applyMatrix3(new THREE.Matrix3().copy(toWorld).invert()).normalize();
        let bestDot = -Infinity;
        let bestPoint = cloud[0];
        for (const p of cloud) {
          const d = p.dot(localDir);
          if (d > bestDot) { bestDot = d; bestPoint = p; }
        }
        // Sit slightly inside the extreme vertex so an effect hugs the surface instead of floating
        // off the single furthest triangle.
        offset.copy(bestPoint).lerp(centroid, 0.15);
      }
      out.push({ ...definition, offset, sampleCount: cloud.length, radius });
    }
  }
  return out;
}

/** Attach an `Object3D` per socket to its bone, so it inherits the bone's animated transform. */
export function attachSockets(bones: THREE.Bone[], measured: MeasuredSocket[]): Map<string, THREE.Object3D> {
  const byName = new Map(bones.map((b) => [b.name, b]));
  const out = new Map<string, THREE.Object3D>();
  for (const socket of measured) {
    const bone = byName.get(socket.bone);
    if (!bone) continue;
    const node = new THREE.Object3D();
    node.name = `socket:${socket.id}`;
    node.position.copy(socket.offset);
    node.userData.socket = socket;
    bone.add(node);
    out.set(socket.id, node);
  }
  return out;
}
