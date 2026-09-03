import * as THREE from 'three';

export const MARS_CAT_RENDER_CONTRACT = {
  target: [-1.4901161193847656e-7, 0.5757730114273727, -0.08574904501438141] as const,
  radius: 3.1026108186425119,
  fovDegrees: 25,
  near: 0.1,
  far: 100,
  exposure: 1,
  environmentIntensity: 0.85,
  background: 0x0f0f0f,
} as const;

export function createMarsCatLookDevLights(): THREE.Group {
  const lights = new THREE.Group();
  const key = new THREE.DirectionalLight(0xfff5ee, 4);
  key.position.set(3, 5, 4);
  const fill = new THREE.DirectionalLight(0x8fcfff, 1.7);
  fill.position.set(-4, 2, 3);
  const rim = new THREE.DirectionalLight(0xff7aaa, 2.2);
  rim.position.set(-3, 3, -4);
  lights.add(new THREE.HemisphereLight(0xd8ebff, 0x24151d, 1.5), key, fill, rim);
  return lights;
}
