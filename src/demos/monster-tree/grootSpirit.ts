import * as THREE from 'three';

/** An invented bioluminescent woodland moth, not a human silhouette with wings. */
export class GrootSpirit {
  readonly root=new THREE.Group();
  readonly wings:THREE.Mesh[]=[];
  readonly glow:THREE.Sprite;
  readonly phase:number;
  private readonly clock={value:0};
  constructor(glowMap:THREE.Texture,index:number,readonly guardian=false){
    this.phase=index*2.399;this.root.name=guardian?'groot-new-elder-spirit':`lantern-spirit-${index}`;this.root.visible=false;
    const texture=wingTexture(guardian);
    const material=new THREE.MeshStandardMaterial({map:texture,color:guardian?'#a7d8cf':'#cabd96',roughness:.58,metalness:.08,side:THREE.DoubleSide,transparent:true,opacity:.82,depthWrite:false,emissive:guardian?'#507d77':'#524827',emissiveIntensity:.22});
    material.onBeforeCompile=shader=>{
      shader.uniforms.spiritTime=this.clock;
      shader.vertexShader='uniform float spiritTime;\n'+shader.vertexShader;
      shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\ntransformed.y += sin(spiritTime*18.0-abs(position.x)*48.0+position.z*22.0)*0.012*pow(abs(position.x)/0.105,1.5);');
    };
    const bodyMat=new THREE.MeshStandardMaterial({color:'#69573d',roughness:.87});
    const bellyMat=new THREE.MeshBasicMaterial({color:guardian?'#a5ede1':'#e2bd6a'});
    const sphere=new THREE.SphereGeometry(1,12,8);
    // Horizontal thorax and segmented, tapering lantern abdomen. No human head, arms or legs.
    const thorax=new THREE.Mesh(sphere,bodyMat);thorax.name='moth-thorax';thorax.scale.set(.010,.008,.014);this.root.add(thorax);
    for(let ring=0;ring<7;ring++){
      const segment=new THREE.Mesh(sphere,ring>2?bellyMat:bodyMat),r=.0085*(1-ring*.105);
      segment.name='moth-abdomen-segment';segment.position.set(0,-.002,-.012-ring*.006);segment.scale.set(r,r*.72,.005);this.root.add(segment);
    }
    const head=new THREE.Mesh(sphere,bodyMat);head.name='moth-head';head.position.z=.017;head.scale.set(.008,.006,.007);this.root.add(head);
    for(const side of [-1,1]){
      const eye=new THREE.Mesh(sphere,new THREE.MeshStandardMaterial({color:'#192322',roughness:.2,metalness:.25}));eye.position.set(side*.006,.002,.019);eye.scale.set(.003,.003,.004);this.root.add(eye);
      const antenna=new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(side*.004,.003,.020),new THREE.Vector3(side*.014,.013,.039),new THREE.Vector3(side*.028,.017,.048)]),12,.0008,4,false),bodyMat);antenna.name='moth-antenna';this.root.add(antenna);
      for(let lobe=0;lobe<2;lobe++){
        const wing=new THREE.Mesh(wingGeometry(side,lobe),material);wing.name='veined-moth-wing';this.root.add(wing);this.wings.push(wing);
      }
      // Small tucked insect tarsi sit beneath the thorax, not dangling humanoid limbs.
      for(let leg=0;leg<3;leg++){
        const z=.011-leg*.008;
        this.root.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(side*.004,-.004,z),new THREE.Vector3(side*.011,-.011,z-.004),new THREE.Vector3(side*.014,-.008,z-.012)]),5,.00055,3,false),bodyMat));
      }
    }
    mergeAnatomy(this.root,this.wings);
    this.glow=new THREE.Sprite(new THREE.SpriteMaterial({map:glowMap,color:guardian?'#9fead9':'#ffdb89',transparent:true,opacity:.40,blending:THREE.AdditiveBlending,depthWrite:false}));
    this.glow.position.set(0,-.002,-.032);this.glow.scale.setScalar(.09);this.root.add(this.glow);
    this.root.scale.setScalar(guardian?2.5:.85);
  }
  update(time:number,strength:number,visibility=1):void{
    this.root.visible=visibility>.001;this.clock.value=time+this.phase;
    this.root.scale.setScalar((this.guardian?2.5:.85)*visibility);
    for(let wing=0;wing<4;wing++){
      const side=wing<2?-1:1,lobe=wing%2;
      this.wings[wing].rotation.z=side*(.18+Math.sin(time*18+this.phase-lobe*.4)*.47);
      this.wings[wing].rotation.x=.08*Math.sin(time*18+this.phase-.8-lobe*.3);
    }
    this.glow.material.opacity=(.32+.07*Math.sin(time*2.3+this.phase)+strength*.18)*visibility;
  }
}

/** Static insect anatomy is one coloured draw, not twenty tiny independent mesh draws. */
function mergeAnatomy(root:THREE.Group,wings:THREE.Mesh[]):void{
  const parts=root.children.filter((o):o is THREE.Mesh<THREE.BufferGeometry,THREE.MeshStandardMaterial>=>o instanceof THREE.Mesh&&!wings.includes(o));
  const count=parts.reduce((n,o)=>n+(o.geometry.index?.count??o.geometry.attributes.position.count),0);
  const positions=new Float32Array(count*3),normals=new Float32Array(count*3),colours=new Float32Array(count*3),p=new THREE.Vector3(),n=new THREE.Vector3(),normalMatrix=new THREE.Matrix3();
  const geometries=new Set<THREE.BufferGeometry>(),materials=new Set<THREE.Material>();let at=0;
  for(const mesh of parts){
    mesh.updateMatrix();normalMatrix.getNormalMatrix(mesh.matrix);const g=mesh.geometry,size=g.index?.count??g.attributes.position.count;
    for(let i=0;i<size;i++){
      const v=g.index?g.index.getX(i):i;p.fromBufferAttribute(g.attributes.position,v).applyMatrix4(mesh.matrix).toArray(positions,at);
      n.fromBufferAttribute(g.attributes.normal,v).applyMatrix3(normalMatrix).normalize().toArray(normals,at);mesh.material.color.toArray(colours,at);at+=3;
    }
    geometries.add(g);materials.add(mesh.material);root.remove(mesh);
  }
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));geometry.setAttribute('normal',new THREE.BufferAttribute(normals,3));geometry.setAttribute('color',new THREE.BufferAttribute(colours,3));
  const body=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({vertexColors:true,roughness:.68,metalness:.06,emissive:'#67532c',emissiveIntensity:.08}));body.name='moth-segmented-anatomy';root.add(body);
  for(const g of geometries)g.dispose();for(const m of materials)m.dispose();
}

function wingGeometry(side:number,lobe:number):THREE.BufferGeometry{
  const p:number[]=[],uv:number[]=[],ix:number[]=[];
  for(let row=0;row<=20;row++)for(let col=0;col<=10;col++){
    const u=row/20,v=col/10,width=Math.sin(Math.PI*u)**.7;
    const x=side*(.004+u*(lobe?.067:.105)),z=(lobe?-.018:.012)+width*(v-.48)*(lobe?.070:.085)-u*(lobe?.055:.012);
    p.push(x,.009*Math.sin(u*Math.PI)-.005*(v-.5)**2,z);uv.push(u,v);
    if(row<20&&col<10){const a=row*11+col;if(side>0)ix.push(a,a+11,a+1,a+1,a+11,a+12);else ix.push(a,a+1,a+11,a+1,a+12,a+11);}
  }
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(p,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.setIndex(ix);g.computeVertexNormals();return g;
}
function wingTexture(guardian:boolean):THREE.CanvasTexture{
  const c=document.createElement('canvas');c.width=c.height=256;const ctx=c.getContext('2d')!;
  const gradient=ctx.createLinearGradient(0,0,256,0);gradient.addColorStop(0,'#574732');gradient.addColorStop(.24,guardian?'#93b9a3':'#cbbd91');gradient.addColorStop(.7,guardian?'#c4e3cc':'#e8d7af');gradient.addColorStop(1,'#6c6750');ctx.fillStyle=gradient;ctx.fillRect(0,0,256,256);
  // Fine longitudinal veins and cross-veins follow the membrane, with subdued eye spots.
  ctx.lineWidth=1.3;ctx.strokeStyle='#514c3d88';
  for(let i=0;i<10;i++){ctx.beginPath();ctx.moveTo(0,128);ctx.bezierCurveTo(70,120,130,i*28,256,i*28);ctx.stroke();}
  ctx.lineWidth=.6;ctx.strokeStyle='#68685455';for(let i=0;i<22;i++){ctx.beginPath();ctx.moveTo(i*12,0);ctx.quadraticCurveTo(i*12+25,128,i*12,256);ctx.stroke();}
  for(const y of [67,188]){ctx.fillStyle='#4b56499a';ctx.beginPath();ctx.ellipse(184,y,18,23,.2,0,Math.PI*2);ctx.fill();ctx.fillStyle=guardian?'#bddcca':'#dfc787';ctx.beginPath();ctx.ellipse(184,y,9,14,.2,0,Math.PI*2);ctx.fill();}
  for(let y=0;y<256;y+=3)for(let x=0;x<256;x+=3){const n=Math.sin(x*127.1+y*311.7)*43758.5453;ctx.fillStyle=`rgba(54,48,34,${(n-Math.floor(n))*.12})`;ctx.fillRect(x,y,1,2);}
  const texture=new THREE.CanvasTexture(c);texture.colorSpace=THREE.SRGBColorSpace;return texture;
}
