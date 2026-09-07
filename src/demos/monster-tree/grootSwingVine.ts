import * as THREE from 'three';
import type { GrootMeasure } from './grootAnimation';
import type { GrootWoodStock } from './grootWood';

const SECTIONS=112;
const ease=(x:number):number=>{const t=THREE.MathUtils.clamp(x,0,1);return t*t*t*(t*(t*6-15)+10);};

/** One overhead liana, assembled from the original bark. The canopy anchor is captured in
 * effect-space once per cast; only its gripped end follows the hand. All storage is pooled. */
export class GrootSwingVine {
  readonly group=new THREE.Group();
  readonly wood:THREE.InstancedMesh;
  readonly anchor=new THREE.Vector3();
  readonly end=new THREE.Vector3();
  private readonly releasePoint=new THREE.Vector3();
  private readonly releaseVelocity=new THREE.Vector3();
  private readonly castMatrix=new THREE.Matrix4();
  private readonly tangent=new THREE.Vector3();
  private readonly point=new THREE.Vector3();
  private readonly next=new THREE.Vector3();
  private readonly up=new THREE.Vector3(0,1,0);
  private readonly roll=new THREE.Quaternion();
  private readonly dummy=new THREE.Object3D();
  private initialized=false;

  constructor(readonly height:number,stock:GrootWoodStock,material:THREE.Material|THREE.Material[]){
    this.group.name='groot-rootfall-overhead-vine';this.group.visible=false;
    this.wood=new THREE.InstancedMesh(stock.geometry,material,SECTIONS);
    this.wood.name='rootfall-original-bark-liana';this.wood.count=0;this.wood.visible=false;
    this.wood.frustumCulled=false;this.wood.castShadow=true;this.wood.receiveShadow=true;
    this.group.add(this.wood);
  }

  reset():void{this.initialized=false;this.group.visible=false;this.wood.visible=false;this.wood.count=0;}

  private onCurve(u:number,time:number,out:THREE.Vector3):void{
    out.lerpVectors(this.anchor,this.end,u);
    // Under load the stem is almost taut. The endpoints stay exact while the middle flexes.
    const bend=Math.sin(u*Math.PI)*this.height*.022;
    out.x+=Math.sin(time*2.1-u*2)*bend;out.z+=Math.sin(time*1.6+u*3)*bend;
  }

  update(id:string,time:number,measure:GrootMeasure,grip:THREE.Vector3,actorMatrix:THREE.Matrix4):void{
    const swing=measure.swing,land=measure.events[0]?.time??0,h=this.height;
    if(id!=='root-charge'||!swing||time<=0||time>=land+1.1){this.group.visible=false;this.wood.visible=false;this.wood.count=0;return;}
    if(!this.initialized){
      this.castMatrix.copy(actorMatrix);
      this.anchor.set((swing.gripPointH[0]+swing.releasePointH[0])*.5,2.65,swing.gripPointH[2]-.12).multiplyScalar(h).applyMatrix4(this.castMatrix);
      this.releasePoint.fromArray(swing.releasePointH).multiplyScalar(h).applyMatrix4(this.castMatrix);
      // Apply only the linear transform to velocity (translation is not a velocity).
      this.releaseVelocity.fromArray(swing.releaseVelocityH).multiplyScalar(h);
      const e=this.castMatrix.elements,x=this.releaseVelocity.x,y=this.releaseVelocity.y,z=this.releaseVelocity.z;
      this.releaseVelocity.set(e[0]*x+e[4]*y+e[8]*z,e[1]*x+e[5]*y+e[9]*z,e[2]*x+e[6]*y+e[10]*z);
      this.initialized=true;
    }
    if(time<=swing.releaseTime){
      this.end.copy(grip);
      if(time<swing.gripTime)this.end.lerp(this.anchor,1-ease(time/swing.gripTime));
    }else{
      const age=time-swing.releaseTime,settle=ease(age/1.15);
      this.end.copy(this.releasePoint).addScaledVector(this.releaseVelocity,Math.sin(age*4)/4*Math.exp(-age*2));
      this.end.x+=(this.anchor.x-this.releasePoint.x)*settle*.65;
      this.end.z+=(this.anchor.z-this.releasePoint.z)*settle*.65;
      this.end.y+=h*.22*settle;
      this.end.lerp(this.anchor,ease((time-land-.15)/.95));
    }
    const width=1-ease((time-land-.65)/.45);
    this.group.visible=true;this.wood.visible=true;this.wood.count=0;
    for(let i=0;i<SECTIONS;i++){
      // Short overlapping, uniformly scaled stock keeps the vine slender without distorting
      // the source bark. Extra sections provide length; no tube or green substitute surface.
      this.onCurve(i/SECTIONS,time,this.point);this.onCurve((i+1)/SECTIONS,time,this.next);
      this.tangent.copy(this.next).sub(this.point);const length=this.tangent.length();
      if(length<1e-7)continue;
      this.dummy.position.copy(this.point);this.dummy.quaternion.setFromUnitVectors(this.up,this.tangent.divideScalar(length));
      this.roll.setFromAxisAngle(this.up,i*2.399);this.dummy.quaternion.multiply(this.roll);
      this.dummy.scale.setScalar(length*3.2*width);this.dummy.updateMatrix();this.wood.setMatrixAt(this.wood.count++,this.dummy.matrix);
    }
    this.wood.instanceMatrix.needsUpdate=true;
  }
}
