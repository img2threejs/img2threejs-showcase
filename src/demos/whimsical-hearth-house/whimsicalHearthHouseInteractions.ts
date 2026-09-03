// Demo-layer interactions for the generated whimsical-hearth-house factory.
// The factory exposes the action-ready contract (root.userData.sculptRuntime
// nodes + per-component actionProfile); this module DRIVES that contract —
// click selection, reversible explode, door action, cozy idle, reset — and
// deliberately contains no geometry or material knowledge of its own.
import * as THREE from 'three';

type SculptRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
};

type NodeSnapshot = {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
};

export type HearthHouseInteractions = {
  /** 0 = assembled, 1 = fully exploded; any value in between is stable. */
  setExplode(t: number): void;
  openDoor(): void;
  closeDoor(): void;
  /** Advance the cozy idle (chimney-smoke bob) by dt seconds. */
  tickIdle(dt: number): void;
  /** Raycast pick: returns the semantic component id under the pointer, if any. */
  pick(normalizedX: number, normalizedY: number, camera: THREE.Camera): string | null;
  /** Restore every node transform exactly as built and close the door. */
  reset(): void;
};

const EXPLODE_DISTANCE = 0.6;
const DOOR_OPEN_ANGLE = -1.15;

export function attachHearthHouseInteractions(group: THREE.Group): HearthHouseInteractions {
  const runtime = group.userData.sculptRuntime as SculptRuntime | undefined;
  if (!runtime || !runtime.nodes) {
    throw new Error('factory group does not expose sculptRuntime; regenerate at interaction-pass');
  }
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
  const modelCenter = new THREE.Box3().setFromObject(group).getCenter(new THREE.Vector3());
  const explodeDirections = new Map<string, THREE.Vector3>();
  for (const [id, node] of Object.entries(nodes)) {
    if (id === 'root') continue;
    const world = node.getWorldPosition(new THREE.Vector3());
    const direction = world.sub(modelCenter);
    // ground-hugging parts push outward, not down through the floor
    direction.y = Math.max(direction.y, 0.15);
    if (direction.lengthSq() < 1e-8) direction.set(0, 1, 0);
    explodeDirections.set(id, direction.normalize());
  }

  let doorOpen = false;
  let idleTime = 0;
  const raycaster = new THREE.Raycaster();

  const doorNode = nodes['front-door'];
  const doorComponent = doorNode?.userData.sculptComponent as
    | { dimensions?: { width?: number } }
    | undefined;
  const doorHalfWidth = (doorComponent?.dimensions?.width ?? 1.2) / 2;

  const applyDoor = () => {
    if (!doorNode) return;
    const base = snapshots.get('front-door');
    if (!base) return;
    doorNode.quaternion.copy(base.quaternion);
    doorNode.position.copy(base.position);
    if (doorOpen) {
      // hinge on the door's left jamb: rotate the pivot about Y around an
      // offset axis by composing translate(hinge) * rotate * translate(-hinge)
      const hinge = new THREE.Vector3(-doorHalfWidth, 0, 0);
      const rotation = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        DOOR_OPEN_ANGLE,
      );
      doorNode.quaternion.multiply(rotation);
      const swing = hinge.clone().applyQuaternion(rotation).sub(hinge);
      doorNode.position.sub(swing);
    }
  };

  return {
    setExplode(t: number): void {
      const clamped = Math.min(1, Math.max(0, t));
      for (const [id, direction] of explodeDirections) {
        const node = nodes[id];
        const base = snapshots.get(id);
        if (!node || !base) continue;
        node.position
          .copy(base.position)
          .addScaledVector(direction, clamped * EXPLODE_DISTANCE);
      }
      applyDoor();
      group.updateMatrixWorld(true);
    },
    openDoor(): void {
      doorOpen = true;
      applyDoor();
    },
    closeDoor(): void {
      doorOpen = false;
      applyDoor();
    },
    tickIdle(dt: number): void {
      idleTime += dt;
      const smoke = nodes['chimney-smoke'];
      const base = snapshots.get('chimney-smoke');
      if (smoke && base) {
        smoke.position.y = base.position.y + Math.sin(idleTime * 1.6) * 0.12;
        const puff = 1 + Math.sin(idleTime * 1.6 + 0.8) * 0.05;
        smoke.scale.copy(base.scale).multiplyScalar(puff);
      }
    },
    pick(normalizedX: number, normalizedY: number, camera: THREE.Camera): string | null {
      raycaster.setFromCamera(new THREE.Vector2(normalizedX, normalizedY), camera);
      const hits = raycaster.intersectObject(group, true);
      for (const hit of hits) {
        let object: THREE.Object3D | null = hit.object;
        while (object) {
          const component = object.userData.sculptComponent as { id?: string } | undefined;
          if (component?.id) return component.id;
          object = object.parent;
        }
      }
      return null;
    },
    reset(): void {
      doorOpen = false;
      idleTime = 0;
      for (const [id, snapshot] of snapshots) {
        const node = nodes[id];
        if (!node) continue;
        node.position.copy(snapshot.position);
        node.quaternion.copy(snapshot.quaternion);
        node.scale.copy(snapshot.scale);
      }
      group.updateMatrixWorld(true);
    },
  };
}
