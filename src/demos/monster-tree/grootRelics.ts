import * as THREE from 'three';
import { forestRandom } from './grootForest';
import { forestGround, placementTrees, type TreePlacementSource } from './grootWorld';
import { GrootSkin, RELIC_SKIN_BITS } from './grootSkin';
import { inRiverH } from './grootRiverPath';

export const GROOT_RELICS=[
  {id:'moonroot-heart',label:'Moonroot Heart',bit:RELIC_SKIN_BITS.heart,color:new THREE.Color('#8ed9cf')},
  {id:'star-sap-shard',label:'Star-Sap Shard',bit:RELIC_SKIN_BITS.sap,color:new THREE.Color('#ffe3a0')},
  {id:'crown-spore',label:'Crown Spore',bit:RELIC_SKIN_BITS.crown,color:new THREE.Color('#9dffc2')},
] as const;

type RelicDefinition=(typeof GROOT_RELICS)[number];
interface RelicState {position:THREE.Vector3;drawPosition:THREE.Vector3;collected:boolean;age:number;}
const BURST_PER_RELIC=24,HALO_COUNT=3,POINT_COUNT=HALO_COUNT+GROOT_RELICS.length*BURST_PER_RELIC;
const ease=(x:number):number=>{const t=THREE.MathUtils.clamp(x,0,1);return 1-(1-t)**3;};

function freshSeed():number{
  try{const value=new Uint32Array(1);window.crypto.getRandomValues(value);return value[0]||1;}catch{return(Math.random()*0xffffffff)>>>0||1;}
}

/** Pure, bounded placement with deterministic fallbacks for browser reproduction. */
export function planGrootRelics(seed:number,height:number,colliders:TreePlacementSource):THREE.Vector3[]{
  const random=forestRandom(seed||1),points:THREE.Vector3[]=[];
  const safe=(x:number,z:number):boolean=>{
    if(inRiverH(x/height,z/height,.6))return false;
    if(Math.hypot(x,z)<6*height||Math.hypot(x,z)>15*height)return false;
    for(const point of points)if(Math.hypot(point.x-x,point.z-z)<3.8*height)return false;
    for(const collider of placementTrees(colliders,x,z,.48*height))if(Math.hypot(collider.x-x,collider.z-z)<collider.radius+.48*height)return false;
    return true;
  };
  for(let i=0;i<GROOT_RELICS.length;i++){
    let placed=false;
    for(let attempt=0;attempt<96&&!placed;attempt++){
      const sector=(i+random()*.72)/GROOT_RELICS.length*Math.PI*2+random()*.32,radius=(6.4+random()*8.1)*height;
      const x=Math.cos(sector)*radius,z=Math.sin(sector)*radius;
      if(safe(x,z)){points.push(new THREE.Vector3(x,forestGround(x,z,height)+.22*height,z));placed=true;}
    }
    if(placed)continue;
    for(let step=0;step<180&&!placed;step++){
      const angle=(i/3+step*.381966)*Math.PI*2,radius=(7+(step%8))*height,x=Math.cos(angle)*radius,z=Math.sin(angle)*radius;
      if(safe(x,z)){points.push(new THREE.Vector3(x,forestGround(x,z,height)+.22*height,z));placed=true;}
    }
    if(!placed)throw new Error(`Unable to place Groot relic ${i} away from woodland colliders`);
  }
  return points;
}

/** Three unique session relics: progressive accents, then entitlement to the supplied Ice form. */
export class GrootRelics {
  readonly group=new THREE.Group();
  readonly body:THREE.InstancedMesh;
  readonly motes:THREE.Points;
  readonly skin:GrootSkin;
  onCollect?: (relic:RelicDefinition,count:number,complete:boolean)=>void;
  seed=0;
  active=false;
  private time=0;
  private readonly states:RelicState[]=GROOT_RELICS.map(()=>({position:new THREE.Vector3(),drawPosition:new THREE.Vector3(),collected:false,age:0}));
  private readonly dummy=new THREE.Object3D();
  private readonly target=new THREE.Vector3();
  private readonly positions=new Float32Array(POINT_COUNT*3);
  private readonly colours=new Float32Array(POINT_COUNT*3);
  private readonly sizes=new Float32Array(POINT_COUNT);
  private readonly alphas=new Float32Array(POINT_COUNT);
  private readonly velocity=new Float32Array(POINT_COUNT*3);
  private readonly ages=new Float32Array(POINT_COUNT);
  private readonly lives=new Float32Array(POINT_COUNT);
  constructor(readonly height:number,skin:GrootSkin,private readonly colliders:TreePlacementSource){
    this.skin=skin;this.group.name='groot-random-relics';this.group.visible=false;
    const geometry=new THREE.DodecahedronGeometry(1,1);
    const material=new THREE.MeshStandardMaterial({color:'#ffffff',emissive:'#346c63',emissiveIntensity:.88,roughness:.34,metalness:.16,vertexColors:true});
    this.body=new THREE.InstancedMesh(geometry,material,GROOT_RELICS.length);this.body.name='groot-relic-fragments';this.body.count=GROOT_RELICS.length;this.body.castShadow=true;this.body.frustumCulled=false;
    GROOT_RELICS.forEach((relic,i)=>this.body.setColorAt(i,relic.color));this.body.instanceColor!.needsUpdate=true;this.group.add(this.body);
    const points=new THREE.BufferGeometry();points.setAttribute('position',new THREE.BufferAttribute(this.positions,3));points.setAttribute('color',new THREE.BufferAttribute(this.colours,3));points.setAttribute('aSize',new THREE.BufferAttribute(this.sizes,1));points.setAttribute('aAlpha',new THREE.BufferAttribute(this.alphas,1));
    const pointMaterial=new THREE.ShaderMaterial({transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,vertexColors:true,
      vertexShader:'attribute float aSize;attribute float aAlpha;varying vec3 vColor;varying float vAlpha;void main(){vColor=color;vAlpha=aAlpha;vec4 p=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*p;gl_PointSize=clamp(aSize*540./max(.1,-p.z),1.,72.);}',
      fragmentShader:'varying vec3 vColor;varying float vAlpha;void main(){float r=length(gl_PointCoord-.5)*2.;float glow=exp(-r*r*5.);gl_FragColor=vec4(vColor,glow*vAlpha*smoothstep(1.,.68,r));}'});
    this.motes=new THREE.Points(points,pointMaterial);this.motes.name='groot-relic-halos-and-absorption';this.motes.frustumCulled=false;this.group.add(this.motes);
    for(let i=0;i<POINT_COUNT;i++){this.sizes[i]=i<HALO_COUNT?.16*height:.026*height;this.alphas[i]=0;}
    this.relocate(freshSeed());
    this.group.traverse(object=>{object.userData.isHighlight=true;});
  }
  get collectedCount():number{return this.states.reduce((count,state)=>count+Number(state.collected),0);}
  relocate(seed:number):void{
    this.seed=seed>>>0||1;const plan=planGrootRelics(this.seed,this.height,this.colliders);this.skin.reset();this.time=0;this.lives.fill(0);this.ages.fill(0);this.alphas.fill(0);
    for(let i=0;i<this.states.length;i++){const state=this.states[i];state.position.copy(plan[i]);state.drawPosition.copy(plan[i]);state.collected=false;state.age=0;}
    this.refreshMatrices(new THREE.Vector3());
  }
  setActive(active:boolean):void{this.active=active;this.group.visible=active;}
  update(dt:number,actor:THREE.Vector3,allowPickup:boolean):void{
    if(!this.active)return;this.time+=dt;this.skin.update(dt);
    if(allowPickup){
      for(let i=0;i<this.states.length;i++){
        const state=this.states[i];if(!state.collected&&state.position.distanceToSquared(actor)<(.42*this.height)**2)this.collect(i,actor);
      }
    }
    for(let i=0;i<this.states.length;i++)if(this.states[i].collected)this.states[i].age+=dt;
    this.refreshMatrices(actor);this.updateMotes(dt);
  }
  nearestDistance(actor:THREE.Vector3):number{
    let nearest=Infinity;for(const state of this.states)if(!state.collected)nearest=Math.min(nearest,Math.sqrt(state.position.distanceToSquared(actor)));return nearest;
  }
  collectIndex(index:number,actor:THREE.Vector3):boolean{
    if(index<0||index>=this.states.length||this.states[index].collected)return false;this.collect(index,actor);return true;
  }
  inspect():{seed:number;mask:number;complete:boolean;count:number;drawCalls:number;items:Array<{id:string;collected:boolean;position:number[]}>}{
    return{seed:this.seed,mask:this.skin.mask,complete:this.skin.complete,count:this.collectedCount,drawCalls:3,items:this.states.map((state,i)=>({id:GROOT_RELICS[i].id,collected:state.collected,position:state.position.toArray()}))};
  }
  private collect(index:number,actor:THREE.Vector3):void{
    const state=this.states[index];if(state.collected)return;state.collected=true;state.age=0;state.drawPosition.copy(state.position);this.skin.collect(GROOT_RELICS[index].bit);this.emitBurst(index,state.position,actor);this.onCollect?.(GROOT_RELICS[index],this.collectedCount,this.skin.complete);
  }
  private refreshMatrices(actor:THREE.Vector3):void{
    for(let i=0;i<this.states.length;i++){
      const state=this.states[i],relic=GROOT_RELICS[i],absorb=ease(state.age/.72),bob=Math.sin(this.time*1.65+i*2.2)*.055*this.height;
      if(state.collected){this.target.copy(actor);this.target.y+=this.height*.62;state.drawPosition.lerpVectors(state.position,this.target,absorb);}
      else state.drawPosition.copy(state.position);
      this.dummy.position.copy(state.drawPosition);this.dummy.position.y+=bob*(1-absorb);this.dummy.rotation.set(this.time*.55+i*.7,this.time*(.82+i*.08),i*.45);
      const scale=this.height*(.105+i*.012)*(1-absorb);this.dummy.scale.set(scale*(i===0?1.08:.82),scale*(i===1?1.28:.92),scale);this.dummy.updateMatrix();this.body.setMatrixAt(i,this.dummy.matrix);
      const at=i*3;this.positions[at]=this.dummy.position.x;this.positions[at+1]=this.dummy.position.y;this.positions[at+2]=this.dummy.position.z;relic.color.toArray(this.colours,at);this.alphas[i]=state.collected?(1-absorb)*.9:.66+.20*Math.sin(this.time*2+i);
    }
    this.body.instanceMatrix.needsUpdate=true;
  }
  private emitBurst(index:number,origin:THREE.Vector3,actor:THREE.Vector3):void{
    const random=forestRandom(this.seed+index*9973),relic=GROOT_RELICS[index],start=HALO_COUNT+index*BURST_PER_RELIC;
    this.target.copy(actor).sub(origin).normalize();
    for(let j=0;j<BURST_PER_RELIC;j++){
      const i=start+j,at=i*3,a=random()*Math.PI*2,speed=this.height*(.16+random()*.28);
      this.positions[at]=origin.x;this.positions[at+1]=origin.y;this.positions[at+2]=origin.z;
      this.velocity[at]=Math.cos(a)*speed+this.target.x*this.height*.18;this.velocity[at+1]=this.height*(.12+random()*.30);this.velocity[at+2]=Math.sin(a)*speed+this.target.z*this.height*.18;
      relic.color.toArray(this.colours,at);this.ages[i]=0;this.lives[i]=.65+random()*.45;this.alphas[i]=1;
    }
  }
  private updateMotes(dt:number):void{
    for(let i=HALO_COUNT;i<POINT_COUNT;i++){
      if(this.lives[i]<=0){this.alphas[i]=0;continue;}this.ages[i]+=dt;const life=this.ages[i]/this.lives[i];if(life>=1){this.lives[i]=0;this.alphas[i]=0;continue;}
      const at=i*3;this.velocity[at]*=Math.exp(-dt*1.8);this.velocity[at+2]*=Math.exp(-dt*1.8);this.velocity[at+1]-=this.height*.34*dt;
      this.positions[at]+=this.velocity[at]*dt;this.positions[at+1]+=this.velocity[at+1]*dt;this.positions[at+2]+=this.velocity[at+2]*dt;this.alphas[i]=(1-life)**1.4;
    }
    for(const name of ['position','color','aAlpha'])this.motes.geometry.getAttribute(name).needsUpdate=true;
  }
}
