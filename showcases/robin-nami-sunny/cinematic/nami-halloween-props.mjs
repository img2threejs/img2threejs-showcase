import * as THREE from 'three';

// Procedural witch hat for Nami's Halloween colorway. It is sized from her hair's rest bounds and
// parented to the Head bone, so it follows her head through every animation. Pure geometry: no
// image assets, nothing is added to or changed in her GLB.
function feltTexture() {
  const size = 128, canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d'), image = context.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    // Soft felt grain: low-contrast noise around mid grey, tinted by the material colour.
    const n = 205 + Math.floor(Math.random() * 50) - Math.floor(Math.random() * 26);
    image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = n; image.data[i * 4 + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.repeat.set(3, 3); texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Returns { object, dispose }; `object` is already attached to `headBone` at its rest pose. */
export function attachWitchHat({ entity, headBone, hair }) {
  entity.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(hair), size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  const brim = Math.max(size.x, size.z) * 0.74, crownRadius = Math.max(size.x, size.z) * 0.36, height = brim * 1.55;
  // Lathe profile: brim disc -> crown cone with a gentle S-curve; tip bent by moving vertices afterwards.
  const profile = [
    [0.02, 0], [brim * 0.7, -0.004], [brim, 0.012], [brim * 1.01, 0.02],
    [crownRadius * 1.25, 0.03], [crownRadius * 1.05, height * 0.12], [crownRadius * 0.82, height * 0.4], [crownRadius * 0.5, height * 0.68], [crownRadius * 0.2, height * 0.9], [0.004, height],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const geometry = new THREE.LatheGeometry(profile, 48);
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i++) {
    const t = Math.max(0, position.getY(i) / height - 0.3) / 0.7;
    position.setZ(i, position.getZ(i) - t * t * height * 0.34); // tip folds backwards
    position.setY(i, position.getY(i) - t * t * height * 0.08);
  }
  geometry.computeVertexNormals();
  const felt = feltTexture();
  const hatMaterial = new THREE.MeshStandardMaterial({ color: 0x24123d, roughness: 0.9, metalness: 0, map: felt, side: THREE.DoubleSide });
  const bandMaterial = new THREE.MeshStandardMaterial({ color: 0xe8741c, roughness: 0.6, metalness: 0 });
  const buckleMaterial = new THREE.MeshStandardMaterial({ color: 0xd9a826, roughness: 0.35, metalness: 0.85 });
  const hat = new THREE.Group();
  hat.name = 'Nami witch hat';
  const body = new THREE.Mesh(geometry, hatMaterial);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(crownRadius * 1.2, crownRadius * 1.3, height * 0.1, 40, 1, true), bandMaterial);
  band.position.y = height * 0.09; band.material.side = THREE.DoubleSide;
  const buckle = new THREE.Mesh(new THREE.BoxGeometry(crownRadius * 0.55, height * 0.12, 0.012), buckleMaterial);
  buckle.position.set(0, height * 0.09, crownRadius * 1.3);
  hat.add(body, band, buckle);
  for (const mesh of [body, band, buckle]) { mesh.castShadow = true; mesh.receiveShadow = true; }
  // Sit on the crown of the hair, slightly tilted back like a stage witch.
  hat.position.set(center.x, box.max.y - size.y * 0.1, center.z - size.z * 0.02);
  hat.rotation.x = -0.12;
  hat.updateMatrixWorld(true);
  headBone.attach(hat);
  return {
    object: hat,
    dispose() {
      hat.removeFromParent();
      for (const resource of [geometry, band.geometry, buckle.geometry, hatMaterial, bandMaterial, buckleMaterial, felt]) resource.dispose();
    },
  };
}
