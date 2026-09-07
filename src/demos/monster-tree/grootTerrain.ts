import * as THREE from 'three';
import { FAULTLINE } from './grootFaultline';
import { GrootStreaming, type StreamPart } from './grootStreaming';
import { GrootTerrainChunks } from './grootTerrainChunks';
import { GrootWorld, forestGround, forestHeightH, forestHash as random } from './grootWorld';
export { forestGround, forestHeightH, GROOT_WORLD_RADIUS_H } from './grootWorld';
const TREE_ATTACKS=new Set(['pierce','sweep','seismic','ground','gather','seed','roar','freeze']);

/** Analytic gameplay/reactions plus independently resident, incremental forest cells. */
export class GrootTerrain {
  readonly group=new THREE.Group();
  readonly ground:THREE.Mesh;
  readonly world:GrootWorld;
  readonly stream:GrootStreaming;
  readonly chunks:GrootTerrainChunks;
  /** River ground-phase attachment; all geometry belongs to the same spatial slot. */
  riverCell?: (cx:number,cz:number)=>StreamPart;
  /** Inspection-only list of actual render buffers, never an aggregate staging mesh. */
  get grassTiles():THREE.InstancedMesh[]{return [...this.chunks.batches.buckets.values()].map(b=>b.mesh).filter(m=>m.name==='world-meadow-grass');}
  private readonly wind={value:0};
  readonly grassBrushes=Array.from({length:16},()=>new THREE.Vector4());
  readonly grassAges=new Float32Array(16).fill(99);
  private readonly grassWeights=new Float32Array(16);
  readonly treeHits=Array.from({length:8},()=>new THREE.Vector4());
  readonly treeDirections=Array.from({length:8},()=>new THREE.Vector2());
  readonly treeAges=new Float32Array(8).fill(99);
  private readonly treeResponses=new Float32Array(8);
  private readonly treeDebrisPending=new Uint8Array(8);
  private readonly treeContactTime=new Float32Array(8);
  readonly lastTreeHit=new THREE.Vector3();
  lastHitCount=0;
  private brushCursor=0;
  private treeCursor=0;
  private readonly previousPlayer=new THREE.Vector2();
  private playerReady=false;
  constructor(readonly height:number,bark:THREE.Material,leaf:THREE.BufferGeometry,foliage:THREE.Material){
    this.world=new GrootWorld(height);
    this.group.name='groot-open-woodland';this.group.visible=false;
    // Empty compatibility material handle, never a global draw/ground mesh.
    const geometry=new THREE.BufferGeometry();
    const soil=new THREE.TextureLoader().load('/textures/groot/forest-floor-v1.png');soil.colorSpace=THREE.SRGBColorSpace;soil.wrapS=soil.wrapT=THREE.RepeatWrapping;soil.anisotropy=8;
    // Relief is authored independently of the albedo: don't mistake dark leaves for deep holes.
    const relief=soilRelief();
    this.ground=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color:'#b4b4a6',map:soil,vertexColors:true,bumpMap:relief,bumpScale:.012,roughness:.96}));this.ground.name='layered-forest-earth';this.ground.receiveShadow=true;this.group.add(this.ground);
    this.ground.visible=false;
    this.installTreeReaction(bark);this.installTreeReaction(foliage);
    const grassMat=new THREE.MeshStandardMaterial({color:'#8a9670',roughness:.9,side:THREE.DoubleSide,vertexColors:false});
    grassMat.onBeforeCompile=shader=>{
      shader.uniforms.worldWind=this.wind;shader.uniforms.grassBrushes={value:this.grassBrushes};shader.uniforms.grassWeights={value:this.grassWeights};
      shader.vertexShader='uniform float worldWind; uniform vec4 grassBrushes[16]; uniform float grassWeights[16];\n'+shader.vertexShader;
      shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
        transformed.x+=sin(worldWind*1.7+instanceMatrix[3].x*2.0+instanceMatrix[3].z)*position.y*position.y*.18;
        vec2 brushBend=vec2(0.);float pressure=0.;
        for(int i=0;i<16;i++){
          if(grassWeights[i]<.0001)continue;
          float d=distance(instanceMatrix[3].xz,grassBrushes[i].xy);
          float w=(1.-smoothstep(.12,.55,d))*grassWeights[i];
          brushBend+=grassBrushes[i].zw*w;pressure=max(pressure,w);
        }
        float bendLength=length(brushBend);if(bendLength>1.)brushBend/=bendLength;
        // Brush headings are world-aligned; each tuft has its own random yaw.
        vec2 localBend=vec2(dot(brushBend,normalize(instanceMatrix[0].xz)),dot(brushBend,normalize(instanceMatrix[2].xz)));
        transformed.xz+=localBend*position.y*position.y*.85;
        transformed.y*=1.-pressure*.68;
      `);
    };
    this.chunks=new GrootTerrainChunks(this,treeGeometry(),bark,leaf,foliage,grassGeometry(),grassMat);
    this.stream=new GrootStreaming(this.group,height,this.chunks);
    this.stream.fade(bark);this.stream.fade(foliage);this.stream.fade(grassMat,false,true);
    this.stream.fade(this.ground.material as THREE.Material,true);
    this.chunks.installFade();
  }
  update(dt:number,origin:THREE.Vector3):void{
    this.group.visible=true;this.wind.value+=dt;
    for(let i=0;i<16;i++)this.grassAges[i]+=dt;for(let i=0;i<8;i++)if(this.treeAges[i]>=0)this.treeAges[i]+=dt;
    const x=origin.x/this.height,z=origin.z/this.height,dx=x-this.previousPlayer.x,dz=z-this.previousPlayer.y,distance=Math.hypot(dx,dz);
    if(this.playerReady&&distance>.035&&distance<1.5){const i=this.brushCursor++%16;this.grassBrushes[i].set(x,z,dx/distance,dz/distance);this.grassAges[i]=0;this.previousPlayer.set(x,z);}
    if(!this.playerReady||distance>=1.5){this.previousPlayer.set(x,z);this.playerReady=true;}
    // These envelopes are uniform across every vertex: evaluate 24 times, not millions.
    for(let i=0;i<16;i++)this.grassWeights[i]=Math.exp(-this.grassAges[i]*2.3);
    for(let i=0;i<8;i++){const age=Math.max(0,this.treeAges[i]);this.treeResponses[i]=Math.sin(age*13)*Math.exp(-age*2.5)*this.treeHits[i].w;}
    // No scene construction, queue pumping or instance uploads in fixed simulation steps.
  }
  strike(kind:string,origin:THREE.Vector3,facing:THREE.Vector3,clipTime=0,groundRadiusH=1.65):number{
    this.lastHitCount=0;
    if(!TREE_ATTACKS.has(kind))return 0;
    const h=this.height,heavy=kind==='ground'||kind==='seismic'||kind==='roar';
    const reach=kind==='seismic'?Math.hypot(FAULTLINE.offsetM/h+(FAULTLINE.columns-1)*FAULTLINE.spacingH+FAULTLINE.paddingH,.36)
      :kind==='ground'||kind==='roar'?groundRadiusH:kind==='freeze'?.7:Math.hypot(2.05,.75);
    // Rectangle-style attacks pad both axes; conservatively include their padded corners.
    for(const tree of this.world.queryRadius(origin.x,origin.z,(reach+.4)*h)){
      const dx=(tree.x-origin.x)/h,dz=(tree.z-origin.z)/h;
      const along=dx*facing.x+dz*facing.z,across=Math.abs(dx*facing.z-dz*facing.x),padding=tree.radius/h;
      const start=FAULTLINE.offsetM/h;
      const hit=kind==='seismic'?along>start-FAULTLINE.paddingH-padding&&along<start+(FAULTLINE.columns-1)*FAULTLINE.spacingH+FAULTLINE.paddingH+padding&&across<.36+padding
        :kind==='ground'||kind==='roar'||kind==='freeze'?Math.hypot(dx,dz)<(kind==='freeze'?.7:groundRadiusH)+padding
        :along>-.1&&along<(kind==='sweep'?1.65:2.05)+padding&&across<(kind==='sweep'?.75:.27)+padding;
      if(!hit)continue;
      const index=this.treeCursor++%8;this.treeHits[index].set(tree.x/h,tree.z/h,forestHeightH(tree.x/h,tree.z/h),heavy?1:.6);this.treeDirections[index].set(facing.x,facing.z);
      // Faultline travels .12 H every .012 s; a trunk reacts as its column rises.
      this.treeContactTime[index]=clipTime+(kind==='seismic'?Math.max(0,along-start)/FAULTLINE.spacingH*FAULTLINE.stepSeconds+.06:0);
      this.treeAges[index]=-1;this.treeDebrisPending[index]=1;
      this.lastTreeHit.set(tree.x,forestGround(tree.x,tree.z,h)+.5*h,tree.z);this.lastHitCount++;
    }
    return this.lastHitCount;
  }
  advanceImpacts(clipTime:number):void{
    for(let i=0;i<8;i++)if(this.treeDebrisPending[i]&&this.treeAges[i]<0&&clipTime>=this.treeContactTime[i])this.treeAges[i]=0;
  }
  cancelPendingImpacts():void{
    for(let i=0;i<8;i++)if(this.treeAges[i]<0){this.treeAges[i]=99;this.treeDebrisPending[i]=0;}
  }
  consumeTreeDebris(out:THREE.Vector3):boolean{
    for(let i=0;i<8;i++)if(this.treeDebrisPending[i]&&this.treeAges[i]>=0){
      this.treeDebrisPending[i]=0;const hit=this.treeHits[i];out.set(hit.x*this.height,(hit.z+.5)*this.height,hit.y*this.height);return true;
    }
    return false;
  }
  installTreeReaction(material:THREE.Material):void{
    const previous=material.onBeforeCompile.bind(material);
    material.onBeforeCompile=(shader,renderer)=>{
      previous(shader,renderer);shader.uniforms.treeHits={value:this.treeHits};shader.uniforms.treeResponses={value:this.treeResponses};shader.uniforms.treeDirections={value:this.treeDirections};
      shader.vertexShader=`uniform vec4 treeHits[8];uniform float treeResponses[8];uniform vec2 treeDirections[8];
        float rootGround(vec2 p){return smoothstep(2.4,7.,length(p))*(.24*sin(p.x*.23)*cos(p.y*.19)+.12*sin(p.x*.51+p.y*.29)+.055*sin(p.y*1.1-p.x*.7));}
      `+shader.vertexShader;
      shader.vertexShader=shader.vertexShader.replace('#include <project_vertex>',`#include <project_vertex>
        vec4 woodPosition=vec4(transformed,1.);
        #ifdef USE_INSTANCING
          woodPosition=instanceMatrix*woodPosition;
        #endif
        vec3 woodWorld=(modelMatrix*woodPosition).xyz/${this.height.toFixed(8)};
        float rootFit=0.;
        #ifdef USE_INSTANCING
          vec3 rootBase=(modelMatrix*vec4(instanceMatrix[3].xyz,1.)).xyz/${this.height.toFixed(8)};
          rootFit=(rootGround(woodWorld.xz)-rootGround(rootBase.xz))*(1.-smoothstep(.04,.38,woodWorld.y-rootBase.y));
        #endif
        vec2 woodBend=vec2(0.);
        for(int i=0;i<8;i++){
          if(abs(treeResponses[i])<.00001)continue;
          float proximity=1.-smoothstep(.22,1.6,distance(woodWorld.xz,treeHits[i].xy));
          float response=treeResponses[i];
          float lever=pow(clamp((woodWorld.y-treeHits[i].z)/2.8,0.,1.),1.5);
          woodBend+=treeDirections[i]*proximity*response*lever*.24;
        }
        mvPosition.xyz+=(viewMatrix*vec4(woodBend.x*${this.height.toFixed(8)},rootFit*${this.height.toFixed(8)},woodBend.y*${this.height.toFixed(8)},0.)).xyz;
        gl_Position=projectionMatrix*mvPosition;
      `);
    };
  }
}

export function grassGeometry():THREE.BufferGeometry{
  const p:number[]=[],ix:number[]=[];
  for(let blade=0;blade<5;blade++){
    const a=blade*2.4,base=p.length/3;
    for(let row=0;row<=4;row++){const t=row/4,w=.035*(1-t);for(const side of [-1,1])p.push(Math.cos(a)*t*t*.32+Math.sin(a)*w*side,t*(.7+blade*.08),Math.sin(a)*t*t*.32-Math.cos(a)*w*side);if(row<4){const n=base+row*2;ix.push(n,n+2,n+1,n+1,n+2,n+3);}}
  }
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(p,3));g.setIndex(ix);g.computeVertexNormals();return g;
}
function treeGeometry():THREE.BufferGeometry{
  const positions:number[]=[],normals:number[]=[],uv:number[]=[],indices:number[]=[];
  const add=(points:THREE.Vector3[],radius:number):void=>{
    const curve=new THREE.CatmullRomCurve3(points),g=new THREE.TubeGeometry(curve,18,radius,10,false),p=g.attributes.position,at=positions.length/3,centre=new THREE.Vector3();
    for(let ring=0;ring<=18;ring++){curve.getPointAt(ring/18,centre);const taper=1-ring/18*.85;for(let j=0;j<=10;j++){const i=ring*11+j;const ridge=1+.14*Math.sin(j*3.1+ring*.7);p.setXYZ(i,centre.x+(p.getX(i)-centre.x)*taper*ridge,centre.y+(p.getY(i)-centre.y)*taper,centre.z+(p.getZ(i)-centre.z)*taper*ridge);}}
    g.computeVertexNormals();positions.push(...p.array);normals.push(...g.attributes.normal.array);uv.push(...g.attributes.uv.array);for(const i of g.index!.array)indices.push(i+at);g.dispose();
  };
  add([new THREE.Vector3(0,0,0),new THREE.Vector3(.08,1,0),new THREE.Vector3(-.08,2.3,.07),new THREE.Vector3(.12,3.3,0)],.19);
  for(let i=0;i<5;i++){const a=i*2.4,y=1.35+i*.23;add([new THREE.Vector3(0,y,0),new THREE.Vector3(Math.cos(a)*.48,y+.40,Math.sin(a)*.48),new THREE.Vector3(Math.cos(a)*1.2,y+.85,Math.sin(a)*1.2)],.068);}
  for(let i=0;i<4;i++){const a=i*1.57;add([new THREE.Vector3(0,.22,0),new THREE.Vector3(Math.cos(a)*.26,.035,Math.sin(a)*.26),new THREE.Vector3(Math.cos(a)*.6,-.015,Math.sin(a)*.6)],.075);}
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.setIndex(indices);return g;
}
function soilRelief():THREE.CanvasTexture{
  const c=document.createElement('canvas');c.width=c.height=256;const ctx=c.getContext('2d')!,data=ctx.createImageData(256,256);
  for(let y=0;y<256;y++)for(let x=0;x<256;x++){const value=120+18*Math.sin(x*.24)*Math.sin(y*.28)+random(x,y,82)*30,at=(y*256+x)*4;data.data[at]=data.data[at+1]=data.data[at+2]=value;data.data[at+3]=255;}ctx.putImageData(data,0,0);
  const texture=new THREE.CanvasTexture(c);texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.repeat.set(2,2);return texture;
}
