import * as THREE from 'three';

export const STREAM_TIERS = {70:{radius:8,half:4,cap:81},85:{radius:12,half:6,cap:169},100:{radius:18,half:8,cap:289}} as const;
export type StreamTier = keyof typeof STREAM_TIERS;
/** Exact closest-point AABB/disk overlap, including tangent and negative cells. */
export function cellIntersects(cx:number,cz:number,x:number,z:number,r:number,pad=0):boolean {
  const dx=Math.max(cx*3-pad-x,0,x-((cx+1)*3+pad));
  const dz=Math.max(cz*3-pad-z,0,z-((cz+1)*3+pad));
  return dx*dx+dz*dz<=r*r;
}
export interface StreamPart {group:THREE.Group;bytes:number;dispose():void;setVisible?(visible:boolean,x:number,z:number,r:number):void;promoteNear?():number;extraBuffers?:THREE.BufferAttribute[];sourceMeshes?:THREE.InstancedMesh[];sourceGeometry?:THREE.BufferGeometry;}
export interface StreamSlot {
  key:string;cx:number;cz:number;ground?:StreamPart;vegetation?:StreamPart;
  job?:Generator<void,StreamPart>;near:boolean;
}
export interface StreamBuilder {
  setVisible?(x:number,z:number,r:number):void;
  ground(cx:number,cz:number):StreamPart;
  vegetation(cx:number,cz:number,near:boolean):Generator<void,StreamPart>;
}
/** One identity per cell, including unfinished work. No async callbacks or descriptor cache.
 * Matrices stay in absolute H coordinates: reaction shaders must not acquire a chunk offset.
 * 3H vegetation padding covers the largest canopy (1.45*1.55 + .48 leaf + .24 reaction)
 * and a 1H grass cell extension (root offset .67H + blade .08H + brush/wind <.25H). Ground has no geometry extension.
 */
export class GrootStreaming {
  readonly slots=new Map<string,StreamSlot>();
  readonly anchor={value:new THREE.Vector2()};
  readonly radius={value:8};
  // Fade completes 1H inside the R+4H reserved ground footprint. That last H is
  // prebuilt ground headroom across a 3H identity boundary, not an extra safety buffer.
  readonly groundRadius={value:11};
  readonly colour={value:new THREE.Color('#06101c')};
  tier:StreamTier=70;
  disposed=false;
  private x=0;private z=0;
  private hasTarget=false;
  private bootstrap=true;
  private envelopeX=NaN;private envelopeZ=NaN;private envelopeTier:StreamTier|undefined;
  private coverageVersion=0;
  private readyVersion=-1;private readyX=NaN;private readyZ=NaN;private readyRadius=NaN;private readyValue=false;
  private readonly faded=new WeakSet<THREE.Material>();
  private readonly observed=new WeakSet<THREE.BufferAttribute>();
  readonly stats={pumps:0,generatedGround:0,generatedVegetation:0,promotedCanopy:0,evicted:0,cancelled:0,preparedBytes:0,lastBytes:0,uploadedBytes:0,lastUploadBytes:0,uploadCalls:0,actualUploadOverages:0,lastMs:0,maxMs:0,cpuOverages:0,uploadOverages:0,loadingFrames:0,completed:0,queue:0,peakSlots:0,peakQueue:0,stalls:0,envelopeRebuilds:0,planningScans:0,readyScans:0,readyCacheHits:0,steadySkips:0};
  constructor(readonly group:THREE.Group,readonly height:number,private readonly builder:StreamBuilder){}
  setScale(scale:number):void {
    if(this.disposed)return;
    this.tier=scale===1?100:scale===.85?85:70;
    if(STREAM_TIERS[this.tier].radius<this.radius.value)this.radius.value=STREAM_TIERS[this.tier].radius;
    this.groundRadius.value=this.radius.value+3;
  }
  /** Compose, never replace, existing wind/reaction/water hooks. Actor/VFX materials aren't enrolled. */
  fade(material:THREE.Material,ground=false,grass=false):void {
    if(this.faded.has(material))return;this.faded.add(material);
    const previous=material.onBeforeCompile.bind(material),key=material.customProgramCacheKey();
    material.onBeforeCompile=(shader,renderer)=>{
      previous(shader,renderer);
      Object.assign(shader.uniforms,{streamAnchor:this.anchor,streamRadius:ground?this.groundRadius:this.radius,streamColour:this.colour});
      if(material instanceof THREE.ShaderMaterial){
        // Authored additive moonshafts are local scenery too; unlike lit surfaces they
        // dissolve to zero contribution instead of blending the background additively.
        shader.vertexShader='varying vec2 vStreamXZ;\n'+shader.vertexShader.replace('void main(){',`void main(){vStreamXZ=(modelMatrix*vec4(position,1.)).xz/${this.height.toFixed(8)};`);
        shader.fragmentShader='varying vec2 vStreamXZ;uniform vec2 streamAnchor;uniform float streamRadius;\n'+shader.fragmentShader.replace(/}\s*$/,`float d=distance(vStreamXZ,streamAnchor);if(d>=streamRadius)discard;gl_FragColor.a*=1.-smoothstep(streamRadius-2.,streamRadius,d);}`);
        return;
      }
      shader.vertexShader='varying vec2 vStreamXZ;\n'+shader.vertexShader;
      shader.vertexShader=shader.vertexShader.replace('#include <project_vertex>',`#include <project_vertex>
        vec4 streamPosition=vec4(transformed,1.);
        #ifdef USE_INSTANCING
          streamPosition=instanceMatrix*streamPosition;
        #endif
        vStreamXZ=(modelMatrix*streamPosition).xz/${this.height.toFixed(8)};
      `);
      shader.fragmentShader='varying vec2 vStreamXZ;uniform vec2 streamAnchor;uniform float streamRadius;uniform vec3 streamColour;\n'+shader.fragmentShader;
      // Clip by actor radius, not camera depth. Fade AFTER tone mapping: a scene colour
      // background is clear-colour output, not ACES-lit surface radiance.
      shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>',`float streamDistance=distance(vStreamXZ,streamAnchor);
        float streamEnd=${grass?'min(12.,streamRadius)':'streamRadius'};
        if(streamDistance>=streamEnd)discard;
        #include <opaque_fragment>`);
      // Camera-depth fog would tint the already radial-matched background differently.
      shader.fragmentShader=shader.fragmentShader.replace('#include <fog_fragment>',`gl_FragColor.rgb=mix(gl_FragColor.rgb,linearToOutputTexel(vec4(streamColour,1.)).rgb,smoothstep(streamEnd-2.,streamEnd,streamDistance));`);
    };
    material.customProgramCacheKey=()=>key+`:local-stream-v2:${ground}:${grass}`;material.needsUpdate=true;
  }
  private observe(part:StreamPart):void {
    const buffers:THREE.BufferAttribute[]=[...(part.extraBuffers??[])];
    part.group.traverse(object=>{if(!(object instanceof THREE.Mesh))return;
      for(const attribute of Object.values(object.geometry.attributes))if(attribute instanceof THREE.BufferAttribute)buffers.push(attribute);
      if(object.geometry.index)buffers.push(object.geometry.index);
      if(object instanceof THREE.InstancedMesh){buffers.push(object.instanceMatrix);if(object.instanceColor)buffers.push(object.instanceColor);}
    });
    for(const attribute of buffers){if(this.observed.has(attribute))continue;this.observed.add(attribute);
      // r169 clears MERGED update ranges before onUpload, but first bufferData ignores
      // ranges and does not clear them. Capture the former and clear the latter here.
      let first=true,rangeBytes:number|undefined;
      const clear=attribute.clearUpdateRanges.bind(attribute);
      attribute.clearUpdateRanges=()=>{rangeBytes=attribute.updateRanges.reduce((n,r)=>n+r.count,0)*attribute.array.BYTES_PER_ELEMENT;clear();};
      const previous=attribute.onUploadCallback;attribute.onUpload(()=>{
        previous.call(attribute);const bytes=first?attribute.array.byteLength:(rangeBytes??attribute.array.byteLength);
        if(first){clear();first=false;}rangeBytes=undefined;
        if(this.disposed)return;this.stats.uploadCalls++;this.stats.uploadedBytes+=bytes;this.stats.lastUploadBytes+=bytes;
      });
    }
  }
  private retire(slot:StreamSlot):void {
    if(slot.job){slot.job.return(undefined as never);this.stats.cancelled++;}
    slot.ground?.dispose();slot.vegetation?.dispose();this.slots.delete(slot.key);this.coverageVersion++;this.stats.evicted++;
  }
  private cacheReady(x:number,z:number,r:number,value:boolean):boolean {
    this.readyX=x;this.readyZ=z;this.readyRadius=r;this.readyVersion=this.coverageVersion;this.readyValue=value;return value;
  }
  private ready(x:number,z:number,r:number):boolean {
    // Exact coordinates, radius AND content epoch: subcell movement and newly completed
    // ground/vegetation must never reuse an approximate cell-centred exposure result.
    if(this.readyVersion===this.coverageVersion&&x===this.readyX&&z===this.readyZ&&r===this.readyRadius){this.stats.readyCacheHits++;return this.readyValue;}
    this.stats.readyScans++;
    const half=Math.ceil((r+4)/3),cx=Math.floor(x/3),cz=Math.floor(z/3);
    for(let dz=-half;dz<=half;dz++)for(let dx=-half;dx<=half;dx++){
      const gx=cx+dx,gz=cz+dz,slot=this.slots.get(`${gx}:${gz}`);
      if(cellIntersects(gx,gz,x,z,r+3)&&!slot?.ground)return this.cacheReady(x,z,r,false);
      if(cellIntersects(gx,gz,x,z,r,3)&&!slot?.vegetation)return this.cacheReady(x,z,r,false);
    }
    return this.cacheReady(x,z,r,true);
  }
  canExpose(position:THREE.Vector3):boolean {return this.ready(position.x/this.height,position.z/this.height,this.radius.value);}
  /** Only the viewer's main render-frame hook calls this, including pause/capture. */
  pump(position:THREE.Vector3,background?:THREE.Color):void {
    if(this.disposed)return;
    const start=performance.now(),stats=this.stats;stats.pumps++;if(stats.lastUploadBytes>65536)stats.actualUploadOverages++;stats.lastUploadBytes=0;stats.lastBytes=0;stats.completed=0;
    const x=position.x/this.height,z=position.z/this.height;
    if(background)this.colour.value.copy(background);
    // A settled, unchanged target cannot acquire new work. Keep live uniforms and upload
    // accounting current, but do not allocate keys, scan readiness/visibility or plan jobs.
    // Exact movement always takes the normal path, retaining radial fade and canopy LOD.
    if(this.hasTarget&&!this.bootstrap&&this.envelopeTier===this.tier&&this.radius.value===STREAM_TIERS[this.tier].radius&&x===this.x&&z===this.z&&stats.queue===0){
      stats.steadySkips++;this.anchor.value.set(x,z);this.finishPump(start);return;
    }
    // Explicit relocation may invalidate the entire old view. Prepare the approved 8H
    // minimum view first, not a synchronous/full high-tier catchup. Source fidelity is
    // unchanged; larger ready bands follow. Ordinary/tier-expansion views never collapse.
    if(!this.hasTarget||(Math.hypot(x-this.x,z-this.z)>3&&!this.ready(x,z,this.radius.value))){this.bootstrap=true;this.radius.value=8;this.groundRadius.value=11;}
    this.hasTarget=true;this.x=x;this.z=z;
    const {radius:r,half,cap}=STREAM_TIERS[this.tier],cx=Math.floor(this.x/3),cz=Math.floor(this.z/3);
    const preparingRadius=this.bootstrap?Math.min(r,this.ready(x,z,this.radius.value)?(this.radius.value===8?12:18):this.radius.value):r;
    // Retire BEFORE admitting any target work, including tier shrink/teleport. Complete
    // envelope reservation is intentional: ground, staging and vegetation share each slot.
    if(cx!==this.envelopeX||cz!==this.envelopeZ||this.tier!==this.envelopeTier){
      stats.envelopeRebuilds++;
      for(const slot of this.slots.values())if(Math.abs(slot.cx-cx)>half||Math.abs(slot.cz-cz)>half)this.retire(slot);
      for(let dz=-half;dz<=half;dz++)for(let dx=-half;dx<=half;dx++){
        const gx=cx+dx,gz=cz+dz,key=`${gx}:${gz}`;
        if(!this.slots.has(key)){this.slots.set(key,{key,cx:gx,cz:gz,near:cellIntersects(gx,gz,this.x,this.z,12)});this.coverageVersion++;}
      }
      this.envelopeX=cx;this.envelopeZ=cz;this.envelopeTier=this.tier;
    }
    if(this.slots.size>cap||this.slots.size>289)throw new Error('Forest identity envelope exceeded');
    // Only one phase is consumed: a stable linear minimum preserves priority/distance
    // ordering without allocating queue records or sorting an otherwise unused tail.
    let next:StreamSlot|undefined,nextPriority=Infinity,nextDistance=Infinity,queued=0;
    stats.planningScans+=this.slots.size;
    for(const slot of this.slots.values()){
      const core=cellIntersects(slot.cx,slot.cz,this.x,this.z,r,3);
      const prefetch=cellIntersects(slot.cx,slot.cz,this.x,this.z,r+2,3);
      const dx=slot.cx*3+1.5-this.x,dz=slot.cz*3+1.5-this.z,distance=dx*dx+dz*dz;
      // Stable near tier per cell, upgraded before it enters 10H; retain high detail until
      // eviction rather than thrashing/reuploading during boundary oscillation.
      const near=cellIntersects(slot.cx,slot.cz,this.x,this.z,12);
      if(near&&!slot.near&&!slot.vegetation){slot.near=true;if(slot.job){slot.job.return(undefined as never);slot.job=undefined;stats.cancelled++;}}
      const requiredGround=cellIntersects(slot.cx,slot.cz,this.x,this.z,preparingRadius+3);
      const requiredVegetation=cellIntersects(slot.cx,slot.cz,this.x,this.z,preparingRadius,3);
      let priority=Infinity;
      if(!slot.ground)priority=requiredGround?0:2;
      else if(near&&!slot.near&&slot.vegetation)priority=.5;
      else if(!slot.vegetation&&prefetch)priority=requiredVegetation?1:core?3:4;
      if(priority!==Infinity){queued++;if(priority<nextPriority||(priority===nextPriority&&distance<nextDistance)){next=slot;nextPriority=priority;nextDistance=distance;}}
    }
    stats.queue=queued;stats.peakQueue=Math.max(stats.peakQueue,queued);stats.peakSlots=Math.max(stats.peakSlots,this.slots.size);
    // Finite generators yield after tree canopy and each 1H meadow patch. One completed
    // cell-phase per actual frame; CPU/upload limits are SOFT, with real overages recorded.
    if(next){
      const slot=next;
      if(!slot.ground){slot.ground=this.builder.ground(slot.cx,slot.cz);this.coverageVersion++;this.observe(slot.ground);stats.generatedGround++;stats.lastBytes=slot.ground.bytes;stats.completed++;}
      else if(nextPriority===.5){stats.lastBytes=slot.vegetation?.promoteNear?.()??0;slot.near=true;stats.promotedCanopy++;stats.completed++;}
      else {
        slot.job??=this.builder.vegetation(slot.cx,slot.cz,slot.near);
        do {const result=slot.job.next();if(result.done){slot.vegetation=result.value;this.coverageVersion++;this.observe(slot.vegetation);slot.job=undefined;stats.generatedVegetation++;stats.lastBytes=result.value.bytes;stats.completed++;break;}}while(performance.now()-start<1);
      }
    }
    if(this.ready(this.x,this.z,preparingRadius)){this.radius.value=preparingRadius;this.groundRadius.value=preparingRadius+3;if(preparingRadius===r)this.bootstrap=false;}
    if(!this.ready(this.x,this.z,this.radius.value))stats.loadingFrames++;
    this.anchor.value.set(this.x,this.z);
    for(const slot of this.slots.values()){
      if(slot.ground){const visible=cellIntersects(slot.cx,slot.cz,this.x,this.z,this.groundRadius.value);slot.ground.group.visible=visible;slot.ground.setVisible?.(visible,this.x,this.z,this.radius.value);}
      if(slot.vegetation){
        slot.vegetation.group.visible=cellIntersects(slot.cx,slot.cz,this.x,this.z,this.radius.value,3);
        for(const mesh of slot.vegetation.group.children)if(mesh instanceof THREE.InstancedMesh&&['world-meadow-grass','world-fallen-leaves','world-moss-stones'].includes(mesh.name))mesh.visible=mesh.count>0&&cellIntersects(slot.cx,slot.cz,this.x,this.z,Math.min(12,this.radius.value),1);
      }
    }
    this.builder.setVisible?.(this.x,this.z,this.radius.value);
    this.finishPump(start);
  }
  private finishPump(start:number):void {
    const stats=this.stats;
    stats.lastMs=performance.now()-start;stats.maxMs=Math.max(stats.maxMs,stats.lastMs);stats.preparedBytes+=stats.lastBytes;
    if(stats.lastMs>1)stats.cpuOverages++;if(stats.lastBytes>65536)stats.uploadOverages++;
  }
  inspect(){return {...this.stats,tier:this.tier,radiusH:this.radius.value,targetRadiusH:STREAM_TIERS[this.tier].radius,groundRadiusH:this.groundRadius.value,slots:this.slots.size,bootstrap:this.bootstrap,cap:STREAM_TIERS[this.tier].cap,groundReady:[...this.slots.values()].filter(s=>s.ground).length,vegetationReady:[...this.slots.values()].filter(s=>s.vegetation).length,descriptorCache:0,disposed:this.disposed};}
  dispose():void {if(this.disposed)return;this.disposed=true;for(const slot of this.slots.values())this.retire(slot);this.stats.queue=0;}
}
