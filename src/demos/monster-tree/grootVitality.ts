import * as THREE from 'three';
import type { MonsterTreeRig } from './rig';
import { glowTexture } from './grootForest';

/** Skin-bound crevice light. Rest-space height makes the wave travel anatomically head-to-foot. */
export class GrootVitality {
  readonly shell:THREE.SkinnedMesh;
  readonly eyes:THREE.Group[]=[];
  readonly clock={value:0};
  readonly creviceVertices:number;
  private readonly low={value:new THREE.Color('#0d66d9')};
  private readonly high={value:new THREE.Color('#73e6ff')};
  private readonly power={value:1};
  private readonly eyeCoreMaterial:THREE.MeshBasicMaterial;
  private readonly eyeHaloMaterial:THREE.SpriteMaterial;
  constructor(readonly rig:MonsterTreeRig){
    const source=rig.shell.geometry,geometry=source.clone(),p=source.attributes.position,n=source.attributes.normal,c=source.attributes.color,ix=source.index!;
    const neighbours=new Float32Array(p.count*3),counts=new Uint16Array(p.count),lengths=new Float32Array(p.count);
    const edge=(a:number,b:number):void=>{
      neighbours[a*3]+=p.getX(b);neighbours[a*3+1]+=p.getY(b);neighbours[a*3+2]+=p.getZ(b);counts[a]++;
      lengths[a]+=Math.hypot(p.getX(b)-p.getX(a),p.getY(b)-p.getY(a),p.getZ(b)-p.getZ(a));
    };
    for(let i=0;i<ix.count;i+=3){const a=ix.getX(i),b=ix.getX(i+1),d=ix.getX(i+2);edge(a,b);edge(a,d);edge(b,a);edge(b,d);edge(d,a);edge(d,b);}
    const mask=new Float32Array(p.count);let kept=0,minY=Infinity,maxY=-Infinity;
    for(let i=0;i<p.count;i++){
      minY=Math.min(minY,p.getY(i));maxY=Math.max(maxY,p.getY(i));
      if(!counts[i])continue;
      const count=counts[i],curvature=((neighbours[i*3]/count-p.getX(i))*n.getX(i)+(neighbours[i*3+1]/count-p.getY(i))*n.getY(i)+(neighbours[i*3+2]/count-p.getZ(i))*n.getZ(i))/Math.max(lengths[i]/count,.00001);
      const dark=1-THREE.MathUtils.smoothstep(.2126*c.getX(i)+.7152*c.getY(i)+.0722*c.getZ(i),.025,.17);
      mask[i]=THREE.MathUtils.clamp(curvature*5,0,1)*(.35+.65*dark);if(mask[i]>.15)kept++;
    }
    this.creviceVertices=kept;geometry.setAttribute('aCrevice',new THREE.BufferAttribute(mask,1));
    const material=new THREE.ShaderMaterial({transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,
      uniforms:{uTime:this.clock,uBottom:{value:minY},uHeight:{value:maxY-minY},uLow:this.low,uHigh:this.high,uPower:this.power},
      vertexShader:`#include <common>
        #include <skinning_pars_vertex>
        uniform float uBottom;uniform float uHeight;attribute float aCrevice;
        varying float vHeight;varying float vCrevice;varying vec3 vBark;
        void main(){
          vHeight=(position.y-uBottom)/uHeight;vCrevice=aCrevice;vBark=position/uHeight;
          #include <skinbase_vertex>
          #include <begin_vertex>
          transformed+=normal*uHeight*.00025;
          #include <skinning_vertex>
          #include <project_vertex>
        }`,
      fragmentShader:`uniform float uTime;uniform vec3 uLow;uniform vec3 uHigh;uniform float uPower;varying float vHeight;varying float vCrevice;varying vec3 vBark;
        void main(){
          float grain=.5+.5*sin(vBark.x*230.+vBark.z*197.+sin(vBark.y*31.+vBark.z*48.)*2.2);
          float fissure=smoothstep(.60,.94,grain)*smoothstep(.05,.55,vCrevice);
          float centre=1.-fract(uTime*.23);
          float d=vHeight-centre;float wave=exp(-d*d/ .006);
          float ripple=.60+.40*cos(d*110.);
          float strength=fissure*(.12+wave*ripple*1.25)*uPower;
          if(strength<.012)discard;
          gl_FragColor=vec4(mix(uLow,uHigh,wave),strength);
        }`
    });
    material.name='groot-blue-life-crevices';this.shell=new THREE.SkinnedMesh(geometry,material);
    this.shell.name='groot-skinned-life-wave';this.shell.bind(rig.skeleton,rig.shell.bindMatrix);this.shell.visible=false;this.shell.frustumCulled=false;this.shell.renderOrder=1;this.shell.userData.isHighlight=true;rig.group.add(this.shell);
    const map=glowTexture(),coreGeometry=new THREE.SphereGeometry(.004,16,10);
    this.eyeCoreMaterial=new THREE.MeshBasicMaterial({color:'#97eaff',toneMapped:false});
    this.eyeHaloMaterial=new THREE.SpriteMaterial({map,color:'#65caff',transparent:true,opacity:.82,blending:THREE.AdditiveBlending,depthWrite:false,toneMapped:false});
    for(const id of ['eye-l','eye-r']){
      const socket=rig.sockets[id];if(!socket)throw new Error(`Missing measured Groot eye socket: ${id}`);
      const eye=new THREE.Group();eye.name=`groot-blue-${id}`;eye.visible=false;
      const core=new THREE.Mesh(coreGeometry,this.eyeCoreMaterial);core.name='blue-eye-core';eye.add(core);
      const glow=new THREE.Sprite(this.eyeHaloMaterial);glow.scale.set(.028,.028,1);glow.name='blue-eye-halo';eye.add(glow);
      eye.traverse(o=>{o.userData.isHighlight=true;});socket.add(eye);this.eyes.push(eye);
    }
  }
  setPalette(low:THREE.Color,high:THREE.Color,eyeCore:THREE.Color,eyeHalo:THREE.Color,power:number):void{
    this.low.value.copy(low);this.high.value.copy(high);this.power.value=power;
    this.eyeCoreMaterial.color.copy(eyeCore);this.eyeHaloMaterial.color.copy(eyeHalo);
  }
  update(dt:number):void {this.clock.value+=dt;this.shell.visible=true;for(const eye of this.eyes)eye.visible=true;}
}
