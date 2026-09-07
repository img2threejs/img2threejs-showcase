import * as THREE from 'three';
import { type DecodedPart } from './meshCodec';
import type { MonsterTreeRig } from './rig';
import type { GrootSourceProfile, SourceJoint } from './grootSourceProfile';
import { directionalSurfaceSupportSamples } from './grootSurfaceSupport';
import { loadGrootMedium, type GrootSourceQuality } from './grootSourceLod';
type SourceSurface={mesh:THREE.SkinnedMesh;support:Uint32Array;recoverySupport:Uint32Array};

/** Source geometry is unchanged; only skin attributes and a separate calibrated skeleton are added. */
export class GrootSourceForm{
 readonly group=new THREE.Group();readonly skeleton:THREE.Skeleton;
 readonly progress={value:0};readonly ready:Promise<void>;
 mesh:THREE.SkinnedMesh|null=null;error:string|null=null;
 private disposed=false;private loaded=false;
 quality:GrootSourceQuality='high';requestedQuality:GrootSourceQuality='high';qualityError:string|null=null;
 qualityReady:Promise<void>=Promise.resolve();
 private qualityLoading=false;
 private readonly surfaces:Partial<Record<GrootSourceQuality,SourceSurface>>={};
 private readonly joints:SourceJoint[];
 private readonly bones:THREE.Bone[];
 private readonly rest:THREE.Vector3[];
 readonly revealDirection={value:1};
 private readonly oldRest:THREE.Matrix4[]=[];
 private readonly corrections:THREE.Quaternion[]=[];
 private readonly correction=new THREE.Quaternion();
 /** Extra curved-foot support only for the new captured cancellation path. */
 recovering=false;
 private readonly delta:THREE.Quaternion[];
 private readonly positions:THREE.Vector3[];
 private readonly invGroup=new THREE.Matrix4();private readonly matrix=new THREE.Matrix4();
 private readonly q=new THREE.Quaternion();private readonly p=new THREE.Vector3();private readonly s=new THREE.Vector3();
 private readonly materials:THREE.Material[]=[];
 private support:Uint32Array=new Uint32Array();
 private recoverySupport:Uint32Array=new Uint32Array();
 private readonly motes:THREE.Points;
 private readonly motePositions=new Float32Array(80*3);
 private clock=0;
 // Exact-input cache, not a pose epsilon: fixed-step event/socket sampling stays live.
 private readonly poseInputs:Float64Array;
 private poseValid=false;
 private poseCursor=0;
 private poseChanged=false;
 private recordPose(value:number):void{if(this.poseInputs[this.poseCursor]!==value)this.poseChanged=true;this.poseInputs[this.poseCursor++]=value;}
 constructor(private readonly rig:MonsterTreeRig,readonly height:number,private readonly profile:GrootSourceProfile){
  this.joints=profile.joints;
  this.delta=this.joints.map(()=>new THREE.Quaternion());
  this.positions=this.joints.map(()=>new THREE.Vector3());
  this.poseInputs=new Float64Array(this.joints.length*20+18);
  this.bones=this.joints.map(j=>{const b=new THREE.Bone();b.name=`${profile.id}:${j[0]}`;return b;});
  this.rest=this.joints.map(j=>new THREE.Vector3(...j[2]));
  this.group.name=`groot-${profile.id}-source`;rig.group.add(this.group);this.group.visible=false;
  const normalise=rig.group.getObjectByName('monster-tree-skin-root')!.matrix;
  for(let i=0;i<this.joints.length;i++){
   const j=this.joints[i],b=this.bones[i];b.position.copy(this.rest[i]);if(j[1]>=0){b.position.sub(this.rest[j[1]]);this.bones[j[1]].add(b);}else this.group.add(b);
   const sourceIndex=rig.skeleton.bones.indexOf(rig.bones[j[0]]);
   this.oldRest.push(normalise.clone().multiply(rig.skeleton.boneInverses[sourceIndex].clone().invert()));
  }
  const reference=profile.reference(rig);
  for(const [name] of this.joints){
   reference.get(rig.bones[name])!.decompose(this.p,this.q,this.s);
   this.corrections.push(this.q.clone().normalize().invert());
  }
  this.group.updateMatrixWorld(true);this.skeleton=new THREE.Skeleton(this.bones,this.rest.map(p=>new THREE.Matrix4().makeTranslation(-p.x,-p.y,-p.z)));
  const mg=new THREE.BufferGeometry();mg.setAttribute('position',new THREE.BufferAttribute(this.motePositions,3));
  this.motes=new THREE.Points(mg,new THREE.PointsMaterial({color:'#8af7f1',size:.012,transparent:true,opacity:.8,blending:THREE.AdditiveBlending,depthWrite:false}));this.motes.name='abies-transform-embers';this.motes.frustumCulled=false;this.group.add(this.motes);
  this.ready=profile.load().then(parts=>{if(this.disposed)return;const surface=this.surfaces.high=this.build(parts);this.mesh=surface.mesh;this.support=surface.support;this.recoverySupport=surface.recoverySupport;this.group.add(this.mesh);this.loaded=true;this.sync();}).catch(error=>{this.error=String(error);});
 }
 get isReady():boolean{return this.loaded;}
 requestQuality(quality:GrootSourceQuality):void{
  if(this.disposed)return;this.requestedQuality=quality;
  if(quality==='high'||this.surfaces.medium||this.qualityLoading)return;
  this.qualityLoading=true;this.qualityError=null;
  this.qualityReady=loadGrootMedium(this.profile.id).then(parts=>{
   if(!this.disposed)this.surfaces.medium=this.build(parts);
  }).catch(error=>{if(!this.disposed)this.qualityError=String(error);}).finally(()=>{this.qualityLoading=false;});
 }
 /** Skin owns the safe boundary: never replace topology mid-reveal or mid-cast. */
 applyQuality():void{
  if(this.disposed||!this.loaded||this.quality===this.requestedQuality)return;
  const surface=this.surfaces[this.requestedQuality];if(!surface)return;
  this.mesh?.removeFromParent();this.mesh=surface.mesh;this.support=surface.support;this.recoverySupport=surface.recoverySupport;this.group.add(this.mesh);
  this.quality=this.requestedQuality;this.poseValid=false;
 }
 private build(parts:DecodedPart[]):SourceSurface{
  const n=parts.reduce((v,p)=>v+p.position.length/3,0),t=parts.reduce((v,p)=>v+p.index.length,0);
  const position=new Float32Array(n*3),normal=new Float32Array(n*3),color=new Float32Array(n*3),index=new Uint32Array(t),si=new Uint16Array(n*4),sw=new Float32Array(n*4);
  const geometry=new THREE.BufferGeometry(),materials:THREE.MeshStandardMaterial[]=[];let vertex=0,face=0;
  const materialIds=new Map<string,number>();
  for(const part of parts){
   position.set(part.position,vertex*3);normal.set(part.normal,vertex*3);color.set(part.colour,vertex*3);for(let i=0;i<part.index.length;i++)index[face+i]=part.index[i]+vertex;
   const m=part.meta.material,key=JSON.stringify(m);let id=materialIds.get(key);
   if(id===undefined){id=materials.length;materialIds.set(key,id);const material=new THREE.MeshStandardMaterial({vertexColors:true,roughness:m.roughness,metalness:m.metalness,emissive:m.emissive,side:m.doubleSided?THREE.DoubleSide:THREE.FrontSide,opacity:m.opacity,transparent:m.alphaMode==='BLEND',alphaTest:m.alphaMode==='MASK'?m.alphaCutoff:0});material.name=`abies-source-material-${id}`;this.patch(material,1);materials.push(material);this.materials.push(material);}
   // Only adjacent identical material IDs: preserve every index, triangle order and scalar.
   const previous=geometry.groups[geometry.groups.length-1];
   if(previous&&previous.materialIndex===id)previous.count+=part.index.length;
   else geometry.addGroup(face,part.index.length,id);
   vertex+=part.position.length/3;face+=part.index.length;
  }
  this.profile.weights(position,index,si,sw);
  geometry.setAttribute('position',new THREE.BufferAttribute(position,3));geometry.setAttribute('normal',new THREE.BufferAttribute(normal,3));geometry.setAttribute('color',new THREE.BufferAttribute(color,3));geometry.setAttribute('skinIndex',new THREE.BufferAttribute(si,4));geometry.setAttribute('skinWeight',new THREE.BufferAttribute(sw,4));geometry.setIndex(new THREE.BufferAttribute(index,1));geometry.computeBoundingSphere();
  const mesh=new THREE.SkinnedMesh(geometry,materials);mesh.name=`groot-${this.profile.id}-weighted-source`;mesh.bind(this.skeleton,new THREE.Matrix4());mesh.frustumCulled=false;mesh.castShadow=true;mesh.receiveShadow=true;
  // Fixed directional support samples keep claws/feet above the actor's terrain plane
  // in standing and inverted motions without per-frame scans of the full 162k source.
  const samples=new Set(directionalSurfaceSupportSamples(position,si,this.joints.length));
  const support=new Uint32Array(samples);
  // Keep Ice's reviewed ordinary gait support bit-identical. Its curved foot can
  // reach between extrema on the NEW captured fall recovery; augment that path only.
  for(let v=0;v<n;v+=4)if(position[v*3+1]<.15)samples.add(v);
  const recoverySupport=new Uint32Array(samples);
  const depth=new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking}),distance=new THREE.MeshDistanceMaterial();this.patch(depth,1);this.patch(distance,1);mesh.customDepthMaterial=depth;mesh.customDistanceMaterial=distance;this.materials.push(depth,distance);
  return{mesh,support,recoverySupport};
 }
 /** Opaque spatial reveal, shared by colour and shadow passes. Not ghost-opacity overlap. */
 patch(material:THREE.Material,direction:0|1):void{
  const prior=material.onBeforeCompile,key=material.customProgramCacheKey();
  material.onBeforeCompile=(shader,renderer)=>{
   prior.call(material,shader,renderer);shader.uniforms.abiesProgress=this.progress;shader.uniforms.sourceDirection=this.revealDirection;
   shader.vertexShader='varying vec3 abiesRest;\n'+shader.vertexShader;shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>\nabiesRest=position;`);
   shader.fragmentShader='varying vec3 abiesRest;uniform float abiesProgress;uniform float sourceDirection;\n'+shader.fragmentShader;
   shader.fragmentShader=shader.fragmentShader.replace('#include <clipping_planes_fragment>',`#include <clipping_planes_fragment>
    float abiesHeight=abiesRest.y/${direction===1?'1.0':'.955'};
    float abiesNoise=sin(abiesRest.x*79.+sin(abiesRest.z*53.)*2.)*sin(abiesRest.y*91.+abiesRest.z*37.);
    float abiesCut=abiesHeight+abiesNoise*.035;
    float abiesBand=abiesProgress*1.18-.09;
    ${direction===1?'if(sourceDirection>0.5){if(abiesProgress<=0. || (abiesProgress<1. && abiesCut>abiesBand))discard;}else{if(abiesProgress>=1. || (abiesProgress>0. && abiesCut<abiesBand))discard;}':'if(abiesProgress>=1. || (abiesProgress>0. && abiesCut<abiesBand))discard;'}
   `);
   if(shader.fragmentShader.includes('#include <opaque_fragment>'))shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>',`float edge=exp(-abs(abiesCut-abiesBand)*100.)*step(.001,abiesProgress)*step(abiesProgress,.999);outgoingLight+=vec3(.08,.95,1.0)*edge*2.0;\n#include <opaque_fragment>`);
  };material.customProgramCacheKey=()=>`${key}-abies-spatial-${direction}-v1`;material.needsUpdate=true;
 }
 setGrowth(value:number):void{this.progress.value=THREE.MathUtils.clamp(value,0,1);this.sync();}
 sync(dt=0,allowCache=false):void{
  if(this.disposed)return;this.clock+=dt;this.group.visible=this.loaded&&(this.revealDirection.value?this.progress.value>0:this.progress.value<1);
  if(!this.group.visible){this.poseValid=false;return;}
  this.rig.group.updateWorldMatrix(true,false);
  this.poseChanged=!allowCache||!this.poseValid;this.poseCursor=0;
  // Reserve the former gait slot so recovery diagnostics keep their cache index.
  this.recordPose(0);this.recordPose(Number(this.recovering));
  for(const value of this.rig.group.matrixWorld.elements)this.recordPose(value);
  for(let i=0;i<this.joints.length;i++){
   const bone=this.rig.bones[this.joints[i][0]];bone.updateWorldMatrix(true,false);
   for(const value of bone.matrixWorld.elements)this.recordPose(value);
   const q=this.corrections[i];this.recordPose(q.x);this.recordPose(q.y);this.recordPose(q.z);this.recordPose(q.w);
  }
  if(this.poseChanged){
  this.invGroup.copy(this.rig.group.matrixWorld).invert();
  for(let i=0;i<this.joints.length;i++){
   const [name,parent]=this.joints[i];this.matrix.multiplyMatrices(this.invGroup,this.rig.bones[name].matrixWorld);this.matrix.decompose(this.p,this.q,this.s);this.correction.copy(this.corrections[i]);this.delta[i].copy(this.q).normalize().multiply(this.correction).normalize();
   if(parent<0){this.positions[i].copy(this.p).divideScalar(this.height).sub(this.s.setFromMatrixPosition(this.oldRest[i]).divideScalar(this.height)).add(this.rest[i]);}
   else this.positions[i].copy(this.rest[i]).sub(this.rest[parent]).applyQuaternion(this.delta[parent]).add(this.positions[parent]);
   const bone=this.bones[i];bone.position.copy(this.positions[i]);bone.quaternion.copy(this.delta[i]);
   if(parent>=0){bone.position.sub(this.positions[parent]).applyQuaternion(this.q.copy(this.delta[parent]).invert());bone.quaternion.premultiply(this.q);}
  }
  this.group.position.y=0;this.group.scale.setScalar(this.height);this.group.updateMatrixWorld(true);this.skeleton.update();
  if(this.mesh&&this.group.visible){let minY=Infinity;for(const id of (this.recovering?this.recoverySupport:this.support)){this.p.fromBufferAttribute(this.mesh.geometry.attributes.position,id);this.mesh.applyBoneTransform(id,this.p);this.p.applyMatrix4(this.mesh.matrixWorld).applyMatrix4(this.invGroup);minY=Math.min(minY,this.p.y);}if(minY<0){this.group.position.y=-minY;this.group.updateMatrixWorld(true);this.skeleton.update();}}
  this.poseValid=true;
  }
  const active=this.progress.value>0&&this.progress.value<1;this.motes.visible=active;
  if(active){const y=this.progress.value*1.18-.09;for(let i=0;i<80;i++){const angle=i*2.39996+this.clock*.6,r=.10+(i%11)*.018;this.motePositions[i*3]=Math.cos(angle)*r;this.motePositions[i*3+1]=y+Math.sin(i*1.731+this.clock*4)*.065;this.motePositions[i*3+2]=Math.sin(angle)*r;}this.motes.geometry.attributes.position.needsUpdate=true;}
 }
 socketWorld(name:string,out:THREE.Vector3):boolean{
  if(!this.loaded)return false;
  const mapped=/^([LR])_Digit/.test(name)?name[0]+'_Hand':name==='Waist'?'Spine01':name==='NeckTwist01'?'Head':name;
  const i=this.joints.findIndex(j=>j[0]===mapped);if(i<0)return false;
  this.bones[i].getWorldPosition(out);
  if(/Digit/.test(name))out.add(this.p.set(0,-.004,name[0]==='R'?.043:-.043).applyQuaternion(this.bones[i].getWorldQuaternion(this.q)).multiplyScalar(this.height));
  return true;
 }
 inspect(){return{quality:this.quality,requestedQuality:this.requestedQuality,qualityLoading:this.qualityLoading,qualityError:this.qualityError,cachedSurfaces:Object.keys(this.surfaces).length,kind:`supplied-${this.profile.id}`,ready:this.loaded,error:this.error,growth:this.progress.value,visible:this.group.visible,vertices:this.mesh?.geometry.attributes.position.count??0,triangles:(this.mesh?.geometry.index?.count??0)/3,sourceParts:this.profile.parts,materials:this.mesh?(this.mesh.material as THREE.Material[]).length:0,bones:this.bones.length,meshes:this.mesh?1:0};}
 dispose():void{if(this.disposed)return;this.disposed=true;this.group.removeFromParent();for(const surface of Object.values(this.surfaces)){surface.mesh.removeFromParent();surface.mesh.geometry.dispose();}delete this.surfaces.high;delete this.surfaces.medium;for(const m of this.materials)m.dispose();this.materials.length=0;this.motes.geometry.dispose();(this.motes.material as THREE.Material).dispose();this.skeleton.dispose();}
}
