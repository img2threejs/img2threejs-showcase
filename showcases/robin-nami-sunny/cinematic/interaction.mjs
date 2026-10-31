import * as THREE from 'three';
import { createPicker } from '../picking.mjs';
import { regionLabel } from './labels.mjs';

// Same posed-triangle, soft-rig and connected-garment interaction as the studio, one instance per
// character. Two characters share one canvas: each instance only grabs when its own surface is
// the nearest hit, i.e. when `occluded` (the other character's picker) is not in front of it.
export function createInteraction({ canvas, camera, controls, root, meshes, rig, garments, pointerEvents, enabled, onStatus, onRegion, occluded, owner = 'Character', initialMode = 'squeeze' }) {
  const picker = createPicker(meshes, rig.meshes);
  const contacts = new Map(), listeners = new AbortController();
  const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
  const planePoint = new THREE.Vector3(), planeNormal = new THREE.Vector3();
  let mode = initialMode, disposed = false;
  function log(event, type, id) {
    pointerEvents.push({ owner, type, id, pointerId: event.pointerId, pointerType: event.pointerType,
      trusted: event.isTrusted, clientX: event.clientX, clientY: event.clientY, time: performance.now() });
    if (pointerEvents.length > 256) pointerEvents.shift();
  }
  function ray(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    pointer.set((clientX - rect.left) / rect.width * 2 - 1, -(clientY - rect.top) / rect.height * 2 + 1);
    camera.updateMatrixWorld(true); raycaster.setFromCamera(pointer, camera);
    return raycaster.ray;
  }
  function cast(clientX, clientY) {
    root.updateMatrixWorld(true); ray(clientX, clientY);
    const hit = picker.cast(raycaster);
    return hit && occluded(raycaster, hit.distance) ? null : hit;
  }
  function strapNear(event, hit) {
    const side = garments.strapSide(hit);
    if (side) return { hit, side };
    if (hit && rig.pick(hit)) return null;
    const radii = event.pointerType === 'touch' ? [5, 10, 15] : [4, 8];
    for (const radius of radii) for (let k = 0; k < 8; k++) {
      const angle = k * Math.PI / 4;
      const near = cast(event.clientX + Math.cos(angle) * radius, event.clientY + Math.sin(angle) * radius);
      const nearSide = garments.strapSide(near);
      if (nearSide) return { hit: near, side: nearSide };
    }
    return null;
  }
  function down(event) {
    if (disposed || !enabled() || garments.transitioning || (event.button !== 0 && event.pointerType !== 'touch')) return;
    const hit = cast(event.clientX, event.clientY), strapHit = strapNear(event, hit);
    let contact;
    camera.getWorldDirection(planeNormal);
    if (strapHit) {
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, strapHit.hit.point);
      const anchor = ray(event.clientX, event.clientY).intersectPlane(plane, planePoint) ?? strapHit.hit.point;
      if (!garments.grabStrap(strapHit.hit, strapHit.side, anchor)) return;
      contact = { strap: strapHit.side, id: 'strap', plane };
    } else if (mode === 'fabric') {
      const panel = garments.panelSide(hit);
      if (!panel || !garments.grabPanel(hit, panel)) return;
      contact = { panel, id: 'fabric', plane: new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, hit.point) };
    } else {
      const id = hit && rig.pick(hit);
      if (!id) return;
      const token = rig.grab(hit, event.pointerId, { mode });
      if (!token) return;
      contact = { token, id, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, hit.point) };
      onRegion(id);
    }
    event.preventDefault(); event.stopImmediatePropagation();
    contacts.set(event.pointerId, contact); controls.enabled = false;
    canvas.setPointerCapture(event.pointerId); canvas.style.cursor = 'grabbing';
    onStatus(`${owner} · ${contact.strap ? 'Pulling the top strap' : contact.panel ? 'Pulling the top fabric' : `${mode === 'squeeze' ? 'Squeezing' : 'Pulling'} · ${regionLabel(contact.id)}`}`);
    log(event, 'grab', contact.id);
  }
  function move(event) {
    const contact = contacts.get(event.pointerId);
    if (!contact) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (ray(event.clientX, event.clientY).intersectPlane(contact.plane, planePoint)) {
      if (contact.strap) garments.dragStrap(contact.strap, planePoint);
      else if (contact.panel) garments.dragPanel(contact.panel, planePoint);
      else rig.drag(contact.token, planePoint);
    }
    log(event, 'drag', contact.id);
  }
  function up(event) {
    const contact = contacts.get(event.pointerId);
    if (!contact) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (contact.strap) garments.releaseStrap(contact.strap);
    else if (contact.panel) garments.releasePanel(contact.panel);
    else rig.release(contact.token);
    contacts.delete(event.pointerId);
    log(event, event.type === 'pointercancel' ? 'cancel' : event.type === 'lostpointercapture' ? 'lost-capture' : 'release', contact.id);
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    controls.enabled = contacts.size === 0;
    if (!contacts.size) canvas.style.cursor = '';
    onStatus(`${owner} · Released · watch the elastic recovery`);
  }
  function releaseAll() {
    rig.releaseAll(); garments.releaseAll();
    const ids = [...contacts.keys()]; contacts.clear();
    for (const id of ids) if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    controls.enabled = true; canvas.style.cursor = '';
  }
  function visibility() { if (document.hidden) releaseAll(); }
  const options = { capture: true, signal: listeners.signal };
  canvas.addEventListener('pointerdown', down, options); canvas.addEventListener('pointermove', move, options);
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(type, up, options);
  window.addEventListener('blur', releaseAll, { signal: listeners.signal });
  document.addEventListener('visibilitychange', visibility, { signal: listeners.signal });
  function locate(id) {
    if (disposed || !rig.regions.has(id)) return null;
    // Project actual current triangles, then require the first visible body/cloth
    // hit to resolve to the requested mask. Never manufacture pointer events.
    const candidates = [], p = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    root.updateMatrixWorld(true); camera.updateMatrixWorld(true);
    for (const entry of rig.meshes.values()) {
      const mask = entry.masks.get(id); if (!mask) continue;
      for (let i = 0; i < entry.indices.length; i += 3) {
        const ia = entry.indices[i], ib = entry.indices[i + 1], ic = entry.indices[i + 2];
        const weight = (mask[ia] + mask[ib] + mask[ic]) / 3; if (weight < .04) continue;
        entry.mesh.getVertexPosition(ia, a); entry.mesh.getVertexPosition(ib, b); entry.mesh.getVertexPosition(ic, c);
        p.copy(a).add(b).add(c).multiplyScalar(1 / 3).applyMatrix4(entry.mesh.matrixWorld).project(camera);
        if (Math.abs(p.x) > .96 || Math.abs(p.y) > .96 || p.z < -1 || p.z > 1) continue;
        candidates.push({ x: p.x, y: p.y, weight });
      }
    }
    candidates.sort((a, b) => b.weight - a.weight);
    const rect = canvas.getBoundingClientRect();
    for (const candidate of candidates.slice(0, 500)) {
      const x = rect.left + (candidate.x + 1) * .5 * rect.width, y = rect.top + (1 - candidate.y) * .5 * rect.height;
      const hit = cast(x, y);
      if (hit && rig.pick(hit) === id) return { x, y, mesh: hit.object.name, weight: candidate.weight, id };
    }
    return null;
  }
  function locateGarment(kind, side = 1) {
    if (disposed || garments.transitioning) return null;
    if (!['panel', 'strap'].includes(kind) || ![1, -1].includes(side)) throw new Error('Expected panel/strap and side ±1.');
    const mesh = meshes.find(mesh => mesh.name === 'BikiniTop');
    if (!mesh) return null;
    const index = mesh.geometry.getIndex(), positions = mesh.geometry.getAttribute('position');
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), p = new THREE.Vector3();
    root.updateMatrixWorld(true); camera.updateMatrixWorld(true);
    const rect = canvas.getBoundingClientRect(), count = index ? index.count : positions.count;
    for (let i = 0; i < count; i += 3) {
      mesh.getVertexPosition(index ? index.getX(i) : i, a);
      mesh.getVertexPosition(index ? index.getX(i + 1) : i + 1, b);
      mesh.getVertexPosition(index ? index.getX(i + 2) : i + 2, c);
      p.copy(a).add(b).add(c).multiplyScalar(1 / 3).applyMatrix4(mesh.matrixWorld).project(camera);
      if (Math.abs(p.x) > .96 || Math.abs(p.y) > .96 || p.z < -1 || p.z > 1) continue;
      const x = rect.left + (p.x + 1) * .5 * rect.width, y = rect.top + (1 - p.y) * .5 * rect.height;
      const hit = cast(x, y);
      if ((kind === 'strap' ? garments.strapSide(hit) : garments.panelSide(hit)) !== side) continue;
      // Mirror the real pointer hit routing without emitting a synthetic event.
      const strap = strapNear({ clientX: x, clientY: y, pointerType: 'mouse' }, hit);
      if (kind === 'panel' ? Boolean(strap) : strap?.side !== side) continue;
      return { x, y, mesh: hit.object.name, kind, side };
    }
    return null;
  }
  return {
    locate, locateGarment, releaseAll,
    /** Distance along `raycaster` to this character's nearest surface (Infinity when missed). */
    probe(raycaster) {
      if (disposed) return Infinity;
      root.updateMatrixWorld(true);
      return picker.cast(raycaster)?.distance ?? Infinity;
    },
    get active() { return contacts.size > 0; },
    setMode(value) {
      if (!['squeeze', 'grab', 'fabric'].includes(value)) throw new Error(`Invalid interaction mode: ${value}`);
      releaseAll(); mode = value;
    },
    snapshot: () => ({ owner, mode, contacts: contacts.size, pickableMeshes: meshes.map(mesh => mesh.name),
      regions: [...rig.regions.keys()], rig: rig.getDiagnostics(), garments: garments.getState() }),
    dispose() { if (disposed) return; releaseAll(); disposed = true; listeners.abort(); }
  };
}
