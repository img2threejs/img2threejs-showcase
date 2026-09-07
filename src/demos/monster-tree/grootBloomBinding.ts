import * as THREE from 'three';
import { decodeModel, type DecodedPart } from './meshCodec';
import { bloomAttachmentField } from './grootBloomAttachment';
import type { GrootSourceProfile, SourceJoint } from './grootSourceProfile';

// Bloom archive coordinates: +X face/toes, +Z right, ground 0, crown .950432.
// T-pose shoulder/elbow/wrist landmarks are lateral; no Abies idle/gait/neck field.
const joints:SourceJoint[]=[
 ['Hip',-1,[0,.455,0]],['Spine01',0,[0,.525,0]],['Spine02',1,[0,.61,0]],['Head',2,[.012,.747,0]],
 ['L_Upperarm',2,[0,.65,-.115]],['L_Forearm',4,[0,.645,-.265]],['L_Hand',5,[0,.638,-.412]],
 ['R_Upperarm',2,[0,.65,.115]],['R_Forearm',7,[0,.645,.265]],['R_Hand',8,[0,.638,.412]],
 ['L_Thigh',0,[0,.445,-.055]],['L_Calf',10,[.006,.245,-.075]],['L_Foot',11,[0,.045,-.087]],['L_ToeBase',12,[.055,.02,-.087]],
 ['R_Thigh',0,[0,.445,.055]],['R_Calf',14,[.006,.245,.075]],['R_Foot',15,[0,.045,.087]],['R_ToeBase',16,[.055,.02,.087]],
];
let payload:Promise<DecodedPart[]>|undefined,importFailed=false;
async function load():Promise<DecodedPart[]>{try{
 if(!importFailed){const d=await import('./bloom-source/surfaceData.high');return decodeModel(d.SURFACE_MODEL,d.SURFACE_STREAM);}
 const r=await fetch(new URL('./bloom-source/surfaceData.high.retry.json',import.meta.url),{cache:'no-store'});
 if(!r.ok)throw Error(`Bloom source retry: HTTP ${r.status}`);const d=await r.json();return decodeModel(d.model,d.stream);
}catch(error){importFailed=true;payload=undefined;throw error;}}
export const BLOOM_PROFILE:GrootSourceProfile={id:'bloom',parts:123,joints,load:()=>payload??=load(),
 reference(rig){const root=rig.group.getObjectByName('monster-tree-skin-root')!;root.updateMatrix();return new Map(rig.skeleton.bones.map((b,i)=>[b,root.matrix.clone().multiply(rig.skeleton.boneInverses[i].clone().invert())]));},
 weights(position,index,si,sw){
  // Connected lower-leg islands disambiguate inner vines that cross z=0. Weld only
  // for analysis; retain every supplied render vertex/index/color in the actual mesh.
  const n=position.length/3,parent=Int32Array.from({length:n},(_,i)=>i),points=new Map<string,number>();
  const find=(i:number):number=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
  const union=(a:number,b:number):void=>{parent[find(a)]=find(b);};
  for(let i=0;i<n;i++)if(position[i*3+1]<.38||position[i*3+1]>.70){const key=`${position[i*3]},${position[i*3+1]},${position[i*3+2]}`,other=points.get(key);if(other!==undefined)union(i,other);else points.set(key,i);}
  for(let i=0;i<index.length;i+=3)for(let k=0;k<3;k++){const a=index[i+k],b=index[i+(k+1)%3];if((position[a*3+1]<.38&&position[b*3+1]<.38)||(position[a*3+1]>.70&&position[b*3+1]>.70))union(a,b);}
  const sum=new Float64Array(n),count=new Uint32Array(n);for(let i=0;i<n;i++)if(position[i*3+1]<.38||position[i*3+1]>.70){const root=find(i);sum[root]+=position[i*3+2];count[root]++;}
  const attachmentArm=bloomAttachmentField(position,index,0),attachmentHead=bloomAttachmentField(position,index,1),attachmentFore=bloomAttachmentField(position,index,2);
  const smooth=THREE.MathUtils.smoothstep,scores=new Float64Array(18),nearest=new Int32Array(4);
  for(let v=0;v<position.length/3;v++){
   const y=position[v*3+1],z=position[v*3+2],az=Math.abs(z);scores.fill(0);
   // Shoulder branches remain shoulder-owned; hanging leaves beyond elbow are arm-owned.
   const arm=attachmentArm[v];
   const lateral=smooth(z,-.02,.02),fore=attachmentFore[v],hand=smooth(az,.38,.435);
   for(const [base,across] of [[4,1-lateral],[7,lateral]]){scores[base]=arm*across*(1-fore);scores[base+1]=arm*across*fore*(1-hand);scores[base+2]=arm*across*fore*hand;}
   const lower=(1-arm)*(1-smooth(y,.40,.475)),width=.055,spatial=smooth(z,-width,width),right=y<.38?THREE.MathUtils.lerp(Number(sum[find(v)]/count[find(v)]>0),spatial,smooth(y,.30,.38)):spatial;
   for(const [base,across] of [[10,1-right],[14,right]]){const thigh=smooth(y,.21,.285),foot=1-smooth(y,.035,.095);scores[base]=lower*across*thigh;scores[base+1]=lower*across*(1-thigh)*(1-foot);scores[base+2]=lower*across*(1-thigh)*foot; /* Broad toes stay foot-owned: at most four lower-body influences; no truncation discontinuity. */}
   const body=1-arm-lower,head=attachmentHead[v],chest=smooth(y,.52,.61),waist=smooth(y,.445,.525);
   scores[3]=body*head;scores[2]=body*(1-head)*chest;scores[1]=body*(1-head)*(1-chest)*waist;scores[0]=body*(1-head)*(1-chest)*(1-waist);
   nearest.fill(-1);for(let j=0;j<18;j++)for(let k=0;k<4;k++)if(nearest[k]<0||scores[j]>scores[nearest[k]]){for(let t=3;t>k;t--)nearest[t]=nearest[t-1];nearest[k]=j;break;}
   let total=0;for(const j of nearest)total+=scores[j];for(let k=0;k<4;k++){si[v*4+k]=nearest[k];sw[v*4+k]=scores[nearest[k]]/total;}
  }
 }
};
export const prewarmGrootBloom=():Promise<void>=>BLOOM_PROFILE.load().then(()=>{});
