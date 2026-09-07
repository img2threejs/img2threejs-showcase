import * as THREE from 'three';
import type { Viewer } from '../../scene';
import { forestGround } from './grootTerrain';

/** Gameplay camera: independent third-person drag orbit, first-person eye/look.
 * Yaw/pitch belong to the user, never actor facing. Native OrbitControls owns review
 * only; this bounded orbit/follow controller is the sole gameplay input writer.
 */
export class GrootCamera {
  firstPerson=false;
  private active=false;
  private yaw=0;
  private pitch=0;
  private distance=0;
  private pointer:number|null=null;
  private pointerX=0;
  private pointerY=0;
  private readonly direction=new THREE.Vector3();
  private saved?:{enabled:boolean;enableDamping:boolean;enablePan:boolean;enableZoom:boolean;autoRotate:boolean;minDistance:number;maxDistance:number;minPolarAngle:number;maxPolarAngle:number;near:number;fov:number};
  private readonly removeInput:()=>void;
  constructor(private readonly viewer:Viewer,private readonly actor:THREE.Group,private readonly height:number,private readonly canLook:()=>boolean){
    const canvas=viewer.renderer.domElement;
    const down=(e:PointerEvent)=>{
      if(!this.active||!this.canLook()||e.button!==0||this.pointer!==null)return;
      this.pointer=e.pointerId;this.pointerX=e.clientX;this.pointerY=e.clientY;canvas.setPointerCapture(e.pointerId);
    };
    const up=(e:PointerEvent)=>{if(e.pointerId===this.pointer)this.cancelLook();};
    const move=(e:PointerEvent)=>{
      if(e.pointerId!==this.pointer||!this.active||!this.canLook())return;
      this.yaw-=(e.clientX-this.pointerX)*.003;
      this.pitch=THREE.MathUtils.clamp(this.pitch-(e.clientY-this.pointerY)*.003,-1.2,1.15);
      this.pointerX=e.clientX;this.pointerY=e.clientY;
    };
    const wheel=(e:WheelEvent)=>{
      if(!this.active||!this.canLook()||this.firstPerson)return;
      e.preventDefault();this.distance=THREE.MathUtils.clamp(this.distance*Math.exp(Math.sign(e.deltaY)*.08),this.height*1.3,this.height*4);
    };
    const blur=()=>this.cancelLook();
    const visibility=()=>{if(document.hidden)this.cancelLook();};
    canvas.addEventListener('pointerdown',down);canvas.addEventListener('pointermove',move);canvas.addEventListener('pointerup',up);canvas.addEventListener('pointercancel',up);canvas.addEventListener('lostpointercapture',up);canvas.addEventListener('wheel',wheel,{passive:false});window.addEventListener('blur',blur);document.addEventListener('visibilitychange',visibility);
    this.removeInput=()=>{canvas.removeEventListener('pointerdown',down);canvas.removeEventListener('pointermove',move);canvas.removeEventListener('pointerup',up);canvas.removeEventListener('pointercancel',up);canvas.removeEventListener('lostpointercapture',up);canvas.removeEventListener('wheel',wheel);window.removeEventListener('blur',blur);document.removeEventListener('visibilitychange',visibility);};
  }
  cancelLook():void{
    const pointer=this.pointer;this.pointer=null;
    const canvas=this.viewer.renderer.domElement;
    if(pointer!==null&&canvas.hasPointerCapture(pointer))canvas.releasePointerCapture(pointer);
  }
  setGameplay(value:boolean):void{
    if(value===this.active)return;
    this.cancelLook();
    const {controls:c,camera}=this.viewer;
    if(value){
      // First called by the game tick AFTER the viewer's authored/async framing pass.
      this.saved={enabled:c.enabled,enableDamping:c.enableDamping,enablePan:c.enablePan,enableZoom:c.enableZoom,autoRotate:c.autoRotate,minDistance:c.minDistance,maxDistance:c.maxDistance,minPolarAngle:c.minPolarAngle,maxPolarAngle:c.maxPolarAngle,near:camera.near,fov:camera.fov};
      camera.getWorldDirection(this.direction);this.yaw=Math.atan2(-this.direction.x,-this.direction.z);this.pitch=Math.asin(THREE.MathUtils.clamp(this.direction.y,-1,1));
      this.distance=THREE.MathUtils.clamp(camera.position.distanceTo(c.target),this.height*1.3,this.height*4);
      c.enableDamping=false;c.autoRotate=false;c.update(); // discard pending review inertia before applying the adopted view
      c.enabled=false;c.enablePan=false;c.enableZoom=false;c.minDistance=0;c.maxDistance=Infinity;c.minPolarAngle=0;c.maxPolarAngle=Math.PI;
    }else if(this.saved){
      const {near,fov,...controls}=this.saved;Object.assign(c,controls);camera.near=near;camera.fov=fov;camera.updateProjectionMatrix();
    }
    this.active=value;
    if(value)this.update();
  }
  setFirstPerson(value:boolean):void{
    if(this.firstPerson===value)return;
    this.cancelLook();this.firstPerson=value;
    const camera=this.viewer.camera;
    camera.near=value?.025:this.saved?.near??camera.near;camera.fov=value?72:this.saved?.fov??camera.fov;camera.updateProjectionMatrix();
    this.update();
  }
  /** View-relative movement basis; only first person also uses it as actor/skill aim. */
  forward(out:THREE.Vector3):THREE.Vector3{return out.set(-Math.sin(this.yaw),0,-Math.cos(this.yaw));}
  update():void{
    if(!this.active)return;
    const {camera,controls}=this.viewer;
    this.direction.set(-Math.sin(this.yaw)*Math.cos(this.pitch),Math.sin(this.pitch),-Math.cos(this.yaw)*Math.cos(this.pitch));
    controls.target.copy(this.actor.position);controls.target.y+=this.height*.84;
    if(this.firstPerson){camera.position.copy(controls.target);controls.target.add(this.direction);}
    else{
      camera.position.copy(controls.target).addScaledVector(this.direction,-this.distance);
      // Preserve look direction while preventing an upward look from burying the camera.
      // This is only a terrain floor, not tree/obstacle camera collision.
      const lift=Math.max(0,forestGround(camera.position.x,camera.position.z,this.height)+this.height*.12-camera.position.y);
      camera.position.y+=lift;controls.target.y+=lift;
    }
    camera.lookAt(controls.target);
  }
  dispose():void{this.setFirstPerson(false);this.setGameplay(false);this.cancelLook();this.removeInput();}
}
