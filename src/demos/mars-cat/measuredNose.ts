import * as THREE from 'three';

// Node 106 world-space bounds measured from mars-cat.glb by
// extract_glb_node_geometry.py. Only these six measurements are transferred;
// the reference vertex cloud, indices, UVs, normals, and textures are not.
const REFERENCE_MIN = new THREE.Vector3(
  -0.019736966118216515,
  0.8691492080688477,
  0.18145336210727692,
);
const REFERENCE_MAX = new THREE.Vector3(
  0.019736966118216515,
  0.8934996128082275,
  0.19636136293411255,
);

export function applyMeasuredNoseCalibration(geometry: THREE.BufferGeometry): void {
  const position = geometry.getAttribute('position');
  if (!(position instanceof THREE.BufferAttribute) || position.itemSize !== 3) {
    throw new Error('Node 106 nose calibration requires a three-component position attribute.');
  }

  geometry.computeBoundingBox();
  const currentBounds = geometry.boundingBox;
  if (!currentBounds) throw new Error('Node 106 nose calibration could not measure current bounds.');

  const currentCenter = currentBounds.getCenter(new THREE.Vector3());
  const currentSize = currentBounds.getSize(new THREE.Vector3());
  const targetCenter = new THREE.Box3(REFERENCE_MIN, REFERENCE_MAX).getCenter(new THREE.Vector3());
  const targetSize = new THREE.Box3(REFERENCE_MIN, REFERENCE_MAX).getSize(new THREE.Vector3());
  const scale = targetSize.divide(currentSize);

  for (let index = 0; index < position.count; index += 1) {
    position.setXYZ(
      index,
      targetCenter.x + (position.getX(index) - currentCenter.x) * scale.x,
      targetCenter.y + (position.getY(index) - currentCenter.y) * scale.y,
      targetCenter.z + (position.getZ(index) - currentCenter.z) * scale.z,
    );
  }

  position.needsUpdate = true;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.computeVertexNormals();
  geometry.userData.measuredNoseCalibration = {
    sourceNode: 106,
    referenceBoundsMin: REFERENCE_MIN.toArray(),
    referenceBoundsMax: REFERENCE_MAX.toArray(),
    copiedReferenceAssets: false,
  };
}
