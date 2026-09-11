import * as THREE from 'three';
import { decodeModel, type DecodedPart } from './meshCodec';
import type { GrootSourceProfile, SourceJoint } from './grootSourceProfile';
import { iceNeckField } from './grootIceNeckField';

// Independent measurements: .964 tall, +X face/toes, +Z anatomical right.
// T-pose elbows/wrists run laterally, not down the Abies y-coordinate field.
const joints:SourceJoint[]=[
 ['Hip',-1,[0,.46,0]],['Spine01',0,[0,.535,0]],['Spine02',1,[0,.635,0]],['Head',2,[.018,.755,0]],
 ['L_Upperarm',2,[0,.68,-.12]],['L_Forearm',4,[0,.677,-.275]],['L_Hand',5,[.005,.669,-.425]],
 ['R_Upperarm',2,[0,.68,.12]],['R_Forearm',7,[0,.677,.275]],['R_Hand',8,[.005,.669,.425]],
 ['L_Thigh',0,[0,.455,-.057]],['L_Calf',10,[.008,.265,-.075]],['L_Foot',11,[0,.055,-.093]],['L_ToeBase',12,[.057,.025,-.093]],
 ['R_Thigh',0,[0,.455,.057]],['R_Calf',14,[.008,.265,.075]],['R_Foot',15,[0,.055,.093]],['R_ToeBase',16,[.057,.025,.093]],
];
let payload:Promise<DecodedPart[]>|undefined;
let importFailed=false;
async function loadIce():Promise<DecodedPart[]>{
 try{
  if(!importFailed){const d=await import('./ice-source/surfaceData.high');return decodeModel(d.SURFACE_MODEL,d.SURFACE_STREAM);}
  // Failed ES module requests remain cached by browsers. A data-only fetch can genuinely
  // retry, without eval, extra skeletons, or a cache-busting series of retained modules.
  const response=await fetch(new URL('./ice-source/surfaceData.high.retry.json',import.meta.url),{cache:'no-store'});
  if(!response.ok)throw new Error(`Ice source retry: HTTP ${response.status}`);
  const d=await response.json();return decodeModel(d.model,d.stream);
 }catch(error){importFailed=true;payload=undefined;throw error;}
}
export const ICE_PROFILE:GrootSourceProfile={
 id:'ice',parts:33,joints,
 load:()=>payload??=loadIce(),
 // Complete authored bind frames carry all roll axes. Never infer a shortest-arc arm
 // swing from an idle stance or borrow Abies' arms-down animation reference.
 reference(rig){
  const root=rig.group.getObjectByName('monster-tree-skin-root')!;root.updateMatrix();
  return new Map(rig.skeleton.bones.map((b,i)=>[b,root.matrix.clone().multiply(rig.skeleton.boneInverses[i].clone().invert())]));
 },
 weights(position,index,si,sw){
  const neck=iceNeckField(position,index);
  const smooth=THREE.MathUtils.smoothstep,scores=new Float64Array(18),nearest=new Int32Array(4);
  // Spatial fields are smooth and position-only: every quantized seam duplicate gets
  // bit-identical weights without touching the source render topology or normals.
  for(let v=0;v<position.length/3;v++){
   const x=position[v*3],y=position[v*3+1],z=position[v*3+2],az=Math.abs(z);
   scores.fill(0);
   // Long hanging wrist icicles are hand-owned even below the elbow height.
   // Lateral separation distinguishes them from the hips, not a global y cutoff.
   const arm=smooth(az,.085,.175)*Math.max(smooth(y,.49,.60),smooth(az,.16,.20)*smooth(y,.40,.50))*(1-smooth(y,.69,.77));
   const lateral=smooth(z,-.025,.025),fore=smooth(az,.235,.305),hand=smooth(az,.397,.441);
   for(const [base,across] of [[4,1-lateral],[7,lateral]]){
    scores[base]=arm*across*(1-fore);scores[base+1]=arm*across*fore*(1-hand);scores[base+2]=arm*across*fore*hand;
   }
   const lower=(1-arm)*(1-smooth(y,.415,.485));
   // Separate lower legs do not share the torso's broad lateral blend across empty air.
   const legWidth=.002+.023*smooth(y,.30,.40),legRight=smooth(z,-legWidth,legWidth);
   for(const [base,across] of [[10,1-legRight],[14,legRight]]){
    const thigh=smooth(y,.23,.30),foot=1-smooth(y,.045,.105),toe=smooth(x,.025,.07);
    scores[base]=lower*across*thigh;scores[base+1]=lower*across*(1-thigh)*(1-foot);
    scores[base+2]=lower*across*(1-thigh)*foot*(1-toe);scores[base+3]=lower*across*(1-thigh)*foot*toe;
   }
   // Branching shoulder crown stays chest-owned outside the central skull/neck.
   const head=neck[v],body=1-arm-lower;
   const chest=smooth(y,.53,.625),waist=smooth(y,.46,.535);
   scores[3]=body*head;scores[2]=body*(1-head)*chest;scores[1]=body*(1-head)*(1-chest)*waist;scores[0]=body*(1-head)*(1-chest)*(1-waist);
   nearest.fill(-1);for(let j=0;j<18;j++)for(let k=0;k<4;k++)if(nearest[k]<0||scores[j]>scores[nearest[k]]){for(let t=3;t>k;t--)nearest[t]=nearest[t-1];nearest[k]=j;break;}
   let total=0;for(const j of nearest)total+=scores[j];for(let k=0;k<4;k++){si[v*4+k]=nearest[k];sw[v*4+k]=scores[nearest[k]]/total;}
  }
 },
};
