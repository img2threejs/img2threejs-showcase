import * as THREE from 'three';
import type { GrootTerrain } from './grootTerrain';
import { forestHeightH, forestHash as random } from './grootWorld';
import { inRiverH } from './grootRiverPath';
import type { StreamPart } from './grootStreaming';
import { GrootSpatialBatches, type InstanceSpan } from './grootSpatialBatches';
import { GrootGroundBatches } from './grootGroundBatches';

/** All tile samples and edge derivatives use absolute coordinates, never tile-local normals. */
export function groundTile(cx:number,cz:number):THREE.BufferGeometry {
  const geometry=new THREE.PlaneGeometry(3,3,6,6);geometry.rotateX(-Math.PI/2);
  const p=geometry.attributes.position,uv=geometry.attributes.uv,n=geometry.attributes.normal,colours=new Float32Array(p.count*3),normal=new THREE.Vector3();
  for(let i=0;i<p.count;i++){
    const x=cx*3+1.5+p.getX(i),z=cz*3+1.5+p.getZ(i),e=.001;
    p.setXYZ(i,x,forestHeightH(x,z)-.009,z);uv.setXY(i,x*.75,z*.75);
    normal.set(-(forestHeightH(x+e,z)-forestHeightH(x-e,z))/(2*e),1,-(forestHeightH(x,z+e)-forestHeightH(x,z-e))/(2*e)).normalize();n.setXYZ(i,normal.x,normal.y,normal.z);
    const patch=.88+.12*Math.sin(x*.61+Math.sin(z*.47));colours.set([patch,patch*.98,patch*.9],i*3);
  }
  geometry.setAttribute('color',new THREE.BufferAttribute(colours,3));geometry.computeBoundingBox();geometry.computeBoundingSphere();return geometry;
}
export function geometryBytes(g:THREE.BufferGeometry):number {return Object.values(g.attributes).reduce((n,a)=>n+a.array.byteLength,0)+(g.index?.array.byteLength??0);}
export class GrootTerrainChunks {
  private disposed=false;
  readonly batches:GrootSpatialBatches;
  readonly groundBatches:GrootGroundBatches;
  private readonly litterMaterial=new THREE.MeshStandardMaterial({color:'#92744b',roughness:.96,side:THREE.DoubleSide});
  private readonly stoneMaterial=new THREE.MeshStandardMaterial({color:'#6e7565',roughness:.95});
  private readonly stoneGeometry=new THREE.IcosahedronGeometry(1,1);
  /** Finite authored source templates, not resident GPU instances or a logical-cell cache. */
  readonly authored=new Map<string,THREE.Mesh[]>();
  private readonly dummy=new THREE.Object3D();
  private readonly colour=new THREE.Color();
  constructor(private readonly terrain:GrootTerrain,private readonly trunk:THREE.BufferGeometry,private readonly bark:THREE.Material,private readonly leaf:THREE.BufferGeometry,private readonly foliage:THREE.Material,private readonly grass:THREE.BufferGeometry,private readonly grassMaterial:THREE.Material){this.batches=new GrootSpatialBatches(terrain.group);this.groundBatches=new GrootGroundBatches(terrain.group,terrain.ground.material);}
  installFade():void {this.terrain.stream.fade(this.litterMaterial,false,true);this.terrain.stream.fade(this.stoneMaterial,false,true);}
  ground(cx:number,cz:number):StreamPart {
    const group=new THREE.Group(),g=groundTile(cx,cz),batch=this.groundBatches.attach(cx,cz,g);
    group.name=`world-ground-cell:${cx}:${cz}`;
    const river=this.terrain.riverCell?.(cx,cz);
    // River uses world units; its own group lives beside the H-scaled forest.
    return {group,sourceGeometry:g,extraBuffers:[...batch.extraBuffers,...(river?.extraBuffers??[])],bytes:geometryBytes(g)+batch.bytes+(river?.bytes??0),dispose:()=>{batch.dispose();g.dispose();river?.dispose();},setVisible:(visible:boolean,x:number,z:number,r:number)=>{river?.setVisible?.(visible,x,z,r);}};
  }
  setVisible(x:number,z:number,r:number):void {this.batches.setVisible(x,z,r);this.groundBatches.setVisible(x,z,r+3);}
  private put(mesh:THREE.InstancedMesh,x:number,y:number,z:number,sx:number,sy:number,sz:number,yaw:number,tilt=0):void {
    if(mesh.count>=mesh.instanceMatrix.count)throw new Error('Forest per-cell instance capacity exceeded');
    this.dummy.position.set(x,y,z);this.dummy.rotation.set(tilt,yaw,0);this.dummy.scale.set(sx,sy,sz);this.dummy.updateMatrix();mesh.setMatrixAt(mesh.count++,this.dummy.matrix);
  }
  *vegetation(cx:number,cz:number,near:boolean):Generator<void,StreamPart> {
    const group=new THREE.Group(),owned:THREE.InstancedMesh[]=[],spans:InstanceSpan[]=[];
    group.name=`world-vegetation-cell:${cx}:${cz}`;group.visible=false;
    const make=(name:string,g:THREE.BufferGeometry,m:THREE.Material,capacity:number,coloured=false)=>{
      const mesh=new THREE.InstancedMesh(g,m,capacity);mesh.instanceMatrix.array.fill(0);mesh.count=0;mesh.name=name;mesh.receiveShadow=true;
      if(coloured)mesh.setColorAt(0,this.colour);group.add(mesh);owned.push(mesh);return mesh;
    };
    const tree=this.terrain.world.treeCell(cx,cz);
    const trunks=make('world-rooted-tree-trunks',this.trunk,this.bark,1);trunks.castShadow=true;
    const canopy=make('world-layered-canopy',this.leaf,this.foliage,120);
    const grass=make('world-meadow-grass',this.grass,this.grassMaterial,456,true);
    const litter=make('world-fallen-leaves',this.leaf,this.litterMaterial,63);
    const stones=make('world-moss-stones',this.stoneGeometry,this.stoneMaterial,9);
    let committed=false;
    const fillCanopy=(high:boolean)=>{
      canopy.count=0;if(!tree)return;
      for(let j=0;j<(high?120:40);j++){
        const angle=random(cx+j,cz,4)*6.28,r=Math.sqrt(random(cx,cz+j,5))*1.45*tree.size;
        const s=(.12+random(cx-j,cz,7)*.20)*(high?1:1.5);
        this.put(canopy,tree.xH+Math.cos(angle)*r,tree.yH+(2.35+random(cx+j,cz+j,6)*.85)*tree.size,tree.zH+Math.sin(angle)*r,s*.75,s,s,angle,-.65+random(cx,cz+j,8)*1.3);
      }
    };
    const finishMesh=(mesh:THREE.InstancedMesh)=>{
      mesh.visible=mesh.count>0;
      if(!mesh.count)return;
      mesh.instanceMatrix.needsUpdate=true;if(mesh.instanceColor)mesh.instanceColor.needsUpdate=true;
      mesh.computeBoundingBox();mesh.boundingBox!.expandByScalar(.7);mesh.boundingSphere=mesh.boundingBox!.getBoundingSphere(new THREE.Sphere());
    };
    const dispose=()=>{group.removeFromParent();for(const span of spans)this.batches.detach(span);for(const mesh of owned)mesh.dispose();};
    try {
      if(tree){this.put(trunks,tree.xH,tree.yH,tree.zH,tree.size,tree.size,tree.size,tree.yaw);fillCanopy(near);}
      yield;
      for(let dz=0;dz<3;dz++)for(let dx=0;dx<3;dx++){
        const gx=cx*3+dx,gz=cz*3+dz;
        const clearing=THREE.MathUtils.smoothstep(Math.hypot(gx,gz),.7,2.5),density=Math.abs(gz-2*Math.sin(gx*.19))<.65?.12:1;
        for(let j=0;j<Math.ceil(48*clearing*density);j++){
          const px=gx+random(gx+j,gz,17),pz=gz+random(gx,gz+j,18),s=.07+random(gx-j,gz,19)*.16;
          if(inRiverH(px,pz,.15))continue;
          this.put(grass,px,forestHeightH(px,pz),pz,s,s,s,random(gx,gz-j,20)*6.28);
          this.colour.setHSL(.20+random(gx+j,gz,21)*.10,.28,.19+random(gx,gz+j,22)*.13);grass.setColorAt(grass.count-1,this.colour);
        }
        for(let j=0;j<7;j++){
          const px=gx+random(gx+j,gz,23),pz=gz+random(gx,gz+j,24),s=.025+random(gx+j,gz,25)*.035;
          if(inRiverH(px,pz,.12))continue;
          this.put(litter,px,forestHeightH(px,pz)+.004,pz,s,s,s,random(gx,gz+j,26)*6.28,-Math.PI/2+.15);
        }
        if(random(gx,gz,27)>.68){const px=gx+random(gx,gz,28),pz=gz+random(gx,gz,29),s=.025+random(gx,gz,30)*.08;this.put(stones,px,forestHeightH(px,pz),pz,s,s*.5,s*.8,random(gx,gz,31)*6.28);}
        yield;
      }
      if(tree)for(let j=0;j<24;j++){
        // Coordinate-derived identity, independent of transient visible collider order.
        const seed=random(cx,cz,90)*4096,a=j*2.399+seed,r=.20+random(seed,j,91)*.47,px=tree.xH+Math.cos(a)*r,pz=tree.zH+Math.sin(a)*r,s=.10+random(seed,j,92)*.12;
        this.put(grass,px,forestHeightH(px,pz),pz,s,s,s,a);this.colour.setHSL(.24,.30,.26+random(seed,j,93)*.12);grass.setColorAt(grass.count-1,this.colour);
      }
      yield;
      // Authored geometry is spatially owned, not attached permanently at the origin.
      for(const source of this.authored.get(`${cx}:${cz}`)??[]){
        const mesh=source.clone();
        if(mesh instanceof THREE.InstancedMesh)owned.push(mesh); // Three.clone owns copied instance attributes.
        group.add(mesh);
      }
      let bytes=0;for(const mesh of owned){finishMesh(mesh);bytes+=mesh.instanceMatrix.array.byteLength+(mesh.instanceColor?.array.byteLength??0);}
      const sources=[trunks,canopy,grass,litter,stones];
      for(const source of sources){const span=this.batches.attach(cx,cz,source);if(span)spans.push(span);group.remove(source);}
      const extraBuffers=spans.flatMap(s=>[s.mesh.instanceMatrix,...(s.mesh.instanceColor?[s.mesh.instanceColor]:[]),...Object.values(s.mesh.geometry.attributes) as THREE.BufferAttribute[],...(s.mesh.geometry.index?[s.mesh.geometry.index]:[])]);
      if(group.children.length)this.terrain.group.add(group);committed=true;
      return {group,sourceMeshes:sources,extraBuffers,bytes:bytes+sources.reduce((n,m)=>n+m.instanceMatrix.array.byteLength+(m.instanceColor?.array.byteLength??0),0),dispose,promoteNear:()=>{fillCanopy(true);finishMesh(canopy);const span=spans.find(s=>s.source===canopy);return canopy.instanceMatrix.array.byteLength+(span?this.batches.copy(span):0);}};
    } finally {if(!committed)dispose();}
  }
  dispose():void {
    if(this.disposed)return;this.disposed=true;
    this.batches.dispose();this.groundBatches.dispose();
    const geometries=new Set<THREE.BufferGeometry>([this.trunk,this.grass,this.stoneGeometry,this.leaf]);
    const materials=new Set<THREE.Material>([this.bark,this.foliage,this.grassMaterial,this.litterMaterial,this.stoneMaterial]),textures=new Set<THREE.Texture>();
    for(const sources of this.authored.values())for(const source of sources){geometries.add(source.geometry);for(const m of Array.isArray(source.material)?source.material:[source.material])materials.add(m);if(source instanceof THREE.InstancedMesh)source.dispose();}
    for(const g of geometries)g.dispose();for(const m of materials){for(const value of Object.values(m))if(value instanceof THREE.Texture)textures.add(value);m.dispose();}for(const t of textures)t.dispose();this.authored.clear();
  }
}
