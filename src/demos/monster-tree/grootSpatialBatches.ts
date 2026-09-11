import * as THREE from 'three';
import { cellIntersects } from './grootStreaming';

export interface InstanceSpan {
  key:string;cx:number;cz:number;offset:number;capacity:number;count:number;
  source:THREE.InstancedMesh;mesh:THREE.InstancedMesh;
}
interface Bucket {key:string;mesh:THREE.InstancedMesh;spans:Map<string,InstanceSpan>;capacity:number;}
/** Dense records within one small spatial bucket; no source regeneration or global
 * repacking. Arrival appends. Count changes/retirement relocate only the following
 * allocations in THIS bucket. Relocated cells are explicitly changed GPU spans.
 * Unused capacity is never drawn; retired trailing records are cleared as well. */
export class GrootSpatialBatches {
  readonly cellSide=2;
  readonly buckets=new Map<string,Bucket>();
  private readonly byMesh=new WeakMap<THREE.InstancedMesh,Bucket>();
  readonly stats={copies:0,copiedBytes:0,retiredBytes:0,relocatedCells:0,relocatedBytes:0,created:0,released:0,peak:0};
  constructor(private readonly parent:THREE.Group){}
  attach(cx:number,cz:number,source:THREE.InstancedMesh):InstanceSpan|undefined {
    if(!source.count)return;
    if(Array.isArray(source.material)||source.material.transparent)throw new Error('Only compatible opaque instances may batch');
    const side=this.cellSide,bx=Math.floor(cx/side),bz=Math.floor(cz/side),capacity=source.instanceMatrix.count;
    const key=`${bx}:${bz}:${source.geometry.uuid}:${source.material.uuid}:${source.castShadow}:${source.receiveShadow}:${capacity}:${!!source.instanceColor}`;
    let bucket=this.buckets.get(key);
    if(!bucket){
      const mesh=new THREE.InstancedMesh(source.geometry,source.material,capacity*side*side);
      mesh.name=source.name;mesh.castShadow=source.castShadow;mesh.receiveShadow=source.receiveShadow;
      mesh.instanceMatrix.array.fill(0);mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);mesh.count=0;
      if(source.instanceColor)mesh.instanceColor=new THREE.InstancedBufferAttribute(new Float32Array(capacity*side*side*3),3).setUsage(THREE.DynamicDrawUsage);
      mesh.userData.streamBucket={x:bx,z:bz,sizeH:side*3,dense:true};mesh.userData.streamSpans=[];
      bucket={key,mesh,spans:new Map(),capacity};this.buckets.set(key,bucket);this.byMesh.set(mesh,bucket);this.parent.add(mesh);this.stats.created++;
      this.stats.peak=Math.max(this.stats.peak,this.buckets.size);
    }
    const cell=`${cx}:${cz}`;
    if(bucket.spans.has(cell)||bucket.spans.size>=side*side)throw new Error('Duplicate or overflowing cell bucket');
    const span:InstanceSpan={key:cell,cx,cz,offset:bucket.mesh.count,capacity,count:0,source,mesh:bucket.mesh};
    bucket.spans.set(cell,span);this.copy(span);return span;
  }
  copy(span:InstanceSpan):number {
    const bytes=this.resize(span,span.source.count,true);this.stats.copies++;this.stats.copiedBytes+=bytes;return bytes;
  }
  private resize(span:InstanceSpan,count:number,writeSource:boolean):number {
    const {mesh,source,offset}=span,bucket=this.byMesh.get(mesh)!,oldTotal=mesh.count,oldEnd=offset+span.count,delta=count-span.count,newTotal=oldTotal+delta;
    if(count>span.capacity||newTotal>mesh.instanceMatrix.count)throw new Error('Dense instance capacity exceeded');
    let bytes=0;
    for(const [attribute,from,size] of [[mesh.instanceMatrix,source.instanceMatrix,16],[mesh.instanceColor,source.instanceColor,3]] as const){
      if(!attribute||!from)continue;
      if(delta&&oldEnd<oldTotal){attribute.array.copyWithin((oldEnd+delta)*size,oldEnd*size,oldTotal*size);this.stats.relocatedBytes+=(oldTotal-oldEnd)*size*attribute.array.BYTES_PER_ELEMENT;}
      if(writeSource)attribute.array.set(from.array.subarray(0,count*size),offset*size);
      if(delta<0)attribute.array.fill(0,newTotal*size,oldTotal*size);
      // Same-size edits touch only the source span; resize touches its local suffix,
      // including cleared retired tail. Prefix and all other buckets remain untouched.
      const length=(delta?Math.max(oldTotal,newTotal)-offset:count)*size;
      if(length){attribute.addUpdateRange(offset*size,length);attribute.needsUpdate=true;bytes+=length*attribute.array.BYTES_PER_ELEMENT;}
    }
    if(delta)for(const other of bucket.spans.values())if(other!==span&&other.offset>=oldEnd){other.offset+=delta;this.stats.relocatedCells++;}
    span.count=count;mesh.count=newTotal;this.refresh(bucket);return bytes;
  }
  detach(span:InstanceSpan):void {
    const bucket=this.byMesh.get(span.mesh);if(!bucket||!bucket.spans.delete(span.key))return;
    if(!bucket.spans.size){bucket.mesh.removeFromParent();bucket.mesh.dispose();this.buckets.delete(bucket.key);this.byMesh.delete(bucket.mesh);this.stats.released++;return;}
    this.stats.retiredBytes+=this.resize(span,0,false);
  }
  private refresh(bucket:Bucket):void {
    const {mesh,spans}=bucket,box=mesh.boundingBox??new THREE.Box3();box.makeEmpty();
    for(const span of spans.values())if(span.source.boundingBox)box.union(span.source.boundingBox);
    // Source bounds include .7H for wind, root fitting and tree-hit deformation.
    mesh.boundingBox=box;mesh.boundingSphere=box.getBoundingSphere(mesh.boundingSphere??new THREE.Sphere());
    mesh.userData.streamSpans=[...spans.values()].map(s=>({key:s.key,offset:s.offset,capacity:s.capacity,count:s.count}));
  }
  setVisible(x:number,z:number,r:number):void {
    for(const {mesh,spans} of this.buckets.values()){
      const meadow=['world-meadow-grass','world-fallen-leaves','world-moss-stones'].includes(mesh.name);
      mesh.visible=false;for(const s of spans.values())if(cellIntersects(s.cx,s.cz,x,z,meadow?Math.min(12,r):r,meadow?1:3)){mesh.visible=true;break;}
    }
  }
  dispose():void {for(const bucket of this.buckets.values()){bucket.mesh.removeFromParent();bucket.mesh.dispose();this.byMesh.delete(bucket.mesh);this.stats.released++;}this.buckets.clear();}
}
