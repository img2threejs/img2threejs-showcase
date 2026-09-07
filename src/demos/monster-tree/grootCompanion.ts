import * as THREE from 'three';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import type { MonsterTreeRig } from './rig';
import { forestGround } from './grootTerrain';
import { GrootCompanionReveal } from './grootCompanionReveal';

const BABY_SCALE=.30;
const locomotion=(id:string):boolean=>id==='grove-idle'||id==='forest-walk'||id==='forest-run';
const ease=(x:number):number=>{const t=THREE.MathUtils.clamp(x,0,1);return t*t*(3-2*t);};

/** Persistent, independently skinned offspring. Geometry/material edits never touch the parent. */
export class GrootCompanion {
  readonly root=new THREE.Group();
  readonly body:THREE.Object3D;
  readonly shell:THREE.SkinnedMesh;
  readonly mixer:THREE.AnimationMixer;
  readonly light:THREE.PointLight;
  readonly revealFx:GrootCompanionReveal;
  readonly actions:THREE.AnimationAction[];
  readonly ids:string[];
  enabled=false;
  pending=false;
  current='grove-idle';
  private visibleScale=0;
  private age=0;
  private time=0;
  private lastMain='';
  private mainReady=false;
  private mainSpeed=0;
  private orbit=.4;
  private nextHop=1.4;
  private hopAge=-1;
  private readonly target=new THREE.Vector3();
  private readonly birth=new THREE.Vector3();
  private readonly previousMain=new THREE.Vector3();
  private readonly step=new THREE.Vector3();
  private readonly hopStart=new THREE.Vector3();
  private readonly hopEnd=new THREE.Vector3();
  private readonly weights:Float32Array;
  private active=0;
  private fade=1;
  constructor(rig:MonsterTreeRig,readonly height:number,clips:THREE.AnimationClip[],seedGeometry:THREE.BufferGeometry){
    this.root.name='groot-baby-companion';this.root.visible=false;
    this.revealFx=new GrootCompanionReveal(height,seedGeometry,rig.shell.material);
    // The source root stores a circular runtime rig in userData. It is not part of the model.
    // SkeletonUtils uses Object3D.clone's JSON metadata copy; exclude that root-only metadata
    // during this synchronous construction and restore the exact original reference in finally.
    const metadata=rig.group.userData;
    try{rig.group.userData={};this.body=clone(rig.group);}finally{rig.group.userData=metadata;}
    this.body.name='groot-sapling-body';this.root.add(this.body);
    this.shell=this.body.getObjectByName(rig.shell.name) as THREE.SkinnedMesh;
    this.shell.geometry=rig.shell.geometry.clone();
    const colours=this.shell.geometry.attributes.color,source=rig.shell.geometry.attributes.color;
    for(let i=0;i<colours.count;i++){
      const lum=.2126*source.getX(i)+.7152*source.getY(i)+.0722*source.getZ(i);
      // Dark young chlorophyll with fresh green ridges; retain the original bark's fine shading.
      colours.setXYZ(i,.022+lum*.32,.060+lum*.85,.018+lum*.28);
    }
    const material=(rig.shell.material as THREE.MeshStandardMaterial).clone();
    material.name='sapling-fresh-forest-green';material.roughness=.72;material.metalness=.02;
    material.emissive.set('#193514');material.emissiveIntensity=.12;this.shell.material=material;
    this.shell.frustumCulled=false;
    // A fixed juvenile proportion, not squash/stretch during actions. Skin weights blend the neck.
    this.body.getObjectByName('Head')!.scale.setScalar(1.38);
    this.mixer=new THREE.AnimationMixer(this.body);this.ids=clips.map(c=>c.name.replace('groot:',''));
    this.actions=clips.map(clip=>{
      const action=this.mixer.clipAction(clip),id=clip.name.replace('groot:','');
      action.setLoop(locomotion(id)||id==='spirit-greeting'?THREE.LoopRepeat:THREE.LoopOnce,Infinity);
      action.clampWhenFinished=true;action.setEffectiveWeight(0).play();return action;
    });
    this.weights=new Float32Array(this.actions.length);
    this.mixer.update(0);for(const action of this.actions)action.stop();this.select('grove-idle');
    // Keep light counts stable when the body toggles: changing visible light counts recompiles
    // every lit forest material during the first summon. Intensity, not topology, animates now.
    this.light=new THREE.PointLight('#bbdfa1',0,height*1.2,2);this.revealFx.group.add(this.light);
    this.root.traverse(o=>{o.userData.isHighlight=true;});
  }
  request():void {this.enabled=true;this.pending=true;this.age=0;this.visibleScale=0;this.root.visible=false;this.revealFx.start();}
  dismiss():void {this.enabled=false;this.pending=false;}
  recall(origin:THREE.Vector3,yaw:number):void{
    this.root.position.copy(origin);this.root.position.x+=Math.sin(yaw)*this.height*.48;this.root.position.z+=Math.cos(yaw)*this.height*.48;
    this.root.position.y=forestGround(this.root.position.x,this.root.position.z,this.height);
    this.previousMain.copy(origin);this.mainSpeed=0;this.hopAge=-1;this.nextHop=this.time+1;this.select('grove-idle');
  }
  reveal(hand:THREE.Vector3):void{
    if(!this.enabled||!this.pending)return;
    this.pending=false;this.age=0;this.birth.copy(hand);this.root.position.copy(this.target);
    this.visibleScale=0;this.mainReady=false;this.nextHop=this.time+1.4;this.hopAge=-1;this.lastMain='spore-bloom';this.select('spirit-greeting');
  }
  private select(id:string):void{
    const index=this.ids.indexOf(id);if(index<0||(index===this.active&&this.actions[index].isRunning()))return;
    for(let i=0;i<this.actions.length;i++)this.weights[i]=this.actions[i].getEffectiveWeight();
    this.active=index;this.current=id;this.fade=0;this.actions[index].reset().setEffectiveTimeScale(1).setEffectiveWeight(0).play();
  }
  update(dt:number,origin:THREE.Vector3,facing:THREE.Vector3,mainId:string):void{
    this.time+=dt;
    if(this.pending){
      this.target.copy(origin);this.target.x+=(-facing.z*.48+facing.x*.10)*this.height;this.target.z+=(facing.x*.48+facing.z*.10)*this.height;this.target.y=forestGround(this.target.x,this.target.z,this.height);
      this.revealFx.update(dt,true,true,0,0,this.target,this.birth);return;
    }
    if(!this.enabled){this.visibleScale=Math.max(0,this.visibleScale-dt/.35);this.root.scale.setScalar(BABY_SCALE*this.visibleScale);this.root.visible=this.visibleScale>0;this.light.intensity=this.height*this.height*.08*this.visibleScale;this.revealFx.update(dt,false,false,this.age,this.visibleScale,this.root.position,this.birth);return;}
    this.age+=dt;this.visibleScale=ease(this.age/.75);this.root.visible=true;this.root.scale.setScalar(BABY_SCALE*this.visibleScale);
    const h=this.height;
    const mainDistance=this.mainReady?origin.distanceTo(this.previousMain):0;
    this.mainSpeed+=(mainDistance/Math.max(dt,.0001)-this.mainSpeed)*(1-Math.exp(-dt*8));
    this.previousMain.copy(origin);this.mainReady=true;
    this.target.copy(origin);this.target.x+=-facing.z*.48*h+facing.x*.10*h;this.target.z+=facing.x*.48*h+facing.z*.10*h;
    this.target.y=forestGround(this.target.x,this.target.z,h);
    if(this.age<.9){
      this.root.position.copy(this.target);this.root.position.y-=h*.035*(1-this.visibleScale);
      this.root.rotation.y=Math.atan2(-facing.z,facing.x);
    }else{
      if(mainDistance>3*h){this.root.position.copy(this.target);this.mainSpeed=0;this.hopAge=-1;}
      const mainMoving=this.mainSpeed>h*.08;
      if(!mainMoving&&locomotion(mainId)&&this.hopAge<0&&this.time>this.nextHop){
        this.orbit+=1.55;this.hopStart.copy(this.root.position);this.hopEnd.copy(origin);
        this.hopEnd.x+=Math.cos(this.orbit)*h*.48;this.hopEnd.z+=Math.sin(this.orbit)*h*.48;
        this.hopAge=0;this.select('forest-jump');
      }
      if(this.hopAge>=0&&!mainMoving&&locomotion(mainId)){
        this.hopAge+=dt;const duration=this.actions[this.active].getClip().duration;
        this.root.position.lerpVectors(this.hopStart,this.hopEnd,ease(this.hopAge/duration));
        this.step.copy(this.hopEnd).sub(this.hopStart);
        if(this.hopAge>=duration){this.hopAge=-1;this.nextHop=this.time+1.15;this.select('grove-idle');}
      }else{
        this.hopAge=-1;
        if(mainMoving){
          this.step.copy(this.target).sub(this.root.position);this.step.y=0;const distance=this.step.length();
          const speed=Math.min(h*2.5,distance*5),travel=Math.min(distance,speed*dt);
          if(distance>.001)this.root.position.addScaledVector(this.step,travel/distance);
          if(locomotion(mainId)){
            const run=speed>h*.25;this.select(run?'forest-run':'forest-walk');
            this.actions[this.active].setEffectiveTimeScale(THREE.MathUtils.clamp(speed/(h*BABY_SCALE*(run?1.883:.754)),.7,3));
          }
        }else{this.step.copy(origin).sub(this.root.position);if(locomotion(mainId)&&this.current!=='grove-idle')this.select('grove-idle');}
      }
      if(mainId!==this.lastMain&&!locomotion(mainId)&&mainId!=='spore-bloom')this.select(mainId);
      const desired=Math.atan2(-this.step.z,this.step.x),delta=Math.atan2(Math.sin(desired-this.root.rotation.y),Math.cos(desired-this.root.rotation.y));
      this.root.rotation.y+=delta*(1-Math.exp(-dt*8));
      const dx=this.root.position.x-origin.x,dz=this.root.position.z-origin.z,distance=Math.hypot(dx,dz);
      if(distance<h*.26){this.root.position.x=origin.x+(distance?dx/distance:-facing.z)*h*.26;this.root.position.z=origin.z+(distance?dz/distance:facing.x)*h*.26;}
      // Root stays on the shared terrain. Airborne displacement comes from the supplied jump clip.
      this.root.position.y=forestGround(this.root.position.x,this.root.position.z,h);
    }
    this.lastMain=mainId;this.fade=Math.min(1,this.fade+dt/.22);const blend=ease(this.fade);
    for(let i=0;i<this.actions.length;i++){
      this.actions[i].setEffectiveWeight(this.weights[i]*(1-blend)+(i===this.active?blend:0));
      if(this.fade===1&&i!==this.active&&this.actions[i].isScheduled())this.actions[i].stop();
    }
    this.mixer.update(dt);this.root.updateMatrixWorld(true);this.light.intensity=h*h*.08*this.visibleScale;
    this.light.position.set(h*.6,h*.9,h*.7).multiplyScalar(BABY_SCALE*this.visibleScale).applyEuler(this.root.rotation);
    this.revealFx.update(dt,true,false,this.age,this.visibleScale,this.root.position,this.birth);
  }
}
