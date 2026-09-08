import * as THREE from 'three';
import { forestHeightH } from './grootWorld';
import { riverCentreH,riverWidthH,RIVER_LEVEL_H } from './grootRiverPath';
/** Preserve the authored .25H longitudinal/24 transverse surface samples and bank strips.
 * Clip triangles to 3H ownership cells. No full-path GPU mesh or retained segment cache.
 */
export function riverTile(cx:number,cz:number,height:number,bank=false):THREE.BufferGeometry {
  const p:number[]=[],uv:number[]=[],depth:number[]=[],colour:number[]=[],normal:number[]=[];
  const minX=Math.max(-34,cx*3),maxX=Math.min(34,(cx+1)*3),loZ=cz*3,hiZ=loZ+3;
  type Point={x:number;z:number};
  const clip=(points:Point[],edge:number,upper:boolean):Point[]=>{
    const result:Point[]=[];
    for(let i=0;i<points.length;i++){
      const a=points[i],b=points[(i+1)%points.length],insideA=upper?a.z<=edge:a.z>=edge,insideB=upper?b.z<=edge:b.z>=edge;
      if(insideA)result.push(a);
      if(insideA!==insideB){const t=(edge-a.z)/(b.z-a.z);result.push({x:a.x+(b.x-a.x)*t,z:edge});}
    }
    return result;
  };
  const vertex=({x,z}:Point)=>{
    const y=bank?forestHeightH(x,z)+.006:RIVER_LEVEL_H;
    p.push(x*height,y*height,z*height);uv.push(x*.75,z*.75);depth.push(Math.max(0,RIVER_LEVEL_H-forestHeightH(x,z)));
    const patch=.88+.12*Math.sin(x*.61+Math.sin(z*.47));colour.push(patch,patch*.98,patch*.9);
    if(bank){const e=.001,n=new THREE.Vector3(-(forestHeightH(x+e,z)-forestHeightH(x-e,z))/(2*e),1,-(forestHeightH(x,z+e)-forestHeightH(x,z-e))/(2*e)).normalize();normal.push(n.x,n.y,n.z);}else normal.push(0,1,0);
  };
  const tri=(a:Point,b:Point,c:Point)=>{
    const points=clip(clip([a,b,c],loZ,false),hiZ,true);
    for(let i=1;i+1<points.length;i++){
      const [u,v,w]=[points[0],points[i],points[i+1]];
      const area=(v.x-u.x)*(w.z-u.z)-(v.z-u.z)*(w.x-u.x);if(Math.abs(area)<1e-10)continue;
      // Upward winding in XZ.
      vertex(u);vertex(area>0?w:v);vertex(area>0?v:w);
    }
  };
  const at=(x:number,j:number,side:number):Point=>({x,z:riverCentreH(x)+(bank?side*(riverWidthH(x)*.78+j/6*1.25):(j/24*2-1)*riverWidthH(x))});
  // Analytic path: centre in [-9.73,-6.27], width <=1.01, bank extension <=1.25.
  for(let x=minX;loZ< -4.0&&hiZ> -12.0&&x<maxX;x+=.25)for(const side of bank?[-1,1]:[0])for(let j=0;j<(bank?6:24);j++){
    const a=at(x,j,side),b=at(Math.min(x+.25,maxX),j,side),c=at(x,j+1,side),d=at(Math.min(x+.25,maxX),j+1,side);
    tri(a,c,b);tri(b,c,d);
  }
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(p,3));g.setAttribute('normal',new THREE.Float32BufferAttribute(normal,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
  g.setAttribute('color',new THREE.Float32BufferAttribute(colour,3));if(!bank)g.setAttribute('riverDepth',new THREE.Float32BufferAttribute(depth,1));g.computeBoundingSphere();return g;
}
