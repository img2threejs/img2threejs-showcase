import * as THREE from 'three';
import type { GrootMeasure, ImpactKind } from './grootAnimation';

export const GROOT_SOUND_CUES:Record<ImpactKind,number>={pierce:2,sweep:2,seismic:3,ground:3,shield:4,taken:11,bloom:8,gather:4,seed:7,summon:8,heal:4,freeze:2,roar:9};
const PREFERENCE='groot:sound:v1';

/** One lazy audio context and one fixed 24-voice mixer. No per-footstep AudioNodes. */
export class GrootSound {
  volume=.55;
  muted=false;
  active=true;
  status:'locked'|'loading'|'ready'|'unavailable'|'closed'='locked';
  readonly counts=new Uint32Array(12);
  readonly last={kind:-1,clip:'',clipTime:0,pan:0,gain:0};
  metrics?:{capacity:number;active:number;played:number;dropped:number;peak:number};
  onChange?:()=>void;
  private context?:AudioContext;
  private node?:AudioWorkletNode;
  readonly analyserData=new Float32Array(512);
  private analyser?:AnalyserNode;
  private disposed=false;
  private background=false;
  private windup=Infinity;
  private currentClip='';
  private clipTime=0;
  private armourOn=false;
  private readonly delta=new THREE.Vector3();
  private readonly cameraPosition=new THREE.Vector3();
  private readonly cameraRight=new THREE.Vector3();
  private readonly message={type:'play',kind:0,gain:0,pan:0,rate:1,priority:1};
  private readonly cleanup:()=>void;
  constructor(private readonly camera:THREE.Camera,private readonly height:number){
    try{const saved=JSON.parse(localStorage.getItem(PREFERENCE)??'null');if(saved){if(typeof saved.volume==='number'&&Number.isFinite(saved.volume))this.volume=THREE.MathUtils.clamp(saved.volume,0,1);this.muted=saved.muted===true;}}catch{/* Audio preferences must not block play. */}
    if(!window.AudioContext||!window.AudioWorkletNode)this.status='unavailable';
    const gesture=(e:Event)=>{if(e.isTrusted&&!this.background&&this.active)void this.unlock();};
    const blur=()=>{this.background=true;this.silence();void this.context?.suspend().catch(()=>{});};
    const focus=()=>{this.background=false;};
    const visibility=()=>{if(document.hidden)blur();else focus();};
    window.addEventListener('pointerdown',gesture,true);window.addEventListener('keydown',gesture,true);
    window.addEventListener('blur',blur);window.addEventListener('focus',focus);document.addEventListener('visibilitychange',visibility);
    this.cleanup=()=>{window.removeEventListener('pointerdown',gesture,true);window.removeEventListener('keydown',gesture,true);window.removeEventListener('blur',blur);window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',visibility);};
  }
  get state():string{return this.context?.state??'not-created';}
  async unlock():Promise<void>{
    if(this.disposed||this.status==='unavailable'||!this.active||this.background)return;
    if(this.context){if(this.context.state==='suspended')await this.context.resume().catch(()=>{});return;}
    try{
      this.status='loading';this.onChange?.();
      const context=new AudioContext({latencyHint:'interactive'});this.context=context;
      // Call resume within the original gesture, before awaiting the module fetch.
      await Promise.all([context.resume(),context.audioWorklet.addModule('/audio/groot-processor.js')]);
      if(this.disposed)return;
      const node=new AudioWorkletNode(context,'groot-sound',{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[2]});this.node=node;
      node.port.onmessage=({data})=>{if(this.disposed)return;if(data.type==='ready'){this.status='ready';this.applyVolume();if(!this.active||this.background)this.silence();this.onChange?.();}else if(data.type==='metrics')this.metrics=data;};
      node.onprocessorerror=()=>{this.status='unavailable';node.disconnect();this.onChange?.();};
      this.analyser=context.createAnalyser();this.analyser.fftSize=512;node.connect(this.analyser);this.analyser.connect(context.destination);
      if(!this.active||this.background){this.silence();await context.suspend();}
    }catch{
      if(this.disposed)return;this.status='unavailable';void this.context?.close().catch(()=>{});this.onChange?.();
    }
  }
  private save():void{try{localStorage.setItem(PREFERENCE,JSON.stringify({volume:this.volume,muted:this.muted}));}catch{/* Storage may be blocked. */}}
  private applyVolume():void{this.node?.port.postMessage({type:'volume',value:this.muted||!this.active||this.background?0:this.volume});}
  setVolume(value:number):void{if(!Number.isFinite(value))return;this.volume=THREE.MathUtils.clamp(value,0,1);this.applyVolume();if(!this.volume)this.silence();this.save();this.onChange?.();}
  setMuted(muted:boolean):void{this.muted=muted;this.applyVolume();if(muted)this.silence();this.save();this.onChange?.();}
  setActive(active:boolean):void{if(this.active===active)return;this.active=active;if(!active){this.silence();void this.context?.suspend().catch(()=>{});}else{this.applyVolume();void this.unlock();}}
  silence():void{this.node?.port.postMessage({type:'stop'});}
  begin(id:string,measure:GrootMeasure):void{this.currentClip=id;this.clipTime=0;this.windup=measure.events.length?Math.max(0,measure.events[0].time-.48):Infinity;}
  frame(time:number,position:THREE.Vector3):void{
    this.clipTime=time;
    if(time>=this.windup){this.windup=Infinity;if(this.currentClip!=='regrowth'||this.armourOn)this.play(6,position,.48,1,2);}
  }
  step(position:THREE.Vector3,running:boolean):void{this.play(running?1:0,position,running?.80:.62,1,1);}
  impact(kind:ImpactKind,time:number,position:THREE.Vector3):void{
    this.clipTime=time;if(this.currentClip==='regrowth'&&!this.armourOn)return;
    this.play(GROOT_SOUND_CUES[kind],position,kind==='seismic'||kind==='ground'||kind==='roar'?.95:kind==='heal'||kind==='bloom'?.62:.80,1,3);
  }
  armour(enabled:boolean,position:THREE.Vector3):void{this.armourOn=enabled;this.play(enabled?4:5,position,.65,1,2);}
  dismiss(position:THREE.Vector3):void{this.windup=Infinity;this.play(8,position,.32,.72,2);}
  jump(position:THREE.Vector3):void{this.play(10,position,.55,.85,2);}
  relic(position:THREE.Vector3,complete:boolean):void{this.play(complete?9:8,position,complete?.88:.62,complete?.82:1.18,3);}
  private play(kind:number,position:THREE.Vector3,gain:number,rate:number,priority:number):void{
    if(!this.node||this.status!=='ready'||this.context?.state!=='running'||!this.active||this.background||this.muted||this.volume===0)return;
    this.camera.getWorldPosition(this.cameraPosition);this.cameraRight.setFromMatrixColumn(this.camera.matrixWorld,0).normalize();this.delta.copy(position).sub(this.cameraPosition);
    const distance=this.delta.length(),pan=THREE.MathUtils.clamp(this.delta.dot(this.cameraRight)/Math.max(this.height,distance)*1.5,-.85,.85);
    gain*=1/(1+Math.max(0,distance/this.height-4)*.22);
    const m=this.message;m.kind=kind;m.gain=gain;m.pan=pan;m.rate=rate;m.priority=priority;this.node.port.postMessage(m);
    this.counts[kind]++;this.last.kind=kind;this.last.clip=this.currentClip;this.last.clipTime=this.clipTime;this.last.pan=pan;this.last.gain=gain;
  }
  inspect():void{this.node?.port.postMessage({type:'inspect'});}
  readLevel():number{if(!this.analyser)return 0;this.analyser.getFloatTimeDomainData(this.analyserData);let peak=0;for(const v of this.analyserData)peak=Math.max(peak,Math.abs(v));return peak;}
  dispose():void{if(this.disposed)return;this.disposed=true;this.active=false;this.cleanup();this.silence();this.node?.disconnect();this.node?.port.close();this.analyser?.disconnect();void this.context?.close().catch(()=>{});this.status='closed';this.onChange=undefined;}
}
