import * as THREE from 'three';

/** Fixed studio cards create moving specular bands as the phone or camera rotates. */
export function createMetalStudioEnvironment(): THREE.Scene {
  const studio = new THREE.Scene();
  studio.background = new THREE.Color(0.055, 0.055, 0.06);
  const card = (position: [number, number, number], width: number, height: number, intensity: number): void => {
    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(intensity, intensity, intensity), side: THREE.DoubleSide,
    });
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
    panel.position.set(...position);
    panel.lookAt(0, 0, 0);
    studio.add(panel);
  };
  // Keep narrow bright cards for moving edge highlights, with a much darker surround so the
  // metal retains contrast instead of reading as a uniformly white emissive strip.
  card([4, 5, 4], 2.4, 7, 3.2);
  card([5, 0, 0], 4.2, 7, 2.6);
  card([-5, -1, 0], 3, 6, 2.25);
  card([1, 5, -1], 7, 2, 2.2);
  card([-4, 5, -5], 2.4, 7, 3);
  card([3, -4, -2], 5, 1.5, 1.4);
  return studio;
}
