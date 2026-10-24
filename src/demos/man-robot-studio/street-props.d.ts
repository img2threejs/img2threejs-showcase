import type * as THREE from 'three/webgpu';

export function createStreetProps(three: typeof THREE, scene: THREE.Scene): {
  update(time: number): void;
  group: THREE.Group;
  stats: { triangles: number; drawCalls: number; trees: number; cars: number; scooters: number; bicycles: number };
};
