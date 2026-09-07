import * as THREE from 'three';
/** Bloom attachment transport on welded source edges. Upper branches inherit their
 * connected collar/arm weights rather than switching ownership with crown height. */
export function bloomAttachmentField(position:Float32Array,index:Uint32Array,channel:0|1|2):Float32Array {
 const n=position.length/3,canonical=new Uint32Array(n),points=new Map<string,number>();
 for(let i=0;i<n;i++){const key=`${position[i*3]},${position[i*3+1]},${position[i*3+2]}`;canonical[i]=points.get(key)??i;if(!points.has(key))points.set(key,i);}
 const edges=new Set<number>();for(let f=0;f<index.length;f+=3)for(let k=0;k<3;k++){const a=canonical[index[f+k]],b=canonical[index[f+(k+1)%3]];if(a!==b)edges.add(Math.min(a,b)*n+Math.max(a,b));}
 const offsets=new Uint32Array(n+1);for(const e of edges){offsets[Math.floor(e/n)+1]++;offsets[e%n+1]++;}for(let i=1;i<=n;i++)offsets[i]+=offsets[i-1];
 const cursor=offsets.slice(),neighbours=new Uint32Array(offsets[n]),weights=new Float32Array(offsets[n]);
 for(const e of edges){const a=Math.floor(e/n),b=e%n,w=1/Math.max(1e-5,Math.hypot(position[a*3]-position[b*3],position[a*3+1]-position[b*3+1],position[a*3+2]-position[b*3+2]));for(const [u,v]of [[a,b],[b,a]]){const at=cursor[u]++;neighbours[at]=v;weights[at]=w;}}
 const field=new Float32Array(n),free:number[]=[];
 for(const i of points.values()){
  const y=position[i*3+1],az=Math.abs(position[i*3+2]),smooth=THREE.MathUtils.smoothstep;
  const skull=y>.79&&az<.075;
  // Dirichlet anchors: measured T-pose collar/arms below .665, central skull above .79.
  // Everything else above the collar transports its actual connected attachment.
  const arm=smooth(az,.08,.17)*smooth(y,.47,.57),head=smooth(y,.685,.765)*(1-smooth(az,.10,.18)),fore=smooth(az,.23,.30);
  field[i]=skull?(channel===1?1:0):channel===0?arm:channel===1?head:fore;
  if(y>.665&&!skull&&offsets[i+1]>offsets[i])free.push(i);
 }
 const isFree=new Uint8Array(n);for(const i of free)isFree[i]=1;
 const diagonal=new Float64Array(n),r=new Float64Array(n),direction=new Float64Array(n),ap=new Float64Array(n),solution=Float64Array.from(field);
 const multiply=(input:Float64Array,output:Float64Array)=>{for(const i of free){let sum=diagonal[i]*input[i];for(let j=offsets[i];j<offsets[i+1];j++)if(isFree[neighbours[j]])sum-=weights[j]*input[neighbours[j]];output[i]=sum;}};
 for(const i of free)for(let j=offsets[i];j<offsets[i+1];j++)diagonal[i]+=weights[j];
 multiply(solution,ap);let rz=0;
 for(const i of free){let rhs=0;for(let j=offsets[i];j<offsets[i+1];j++)if(!isFree[neighbours[j]])rhs+=weights[j]*field[neighbours[j]];r[i]=rhs-ap[i];direction[i]=r[i]/diagonal[i];rz+=r[i]*direction[i];}
 const initial=rz;
 for(let iteration=0;iteration<800&&rz>initial*1e-14;iteration++){
  multiply(direction,ap);let dot=0;for(const i of free)dot+=direction[i]*ap[i];if(dot<=0)break;const alpha=rz/dot;
  let next=0;for(const i of free){solution[i]+=alpha*direction[i];r[i]-=alpha*ap[i];next+=r[i]*r[i]/diagonal[i];}
  const beta=next/rz;for(const i of free)direction[i]=r[i]/diagonal[i]+beta*direction[i];rz=next;
 }
 for(const i of free)field[i]=THREE.MathUtils.clamp(solution[i],0,1);for(let i=0;i<n;i++)field[i]=field[canonical[i]];return field;
}
