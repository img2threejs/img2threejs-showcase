import * as THREE from 'three';
import { GROOT_FBX_DATA as ORIGINAL_FBX_DATA } from './grootFbxData';
import { GROOT_FBX_V2_DATA } from './grootFbxV2Data';
import type { GrootAction, GrootEvent, GrootSwingMeasure, ImpactKind } from './grootAnimation';
import type { MonsterTreeRig } from './rig';

export const GROOT_FBX_DATA={...ORIGINAL_FBX_DATA,...GROOT_FBX_V2_DATA};
export const isV2=(id:string):boolean=>!!GROOT_FBX_V2_DATA[id];
/** The second spellbook is animation-only, including its retained original roar. */
export const isB2=(id:string):boolean=>id==='forest-roar'||isV2(id);
export const entryTime=.5;
export const clipEntry=(id:string):number=>id==='forest-jump'?.34:entryTime;
export const exitTime=(id:string):number=>id==='husk-rebirth'||id==='last-stand'?1.8:isV2(id)?1:id==='forest-jump'?.32:id==='forest-dance'||id==='root-charge'?1.1:.65;
const decode=(text:string):Float32Array=>{const bytes=Uint8Array.from(atob(text),c=>c.charCodeAt(0));return new Float32Array(bytes.buffer);};
const smooth=(v:number):number=>{const t=THREE.MathUtils.clamp(v,0,1);return t*t*t*(t*(t*6-15)+10);};

/** Pads are explicit transitions; the inner motion comes from the supplied FBX, not a pose preset. */
export function importedClip(spec:GrootAction,baseline:THREE.AnimationClip,rig:MonsterTreeRig,height:number):THREE.AnimationClip {
  const data=GROOT_FBX_DATA[spec.id],count=Math.ceil(spec.duration*60),times=new Float32Array(count+1);
  const entry=clipEntry(spec.id);
  const sourceTimes=Float32Array.from({length:data.frames},(_,i)=>i/(data.frames-1)*data.duration);
  if(data.gait){
    // A cyclic locomotion clip must not blend through idle at each stride.
    return new THREE.AnimationClip(`groot:${spec.id}`,data.duration,baseline.tracks.map((ref,n)=>ref.name.endsWith('.quaternion')
      ?new THREE.QuaternionKeyframeTrack(ref.name,sourceTimes,decode(data.rotations[n]))
      :new THREE.VectorKeyframeTrack(ref.name,sourceTimes,decode(data.positions))));
  }
  const tracks:THREE.KeyframeTrack[]=[];
  for(let n=0;n<baseline.tracks.length;n++){
    const ref=baseline.tracks[n],quaternion=ref.name.endsWith('.quaternion'),size=quaternion?4:3;
    const source=quaternion?decode(data.rotations[n]):decode(data.positions),target=new Float32Array((count+1)*size);
    const track=quaternion?new THREE.QuaternionKeyframeTrack(ref.name,sourceTimes,source):new THREE.VectorKeyframeTrack(ref.name,sourceTimes,source);
    const idle=GROOT_FBX_DATA['grove-idle'],rest=quaternion?decode(idle.rotations[n]):decode(idle.positions);
    const interpolant=track.createInterpolant(),q=new THREE.Quaternion(),base=new THREE.Quaternion().fromArray(rest);
    for(let f=0;f<=count;f++){
      const t=f/count*spec.duration;times[f]=t;
      const value=interpolant.evaluate(THREE.MathUtils.clamp(t-entry,0,data.duration));
      const weight=t<entry?smooth(t/entry):1-smooth((t-entry-data.duration)/exitTime(spec.id));
      if(quaternion){q.fromArray(value).normalize();base.fromArray(rest).slerp(q,weight).normalize().toArray(target,f*4);}
      else for(let k=0;k<3;k++)target[f*3+k]=rest[k]+(value[k]-rest[k])*weight;
    }
    tracks.push(quaternion?new THREE.QuaternionKeyframeTrack(ref.name,times,target):new THREE.VectorKeyframeTrack(ref.name,times,target));
  }
  const clip=new THREE.AnimationClip(`groot:${spec.id}`,spec.duration,tracks);
  if(spec.id==='forest-dance'||isV2(spec.id)){
    // The FBX ends in a low freeze. The added stand-up transition needs its own skinned-surface
    // clearance sweep; safe endpoints alone do not keep an interpolated crown above the floor.
    rig.mixer.stopAllAction();const action=rig.mixer.clipAction(clip).setLoop(THREE.LoopOnce,1).play();action.clampWhenFinished=true;
    const p=new THREE.Vector3(),parent=new THREE.Quaternion(),scale=rig.bones.Hip.parent!.getWorldScale(new THREE.Vector3()).y;
    const surface=rig.shell.geometry.getAttribute('position'),lift=new Float32Array(times.length);
    for(let f=0;f<times.length;f++){
      action.time=times[f];rig.mixer.update(0);rig.group.updateMatrixWorld(true);let low=Infinity;
      for(let v=0;v<surface.count;v+=13){p.fromBufferAttribute(surface,v);rig.shell.applyBoneTransform(v,p);p.applyMatrix4(rig.shell.matrixWorld);low=Math.min(low,p.y);}
      lift[f]=Math.max(0,height*.01-low);
    }
    action.stop();const positionTrack=tracks[tracks.length-1];
    rig.bones.Hip.parent!.getWorldQuaternion(parent).invert();
    for(let f=0;f<times.length;f++){
      let rise=lift[f];for(let j=-3;j<=3;j++)rise=Math.max(rise,lift[THREE.MathUtils.clamp(f+j,0,lift.length-1)]*(1-Math.abs(j)*.12));
      p.set(0,rise,0).applyQuaternion(parent).divideScalar(scale);
      for(let k=0;k<3;k++)positionTrack.values[f*3+k]+=p.getComponent(k);
    }
  }
  return clip;
}

/** Offline-in-construction sweep. Search all FBX samples, never an authored normalized time band. */
export function importedEvents(spec:GrootAction,samples:THREE.Vector3[][]):{events:GrootEvent[];footDriftH:number;sourceFile:string;effect:string;contactSamples:number;swing?:GrootSwingMeasure} {
  const data=GROOT_FBX_DATA[spec.id],count=samples.length-1,dt=spec.duration/count;
  const entry=clipEntry(spec.id),start=Math.max(2,Math.ceil(entry/dt)),end=Math.min(count-2,Math.floor((entry+data.duration)/dt));
  const kind=(data.gait?'idle':spec.id==='vine-sweep'?'seismic':data.kind==='jump'?'ground':data.kind) as ImpactKind|'idle',events:GrootEvent[]=[];
  if(isV2(spec.id)){
    const names=['L_Digit3_3','R_Digit3_3','L_Foot','R_Foot','Spine02','Head'];
    const add=(at:number,bone:number)=>events.push({time:at*dt,kind:'freeze',bone:names[bone],pointH:samples[at][bone].toArray(),speedH:samples[at][bone].distanceTo(samples[at-1][bone])/dt,hold:0});
    let at=start,bone=4,best=-Infinity;
    if(data.kind==='comet'){
      let apex=start,floor=Infinity;const low=(i:number)=>Math.min(samples[i][2].y,samples[i][3].y);
      for(let i=start;i<=end;i++){if(low(i)>low(apex))apex=i;floor=Math.min(floor,low(i));}
      at=end;for(let i=apex+1;i<=end;i++)if(low(i)<floor+.035){at=i;break;}bone=samples[at][2].y<samples[at][3].y?2:3;
      add(apex,4);add(at,bone);
    }else if(data.kind==='rebirth'||data.kind==='laststand'){
      // Measure descent and first low-body arrival, not a late almost-still minimum in the
      // fallen hold. Keep these source-derived landmarks for timing and pose review.
      let floor=Infinity;for(let i=start;i<=end;i++)floor=Math.min(floor,samples[i][4].y);
      let descent=start,contact=end;for(let i=start;i<=end;i++)if(samples[i][4].y<samples[start][4].y-.06){descent=i;break;}
      for(let i=descent;i<=end;i++)if(samples[i][4].y<=floor+.025){contact=i;break;}
      add(descent,4);add(contact,4);
    }else if(data.kind==='tempest'){
      // Local downward foot arrivals generate real rhythmic beats; enforce .28s separation.
      let last=-Infinity;for(let i=start+2;i<end-2;i++)for(const foot of [2,3])if(i*dt-last>.28&&samples[i][foot].y<samples[i-2][foot].y&&samples[i][foot].y<=samples[i+2][foot].y){add(i,foot);last=i*dt;}
      if(!events.length)add(start,2);
    }else{
      const choices=data.kind==='crescent'||data.kind==='wedge'?[2,3]:[0,1];
      for(let i=start+4;i<=end-4;i++)for(const joint of choices){
        const p=samples[i][joint],chest=samples[i][4];
        const score=data.kind==='crescent'?p.y-chest.y:data.kind==='wedge'?p.x-chest.x:data.kind==='petals'?p.y:p.distanceTo(chest);
        if(score>best){best=score;at=i;bone=joint;}
      }add(at,bone);
    }
    return {events,footDriftH:0,contactSamples:0,sourceFile:`v2/${data.file}`,effect:''};
  }
  let bone=1,at=start,best=-Infinity,apex=start,lift=0;
  const footHeight=(i:number)=>Math.min(samples[i][2].y,samples[i][3].y);
  for(let i=start;i<=end;i++)if(footHeight(i)>footHeight(apex))apex=i;
  let floor=Infinity;for(let i=start;i<=end;i++)floor=Math.min(floor,footHeight(i));lift=footHeight(apex)-floor;
  if(kind==='ground'&&lift>.08){
    bone=samples[apex][2].y<samples[apex][3].y?2:3;
    at=apex;
    for(let i=apex;i<=end;i++)if(footHeight(i)<floor+.018){at=i;bone=samples[i][2].y<samples[i][3].y?2:3;break;}
  }else if(kind!=='idle'){
    for(let i=start;i<=end;i++){
      // Stationary area casts deliver force through the casting arm; only an actual airborne
      // clip uses foot contact above. The lowered recovery guard is not a ground impact.
      for(const hand of kind==='roar'?[4]:kind==='ground'?[1]:[0,1]){
        const p=samples[i][hand],chest=samples[i][4],before=samples[Math.max(start,i-6)][hand];
        const arrest=before.distanceTo(p)/(.05+dt);
        const value=kind==='freeze'?-p.y:kind==='gather'?-samples[i][0].distanceTo(samples[i][1]):kind==='heal'||kind==='bloom'||kind==='shield'?p.y:kind==='roar'?samples[i][0].distanceTo(samples[i][1]):p.x-chest.x;
        // For equal extension choose the arrival at the hold, not its last still frame.
        const score=value+Math.min(.008,arrest*.001);
        if(score>best){best=score;at=i;bone=hand;}
      }
    }
  }
  if(kind!=='idle'){
    const names=['L_Digit3_3','R_Digit3_3','L_Foot','R_Foot','Spine02','Head'];
    events.push({time:at*dt,kind,bone:names[bone],pointH:samples[at][bone].toArray(),speedH:samples[at][bone].distanceTo(samples[at-1][bone])/dt,hold:kind==='ground'||kind==='seismic'?.07:kind==='pierce'||kind==='sweep'?.05:kind==='roar'?.04:0});
  }
  let drift=0,contactSamples=0;
  for(const contact of data.contacts){
    const pad=data.gait?0:entry,foot=contact.foot==='L_Foot'?2:3,from=Math.ceil((contact.start+pad)/dt),to=Math.floor((contact.end+pad)/dt);
    for(let i=from;i<=to;i++){
      const delta=samples[i][foot].clone().sub(samples[from][foot]);
      if(data.gait)delta.x+=data.gait.speedH*(i-from)*dt;
      drift=Math.max(drift,delta.length());contactSamples++;
    }
  }
  let swing:GrootSwingMeasure|undefined;
  if(spec.id==='root-charge'){
    // The grip sockets are palm-side digit bases, not fingertip extrema. Find the compact
    // two-hand hold, then its first opening. This is sampled once, never a live release test.
    let closest=start;
    for(let i=start;i<at;i++)if(samples[i][6].distanceTo(samples[i][7])<samples[closest][6].distanceTo(samples[closest][7]))closest=i;
    const gap=samples[closest][6].distanceTo(samples[closest][7]);
    let grip=closest,release=closest;
    for(let i=1;i<=closest;i++)if(samples[i][6].y>samples[i][5].y+.035){grip=i;break;}
    for(let i=closest+1;i<at;i++)if(samples[i][6].distanceTo(samples[i][7])>Math.max(.14,gap*2)){release=i;break;}
    if(release>grip){
      const before=Math.max(grip,release-4),velocity=samples[release][6].clone().sub(samples[before][6]).divideScalar((release-before)*dt);
      swing={gripTime:grip*dt,releaseTime:release*dt,gripPointH:samples[grip][6].toArray(),releasePointH:samples[release][6].toArray(),releaseVelocityH:velocity.toArray(),minimumHandGapH:gap};
    }
  }
  return {events,footDriftH:drift,sourceFile:data.file,effect:spec.id==='vine-sweep'?'seismic':data.kind,contactSamples,swing};
}
