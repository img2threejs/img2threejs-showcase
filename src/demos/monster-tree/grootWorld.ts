import * as THREE from 'three';
import { inRiverH, riverDistanceH, riverWidthH, RIVER_LEVEL_H } from './grootRiverPath';

export const GROOT_WORLD_RADIUS_H=60;
export const TREE_CELL_H=3;
export const forestHash=(x:number,z:number,salt=0):number=>{const n=Math.sin(x*127.1+z*311.7+salt*74.7)*43758.5453;return n-Math.floor(n);};
/** Shared analytic earth; never depends on render residency. Coordinates here are in H. */
export function forestHeightH(x:number,z:number):number{
  const fade=THREE.MathUtils.smoothstep(Math.hypot(x,z),2.4,7);
  const base=fade*(.24*Math.sin(x*.23)*Math.cos(z*.19)+.12*Math.sin(x*.51+z*.29)+.055*Math.sin(z*1.1-x*.7));
  if(Math.abs(x)>=34)return base;
  const width=riverWidthH(x),d=riverDistanceH(x,z);
  const bed=RIVER_LEVEL_H-.20+.29*THREE.MathUtils.smoothstep(d,width*.45,width+ .20);
  return THREE.MathUtils.lerp(bed,base,THREE.MathUtils.smoothstep(d,width+.2,width+1.2));
}
export function forestGround(x:number,z:number,height:number):number{return forestHeightH(x/height,z/height)*height;}
export interface TreeCollider {readonly x:number;readonly z:number;readonly radius:number;}
export interface WorldTree extends TreeCollider {
  readonly id:string;readonly kind:'cell'|'grove';
  readonly cellX:number;readonly cellZ:number;
  /** Absolute transforms in H, matching the original global instance window. */
  readonly xH:number;readonly zH:number;readonly yH:number;readonly size:number;readonly yaw:number;
}
export interface TreeQuery {queryRadius(x:number,z:number,radius:number):readonly TreeCollider[];}
export type TreePlacementSource=TreeQuery|readonly TreeCollider[];
export function placementTrees(source:TreePlacementSource,x:number,z:number,radius:number):readonly TreeCollider[]{
  return 'queryRadius' in source?source.queryRadius(x,z,radius):source;
}
/** No meshes, async jobs or full-world retained records. Missing cells compute immediately.
 * Grove registration occurs only AFTER its seeded geometry constructor finishes consuming RNG.
 */
export class GrootWorld implements TreeQuery {
  private grove:readonly WorldTree[]=[];
  private groveReady=false;
  private maxRadius:number;
  constructor(readonly height:number){this.maxRadius=1.55*.17*height;}
  registerGrove(trees:readonly TreeCollider[]):void{
    if(this.groveReady)throw new Error('Grove descriptors already registered');
    this.grove=Object.freeze(trees.map((t,i)=>Object.freeze({...t,id:`grove:${i}`,kind:'grove' as const,cellX:Math.floor(t.x/this.height/3),cellZ:Math.floor(t.z/this.height/3),xH:t.x/this.height,zH:t.z/this.height,yH:forestHeightH(t.x/this.height,t.z/this.height),size:1,yaw:0})));
    for(const t of this.grove)this.maxRadius=Math.max(this.maxRadius,t.radius);
    this.groveReady=true;
  }
  treeCell(gx:number,gz:number):WorldTree|null{
    if(!Number.isInteger(gx)||!Number.isInteger(gz))throw new Error('Tree cells require integer coordinates');
    const xH=gx*3+forestHash(gx,gz)*2.3,zH=gz*3+forestHash(gx,gz,1)*2.3,d=Math.hypot(xH,zH);
    if(d<3.2||d>GROOT_WORLD_RADIUS_H+2||inRiverH(xH,zH,.6))return null;
    const size=.7+forestHash(gx,gz,2)*.85;
    return Object.freeze({id:`cell:${gx}:${gz}`,kind:'cell',cellX:gx,cellZ:gz,xH,zH,yH:forestHeightH(xH,zH),size,yaw:forestHash(gx,gz,3)*6.28,x:xH*this.height,z:zH*this.height,radius:size*.17*this.height});
  }
  /** World-unit candidate area, including trunks whose radius overlaps the rectangle. */
  queryArea(minX:number,minZ:number,maxX:number,maxZ:number):WorldTree[]{
    if(![minX,minZ,maxX,maxZ].every(Number.isFinite)||minX>maxX||minZ>maxZ)throw new Error('Invalid tree query area');
    const h=this.height,p=this.maxRadius,edge=GROOT_WORLD_RADIUS_H+2,result:WorldTree[]=[];
    const overlaps=(t:WorldTree)=>t.x+t.radius>=minX&&t.x-t.radius<=maxX&&t.z+t.radius>=minZ&&t.z-t.radius<=maxZ;
    const loX=Math.max(-21,Math.floor((minX-p)/h/3)),hiX=Math.min(Math.floor(edge/3),Math.floor((maxX+p)/h/3));
    const loZ=Math.max(-21,Math.floor((minZ-p)/h/3)),hiZ=Math.min(Math.floor(edge/3),Math.floor((maxZ+p)/h/3));
    for(let z=loZ;z<=hiZ;z++)for(let x=loX;x<=hiX;x++){const t=this.treeCell(x,z);if(t&&overlaps(t))result.push(t);}
    for(const t of this.grove)if(overlaps(t))result.push(t);
    return result;
  }
  queryRadius(x:number,z:number,radius:number):WorldTree[]{
    return this.queryArea(x-radius,z-radius,x+radius,z+radius).filter(t=>Math.hypot(t.x-x,t.z-z)<=radius+t.radius);
  }
  /** Broad phase only: endpoint pushout can reach an overlapping neighbour. Include the
   * connected inflated-trunk component BEFORE response, then restore legacy traversal order.
   * No position changes, sweep response, depenetration or slide iterations happen here. */
  queryMovement(from:TreePoint,to:TreePoint,radius:number):WorldTree[]{
    const candidates=this.queryArea(Math.min(from.x,to.x)-radius,Math.min(from.z,to.z)-radius,Math.max(from.x,to.x)+radius,Math.max(from.z,to.z)+radius);
    const ids=new Set(candidates.map(t=>t.id));
    for(let i=0;i<candidates.length;i++){
      const tree=candidates[i];
      for(const neighbour of this.queryRadius(tree.x,tree.z,tree.radius+2*radius)){
        if(!ids.has(neighbour.id)){ids.add(neighbour.id);candidates.push(neighbour);}
      }
    }
    return [...candidates.filter(t=>t.kind==='cell').sort((a,b)=>a.cellZ-b.cellZ||a.cellX-b.cellX),...this.grove.filter(t=>ids.has(t.id))];
  }
  querySwept(from:TreePoint,to:TreePoint,radius:number):WorldTree[]{
    const dx=to.x-from.x,dz=to.z-from.z,length=dx*dx+dz*dz;
    return this.queryArea(Math.min(from.x,to.x)-radius,Math.min(from.z,to.z)-radius,Math.max(from.x,to.x)+radius,Math.max(from.z,to.z)+radius).filter(t=>{
      const u=length?THREE.MathUtils.clamp(((t.x-from.x)*dx+(t.z-from.z)*dz)/length,0,1):0;
      return Math.hypot(t.x-from.x-u*dx,t.z-from.z-u*dz)<=radius+t.radius;
    });
  }
}
export interface TreePoint {x:number;z:number;}
