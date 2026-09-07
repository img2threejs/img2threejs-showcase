import * as THREE from 'three';
import type { GrootSkin } from './grootSkin';
import type { GrootWaterReflection } from './grootWaterReflection';
/** Explicit 70-only reductions. Capture and restore scene-owned shadow resources. */
export class GrootRenderQuality {
 private readonly shadows:{shadow:THREE.LightShadow;width:number;height:number}[]=[];
 private low=false;
 private disposed=false;
 constructor(scene:THREE.Scene,private readonly skin:GrootSkin,private readonly reflection:GrootWaterReflection){
  scene.traverse(object=>{if(object instanceof THREE.DirectionalLight||object instanceof THREE.SpotLight||object instanceof THREE.PointLight){const shadow=object.shadow;this.shadows.push({shadow,width:shadow.mapSize.x,height:shadow.mapSize.y});}});
 }
 setScale(scale:number):void{
  if(this.disposed)return;const low=scale===.7;this.skin.setQuality(low?'medium':'high');this.reflection.setPerformance(low);
  if(low===this.low)return;this.low=low;
  for(const {shadow,width,height} of this.shadows){
   shadow.mapSize.set(low?Math.max(128,width/2):width,low?Math.max(128,height/2):height);
   shadow.map?.dispose();shadow.map=null;shadow.mapPass?.dispose();shadow.mapPass=null;shadow.needsUpdate=true;
  }
 }
 dispose():void{if(this.disposed)return;this.setScale(1);this.disposed=true;}
}
