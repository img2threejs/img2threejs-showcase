import * as THREE from 'three';
import { inRiverH, riverCentreH, riverWidthH, RIVER_LEVEL_H } from './grootRiverPath';
import { forestGround } from './grootTerrain';
import { GrootWaterReflection } from './grootWaterReflection';

const WAVE_CAPACITY=16,DROP_CAPACITY=128,WAVE_LIFE=2.5;
/** A shallow dielectric surface: advected multi-scale normals and anchored dispersive wakes. */
export class GrootRiver {
  readonly group=new THREE.Group();
  readonly surface:THREE.Mesh<THREE.BufferGeometry,THREE.MeshPhysicalMaterial>;
  readonly drops:THREE.Points;
  readonly clock={value:0};
  readonly reflection:GrootWaterReflection;
  readonly waves=Array.from({length:WAVE_CAPACITY},()=>new THREE.Vector4(0,0,99,0));
  readonly headings=Array.from({length:WAVE_CAPACITY},()=>new THREE.Vector2(1,0));
  crossings=0;
  emitted=0;
  wet=false;
  disposed=false;
  private ready=false;
  private distance=0;
  private cursor=0;
  private readonly previous=new THREE.Vector3();
  private readonly positions=new Float32Array(DROP_CAPACITY*3);
  private readonly velocities=new Float32Array(DROP_CAPACITY*3);
  private readonly ages=new Float32Array(DROP_CAPACITY).fill(99);
  private readonly alphas=new Float32Array(DROP_CAPACITY);
  private readonly sizes=new Float32Array(DROP_CAPACITY);
  private readonly bankGeometry:THREE.BufferGeometry;
  constructor(readonly height:number,bankMaterial:THREE.Material|THREE.Material[]){
    this.group.name='groot-woodland-river';
    this.reflection=new GrootWaterReflection(RIVER_LEVEL_H*height);
    const geometry=new THREE.PlaneGeometry(1,1,272,24),p=geometry.attributes.position,uv=geometry.attributes.uv;
    const depths=new Float32Array(p.count);
    for(let i=0;i<p.count;i++){
      const x=(uv.getX(i)*2-1)*34,side=uv.getY(i)*2-1,z=riverCentreH(x)+side*riverWidthH(x);
      p.setXYZ(i,x*height,RIVER_LEVEL_H*height,z*height);depths[i]=Math.max(0,RIVER_LEVEL_H-forestGround(x*height,z*height,height)/height);
    }
    geometry.setAttribute('riverDepth',new THREE.BufferAttribute(depths,1));geometry.computeVertexNormals();
    const material=new THREE.MeshPhysicalMaterial({color:'#436653',roughness:.085,metalness:0,ior:1.333,transparent:true,opacity:.93,depthWrite:false,side:THREE.DoubleSide});
    material.forceSinglePass=true;
    material.onBeforeCompile=shader=>{
      Object.assign(shader.uniforms,{riverTime:this.clock,riverHeight:{value:height},riverWaves:{value:this.waves},riverHeadings:{value:this.headings},riverReflection:this.reflection.texture,riverReflectionMatrix:this.reflection.matrix,riverReflectionReady:this.reflection.ready});
      shader.vertexShader='attribute float riverDepth;varying vec3 vRiverWorld;varying float vRiverDepth;\n'+shader.vertexShader;
      shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvRiverWorld=(modelMatrix*vec4(position,1.)).xyz;vRiverDepth=riverDepth;');
      shader.fragmentShader=`
        uniform float riverTime,riverHeight,riverReflectionReady;
        uniform vec4 riverWaves[${WAVE_CAPACITY}];uniform vec2 riverHeadings[${WAVE_CAPACITY}];
        uniform sampler2D riverReflection;uniform mat4 riverReflectionMatrix;
        varying vec3 vRiverWorld;varying float vRiverDepth;
        float riverHash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
        float riverNoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(riverHash(i),riverHash(i+vec2(1,0)),f.x),mix(riverHash(i+vec2(0,1)),riverHash(i+vec2(1)),f.x),f.y);}
        vec2 riverSlope(vec2 p){
          float warp=riverNoise(p*1.73+vec2(-riverTime*.09,.03*riverTime));
          vec2 q=p+vec2(-riverTime*.19,warp*.13),slope=vec2(0.);
          // Incommensurate scales, directions and phases break up UV-aligned stripes.
          slope+=vec2(.96,.28)*cos(dot(q,vec2(.96,.28))*13.7+warp*2.7-riverTime*.81)*.049;
          slope+=vec2(-.36,.93)*cos(dot(q,vec2(-.36,.93))*24.1+warp*3.1-riverTime*1.13)*.040;
          slope+=vec2(.77,-.64)*cos(dot(q,vec2(.77,-.64))*39.3+warp*5.3+riverTime*1.71)*.029;
          slope+=vec2(.23,.97)*cos(dot(q,vec2(.23,.97))*68.7+warp*4.1-riverTime*2.41)*.019;
          slope+=vec2(-.89,.46)*cos(dot(q,vec2(-.89,.46))*107.9+warp*6.7+riverTime*3.17)*.012;
          slope+=vec2(.67,.74)*cos(dot(q,vec2(.67,.74))*173.3+warp*9.1-riverTime*4.37)*.008;
          for(int i=0;i<${WAVE_CAPACITY};i++){
            vec4 wave=riverWaves[i];if(wave.z>=${WAVE_LIFE.toFixed(1)}||wave.w<=0.)continue;
            vec2 delta=p-wave.xy;float r=length(delta);if(r<.015)continue;
            vec2 radial=delta/r;float age=wave.z,radius=.07+age*.64,width=.105+age*.067;
            float offset=r-radius,envelope=exp(-offset*offset/(width*width))*exp(-age*1.35)/sqrt(1.+r*5.);
            float phase=48.*(r-.89*age),carrier=cos(phase);
            // Distinct group/phase speeds create spreading wave trains instead of one flat ring.
            float derivative=(-2.*offset/(width*width)*carrier-48.*sin(phase))*envelope*.014*wave.w;
            float directional=.65+.35*abs(dot(radial,riverHeadings[i]));
            float broken=.82+.18*sin(atan(radial.y,radial.x)*7.+age*3.+float(i));
            slope+=radial*derivative*directional*broken;
          }
          return slope;
        }
      `+shader.fragmentShader;
      shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
        float depthFade=smoothstep(.0,.045,vRiverDepth);
        float depthTint=1.-exp(-vRiverDepth*7.);
        diffuseColor.rgb=mix(vec3(.10,.135,.075),vec3(.024,.072,.061),depthTint);
        diffuseColor.a*=depthFade;
      `);
      shader.fragmentShader=shader.fragmentShader.replace('#include <normal_fragment_begin>',`#include <normal_fragment_begin>
        vec2 waterSlope=riverSlope(vRiverWorld.xz/riverHeight)*smoothstep(0.,.07,vRiverDepth);
        vec3 waterWorldNormal=normalize(vec3(-waterSlope.x,1.,-waterSlope.y));
        normal=normalize(mat3(viewMatrix)*waterWorldNormal);
      `);
      shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>',`
        float fresnel=.0204+.9796*pow(1.-max(0.,dot(normal,normalize(vViewPosition))),5.);
        vec4 reflected=riverReflectionMatrix*vec4(vRiverWorld,1.);
        vec2 reflectedUV=reflected.xy/reflected.w+waterSlope*.055;
        vec3 reflectionColour=texture2D(riverReflection,clamp(reflectedUV,.002,.998),.8).rgb;
        outgoingLight=mix(outgoingLight,reflectionColour,clamp(fresnel*.9+.08,.0,.93)*riverReflectionReady);
        // Shallow banks dissolve, and the real bed stays visible at steep viewing angles.
        diffuseColor.a*=mix(.74,1.,clamp(fresnel*1.45,0.,1.));
        #include <opaque_fragment>
      `);
    };
    material.customProgramCacheKey=()=> 'groot-river-dispersive-v2';
    this.surface=new THREE.Mesh(geometry,material);this.surface.name='moonroot-running-water';this.surface.receiveShadow=true;this.group.add(this.surface);
    this.surface.onBeforeRender=(renderer,scene,camera)=>{
      const x=camera.position.x/height,z=camera.position.z/height;
      if(Math.abs(x)<39&&Math.abs(z-riverCentreH(x))<12)this.reflection.render(renderer,scene,camera,this.surface);
    };
    const vertices:number[]=[],uvs:number[]=[],indices:number[]=[],colours:number[]=[];
    for(const side of [-1,1]){
      const start=vertices.length/3;
      for(let i=0;i<=272;i++)for(let j=0;j<=6;j++){
        const x=-34+i*.25,z=riverCentreH(x)+side*(riverWidthH(x)*.78+j/6*1.25);
        vertices.push(x*height,forestGround(x*height,z*height,height)+.006*height,z*height);uvs.push(x*.75,z*.75);
        const patch=.88+.12*Math.sin(x*.61+Math.sin(z*.47));colours.push(patch,patch*.98,patch*.9);
      }
      for(let i=0;i<272;i++)for(let j=0;j<6;j++){
        const a=start+i*7+j,b=a+7;
        if(side===1)indices.push(a,a+1,b,b,a+1,b+1);else indices.push(a,b,a+1,b,b+1,a+1);
      }
    }
    const banks=this.bankGeometry=new THREE.BufferGeometry();banks.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));banks.setAttribute('color',new THREE.Float32BufferAttribute(colours,3));banks.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));banks.setIndex(indices);banks.computeVertexNormals();
    const bank=new THREE.Mesh(banks,bankMaterial);bank.name='river-soft-soil-banks';bank.receiveShadow=true;this.group.add(bank);
    const drops=new THREE.BufferGeometry();drops.setAttribute('position',new THREE.BufferAttribute(this.positions,3));drops.setAttribute('aAlpha',new THREE.BufferAttribute(this.alphas,1));drops.setAttribute('aSize',new THREE.BufferAttribute(this.sizes,1));
    this.drops=new THREE.Points(drops,new THREE.ShaderMaterial({transparent:true,depthWrite:false,
      vertexShader:'attribute float aAlpha,aSize;varying float vAlpha;void main(){vAlpha=aAlpha;vec4 p=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*p;gl_PointSize=clamp(aSize/max(.1,-p.z),1.,7.);}',
      fragmentShader:'varying float vAlpha;void main(){vec2 p=gl_PointCoord-.5;float r=length(p*vec2(1.,.75));if(r>.5)discard;float glint=pow(max(0.,1.-length(p-vec2(-.12,.13))*2.),4.);gl_FragColor=vec4(mix(vec3(.18,.34,.31),vec3(.83,.96,.91),glint),vAlpha*(1.-smoothstep(.22,.5,r))*.7);}'
    }));this.drops.name='river-splash-droplets';this.drops.frustumCulled=false;this.group.add(this.drops);this.animate(0);
  }
  contains(position:THREE.Vector3):boolean{return inRiverH(position.x/this.height,position.z/this.height)&&forestGround(position.x,position.z,this.height)<RIVER_LEVEL_H*this.height;}
  update(dt:number,position:THREE.Vector3,grounded:boolean):void{
    if(this.disposed||dt<=0)return;this.clock.value+=dt;
    const wet=this.contains(position)&&grounded,dx=position.x-this.previous.x,dz=position.z-this.previous.z,distance=this.ready?Math.hypot(dx,dz):0;
    const travelling=distance>1e-5&&distance<this.height*1.5;
    if(wet&&this.ready&&travelling){
      if(!this.wet){this.crossings++;this.emit(position,dx,dz,distance/dt);this.distance=0;}
      else{this.distance+=distance;if(this.distance>this.height*.22){this.emit(position,dx,dz,distance/dt);this.distance%=this.height*.22;}}
    }
    if(!wet)this.distance=0;
    this.wet=wet;this.ready=true;this.previous.copy(position);this.animate(dt);
  }
  private emit(position:THREE.Vector3,dx:number,dz:number,speed:number):void{
    const slot=this.cursor++%WAVE_CAPACITY,len=Math.hypot(dx,dz),side=this.cursor%2?1:-1;
    let x=position.x/this.height-dz/len*.085*side,z=position.z/this.height+dx/len*.085*side;
    if(!inRiverH(x,z)||forestGround(x*this.height,z*this.height,this.height)>=RIVER_LEVEL_H*this.height){x=position.x/this.height;z=position.z/this.height;}
    const strength=THREE.MathUtils.clamp(speed/this.height,.35,1.3);
    this.waves[slot].set(x,z,0,strength);this.headings[slot].set(dx/len,dz/len);this.emitted++;
    for(let j=0;j<8;j++){
      const i=slot*8+j,at=i*3,seed=Math.sin((this.emitted*13.7+j)*71.31)*43758.5,rand=seed-Math.floor(seed),a=j*2.399+this.emitted*.87;
      this.positions[at]=x*this.height+Math.cos(a)*this.height*.035;this.positions[at+1]=(RIVER_LEVEL_H+.014)*this.height;this.positions[at+2]=z*this.height+Math.sin(a)*this.height*.035;
      this.velocities[at]=(Math.cos(a)*(.10+rand*.28)+dx/len*.14)*this.height*strength;this.velocities[at+1]=this.height*(.23+rand*.5)*Math.sqrt(strength);this.velocities[at+2]=(Math.sin(a)*(.10+rand*.28)+dz/len*.14)*this.height*strength;this.ages[i]=0;this.sizes[i]=(3+rand*7)*this.height;
    }
    this.drops.geometry.attributes.aSize.needsUpdate=true;
  }
  private animate(dt:number):void{
    for(const wave of this.waves){wave.z+=dt;if(wave.z>=WAVE_LIFE)wave.w=0;}
    let airborne=0;
    for(let i=0;i<DROP_CAPACITY;i++){
      this.ages[i]+=dt;const at=i*3;this.alphas[i]=0;if(this.ages[i]>.75)continue;
      this.velocities[at+1]-=this.height*2.8*dt;
      for(let k=0;k<3;k++)this.positions[at+k]+=this.velocities[at+k]*dt;
      if(this.positions[at+1]<RIVER_LEVEL_H*this.height){this.ages[i]=99;continue;}
      this.alphas[i]=1-this.ages[i]/.75;airborne++;
    }
    this.drops.visible=airborne>0;this.drops.geometry.attributes.position.needsUpdate=true;this.drops.geometry.attributes.aAlpha.needsUpdate=true;
  }
  inspect(){return{wet:this.wet,crossings:this.crossings,emitted:this.emitted,time:this.clock.value,ripples:this.waves.filter(r=>r.w>0).length,drops:this.alphas.filter(a=>a>0).length,waveCapacity:WAVE_CAPACITY,dropCapacity:DROP_CAPACITY,waves:this.waves.filter(r=>r.w>0).map(r=>({x:r.x,z:r.y,age:r.z,radiusH:.07+r.z*.64,envelope:Math.exp(-r.z*1.35)*r.w})),reflection:{size:this.reflection.size,maxHz:this.reflection.maxHz,frames:this.reflection.frames,drawCalls:this.reflection.lastDrawCalls,averageCpuMs:this.reflection.frames?this.reflection.totalMs/this.reflection.frames:0},disposed:this.disposed};}
  dispose():void {
    if(this.disposed)return;this.disposed=true;this.surface.onBeforeRender=()=>{};this.reflection.dispose();
    this.surface.geometry.dispose();this.surface.material.dispose();this.bankGeometry.dispose();this.drops.geometry.dispose();(this.drops.material as THREE.Material).dispose();
  }
}
