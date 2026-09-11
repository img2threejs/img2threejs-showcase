import * as THREE from 'three';
import type { MonsterTreeRig } from './rig';
import { directionalSurfaceSupportSamples } from './grootSurfaceSupport';

const ease=(u:number):number=>u*u*u*(10+u*(-15+6*u));
/** A single chosen tangent-space path, not a crossfade against an advancing acrobat.
 * The captured local angular/linear velocity decays with a 50ms time constant; the
 * C2 envelope arrives at the actual idle entry with zero velocity/acceleration.
 * All key storage/support selection is reusable. No live full-surface scan. */
export class GrootRecovery {
 readonly duration=1.1;
 readonly action:THREE.AnimationAction;
 active=false;
 private readonly previous:THREE.Quaternion[];
 private readonly velocity:THREE.Vector3[];
 private readonly previousPosition=new THREE.Vector3();
 private readonly positionVelocity=new THREE.Vector3();
 private readonly q=new THREE.Quaternion();
 private readonly delta=new THREE.Quaternion();
 private readonly vector=new THREE.Vector3();
 private readonly p=new THREE.Vector3();
 private readonly scale=new THREE.Vector3();
 private readonly inverse=new THREE.Matrix4();
 private readonly parentMatrix=new THREE.Matrix4();
 private readonly tracks:THREE.KeyframeTrack[];
 private readonly support:Uint32Array;
 private valid=false;
 constructor(private readonly rig:MonsterTreeRig,private readonly idle:THREE.AnimationClip){
  const times=Float32Array.from({length:133},(_,i)=>i*this.duration/132);
  this.tracks=idle.tracks.map(t=>t.name.endsWith('.quaternion')
   ?new THREE.QuaternionKeyframeTrack(t.name,times,new Float32Array(times.length*4))
   :new THREE.VectorKeyframeTrack(t.name,times,new Float32Array(times.length*3)));
  this.action=rig.mixer.clipAction(new THREE.AnimationClip('groot:captured-recovery',this.duration,this.tracks)).setLoop(THREE.LoopOnce,1);
  this.action.clampWhenFinished=true;
  this.previous=rig.skeleton.bones.map(b=>b.quaternion.clone());this.velocity=this.previous.map(()=>new THREE.Vector3());
  const geo=rig.shell.geometry;
  this.support=directionalSurfaceSupportSamples(geo.attributes.position.array as Float32Array,geo.attributes.skinIndex.array as Uint16Array,rig.skeleton.bones.length,geo.attributes.skinWeight.array as Float32Array);
 }
 private log(q:THREE.Quaternion,out:THREE.Vector3):THREE.Vector3{
  q.normalize();if(q.w<0)q.set(-q.x,-q.y,-q.z,-q.w);
  const length=Math.hypot(q.x,q.y,q.z),angle=2*Math.atan2(length,q.w);
  return out.set(q.x,q.y,q.z).multiplyScalar(length>1e-10?angle/length:2);
 }
 private exp(v:THREE.Vector3,out:THREE.Quaternion):THREE.Quaternion{
  const angle=v.length(),s=angle>1e-10?Math.sin(angle/2)/angle:.5;
  return out.set(v.x*s,v.y*s,v.z*s,Math.cos(angle/2)).normalize();
 }
 reset():void{this.active=false;this.action.stop();this.valid=false;}
 record(dt:number):void{
  for(let i=0;i<this.previous.length;i++){
   const current=this.rig.skeleton.bones[i].quaternion;
   if(this.valid&&dt>0)this.log(this.delta.copy(this.previous[i]).invert().multiply(current),this.velocity[i]).divideScalar(dt);
   else this.velocity[i].set(0,0,0);
   this.previous[i].copy(current);
  }
  const hip=this.rig.bones.Hip.position;
  if(this.valid&&dt>0)this.positionVelocity.copy(hip).sub(this.previousPosition).divideScalar(dt);else this.positionVelocity.set(0,0,0);
  this.previousPosition.copy(hip);this.valid=true;
 }
 capture():void{
  for(let n=0;n<this.tracks.length;n++){
   const track=this.tracks[n],rotation=track.name.endsWith('.quaternion'),target=this.idle.tracks[n].values;
   if(rotation){
    const start=this.rig.skeleton.bones[n].quaternion;
    this.log(this.delta.copy(start).invert().multiply(this.q.fromArray(target)),this.vector);
    const dx=this.vector.x,dy=this.vector.y,dz=this.vector.z,v=this.velocity[n];
    for(let f=0;f<track.times.length;f++){
     const t=track.times[f],u=f/(track.times.length-1),blend=ease(u),coast=.05*(-Math.expm1(-t/.05))*(1-blend);
     this.vector.set(dx*blend+v.x*coast,dy*blend+v.y*coast,dz*blend+v.z*coast);
     this.exp(this.vector,this.q).premultiply(start).normalize().toArray(track.values,f*4);
    }
   }else{
    const start=this.rig.bones.Hip.position;
    for(let f=0;f<track.times.length;f++){
     const t=track.times[f],blend=ease(f/(track.times.length-1)),coast=.05*(-Math.expm1(-t/.05))*(1-blend);
     this.p.fromArray(target).sub(start).multiplyScalar(blend).add(start).addScaledVector(this.positionVelocity,coast).toArray(track.values,f*3);
    }
   }
  }
 }
 /** Original's actual weighted directional surface support; source outfits retain
  * their own measured surfaces/support. Only prevents penetration during cancellation. */
 supportPose():void{
  this.rig.group.updateWorldMatrix(true,true);this.inverse.copy(this.rig.group.matrixWorld).invert();
  let low=Infinity;
  for(const i of this.support){this.p.fromBufferAttribute(this.rig.shell.geometry.attributes.position,i);this.rig.shell.applyBoneTransform(i,this.p);this.p.applyMatrix4(this.rig.shell.matrixWorld).applyMatrix4(this.inverse);low=Math.min(low,this.p.y);}
  if(low<0){
   this.parentMatrix.multiplyMatrices(this.inverse,this.rig.bones.Hip.parent!.matrixWorld).decompose(this.p,this.q,this.scale);
   this.p.set(0,-low,0).applyQuaternion(this.q.invert()).divide(this.scale);this.rig.bones.Hip.position.add(this.p);this.rig.group.updateMatrixWorld(true);
  }
 }
}
