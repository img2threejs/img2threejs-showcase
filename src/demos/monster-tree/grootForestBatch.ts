import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Construction-only batching. Preserve every vertex, material, shadow flag and tree-hit shader.
 * Spatial buckets keep distant parts of the old grove independently frustum-cullable. */
export function batchGrootForest(group:THREE.Group):void{
  const buckets=new Map<string,THREE.Mesh[]>(),centre=new THREE.Vector3();
  for(const child of group.children){
    if(!(child instanceof THREE.Mesh)||child instanceof THREE.InstancedMesh||Array.isArray(child.material))continue;
    child.updateMatrix();child.geometry.computeBoundingBox();child.geometry.boundingBox!.getCenter(centre).applyMatrix4(child.matrix);
    const key=`${child.material.uuid}:${child.castShadow}:${child.receiveShadow}:${Math.floor(centre.x/3)}:${Math.floor(centre.z/3)}`;
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

/** Detach finite authored sources; only slot-owned clones can enter a render pass. */
export function ownGrootGrove(group:THREE.Group,templates:Map<string,THREE.Mesh[]>,fade:(material:THREE.Material)=>void):void {
  const matrix=new THREE.Matrix4(),centre=new THREE.Vector3(),colour=new THREE.Color();
  const store=(key:string,mesh:THREE.Mesh)=>{const list=templates.get(key)??[];list.push(mesh);templates.set(key,list);for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material])fade(material);};
  for(const child of [...group.children]){
    if(!(child instanceof THREE.Mesh))continue;
    child.updateMatrix();group.remove(child);
    if(child instanceof THREE.InstancedMesh){
      const buckets=new Map<string,number[]>();
      for(let i=0;i<child.count;i++){child.getMatrixAt(i,matrix);centre.setFromMatrixPosition(matrix).applyMatrix4(child.matrix);const key=`${Math.floor(centre.x/3)}:${Math.floor(centre.z/3)}`,list=buckets.get(key)??[];list.push(i);buckets.set(key,list);}
      for(const [key,list] of buckets){
        const mesh=new THREE.InstancedMesh(child.geometry,child.material,list.length);mesh.name=child.name||'authored-grove-instances';mesh.castShadow=child.castShadow;mesh.receiveShadow=child.receiveShadow;
        for(let j=0;j<list.length;j++){child.getMatrixAt(list[j],matrix);matrix.premultiply(child.matrix);mesh.setMatrixAt(j,matrix);if(child.instanceColor){child.getColorAt(list[j],colour);mesh.setColorAt(j,colour);}}
        store(key,mesh);
      }
      child.dispose();
    }else{
      child.geometry.computeBoundingBox();child.geometry.boundingBox!.getCenter(centre).applyMatrix4(child.matrix);
      // Mesh culling includes tree reactions and authored source extensions.
      child.geometry.computeBoundingSphere();child.geometry.boundingSphere!.radius+=.7;
      store(`${Math.floor(centre.x/3)}:${Math.floor(centre.z/3)}`,child);
    }
  }
}
