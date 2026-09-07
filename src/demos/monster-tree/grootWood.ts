import * as THREE from 'three';
import type { MonsterTreeRig } from './rig';

export interface GrootWoodStock {
  geometry: THREE.BufferGeometry;
  /** Exact vertex correspondence into the source geometry; retained for the provenance gate. */
  sourceVertices: Uint32Array;
}

/** Harvest the bark-rich shoulder spurs, above the rounded shoulder/arm mass. */
export function extractGrootWood(rig: MonsterTreeRig): GrootWoodStock[] {
  const source=rig.shell.geometry,p=source.getAttribute('position'),si=source.getAttribute('skinIndex'),sw=source.getAttribute('skinWeight');
  const regions=['R_UpperarmTwist01','L_UpperarmTwist01'];
  const labels=new Int8Array(p.count).fill(-1),minimum=[Infinity,Infinity],maximum=[-Infinity,-Infinity];
  for(let v=0;v<p.count;v++){
    let best=0;for(let k=1;k<4;k++)if(sw.array[v*4+k]>sw.array[v*4+best])best=k;
    const region=regions.indexOf(rig.skeleton.bones[si.array[v*4+best]].name);
    labels[v]=region;
    if(region>=0){minimum[region]=Math.min(minimum[region],p.getY(v));maximum[region]=Math.max(maximum[region],p.getY(v));}
  }
  const keep=(v:number):boolean=>labels[v]>=0&&p.getY(v)>minimum[labels[v]]+(maximum[labels[v]]-minimum[labels[v]])*.45;
  const vertices:number[]=[],faces:number[]=[],remap=new Map<number,number>(),ix=source.index!;
  for(let f=0;f<ix.count;f+=3){
    if(!keep(ix.array[f])||!keep(ix.array[f+1])||!keep(ix.array[f+2]))continue;
    for(let k=0;k<3;k++){
      const original=ix.array[f+k];
      if(!remap.has(original)){remap.set(original,vertices.length);vertices.push(original);}
      faces.push(remap.get(original)!);
    }
  }
  const cut=new THREE.BufferGeometry();cut.setIndex(faces);
  for(const name of ['position','normal','color']){
    const attribute=source.getAttribute(name),array=new Float32Array(vertices.length*3);
    vertices.forEach((v,i)=>{for(let k=0;k<3;k++)array[i*3+k]=attribute.array[v*3+k];});
    cut.setAttribute(name,new THREE.BufferAttribute(array,3));
  }
  const candidates=splitGrootWood(cut),stocks:GrootWoodStock[]=[];
  for(const stock of candidates){
    const box=stock.geometry.boundingBox!;
    // A shallow cut-surface fragment can be six times wider than tall: never promote that
    // sliver into a giant blade. Keep the three detailed, upright bark clusters only.
    if(stock.sourceVertices.length>=250&&Math.max(box.max.x-box.min.x,box.max.z-box.min.z)<1.2)stocks.push(stock);
    else stock.geometry.dispose();
  }
  if(!stocks.length)throw new Error('Groot has no usable bark-rich shoulder spurs.');
  for(const stock of stocks){
    for(let i=0;i<stock.sourceVertices.length;i++)stock.sourceVertices[i]=vertices[stock.sourceVertices[i]];
    stock.geometry.name=stock.geometry.name.replace('crown','shoulder-spur');
  }
  cut.dispose();
  return stocks;
}

/** Separate connected source wood, not cylinders with a bark-looking material. Construction only. */
function splitGrootWood(source: THREE.BufferGeometry | null): GrootWoodStock[] {
  if (!source?.index) throw new Error('Groot effects require the character’s original branch stock.');
  const p = source.getAttribute('position'), indices = source.index.array;
  const parents = Array.from({ length: p.count }, (_, i) => i);
  const find = (i: number): number => parents[i] === i ? i : (parents[i] = find(parents[i]));
  for (let i = 0; i < indices.length; i += 3) {
    parents[find(indices[i + 1])] = find(indices[i]);
    parents[find(indices[i + 2])] = find(indices[i]);
  }
  // Imported normal/colour seams can duplicate a vertex without disconnecting the wood.
  const weld = new Map<string, number>();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(5)},${p.getY(i).toFixed(5)},${p.getZ(i).toFixed(5)}`;
    const other = weld.get(key);
    if (other !== undefined) parents[find(i)] = find(other);
    else weld.set(key, i);
  }
  const components = new Map<number, number[]>();
  for (let i = 0; i < p.count; i++) {
    const root = find(i), vertices = components.get(root) ?? [];
    vertices.push(i); components.set(root, vertices);
  }
  const stocks: GrootWoodStock[] = [];
  for (const vertices of components.values()) {
    if (vertices.length < 25) continue; // Discard the tiny cut-surface sliver, not a branch.
    const remap = new Map(vertices.map((v, i) => [v, i]));
    const faces: number[] = [];
    for (let i = 0; i < indices.length; i += 3) {
      if (remap.has(indices[i])) faces.push(remap.get(indices[i])!, remap.get(indices[i + 1])!, remap.get(indices[i + 2])!);
    }
    const geometry = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'color']) {
      const original = source.getAttribute(name), copy = new Float32Array(vertices.length * 3);
      vertices.forEach((v, i) => { for (let k = 0; k < 3; k++) copy[i * 3 + k] = original.array[v * 3 + k]; });
      geometry.setAttribute(name, new THREE.BufferAttribute(copy, 3));
    }
    geometry.setIndex(faces); geometry.computeBoundingBox();
    const box = geometry.boundingBox!, length = box.max.y - box.min.y;
    if(length<1e-6){geometry.dispose();continue;}
    let baseX = 0, baseZ = 0, baseCount = 0;
    for (const v of vertices) if (p.getY(v) < box.min.y + length * .08) {
      baseX += p.getX(v); baseZ += p.getZ(v); baseCount++;
    }
    geometry.translate(-baseX / baseCount, -box.min.y, -baseZ / baseCount);
    geometry.scale(1 / length, 1 / length, 1 / length);
    geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    geometry.name = `groot-original-crown-wood-${stocks.length}`;
    stocks.push({ geometry, sourceVertices: new Uint32Array(vertices) });
  }
  if (!stocks.length) throw new Error('No usable original Groot branches were found.');
  return stocks;
}
