import * as THREE from 'three';
import type { GrootSound } from './grootSound';
import type { MonsterTreeRig } from './rig';
import type { GrootEvent, GrootFxHooks, GrootMeasure } from './grootAnimation';
import { GrootForest, forestRandom, leafGeometry } from './grootForest';
import { extractGrootWood, type GrootWoodStock } from './grootWood';
import { GrootToxin } from './grootToxin';
import { GrootSwingVine } from './grootSwingVine';
import { GrootLivingForms } from './grootLivingForms';
import { forestGround } from './grootTerrain';
import { GrootCompanion } from './grootCompanion';
import { GrootVitality } from './grootVitality';
import { FAULTLINE } from './grootFaultline';
import { GrootGroundWake } from './grootGroundWake';
import { GrootWeather } from './grootWeather';
import { GrootSeedCover } from './grootSeedCover';
import { GrootSkin } from './grootSkin';
import { GrootRelics } from './grootRelics';
import { GrootRiver } from './grootRiver';
import { isB2 } from './grootImportedMotion';
import { GrootIceTheme, ICE_GLOW, ICE_SPORE, BLOOM_GLOW, BLOOM_SPORE, type GrootSkillTheme } from './grootIceTheme';

const clamp = THREE.MathUtils.clamp;
const ease = (x: number): number => { const t=clamp(x,0,1);return t*t*(3-2*t); };
const SEGMENTS=32, PARTICLES=768;
export const GROOT_REACH={pierce:1.55,sweep:1.28,ground:1.65,rootfall:2.35,gather:1.15} as const;
const TOXIC_KINDS=new Set(['pierce','sweep','seismic','ground','gather','seed','roar']);

/** Pooled organic growth. Every visible piece starts hidden and has fixed storage. */
export class GrootEffects implements GrootFxHooks {
  sound?:GrootSound;
  readonly themes=new GrootIceTheme();
  castTheme:GrootSkillTheme='wood';
  private readonly particleIce=new Uint8Array(PARTICLES);
  readonly group=new THREE.Group();
  readonly forest: GrootForest;
  readonly particles: THREE.Points;
  readonly tendrils: THREE.InstancedMesh[]=[];
  readonly bloomLeaves=new THREE.InstancedMesh(leafGeometry(),new THREE.MeshStandardMaterial({color:'#71b83b',roughness:.82,side:THREE.DoubleSide}),128);
  readonly woodStock: GrootWoodStock[];
  readonly toxin:GrootToxin;
  readonly swingVine:GrootSwingVine;
  readonly livingForms:GrootLivingForms;
  readonly companion:GrootCompanion;
  readonly vitality:GrootVitality;
  readonly groundWake:GrootGroundWake;
  readonly weather:GrootWeather;
  readonly seedCover:GrootSeedCover;
  readonly skin:GrootSkin;
  readonly relics:GrootRelics;
  readonly river:GrootRiver;
  private readonly toxicWood:THREE.InstancedMesh[];
  actor?: THREE.Object3D;
  private readonly actorMatrix=new THREE.Matrix4();
  private readonly inverseActor=new THREE.Matrix4();
  private readonly pathRight=new THREE.Vector3();
  private readonly pathLeft=new THREE.Vector3();
  private twoHands=false;
  private activeEffect='';
  private activeClip='';
  private readonly pathChest=new THREE.Vector3();
  private readonly eventFacing=new THREE.Vector3(1,0,0);
  private readonly facing=new THREE.Vector3(1,0,0);
  private readonly actorPosition=new THREE.Vector3();
  private readonly centres=new Float32Array((SEGMENTS+1)*3);
  private readonly tangent=new THREE.Vector3();
  private readonly up=new THREE.Vector3(0,1,0);
  private readonly roll=new THREE.Quaternion();
  private readonly positions=new Float32Array(PARTICLES*3);
  private readonly colors=new Float32Array(PARTICLES*3);
  private readonly sizes=new Float32Array(PARTICLES);
  private readonly alphas=new Float32Array(PARTICLES);
  private readonly velocity=new Float32Array(PARTICLES*3);
  private readonly age=new Float32Array(PARTICLES);
  private readonly life=new Float32Array(PARTICLES);
  private readonly kind=new Uint8Array(PARTICLES);
  private readonly landed=new Uint8Array(PARTICLES);
  readonly woodDebris: THREE.InstancedMesh;
  private readonly dummy=new THREE.Object3D();
  private readonly random=forestRandom(2349);
  private cursor=0;
  private ambient=0;
  private clock=0;
  private impactAge=99;
  private impactKind='';
  private readonly anchor=new THREE.Vector3();
  private readonly left=new THREE.Vector3();
  private readonly right=new THREE.Vector3();
  private readonly chest=new THREE.Vector3();
  private readonly p=new THREE.Vector3();
  private readonly previousHand=new THREE.Vector3();
  private previousValid=false;
  private readonly sporeGold=new THREE.Color('#ffdda0');
  private readonly spiritJade=new THREE.Color('#a6f8db');

  constructor(readonly rig: MonsterTreeRig,readonly height: number,clips:THREE.AnimationClip[]) {
    this.group.name='groot-living-wood-effects';this.group.visible=false;
    this.bloomLeaves.name='bloom-skill-vine-leaves';this.bloomLeaves.count=0;this.bloomLeaves.visible=false;this.bloomLeaves.frustumCulled=false;this.group.add(this.bloomLeaves);
    this.woodStock=extractGrootWood(rig);
    this.forest=new GrootForest(height);this.group.add(this.forest.group);
    this.river=new GrootRiver(height,this.forest.terrain.ground.material);this.group.add(this.river.group);
    this.forest.terrain.riverCell=(cx,cz)=>this.river.createCell(cx,cz);
    this.forest.terrain.stream.fade(this.river.surface.material);
    this.seedCover=new GrootSeedCover(height);this.group.add(this.seedCover.group);
    this.groundWake=new GrootGroundWake(height);this.group.add(this.groundWake.group);
    this.weather=new GrootWeather(height);this.group.add(this.weather.group);
    this.companion=new GrootCompanion(rig,height,clips,this.woodStock[0].geometry);this.group.add(this.companion.root,this.companion.revealFx.group);
    for(let i=0;i<this.woodStock.length;i++){
      const geometry=this.woodStock[i].geometry;
      // Share the character's actual material: no tint, green emissive, or substitute bark map.
      const mesh=new THREE.InstancedMesh(geometry,rig.shell.material,216);mesh.count=0;mesh.visible=false;mesh.frustumCulled=false;
      mesh.castShadow=true;mesh.receiveShadow=true;
      mesh.name=`groot-source-branch-${i}`;
      this.tendrils.push(mesh);this.group.add(mesh);
    }
    this.livingForms=new GrootLivingForms(rig,height,this.woodStock);this.group.add(this.livingForms.group);
    this.toxicWood=[...this.tendrils,this.livingForms.faultline];
    this.toxin=new GrootToxin(height,this.toxicWood);this.group.add(this.toxin.group);
    this.swingVine=new GrootSwingVine(height,this.woodStock[this.woodStock.length-1],rig.shell.material);this.group.add(this.swingVine.group);
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.BufferAttribute(this.positions,3));geometry.setAttribute('color',new THREE.BufferAttribute(this.colors,3));
    geometry.setAttribute('aSize',new THREE.BufferAttribute(this.sizes,1));geometry.setAttribute('aAlpha',new THREE.BufferAttribute(this.alphas,1));
    const material=new THREE.ShaderMaterial({transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,vertexColors:true,
      uniforms:{uHeight:{value:height}},
      vertexShader:'attribute float aSize; attribute float aAlpha; varying vec3 vColor; varying float vAlpha; void main(){vColor=color;vAlpha=aAlpha;vec4 p=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*p;gl_PointSize=clamp(aSize*600./max(.1,-p.z),1.,60.);}',
      fragmentShader:'varying vec3 vColor; varying float vAlpha; void main(){float r=length(gl_PointCoord-.5)*2.;float core=exp(-r*r*24.);float glow=exp(-r*r*5.)*.23;gl_FragColor=vec4(vColor,(core+glow)*vAlpha*smoothstep(1.,.7,r));}' });
    this.particles=new THREE.Points(geometry,material);this.particles.visible=false;this.particles.frustumCulled=false;this.group.add(this.particles);
    this.woodDebris=new THREE.InstancedMesh(this.woodStock[Math.min(2,this.woodStock.length-1)].geometry,rig.shell.material,96);
    this.woodDebris.name='groot-source-wood-debris';
    this.woodDebris.visible=false;this.woodDebris.count=0;this.woodDebris.frustumCulled=false;this.group.add(this.woodDebris);
    this.vitality=new GrootVitality(rig);
    this.skin=new GrootSkin(rig,this.vitality,height);
    this.relics=new GrootRelics(height,this.skin,this.forest.terrain.world);this.group.add(this.relics.group);
    this.group.traverse(object=>{object.userData.isHighlight=true;});
  }

  reset(): void {
    this.bloomLeaves.count=0;this.bloomLeaves.visible=false;
    this.forest.terrain.cancelPendingImpacts();
    this.toxin.reset();
    this.swingVine.reset();
    this.livingForms.reset();
    this.life.fill(0);this.landed.fill(0);this.alphas.fill(0);this.impactAge=99;this.previousValid=false;this.woodDebris.count=0;this.woodDebris.visible=false;
    for(const mesh of this.tendrils){mesh.visible=false;mesh.count=0;}
  }

  private joint(name: string,out: THREE.Vector3): void {
    if(!(this.skin.committed==='ice'&&this.skin.ice?.socketWorld(name,out)))this.rig.bones[name].getWorldPosition(out);this.group.worldToLocal(out);
  }
  begin(id:string,measure:GrootMeasure):void{
    this.activeClip=id;this.sound?.begin(id,measure);
    if(isB2(id))return; // B2 never dispatches an Ice attack theme.
    this.castTheme=this.skin.committed==='ice'?'ice':this.skin.committed==='abies'?'bloom':'wood';
    for(const mesh of [...this.tendrils,this.woodDebris,this.swingVine.wood,this.livingForms.faultline,this.livingForms.faultlineThorns,this.livingForms.jadeThorns,this.livingForms.cocoon])this.themes.set(mesh,this.castTheme);
    this.toxin.setIce(this.castTheme==='ice');
    if(id==='regrowth')this.themes.set(this.livingForms.armour,this.castTheme);
    if(id==='spore-bloom'){this.themes.tree(this.companion.root,this.castTheme);this.themes.tree(this.companion.revealFx.group,this.castTheme);}
  }
  step(foot:'L_Foot'|'R_Foot',running=false):void {
    this.joint(foot,this.p);if(!isB2(this.activeClip))this.groundWake.step(this.p,this.facing);
    this.group.localToWorld(this.p);this.sound?.step(this.p,running);
  }

  event(event: GrootEvent): void {
    if(isB2(this.activeClip))return;
    this.group.updateWorldMatrix(true,false);
    if(this.actor){this.actor.updateWorldMatrix(true,false);this.actorMatrix.copy(this.group.matrixWorld).invert().multiply(this.actor.matrixWorld);this.facing.set(1,0,0).transformDirection(this.actorMatrix);}
    this.joint(event.bone==='R_Hand'?'R_Digit3_3':event.bone,this.anchor);this.impactAge=0;this.impactKind=event.kind;
    if(event.kind==='ground'||event.kind==='freeze')this.anchor.y=forestGround(this.anchor.x,this.anchor.z,this.height)+.015*this.height;
    if(event.kind==='seismic'){
      this.livingForms.quake(this.actorMatrix);
      this.anchor.setFromMatrixPosition(this.actorMatrix).addScaledVector(this.facing,FAULTLINE.offsetM);
      this.anchor.y=forestGround(this.anchor.x,this.anchor.z,this.height)+.015*this.height;
    }
    this.eventFacing.copy(this.facing);
    if(event.kind==='pierce')this.anchor.addScaledVector(this.facing,this.height*GROOT_REACH.pierce);
    if(event.kind==='sweep'){this.anchor.addScaledVector(this.facing,this.height*.9);this.anchor.x+=this.facing.z*this.height*.6;this.anchor.z-=this.facing.x*this.height*.6;}
    if(event.kind==='gather'){this.joint('Spine02',this.anchor);this.anchor.addScaledVector(this.facing,this.height*.72);this.anchor.y=forestGround(this.anchor.x,this.anchor.z,this.height)+.15*this.height;}
    if(event.kind==='summon'){
      // Theme only summoned moths/trails/lights, never forest moonshafts or tree materials.
      const atmosphere=this.forest.atmosphere;
      for(const spirit of atmosphere.spirits)this.themes.tree(spirit.root,this.castTheme);
      this.themes.set(atmosphere.trails,this.castTheme);this.forest.summon(18);
    }
    if(event.kind==='bloom')this.companion.reveal(this.anchor);
    if(event.kind==='seed'&&this.activeClip==='seed-sanctum'){
      // Life Seeds emerge in front of the chest, never from a hand swept behind the back.
      this.joint('Spine02',this.anchor);this.anchor.addScaledVector(this.facing,this.height*.36);
    }
    if(event.kind!=='bloom'||this.companion.enabled){this.p.copy(this.anchor);this.group.localToWorld(this.p);this.sound?.impact(event.kind,event.time,this.p);}
    this.actorPosition.setFromMatrixPosition(this.actorMatrix);
    this.forest.terrain.strike(event.kind,event.kind==='ground'||event.kind==='freeze'?this.anchor:this.actorPosition,this.facing,event.time,this.activeClip==='root-charge'?GROOT_REACH.rootfall:GROOT_REACH.ground);
    if(TOXIC_KINDS.has(event.kind))this.toxin.impactAt(this.anchor,event.kind==='ground'||event.kind==='seismic'||event.kind==='gather'||event.kind==='roar',event.kind==='seismic'?this.facing:undefined);
    const rootfall=this.activeClip==='root-charge'&&event.kind==='ground';
    const count=rootfall?190:event.kind==='ground'?110:event.kind==='bloom'?240:event.kind==='taken'?45:65;
    for(let i=0;i<count;i++)this.emit(this.anchor,event.kind==='taken'?2:event.kind==='ground'||event.kind==='pierce'||event.kind==='sweep'?1:event.kind==='gather'?3:event.kind==='seed'?4:0,rootfall?1.6:1);
  }

  private emit(origin: THREE.Vector3,kind: number,power: number): void {
    const i=this.cursor++%PARTICLES,at=i*3,h=this.height,r=this.random,angle=r()*Math.PI*2;
    this.positions[at]=origin.x+(r()-.5)*h*.025;this.positions[at+1]=origin.y+(r()-.5)*h*.02;this.positions[at+2]=origin.z+(r()-.5)*h*.025;
    const speed=(.08+r()*.28)*h*power;
    this.velocity[at]=Math.cos(angle)*speed;this.velocity[at+1]=(.10+r()*.25)*h*power;this.velocity[at+2]=Math.sin(angle)*speed;
    if(kind===2){this.velocity[at]=-.3*h*r();this.velocity[at+1]=r()*.13*h;}
    if(kind===3){this.positions[at]+=Math.cos(angle)*h*.6;this.positions[at+2]+=Math.sin(angle)*h*.6;this.velocity[at]=-Math.cos(angle)*h*.7;this.velocity[at+1]=.05*h;this.velocity[at+2]=-Math.sin(angle)*h*.7;}
    if(kind===4){this.velocity[at]=h*(2.3+r()*.45);this.velocity[at+1]=h*.16;this.velocity[at+2]=(r()-.5)*h*.6;}
    if(kind===2||kind===4){const x=this.velocity[at],z=this.velocity[at+2];this.velocity[at]=this.facing.x*x-this.facing.z*z;this.velocity[at+2]=this.facing.z*x+this.facing.x*z;}
    this.age[i]=0;this.life[i]=kind===4?3.5+r()*.8:kind===1?.6+r()*.55:1.0+r()*1.2;this.kind[i]=kind;this.landed[i]=0;
    this.sizes[i]=h*(kind===1?.012:.016+r()*.02);
    this.particleIce[i]=this.castTheme==='ice'?1:this.castTheme==='bloom'?2:0;
    (r()>.15?(this.particleIce[i]===1?ICE_SPORE:this.particleIce[i]===2?BLOOM_SPORE:this.sporeGold):(this.particleIce[i]===1?ICE_GLOW:this.particleIce[i]===2?BLOOM_GLOW:this.spiritJade)).toArray(this.colors,at);
  }

  private growWood(index: number,mode: string,growth: number,time: number): void {
    const h=this.height;if(growth<=.005)return;
    const a=index*2.399, ca=Math.cos(a),sa=Math.sin(a);
    const hand=this.twoHands&&index%2===1?this.pathLeft:this.pathRight;
    for(let ring=0;ring<=SEGMENTS;ring++){
      const s=ring/SEGMENTS;
      let x=0,y=0,z=0;
      if(mode==='root-spear'){
        x=hand.x+s*h*GROOT_REACH.pierce;y=hand.y+Math.sin(s*9+a)*h*.018*s;z=hand.z+Math.cos(s*9+a)*h*.030*s;
      }else if(mode==='vine-sweep'){
        const whip=Math.sin(time*2.2-s*2.8)*.50;
        x=hand.x+s*h*GROOT_REACH.sweep;y=hand.y+Math.sin(s*4+a)*h*.055*s;
        z=this.pathRight.z+(whip*s+Math.sin(s*8+a)*.018)*h;
      }else if(mode==='sanctuary'){
        const theta=1.3+index/11*3.7+s*(index%2===0?.7:-.45);
        const bulge=.35*(1-s)+Math.sin(s*Math.PI)*.32+.035*s;
        x=Math.cos(theta)*bulge*h-.045*h;z=Math.sin(theta)*bulge*h;
        y=s*h*1.12;
      }else if(mode==='root-stomp'){
        const rootfall=this.activeClip==='root-charge',radius=(rootfall?GROOT_REACH.rootfall:GROOT_REACH.ground)*(this.activeEffect==='freeze'?.48:1);
        x=this.anchor.x+(ca*this.eventFacing.x-sa*this.eventFacing.z)*s*h*radius;z=this.anchor.z+(ca*this.eventFacing.z+sa*this.eventFacing.x)*s*h*radius;
        y=h*(.012+Math.sin(s*Math.PI)*(this.activeEffect==='freeze'?.06:rootfall?.36:.20)+Math.sin(s*13+a)*.018*s);
      }else if(mode==='regrowth'){
        const theta=a+s*6-time*.6;
        x=this.pathChest.x+Math.cos(theta)*h*.13;z=this.pathChest.z+Math.sin(theta)*h*.13;
        y=this.pathChest.y-h*.28+s*h*.42;
      }else if(mode==='verdant-embrace'){
        const angle=a-s*.55,r=GROOT_REACH.gather*(1-s*.72);
        x=this.pathChest.x+h*.72+Math.cos(angle)*r*h;z=this.pathChest.z+Math.sin(angle)*r*h;
        y=(.012+Math.sin(s*Math.PI)*.17)*h;
      }
      this.p.set(x,y,z);if(mode!=='root-stomp')this.p.applyMatrix4(this.actorMatrix);else this.p.y+=forestGround(x,z,h);
      this.p.toArray(this.centres,ring*3);
    }
    // Overlapping original spurs follow the path with UNIFORM scale. Never stretch one small
    // branch into a metre-long ribbon; its forks, silhouette and bark facets stay intact.
    for(let section=0;section<18;section++){
      const born=ease((growth*20-section)/3);if(born<=.001)continue;
      const u=section/18*SEGMENTS,lo=Math.floor(u),mix=u-lo,c=lo*3;
      this.dummy.position.set(
        this.centres[c]+(this.centres[c+3]-this.centres[c])*mix,
        this.centres[c+1]+(this.centres[c+4]-this.centres[c+1])*mix,
        this.centres[c+2]+(this.centres[c+5]-this.centres[c+2])*mix);
      this.tangent.set(this.centres[c+3]-this.centres[c],this.centres[c+4]-this.centres[c+1],this.centres[c+5]-this.centres[c+2]);
      const sectionLength=this.tangent.length()*SEGMENTS/18;
      this.tangent.normalize();this.dummy.quaternion.setFromUnitVectors(this.up,this.tangent);
      this.roll.setFromAxisAngle(this.up,index*2.399+section*2.1);this.dummy.quaternion.multiply(this.roll);
      this.dummy.scale.setScalar(sectionLength*1.65*born*(1-section/18*.24));this.dummy.updateMatrix();
      const mesh=this.tendrils[(index+section)%this.tendrils.length];
      mesh.setMatrixAt(mesh.count++,this.dummy.matrix);mesh.visible=true;
    }
  }

  frame(dt: number,id: string,time: number,measure: GrootMeasure): void {
    this.activeClip=id;
    const animationOnly=isB2(id);
    this.group.visible=true;this.particles.visible=!animationOnly;this.clock+=dt;this.impactAge+=dt;
    this.group.updateWorldMatrix(true,false);
    if(this.actor){this.actor.updateWorldMatrix(true,false);this.actorMatrix.copy(this.group.matrixWorld).invert().multiply(this.actor.matrixWorld);}else this.actorMatrix.identity();
    this.skin.syncPose(0,true);
    this.inverseActor.copy(this.actorMatrix).invert();this.facing.set(1,0,0).transformDirection(this.actorMatrix);
    this.actorPosition.setFromMatrixPosition(this.actorMatrix);
    this.joint('R_Digit3_3',this.right);this.joint('L_Digit3_3',this.left);this.joint('Spine02',this.chest);
    this.p.copy(this.actorPosition);this.group.localToWorld(this.p);this.sound?.frame(time,this.p);
    this.pathRight.copy(this.right).applyMatrix4(this.inverseActor);this.pathLeft.copy(this.left).applyMatrix4(this.inverseActor);this.pathChest.copy(this.chest).applyMatrix4(this.inverseActor);
    this.twoHands=measure.sourceFile?.includes('2H')??false;
    this.activeEffect=isB2(id)?'':measure.effect??'';
    this.joint('R_Digit3_1',this.p);this.swingVine.update(id,time,measure,this.p,this.actorMatrix);
    this.forest.terrain.advanceImpacts(time);
    this.forest.update(dt,id==='spirit-greeting'||id==='spirit-call'?this.right:undefined,ease(time/.85)*(1-ease((time-3.1)/1.1)),this.actorPosition,this.facing);
    this.companion.update(dt,this.actorPosition,this.facing,id);
    this.vitality.update(dt);
    this.skin.syncPose(0,true);
    this.groundWake.update(dt);
    this.seedCover.update(dt);
    this.weather.update(dt,this.actorPosition);
    while(this.forest.terrain.consumeTreeDebris(this.p))if(!animationOnly)for(let i=0;i<36;i++)this.emit(this.p,1,1.3);
    const event=measure.events[0],stop=event?.time??1;
    let growth=0,count=0;
    const visual=this.activeEffect==='pierce'?'root-spear':this.activeEffect==='sweep'?'vine-sweep':this.activeEffect==='heal'?'regrowth':this.activeEffect==='gather'?'verdant-embrace':this.activeEffect==='shield'?'sanctuary':id;
    if(visual==='root-spear'||visual==='vine-sweep'||this.activeEffect==='seed'){
      growth=ease((time-(stop-.52))/.52)*(1-ease((time-stop-.16)/.72));count=5;
    }else if(visual==='sanctuary'){
      growth=ease((time-stop+.85)/.85)*(1-ease((time-stop-.35)/.9));count=12;
    }else if((this.activeEffect==='ground'||this.activeEffect==='roar'||this.activeEffect==='freeze'||id==='root-charge')&&(this.impactKind==='ground'||this.impactKind==='roar'||this.impactKind==='freeze')){
      growth=ease(this.impactAge/.26)*(1-ease((this.impactAge-.65)/.9));count=this.activeEffect==='freeze'?10:id==='root-charge'?30:this.activeEffect==='roar'?20:18;
    }else if(visual==='regrowth'){
      growth=ease((time-stop+.7)/.7)*(1-ease((time-stop-.4)/1));count=7;
    }else if(visual==='verdant-embrace'){
      growth=ease((time-stop+.7)/.7)*(1-ease((time-stop-.4)/1));count=14;
    }
    const mode=this.activeEffect==='ground'||this.activeEffect==='roar'||this.activeEffect==='freeze'||id==='root-charge'?'root-stomp':this.activeEffect==='seed'?'root-spear':visual;
    for(const mesh of this.tendrils){mesh.count=0;mesh.visible=false;}
    if(id!=='vine-sweep'&&id!=='sanctuary'&&id!=='regrowth'&&id!=='seed-sanctum')for(let i=0;i<count;i++)this.growWood(i,mode,growth,time);
    // Dedicated silhouettes replace the old shared spear/spiral layout for these three skills.
    if(id==='vine-sweep'||id==='sanctuary'||id==='regrowth'||id==='seed-sanctum')for(const mesh of this.tendrils){mesh.count=0;mesh.visible=false;}
    this.livingForms.update(id,time,stop,this.actorMatrix,dt);
    // Bounded leaf pairs on the existing animated vine paths; no new timing/collision.
    this.bloomLeaves.count=0;
    if(this.castTheme==='bloom'&&!animationOnly){
      for(const mesh of [...this.tendrils,this.swingVine.wood])if(mesh.visible)for(let i=0;i<mesh.count&&this.bloomLeaves.count<128;i+=3){
        mesh.getMatrixAt(i,this.dummy.matrix);this.dummy.matrix.decompose(this.dummy.position,this.dummy.quaternion,this.dummy.scale);
        this.dummy.scale.multiplyScalar(.48);this.dummy.updateMatrix();this.bloomLeaves.setMatrixAt(this.bloomLeaves.count++,this.dummy.matrix);
      }
    }
    this.bloomLeaves.visible=this.bloomLeaves.count>0;this.bloomLeaves.instanceMatrix.needsUpdate=true;
    for(const mesh of this.tendrils)if(mesh.visible)mesh.instanceMatrix.needsUpdate=true;
    this.toxin.update(dt,this.toxicWood,TOXIC_KINDS.has(this.activeEffect));
    // Per-clip speed calibration. Quiet gestures retain a few motes; fast strikes do not smear.
    const speed=this.previousValid?this.right.distanceTo(this.previousHand)/Math.max(.00001,dt)/this.height:0;
    this.previousHand.copy(this.right);this.previousValid=true;
    const moving=speed>Math.max(.025,measure.p95HandSpeedH*.56);
    const bloom=(this.activeEffect==='bloom'||this.activeEffect==='heal'||this.activeEffect==='freeze')&&time>stop-.5&&time<stop+.8;
    // B2 retains measured motion cues, but emits neither attack VFX nor shared hand motes.
    this.ambient=animationOnly?0:this.ambient+dt*(bloom?65:moving?14:id==='grove-idle'?3:6);
    while(this.ambient>=1){
      this.ambient--;
      this.p.copy(this.random()>.5?this.right:this.left);
      if(id==='grove-idle'){this.p.x+=(this.random()-.5)*this.height*.5;this.p.y=forestGround(this.p.x,this.p.z,this.height)+.15*this.height;}
      this.emit(this.p,0,bloom?.55:.18);
    }
    let debrisCount=0;const drag=Math.exp(-dt*1.9);
    for(let i=0;i<PARTICLES;i++){
      if(this.life[i]<=0){this.alphas[i]=0;continue;}
      this.age[i]+=dt;const life=this.age[i]/this.life[i];
      if(life>=1){this.life[i]=0;this.alphas[i]=0;continue;}
      const at=i*3;
      this.velocity[at]*=drag;this.velocity[at+2]*=drag;
      this.velocity[at+1]+=dt*this.height*(this.kind[i]===1?-.52:this.kind[i]===4?-1.15:.025);
      this.positions[at]+=this.velocity[at]*dt;this.positions[at+1]+=this.velocity[at+1]*dt;this.positions[at+2]+=this.velocity[at+2]*dt;
      const ground=forestGround(this.positions[at],this.positions[at+2],this.height)+.01*this.height;
      if(this.kind[i]===4&&!this.landed[i]&&this.positions[at+1]<=ground){
        this.positions[at+1]=ground;this.velocity[at]=this.velocity[at+1]=this.velocity[at+2]=0;this.landed[i]=1;
        // One in four solid cores becomes a cover patch. Nearby landings merge, so a volley makes
        // a readable thicket rather than 65 overlapping instance fields.
        if((i&3)===0){this.p.fromArray(this.positions,at);this.seedCover.plant(this.p,this.particleIce[i]===1);}
      }else this.positions[at+1]=Math.max(ground,this.positions[at+1]);
      // Physical splinters are source wood, not green/glowing leaf sprites. Seeds alone retain
      // a faint life-spore halo; their moving solid core uses the same source mesh as debris.
      this.alphas[i]=this.kind[i]>0&&this.kind[i]<4?0:ease(life*12)*(1-ease((life-.45)/.55));
      if(this.kind[i]>0&&debrisCount<96){
        this.dummy.position.fromArray(this.positions,at);this.dummy.rotation.set(this.clock*2+i,i*.71,this.clock+i*.3);
        this.dummy.scale.setScalar(this.height*(this.kind[i]===4?.045:.035)*(1-ease((life-.65)/.35)));this.dummy.updateMatrix();this.woodDebris.setMatrixAt(debrisCount++,this.dummy.matrix);
      }
    }
    this.woodDebris.count=debrisCount;this.woodDebris.visible=debrisCount>0;this.woodDebris.instanceMatrix.needsUpdate=true;
    this.particles.geometry.getAttribute('position').needsUpdate=true;this.particles.geometry.getAttribute('color').needsUpdate=true;
    this.particles.geometry.getAttribute('aSize').needsUpdate=true;this.particles.geometry.getAttribute('aAlpha').needsUpdate=true;
  }
}
