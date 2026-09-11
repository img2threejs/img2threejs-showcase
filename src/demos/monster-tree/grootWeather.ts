import * as THREE from 'three';
import { forestGround } from './grootTerrain';

/** Fixed atmospheric pool: windborne mist, restrained green vapour and floating pollen. */
export class GrootWeather {
  readonly group=new THREE.Group();
  readonly mist:THREE.InstancedMesh;
  readonly dust:THREE.Points;
  private readonly clock={value:0};
  readonly daylight={value:0};
  private readonly dummy=new THREE.Object3D();
  private readonly positions=new Float32Array(256*3);
  constructor(readonly height:number){
    this.group.name='groot-forest-weather';this.group.visible=false;
    const geometry=new THREE.PlaneGeometry(1,1);
    geometry.setAttribute('phase',new THREE.InstancedBufferAttribute(Float32Array.from({length:96},(_,i)=>i*1.712),1));
    const material=new THREE.ShaderMaterial({transparent:true,depthWrite:false,side:THREE.DoubleSide,
      uniforms:{clock:this.clock,daylight:this.daylight},
      vertexShader:`attribute float phase;varying vec2 vUv;varying float vSeed;void main(){
        vUv=uv;vSeed=phase;vec4 centre=modelViewMatrix*instanceMatrix*vec4(0.,0.,0.,1.);
        centre.xy+=position.xy*vec2(length(instanceMatrix[0].xyz),length(instanceMatrix[1].xyz));gl_Position=projectionMatrix*centre;
      }`,
      fragmentShader:`uniform float clock;uniform float daylight;varying vec2 vUv;varying float vSeed;
        float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
        float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+1.),f.x),f.y);}
        void main(){vec2 p=vUv-.5;float edge=1.-smoothstep(.20,.51,length(p));
          float n=noise(vUv*5.+vec2(clock*.025+vSeed,clock*.008));n=.65*n+.35*noise(vUv*12.-clock*.017+vSeed);
          float wisps=smoothstep(.25,.8,n)*edge;float toxic=step(.62,fract(vSeed));
          vec3 moon=mix(vec3(.23,.32,.36),vec3(.24,.39,.28),toxic*.65);
          vec3 sun=mix(vec3(.66,.70,.62),vec3(.43,.58,.38),toxic*.40);
          gl_FragColor=vec4(mix(moon,sun,daylight),wisps*.16);
        }`});
    this.mist=new THREE.InstancedMesh(geometry,material,96);this.mist.name='layered-green-woodland-mist';this.mist.visible=false;this.mist.count=0;this.mist.frustumCulled=false;this.group.add(this.mist);
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(this.positions,3));
    g.setAttribute('size',new THREE.BufferAttribute(Float32Array.from({length:256},(_,i)=>height*(.006+.006*(.5+.5*Math.sin(i*17)))),1));
    this.dust=new THREE.Points(g,new THREE.ShaderMaterial({transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,
      vertexShader:'attribute float size;void main(){vec4 p=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*p;gl_PointSize=clamp(size*500./max(.1,-p.z),1.,5.);}',
      fragmentShader:'void main(){float r=length(gl_PointCoord-.5)*2.;gl_FragColor=vec4(.50,.69,.53,exp(-r*r*6.)*.24);}' }));
    this.dust.name='suspended-forest-pollen';this.dust.visible=false;this.dust.frustumCulled=false;this.group.add(this.dust);
  }
  update(dt:number,origin:THREE.Vector3):void{
    this.clock.value+=dt;const t=this.clock.value,h=this.height;
    for(let i=0;i<96;i++){
      // Wrap a stable world grid far from the player instead of dragging smoke with their feet.
      const px=(i%12-6)*1.8+t*.018+Math.sin(i*9)*.4,pz=(Math.floor(i/12)-4)*2.5+Math.cos(i*5)*.7;
      const x=(px+Math.floor((origin.x/h-px)/21.6+.5)*21.6)*h,z=(pz+Math.floor((origin.z/h-pz)/20+.5)*20)*h;
      const clear=Math.max(.001,THREE.MathUtils.smoothstep(Math.hypot(x-origin.x,z-origin.z)/h,.8,2.5));
      this.dummy.position.set(x,forestGround(x,z,h)+h*(.18+(i%4)*.34+.07*Math.sin(t*.12+i)),z);
      this.dummy.scale.set(h*(1.8+(i%3)*.55)*clear,h*(.55+(i%4)*.22)*clear,1);this.dummy.updateMatrix();this.mist.setMatrixAt(i,this.dummy.matrix);
    }
    for(let i=0;i<256;i++){
      const a=i*2.399+t*.015,r=h*(1.3+(i%37)*.18),x=origin.x+Math.cos(a)*r,z=origin.z+Math.sin(a)*r;
      this.positions[i*3]=x;this.positions[i*3+1]=forestGround(x,z,h)+h*(.15+(i%17)*.14+.10*Math.sin(t*.21+i));this.positions[i*3+2]=z;
    }
    this.group.visible=this.mist.visible=this.dust.visible=true;this.mist.count=96;this.mist.instanceMatrix.needsUpdate=true;this.dust.geometry.attributes.position.needsUpdate=true;
  }
}
