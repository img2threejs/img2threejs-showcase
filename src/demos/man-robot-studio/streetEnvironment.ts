import * as THREE from 'three/webgpu';
import { createStreetWorld } from './street-world.js';
import { createStreetProps } from './street-props.js';

/** Own only the procedural environment, never the native robot or its shared source texture. */
export function createRobotStreetEnvironment(scene: THREE.Scene): {
  update(time: number, camera: THREE.Camera, position: THREE.Vector3): void;
  dispose(): void;
} {
  const previous = {
    background: scene.background,
    environment: scene.environment,
    fog: scene.fog,
    backgroundIntensity: scene.backgroundIntensity,
    environmentIntensity: scene.environmentIntensity,
  };
  const existing = new Set(scene.children);
  const world = createStreetWorld(THREE, scene);
  const props = createStreetProps(THREE, scene);
  const roots = scene.children.filter((child) => !existing.has(child));
  const sky = scene.environment;
  let disposed = false;

  return {
    update(time, camera, position) {
      if (disposed) return;
      world.update(time, camera, position);
      props.update(time);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      const textures = new Set<THREE.Texture>();
      if (sky) textures.add(sky);
      for (const root of roots) {
        root.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (mesh.geometry) geometries.add(mesh.geometry);
          if (mesh.material) {
            const entries = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            for (const material of entries) materials.add(material);
          }
          const light = object as THREE.DirectionalLight;
          light.shadow?.dispose();
          const instanced = object as THREE.InstancedMesh;
          if (instanced.isInstancedMesh) instanced.dispose();
        });
        root.removeFromParent();
      }
      for (const material of materials) {
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture) textures.add(value);
        }
        material.dispose();
      }
      for (const geometry of geometries) geometry.dispose();
      for (const texture of textures) texture.dispose();
      scene.background = previous.background;
      scene.environment = previous.environment;
      scene.fog = previous.fog;
      scene.backgroundIntensity = previous.backgroundIntensity;
      scene.environmentIntensity = previous.environmentIntensity;
    },
  };
}
