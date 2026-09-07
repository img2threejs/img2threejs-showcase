import * as THREE from 'three';

const COUNT=288,SEEDS=128;
const ease=(x:number):number=>{const t=THREE.MathUtils.clamp(x,0,1);return t*t*(3-2*t);};

/** A short theatrical light cue and persistent blue-white fireflies, allocated once. */
export class GrootCompanionReveal {
  readonly group=new THREE.Group();
  readonly spotlight:THREE.SpotLight;
  readonly shaft:THREE.Mesh;
  readonly fireflies:THREE.Points;
  readonly seeds:THREE.InstancedMesh;
  private readonly seedPose=new THREE.Object3D();
  private readonly power={value:0};
  private readonly positions=new Float32Array(COUNT*3);
  private readonly alphas=new Float32Array(COUNT);
  private time=0;
  private chargeAge=0;
  constructor(readonly height:number,seedGeometry:THREE.BufferGeometry,seedMaterial:THREE.Material|THREE.Material[]){
    const h=height;this.group.name='little-groot-summon-stage';this.group.visible=false;
    this.spotlight=new THREE.SpotLight('#d2f5ff',0,h*6,.18,.8,2);this.spotlight.name='little-groot-reveal-spotlight';
    this.spotlight.position.set(.35*h,2.8*h,.2*h);this.spotlight.target.position.set(0,.12*h,0);
    this.spotlight.castShadow=true;this.spotlight.shadow.mapSize.set(512,512);this.spotlight.shadow.camera.near=.1;this.spotlight.shadow.bias=-.0004;this.spotlight.shadow.normalBias=.005;
    this.spotlight.shadow.autoUpdate=false;
    this.spotlight.visible=false;this.group.add(this.spotlight,this.spotlight.target);
    const axis=this.spotlight.position.clone().sub(this.spotlight.target.position),length=axis.length();
    const shaftMaterial=new THREE.ShaderMaterial({transparent:true,depthWrite:false,side:THREE.DoubleSide,blending:THREE.AdditiveBlending,
      uniforms:{uPower:this.power},
      vertexShader:'varying vec2 vUv;varying vec3 vN;varying vec3 vV;void main(){vUv=uv;vec4 p=modelViewMatrix*vec4(position,1.);vN=normalMatrix*normal;vV=-p.xyz;gl_Position=projectionMatrix*p;}',
      fragmentShader:'uniform float uPower;varying vec2 vUv;varying vec3 vN;varying vec3 vV;void main(){float face=pow(abs(dot(normalize(vN),normalize(vV))),1.3);float fade=smoothstep(0.,.14,vUv.y)*(1.-smoothstep(.75,1.,vUv.y));gl_FragColor=vec4(.65,.91,1.,uPower*face*fade*.15);}'
    });
    this.shaft=new THREE.Mesh(new THREE.CylinderGeometry(.025*h,.46*h,length,40,1,true),shaftMaterial);
    this.shaft.name='little-groot-summon-moonbeam';this.shaft.position.copy(this.spotlight.position).add(this.spotlight.target.position).multiplyScalar(.5);this.shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),axis.normalize());this.shaft.visible=false;this.group.add(this.shaft);
    const sizes=new Float32Array(COUNT),colours=new Float32Array(COUNT*3);
    for(let i=0;i<COUNT;i++){sizes[i]=h*(i<32?.025:i<128?.017:.012);colours[i*3]=.70+(i%3)*.10;colours[i*3+1]=.93;colours[i*3+2]=1;}
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(this.positions,3));geometry.setAttribute('aAlpha',new THREE.BufferAttribute(this.alphas,1));geometry.setAttribute('aSize',new THREE.BufferAttribute(sizes,1));geometry.setAttribute('color',new THREE.BufferAttribute(colours,3));
    const material=new THREE.ShaderMaterial({transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,vertexColors:true,
      vertexShader:'attribute float aAlpha;attribute float aSize;varying float vAlpha;varying vec3 vColor;void main(){vAlpha=aAlpha;vColor=color;vec4 p=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*p;gl_PointSize=clamp(aSize*900./max(.1,-p.z),2.,45.);}',
      fragmentShader:'varying float vAlpha;varying vec3 vColor;void main(){float r=length(gl_PointCoord-.5)*2.;if(r>1.)discard;float core=exp(-r*r*45.);float halo=exp(-r*r*5.)*.28;gl_FragColor=vec4(mix(vColor,vec3(1.),core),vAlpha*(core+halo)*smoothstep(1.,.6,r));}'
    });
    this.fireflies=new THREE.Points(geometry,material);this.fireflies.name='little-groot-white-blue-fireflies';this.fireflies.visible=false;this.fireflies.frustumCulled=false;this.group.add(this.fireflies);
    this.seeds=new THREE.InstancedMesh(seedGeometry,seedMaterial,SEEDS);this.seeds.name='little-groot-dense-seed-spiral';this.seeds.count=0;this.seeds.visible=false;this.seeds.frustumCulled=false;this.seeds.receiveShadow=true;this.group.add(this.seeds);
    this.group.traverse(o=>{o.userData.isHighlight=true;});
  }
  start():void {this.chargeAge=0;}
  update(dt:number,enabled:boolean,pending:boolean,age:number,visibility:number,origin:THREE.Vector3,hand:THREE.Vector3):void{
    this.time+=dt;if(pending)this.chargeAge+=dt;
    const glow=pending?ease(this.chargeAge/.45):visibility;
    const visible=(enabled||visibility>0)&&glow>.001;
    this.group.visible=true;this.group.position.copy(origin);
    this.power.value=enabled?(pending?.40*glow:(.9+.65*Math.exp(-age*7))*(1-ease((age-1.15)/1.7))):0;
    this.spotlight.intensity=this.height*this.height*24*this.power.value;this.spotlight.visible=true;this.shaft.visible=this.power.value>.002;
    this.spotlight.shadow.needsUpdate=this.power.value>.002;
    this.fireflies.visible=visible;this.seeds.visible=false;this.seeds.count=0;
    if(!visible)return;
    const h=this.height,scatter=pending?0:ease(age/.3)*(1-ease((age-.35)/.65));
    for(let i=0;i<COUNT;i++){
      const phase=i*2.399,t=this.time*(.45+(i%7)*.09)+phase;
      const r=(pending?.36:i<128?.20:.34)+.075*Math.sin(t*1.7+phase)+scatter*.36;
      let x=Math.cos(t)*r*h,z=Math.sin(t*.91+Math.sin(t*.4)*.25)*r*h;
      let y=(.07+(i%9)*.036+.045*Math.sin(t*1.8))*h;
      // A few motes carry the cast from the measured hand socket to the seedling below.
      if(!pending&&age<.7&&i<16){const u=ease((age-i*.008)/.52);x=x*u+(hand.x-origin.x)*(1-u);y=y*u+(hand.y-origin.y)*(1-u);z=z*u+(hand.z-origin.z)*(1-u);}
      this.positions[i*3]=x;this.positions[i*3+1]=y;this.positions[i*3+2]=z;
      this.alphas[i]=glow*(.45+.55*Math.sin(t*2.3+phase)**2)*(pending||age<1.2?1:i<128?.85:.40);
    }
    // Two counter-rotating seed streams coil inward, blossom outward at birth, then settle.
    // Uniformly scaled harvested bark keeps its source shape, colour and grain intact.
    const seedPower=pending?glow:visibility*(1-ease((age-1.1)/1.8));
    if(seedPower>.001)for(let i=0;i<SEEDS;i++){
      const u=i/SEEDS,arm=i%2?1:-1,turn=u*Math.PI*8+arm*this.time*2.2;
      const radius=(.16+.40*Math.sqrt(u)+scatter*.32)*(pending?1-.25*glow:1);
      this.seedPose.position.set(Math.cos(turn)*radius*h,(.025+u*.32+scatter*.24)*h,Math.sin(turn)*radius*h);
      this.seedPose.rotation.set(turn*.5,u*19,turn);this.seedPose.scale.setScalar(h*(.019+.017*Math.sin(i*7.1)**2)*seedPower);this.seedPose.updateMatrix();
      this.seeds.setMatrixAt(this.seeds.count++,this.seedPose.matrix);
    }
    this.seeds.visible=this.seeds.count>0;if(this.seeds.visible)this.seeds.instanceMatrix.needsUpdate=true;
    this.fireflies.geometry.attributes.position.needsUpdate=true;this.fireflies.geometry.attributes.aAlpha.needsUpdate=true;
  }
}
