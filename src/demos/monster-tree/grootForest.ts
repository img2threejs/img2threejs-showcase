import * as THREE from 'three';
import { GrootAtmosphere } from './grootAtmosphere';
import { GrootTerrain, forestHeightH } from './grootTerrain';
import { batchGrootForest, ownGrootGrove } from './grootForestBatch';

/** Seeded construction: revisiting a clip does not regenerate its surroundings. */
export function forestRandom(seed = 8731): () => number {
  let state = seed;
  return () => { state = Math.imul(state ^ state >>> 15, 1 | state); state ^= state + Math.imul(state ^ state >>> 7, 61 | state); return ((state ^ state >>> 14) >>> 0) / 4294967296; };
}

export function leafGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const vertices:number[]=[],uv:number[]=[],indices:number[]=[];
  for(let row=0;row<=12;row++){
    const t=row/12,width=Math.sin(t*Math.PI)*.30;
    for(let col=0;col<3;col++){vertices.push((col-1)*width,t,Math.sin(t*Math.PI)*.12-(col===1?0:.035));uv.push(col/2,t);}
    if(row<12)for(let col=0;col<2;col++){const a=row*3+col;indices.push(a,a+3,a+1,a+1,a+3,a+4);}
  }
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));
  geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
  geometry.setIndex(indices);geometry.computeVertexNormals();
  return geometry;
}

export function woodlandTexture(kind: 'bark'|'soil'|'leaf'): THREE.CanvasTexture {
  const canvas=document.createElement('canvas');canvas.width=canvas.height=256;
  const ctx=canvas.getContext('2d')!,data=ctx.createImageData(256,256),r=forestRandom(813);
  for(let y=0;y<256;y++)for(let x=0;x<256;x++){
    const at=(y*256+x)*4;
    const noise=r(),groove=Math.sin(y*.32+Math.sin(x*.03)*1.5)*.5+.5;
    const moss=(Math.sin(x*.063+Math.cos(y*.08)*2)+Math.sin(y*.048))*0.25+.5;
    const value=kind==='bark'?(.24+groove*.13+noise*.15):kind==='soil'?(.20+noise*.18+moss*.18):(.45+Math.sin(x/256*Math.PI)*.28+noise*.04);
    data.data[at]=value*(kind==='soil'?122:kind==='leaf'?170:193);
    data.data[at+1]=value*(kind==='soil'?141:kind==='leaf'?212:173);
    data.data[at+2]=value*(kind==='soil'?99:kind==='leaf'?125:139);data.data[at+3]=255;
  }
  ctx.putImageData(data,0,0);
  if(kind==='leaf'){
    ctx.strokeStyle='rgba(208,222,158,.6)';ctx.lineWidth=1.4;ctx.beginPath();ctx.moveTo(128,0);ctx.lineTo(128,256);ctx.stroke();
    for(let y=30;y<246;y+=25){ctx.beginPath();ctx.moveTo(12,y-25);ctx.quadraticCurveTo(75,y,128,y+24);ctx.quadraticCurveTo(180,y,244,y-25);ctx.stroke();}
  }
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
  texture.wrapS=texture.wrapT=THREE.RepeatWrapping;
  if(kind==='soil')texture.repeat.set(8,8);
  return texture;
}

export function glowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
  const context = canvas.getContext('2d')!;
  const gradient = context.createRadialGradient(32,32,0,32,32,32);
  gradient.addColorStop(0,'rgba(255,255,255,1)'); gradient.addColorStop(.09,'rgba(255,255,255,1)');
  gradient.addColorStop(.24,'rgba(255,255,255,.38)'); gradient.addColorStop(.6,'rgba(255,255,255,.07)'); gradient.addColorStop(1,'rgba(255,255,255,0)');
  context.fillStyle = gradient; context.fillRect(0,0,64,64);
  return new THREE.CanvasTexture(canvas);
}

function bough(points: THREE.Vector3[], radius: number, material: THREE.Material): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3(points);
  const geometry = new THREE.TubeGeometry(curve, 18, radius, 7, false);
  const pos = geometry.getAttribute('position'), p = new THREE.Vector3();
  for (let ring = 0; ring <= 18; ring++) {
    curve.getPointAt(ring / 18, p);
    const taper = 1 - ring / 18 * .91;
    for (let k = 0; k <= 7; k++) {
      const i = ring * 8 + k;
      pos.setXYZ(i, p.x + (pos.getX(i)-p.x)*taper, p.y + (pos.getY(i)-p.y)*taper, p.z+(pos.getZ(i)-p.z)*taper);
    }
  }
  // Bough points are authored in grove coordinates. Plant every root in the shared height field.
  for(let i=0;i<pos.count;i++)pos.setY(i,pos.getY(i)+forestHeightH(pos.getX(i),pos.getZ(i)));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry,material); mesh.castShadow = true; mesh.receiveShadow = true;
  return mesh;
}

/** A real forest clearing, not a backdrop ring. All geometry is outside the figure's framing
 * contract; authored trees, fern fans, moss stones, mushrooms and winged will-o'-wisps. */
export class GrootForest {
  readonly group = new THREE.Group();
  private time = 0;
  private readonly wind = { value: 0 };
  readonly atmosphere:GrootAtmosphere;
  readonly terrain:GrootTerrain;
  readonly colliders:{x:number;z:number;radius:number}[]=[];
  private readonly origin=new THREE.Vector3();
  private readonly facing=new THREE.Vector3(1,0,0);
  constructor(height: number) {
    this.group.name = 'groot-moonlit-forest'; this.group.scale.setScalar(height); this.group.visible = false;
    const random = forestRandom();
    const barkTexture=woodlandTexture('bark');
    const bark = new THREE.MeshStandardMaterial({ color: '#c0b39a', map:barkTexture,bumpMap:barkTexture,bumpScale:.014,roughness: .96 });
    const foliage = new THREE.MeshStandardMaterial({ color: '#d2dfbd',map:woodlandTexture('leaf'),roughness: .86, side: THREE.DoubleSide });
    foliage.onBeforeCompile = shader => {
      shader.uniforms.groveTime = this.wind;
      shader.vertexShader = 'uniform float groveTime;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.z += sin(groveTime*1.1 + instanceMatrix[3].x*2.1 + instanceMatrix[3].z)*0.055*position.y;');
    };
    const leaf = leafGeometry(), dummy = new THREE.Object3D(), color = new THREE.Color();
    this.terrain=new GrootTerrain(height,bark,leaf,foliage);this.group.add(this.terrain.group);
    const canopy = new THREE.InstancedMesh(leaf, foliage, 2400); canopy.castShadow = false;
    let leafAt = 0;
    for (let tree = 0; tree < 12; tree++) {
      const angle = 1.85 + tree / 11 * 3.0, radius = 1.55 + random() * 1.2;
      const x = Math.cos(angle)*radius, z = Math.sin(angle)*radius;
      this.colliders.push({x:x*height,z:z*height,radius:.19*height});
      const tall = 1.9 + random()*1.3, bend = (random()-.5)*.38;
      this.group.add(bough([new THREE.Vector3(x,0,z),new THREE.Vector3(x+bend,.7,z+.05),new THREE.Vector3(x+bend*.5,tall*.75,z-.08),new THREE.Vector3(x+.12,tall,z-.13)],.085+random()*.09,bark));
      for (let branch = 0; branch < 3; branch++) {
        const a = branch*2.1+tree, y = tall*(.56+branch*.12), reach = .45+random()*.4;
        const bx = x+Math.cos(a)*reach, bz = z+Math.sin(a)*reach;
        this.group.add(bough([new THREE.Vector3(x+bend*.5,y,z),new THREE.Vector3((x+bx)/2,y+.15,(z+bz)/2),new THREE.Vector3(bx,y+.4,bz)],.035,bark));
        for (let j=0;j<60;j++) {
          dummy.position.set(bx+(random()-.5)*.75,y+.36+random()*.36,bz+(random()-.5)*.75);
          dummy.rotation.set(-.7+random()*1.4,random()*6.28,random()*6.28); dummy.scale.setScalar(.13+random()*.19); dummy.updateMatrix();
          canopy.setMatrixAt(leafAt,dummy.matrix); canopy.setColorAt(leafAt++,color.setHSL(.22+random()*.06,.23+random()*.25,.10+random()*.13));
        }
      }
      for (let root=0;root<4;root++) {
        const a = root*1.57+tree;
        this.group.add(bough([new THREE.Vector3(x,.25,z),new THREE.Vector3(x+Math.cos(a)*.18,.04,z+Math.sin(a)*.18),new THREE.Vector3(x+Math.cos(a)*.48,-.02,z+Math.sin(a)*.48)],.055,bark));
      }
    }
    canopy.count = leafAt; this.group.add(canopy);
    // Receding silhouettes break up the flat background and give the clearing depth.
    const distantBark=new THREE.MeshStandardMaterial({color:'#9da48d',map:barkTexture,bumpMap:barkTexture,bumpScale:.014,roughness:1});
    this.terrain.installTreeReaction(distantBark);
    for(let i=0;i<26;i++){
      const a=1.8+i/25*3.4,r=3+random()*2.1,x=Math.cos(a)*r,z=Math.sin(a)*r,tall=2.8+random()*2;
      this.colliders.push({x:x*height,z:z*height,radius:.18*height});
      this.group.add(bough([new THREE.Vector3(x,-.05,z),new THREE.Vector3(x+.15,tall*.5,z),new THREE.Vector3(x-.12,tall,z+.1)],.08+random()*.10,distantBark));
    }
    const ferns = new THREE.InstancedMesh(leaf,foliage,10000); let fernAt = 0;
    for(let tuft=0;tuft<90;tuft++) {
      const a = random()*Math.PI*2, r = .65 + random()*2.2;
      const x = Math.cos(a)*r,z = Math.sin(a)*r;
      // The forward clearing stays open for hands, roots and their consequences.
      if(x>0&&Math.abs(z)<.7) continue;
      for(let frond=0;frond<5;frond++) for(let blade=0;blade<16;blade++) {
        const angle = frond*1.256+tuft,along = Math.floor(blade/2)/8,sign=blade%2===0?-1:1,length=.065*(1-along*.65);
        const px=x+Math.cos(angle)*along*.22,pz=z+Math.sin(angle)*along*.22;
        dummy.position.set(px,forestHeightH(px,pz)+.016+Math.sin(along*2.3)*.14,pz);
        dummy.rotation.set(Math.cos(angle)*1.1,angle+sign*.75,Math.sin(angle)*1.1); dummy.scale.set(length*.7,length,length*.7);dummy.updateMatrix();
        ferns.setMatrixAt(fernAt,dummy.matrix);ferns.setColorAt(fernAt++,color.setHSL(.23+random()*.09,.38,.13+random()*.14));
      }
    }
    ferns.count=fernAt; this.group.add(ferns);
    const groundGeometry = new THREE.CircleGeometry(8,96); groundGeometry.rotateX(-Math.PI/2);
    const gp=groundGeometry.getAttribute('position'), colours=new Float32Array(gp.count*3);
    for(let i=0;i<gp.count;i++) { color.setHSL(.22,.18,.08+random()*.055);color.toArray(colours,i*3); }
    groundGeometry.setAttribute('color',new THREE.BufferAttribute(colours,3));
    const soil=woodlandTexture('soil');
    groundGeometry.dispose(); // Ground is now the shared, sampled open-world terrain.
    const stones=new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1,2),new THREE.MeshStandardMaterial({color:'#626952',map:soil,roughness:1}),55);
    for(let i=0;i<55;i++){ const a=random()*6.28,r=.7+random()*2.1,x=Math.cos(a)*r,z=Math.sin(a)*r;dummy.position.set(x,forestHeightH(x,z)+.015,z);dummy.rotation.set(random(),random()*6,random());dummy.scale.set(.05+random()*.14,.025+random()*.08,.04+random()*.13);dummy.updateMatrix();stones.setMatrixAt(i,dummy.matrix);stones.setColorAt(i,color.setHSL(.22,.14,.47+random()*.18)); }
    stones.receiveShadow=true;this.group.add(stones);
    const cap = new THREE.SphereGeometry(1,12,6,0,Math.PI*2,0,Math.PI/2),stem = new THREE.CylinderGeometry(.005,.008,.045,6);
    const capMat = new THREE.MeshStandardMaterial({color:'#8fd8cf',emissive:'#38746c',emissiveIntensity:.38,roughness:.64,side:THREE.DoubleSide});
    for(let i=0;i<20;i++){
      const a=random()*6.28,r=.78+random()*1.5,x=Math.cos(a)*r,z=Math.sin(a)*r;
      const stalk=new THREE.Mesh(stem,bark);stalk.position.set(x,.018,z);this.group.add(stalk);
      const mushroom=new THREE.Mesh(cap,capMat);mushroom.position.set(x,.039,z);mushroom.scale.set(.027,.012,.027);this.group.add(mushroom);
    }
    // The authored RNG is interleaved with geometry: only now are all 38 trunks known.
    this.terrain.world.registerGrove(this.colliders);
    batchGrootForest(this.group);
    ownGrootGrove(this.group,this.terrain.chunks.authored,material=>this.terrain.stream.fade(material));
    this.atmosphere=new GrootAtmosphere(height,glowTexture());this.group.add(this.atmosphere.group);
    // Keep dynamic spirits and the stable lighting rig untouched, but the four fixed
    // origin moonshafts must have the same slot ownership as the authored grove.
    ownGrootGrove(this.atmosphere.group,this.terrain.chunks.authored,material=>this.terrain.stream.fade(material));
    this.group.traverse(object=>{object.userData.isHighlight=true;});
  }
  summon(seconds=18):void {this.atmosphere.summon(seconds);}
  update(dt: number, greetingHand?: THREE.Vector3, greetingWeight=1,origin=this.origin,facing=this.facing): void {
    this.group.visible=true;this.time+=dt;this.wind.value=this.time;
    this.terrain.update(dt,origin);
    this.atmosphere.update(dt,origin,facing,greetingHand,greetingWeight);
  }
}
