import * as THREE from 'three';
import type { Viewer } from '../../scene';
import type { OceanPlane } from './ocean';
import type { CampfireVfx } from './campfire';

/**
 * Click/tap drops a boulder into clear, deep water; drag anywhere is native OrbitControls;
 * R repeats at the last eligible sea point. The campfire keeps its
 * retained-hit relight rule, and pinch-zoom stays in OrbitControls' hands. No
 * rotation/turntable state is touched.
 */
export function mountWaterInteraction(
  viewer: Viewer,
  root: THREE.Group,
  ocean: OceanPlane,
  fireVfx: CampfireVfx,
  dropRock: (x: number, z: number) => void,
  canDrop: (x: number, z: number) => boolean,
): () => void {
  const canvas = viewer.renderer.domElement;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const seaPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -ocean.mesh.position.y);
  const point = new THREE.Vector3();
  const surface = new THREE.Vector3();
  const lastSea = new THREE.Vector3(8, ocean.mesh.position.y, 1);
  const solids: THREE.Object3D[] = [];
  const hits: THREE.Intersection[] = [];
  const touches = new Set<number>();
  let bounds = canvas.getBoundingClientRect();
  let pendingPointer: number | null = null;
  let downX = 0, downY = 0;
  let fireTap = false, firePointer = -1;
  const previousLabel = canvas.getAttribute('aria-label');
  const previousTabIndex = canvas.getAttribute('tabindex');
  const previousTitle = canvas.title;
  const previousCursor = canvas.style.cursor;
  canvas.tabIndex = 0;
  canvas.setAttribute(
    'aria-label',
    'Tropical island. Click or tap clear, deep water to drop a rock vertically. Shallows and areas near solid objects are excluded. Drag to orbit the island. Pinch to zoom. Click the campfire to relight it. Press R to repeat at the last eligible sea point once it is clear.',
  );
  canvas.title = 'Click/tap clear deep water: drop a rock · Avoid shallows and solid objects · Drag: orbit · Pinch: zoom · Click campfire: relight · R: repeat once clear';

  const updateBounds = (): void => { bounds = canvas.getBoundingClientRect(); };
  const observer = new ResizeObserver(updateBounds);
  observer.observe(canvas);
  window.addEventListener('resize', updateBounds);

  const collectSolid = (object: THREE.Object3D): void => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || mesh.userData.isHighlight || mesh.userData.isRuntimeEffect
      || mesh.name === 'Shoreline foam ring') return;
    for (let parent: THREE.Object3D | null = mesh; parent; parent = parent.parent) {
      if (!parent.visible) return;
    }
    solids.push(mesh);
  };

  const findVisibleCampfireAncestor = (object: THREE.Object3D): THREE.Object3D | null => {
    let cursor: THREE.Object3D | null = object;
    while (cursor) {
      if (cursor.name === 'Campfire') {
        let chain: THREE.Object3D | null = cursor;
        while (chain) {
          if (!chain.visible) return null;
          chain = chain.parent;
        }
        return cursor;
      }
      cursor = cursor.parent;
    }
    return null;
  };

  const fireHitAt = (event: PointerEvent): boolean => {
    pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1,
      -(event.clientY - bounds.top) / bounds.height * 2 + 1);
    raycaster.setFromCamera(pointer, viewer.camera);
    solids.length = 0;
    root.traverse(collectSolid);
    hits.length = 0;
    raycaster.intersectObjects(solids, false, hits);
    if (!hits.length) return false;
    const hit = hits[0]!;
    return findVisibleCampfireAncestor(hit.object) !== null;
  };

  /** Pick unoccluded displaced water and remember only a valid visible sea point. */
  const seaAt = (event: PointerEvent, checkProps: boolean): boolean => {
    pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1,
      -(event.clientY - bounds.top) / bounds.height * 2 + 1);
    raycaster.setFromCamera(pointer, viewer.camera);
    if (!raycaster.ray.intersectPlane(seaPlane, point)) return false;
    let distance = point.distanceTo(raycaster.ray.origin);
    for (let i = 0; i < 3; i += 1) {
      ocean.sampleSurface(point.x, point.z, surface);
      const derivative = raycaster.ray.direction.y - surface.y * raycaster.ray.direction.x
        - surface.z * raycaster.ray.direction.z;
      if (Math.abs(derivative) < 0.001) break;
      distance -= (point.y - ocean.mesh.position.y - surface.x) / derivative;
      if (distance <= 0) return false;
      raycaster.ray.at(distance, point);
    }
    if (!ocean.isWater(point.x, point.z) || !canDrop(point.x, point.z)) return false;
    if (checkProps) {
      solids.length = 0;
      root.traverse(collectSolid);
      hits.length = 0;
      raycaster.intersectObjects(solids, false, hits);
      if (hits.length && hits[0]!.distance < distance - 0.02) return false;
    }
    lastSea.copy(point);
    return true;
  };

  const abortPending = (): void => {
    pendingPointer = null;
    fireTap = false;
  };

  const onDown = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') {
      touches.add(event.pointerId);
      if (touches.size > 1) {
        abortPending();
        return;
      }
    }
    if (pendingPointer !== null || event.button !== 0 || !viewer.controls.enabled) return;
    updateBounds();
    if (fireHitAt(event)) {
      downX = event.clientX;
      downY = event.clientY;
      fireTap = true;
      firePointer = event.pointerId;
      return;
    }
    fireTap = false;
    if (!seaAt(event, true)) return;
    pendingPointer = event.pointerId;
    downX = event.clientX;
    downY = event.clientY;
  };

  const onMove = (event: PointerEvent): void => {
    if (event.pointerType === 'touch' && touches.size > 1) {
      abortPending();
    }
    if (fireTap && event.pointerId === firePointer) {
      if (Math.hypot(event.clientX - downX, event.clientY - downY) > 6) {
        fireTap = false;
      }
    }
    if (pendingPointer === event.pointerId) {
      // Drag takes it back to OrbitControls; no rock drop.
      if (Math.hypot(event.clientX - downX, event.clientY - downY) > 6) {
        pendingPointer = null;
        canvas.style.cursor = '';
      }
    }
  };

  const onHover = (event: PointerEvent): void => {
    if (event.buttons || event.pointerType === 'touch' || pendingPointer !== null) return;
    canvas.style.cursor = seaAt(event, true) ? 'crosshair' : '';
  };

  const onUp = (event: PointerEvent): void => {
    touches.delete(event.pointerId);
    if (fireTap && event.pointerId === firePointer && event.button === 0 && touches.size <= 1
      && Math.hypot(event.clientX - downX, event.clientY - downY) <= 6) {
      if (!fireVfx.lit && fireHitAt(event)) fireVfx.relight();
      fireTap = false;
    } else if (fireTap && event.pointerId === firePointer) {
      fireTap = false;
    }
    if (event.pointerId !== pendingPointer) return;
    const travelled = Math.hypot(event.clientX - downX, event.clientY - downY);
    // Strict release validation: primary button, controls still enabled, travel
    // distance within 6px, and a clean re-pick on release confirms the pointer
    // still lands on unoccluded real water. Native drag never drops.
    if (event.button === 0 && viewer.controls.enabled && travelled <= 6
      && seaAt(event, true)) {
      dropRock(point.x, point.z);
    }
    pendingPointer = null;
    // Drag cancel: reset inline cursor once so OrbitControls' grab CSS owns
    // the pointer again.
    canvas.style.cursor = '';
  };

  const onCancel = (event: PointerEvent): void => {
    touches.delete(event.pointerId);
    if (fireTap && event.pointerId === firePointer) fireTap = false;
    if (event.pointerId === pendingPointer) {
      pendingPointer = null;
      canvas.style.cursor = '';
    }
  };

  const onBlur = (): void => {
    touches.clear();
    abortPending();
  };

  const onKey = (event: KeyboardEvent): void => {
    if (event.code !== 'KeyR') return;
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    // Shift has no behavioural effect — R always uses its own single-shot drop.
    event.preventDefault();
    dropRock(lastSea.x, lastSea.z);
  };

  canvas.addEventListener('pointerdown', onDown, true);
  canvas.addEventListener('pointermove', onMove, { capture: true, passive: false });
  canvas.addEventListener('pointermove', onHover);
  canvas.addEventListener('pointerup', onUp, true);
  canvas.addEventListener('pointercancel', onCancel, true);
  canvas.addEventListener('lostpointercapture', onCancel);
  canvas.addEventListener('keydown', onKey);
  window.addEventListener('blur', onBlur);
  return (): void => {
    touches.clear();
    abortPending();
    observer.disconnect();
    window.removeEventListener('resize', updateBounds);
    window.removeEventListener('blur', onBlur);
    canvas.removeEventListener('pointerdown', onDown, true);
    canvas.removeEventListener('pointermove', onMove, true);
    canvas.removeEventListener('pointermove', onHover);
    canvas.removeEventListener('pointerup', onUp, true);
    canvas.removeEventListener('pointercancel', onCancel, true);
    canvas.removeEventListener('lostpointercapture', onCancel);
    canvas.removeEventListener('keydown', onKey);
    if (previousLabel === null) canvas.removeAttribute('aria-label');
    else canvas.setAttribute('aria-label', previousLabel);
    if (previousTabIndex === null) canvas.removeAttribute('tabindex');
    else canvas.setAttribute('tabindex', previousTabIndex);
    canvas.title = previousTitle;
    canvas.style.cursor = previousCursor;
  };
}