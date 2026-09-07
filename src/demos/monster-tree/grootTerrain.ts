import * as THREE from 'three';
import { FAULTLINE } from './grootFaultline';
import { inRiverH, riverDistanceH, riverWidthH, RIVER_LEVEL_H } from './grootRiverPath';

export const GROOT_WORLD_RADIUS_H=60;
/** Shared by the terrain vertices, player grounding and ground-born effects. Centre stays level. */
export function forestHeightH(x:number,z:number):number{
  const fade=THREE.MathUtils.smoothstep(Math.hypot(x,z),2.4,7);
  const base=fade*(.24*Math.sin(x*.23)*Math.cos(z*.19)+.12*Math.sin(x*.51+z*.29)+.055*Math.sin(z*1.1-x*.7));
  if(Math.abs(x)>=34)return base;
  const width=riverWidthH(x),d=riverDistanceH(x,z);
  const bed=RIVER_LEVEL_H-.20+.29*THREE.MathUtils.smoothstep(d,width*.45,width+ .20);
  return THREE.MathUtils.lerp(bed,base,THREE.MathUtils.smoothstep(d,width+.2,width+1.2));
}
export function forestGround(x:number,z:number,height:number):number{return forestHeightH(x/height,z/height)*height;}
const random=(x:number,z:number,salt=0):number=>{const n=Math.sin(x*127.1+z*311.7+salt*74.7)*43758.5453;return n-Math.floor(n);};
const TREE_ATTACKS=new Set(['pierce','sweep','seismic','ground','gather','seed','roar','freeze']);

/** A bounded, explorable forest with a fixed local vegetation pool. No runtime object creation. */
export class GrootTerrain {
  readonly group=new THREE.Group();
  readonly ground:THREE.Mesh;
  readonly trees:THREE.InstancedMesh;
  readonly canopy:THREE.InstancedMesh;
  readonly grass:THREE.InstancedMesh;
  /** The aggregate is a CPU staging buffer; these same-density tiles are the render objects. */
  readonly grassTiles:THREE.InstancedMesh[]=[];
  readonly litter:THREE.InstancedMesh;
  readonly stones:THREE.InstancedMesh;
  readonly colliders=Array.from({length:256},()=>({x:0,z:0,radius:0}));
  colliderCount=0;
  private cellX=Infinity;
  private cellZ=Infinity;
  private readonly dummy=new THREE.Object3D();
  private readonly colour=new THREE.Color();
  // Toroidal 32×32 cell cache: 3.6 MiB fixed storage. Most of a moving meadow overlaps its
  // previous region; reuse exact transforms/colours instead of re-running 140k trigonometric
  // samples at every boundary. Key checks handle collisions and arbitrary teleports.
  private readonly meadowX=new Int16Array(1024).fill(32767);
  private readonly meadowZ=new Int16Array(1024).fill(32767);
  private readonly meadowData=new Float32Array(1024*48*19);
  meadowCacheHits=0;
  meadowCacheMisses=0;
  private readonly wind={value:0};
  private readonly meshes:THREE.InstancedMesh[];
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
  constructor(readonly height:number,bark:THREE.Material,leaf:THREE.BufferGeometry,foliage:THREE.Material,private readonly oldColliders:{x:number;z:number;radius:number}[]){
    this.group.name='groot-open-woodland';this.group.visible=false;
    const geometry=new THREE.PlaneGeometry(128,128,256,256);geometry.rotateX(-Math.PI/2);
    const p=geometry.attributes.position,colours=new Float32Array(p.count*3),uv=geometry.attributes.uv;
    for(let i=0;i<p.count;i++){
      const x=p.getX(i),z=p.getZ(i);p.setY(i,forestHeightH(x,z)-.009);uv.setXY(i,x*.75,z*.75);
      const patch=.88+.12*Math.sin(x*.61+Math.sin(z*.47));this.colour.setRGB(patch,patch*.98,patch*.9).toArray(colours,i*3);
    }
    geometry.setAttribute('color',new THREE.BufferAttribute(colours,3));geometry.computeVertexNormals();
    const soil=new THREE.TextureLoader().load('/textures/groot/forest-floor-v1.png');soil.colorSpace=THREE.SRGBColorSpace;soil.wrapS=soil.wrapT=THREE.RepeatWrapping;soil.anisotropy=8;
    // Relief is authored independently of the albedo: don't mistake dark leaves for deep holes.
    const relief=soilRelief();
    this.ground=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color:'#b4b4a6',map:soil,vertexColors:true,bumpMap:relief,bumpScale:.012,roughness:.96}));this.ground.name='layered-forest-earth';this.ground.receiveShadow=true;this.group.add(this.ground);
    const make=(name:string,g:THREE.BufferGeometry,m:THREE.Material,capacity:number):THREE.InstancedMesh=>{
      const mesh=new THREE.InstancedMesh(g,m,capacity);mesh.name=name;mesh.count=0;mesh.visible=false;mesh.frustumCulled=false;mesh.receiveShadow=true;this.group.add(mesh);return mesh;
    };
    this.installTreeReaction(bark);this.installTreeReaction(foliage);
    this.trees=make('world-rooted-tree-trunks',treeGeometry(),bark,256);this.trees.castShadow=true;
    this.canopy=make('world-layered-canopy',leaf,foliage,18000);
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
    this.grass=make('world-meadow-grass',grassGeometry(),grassMat,28000);
    this.grass.setColorAt(0,this.colour);
    this.group.remove(this.grass);
    for(let i=0;i<25;i++){
      const tile=new THREE.InstancedMesh(this.grass.geometry,grassMat,2304);
      tile.name=`world-meadow-tile-${i}`;tile.count=0;tile.visible=false;tile.receiveShadow=true;
      tile.boundingSphere=new THREE.Sphere(new THREE.Vector3(),4.9);
      tile.setColorAt(0,this.colour);this.grassTiles.push(tile);this.group.add(tile);
    }
    this.litter=make('world-fallen-leaves',leaf,new THREE.MeshStandardMaterial({color:'#92744b',roughness:.96,side:THREE.DoubleSide}),6000);
    this.stones=make('world-moss-stones',new THREE.IcosahedronGeometry(1,1),new THREE.MeshStandardMaterial({color:'#6e7565',roughness:.95}),1800);
    this.meshes=[this.trees,this.canopy,this.grass,this.litter,this.stones];
    this.refresh(0,0);
    this.ground.visible=false;for(const mesh of this.meshes)mesh.visible=false;
    for(const tile of this.grassTiles)tile.visible=false;
  }
  private put(mesh:THREE.InstancedMesh,x:number,y:number,z:number,sx:number,sy:number,sz:number,yaw:number,tilt=0):void{
    if(mesh.count>=mesh.instanceMatrix.count)return;
    this.dummy.position.set(x,y,z);this.dummy.rotation.set(tilt,yaw,0);this.dummy.scale.set(sx,sy,sz);this.dummy.updateMatrix();mesh.setMatrixAt(mesh.count++,this.dummy.matrix);
  }
  private putMeadowCell(gx:number,gz:number,count:number):void{
    if(!count)return;
    const slot=((gx%32+32)%32)+((gz%32+32)%32)*32,base=slot*48*19,data=this.meadowData;
    if(this.meadowX[slot]!==gx||this.meadowZ[slot]!==gz){
      this.meadowX[slot]=gx;this.meadowZ[slot]=gz;this.meadowCacheMisses++;
      for(let j=0;j<count;j++){
        const px=gx+random(gx+j,gz,17),pz=gz+random(gx,gz+j,18),y=forestHeightH(px,pz),s=.07+random(gx-j,gz,19)*.16,at=base+j*19;
        this.dummy.position.set(px,y,pz);this.dummy.rotation.set(0,random(gx,gz-j,20)*6.28,0);this.dummy.scale.set(s,s,s);this.dummy.updateMatrix();this.dummy.matrix.toArray(data,at);
        this.colour.setHSL(.20+random(gx+j,gz,21)*.10,.28,.19+random(gx,gz+j,22)*.13).toArray(data,at+16);
      }
    }else this.meadowCacheHits++;
    const matrices=this.grass.instanceMatrix.array,colours=this.grass.instanceColor!.array;
    for(let j=0;j<count;j++){
      const at=base+j*19,target=this.grass.count++;
      if(inRiverH(data[at+12],data[at+14],.15)){this.grass.count--;continue;}
      for(let k=0;k<16;k++)matrices[target*16+k]=data[at+k];
      for(let k=0;k<3;k++)colours[target*3+k]=data[at+16+k];
    }
  }
  private refresh(x:number,z:number):void{
    const cx=Math.floor(x/3),cz=Math.floor(z/3);if(cx===this.cellX&&cz===this.cellZ)return;this.cellX=cx;this.cellZ=cz;
    this.trees.count=this.canopy.count=this.grass.count=this.litter.count=this.stones.count=0;this.colliderCount=0;
    for(let dz=-6;dz<=6;dz++)for(let dx=-6;dx<=6;dx++){
      const gx=cx+dx,gz=cz+dz,tx=gx*3+random(gx,gz)*2.3,tz=gz*3+random(gx,gz,1)*2.3,distance=Math.hypot(tx-x,tz-z);
      if(Math.hypot(tx,tz)<3.2||distance>18||Math.hypot(tx,tz)>GROOT_WORLD_RADIUS_H+2||inRiverH(tx,tz,.6))continue;
      const y=forestHeightH(tx,tz),size=.7+random(gx,gz,2)*.85,yaw=random(gx,gz,3)*6.28;
      this.put(this.trees,tx,y,tz,size,size,size,yaw);
      const collider=this.colliders[this.colliderCount++];collider.x=tx*this.height;collider.z=tz*this.height;collider.radius=size*.17*this.height;
      const leaves=distance<10?120:40;
      for(let j=0;j<leaves;j++){
        const angle=random(gx+j,gz,4)*6.28,r=Math.sqrt(random(gx,gz+j,5))*1.45*size;
        const lx=tx+Math.cos(angle)*r,lz=tz+Math.sin(angle)*r,ly=y+(2.35+random(gx+j,gz+j,6)*.85)*size;
        const s=(.12+random(gx-j,gz,7)*.20)*(distance<10?1:1.5);
        this.put(this.canopy,lx,ly,lz,s*.75,s,s,angle,-.65+random(gx,gz+j,8)*1.3);
      }
    }
    for(let dz=-12;dz<=12;dz++)for(let dx=-12;dx<=12;dx++){
      const gx=cx*3+dx,gz=cz*3+dz;if(Math.hypot(gx-x,gz-z)>12)continue;
      const clearing=THREE.MathUtils.smoothstep(Math.hypot(gx,gz),.7,2.5);
      const path=Math.abs(gz-2*Math.sin(gx*.19));const density=path<.65?.12:1;
      this.putMeadowCell(gx,gz,Math.ceil(48*clearing*density));
      for(let j=0;j<7;j++){
        const px=gx+random(gx+j,gz,23),pz=gz+random(gx,gz+j,24),s=.025+random(gx+j,gz,25)*.035;
        if(inRiverH(px,pz,.12))continue;
        this.put(this.litter,px,forestHeightH(px,pz)+.004,pz,s,s,s,random(gx,gz+j,26)*6.28,-Math.PI/2+.15);
      }
      if(random(gx,gz,27)>.68){const px=gx+random(gx,gz,28),pz=gz+random(gx,gz,29),s=.025+random(gx,gz,30)*.08;this.put(this.stones,px,forestHeightH(px,pz),pz,s,s*.5,s*.8,random(gx,gz,31)*6.28);}
    }
    // Dense uneven undergrowth knits the buttress roots into the same sampled earth.
    for(let i=0;i<this.colliderCount;i++){
      const tree=this.colliders[i],tx=tree.x/this.height,tz=tree.z/this.height;
      for(let j=0;j<24;j++){
        const a=j*2.399+i,r=.20+random(i,j,91)*.47,px=tx+Math.cos(a)*r,pz=tz+Math.sin(a)*r,s=.10+random(i,j,92)*.12;
        this.put(this.grass,px,forestHeightH(px,pz),pz,s,s,s,a);this.colour.setHSL(.24,.30,.26+random(i,j,93)*.12);this.grass.setColorAt(this.grass.count-1,this.colour);
      }
    }
    for(const mesh of this.meshes){mesh.visible=mesh.count>0;mesh.instanceMatrix.needsUpdate=true;if(mesh.instanceColor)mesh.instanceColor.needsUpdate=true;}
    this.tileGrass(cx*3-12,cz*3-12);
  }
  private tileGrass(baseX:number,baseZ:number):void{
    for(let i=0;i<25;i++){
      const tile=this.grassTiles[i];tile.count=0;
      tile.boundingSphere!.center.set(baseX+(i%5)*6+3,.35,baseZ+Math.floor(i/5)*6+3);
    }
    const matrices=this.grass.instanceMatrix.array,colours=this.grass.instanceColor!.array;
    for(let i=0;i<this.grass.count;i++){
      const at=i*16,x=matrices[at+12],z=matrices[at+14];
      const bx=Math.floor((x-baseX)/6),bz=Math.floor((z-baseZ)/6);
      // Tree-root tufts at the edge can extend beyond the main meadow square. Clamp into an
      // edge tile, then expand its preallocated sphere below so nothing gets culled too early.
      const tile=this.grassTiles[THREE.MathUtils.clamp(bz,0,4)*5+THREE.MathUtils.clamp(bx,0,4)],slot=tile.count++;
      if(slot>=tile.instanceMatrix.count)throw new Error('Groot meadow tile capacity exceeded');
      const target=tile.instanceMatrix.array;for(let k=0;k<16;k++)target[slot*16+k]=matrices[at+k];
      for(let k=0;k<3;k++)tile.instanceColor!.array[slot*3+k]=colours[i*3+k];
    }
    for(const tile of this.grassTiles){
      tile.visible=tile.count>0;tile.instanceMatrix.needsUpdate=true;tile.instanceColor!.needsUpdate=true;
      // Includes all source geometry and GPU brush/wind displacement, with no per-refresh allocation.
      const a=tile.instanceMatrix.array,centre=tile.boundingSphere!.center;let radius=4.9;
      for(let i=0;i<tile.count;i++)radius=Math.max(radius,Math.hypot(a[i*16+12]-centre.x,a[i*16+13]-centre.y,a[i*16+14]-centre.z)+.7);
      tile.boundingSphere!.radius=radius;
    }
  }
  update(dt:number,origin:THREE.Vector3):void{
    this.group.visible=true;this.ground.visible=true;this.wind.value+=dt;
    for(let i=0;i<16;i++)this.grassAges[i]+=dt;for(let i=0;i<8;i++)if(this.treeAges[i]>=0)this.treeAges[i]+=dt;
    const x=origin.x/this.height,z=origin.z/this.height,dx=x-this.previousPlayer.x,dz=z-this.previousPlayer.y,distance=Math.hypot(dx,dz);
    if(this.playerReady&&distance>.035&&distance<1.5){const i=this.brushCursor++%16;this.grassBrushes[i].set(x,z,dx/distance,dz/distance);this.grassAges[i]=0;this.previousPlayer.set(x,z);}
    if(!this.playerReady||distance>=1.5){this.previousPlayer.set(x,z);this.playerReady=true;}
    // These envelopes are uniform across every vertex: evaluate 24 times, not millions.
    for(let i=0;i<16;i++)this.grassWeights[i]=Math.exp(-this.grassAges[i]*2.3);
    for(let i=0;i<8;i++){const age=Math.max(0,this.treeAges[i]);this.treeResponses[i]=Math.sin(age*13)*Math.exp(-age*2.5)*this.treeHits[i].w;}
    this.refresh(x,z);for(const mesh of this.meshes)mesh.visible=mesh.count>0;
    for(const tile of this.grassTiles)tile.visible=tile.count>0;
  }
  strike(kind:string,origin:THREE.Vector3,facing:THREE.Vector3,clipTime=0,groundRadiusH=1.65):number{
    this.lastHitCount=0;
    if(!TREE_ATTACKS.has(kind))return 0;
    const h=this.height,heavy=kind==='ground'||kind==='seismic'||kind==='roar';
    for(let i=0;i<this.colliderCount+this.oldColliders.length;i++){
      const tree=i<this.colliderCount?this.colliders[i]:this.oldColliders[i-this.colliderCount],dx=(tree.x-origin.x)/h,dz=(tree.z-origin.z)/h;
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
