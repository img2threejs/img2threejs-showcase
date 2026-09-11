import * as THREE from 'three';
import type { MonsterTreeRig } from './rig';
import type { GrootVitality } from './grootVitality';
import { GrootSourceForm } from './grootSourceForm';
import { BLOOM_PROFILE } from './grootBloomBinding';
import { ICE_PROFILE } from './grootIceBinding';
import { patchFormReveal } from './grootFormReveal';
import type { GrootSourceQuality } from './grootSourceLod';
export type GrootOutfit='original'|'abies'|'ice';

export const RELIC_SKIN_BITS={heart:1,sap:2,crown:4} as const;

interface SkinLook {
  bark:THREE.Color;
  emissive:THREE.Color;
  roughness:number;
  metalness:number;
  emissiveIntensity:number;
  veinLow:THREE.Color;
  veinHigh:THREE.Color;
  eyeCore:THREE.Color;
  eyeHalo:THREE.Color;
  veinPower:number;
  crown:number;
  dye:number;
  elder:number;
}

const copyLook=(look:SkinLook):SkinLook=>({
  bark:look.bark.clone(),emissive:look.emissive.clone(),roughness:look.roughness,
  metalness:look.metalness,emissiveIntensity:look.emissiveIntensity,
  veinLow:look.veinLow.clone(),veinHigh:look.veinHigh.clone(),eyeCore:look.eyeCore.clone(),
  eyeHalo:look.eyeHalo.clone(),veinPower:look.veinPower,crown:look.crown,dye:look.dye,elder:look.elder,
});

/** Quest accents and bounded three-form selection. Only the player's private bark clone is dyed. */
export class GrootSkin {
  readonly crown:THREE.InstancedMesh;
  elder:GrootSourceForm;
  onChange?:()=>void;
  ice:GrootSourceForm|null=null;
  requested:GrootOutfit='original';
  committed:GrootOutfit='original';
  safeToSwitch:()=>boolean=()=>true;
  sourceRecovering:()=>boolean=()=>false;
  private pair:{from:GrootOutfit;to:GrootOutfit;progress:number}|null=null;
  private generation=0;
  private quality:GrootSourceQuality='high';
  setQuality(quality:GrootSourceQuality):void{
    if(this.disposed)return;this.quality=quality;this.elder.requestQuality(quality);this.ice?.requestQuality(quality);
  }
  get qualityStatus():string{
    const form=this.form(this.requested);
    if(form?.qualityError&&this.quality==='medium')return 'Source quality failed · current mesh retained; select 70% again to retry.';
    if(form&&form.quality!==this.quality)return 'Source quality queued · waiting for load / safe idle boundary.';
    return this.quality==='medium'?'70%: medium source mesh (Original unchanged), softer shadows, 192px / 8Hz reflections.':'85% / 100%: high source mesh, original shadows, 384px / 12Hz reflections.';
  }
  private readonly originalProgress={value:1};
  private readonly originalDirection={value:1};
  private readonly shadowMaterials:THREE.Material[]=[];
  private readonly material:THREE.MeshStandardMaterial;
  private readonly sharedMaterial:THREE.MeshStandardMaterial;
  private readonly previousDepth:THREE.Material|undefined;
  private readonly previousDistance:THREE.Material|undefined;
  private disposed=false;
  private readonly base:SkinLook;
  private from:SkinLook;
  private to:SkinLook;
  private current:SkinLook;
  private transition=1;
  private maskValue=0;
  private readonly dyeAmount={value:0};
  private readonly dyeColor={value:new THREE.Color()};
  constructor(private readonly rig:MonsterTreeRig,private readonly vitality:GrootVitality,private readonly height:number){
    if(!(rig.shell.material instanceof THREE.MeshStandardMaterial))throw new Error('Groot skin requires the shared MeshStandardMaterial');
    // The old bark material is also used by forest spells. Dissolve only the player's own shell.
    const shared=rig.shell.material;this.sharedMaterial=shared;this.previousDepth=rig.shell.customDepthMaterial;this.previousDistance=rig.shell.customDistanceMaterial;this.material=shared.clone();this.material.onBeforeCompile=shared.onBeforeCompile;this.material.customProgramCacheKey=shared.customProgramCacheKey;rig.shell.material=this.material;
    const compile=this.material.onBeforeCompile,cacheKey=this.material.customProgramCacheKey();
    this.material.onBeforeCompile=(shader,renderer)=>{
      compile.call(this.material,shader,renderer);
      shader.uniforms.relicDye=this.dyeAmount;shader.uniforms.relicTint=this.dyeColor;
      shader.fragmentShader='uniform float relicDye; uniform vec3 relicTint;\n'+shader.fragmentShader;
      shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
        float barkLuminance=dot(diffuseColor.rgb,vec3(.2126,.7152,.0722));
        diffuseColor.rgb=mix(diffuseColor.rgb,relicTint*(.28+barkLuminance*1.8),relicDye);
      `);
    };
    this.material.customProgramCacheKey=()=>cacheKey+'-elder-moonroot-dye-v2';this.material.needsUpdate=true;
    this.base={
      bark:this.material.color.clone(),emissive:this.material.emissive.clone(),roughness:this.material.roughness,
      metalness:this.material.metalness,emissiveIntensity:this.material.emissiveIntensity,
      veinLow:new THREE.Color('#0d66d9'),veinHigh:new THREE.Color('#73e6ff'),
      eyeCore:new THREE.Color('#97eaff'),eyeHalo:new THREE.Color('#65caff'),veinPower:1,crown:0,dye:0,elder:0,
    };
    this.current=copyLook(this.base);this.from=copyLook(this.base);this.to=copyLook(this.base);
    const geometry=new THREE.OctahedronGeometry(.018,0);
    const material=new THREE.MeshStandardMaterial({color:'#6fb99a',emissive:'#2b9d7e',emissiveIntensity:.72,roughness:.56,metalness:.04,transparent:true,opacity:0,depthWrite:false});
    this.crown=new THREE.InstancedMesh(geometry,material,9);this.crown.name='elder-moonroot-living-crown';this.crown.count=9;this.crown.visible=false;this.crown.castShadow=false;this.crown.frustumCulled=false;
    const dummy=new THREE.Object3D();
    for(let i=0;i<9;i++){
      const a=i/9*Math.PI*2,r=.012+(i%3)*.009;
      dummy.position.set(Math.cos(a)*r,.008+(i%3)*.012,Math.sin(a)*r);
      dummy.rotation.set((i%2?-.18:.18),a,(i%3-1)*.12);dummy.scale.set(.62+(i%3)*.16,1+(i%2)*.35,.62+(i%3)*.16);dummy.updateMatrix();this.crown.setMatrixAt(i,dummy.matrix);
    }
    this.crown.instanceMatrix.needsUpdate=true;
    const socket=rig.sockets.crown;if(!socket)throw new Error('Missing measured Groot crown socket');socket.add(this.crown);
    this.elder=new GrootSourceForm(rig,height,BLOOM_PROFILE);patchFormReveal(this.material,this.originalProgress,this.originalDirection,.955);
    const depth=new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking}),distance=new THREE.MeshDistanceMaterial();
    patchFormReveal(depth,this.originalProgress,this.originalDirection,.955);patchFormReveal(distance,this.originalProgress,this.originalDirection,.955);rig.shell.customDepthMaterial=depth;rig.shell.customDistanceMaterial=distance;this.shadowMaterials.push(depth,distance);
    void this.elder.ready.then(()=>this.onChange?.());this.apply(this.current);
  }
  get mask():number{return this.maskValue;}
  get complete():boolean{return this.maskValue===7;}
  collect(bit:number):boolean{
    if(![1,2,4].includes(bit)||(this.maskValue&bit)!==0)return false;
    this.maskValue|=bit;this.from=copyLook(this.current);this.to=this.target(this.maskValue);this.transition=0;if(this.complete)this.request('ice');this.onChange?.();return true;
  }
  /** Cast admission must settle this pair before choosing a cast/socket owner. */
  get transitioning():boolean{return this.pair!==null;}
  get selectedSource():boolean{return this.requested!=='original';}
  selectSource(value:boolean):void{this.request(value?'abies':'original');}
  toggle():void{this.selectSource(!this.selectedSource);}
  request(target:GrootOutfit):boolean{
    if(this.disposed||!['original','abies','ice'].includes(target)||(target==='ice'&&!this.complete))return false;
    this.requested=target;
    if(target==='abies'&&this.elder.error){this.elder.dispose();const form=this.elder=new GrootSourceForm(this.rig,this.height,BLOOM_PROFILE);void form.ready.then(()=>{if(!this.disposed&&form===this.elder)this.onChange?.();});}
    if(target==='ice'&&(!this.ice||this.ice.error)){
      this.ice?.dispose();const token=++this.generation;
      const form=this.ice=new GrootSourceForm(this.rig,this.height,ICE_PROFILE);
      void form.ready.then(()=>{if(!this.disposed&&token===this.generation)this.onChange?.();});
    }
    this.form(target)?.requestQuality(this.quality);
    this.onChange?.();return true;
  }
  private form(id:GrootOutfit):GrootSourceForm|null{return id==='abies'?this.elder:id==='ice'?this.ice:null;}
  private readyFor(id:GrootOutfit):boolean{return id==='original'||!!this.form(id)?.isReady;}
  reset():void{this.generation++;if(this.ice&&!this.ice.isReady){this.ice.dispose();this.ice=null;}this.maskValue=0;this.requested=this.committed='original';this.pair=null;this.elder.revealDirection.value=1;this.elder.setGrowth(0);if(this.ice){this.ice.revealDirection.value=1;this.ice.setGrowth(0);}this.transition=1;this.current=copyLook(this.base);this.from=copyLook(this.base);this.to=copyLook(this.base);this.apply(this.current);this.syncPose();this.onChange?.();}
  update(dt:number):void{
    if(this.transition<1){this.transition=Math.min(1,this.transition+Math.max(0,dt)/(this.complete?1.45:.9));const t=1-(1-this.transition)**3;this.mix(this.from,this.to,t,this.current);this.apply(this.current);}
    if(this.disposed)return;
    const safe=this.safeToSwitch();
    if(safe&&!this.pair){this.elder.applyQuality();this.ice?.applyQuality();}
    if(!this.pair&&safe&&this.requested!==this.committed&&this.readyFor(this.requested))this.pair={from:this.committed,to:this.requested,progress:0};
    if(this.pair){
      const pair=this.pair;
      // Reverse the SAME cut; a third target waits until one endpoint is fully visible.
      const reverse=safe&&this.requested===pair.from;
      pair.progress=THREE.MathUtils.clamp(pair.progress+(reverse?-1:1)*Math.max(0,dt)/2,0,1);
      if(pair.progress<1e-8)pair.progress=0;else if(pair.progress>1-1e-8)pair.progress=1;
      if(pair.progress===1||(reverse&&pair.progress===0)){this.committed=pair.progress===1?pair.to:pair.from;this.pair=null;this.onChange?.();}
    }
    this.syncPose(dt,true);
  }
  syncPose(dt=0,allowCache=false):void{
    const pair=this.pair;
    for(const id of ['original','abies','ice'] as const){
      const direction=pair?.from===id?0:1;
      const progress=pair&&(pair.from===id||pair.to===id)?pair.progress:!pair&&this.committed===id?1:0;
      if(id==='original'){this.originalDirection.value=direction;this.originalProgress.value=progress;this.rig.shell.visible=direction===1?progress>0:progress<1;}
      else{const form=this.form(id);if(form){form.recovering=this.sourceRecovering();form.revealDirection.value=direction;form.progress.value=progress;form.sync(dt,allowCache);}}
    }
    const original=!pair&&this.committed==='original';this.vitality.shell.visible=original;for(const eye of this.vitality.eyes)eye.visible=original;this.crown.visible=original&&this.current.crown>.002;
  }
  inspect(){
    return{mask:this.maskValue,complete:this.complete,selected:this.requested,requested:this.requested,committed:this.committed,ready:{original:true,abies:this.elder.isReady,ice:!!this.ice?.isReady},error:this.form(this.requested)?.error??null,queued:this.requested!==this.committed&&!this.pair,pair:this.pair?{...this.pair}:null,ice:this.ice?.inspect()??null,transition:this.transition,formProgress:this.pair?.progress??(this.committed==='original'?0:1),bark:this.material.color.toArray(),vein:this.current.veinHigh.toArray(),crown:this.current.crown,dye:this.dyeAmount.value,elder:this.elder.inspect()};
  }
  dispose():void{
    if(this.disposed)return;
    this.onChange=undefined;this.generation++;this.pair=null;this.committed=this.requested='original';this.ice?.dispose();this.apply(this.base);this.elder.setGrowth(0);this.syncPose();this.elder.dispose();for(const m of this.shadowMaterials)m.dispose();this.rig.shell.material=this.sharedMaterial;this.rig.shell.customDepthMaterial=this.previousDepth;this.rig.shell.customDistanceMaterial=this.previousDistance;this.material.dispose();this.crown.removeFromParent();this.crown.geometry.dispose();this.disposed=true;
    if(this.crown.material instanceof THREE.Material)this.crown.material.dispose();
  }
  private target(mask:number):SkinLook{
    const target=copyLook(this.base);
    if(mask){
      const count=Number(!!(mask&1))+Number(!!(mask&2))+Number(!!(mask&4));
      target.dye=.65+count*.1;target.bark.set('#83c9ac');target.emissive.set('#245848');target.emissiveIntensity=.24;
      target.veinLow.set('#167d70');target.veinHigh.set('#a5ffe1');target.veinPower=1.2;
    }
    if(mask&RELIC_SKIN_BITS.heart){
      target.bark.set('#b6e1cc');target.emissive.set('#275c49');target.roughness=.86;target.metalness=.06;target.emissiveIntensity=.26;
    }
    if(mask&RELIC_SKIN_BITS.sap){
      target.veinLow.set('#167d70');target.veinHigh.set('#b8fff0');target.eyeCore.set('#e5fff8');target.eyeHalo.set('#72ffe0');target.veinPower=1.32;
    }
    if(mask&RELIC_SKIN_BITS.crown)target.crown=1;
    if(mask===7)return copyLook(this.base);
    return target;
  }
  private mix(a:SkinLook,b:SkinLook,t:number,out:SkinLook):void{
    out.bark.lerpColors(a.bark,b.bark,t);out.emissive.lerpColors(a.emissive,b.emissive,t);
    out.veinLow.lerpColors(a.veinLow,b.veinLow,t);out.veinHigh.lerpColors(a.veinHigh,b.veinHigh,t);
    out.eyeCore.lerpColors(a.eyeCore,b.eyeCore,t);out.eyeHalo.lerpColors(a.eyeHalo,b.eyeHalo,t);
    out.roughness=THREE.MathUtils.lerp(a.roughness,b.roughness,t);out.metalness=THREE.MathUtils.lerp(a.metalness,b.metalness,t);
    out.emissiveIntensity=THREE.MathUtils.lerp(a.emissiveIntensity,b.emissiveIntensity,t);out.veinPower=THREE.MathUtils.lerp(a.veinPower,b.veinPower,t);out.crown=THREE.MathUtils.lerp(a.crown,b.crown,t);
    out.dye=THREE.MathUtils.lerp(a.dye,b.dye,t);
    out.elder=THREE.MathUtils.lerp(a.elder,b.elder,t);
  }
  private apply(look:SkinLook):void{
    this.material.color.copy(look.bark);this.material.emissive.copy(look.emissive);this.material.roughness=look.roughness;
    this.material.metalness=look.metalness;this.material.emissiveIntensity=look.emissiveIntensity;
    this.dyeAmount.value=look.dye;this.dyeColor.value.copy(look.bark);
    this.vitality.setPalette(look.veinLow,look.veinHigh,look.eyeCore,look.eyeHalo,look.veinPower);
    const material=this.crown.material as THREE.MeshStandardMaterial;material.opacity=look.crown*.78;material.emissiveIntensity=.45+look.crown*.55;
    this.crown.visible=look.crown>.002&&this.elder.progress.value<.01;
  }
}
