import * as THREE from 'three';
import type { MonsterTreeRig } from './rig';
import type { GrootWoodStock } from './grootWood';
import { forestGround } from './grootTerrain';
import { FAULTLINE } from './grootFaultline';
import { sharpenGrootWood, grootBarkThorn, installGrootThornGrain } from './grootThornWood';

const ease=(x:number):number=>{const t=THREE.MathUtils.clamp(x,0,1);return t*t*(3-2*t);};
interface Plate {bone:THREE.Bone;position:THREE.Vector3;rotation:THREE.Quaternion;size:number;delay:number}

/** Fixed buffers. Faultline sculpts copies of source bark; armour/cocoon retain the original stock. */
export class GrootLivingForms {
  readonly group=new THREE.Group();
  readonly faultline:THREE.InstancedMesh;
  readonly faultlineThorns:THREE.InstancedMesh;
  readonly jadeThorns:THREE.InstancedMesh;
  readonly cocoon:THREE.InstancedMesh;
  readonly armour:THREE.InstancedMesh;
  private readonly plates:Plate[]=[];
  private readonly dummy=new THREE.Object3D();
  private readonly p=new THREE.Vector3();
  private readonly q=new THREE.Vector3();
  private readonly direction=new THREE.Vector3();
  private readonly up=new THREE.Vector3(0,1,0);
  private readonly inverse=new THREE.Matrix4();
  private readonly matrix=new THREE.Matrix4();
  private readonly roll=new THREE.Quaternion();
  readonly quakeAnchor=new THREE.Matrix4();
  private quakeReady=false;
  armourEnabled=false;
  armourProgress=0;
  armourPreview=false;
  setArmour(enabled:boolean):void {this.armourEnabled=enabled;}
  constructor(readonly rig:MonsterTreeRig,readonly height:number,stock:GrootWoodStock[]){
    this.group.name='groot-living-forms';this.group.visible=false;
    const make=(name:string,capacity:number,index:number):THREE.InstancedMesh=>{
      const mesh=new THREE.InstancedMesh(stock[index].geometry,rig.shell.material,capacity);
      mesh.name=name;mesh.visible=false;mesh.count=0;mesh.frustumCulled=false;mesh.castShadow=true;mesh.receiveShadow=true;this.group.add(mesh);return mesh;
    };
    this.faultline=make('groot-faultline-spikes',120,0);
    this.faultline.geometry=sharpenGrootWood(stock[0].geometry);
    this.faultlineThorns=make('groot-faultline-bark-thorns',800,0);
    this.faultlineThorns.geometry=grootBarkThorn(stock[0].geometry);
    this.jadeThorns=make('groot-faultline-jade-thorns',200,0);
    this.jadeThorns.geometry=grootBarkThorn(stock[0].geometry,true);
    const roughBark=(rig.shell.material as THREE.MeshStandardMaterial).clone();roughBark.roughness=.94;roughBark.metalness=.02;
    installGrootThornGrain(roughBark);
    this.faultline.material=this.faultlineThorns.material=this.jadeThorns.material=roughBark;
    this.cocoon=make('groot-egg-shell',2304,stock.length-1);
    this.armour=make('groot-fitted-bark-armour',320,0);
    // Define overlapping cuirass, pauldrons, vambraces and greaves in the actual rest skeleton.
    rig.group.updateMatrixWorld(true);
    const start=new THREE.Vector3(),end=new THREE.Vector3(),axis=new THREE.Vector3(),side=new THREE.Vector3(),normal=new THREE.Vector3();
    const inv=new THREE.Matrix4(),worldQ=new THREE.Quaternion(),localQ=new THREE.Quaternion();
    const regions:[string,string,number,number,number][]=[
      ['Waist','Spine02',.135,5,12],['Spine02','NeckTwist01',.145,3,12],
      ['L_Upperarm','L_Forearm',.085,3,8],['R_Upperarm','R_Forearm',.085,3,8],
      ['L_Forearm','L_Hand',.053,3,7],['R_Forearm','R_Hand',.053,3,7],
      ['L_Calf','L_Foot',.065,3,8],['R_Calf','R_Foot',.065,3,8],
    ];
    for(const [name,tip,radius,rows,around] of regions){
      const bone=rig.bones[name];bone.getWorldPosition(start);rig.bones[tip].getWorldPosition(end);
      axis.copy(end).sub(start).normalize();side.set(1,0,0);if(Math.abs(axis.dot(side))>.9)side.set(0,0,1);
      normal.crossVectors(axis,side).normalize();side.crossVectors(normal,axis).normalize();
      inv.copy(bone.matrixWorld).invert();bone.getWorldQuaternion(worldQ).invert();
      localQ.setFromUnitVectors(this.up,axis).premultiply(worldQ);
      for(let row=0;row<rows;row++)for(let i=0;i<around;i++){
        const angle=i/around*Math.PI*2+(row%2)*.18;
        const position=start.clone().lerp(end,row/rows).addScaledVector(side,Math.cos(angle)*radius*height).addScaledVector(normal,Math.sin(angle)*radius*height).applyMatrix4(inv);
        const rotation=localQ.clone().multiply(new THREE.Quaternion().setFromAxisAngle(this.up,angle));
        this.plates.push({bone,position,rotation,size:height*(name.includes('Spine')||name==='Waist'?.13:.10),delay:row*.025+(name.includes('Calf')?0:name==='Waist'?.12:name.includes('Spine')?.24:name.includes('Upperarm')?.34:.44)});
      }
    }
  }
  private clear():void {this.group.visible=false;this.faultline.visible=this.faultlineThorns.visible=this.jadeThorns.visible=this.cocoon.visible=this.armour.visible=false;this.faultline.count=this.faultlineThorns.count=this.jadeThorns.count=this.cocoon.count=this.armour.count=0;}
  reset():void {this.clear();this.quakeReady=false;}
  quake(actor:THREE.Matrix4):void {this.quakeAnchor.copy(actor);this.quakeReady=true;}
  private piece(mesh:THREE.InstancedMesh,a:THREE.Vector3,b:THREE.Vector3,size:number,twist:number):void{
    if(size<1e-5||mesh.count>=mesh.instanceMatrix.count)return;
    this.dummy.position.copy(a);this.direction.copy(b).sub(a).normalize();
    this.dummy.quaternion.setFromUnitVectors(this.up,this.direction);this.roll.setFromAxisAngle(this.up,twist);this.dummy.quaternion.multiply(this.roll);
    this.dummy.scale.setScalar(size);this.dummy.updateMatrix();mesh.setMatrixAt(mesh.count++,this.dummy.matrix);
  }
  update(id:string,time:number,stop:number,actor:THREE.Matrix4,dt=0):void{
    this.clear();const h=this.height;
    if(!this.armourPreview)this.armourProgress=THREE.MathUtils.clamp(this.armourProgress+(this.armourEnabled?dt/1.5:-dt/1.25),0,1);
    if(id==='vine-sweep'){
      // The measured event captures this anchor once. Neither movement nor turning drags the quake.
      if(this.quakeReady)for(let column=0;column<FAULTLINE.columns;column++)for(let lane=0;lane<FAULTLINE.lanes;lane++){
        const age=time-stop-column*FAULTLINE.stepSeconds,rise=ease(age/.15)*(1-ease((age-.95)/.55));if(rise<=.001)continue;
        const size=h*(.48+.30*Math.sin(column*.63+lane*.8)**2);
        this.p.set(FAULTLINE.offsetM+column*FAULTLINE.spacingH*h,0,(lane-2)*FAULTLINE.laneH*h).applyMatrix4(this.quakeAnchor);
        this.p.y=forestGround(this.p.x,this.p.z,h)-size*(1-rise)-.035*h;
        this.q.copy(this.p);this.q.y+=h;
        this.piece(this.faultline,this.p,this.q,size,lane*.17+column*.11);
        this.matrix.copy(this.dummy.matrix);
        for(let thorn=0;thorn<8;thorn++){
          const angle=thorn*2.399+lane*.71,level=.16+thorn*.09;
          this.p.set(0,level,0).applyMatrix4(this.matrix);
          this.q.set(Math.cos(angle),level+.65,Math.sin(angle)).applyMatrix4(this.matrix);
          this.piece((thorn+lane+column)%5===0?this.jadeThorns:this.faultlineThorns,this.p,this.q,size*(.17+.05*Math.sin(thorn*1.7)**2),angle);
        }
      }
    }else if(id==='sanctuary'){
      const growth=ease((time-stop+.8)/.8)*(1-ease((time-stop-.65)/.8));
      // Full 360-degree ovoid, wider below its equator and meeting at the crown.
      for(let rib=0;rib<32;rib++)for(let j=0;j<52;j++){
        const s=j/52,born=ease((growth-s)/.12);if(born<=.001)continue;
        for(let k=0;k<2;k++){
          const u=(j+k)/52,theta=rib/32*Math.PI*2+.16*Math.sin(u*Math.PI*2),r=.55*Math.sin(u*Math.PI)**.72*(1.12-.30*u);
          (k?this.q:this.p).set(.04*h+Math.cos(theta)*r*h,(.018+u*1.4)*h,Math.sin(theta)*r*h).applyMatrix4(actor);
        }
        this.piece(this.cocoon,this.p,this.q,h*.070*born,rib*.83+j*.21);
      }
      for(let band=1;band<=5;band++)for(let j=0;j<96;j++){
        const u=band/6,born=ease((growth-u)/.15),r=.55*Math.sin(u*Math.PI)**.72*(1.12-.30*u);
        for(let k=0;k<2;k++){const a=(j+k)/96*Math.PI*2;(k?this.q:this.p).set((.04+Math.cos(a)*r)*h,(.018+u*1.4+.008*Math.sin(a*8))*h,Math.sin(a)*r*h).applyMatrix4(actor);}
        this.piece(this.cocoon,this.p,this.q,h*.060*born,j*.8);
      }
    }
    const growth=this.armourPreview?(id==='regrowth'?ease((time-stop+.85)/.7)*(1-ease((time-stop-.65)/.85)):0):this.armourProgress;
    if(growth>.001){
      this.group.updateWorldMatrix(true,false);this.inverse.copy(this.group.matrixWorld).invert();
      for(const plate of this.plates){
        const born=ease((growth-plate.delay)/.45);if(born<=.001)continue;
        this.matrix.copy(this.inverse).multiply(plate.bone.matrixWorld);
        this.dummy.position.copy(plate.position);this.dummy.quaternion.copy(plate.rotation);this.dummy.scale.setScalar(plate.size*born);this.dummy.updateMatrix();
        // Bone matrices include the imported root scale. Divide it out to keep source stock uniform.
        const boneScale=this.p.setFromMatrixScale(this.matrix).x;
        this.dummy.scale.setScalar(plate.size*born/boneScale);this.dummy.updateMatrix();this.matrix.multiply(this.dummy.matrix);
        this.armour.setMatrixAt(this.armour.count++,this.matrix);
      }
    }
    this.faultline.visible=this.faultline.count>0;this.faultlineThorns.visible=this.faultlineThorns.count>0;this.jadeThorns.visible=this.jadeThorns.count>0;this.cocoon.visible=this.cocoon.count>0;this.armour.visible=this.armour.count>0;
    this.group.visible=this.faultline.visible||this.cocoon.visible||this.armour.visible;
    this.faultline.instanceMatrix.needsUpdate=true;this.cocoon.instanceMatrix.needsUpdate=true;this.armour.instanceMatrix.needsUpdate=true;
    this.faultlineThorns.instanceMatrix.needsUpdate=true;this.jadeThorns.instanceMatrix.needsUpdate=true;
  }
}
