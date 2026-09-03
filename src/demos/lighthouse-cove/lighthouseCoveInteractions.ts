// Demo-layer interactions for the generated lighthouse-cove factory, driving
// the action-ready contract exposed in root.userData.sculptRuntime.
import * as THREE from 'three';

type SculptRuntime = { nodes: Record<string, THREE.Object3D> };
type NodeSnapshot = { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 };

export type LighthouseCoveInteractions = {
  setExplode(t: number): void;
  openDoor(): void;
  closeDoor(): void;
  /** Cove idle: gulls bob, the lantern room breathes its glow. */
  tickIdle(dt: number): void;
  pick(nx: number, ny: number, camera: THREE.Camera): string | null;
  reset(): void;
};

const EXPLODE_DISTANCE = 0.55;
const DOOR_OPEN_ANGLE = -1.1;

export function attachLighthouseCoveInteractions(group: THREE.Group): LighthouseCoveInteractions {
  const runtime = group.userData.sculptRuntime as SculptRuntime | undefined;
  if (!runtime?.nodes) throw new Error('factory group does not expose sculptRuntime');
  const nodes = runtime.nodes;

  const snapshots = new Map<string, NodeSnapshot>();
  for (const [id, node] of Object.entries(nodes)) {
    snapshots.set(id, {
      position: node.position.clone(),
      quaternion: node.quaternion.clone(),
      scale: node.scale.clone(),
    });
  }
  group.updateMatrixWorld(true);
  const center = new THREE.Box3().setFromObject(group).getCenter(new THREE.Vector3());
  const directions = new Map<string, THREE.Vector3>();
  for (const [id, node] of Object.entries(nodes)) {
    if (id === 'root') continue;
    const direction = node.getWorldPosition(new THREE.Vector3()).sub(center);
    direction.y = Math.max(direction.y, 0.12);
    if (direction.lengthSq() < 1e-8) direction.set(0, 1, 0);
    directions.set(id, direction.normalize());
  }

  let doorOpen = false;
  let idleTime = 0;
  const raycaster = new THREE.Raycaster();
  const doorNode = nodes['cottage-door'];
  const doorHalfWidth =
    ((doorNode?.userData.sculptComponent as { dimensions?: { width?: number } } | undefined)
      ?.dimensions?.width ?? 0.72) / 2;

  const lanternEmissives: THREE.MeshPhysicalMaterial[] = [];
  nodes['lantern-room']?.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if ((mesh as { isMesh?: boolean }).isMesh) {
      const material = mesh.material as THREE.MeshPhysicalMaterial;
      if (material?.emissive) lanternEmissives.push(material);
    }
  });
  const baseEmissive = lanternEmissives.map((m) => m.emissiveIntensity);

  const applyDoor = () => {
    if (!doorNode) return;
    const base = snapshots.get('cottage-door');
    if (!base) return;
    doorNode.quaternion.copy(base.quaternion);
    doorNode.position.copy(base.position);
    if (doorOpen) {
      const hinge = new THREE.Vector3(-doorHalfWidth, 0, 0);
      const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), DOOR_OPEN_ANGLE);
      doorNode.quaternion.multiply(rotation);
      doorNode.position.sub(hinge.clone().applyQuaternion(rotation).sub(hinge));
    }
  };

  return {
    setExplode(t) {
      const clamped = Math.min(1, Math.max(0, t));
      for (const [id, direction] of directions) {
        const node = nodes[id];
        const base = snapshots.get(id);
        if (!node || !base) continue;
        node.position.copy(base.position).addScaledVector(direction, clamped * EXPLODE_DISTANCE);
      }
      applyDoor();
      group.updateMatrixWorld(true);
    },
    openDoor() { doorOpen = true; applyDoor(); },
    closeDoor() { doorOpen = false; applyDoor(); },
    tickIdle(dt) {
      idleTime += dt;
      for (const gullId of ['gull-left', 'gull-front']) {
        const gull = nodes[gullId];
        const base = snapshots.get(gullId);
        if (gull && base) gull.position.y = base.position.y + Math.abs(Math.sin(idleTime * 2.2 + (gullId === 'gull-left' ? 0 : 1.4))) * 0.08;
      }
      lanternEmissives.forEach((material, index) => {
        material.emissiveIntensity = baseEmissive[index] * (1 + Math.sin(idleTime * 1.1) * 0.18);
      });
    },
    pick(nx, ny, camera) {
      raycaster.setFromCamera(new THREE.Vector2(nx, ny), camera);
      for (const hit of raycaster.intersectObject(group, true)) {
        let object: THREE.Object3D | null = hit.object;
        while (object) {
          const component = object.userData.sculptComponent as { id?: string } | undefined;
          if (component?.id) return component.id;
          object = object.parent;
        }
      }
      return null;
    },
    reset() {
      doorOpen = false;
      idleTime = 0;
      for (const [id, snapshot] of snapshots) {
        const node = nodes[id];
        if (!node) continue;
        node.position.copy(snapshot.position);
        node.quaternion.copy(snapshot.quaternion);
        node.scale.copy(snapshot.scale);
      }
      lanternEmissives.forEach((material, index) => { material.emissiveIntensity = baseEmissive[index]; });
      group.updateMatrixWorld(true);
    },
  };
}
