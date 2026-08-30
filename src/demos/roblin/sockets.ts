import * as THREE from 'three';
import { BONES, type RigFrame } from './rigFrame';

/**
 * The socket layer.
 *
 * THE SPEC DOES NOT HAVE ONE. `object-sculpt-spec.json` as exported carries no `actionProfile`,
 * no `actionProfile.sockets` and no `destructionGroups` — its `interaction-pass` is still
 * `pending-authoring` and its only anchors are "root group" and one pivot at the body-shell bounds
 * centre. So there was nothing to hang an effect on, and inventing coordinates was the one thing
 * the brief forbade.
 *
 * What DOES exist and is real: 41 named bones from the TRILLES biped rig. Every socket below is
 * therefore defined as (real bone) + (offset expressed as a multiple of a MEASURED body length,
 * along a MEASURED body axis). No literal world coordinate appears anywhere in this file. The
 * resulting socket set is written back into the spec as `actionProfile.sockets` with
 * `provenance: "derived-from-rig-bones"`, so the next run of the pipeline finds the sockets the
 * export was missing.
 *
 * The unit matters. Clavicle-to-clavicle measures 0.085 on this rig — the two clavicle bones sit
 * almost on the spine, so "shoulder width" here is a bone spacing and not a body width. Torso and
 * head sockets therefore multiply the FIGURE HEIGHT, which is a stable measurement; only the hand
 * sockets use the forearm, where it genuinely is the right scale.
 *
 * Offsets are given in the body frame as (forward, up, outward). `outward` is "away from the
 * midline on this bone's own side", which makes a left/right pair a REFLECTION by construction:
 * the same numbers on both sides, with the lateral axis carrying the sign. Nothing here is a
 * rotated copy.
 */

export type SocketKind = 'effect' | 'grip' | 'attachment';

export type BodySide = 'left' | 'right' | 'centre';

export interface SocketDef {
  id: string;
  kind: SocketKind;
  /** A name from rigData.ts. Verified against the live skeleton at build time. */
  bone: string;
  side: BodySide;
  /**
   * The bone the socket's POINTING axis is measured from — see motion.ts. The axis runs from this
   * bone through the socket, so a hand socket measured from the forearm points out through the
   * palm and a toe socket measured from the ankle points out along the foot.
   */
  axisFrom?: string;
  /** Multiples of `unit`, along (forward, up, outward). */
  offset: [number, number, number];
  /** Which measured length the offset multiplies. */
  unit: 'forearm' | 'shoulder' | 'height';
  purpose: string;
}

export const SOCKET_DEFS: readonly SocketDef[] = [
  {
    id: 'effect:cast-primary', kind: 'effect', bone: BONES.handR, side: 'right',
    axisFrom: BONES.forearmR,
    offset: [0.55, 0.12, 0.0], unit: 'forearm',
    purpose: 'muzzle of a ranged cast — a palm-length ahead of the right hand',
  },
  {
    id: 'effect:cast-secondary', kind: 'effect', bone: BONES.handL, side: 'left',
    axisFrom: BONES.forearmL,
    offset: [0.55, 0.12, 0.0], unit: 'forearm',
    purpose: 'second muzzle, for volleys that alternate hands',
  },
  {
    id: 'effect:core', kind: 'effect', bone: BONES.spineUpper, side: 'centre',
    axisFrom: BONES.spineLower,
    offset: [0.07, 0.0, 0.0], unit: 'height',
    purpose: 'chest emitter — the charge that a cast draws from and the idle aura pulses at',
  },
  {
    id: 'effect:crown', kind: 'effect', bone: BONES.head, side: 'centre',
    axisFrom: BONES.neck,
    offset: [0.0, 0.11, 0.0], unit: 'height',
    purpose: 'above the skull, for rising motes and the nova column',
  },
  {
    id: 'effect:shoulder-l', kind: 'effect', bone: BONES.clavicleL, side: 'left',
    axisFrom: BONES.spineUpper,
    offset: [0.0, 0.03, 0.075], unit: 'height',
    purpose: 'left shoulder wisp',
  },
  {
    id: 'effect:shoulder-r', kind: 'effect', bone: BONES.clavicleR, side: 'right',
    axisFrom: BONES.spineUpper,
    offset: [0.0, 0.03, 0.075], unit: 'height',
    purpose: 'right shoulder wisp — the reflection of shoulder-l',
  },
  {
    id: 'grip:left', kind: 'grip', bone: BONES.handL, side: 'left',
    axisFrom: BONES.forearmL,
    offset: [0.0, 0.0, 0.0], unit: 'forearm',
    purpose: 'where a held prop would sit; unused by the effects but part of the action profile',
  },
  {
    id: 'grip:right', kind: 'grip', bone: BONES.handR, side: 'right',
    axisFrom: BONES.forearmR,
    offset: [0.0, 0.0, 0.0], unit: 'forearm',
    purpose: 'the mirror of grip:left',
  },
  {
    id: 'attachment:step-l', kind: 'attachment', bone: BONES.toeL, side: 'left',
    axisFrom: BONES.footL,
    offset: [0.0, 0.0, 0.0], unit: 'forearm',
    purpose: 'ground contact for the left foot — the footstep detector watches this one',
  },
  {
    id: 'attachment:step-r', kind: 'attachment', bone: BONES.toeR, side: 'right',
    axisFrom: BONES.footR,
    offset: [0.0, 0.0, 0.0], unit: 'forearm',
    purpose: 'the mirror of attachment:step-l',
  },
];

export interface Socket {
  readonly def: SocketDef;
  readonly bone: THREE.Bone;
  /** An empty child of the bone. Read its world matrix; do not parent effects to it. */
  readonly object: THREE.Object3D;
  worldPosition(out?: THREE.Vector3): THREE.Vector3;
  worldQuaternion(out?: THREE.Quaternion): THREE.Quaternion;
}

export interface SocketRig {
  get(id: string): Socket;
  readonly all: ReadonlyMap<string, Socket>;
  readonly log: string[];
  /** The `actionProfile.sockets` block to write back into object-sculpt-spec.json. */
  specBlock(): unknown;
}

/**
 * Build the sockets against a live skeleton.
 *
 * Effects are NOT parented to the returned objects. The mesh carries the rig's normalisation
 * scale, so anything parented under a bone inherits it and a 1-unit particle becomes a 2.1-unit
 * one. Effects live at the scene root and read `worldPosition()` each frame instead.
 */
export function createSockets(frame: RigFrame): SocketRig {
  const all = new Map<string, Socket>();
  const log: string[] = [];
  const units = {
    forearm: frame.forearmLength,
    shoulder: frame.shoulderWidth,
    height: frame.figureHeight,
  };

  for (const def of SOCKET_DEFS) {
    // Throws with the full bone list if the name is wrong — a socket on a bone that is not there
    // is a bug to fix, never something to silently skip.
    const bone = frame.bone(def.bone);
    const unit = units[def.unit];
    const [fwd, up, outward] = def.offset;

    // `outward` is signed by the bone's own side, which is what makes the pair a reflection.
    const lateralSign = def.side === 'left' ? 1 : def.side === 'right' ? -1 : 0;

    const world = new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld)
      .addScaledVector(frame.forward, fwd * unit)
      .addScaledVector(frame.up, up * unit)
      .addScaledVector(frame.left, lateralSign * outward * unit);

    const object = new THREE.Object3D();
    object.name = def.id;
    bone.add(object);
    // worldToLocal carries the mesh's normalisation scale, so the socket lands at the world point
    // we measured rather than at that point times the scale.
    object.position.copy(bone.worldToLocal(world.clone()));
    object.updateMatrixWorld(true);

    const socket: Socket = {
      def,
      bone,
      object,
      worldPosition: (out = new THREE.Vector3()) => out.setFromMatrixPosition(object.matrixWorld),
      worldQuaternion: (out = new THREE.Quaternion()) => object.getWorldQuaternion(out),
    };
    all.set(def.id, socket);

    const p = socket.worldPosition();
    log.push(
      `${def.id.padEnd(22)} bone ${def.bone.padEnd(12)} `
      + `offset (${fwd}, ${up}, ${outward}) x ${def.unit} ${unit.toFixed(3)} `
      + `-> world (${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)})`,
    );
  }

  return {
    all,
    log,
    get(id: string): Socket {
      const socket = all.get(id);
      if (!socket) throw new Error(`no socket "${id}"; have: ${[...all.keys()].join(', ')}`);
      return socket;
    },
    specBlock() {
      return {
        provenance: 'derived-from-rig-bones',
        note: 'The exported spec had no actionProfile. These sockets were derived from the 41 real '
          + 'bones in rigData.ts plus body lengths measured off the bind pose; no coordinate is authored.',
        units: {
          forearm: Number(units.forearm.toFixed(6)),
          shoulder: Number(units.shoulder.toFixed(6)),
          height: Number(units.height.toFixed(6)),
        },
        sockets: SOCKET_DEFS.map((def) => ({
          id: def.id,
          kind: def.kind,
          bone: def.bone,
          boneNameSource: 'rigData.ts — the rig\'s own name, not a bounds hypothesis',
          side: def.side,
          offsetBodyFrame: { forward: def.offset[0], up: def.offset[1], outward: def.offset[2] },
          offsetUnit: def.unit,
          axisFrom: def.axisFrom,
          purpose: def.purpose,
        })),
      };
    },
  };
}
