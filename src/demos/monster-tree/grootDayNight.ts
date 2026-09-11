import * as THREE from 'three';
import type { GrootEffects } from './grootEffects';

/** Owns only this demo's scene settings; leaving the demo restores them. */
export class GrootDayNight {
  hour=22;
  daylight=0;
  private readonly sky=new THREE.Color();
  private readonly night=new THREE.Color('#06101c');
  private readonly day=new THREE.Color('#9eada2');
  private readonly dusk=new THREE.Color('#956b55');
  private readonly fog=new THREE.FogExp2('#0c2021',.025);
  private readonly oldBackground:THREE.Scene['background'];
  private readonly oldFog:THREE.Scene['fog'];
  private readonly oldEnvironmentIntensity:number;
  private readonly nightKey=new THREE.Color('#d8e3f4');
  private readonly dayKey=new THREE.Color('#fff0ce');
  private readonly nightSky=new THREE.Color('#8398ac');
  private readonly daySky=new THREE.Color('#bfd6d7');
  private readonly lights:THREE.Group|undefined;
  constructor(private readonly scene:THREE.Scene,private readonly effects:GrootEffects){
    this.oldBackground=scene.background;this.oldFog=scene.fog;this.oldEnvironmentIntensity=scene.environmentIntensity;
    this.lights=scene.getObjectByName('monster-tree-lights') as THREE.Group|undefined;
    scene.background=this.sky;scene.fog=this.fog;this.update(1);
  }
  setHour(hour:number):void {this.hour=THREE.MathUtils.clamp(hour,0,24);}
  update(dt:number):void{
    const elevation=Math.sin((this.hour-6)/24*Math.PI*2),target=THREE.MathUtils.smoothstep(elevation,-.12,.48);
    this.daylight+=(target-this.daylight)*(1-Math.exp(-dt*4));
    const d=this.daylight,twilight=Math.max(0,1-Math.abs(elevation)*7)*d;
    this.sky.copy(this.night).lerp(this.day,d).lerp(this.dusk,twilight*.45);this.fog.color.copy(this.sky);this.fog.density=.020+.009*(1-d);
    this.scene.environmentIntensity=this.oldEnvironmentIntensity*(1+d*.55);
    this.effects.weather.daylight.value=d;this.effects.forest.atmosphere.daylight=d;
    if(!this.lights)return;
    const key=this.lights.getObjectByName('key') as THREE.DirectionalLight,fill=this.lights.getObjectByName('fill') as THREE.DirectionalLight;
    const rim=this.lights.getObjectByName('rim') as THREE.DirectionalLight,sky=this.lights.getObjectByName('hemi') as THREE.HemisphereLight;
    key.color.copy(this.nightKey).lerp(this.dayKey,d);key.intensity=1.25+d*2;fill.intensity=.32+d*.48;rim.intensity=1.05-d*.35;
    sky.color.copy(this.nightSky).lerp(this.daySky,d);sky.intensity=.14+d*.85;
    const h=this.effects.height;key.position.set(h*(1.15+Math.cos((this.hour-6)/24*Math.PI*2)*d*1.8),h*(1.3+d*1.5),h*.85);
  }
  dispose():void {this.scene.background=this.oldBackground;this.scene.fog=this.oldFog;this.scene.environmentIntensity=this.oldEnvironmentIntensity;}
}
