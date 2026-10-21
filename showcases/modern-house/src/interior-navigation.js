import * as THREE from 'three';
import { validateRoomBounds } from './interior-manifest.js';

// The cutaway source camera sits outside the physical room, so eye movement
// cannot be limited to the room shell. The viewing enclosure is a separate,
// finite camera-safety volume; the physical roomBounds stay authoritative for
// geometry, shadows and the target (look-at) limits.
export const ENCLOSURE_MARGIN = 1.5;

const asVector = value => new THREE.Vector3().fromArray(value);

// Derive the finite volumes from the manifest itself:
//   eye    = a horizontal square wide enough to orbit the farthest authored
//            eye (source camera or any preset) around the room centre, spanning
//            the lowest to the highest authored eye/room height plus a margin;
//   target = the physical room plus every authored target.
// Nothing here widens or alters the physical room.
export function computeViewingEnclosure(manifest, margin = ENCLOSURE_MARGIN) {
  validateRoomBounds(manifest.roomBounds);
  if (!Number.isFinite(margin) || margin < 0) throw new RangeError('Viewing enclosure margin must be a non-negative number.');
  const room = new THREE.Box3(asVector(manifest.roomBounds.min), asVector(manifest.roomBounds.max));
  const poses = [['source', manifest.camera], ...Object.entries(manifest.views)];
  const eyes = poses.map(([, pose]) => asVector(pose.position));
  const targets = poses.map(([, pose]) => asVector(pose.target));
  const center = room.getCenter(new THREE.Vector3());
  const roomSize = room.getSize(new THREE.Vector3());
  let radius = Math.max(roomSize.x, roomSize.z) / 2;
  let farthestEye = 0;
  for (const eye of eyes) farthestEye = Math.max(farthestEye, Math.hypot(eye.x-center.x, eye.z-center.z));
  radius = Math.max(radius, farthestEye) + margin;
  const eye = new THREE.Box3(
    new THREE.Vector3(center.x-radius, Math.min(room.min.y, ...eyes.map(point => point.y)), center.z-radius),
    new THREE.Vector3(center.x+radius, Math.max(room.max.y, ...eyes.map(point => point.y)) + margin, center.z+radius),
  );
  const target = room.clone();
  for (const point of targets) target.expandByPoint(point);
  return { room, eye, target, margin,
    derivedFrom: { poses: poses.map(([name]) => name), farthestHorizontalEyeDistance: farthestEye } };
}

export function createInteriorNavigation(camera, controls, volumes) {
  const { room, eye: cameraBounds, target: targetBounds, margin, derivedFrom } = volumes;
  if (![room, cameraBounds, targetBounds].every(box => box?.isBox3 && !box.isEmpty())) throw new TypeError('Interior navigation needs room, eye and target boxes.');
  const previousCamera = new THREE.Vector3();
  const previousTarget = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const center = room.getCenter(new THREE.Vector3());
  const originalUpdate = controls.update;
  const originalLimits = { minDistance: controls.minDistance, maxDistance: controls.maxDistance,
    minPolarAngle: controls.minPolarAngle, maxPolarAngle: controls.maxPolarAngle };
  const roomSize = room.getSize(new THREE.Vector3());
  const enclosureSize = cameraBounds.getSize(new THREE.Vector3());
  let disposed = false;
  let atBoundary = false;

  controls.minDistance = Math.min(0.3, (Math.min(roomSize.x, roomSize.y, roomSize.z)-0.4)/2);
  controls.maxDistance = enclosureSize.length();
  controls.minPolarAngle = 0.02;
  controls.maxPolarAngle = Math.PI - 0.02;

  function constrain() {
    if (disposed) return false;
    previousCamera.copy(camera.position);
    previousTarget.copy(controls.target);
    cameraBounds.clampPoint(camera.position, camera.position);
    targetBounds.clampPoint(controls.target, controls.target);

    if (camera.position.distanceToSquared(controls.target) < controls.minDistance ** 2) {
      direction.subVectors(controls.target, camera.position);
      if (direction.lengthSq() > 1e-12) {
        direction.normalize();
        controls.target.copy(camera.position).addScaledVector(direction, controls.minDistance);
        targetBounds.clampPoint(controls.target, controls.target);
      }
      if (camera.position.distanceToSquared(controls.target) < controls.minDistance ** 2) {
        // Near floor/ceiling, a vertical ray may have no room. Aim horizontally
        // into the room instead of pushing the eye through the shell.
        direction.set(center.x-camera.position.x, 0, center.z-camera.position.z);
        if (direction.lengthSq() < 1e-12) direction.set(0, 0, -1);
        direction.normalize();
        controls.target.copy(camera.position).addScaledVector(direction, controls.minDistance);
        targetBounds.clampPoint(controls.target, controls.target);
      }
    }

    atBoundary = !camera.position.equals(previousCamera) || !controls.target.equals(previousTarget);
    if (atBoundary) camera.lookAt(controls.target);
    // OrbitControls r180 derives spherical coordinates from the actual eye and
    // target at the next update; its current change dispatch commits these final
    // transforms afterwards. Calling update here would reintroduce an escape.
    return atBoundary;
  }

  function updateWithinEnclosure(deltaTime) {
    atBoundary = false;
    const changed = originalUpdate.call(controls, deltaTime);
    const eventBoundary = atBoundary;
    // r180 can skip `change` for sub-EPS transforms. Clamp those too.
    const finalBoundary = constrain();
    atBoundary = eventBoundary || finalBoundary;
    return changed || atBoundary;
  }

  controls.update = updateWithinEnclosure;
  controls.addEventListener('change', constrain);
  constrain();
  return {
    constrain,
    snapshot() {
      const distance = camera.position.distanceTo(controls.target);
      const box = value => ({ min: value.min.toArray(), max: value.max.toArray(), size: value.getSize(new THREE.Vector3()).toArray() });
      return {
        // `min`/`max` keep their earlier meaning: the physical room, unchanged.
        bounds: { min: room.min.toArray(), max: room.max.toArray(),
          kind: 'viewing-enclosure', collision: false,
          physicalRoom: box(room), enclosure: { ...box(cameraBounds), margin }, target: box(targetBounds),
          derivedFrom: { ...derivedFrom, poses: [...derivedFrom.poses] } },
        camera: camera.position.toArray(), target: controls.target.toArray(),
        safety: {
          cameraInBounds: cameraBounds.containsPoint(camera.position),
          targetInBounds: targetBounds.containsPoint(controls.target),
          cameraInPhysicalRoom: room.containsPoint(camera.position),
          targetInPhysicalRoom: room.containsPoint(controls.target),
          distance,
          polarAngle: distance ? Math.acos(THREE.MathUtils.clamp((camera.position.y-controls.target.y)/distance, -1, 1)) : null,
          atBoundary,
          minDistance: controls.minDistance, maxDistance: controls.maxDistance,
        },
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      controls.removeEventListener('change', constrain);
      if (controls.update === updateWithinEnclosure) {
        controls.update = originalUpdate;
        Object.assign(controls, originalLimits);
      }
    },
  };
}
