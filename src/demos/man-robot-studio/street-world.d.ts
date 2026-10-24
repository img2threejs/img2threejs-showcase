import type * as THREE from 'three/webgpu';

/** Seeded, asset-free street geometry and lighting shared with the cinematic director. */
export function createStreetWorld(three: typeof THREE, scene: THREE.Scene): {
  update(time: number, camera: THREE.Camera | null, position: { x: number; z: number }): void;
};
