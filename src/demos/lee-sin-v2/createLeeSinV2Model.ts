import * as THREE from 'three';
import {
  CharacterSession,
  createLeeSinV2CharacterIR,
} from 'img2threejs-character';

/** Thin showcase adapter over the real img2threejs-character compiler/runtime. */
export type LeeSinV2Options = {
  castShadow?: boolean;
  receiveShadow?: boolean;
  animate?: boolean;
  poseProfile?: string;
};

export interface LeeSinV2CaptureProfile {
  position: [number, number, number];
  target: [number, number, number];
  projection: 'orthographic';
  orthographicHalfHeight: number;
  poseProfileId: string;
}

const DISPLAY_SCALE = 5;

function triangleCount(root: THREE.Object3D): number {
  let count = 0;
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry;
    count += geometry.index
      ? geometry.index.count / 3
      : geometry.getAttribute('position').count / 3;
  });
  return Math.round(count);
}

export function createLeeSinV2Model(options: LeeSinV2Options = {}): THREE.Group {
  const { castShadow = true, receiveShadow = true, animate = true, poseProfile = 'turnaround-a-pose' } = options;
  const ir = createLeeSinV2CharacterIR({ profile: 'standard' });
  const session = new CharacterSession(ir);
  const compiled = session.compile({ backend: 'webgl' });
  const report = session.conformance();

  if (compiled.diagnostics.errors.length > 0) {
    throw new Error(`Lee Sin v2 character compilation failed: ${compiled.diagnostics.errors.join('; ')}`);
  }
  if (report.failedGateIds.length > 0) {
    throw new Error(`Lee Sin v2 character conformance failed: ${report.failedGateIds.join(', ')}`);
  }

  const root = compiled.root;
  root.name = 'lee-sin-v2';
  root.scale.setScalar(DISPLAY_SCALE);
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
  });

  // Preserve the plugin-owned CharacterRuntime already installed at sculptRuntime.
  root.userData.characterPlugin = {
    package: 'img2threejs-character',
    characterIR: ir,
    conformance: report,
    diagnostics: compiled.diagnostics,
    bodyMeshes: compiled.bodyMeshes,
    accessories: compiled.accessories.items,
    skeleton: compiled.skeleton.skeleton,
    visualEvidenceArtifact: 'artifacts/lee-sin-v2/visual-gate.json',
  };
  root.userData.triangleCount = triangleCount(root);
  if (animate) root.userData.tick = (dt: number): void => compiled.runtime.update(dt);
  compiled.runtime.pose.applyProfile(poseProfile);
  compiled.runtime.update(0);
  return root;
}

export function createLeeSinV2CaptureProfiles(): Record<string, LeeSinV2CaptureProfile> {
  const ir = createLeeSinV2CharacterIR({ profile: 'standard' });
  return Object.fromEntries(ir.evidence.captureProfiles.map((profile) => {
    const camera = profile.camera;
    if (camera.projection !== 'orthographic' || !camera.position || !camera.target || camera.orthographicHalfHeight === undefined) {
      throw new Error(`Lee Sin v2 capture profile ${profile.id} is not a complete orthographic camera`);
    }
    return [profile.id, {
      position: camera.position.map((value) => value * DISPLAY_SCALE) as [number, number, number],
      target: camera.target.map((value) => value * DISPLAY_SCALE) as [number, number, number],
      projection: 'orthographic' as const,
      orthographicHalfHeight: camera.orthographicHalfHeight * DISPLAY_SCALE,
      poseProfileId: profile.poseProfileId,
    }];
  }));
}

export function createLeeSinV2LookDevLights(): THREE.Group {
  const lights = new THREE.Group();
  lights.name = 'lee-sin-v2-look-dev-lights';
  lights.add(new THREE.HemisphereLight(0xffffff, 0x6d625b, 1.2));

  const key = new THREE.DirectionalLight(0xfff0dc, 1.5);
  key.position.set(6, 9, 8);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);

  const fill = new THREE.DirectionalLight(0xaec7e8, 0.8);
  fill.position.set(-7, 5, 5);

  const rim = new THREE.DirectionalLight(0xffffff, 0.65);
  rim.position.set(-6, 7, -9);
  lights.add(key, fill, rim);
  return lights;
}
