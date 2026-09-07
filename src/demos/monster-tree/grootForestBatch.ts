import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Construction-only batching. Preserve every vertex, material, shadow flag and tree-hit shader.
 * Spatial buckets keep distant parts of the old grove independently frustum-cullable. */
export function batchGrootForest(group:THREE.Group):void{
  const buckets=new Map<string,THREE.Mesh[]>(),centre=new THREE.Vector3();
  for(const child of group.children){
    if(!(child instanceof THREE.Mesh)||child instanceof THREE.InstancedMesh||Array.isArray(child.material))continue;
    child.updateMatrix();child.geometry.computeBoundingBox();child.geometry.boundingBox!.getCenter(centre).applyMatrix4(child.matrix);
    const key=`${child.material.uuid}:${child.castShadow}:${child.receiveShadow}:${Math.floor(centre.x/2)}:${Math.floor(centre.z/2)}`;
    const list=buckets.get(key);if(list)list.push(child);else buckets.set(key,[child]);
  }
  let before=0,after=0;
  const retired=new Set<THREE.BufferGeometry>();
  for(const meshes of buckets.values()){
    before+=meshes.length;after++;
    if(meshes.length<2)continue;
    const copies=meshes.map(mesh=>mesh.geometry.clone().applyMatrix4(mesh.matrix));
    const geometry=mergeGeometries(copies,false);for(const copy of copies)copy.dispose();
    if(!geometry){after+=meshes.length-1;continue;}
    const first=meshes[0],mesh=new THREE.Mesh(geometry,first.material);
    mesh.name='groot-batched-grove';mesh.castShadow=first.castShadow;mesh.receiveShadow=first.receiveShadow;
    mesh.updateMatrix();mesh.matrixAutoUpdate=false;geometry.computeBoundingSphere();group.add(mesh);
    for(const original of meshes){group.remove(original);retired.add(original.geometry);}
  }
  // A shared mushroom primitive may still belong to an unmerged singleton.
  for(const child of group.children)if(child instanceof THREE.Mesh)retired.delete(child.geometry);
  for(const geometry of retired)geometry.dispose();
  group.userData.batchStats={before,after};
}
