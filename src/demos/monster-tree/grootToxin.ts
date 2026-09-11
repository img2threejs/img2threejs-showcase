import * as THREE from 'three';
import { forestGround } from './grootTerrain';

const CAPACITY=384;
/** Sap clings to the original bark surface. Mist is a separate, restrained accent, never green wood. */
export class GrootToxin {
  readonly group=new THREE.Group();
  readonly coats:THREE.InstancedMesh[]=[];
  readonly light:THREE.PointLight;
  private readonly clock={value:0};
  private readonly ice={value:0};
  setIce(value:boolean):void{this.ice.value=Number(value);this.light.color.set(value?'#8edfff':'#c4ca72');this.group.userData.skillTheme=value?'ice':'wood';}
  private readonly intensity={value:0};
  private readonly points:THREE.Points;
  private readonly position=new Float32Array(CAPACITY*3);
  private readonly opacity=new Float32Array(CAPACITY);
  private readonly size=new Float32Array(CAPACITY);
  private readonly velocity=new Float32Array(CAPACITY*3);
  private readonly age=new Float32Array(CAPACITY);
  private readonly life=new Float32Array(CAPACITY);
  private cursor=0;
  private clockTime=0;
  private impactAge=9;
  private readonly impact=new THREE.Vector3();
  private seed=52719;
  constructor(readonly height:number,wood:THREE.InstancedMesh[]){
    this.group.name='groot-toxic-sap';this.group.visible=false;
    const material=new THREE.ShaderMaterial({transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,uniforms:{uTime:this.clock,uPower:this.intensity},
      vertexShader:'varying vec3 vBark;void main(){vBark=position;vec4 p=vec4(position+normal*.0008,1.);gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*p;}',
      fragmentShader:'uniform float uTime;uniform float uPower;varying vec3 vBark;void main(){float crack=pow(.5+.5*sin(vBark.y*54.+sin(vBark.x*67.+vBark.z*41.)*2.5),28.);float patches=smoothstep(.25,.75,.5+.5*sin(vBark.x*43.-vBark.z*39.+vBark.y*8.));float pulse=.55+.25*sin(vBark.y*17.-uTime*2.7);float a=crack*patches*pulse*uPower*.52;if(a<.006)discard;gl_FragColor=vec4(mix(vec3(.55,.68,.17),vec3(.91,.64,.22),.5+.5*sin(vBark.y*13.)),a);}'
    });
    material.uniforms.uIce=this.ice;material.fragmentShader='uniform float uIce;\n'+material.fragmentShader.replace('gl_FragColor=vec4(mix(vec3(.55,.68,.17),vec3(.91,.64,.22),.5+.5*sin(vBark.y*13.)),a);','gl_FragColor=vec4(mix(mix(vec3(.55,.68,.17),vec3(.91,.64,.22),.5+.5*sin(vBark.y*13.)),vec3(.48,.88,1.),uIce),a);');
    for(const base of wood){const coat=new THREE.InstancedMesh(base.geometry,material,base.instanceMatrix.count);coat.name='bark-sap-fissures';coat.instanceMatrix=base.instanceMatrix;coat.count=0;coat.visible=false;coat.frustumCulled=false;this.group.add(coat);this.coats.push(coat);}
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(this.position,3));g.setAttribute('aOpacity',new THREE.BufferAttribute(this.opacity,1));g.setAttribute('aSize',new THREE.BufferAttribute(this.size,1));
    const mistMaterial=new THREE.ShaderMaterial({transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,
      vertexShader:'attribute float aOpacity;attribute float aSize;varying float vOpacity;void main(){vOpacity=aOpacity;vec4 p=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*p;gl_PointSize=min(80.,aSize*650./max(.1,-p.z));}',
      fragmentShader:'varying float vOpacity;void main(){vec2 p=gl_PointCoord-.5;float r=dot(p,p);if(r>.25)discard;float halo=exp(-r*24.)*.22;float core=exp(-r*210.);gl_FragColor=vec4(mix(vec3(.45,.61,.16),vec3(.89,.79,.40),core),vOpacity*(halo+core*.6));}'
    });
    mistMaterial.uniforms.uIce=this.ice;mistMaterial.fragmentShader='uniform float uIce;\n'+mistMaterial.fragmentShader.replace('mix(vec3(.45,.61,.16),vec3(.89,.79,.40),core)','mix(mix(vec3(.45,.61,.16),vec3(.89,.79,.40),core),mix(vec3(.22,.65,.88),vec3(.85,.97,1.),core),uIce)');
    this.points=new THREE.Points(g,mistMaterial);this.points.name='venom-sap-and-low-mist';this.points.visible=false;this.points.frustumCulled=false;this.group.add(this.points);
    this.light=new THREE.PointLight('#c4ca72',0,height*2.5,2);this.light.name='subtle-sap-bounce';this.group.add(this.light);
    this.group.traverse(o=>{o.userData.isHighlight=true;});
  }
  private random():number{this.seed=(1664525*this.seed+1013904223)>>>0;return this.seed/4294967296;}
  reset():void{
    this.life.fill(0);this.opacity.fill(0);this.impactAge=9;this.light.intensity=0;
    this.intensity.value=0;this.group.visible=false;this.points.visible=false;
    this.points.geometry.getAttribute('aOpacity').needsUpdate=true;
    for(const coat of this.coats){coat.count=0;coat.visible=false;}
  }
  impactAt(position:THREE.Vector3,ground:boolean,forward?:THREE.Vector3):void{
    this.impact.copy(position);this.impactAge=0;
    for(let n=0;n<(ground?150:75);n++){
      const i=this.cursor++%CAPACITY,k=i*3,angle=this.random()*Math.PI*2,r=this.random()*(ground?1.25:.16)*this.height;
      this.position[k]=position.x+Math.cos(angle)*r;this.position[k+2]=position.z+Math.sin(angle)*r;this.position[k+1]=Math.max(forestGround(this.position[k],this.position[k+2],this.height)+.02*this.height,position.y+(this.random()-.5)*this.height*.08);
      this.velocity[k]=Math.cos(angle)*this.height*(ground?.18:.12);this.velocity[k+1]=this.height*(.035+this.random()*.075);this.velocity[k+2]=Math.sin(angle)*this.height*(ground?.18:.12);
      if(forward){
        // A narrow forward bed follows Faultline; no radial cloud reaches back to the caster.
        const along=.12+this.random()*1.5*this.height,across=(this.random()-.5)*.5*this.height;
        this.position[k]=position.x+forward.x*along-forward.z*across;this.position[k+2]=position.z+forward.z*along+forward.x*across;
        this.position[k+1]=forestGround(this.position[k],this.position[k+2],this.height)+.025*this.height;
        this.velocity[k]=forward.x*.04*this.height;this.velocity[k+2]=forward.z*.04*this.height;
      }
      this.age[i]=0;this.life[i]=1.1+this.random()*1.5;this.size[i]=this.height*(ground?.11:.045)*(1+this.random());
    }
  }
  update(dt:number,wood:THREE.InstancedMesh[],toxic:boolean):void{
    this.group.visible=true;this.points.visible=true;this.clockTime+=dt;this.clock.value=this.clockTime;this.impactAge+=dt;
    this.intensity.value=toxic?1:0;
    for(let m=0;m<wood.length;m++){
      this.coats[m].count=wood[m].count;this.coats[m].visible=toxic&&wood[m].visible;
      // Sparse beads peel from the existing bark instances, with no per-frame geometry allocation.
      if(toxic&&wood[m].count&&this.random()<dt*14){
        const i=this.cursor++%CAPACITY,k=i*3,at=Math.floor(this.random()*wood[m].count)*16,a=wood[m].instanceMatrix.array;
        this.position[k]=a[at+12];this.position[k+1]=a[at+13];this.position[k+2]=a[at+14];this.velocity[k]=(this.random()-.5)*this.height*.03;this.velocity[k+1]=-this.height*.10;this.velocity[k+2]=(this.random()-.5)*this.height*.03;this.age[i]=0;this.life[i]=.8;this.size[i]=this.height*.035;
      }
    }
    for(let i=0;i<CAPACITY;i++){
      if(this.life[i]<=0){this.opacity[i]=0;continue;}this.age[i]+=dt;const u=this.age[i]/this.life[i];if(u>=1){this.life[i]=0;this.opacity[i]=0;continue;}
      const k=i*3;this.position[k]+=this.velocity[k]*dt;this.position[k+2]+=this.velocity[k+2]*dt;this.position[k+1]=Math.max(forestGround(this.position[k],this.position[k+2],this.height)+this.height*.012,this.position[k+1]+this.velocity[k+1]*dt);this.opacity[i]=Math.sin(Math.PI*u)*.65;
    }
    this.light.position.copy(this.impact);this.light.position.y+=this.height*.12;this.light.intensity=toxic?this.height*this.height*.35*Math.exp(-this.impactAge*3):0;
    this.points.geometry.getAttribute('position').needsUpdate=true;this.points.geometry.getAttribute('aOpacity').needsUpdate=true;this.points.geometry.getAttribute('aSize').needsUpdate=true;
  }
}
