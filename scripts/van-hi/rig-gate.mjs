/**
 * Rig gate for Van Hi: prove the garment separation moved the numbers it claims to have moved.
 *
 *     node scripts/van-hi/rig-gate.mjs
 *
 * Measures the TWO MESHES AS THEY SHIP, not the shell they were cut from. Every edge of each mesh
 * is skinned at five times through all 22 clips and compared with its bind length; "source" re-runs
 * the SAME mesh with the source rig's own weights, so what the table shows is the rebinding and not
 * the cut. Absolute elongation, in millimetres on the 1.9 m figure — not a ratio, because the
 * median edge here is about 3 mm and a ratio on a 3 mm edge says more about the mesh's density than
 * about anything a viewer can see.
 *
 * What it printed when the demo was written:
 *
 *     mesh      edges     worst mm    mean mm   >5mm     >2cm
 *     body source       68716     360.1     0.394    0.98%    0.13%
 *     body shipped      68716      75.8     0.287    0.73%    0.04%
 *     garment source   391084    1750.1     2.043    1.96%    0.71%
 *     garment shipped  391084     109.6     0.058    0.32%    0.03%

 */
import { execFileSync } from 'node:child_process';
import { loadSurface, loadRig, decodeModel, decodeUint16s, decodeFloats } from './decode.mjs';
import { composeTRS, multiply, slerp } from './skinmath.mjs';
// The module under test is TypeScript; transpile it once so this runs under plain node.
const BUILT = 'scripts/van-hi/.garmentSeparation.mjs';
execFileSync('node_modules/.bin/esbuild', ['src/demos/van-hi/garmentSeparation.ts', '--format=esm', '--loader:.ts=ts', `--outfile=${BUILT}`], { stdio: 'pipe' });
const { separateGarment } = await import(`../../${BUILT}`);
const { model, stream } = loadSurface();
const part = decodeModel(model, stream)[0];
const rig = loadRig();
const P = part.position, B = rig.bones.length;
const srcJ = decodeUint16s(rig.skinIndex), srcW = decodeFloats(rig.skinWeight);
const split = separateGarment(P, part.srgb, part.index, rig);

const restLocal=[],restWorld=[];
for(let b=0;b<B;b++){const bo=rig.bones[b];const l=composeTRS(bo.position,bo.quaternion,bo.scale,new Float64Array(16));restLocal.push(l);restWorld.push(bo.parent<0?l.slice():multiply(restWorld[bo.parent],l,new Float64Array(16)));}
const tcache=new Map();
function tracksOf(c){let t=tcache.get(c.name);if(!t){t=new Map(c.tracks.map(x=>[x.bone,{times:decodeFloats(x.times),position:decodeFloats(x.position),quaternion:decodeFloats(x.quaternion),scale:decodeFloats(x.scale)}]));tcache.set(c.name,t);}return t;}
function poseAt(clip,t){const tr=tracksOf(clip),world=[];const q=new Float64Array(4),p=new Float64Array(3),sc=new Float64Array(3);
 for(let b=0;b<B;b++){const k0=tr.get(b);let local;
  if(!k0)local=restLocal[b];else{const{times,position,quaternion,scale}=k0;
   let k=0;while(k<times.length-2&&times[k+1]<t)k++;const k1=Math.min(k+1,times.length-1),t0=times[k],t1=times[k1];const u=t1>t0?Math.min(1,Math.max(0,(t-t0)/(t1-t0))):0;
   for(let c=0;c<3;c++){p[c]=position[k*3+c]+(position[k1*3+c]-position[k*3+c])*u;sc[c]=scale[k*3+c]+(scale[k1*3+c]-scale[k*3+c])*u;}
   slerp(quaternion.subarray(k*4,k*4+4),quaternion.subarray(k1*4,k1*4+4),u,q);local=composeTRS(p,q,sc,new Float64Array(16));}
  world.push(rig.bones[b].parent<0?local.slice():multiply(world[rig.bones[b].parent],local,new Float64Array(16)));}
 return world;}
function skinMatrices(world){const out=new Float64Array(B*16);
 for(let b=0;b<B;b++){const ib=rig.bones[b].inverseBind,wm=world[b];
  for(let c=0;c<4;c++)for(let r=0;r<4;r++){let a=0;for(let i=0;i<4;i++)a+=wm[i*4+r]*ib[c*4+i];out[b*16+c*4+r]=a;}}
 return out;}

function measure(mp, joints, weights, indexBy) {
  const edges=[]; const seen=new Set();
  for(let f=0;f<mp.index.length;f+=3)for(let e=0;e<3;e++){
    const a=mp.index[f+e],b=mp.index[f+((e+1)%3)];
    const key=a<b?a*200000+b:b*200000+a; if(seen.has(key))continue; seen.add(key);
    const va=mp.sourceVertex[a],vb=mp.sourceVertex[b];
    const rest=Math.hypot(P[va*3]-P[vb*3],P[va*3+1]-P[vb*3+1],P[va*3+2]-P[vb*3+2]);
    if(rest>1e-6)edges.push([a,b,va,vb,rest]);}
  const A=new Float64Array(3),Bv=new Float64Array(3);
  const sp=(sm,i,v,o)=>{const x=P[v*3],y=P[v*3+1],z=P[v*3+2];let ox=0,oy=0,oz=0;
   const at=indexBy==='local'?i:v;
   for(let k=0;k<4;k++){const w=weights[at*4+k];if(w<=0)continue;const q=joints[at*4+k]*16;
    ox+=w*(sm[q]*x+sm[q+4]*y+sm[q+8]*z+sm[q+12]);oy+=w*(sm[q+1]*x+sm[q+5]*y+sm[q+9]*z+sm[q+13]);oz+=w*(sm[q+2]*x+sm[q+6]*y+sm[q+10]*z+sm[q+14]);}
   o[0]=ox;o[1]=oy;o[2]=oz;};
  let worst=0,sum=0,n=0,o5=0,o20=0;
  for(const clip of rig.clips)for(let s=0;s<5;s++){const sm=skinMatrices(poseAt(clip,(clip.duration*s)/5));
   for(const [a,b,va,vb,rest] of edges){sp(sm,a,va,A);sp(sm,b,vb,Bv);
    const g=Math.abs(Math.hypot(A[0]-Bv[0],A[1]-Bv[1],A[2]-Bv[2])-rest);
    n++;sum+=g;if(g>0.0026)o5++;if(g>0.0105)o20++;if(g>worst)worst=g;}}
  return {edges:edges.length,worst:worst*1900,mean:sum/n*1900,o5:o5/n*100,o20:o20/n*100};
}

console.log('mesh      edges     worst mm    mean mm   >5mm     >2cm');
for (const [name, mp] of [['body', split.body], ['garment', split.garment]]) {
  const before = measure(mp, srcJ, srcW, 'source');
  const after  = measure(mp, mp.skinIndex, mp.skinWeight, 'local');
  const row=(tag,r)=>console.log(`${(name+' '+tag).padEnd(16)} ${String(r.edges).padStart(6)}  ${r.worst.toFixed(1).padStart(8)}  ${r.mean.toFixed(3).padStart(8)}  ${r.o5.toFixed(2).padStart(6)}%  ${r.o20.toFixed(2).padStart(6)}%`);
  row('source', before); row('shipped', after);
}
