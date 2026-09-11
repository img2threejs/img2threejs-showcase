import type * as THREE from 'three';
import type { DecodedPart } from './meshCodec';
import type { MonsterTreeRig } from './rig';
export type SourceJoint=[name:string,parent:number,position:[number,number,number]];
/** Only the shared source-mesh lifecycle; calibration remains source-owned. */
export interface GrootSourceProfile {
 id:'ice'|'bloom'; parts:number; joints:SourceJoint[];
 load():Promise<DecodedPart[]>;
 reference(rig:MonsterTreeRig):Map<THREE.Object3D,THREE.Matrix4>;
 weights(position:Float32Array,index:Uint32Array,indices:Uint16Array,weights:Float32Array):void;
}
