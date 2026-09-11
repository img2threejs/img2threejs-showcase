import * as THREE from 'three';
import { cellIntersects } from './grootStreaming';
interface GroundSpan {key:string;cx:number;cz:number;offset:number;source:THREE.BufferGeometry;}
interface GroundBucket {mesh:THREE.Mesh;spans:Map<string,GroundSpan>;vertices:number;indices:number;}
/** Fixed 4x4 (12H) ground pages. Every tile keeps its own vertex AND index span. Retiring
 * a tile clears only its indices; unused vertices cannot render or raycast. */
export class GrootGroundBatches {
  readonly cellSide=4;
  readonly buckets=new Map<string,GroundBucket>();
  constructor(private readonly parent:THREE.Group,private readonly material:THREE.Material|THREE.Material[]){}
  attach(cx:number,cz:number,source:THREE.BufferGeometry){
    const side=this.cellSide,bx=Math.floor(cx/side),bz=Math.floor(cz/side),key=`${bx}:${bz}`,cell=`${cx}:${cz}`,offset=(cz-bz*side)*side+cx-bx*side;
    let bucket=this.buckets.get(key);
    if(!bucket){
      const geometry=new THREE.BufferGeometry(),vertices=source.attributes.position.count,indices=source.index!.count;
      for(const [name,attribute] of Object.entries(source.attributes))geometry.setAttribute(name,new THREE.BufferAttribute(new Float32Array(attribute.array.length*side*side),attribute.itemSize).setUsage(THREE.DynamicDrawUsage));
      geometry.setIndex(new THREE.BufferAttribute(new Uint16Array(indices*side*side),1).setUsage(THREE.DynamicDrawUsage));
      const mesh=new THREE.Mesh(geometry,this.material);mesh.name='layered-forest-earth-bucket';mesh.receiveShadow=true;
      mesh.userData.streamBucket={x:bx,z:bz,sizeH:side*3};bucket={mesh,spans:new Map(),vertices,indices};this.buckets.set(key,bucket);this.parent.add(mesh);
    }
    if(bucket.spans.has(cell))throw new Error('Duplicate ground span');
    const span:GroundSpan={key:cell,cx,cz,offset,source};bucket.spans.set(cell,span);
    let bytes=0;for(const [name,attribute] of Object.entries(source.attributes)){
      const target=bucket.mesh.geometry.getAttribute(name) as THREE.BufferAttribute,start=offset*attribute.array.length;
      target.array.set(attribute.array,start);target.addUpdateRange(start,attribute.array.length);target.needsUpdate=true;bytes+=attribute.array.byteLength;
    }
    const index=bucket.mesh.geometry.index!,start=offset*bucket.indices;
    for(let i=0;i<bucket.indices;i++)index.array[start+i]=source.index!.array[i]+offset*bucket.vertices;
    index.addUpdateRange(start,bucket.indices);index.needsUpdate=true;bytes+=bucket.indices*2;this.refresh(bucket);
    const extraBuffers=[...Object.values(bucket.mesh.geometry.attributes) as THREE.BufferAttribute[],index];
    return {mesh:bucket.mesh,bytes,extraBuffers,dispose:()=>{
      bucket!.spans.delete(cell);
      if(!bucket!.spans.size){bucket!.mesh.removeFromParent();bucket!.mesh.geometry.dispose();this.buckets.delete(key);return;}
      index.array.fill(0,start,start+bucket!.indices);index.addUpdateRange(start,bucket!.indices);index.needsUpdate=true;this.refresh(bucket!);
    }};
  }
  private refresh(bucket:GroundBucket):void {
    const geometry=bucket.mesh.geometry,box=geometry.boundingBox??new THREE.Box3();box.makeEmpty();let end=0;
    for(const span of bucket.spans.values()){box.union(span.source.boundingBox!);end=Math.max(end,(span.offset+1)*bucket.indices);}
    geometry.boundingBox=box;geometry.boundingSphere=box.getBoundingSphere(geometry.boundingSphere??new THREE.Sphere());geometry.setDrawRange(0,end);
    bucket.mesh.userData.streamSpans=[...bucket.spans.values()].map(s=>({key:s.key,offset:s.offset*bucket.indices,count:bucket.indices,vertexOffset:s.offset*bucket.vertices,vertexCount:bucket.vertices}));
  }
  setVisible(x:number,z:number,r:number):void {for(const b of this.buckets.values()){b.mesh.visible=false;for(const span of b.spans.values())if(cellIntersects(span.cx,span.cz,x,z,r)){b.mesh.visible=true;break;}}}
  dispose():void {for(const b of this.buckets.values()){b.mesh.removeFromParent();b.mesh.geometry.dispose();}this.buckets.clear();}
}
