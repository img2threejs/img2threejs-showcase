import * as THREE from 'three';
import { GrootSpirit } from './grootSpirit';

export class GrootAtmosphere {
  readonly group=new THREE.Group();
  readonly lanterns: THREE.PointLight[]=[];
  readonly spirits:GrootSpirit[]=[];
  readonly shafts: THREE.Mesh[]=[];
  remaining=0;
  daylight=0;
  private readonly openings:THREE.SpotLight[]=[];
  private strength=0;
  private time=0;
  private readonly clock={value:0};
  private readonly points=new Float32Array(8*28*3);
  readonly trails:THREE.Points;
  private readonly p=new THREE.Vector3();
  constructor(readonly height:number,glowMap:THREE.Texture){
    this.group.name='groot-night-atmosphere';this.group.visible=false;
    const shaftMaterial=new THREE.ShaderMaterial({transparent:true,depthWrite:false,side:THREE.DoubleSide,blending:THREE.AdditiveBlending,
      uniforms:{time:this.clock},vertexShader:'varying vec2 vUv; varying vec3 vN; varying vec3 vV;void main(){vUv=uv;vec4 p=modelViewMatrix*vec4(position,1.);vN=normalMatrix*normal;vV=-p.xyz;gl_Position=projectionMatrix*p;}',
      fragmentShader:'uniform float time;varying vec2 vUv;varying vec3 vN;varying vec3 vV;void main(){float face=pow(abs(dot(normalize(vN),normalize(vV))),1.6);float fade=smoothstep(0.,.13,vUv.y)*(1.-smoothstep(.75,1.,vUv.y));float dust=.78+.16*sin(vUv.y*74.+sin(vUv.x*41.)-time*.35);gl_FragColor=vec4(.49,.68,.85,face*fade*dust*.085);}' });
    const cone=new THREE.CylinderGeometry(.045,.42,4.2,36,12,true),up=new THREE.Vector3(0,1,0);
    const top=new THREE.Vector3(),base=new THREE.Vector3(),axis=new THREE.Vector3();
    for(const [x,z,width] of [[-.5,-.65,1],[1.7,.2,.85],[-1.8,1.3,1.2],[.4,-2.2,.65]]){
      base.set(x,0,z);top.set(x+1.25,4.2,z-.65);axis.copy(top).sub(base);
      const beam=new THREE.Mesh(cone,shaftMaterial);beam.name='moonshaft';beam.position.copy(base).add(top).multiplyScalar(.5);beam.quaternion.setFromUnitVectors(up,axis.clone().normalize());beam.scale.set(width,axis.length()/4.2,width);beam.visible=false;this.shafts.push(beam);this.group.add(beam);
      const light=new THREE.SpotLight('#c9dfff',height*height*75,height*7,Math.atan(.46*width/axis.length()),.9,2);
      light.name='moonlight-opening';light.position.copy(top);light.target.position.copy(base);light.castShadow=true;light.shadow.mapSize.set(512,512);light.shadow.bias=-.0004;light.shadow.normalBias=.025;
      this.group.add(light,light.target);
      this.openings.push(light);
    }
    for(let i=0;i<8;i++){
      const spirit=new GrootSpirit(glowMap,i),root=spirit.root;
      this.group.add(root);this.spirits.push(spirit);
      if(i<3){const light=new THREE.PointLight(i===0?'#ffdfaa':'#bfecff',height*height*.2,height*2.1,2);light.position.y=.12;light.name=`spirit-lantern-light-${i}`;root.add(light);this.lanterns.push(light);}
    }
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(this.points,3));
    this.trails=new THREE.Points(g,new THREE.PointsMaterial({map:glowMap,color:'#c0e3e5',size:.008,transparent:true,opacity:.28,depthWrite:false,blending:THREE.AdditiveBlending}));this.trails.frustumCulled=false;this.group.add(this.trails);
    this.group.traverse(o=>{o.userData.isHighlight=true;});
  }
  summon(seconds=18):void {this.remaining=seconds;}
  update(dt:number,origin:THREE.Vector3,facing:THREE.Vector3,hand?:THREE.Vector3,greet=0):void{
    this.group.visible=true;this.time+=dt;this.clock.value=this.time;this.remaining=Math.max(0,this.remaining-dt);
    this.strength+=(Number(this.remaining>0)-this.strength)*(1-Math.exp(-dt*(this.remaining>0?2.7:.8)));
    for(const shaft of this.shafts)shaft.visible=true;
    for(const light of this.openings)light.intensity=this.height*this.height*(75+this.daylight*25);
    const ox=origin.x/this.height,oz=origin.z/this.height;
    for(let i=0;i<8;i++){
      const spirit=this.spirits[i],t=this.time*.24+spirit.phase,blend=this.strength;
      for(let j=0;j<28;j++){
        const u=t-j*.012,r=.70+i*.08;
        const ambientX=ox+Math.cos(u)*r,ambientZ=oz+Math.sin(u)*r;
        const lanternX=ox+(i===0?facing.x*.52:0)+Math.cos(u)*(i===0?.13:.53+i*.025),lanternZ=oz+(i===0?facing.z*.52:0)+Math.sin(u)*(i===0?.13:.53+i*.025);
        this.p.set(ambientX+(lanternX-ambientX)*blend,origin.y/this.height+.40+(i%4)*.14+Math.sin(u*1.8)*.07,ambientZ+(lanternZ-ambientZ)*blend);
        if(i===0&&hand){this.p.x+=(hand.x/this.height-this.p.x)*greet;this.p.y+=(hand.y/this.height+.20-this.p.y)*greet;this.p.z+=(hand.z/this.height-this.p.z)*greet;}
        this.p.toArray(this.points,(i*28+j)*3);if(j===0)spirit.root.position.copy(this.p);
      }
      spirit.root.rotation.y=-t+.2*Math.sin(this.time*1.7+i);spirit.root.rotation.z=.18*Math.sin(this.time*1.9+i);spirit.root.rotation.x=.20+.15*Math.sin(this.time*1.1+i);
      spirit.update(this.time,blend);
      if(i<3)this.lanterns[i].intensity=this.height*this.height*(.22+blend*(i===0?1.4:.9));
    }
    this.trails.geometry.getAttribute('position').needsUpdate=true;
  }
}
