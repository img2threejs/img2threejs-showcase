/** Directional support samples, not a full convex hull. Include all old 26 directions
 * plus the intervening primitive directions of a 5x5x5 lattice (98 total). The newly
 * calibrated run rotates a toe minimum between the old directions, missing ground by
 * .001772H. Denser extrema repair that regression without an arbitrary global lift.
 * Scan vertices once per direction, retaining separate dominant-joint extrema. */
export function directionalSurfaceSupportSamples(position:Float32Array,skinIndex:Uint16Array,joints:number,skinWeight?:Float32Array):Uint32Array{
 // Blended ankle/toe vertices can become the minimum between rigid-joint extrema.
 // Retain every old sample, plus weight-stratified extrema of the actual surface.
 // Construction only; runtime remains a bounded subset, never a full mesh scan.
 const support=new Set<number>(),bands=skinWeight?8:0;
 for(let x=-2;x<=2;x++)for(let y=-2;y<=2;y++)for(let z=-2;z<=2;z++){
  if(x%2===0&&y%2===0&&z%2===0)continue;
  const best=new Float64Array(joints*(bands+1)).fill(-Infinity),ids=new Int32Array(joints*(bands+1)).fill(-1);
  for(let v=0;v<position.length/3;v++){
   const bone=skinIndex[v*4],value=position[v*3]*x+position[v*3+1]*y+position[v*3+2]*z;
   if(value>best[bone]){best[bone]=value;ids[bone]=v;}
   if(skinWeight){const bin=joints+bone*bands+Math.min(bands-1,Math.floor(skinWeight[v*4]*bands));if(value>best[bin]){best[bin]=value;ids[bin]=v;}}
  }
  for(const id of ids)if(id>=0)support.add(id);
 }
 return new Uint32Array(support);
}
