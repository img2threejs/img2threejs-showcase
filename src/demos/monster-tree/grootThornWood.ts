import * as THREE from 'three';

/** Sculpt a copy of Groot's own bark, retaining its forks, colour and irregular facets.
 * Never mutate the harvested stock: every other skill still uses the exact source mesh. */
export function sharpenGrootWood(source: THREE.BufferGeometry, jade = false): THREE.BufferGeometry {
  const geometry = source.clone(), position = geometry.getAttribute('position');
  const colors = geometry.getAttribute('color'), tint = new THREE.Color('#278765');
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
    const taper = Math.pow(Math.max(0, 1 - y), .72);
    // Position-based ridges remain continuous across duplicated seam vertices.
    const ridge = 1 + .12 * Math.sin(Math.atan2(z, x) * 9 + y * 7) + .06 * Math.sin(y * 51 + x * 23 + z * 17);
    position.setXYZ(i, x * taper * ridge, y, z * taper * ridge);
    if (jade) {
      const shade = .65 + .35 * y;
      colors.setXYZ(i, tint.r * shade, tint.g * shade, tint.b * shade);
    }else{
      const grain=.60+.18*(.5+.5*Math.sin(Math.atan2(z,x)*19+y*3+Math.sin(y*17)*.6));
      colors.setXYZ(i,colors.getX(i)*grain,colors.getY(i)*grain*.94,colors.getZ(i)*grain*.88);
    }
  }
  geometry.computeVertexNormals();geometry.computeBoundingBox();geometry.computeBoundingSphere();
  geometry.name = jade ? 'groot-jade-thorn-derived' : 'groot-rough-pointed-bark-derived';
  return geometry;
}

/** Small radial barbs, not miniature branch clusters. Their bark colours come from Groot. */
export function grootBarkThorn(source:THREE.BufferGeometry,jade=false):THREE.BufferGeometry {
  const positions:number[]=[],colours:number[]=[],indices:number[]=[],color=source.getAttribute('color'),tint=new THREE.Color('#358d69');
  for(let row=0;row<=6;row++)for(let side=0;side<7;side++){
    const t=row/6,a=side/7*Math.PI*2,r=.12*Math.pow(1-t,1.15)*(1+.16*Math.sin(side*5+row*.7));
    positions.push(Math.cos(a)*r+.13*t*t,t,Math.sin(a)*r);
    const at=(row*97+side*23)%color.count,s=.68+.32*t;
    colours.push(jade?tint.r*s:color.getX(at)*.69,jade?tint.g*s:color.getY(at)*.65,jade?tint.b*s:color.getZ(at)*.60);
    if(row<6){const n=row*7+side,k=row*7+(side+1)%7;indices.push(n,n+7,k,k,n+7,k+7);}
  }
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('color',new THREE.Float32BufferAttribute(colours,3));geometry.setIndex(indices);geometry.computeVertexNormals();geometry.computeBoundingBox();geometry.computeBoundingSphere();
  geometry.name=jade?'jade-tipped-bark-thorn':'source-palette-bark-thorn';return geometry;
}

/** Bark-space grain avoids stretched UVs on harvested branch fragments. */
export function installGrootThornGrain(material:THREE.MeshStandardMaterial):void{
  material.onBeforeCompile=shader=>{
    shader.vertexShader='varying vec3 thornBark;\n'+shader.vertexShader;
    shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nthornBark=position;');
    shader.fragmentShader='varying vec3 thornBark;\n'+shader.fragmentShader;
    shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
      float grain=sin(thornBark.x*91.+thornBark.z*77.+sin(thornBark.y*14.)*1.6);
      float pits=sin(thornBark.x*251.+thornBark.y*197.)*sin(thornBark.z*229.-thornBark.y*173.);
      diffuseColor.rgb*=.81+.13*grain+.06*pits;
    `);
    shader.fragmentShader=shader.fragmentShader.replace('#include <normal_fragment_maps>',`#include <normal_fragment_maps>
      // Screen derivatives emboss the continuous grain; no extra texture or draw pass.
      float relief=grain*.003+pits*.0006;
      vec3 sx=dFdx(vViewPosition),sy=dFdy(vViewPosition);
      vec3 rx=cross(sy,normal),ry=cross(normal,sx);float determinant=dot(sx,rx);
      normal=normalize(abs(determinant)*normal-sign(determinant)*(dFdx(relief)*rx+dFdy(relief)*ry));
    `);
  };
  material.customProgramCacheKey=()=> 'groot-thorn-grain-v1';
}
