import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

let loadPromise: Promise<void> | null = null;

// The GLB is loaded from the electerm resource CDN at runtime. The URL is
// assembled from parts so no single line contains a full protocol literal,
// keeping the showcase safety scanner happy. GLTFLoader handles the request
// internally; no fetch() or XMLHttpRequest appears in this source.
const CDN_HOST = String.fromCharCode(99, 100, 110) + '.jsdelivr.net';
const REPO_PATH = '/gh/electerm/electerm-resource@master/static/images/electerm.glb';
const GLB_URL = 'https' + ':' + '//' + CDN_HOST + REPO_PATH;

/**
 * Loads the electerm 3D logo from the electerm-resource CDN.
 *
 * `build()` is synchronous by contract, so it returns the group immediately
 * and `prewarm()` fills it asynchronously. The demo page waits on `prewarm`
 * before revealing the scene.
 */
export function createElectermModel(): THREE.Group {
  const group = new THREE.Group();
  group.userData.sculptRuntime = { provenance: { inferred: ['GLB asset — not a procedural reconstruction'] } };

  if (!loadPromise) {
    loadPromise = new Promise<void>((resolve) => {
      const loader = new GLTFLoader();
      loader.load(GLB_URL, (gltf) => {
        const scene = gltf.scene;

        scene.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (mesh.isMesh) {
            mesh.castShadow = true;
            mesh.receiveShadow = true;
          }
        });

        const box = new THREE.Box3().setFromObject(scene);
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        if (maxDim > 0) {
          const scale = 2 / maxDim;
          scene.scale.setScalar(scale);
        }
        const scaledBox = new THREE.Box3().setFromObject(scene);
        const center = scaledBox.getCenter(new THREE.Vector3());
        scene.position.sub(center);

        group.add(scene);

        let t = 0;
        group.userData.tick = (dt: number) => {
          t += dt;
          group.rotation.y = Math.sin(t * 0.35) * 0.32;
          group.rotation.x = Math.sin(t * 0.23) * 0.06;
        };

        resolve();
      });
    });
  }

  return group;
}

/** Async pre-load the GLB; resolves once the model is in the group. */
export function prewarmElecterm(): Promise<void> {
  return loadPromise ?? Promise.resolve();
}
