import * as THREE from 'three';
import type { MonsterTreeRig } from './rig';
import { GrootRecovery } from './grootRecovery';
import { GROOT_FBX_DATA, importedClip, importedEvents, clipEntry, exitTime, isV2 } from './grootImportedMotion';

const AUTHORED_ACTIONS = [
  { id: 'grove-idle', label: '01 · Listening to the forest', duration: 6, loop: true },
  { id: 'spirit-greeting', label: '02 · A gentle giant', duration: 5.4, loop: true },
  { id: 'root-spear', label: '03 · Thornwood spear', duration: 3.6, loop: false },
  { id: 'vine-sweep', label: '2 · Faultline', duration: 4.2, loop: false },
  { id: 'root-stomp', label: 'Earthshatter · Area cast', duration: 3.8, loop: false },
  { id: 'sanctuary', label: '6 · Wooden sanctuary', duration: 6.4, loop: false },
  { id: 'regrowth', label: '7 · Living bark armour', duration: 5.2, loop: false },
  { id: 'spore-bloom', label: '9 · Little Groot companion', duration: 6, loop: true },
  { id: 'forest-dance', label: 'Root freeze · Breakdance', duration: 5, loop: true },
  { id: 'root-charge', label: 'Rootfall · Swing to land', duration: 4.2, loop: false },
  { id: 'verdant-embrace', label: '11 · Nature’s embrace', duration: 5.2, loop: false },
  { id: 'seed-sanctum', label: '12 · Seeds of life', duration: 8.2, loop: false },
  { id: 'spirit-call', label: '0 · Lantern spirits', duration: 4.6, loop: false },
  { id: 'forest-walk', label: 'WASD · Guardian stride', duration: 1.55, loop: true },
  { id: 'forest-run', label: 'Shift · Forest charge', duration: .96, loop: true },
  { id: 'forest-jump', label: 'Space · Running jump', duration: 1.34, loop: false },
] as const;
export interface GrootAction {id:string;label:string;duration:number;loop:boolean}
export const GROOT_ACTIONS:GrootAction[]=[...AUTHORED_ACTIONS,
  ...[['eclipse-kick','Eclipse Reaper'],['splinter-kick','Splinter Gale'],['comet-drop','Comet Descent'],['spore-tempest','Spore Tempest'],['twin-cyclone','Twin Cyclones'],['petal-collapse','Nightfall Petals'],['husk-rebirth','Husk Rebirth'],['last-stand','Last Stand']].map(([id,label])=>({id,label,duration:4,loop:false})),
  ...[['forest-roar','Elderwood roar'],['toxic-bolt','Venom thorn'],['thorn-fan','Briar fan'],['sap-salvo','Twinwood salvo'],['root-volley','Seed volley'],['bark-lance','Ancient lance'],['elder-burst','Blight eruption']].map(([id,label])=>({id,label,duration:4,loop:false})),
].map(spec=>GROOT_FBX_DATA[spec.id]?{...spec,duration:GROOT_FBX_DATA[spec.id].duration+(GROOT_FBX_DATA[spec.id].gait?0:clipEntry(spec.id)+exitTime(spec.id)),loop:spec.id==='grove-idle'||!!GROOT_FBX_DATA[spec.id].gait}:spec);
export type ImpactKind = 'pierce' | 'sweep' | 'seismic' | 'ground' | 'shield' | 'taken' | 'bloom' | 'gather' | 'seed' | 'summon' | 'heal' | 'freeze' | 'roar';
export interface GrootEvent { time: number; kind: ImpactKind; bone: string; pointH: number[]; speedH: number; hold: number }
export interface GrootSwingMeasure { gripTime:number; releaseTime:number; gripPointH:number[]; releasePointH:number[]; releaseVelocityH:number[]; minimumHandGapH:number }
export interface GrootMeasure { id: string; duration: number; samples: number; p95HandSpeedH: number; peakHandSpeedH: number; footDriftH: number; events: GrootEvent[];sourceFile?:string;effect?:string;contactSamples?:number;swing?:GrootSwingMeasure }
export interface GrootFxHooks {
  reset(): void;
  begin?(id:string,measure:GrootMeasure):void;
  step?(foot:'L_Foot'|'R_Foot',running:boolean):void;
  event(event: GrootEvent): void;
  frame(dt: number, action: string, time: number, measure: GrootMeasure): void;
}
const smooth = (x: number): number => { const t = THREE.MathUtils.clamp(x, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); };
/** A C2 envelope; velocity and acceleration both meet the holds without a kink. */
const envelope = (u: number, a: number, b: number, c: number, d: number): number => smooth((u - a) / (b - a)) * (1 - smooth((u - c) / (d - c)));
const lowerTrack = (track: THREE.KeyframeTrack): boolean => /^(Hip\.|[LR]_(Thigh|Calf|Foot|Toe))/.test(track.name);
const walkSource=GROOT_FBX_DATA['forest-walk'],runSource=GROOT_FBX_DATA['forest-run'];
export const GROOT_GAIT = {
  walk: { speed: walkSource?.gait?.speedH??.32, duration: walkSource?.duration??1.55, stance: walkSource?.gait?.stance??.62 },
  run: { speed: runSource?.gait?.speedH??.82, duration: runSource?.duration??.96, stance: runSource?.gait?.stance??.42 },
};

/** Bake world-target IK into real local quaternion tracks once. There is no post-mixer aiming,
 * no animated joint scale, and no pose construction/allocation in the runtime frame loop. */
export class GrootMotion {
  readonly actions = GROOT_ACTIONS;
  readonly measures: GrootMeasure[] = [];
  readonly clips: THREE.AnimationClip[] = [];
  readonly height: number;
  current: GrootAction = GROOT_ACTIONS[0];
  time = 0;
  hooks?: GrootFxHooks;
  private readonly recovery:GrootRecovery;
  private recoveryGaitWeight=0;
  private readonly playback: THREE.AnimationAction[] = [];
  private readonly upperPlayback: THREE.AnimationAction[] = [];
  private readonly gaitPlayback: THREE.AnimationAction[] = [];
  private locomotion = 0;
  private locomotionTarget = 0;
  private running = 0;
  private runningTarget = 0;
  private gaitPhase = 0;
  private travelSpeedH = 0;
  private readonly blendFrom = new Float32Array(GROOT_ACTIONS.length);
  private activeIndex = 0;
  private fade = 1;
  private fadeSeconds=.28;
  private nextEvent = 0;
  private hold = 0;
  private holdTotal = 1;
  private readonly rest: { bone: THREE.Bone; p: THREE.Vector3; q: THREE.Quaternion; world: THREE.Quaternion }[];
  private readonly footL = new THREE.Vector3();
  private readonly footR = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly parentQ = new THREE.Quaternion();
  private readonly axis = new THREE.Vector3();
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly c = new THREE.Vector3();
  private readonly d = new THREE.Vector3();
  private readonly e = new THREE.Vector3();
  private readonly targetL = new THREE.Vector3();
  private readonly targetR = new THREE.Vector3();
  private readonly targetFootL = new THREE.Vector3();
  private readonly targetFootR = new THREE.Vector3();
  private readonly basis = new THREE.Matrix4();
  private readonly normal = new THREE.Vector3();
  private readonly offsets = new Map<string, THREE.Quaternion>();

  constructor(readonly rig: MonsterTreeRig) {
    rig.mixer.stopAllAction();
    rig.group.updateMatrixWorld(true);
    this.height = new THREE.Box3().setFromObject(rig.group).getSize(this.p).y;
    this.rest = rig.skeleton.bones.map(bone => ({ bone, p: bone.position.clone(), q: bone.quaternion.clone().normalize(), world: bone.getWorldQuaternion(new THREE.Quaternion()) }));
    rig.bones.L_Foot.getWorldPosition(this.footL);
    rig.bones.R_Foot.getWorldPosition(this.footR);
    for (const chain of [['L_Upperarm','L_Forearm','L_Hand'],['R_Upperarm','R_Forearm','R_Hand'],['L_Thigh','L_Calf','L_Foot'],['R_Thigh','R_Calf','R_Foot']]) {
      const arm=chain[0].includes('Upperarm');
      rig.bones[chain[0]].getWorldPosition(this.a);rig.bones[chain[2]].getWorldPosition(this.b);
      this.d.copy(this.b).sub(this.a).normalize();this.e.set(arm?0:1,arm?-1:0,0);
      this.normal.crossVectors(this.d,this.e).normalize();
      for(let j=0;j<2;j++){
        const bone=rig.bones[chain[j]],child=rig.bones[chain[j+1]];
        this.b.copy(child.position).normalize();bone.getWorldQuaternion(this.q).invert();
        this.c.copy(this.normal).applyQuaternion(this.q);
        this.a.crossVectors(this.b,this.c).normalize();this.c.crossVectors(this.a,this.b).normalize();
        this.basis.makeBasis(this.a,this.b,this.c);
        this.offsets.set(bone.name,new THREE.Quaternion().setFromRotationMatrix(this.basis).invert());
      }
    }
    const baseline=this.bake(AUTHORED_ACTIONS[0]);
    for (const spec of GROOT_ACTIONS) this.clips.push(GROOT_FBX_DATA[spec.id]?importedClip(spec,baseline,rig,this.height):this.bake(spec));
    for (let i = 0; i < this.clips.length; i++) this.measures.push(this.measure(this.clips[i], GROOT_ACTIONS[i]));
    rig.mixer.stopAllAction();
    for (const clip of this.clips) {
      rig.clips.push(clip);
      const action = rig.mixer.clipAction(clip);
      action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true;
      this.playback.push(action);
      const upper = rig.mixer.clipAction(new THREE.AnimationClip(`${clip.name}:upper`,clip.duration,clip.tracks.filter(t=>!lowerTrack(t))));
      upper.setLoop(THREE.LoopOnce,1);upper.clampWhenFinished=true;this.upperPlayback.push(upper);
    }
    for(const id of ['forest-walk','forest-run']){
      const clip=this.clips.find(c=>c.name===`groot:${id}`)!;
      this.gaitPlayback.push(rig.mixer.clipAction(new THREE.AnimationClip(`${clip.name}:lower`,clip.duration,clip.tracks.filter(lowerTrack))).setLoop(THREE.LoopRepeat,Infinity));
    }
    this.recovery=new GrootRecovery(rig,this.clips[0]);
    this.play('grove-idle', true);
  }

  private rotate(name: string, x: number, y: number, z: number, angle: number): void {
    const bone = this.rig.bones[name];
    bone.parent!.getWorldQuaternion(this.parentQ).invert();
    this.axis.set(x, y, z).applyQuaternion(this.parentQ);
    this.q.setFromAxisAngle(this.axis, angle);
    bone.quaternion.premultiply(this.q).normalize();
    bone.updateWorldMatrix(false, true);
  }

  private aim(bone: THREE.Bone, child: THREE.Bone, target: THREE.Vector3): void {
    bone.getWorldPosition(this.a); child.getWorldPosition(this.b);
    this.b.sub(this.a).normalize(); this.c.copy(target).sub(this.a).normalize();
    this.b.copy(this.c);
    this.a.crossVectors(this.b,this.normal).normalize();
    this.c.crossVectors(this.a,this.b).normalize();
    this.basis.makeBasis(this.a,this.b,this.c);
    this.q.setFromRotationMatrix(this.basis).multiply(this.offsets.get(bone.name)!);
    bone.parent!.getWorldQuaternion(this.parentQ).invert();
    bone.quaternion.copy(this.parentQ.multiply(this.q)).normalize();
    bone.updateWorldMatrix(false, true);
  }

  private solve(upperName: string, middleName: string, endName: string, target: THREE.Vector3, poleX: number): void {
    const upper = this.rig.bones[upperName], middle = this.rig.bones[middleName], end = this.rig.bones[endName];
    upper.getWorldPosition(this.a); middle.getWorldPosition(this.b); end.getWorldPosition(this.c);
    const l1 = this.a.distanceTo(this.b), l2 = this.b.distanceTo(this.c);
    this.d.copy(target).sub(this.a);
    const distance = THREE.MathUtils.clamp(this.d.length(), Math.abs(l1 - l2) + 0.001, (l1 + l2) * 0.998);
    this.d.normalize();
    const along = (l1 * l1 - l2 * l2 + distance * distance) / (2 * distance);
    const arm=upperName.includes('Upperarm');
    this.e.set(arm?0:poleX,arm?-1:0,0);
    this.normal.crossVectors(this.d,this.e).normalize();
    this.e.crossVectors(this.normal,this.d).normalize();
    this.e.multiplyScalar(Math.sqrt(Math.max(0, l1 * l1 - along * along))).addScaledVector(this.d, along).add(this.a);
    this.aim(upper, middle, this.e);
    this.aim(middle, end, target);
  }

  private pose(spec: GrootAction, time: number): void {
    const h = this.height, u = time / spec.duration, phase = u * Math.PI * 2;
    for (const rest of this.rest) { rest.bone.position.copy(rest.p); rest.bone.quaternion.copy(rest.q); rest.bone.scale.setScalar(1); }
    let crouch = 0.027, lean = -.018, yaw = 0, hipYaw = 0, sway = 0, forward = 0, hop = 0;
    let headYaw = 0.055 * Math.sin(phase), headBow = 0.025 * Math.sin(phase);
    let curlL = 0.10, curlR = 0.10, palmL = 0, palmR = 0, spearPalm = 0;
    this.targetL.set(0.075, 0.48, -0.19);
    this.targetR.set(0.10, 0.50, 0.18);
    this.targetFootL.copy(this.footL); this.targetFootR.copy(this.footR);
    this.targetFootL.x+=h*.025;this.targetFootR.x-=h*.035;
    this.targetFootL.z-=h*.020;this.targetFootR.z+=h*.020;
    const idle = Math.sin(phase);
    this.targetL.x += idle * 0.008; this.targetR.y += idle * 0.008;
    if (spec.id === 'spirit-greeting') {
      const greet = envelope(u, 0.04, 0.28, 0.69, 0.98);
      this.targetR.lerp(this.p.set(0.22, 0.70, 0.25), greet);
      this.targetR.z += Math.sin(phase * 3) * 0.018 * greet;
      headYaw = -0.16 * greet; headBow = -0.08 * greet;
      curlR = 0.1 - 0.16 * greet; lean = -0.018 * greet;
      palmR=greet;
    } else if (spec.id === 'root-spear') {
      const wind = envelope(u, 0.04, 0.22, 0.25, 0.41);
      const strike = envelope(u, 0.26, 0.43, 0.50, 0.91);
      this.targetR.lerp(this.p.set(-0.07, 0.63, 0.25), wind);
      this.targetR.lerp(this.p.set(0.36, 0.64, 0.10), strike);
      this.targetL.lerp(this.p.set(.13,.58,-.15),Math.max(wind,strike));
      yaw = 0.26 * wind - 0.28 * strike; hipYaw=.10*wind-.12*strike;
      lean = -0.045 * wind + 0.095 * strike; forward=.035*strike;
      this.targetFootL.x+=h*.085*strike;this.targetFootL.y+=h*.045*Math.sin(Math.PI*strike)**2;
      crouch += 0.032 * wind+.016*strike; curlL+=.16*Math.max(wind,strike);curlR = 0.1 + 0.16 * wind - 0.08 * strike;
      spearPalm=strike;
    } else if (spec.id === 'vine-sweep') {
      const wind = envelope(u, 0.02, 0.22, 0.26, 0.50), sweep = envelope(u, 0.27, 0.51, 0.57, 0.97);
      this.targetR.lerp(this.p.set(-0.045, 0.66, 0.29), wind);
      this.targetR.lerp(this.p.set(0.31, 0.60, -0.08), sweep);
      this.targetL.lerp(this.p.set(0.12, 0.60, -0.16),Math.max(wind,sweep));
      yaw = 0.32 * wind - 0.34 * sweep;hipYaw=.12*wind-.14*sweep;lean = 0.075 * sweep;
      sway=.018*wind-.02*sweep;forward=.018*sweep;
      headYaw = -yaw * 0.6; crouch += 0.026 * wind+.016*sweep;curlL+=.17*sweep;
      spearPalm=sweep*.8;
    } else if (spec.id === 'root-stomp') {
      const lift = envelope(u, 0.06, 0.25, 0.30, 0.44), brace = envelope(u, 0.35, 0.46, 0.52, 0.87);
      this.targetFootR.y += h * 0.12 * lift; this.targetFootR.x += h * 0.065 * lift;
      sway = -0.035 * lift; crouch += 0.046 * brace; lean = 0.10 * brace;
      this.targetL.lerp(this.p.set(.07,.66,-.22),lift);this.targetR.lerp(this.p.set(.12,.72,.21),lift);
      this.targetL.lerp(this.p.set(.18,.54,-.16),brace);this.targetR.lerp(this.p.set(.21,.56,.15),brace);
      curlL+=.20*brace;curlR+=.20*brace;headBow=.045*brace;
    } else if (spec.id === 'sanctuary') {
      const open = envelope(u, 0.03, 0.20, 0.24, 0.41), protect = envelope(u, 0.25, 0.44, 0.72, 0.99);
      this.targetL.lerp(this.p.set(0.065, 0.68, -0.29), open);
      this.targetR.lerp(this.p.set(0.065, 0.68, 0.29), open);
      this.targetL.lerp(this.p.set(0.20, 0.62, -0.085), protect);
      this.targetR.lerp(this.p.set(0.21, 0.65, 0.085), protect);
      crouch += 0.035 * protect; headBow = 0.13 * protect; lean = 0.055 * protect;
      curlL += protect * 0.11; curlR += protect * 0.11;
    } else if (spec.id === 'regrowth') {
      const recoil = envelope(u, 0.055, 0.12, 0.17, 0.38), heal = envelope(u, 0.21, 0.43, 0.66, 0.99);
      lean = -0.09 * recoil + 0.07 * heal; crouch += 0.038 * heal;
      this.targetL.lerp(this.p.set(0.10, 0.58, -0.26), recoil);
      this.targetR.lerp(this.p.set(0.20, 0.64, 0.02), heal);
      this.targetL.lerp(this.p.set(0.18, 0.55, -0.10), heal);
      headBow = 0.17 * heal; curlR += 0.08 * heal;
    } else if (spec.id === 'spore-bloom') {
      const cup = envelope(u, 0.03, 0.25, 0.36, 0.65), open = envelope(u, 0.36, 0.59, 0.69, 0.98);
      this.targetL.lerp(this.p.set(0.20, 0.60, -0.065), cup);
      this.targetR.lerp(this.p.set(0.20, 0.60, 0.065), cup);
      this.targetL.lerp(this.p.set(0.17, 0.74, -0.25), open);
      this.targetR.lerp(this.p.set(0.17, 0.74, 0.25), open);
      headBow = -0.12 * open; curlL -= 0.17 * open; curlR -= 0.17 * open;
      palmL=Math.max(cup,open);palmR=palmL;
    } else if (spec.id === 'root-charge') {
      const launch=smooth((u-.20)/.20),returnR=smooth((u-.56)/.15),returnL=smooth((u-.72)/.16);
      const rightX=.32*launch*(1-returnR),leftX=.32*launch*(1-returnL);
      const flight=THREE.MathUtils.clamp((u-.20)/.20,0,1);hop=.065*Math.sin(flight*Math.PI)**2;
      forward=(rightX+leftX)/2;
      this.targetFootL.x+=h*leftX;this.targetFootR.x+=h*rightX;
      this.targetFootL.y+=h*(hop+.055*Math.sin(Math.PI*returnL)**2);
      this.targetFootR.y+=h*(hop+.055*Math.sin(Math.PI*returnR)**2);
      const brace=envelope(u,.03,.17,.48,.95);crouch+=.04*brace;
      lean=.11*envelope(u,.18,.31,.42,.66);
      this.targetL.lerp(this.p.set(.18,.62,-.13),brace);this.targetR.lerp(this.p.set(.21,.65,.15),brace);
      this.targetL.x+=forward;this.targetR.x+=forward;this.targetL.y+=hop;this.targetR.y+=hop;
    } else if (spec.id === 'verdant-embrace') {
      const open=envelope(u,.04,.24,.28,.47),gather=envelope(u,.29,.49,.63,.97);
      this.targetL.lerp(this.p.set(.045,.68,-.34),open);this.targetR.lerp(this.p.set(.045,.68,.34),open);
      this.targetL.lerp(this.p.set(.24,.61,-.075),gather);this.targetR.lerp(this.p.set(.24,.61,.075),gather);
      crouch+=.025*gather;lean=.06*gather;headBow=.05*gather;
      curlL+=.08*gather;curlR+=.08*gather;
    } else if (spec.id === 'seed-sanctum') {
      const sleep=envelope(u,.04,.24,.76,.98),pulse=Math.sin((u-.24)*Math.PI*2*7/.52)*.006*sleep;
      this.targetL.lerp(this.p.set(.15,.54+pulse,-.08),sleep);this.targetR.lerp(this.p.set(.15,.57+pulse,.08),sleep);
      crouch+=.042*sleep;headBow=.13*sleep;lean=.055*sleep;
      palmL=sleep*.7;palmR=sleep*.7;
    } else if(spec.id==='spirit-call'){
      const call=envelope(u,.035,.38,.62,.98);
      this.targetR.lerp(this.p.set(.19,.84,.16),call);this.targetL.lerp(this.p.set(.13,.59,-.15),call);
      lean=-.045*call;headBow=-.13*call;headYaw=-.10*call;curlR=-.09*call;palmR=call;
    } else if(spec.id==='forest-walk'||spec.id==='forest-run'){
      const run=spec.id==='forest-run',gait=run?GROOT_GAIT.run:GROOT_GAIT.walk;
      const span=gait.speed*spec.duration*gait.stance;
      for(let side=0;side<2;side++){
        const cycle=(u+side*.5)%1,foot=side===0?this.targetFootL:this.targetFootR;
        let x:number,y=0;
        if(cycle<gait.stance)x=span/2-gait.speed*spec.duration*cycle;
        else{
          const t=(cycle-gait.stance)/(1-gait.stance),m=-gait.speed*spec.duration*(1-gait.stance);
          x=-span/2+span*(3*t*t-2*t*t*t)+m*(2*t*t*t-3*t*t+t);
          y=(run?.115:.07)*Math.sin(Math.PI*t)**2;
        }
        foot.x+=x*h;foot.y+=y*h;
      }
      crouch+=run?.073:.040;hop=(run?.008:.003)*(1-Math.cos(phase*2));
      lean=run?.16:.065;hipYaw=.035*Math.sin(phase);yaw=-.05*Math.sin(phase);sway=.010*Math.sin(phase);
      this.targetL.set(.08+(run?.09:.06)*Math.sin(phase),run?.57:.49,-.17);
      this.targetR.set(.08-(run?.09:.06)*Math.sin(phase),run?.57:.49,.17);
      headYaw=-yaw*.5;headBow=run?.045:.01;curlL=run?.25:.12;curlR=curlL;
    } else if (spec.id === 'forest-dance') {
      const pulse = Math.sin(phase * 2), second = Math.sin(phase * 2 + 0.6) - Math.sin(0.6);
      sway = 0.024 * pulse; yaw = 0.07 * second; crouch += 0.012 * (1 - Math.cos(phase * 4));
      this.targetL.y += 0.055 * (1 - Math.cos(phase * 2));
      this.targetR.x += 0.07 * (1 - Math.cos(phase * 2 + 0.3)) - 0.07 * (1 - Math.cos(0.3));
      headYaw = -0.11 * pulse; headBow = 0.06 * Math.sin(phase * 4);
      curlL += 0.05 * Math.sin(phase * 4); curlR -= 0.05 * Math.sin(phase * 4);
    }
    const hip = this.rig.bones.Hip;
    this.p.set(forward*h, (-crouch+hop) * h, sway * h);
    hip.parent!.getWorldQuaternion(this.q).invert(); this.p.applyQuaternion(this.q);
    hip.parent!.getWorldScale(this.a); this.p.divide(this.a); hip.position.add(this.p);
    this.rig.group.updateMatrixWorld(true);
    this.rotate('Hip',0,1,0,hipYaw);
    this.rotate('Waist', 0, 0, 1, -lean * 0.4);
    this.rotate('Spine01', 0, 0, 1, -lean * 0.6);
    this.rotate('Spine01', 0, 1, 0, yaw * 0.5);
    this.rotate('Spine02', 0, 1, 0, yaw * 0.5);
    this.rotate('NeckTwist01', 0, 1, 0, headYaw * 0.45);
    this.rotate('Head', 0, 1, 0, headYaw * 0.55);
    this.rotate('Head', 0, 0, 1, -headBow);
    this.solve('L_Thigh', 'L_Calf', 'L_Foot', this.targetFootL, 1);
    this.solve('R_Thigh', 'R_Calf', 'R_Foot', this.targetFootR, 1);
    for (const name of ['L_Foot', 'R_Foot']) {
      const rest = this.rest.find(r => r.bone.name === name)!;
      rest.bone.parent!.getWorldQuaternion(this.q).invert();
      rest.bone.quaternion.copy(this.q.multiply(rest.world));
    }
    this.targetL.multiplyScalar(h); this.targetR.multiplyScalar(h);
    this.solve('L_Upperarm', 'L_Forearm', 'L_Hand', this.targetL, 1);
    this.solve('R_Upperarm', 'R_Forearm', 'R_Hand', this.targetR, 1);
    for(const name of ['L_Hand','R_Hand']){
      const weight=name==='L_Hand'?palmL:Math.max(palmR,spearPalm);
      if(weight<=0)continue;
      const hand=this.rig.bones[name];
      // The measured long axis is +Y. A bounded wrist swing retains the forearm's roll,
      // avoiding the 180-degree roll ambiguity of blending toward an absolute palm frame.
      hand.getWorldQuaternion(this.q);
      this.a.set(0,1,0).applyQuaternion(this.q);this.b.set(1,.12,0).normalize();
      this.c.crossVectors(this.a,this.b).normalize();
      const angle=Math.min(1.05,Math.acos(THREE.MathUtils.clamp(this.a.dot(this.b),-1,1)))*weight;
      this.parentQ.setFromAxisAngle(this.c,angle);this.q.premultiply(this.parentQ);
      hand.parent!.getWorldQuaternion(this.parentQ).invert();hand.quaternion.copy(this.parentQ.multiply(this.q));
    }
    for (const rest of this.rest) {
      if (!rest.bone.name.includes('_Digit')) continue;
      const side = rest.bone.name.startsWith('L') ? 1 : -1;
      // Bend fingers in their own measured palm plane, never scale the hand/forearm.
      this.q.setFromAxisAngle(this.axis.set(0, 0, 1), (side === 1 ? curlL : curlR) * side);
      rest.bone.quaternion.copy(rest.q).multiply(this.q);
    }
    this.rig.group.updateMatrixWorld(true);
  }

  private bake(spec: GrootAction): THREE.AnimationClip {
    const frames = Math.ceil(spec.duration * 60), times: number[] = [];
    const rotations = this.rest.map(() => [] as number[]), positions: number[] = [];
    for (let i = 0; i <= frames; i++) {
      const t = i / frames * spec.duration; times.push(t); this.pose(spec, t);
      for (let j = 0; j < this.rest.length; j++) this.rest[j].bone.quaternion.toArray(rotations[j], i * 4);
      this.rig.bones.Hip.position.toArray(positions, i * 3);
    }
    // Offline, zero-phase muscle damping. A hemisphere-aligned quaternion kernel smooths IK
    // angular velocity near reach limits without adding runtime lag. Legs are excluded: their
    // planted targets must remain exact. The subsequently measured table uses these final clips.
    const kernel=[1,6,15,20,15,6,1];
    for(let bone=0;bone<this.rest.length;bone++){
      if(!/Upperarm|Forearm|Hand/.test(this.rest[bone].bone.name))continue;
      for(let pass=0;pass<6;pass++){
        const source=rotations[bone].slice(),target=rotations[bone];
        for(let frame=0;frame<frames;frame++){
          let x=0,y=0,z=0,w=0;
          for(let k=-3;k<=3;k++){
            const at=((frame+k+frames)%frames)*4,base=frame*4;
            const sign=source[at]*source[base]+source[at+1]*source[base+1]+source[at+2]*source[base+2]+source[at+3]*source[base+3]<0?-1:1;
            const weight=kernel[k+3]*sign;x+=source[at]*weight;y+=source[at+1]*weight;z+=source[at+2]*weight;w+=source[at+3]*weight;
          }
          const length=Math.hypot(x,y,z,w);target[frame*4]=x/length;target[frame*4+1]=y/length;target[frame*4+2]=z/length;target[frame*4+3]=w/length;
        }
        for(let k=0;k<4;k++)target[frames*4+k]=target[k];
      }
    }
    const tracks: THREE.KeyframeTrack[] = this.rest.map((r, i) => new THREE.QuaternionKeyframeTrack(`${r.bone.name}.quaternion`, times, rotations[i]));
    tracks.push(new THREE.VectorKeyframeTrack('Hip.position', times, positions));
    return new THREE.AnimationClip(`groot:${spec.id}`, spec.duration, tracks);
  }

  private measure(clip: THREE.AnimationClip, spec: GrootAction): GrootMeasure {
    const mixer = this.rig.mixer;
    mixer.stopAllAction(); const action = mixer.clipAction(clip); action.reset().setLoop(THREE.LoopOnce, 1).play(); action.clampWhenFinished = true;
    const names = ['L_Digit3_3', 'R_Digit3_3', 'L_Foot', 'R_Foot', 'Spine02', 'Head', 'R_Digit3_1', 'L_Digit3_1'];
    const plantAnchors: (THREE.Vector3 | null)[]=[null,null];
    const samples: THREE.Vector3[][] = [];
    const speeds: number[] = [];
    const count = Math.ceil(clip.duration * 120);
    let drift = 0;
    for (let i = 0; i <= count; i++) {
      action.time = i * clip.duration / count; mixer.update(0); this.rig.group.updateMatrixWorld(true);
      const points = names.map(n => this.rig.bones[n].getWorldPosition(new THREE.Vector3()).divideScalar(this.height));
      samples.push(points);
      if (i) {
        for (let hand = 0; hand < 2; hand++) speeds.push(points[hand].distanceTo(samples[i - 1][hand]) * count / clip.duration);
        for (let foot = 2; foot < 4; foot++) {
          if (spec.id === 'root-charge') {
            // Only stationary contact intervals are plant tests; airborne/swing feet are not.
            const u=i/count,plant=foot===2?(u<.20||(u>.41&&u<.71)||u>.90):(u<.20||(u>.41&&u<.55)||u>.73);
            if(plant&&points[foot].y<samples[0][foot].y+.002){
              if(!plantAnchors[foot-2])plantAnchors[foot-2]=points[foot].clone();
              drift=Math.max(drift,points[foot].distanceTo(plantAnchors[foot-2]!));
            }else plantAnchors[foot-2]=null;
          } else if(spec.id==='forest-walk'||spec.id==='forest-run'){
            const gait=spec.id==='forest-run'?GROOT_GAIT.run:GROOT_GAIT.walk,phase=(i/count+(foot-2)*.5)%1;
            if(phase<gait.stance){
              const world=points[foot].clone();world.x+=gait.speed*i/count*spec.duration;
              if(!plantAnchors[foot-2])plantAnchors[foot-2]=world.clone();
              drift=Math.max(drift,world.distanceTo(plantAnchors[foot-2]!));
            }else plantAnchors[foot-2]=null;
          } else {
            if (spec.id === 'root-stomp' && foot === 3) continue;
            if (spec.id === 'root-spear' && foot === 2) continue; // Authored stepping foot; support foot remains gated.
            drift = Math.max(drift, points[foot].distanceTo(samples[0][foot]));
          }
        }
      }
    }
    const events: GrootEvent[] = [];
    if(GROOT_FBX_DATA[spec.id]){
      speeds.sort((a,b)=>a-b);action.stop();
      return {id:spec.id,duration:spec.duration,samples:count+1,p95HandSpeedH:speeds[Math.floor(speeds.length*.95)],peakHandSpeedH:speeds[speeds.length-1],...importedEvents(spec,samples)};
    }
    let bone = 1, kind: ImpactKind | null = null, start = 0.35, end = 0.58, hold = 0;
    if (spec.id === 'root-spear') { kind = 'pierce'; hold = 0.045; }
    if (spec.id === 'vine-sweep') { kind = 'sweep'; start = 0.44; end = 0.60; hold = 0.055; }
    if (spec.id === 'root-stomp') { kind = 'ground'; bone = 3; start = 0.35; end = 0.52; hold = 0.065; }
    if (spec.id === 'regrowth') { kind = 'taken'; bone = 4; start = 0.06; end = 0.20; hold = 0.035; }
    if (spec.id === 'sanctuary') { kind = 'shield'; bone = 4; start = 0.39; end = 0.55; }
    if (spec.id === 'spore-bloom') { kind = 'bloom'; start = 0.50; end = 0.66; }
    if (spec.id === 'root-charge') { kind='ground';bone=3;start=.35;end=.48;hold=.065; }
    if (spec.id === 'verdant-embrace') {kind='gather';start=.46;end=.65;hold=.045;}
    if (spec.id === 'seed-sanctum') {kind='seed';bone=4;start=.23;end=.29;}
    if (spec.id === 'spirit-call') {kind='summon';bone=1;start=.34;end=.58;}
    if (kind) {
      let best = -Infinity, at = Math.ceil(start * count);
      for (let i = at; i <= Math.floor(end * count); i++) {
        const point = samples[i][bone];
        // Extension/contact extrema measured from evaluated joints, not a scrub-bar timestamp.
        const value = kind === 'ground' ? -point.y : kind === 'sweep' ? -point.z : kind==='gather' ? -samples[i][0].distanceTo(samples[i][1])
          : kind === 'taken' ? this.p.copy(samples[i][bone]).addScaledVector(samples[i-1][bone],-2).add(samples[i-2][bone]).length()
          : kind === 'bloom'||kind==='summon' ? point.y : kind === 'shield' ? -point.y : point.x;
        if (value > best + 1e-7) { best = value; at = i; }
      }
      events.push({ time: at * clip.duration / count, kind, bone: names[bone], pointH: samples[at][bone].toArray(),
        speedH: samples[at][bone].distanceTo(samples[at - 1][bone]) * count / clip.duration, hold });
      if(kind==='seed')for(let pulse=1;pulse<7;pulse++){
        const from=Math.floor((.27+pulse*.07)*count),to=Math.floor((.32+pulse*.07)*count);
        let peak=from;for(let i=from;i<=to;i++)if(samples[i][1].y>samples[peak][1].y)peak=i;
        events.push({time:peak*clip.duration/count,kind,bone:'Head',pointH:samples[peak][5].toArray(),speedH:samples[peak][5].distanceTo(samples[peak-1][5])*count/clip.duration,hold:0});
      }
    }
    speeds.sort((a, b) => a - b);
    action.stop();
    return { id: spec.id, duration: spec.duration, samples: count + 1, p95HandSpeedH: speeds[Math.floor(speeds.length * 0.95)], peakHandSpeedH: speeds[speeds.length - 1], footDriftH: drift, events };
  }

  play(id: string, immediate = false): boolean {
    const index = GROOT_ACTIONS.findIndex(a => a.id === id);
    if (index < 0||this.recovering&&!immediate) return false;
    if(immediate)this.recovery?.reset();
    for (let i = 0; i < this.playback.length; i++) this.blendFrom[i] = immediate ? 0 : this.playback[i].getEffectiveWeight()*Number(this.playback[i].isScheduled())+this.upperPlayback[i].getEffectiveWeight()*Number(this.upperPlayback[i].isScheduled());
    const wasGait=this.current.id==='forest-walk'||this.current.id==='forest-run';
    const gaitEntry=(id==='forest-walk'||id==='forest-run')&&!wasGait;
    const leavingGait=!immediate&&wasGait&&this.locomotion>0&&(id==='forest-jump'||isV2(id));
    this.activeIndex = index; this.current = GROOT_ACTIONS[index]; this.time = 0; this.nextEvent = 0; this.hold = 0;
    this.fade = immediate ? 1 : 0;this.fadeSeconds=gaitEntry?.6:.28;
    if (immediate) this.rig.mixer.stopAllAction();
    const action = this.playback[index]; action.reset().setEffectiveTimeScale(1).setEffectiveWeight(immediate ? 1 : 0).play();
    this.upperPlayback[index].reset().setEffectiveTimeScale(1).setEffectiveWeight(0).play();
    if(immediate){this.locomotion=0;this.locomotionTarget=0;}
    if(id==='forest-jump'||isV2(id)){
      // Transfer ownership BEFORE dropping the lower layer. Its full/upper gait
      // tracks already share the evaluated stride phase. Otherwise update(0) at
      // keyboard dispatch exposes unowned bind-pose legs until the next tick.
      if(leavingGait)for(let i=0;i<this.playback.length;i++)if(i!==index){this.playback[i].setEffectiveWeight(this.blendFrom[i]);this.upperPlayback[i].setEffectiveWeight(0);}
      this.locomotion=0;this.locomotionTarget=0;for(const gait of this.gaitPlayback)gait.stop();
    }
    this.hooks?.reset();
    this.hooks?.begin?.(id,this.measures[index]);
    this.rig.mixer.update(0); this.rig.group.updateMatrixWorld(true);
    if(leavingGait)this.recovery.supportPose();
    if(immediate)this.recovery?.record(0);
    return true;
  }

  /** Read-only source-retarget input. Full and upper tracks both drive arms; lower-only
   * locomotion under a cast must NOT apply a gait rest frame to the casting arms. */
  get sourceGaitWeight():number{
    // The captured composite pose includes T11's source arm correspondence too.
    // Carry that parameter with the same recovery envelope, rather than resetting
    // Abies' arms when a still-entering moving cast is cancelled.
    if(this.recovering)return this.recoveryGaitWeight*(1-smooth(this.recovery.action.time/this.recovery.duration));
    let weight=0;
    for(let i=0;i<this.actions.length;i++)if(this.actions[i].id==='forest-walk'||this.actions[i].id==='forest-run'){
      const full=this.playback[i],upper=this.upperPlayback[i];
      if(full.isScheduled())weight+=full.getEffectiveWeight();
      if(upper.isScheduled())weight+=upper.getEffectiveWeight();
    }
    return THREE.MathUtils.clamp(weight,0,1);
  }

  /** Includes cancellation fade/recovery, not merely the current idle clip ID. */
  get outfitSafe():boolean{return ['grove-idle','forest-walk','forest-run'].includes(this.current.id)&&this.fade>=1;}
  get recovering():boolean{return this.recovery?.active??false;}
  cancelV2():boolean {
    if(!isV2(this.current.id))return false;
    const gait=this.sourceGaitWeight;
    this.recovery.capture();this.play('grove-idle',true);this.recoveryGaitWeight=gait;
    this.fade=0;this.fadeSeconds=this.recovery.duration;
    this.playback[this.activeIndex].setEffectiveWeight(0);
    this.recovery.active=true;this.recovery.action.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).play();
    this.rig.mixer.update(0);this.rig.group.updateMatrixWorld(true);
    return true;
  }

  update(dt: number, ignoreHitstop = false): void {
    let remaining = Math.min(Math.max(0, dt), 0.1);
    while (remaining > 1e-8) {
      const wallStep = Math.min(remaining, 1 / 120);
      let scale = 1;
      if (this.hold > 0 && !ignoreHitstop) scale = 0.08 + 0.92 * smooth(1 - this.hold / this.holdTotal);
      const measure = this.measures[this.activeIndex], next = measure.events[this.nextEvent];
      const until = next ? Math.max(0, next.time - this.time) : Infinity;
      const clipStep = Math.min(wallStep * scale, until, this.current.duration - this.time);
      const elapsed = clipStep > 1e-8 ? clipStep / scale : wallStep;
      this.fade = Math.min(1, this.fade + elapsed / this.fadeSeconds);
      const blend = smooth(this.fade);
      this.locomotion+=(this.locomotionTarget-this.locomotion)*(1-Math.exp(-elapsed*16));
      this.running+=(this.runningTarget-this.running)*(1-Math.exp(-elapsed*10));
      const previousGaitPhase=this.gaitPhase;
      // A lower-only gait must enter with the SAME C2 action fade as the full gait.
      // Otherwise releasing a full-body lock injects ~12.5% of an arbitrary stride
      // in its first 120Hz step, even though the walk/run action has barely entered.
      const enteringGait=this.current.id==='forest-walk'||this.current.id==='forest-run';
      const layer=this.locomotion*(enteringGait?blend:1);
      for (let i = 0; i < this.playback.length; i++) {
        const weight=this.recovering?0:this.blendFrom[i]*(1-blend)+(i===this.activeIndex?blend:0);
        this.playback[i].setEffectiveWeight(weight*(1-layer));
        this.upperPlayback[i].setEffectiveWeight(weight*layer);
        if (blend === 1 && i !== this.activeIndex){if(this.playback[i].isScheduled())this.playback[i].stop();if(this.upperPlayback[i].isScheduled())this.upperPlayback[i].stop();}
      }
      if(this.locomotion>.00001){
        const period=GROOT_GAIT.walk.duration*(1-this.running)+GROOT_GAIT.run.duration*this.running;
        const speed=GROOT_GAIT.walk.speed*(1-this.running)+GROOT_GAIT.run.speed*this.running;
        this.gaitPhase=(this.gaitPhase+elapsed/period*this.travelSpeedH/speed)%1;
        for(let i=0;i<2;i++){const action=this.gaitPlayback[i];action.play();action.time=this.gaitPhase*action.getClip().duration;action.setEffectiveTimeScale(0).setEffectiveWeight(layer*(i===0?1-this.running:this.running));}
        if(this.current.id==='forest-walk'||this.current.id==='forest-run'){
          // Body and legs share the distance-driven phase; acceleration/casting must not let
          // the arms play a different part of the supplied cycle from the feet.
          const base=this.playback[this.activeIndex],upper=this.upperPlayback[this.activeIndex];
          base.time=upper.time=this.gaitPhase*this.current.duration;base.setEffectiveTimeScale(0);upper.setEffectiveTimeScale(0);
        }
      }else for(const action of this.gaitPlayback)action.stop();
      this.rig.mixer.update(clipStep); this.time += clipStep;
      this.rig.group.updateMatrixWorld(true);
      if(this.recovering||enteringGait&&this.locomotion>.00001)this.recovery.supportPose();
      this.recovery.record(clipStep);
      if(layer>.15&&this.travelSpeedH>.04){
        const source=this.running>.5?runSource:walkSource;
        for(const contact of source.contacts){
          const phase=contact.start/source.duration;
          const crossed=this.gaitPhase>=previousGaitPhase?phase>previousGaitPhase&&phase<=this.gaitPhase:phase>previousGaitPhase||phase<=this.gaitPhase;
          if(crossed)this.hooks?.step?.(contact.foot as 'L_Foot'|'R_Foot',this.running>.5);
        }
      }
      this.hold = Math.max(0, this.hold - elapsed);
      if (next && this.time >= next.time - 1e-7) {
        this.hooks?.event(next); this.nextEvent++;
        this.hold = next.hold; this.holdTotal = next.hold || 1;
      }
      this.hooks?.frame(elapsed, this.current.id, this.time, measure);
      remaining -= elapsed;
      if(this.recovering&&this.recovery.action.time>=this.recovery.duration-1e-7)this.play('grove-idle',true);
      if (this.time >= this.current.duration - 1e-7) {
        if (ignoreHitstop) return;
        if(this.current.loop){this.time=0;this.nextEvent=0;this.playback[this.activeIndex].reset().play();this.upperPlayback[this.activeIndex].reset().play();}
        else this.play('grove-idle');
      }
    }
  }

  /** Native disjoint-track layers: no post-mixer bone override when a cast meets a run. */
  setLocomotion(weight: number, running: boolean, speedH=0): void {this.locomotionTarget=this.recovering?0:THREE.MathUtils.clamp(weight,0,1);this.runningTarget=Number(running);this.travelSpeedH=speedH;}

  /** Deterministic review owns the same driver; only hitstop is bypassed for clip-time seeks. */
  seek(id: string, time: number): void {
    this.play(id, true);
    while (this.time < Math.min(time, this.current.duration) - 1e-7) this.update(Math.min(1 / 120, time - this.time), true);
  }
}
