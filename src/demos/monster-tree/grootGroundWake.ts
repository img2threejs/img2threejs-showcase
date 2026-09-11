import * as THREE from 'three';
import { forestGround, grassGeometry } from './grootTerrain';

const CAPACITY=48, TUFTS=10;
/** Measured gait contacts leave shallow earth impressions and a short-lived fringe of new grass. */
export class GrootGroundWake {
  readonly group=new THREE.Group();
  readonly footprints:THREE.InstancedMesh;
  readonly sprouts:THREE.InstancedMesh;
  readonly ages=new Float32Array(CAPACITY).fill(99);
  private readonly locations=new Float32Array(CAPACITY*3);
  private readonly headings=new Float32Array(CAPACITY);
  private readonly dummy=new THREE.Object3D();
  private cursor=0;
  steps=0;
  constructor(readonly height:number){
    this.group.name='groot-living-footsteps';this.group.visible=false;
    const geometry=new THREE.PlaneGeometry(1,1,4,4);geometry.rotateX(-Math.PI/2);
    const material=new THREE.ShaderMaterial({transparent:true,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-1,
      uniforms:{ages:{value:this.ages}},
      vertexShader:'attribute float slot;varying vec2 vUv;varying float vAge;uniform float ages[48];void main(){vUv=uv;vAge=ages[int(slot)];gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.);}',
      fragmentShader:`varying vec2 vUv;varying float vAge;void main(){
        vec2 p=(vUv-.5)*2.;float distance=length((p+vec2(.14,0.))*vec2(1.05,1.55));
        for(int toe=0;toe<3;toe++){vec2 q=p-vec2(.48,float(toe-1)*.37);distance=min(distance,length(q*vec2(2.8,4.8)));}
        float sole=1.-smoothstep(.65,1.,distance),rim=smoothstep(.62,.81,distance)*(1.-smoothstep(.81,1.,distance));
        float grooves=.78+.22*sin(p.y*24.+sin(p.x*11.));float fade=smoothstep(0.,.15,vAge)*(1.-smoothstep(6.,12.,vAge));
        gl_FragColor=vec4(mix(vec3(.045,.032,.018),vec3(.20,.15,.085),rim*.6),sole*grooves*fade*.43);
      }`});
    geometry.setAttribute('slot',new THREE.InstancedBufferAttribute(Float32Array.from({length:CAPACITY},(_,i)=>i),1));
    this.footprints=new THREE.InstancedMesh(geometry,material,CAPACITY);this.footprints.name='subtle-earth-footprints';this.footprints.renderOrder=1;
    this.sprouts=new THREE.InstancedMesh(grassGeometry(),new THREE.MeshStandardMaterial({color:'#607e43',roughness:.93,side:THREE.DoubleSide}),CAPACITY*TUFTS);
    this.sprouts.name='footstep-grass-regrowth';this.sprouts.receiveShadow=true;
    for(const mesh of [this.footprints,this.sprouts]){mesh.count=0;mesh.visible=false;mesh.frustumCulled=false;this.group.add(mesh);}
  }
  step(foot:THREE.Vector3,facing:THREE.Vector3):void{
    const at=this.cursor++%CAPACITY;this.ages[at]=0;foot.toArray(this.locations,at*3);this.headings[at]=Math.atan2(-facing.z,facing.x);this.steps++;
  }
  update(dt:number):void{
    this.footprints.count=0;this.sprouts.count=0;
    for(let i=0;i<CAPACITY;i++){
      this.ages[i]+=dt;if(this.ages[i]>=12)continue;
      const at=i*3,x=this.locations[at],z=this.locations[at+2],yaw=this.headings[i],h=this.height;
      const dx=(forestGround(x+.02,z,h)-forestGround(x-.02,z,h))/.04,dz=(forestGround(x,z+.02,h)-forestGround(x,z-.02,h))/.04;
      this.dummy.position.set(x,forestGround(x,z,h)+.003*h,z);this.dummy.rotation.set(Math.atan(dz),yaw,-Math.atan(dx));this.dummy.scale.set(.23*h,1,.12*h);this.dummy.updateMatrix();
      // Preserve the slot index, including expired entries, for the fixed shader age table.
      this.footprints.setMatrixAt(i,this.dummy.matrix);this.footprints.count=Math.max(this.footprints.count,i+1);
      const growth=THREE.MathUtils.smoothstep(this.ages[i],.1,.9)*(1-THREE.MathUtils.smoothstep(this.ages[i],5,9));
      if(growth<.002)continue;
      for(let j=0;j<TUFTS;j++){
        const angle=j*2.399+i*.7,r=h*(.12+.045*Math.sin(j*9+i)**2),px=x+Math.cos(angle)*r,pz=z+Math.sin(angle)*r;
        this.dummy.position.set(px,forestGround(px,pz,h)-.003*h,pz);this.dummy.rotation.set(0,angle,0);this.dummy.scale.setScalar(h*(.10+.045*Math.sin(i+j*3)**2)*growth);this.dummy.updateMatrix();this.sprouts.setMatrixAt(this.sprouts.count++,this.dummy.matrix);
      }
    }
    this.group.visible=this.footprints.count>0||this.sprouts.count>0;
    this.footprints.visible=this.footprints.count>0;this.sprouts.visible=this.sprouts.count>0;
    this.footprints.instanceMatrix.needsUpdate=true;this.sprouts.instanceMatrix.needsUpdate=true;
  }
}
