import * as THREE from 'three';

export const BAKED_GI_LIMIT = 'Hidden objects retain their baked shadows and indirect light. Finish changes do not rebake indirect lighting.';

/** A condition is an authored note: a plain string, or `{text, sources}` citing the source images that show it. */
export function describeCondition(condition) {
  if (condition === undefined || condition === null || condition === '') return null;
  if (typeof condition === 'string') return condition;
  if (typeof condition?.text !== 'string' || !condition.text || !Array.isArray(condition.sources)) {
    throw new Error('Object condition must be text or {text, sources[]}. Re-export the registry.');
  }
  return `${condition.text} (authored observation; sources: ${condition.sources.join(', ')})`;
}

export function objectMetadata(mesh, root) {
  let owner = mesh;
  while (owner && owner.userData.objectId === undefined) {
    if (owner === root) break;
    owner = owner.parent;
  }
  if (!owner || owner.userData.objectId === undefined) throw new Error(`Rendered mesh ${mesh.name || mesh.uuid} has no objectId ancestor. Re-export and encode the scene.`);
  const metadata = { ...owner.userData };
  // Quantization children can carry an atlas while the physical identity is on a parent.
  for (let node = mesh; node; node = node.parent) {
    for (const [key, value] of Object.entries(node.userData)) {
      if (key === 'lightmap' || key === 'dynamic' || key.startsWith('curtain_')) {
        if (!Object.hasOwn(metadata, key)) metadata[key] = value;
      }
    }
    if (node === root) break;
  }
  return metadata;
}

function materials(mesh) { return Array.isArray(mesh.material) ? mesh.material : [mesh.material]; }
function cloneBoundMaterial(source) {
  const clone = source.clone();
  // Material.copy deliberately omits these; the closure contains the immutable RGBM atlas range.
  clone.onBeforeCompile = source.onBeforeCompile;
  clone.customProgramCacheKey = source.customProgramCacheKey;
  return clone;
}
function geometryLayout(geometry) {
  return JSON.stringify([!!geometry.index, Object.entries(geometry.attributes).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, attribute]) => [key, attribute.itemSize, attribute.normalized, attribute.array?.constructor.name ?? attribute.data.array.constructor.name])]);
}
function visibleInTree(mesh, root) {
  for (let node = mesh; node; node = node.parent) {
    if (!node.visible) return false;
    if (node === root) break;
  }
  return true;
}

/** Construct after baked-material binding. Owns only generated batches/materials/outline. */
export function createObjectController({ root, registry, roomId, variants = [], canvas, camera,
  onChange = () => {}, onSelect = () => {}, onInspect = () => {}, announce = () => {}, liveRegion,
  isInteractive = () => true, batch = true }) {
  if (registry?.schemaVersion !== 1 || !Array.isArray(registry.objects)) throw new Error('objects.json requires schemaVersion 1 and an objects array.');
  const registryById = new Map();
  for (const entry of registry.objects) {
    if (!entry?.objectId || registryById.has(entry.objectId)) throw new Error(`Duplicate or missing registry objectId: ${entry?.objectId}`);
    registryById.set(entry.objectId, entry);
  }
  const records = new Map(registry.objects.filter(entry => entry.room === roomId).map(entry => [entry.objectId,
    { entry, meshes: [], parts: [], hidden: false, highlighted: false }]));
  const meshRecords = new Map();
  root.updateWorldMatrix(true, true);
  root.traverse(mesh => {
    if (!mesh.isMesh) return;
    const metadata = objectMetadata(mesh, root);
    const record = records.get(metadata.objectId);
    if (!record) throw new Error(`Rendered object ${metadata.objectId} is absent from room ${roomId} in objects.json. Re-export and encode both assets.`);
    for (const key of ['room', 'class', 'finishGroup']) {
      if (metadata[key] !== record.entry[key]) throw new Error(`Object ${metadata.objectId} ${key} differs between GLB and objects.json.`);
    }
    if (!mesh.geometry?.attributes.position?.count) throw new Error(`Object ${metadata.objectId} has no rendered geometry.`);
    const item = { mesh, metadata, record, originalMaterial: mesh.material, originalVisible: mesh.visible,
      originalLayers: mesh.layers.mask, initiallyVisible: visibleInTree(mesh, root) };
    record.meshes.push(mesh);
    meshRecords.set(mesh, item);
  });
  for (const record of records.values()) if (!record.meshes.length) throw new Error(`Registry object ${record.entry.objectId} has no geometry in room ${roomId}. Re-export and encode both assets.`);
  if (!records.size) throw new Error(`Room ${roomId} has no registered objects.`);

  const ownedMaterials = new Set();
  const ownedBatches = new Set();
  const renderables = [];
  const finishMaterials = new Map();
  const variantsByGroup = new Map();
  for (const group of variants) {
    if (variantsByGroup.has(group.group) || !group.options?.length) throw new Error(`Invalid finish group ${group.group}`);
    variantsByGroup.set(group.group, group.options);
  }
  for (const record of records.values()) {
    const group = record.entry.finishGroup;
    if (group && !variantsByGroup.has(group)) throw new Error(`Object ${record.entry.objectId} references unknown finish group ${group}`);
  }
  const materialCache = new Map();
  const batchGroups = new Map();
  const selectedFinishes = new Map([...variantsByGroup].map(([group, options]) => [group, options[0].id]));
  let selected = null, isolated = null, foreign = false, disposed = false, wireframe = false;
  // `foreign` hides this room's objects while another room's object is isolated.
  const shown = record => !record.hidden && !foreign && (!isolated || isolated === record.entry.objectId);
  const check = () => { if (disposed) throw new Error('Object controller is disposed.'); };
  const lookup = id => { check(); const record = records.get(id); if (!record) throw new Error(`Unknown object ${id} in room ${roomId}`); return record; };
  const inverseRoot = root.matrixWorld.clone().invert();

  try {
    for (const item of meshRecords.values()) {
      const { mesh, metadata, record } = item;
      const group = record.entry.finishGroup ?? '';
      mesh.material = Array.isArray(item.originalMaterial) ? materials(mesh).map(bind) : bind(mesh.material);
      function bind(source) {
        const key = JSON.stringify([source.uuid, metadata.lightmap ?? '', group]);
        if (!materialCache.has(key)) {
          const material = cloneBoundMaterial(source);
          ownedMaterials.add(material);
          materialCache.set(key, material);
          if (group) {
            if (!material.color || !Number.isFinite(material.roughness)) throw new Error(`Finish group ${group} requires PBR color and roughness.`);
            if (!finishMaterials.has(group)) finishMaterials.set(group, new Map());
            finishMaterials.get(group).set(material, { color: material.color.clone(), roughness: material.roughness });
          }
        }
        return materialCache.get(key);
      }
      const dynamic = metadata.dynamic || metadata.curtain_id !== undefined || metadata.curtain_part !== undefined
        || mesh.isSkinnedMesh || mesh.isInstancedMesh || mesh.morphTargetInfluences?.length;
      const opaque = materials(mesh).every(material => !material.transparent && !material.alphaTest && !(material.transmission > 0));
      if (batch && !dynamic && opaque && !Array.isArray(mesh.material) && mesh.geometry.drawRange.start === 0
          && mesh.geometry.drawRange.count >= (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count)) {
        const key = JSON.stringify([roomId, item.originalMaterial.uuid, metadata.lightmap ?? '', group,
          geometryLayout(mesh.geometry), mesh.castShadow, mesh.receiveShadow, mesh.renderOrder, mesh.layers.mask]);
        if (!batchGroups.has(key)) batchGroups.set(key, []);
        batchGroups.get(key).push(item);
      } else {
        record.parts.push({ mesh, original: item });
        renderables.push(mesh);
      }
    }
    for (const items of batchGroups.values()) {
      const vertexCount = items.reduce((sum, item) => sum + item.mesh.geometry.attributes.position.count, 0);
      const indexCount = items.reduce((sum, item) => sum + (item.mesh.geometry.index?.count ?? 0), 0);
      const first = items[0].mesh;
      const combined = new THREE.BatchedMesh(items.length, vertexCount, indexCount, first.material);
      ownedBatches.add(combined);
      combined.name = `objects:${roomId}:${first.material.name}`;
      combined.castShadow = first.castShadow;
      combined.receiveShadow = first.receiveShadow;
      combined.renderOrder = first.renderOrder;
      combined.layers.mask = first.layers.mask;
      combined.userData.objectIds = new Map();
      combined.userData.room = roomId;
      combined.userData.finishGroup = items[0].record.entry.finishGroup;
      const geometryIds = new Map();
      for (const item of items) {
        const geometry = item.mesh.geometry;
        if (!geometryIds.has(geometry)) geometryIds.set(geometry, combined.addGeometry(geometry));
        const instance = combined.addInstance(geometryIds.get(geometry));
        combined.setMatrixAt(instance, new THREE.Matrix4().multiplyMatrices(inverseRoot, item.mesh.matrixWorld));
        combined.setVisibleAt(instance, item.initiallyVisible);
        combined.userData.objectIds.set(instance, item.record.entry.objectId);
        item.record.parts.push({ mesh: combined, instance, original: item });
        // Do not hide the subtree: a physical mesh can parent separate cloth/glass.
        item.mesh.layers.mask = 0;
      }
      root.add(combined);
      renderables.push(combined);
    }
  } catch (error) {
    for (const item of meshRecords.values()) { item.mesh.material = item.originalMaterial; item.mesh.visible = item.originalVisible; item.mesh.layers.mask = item.originalLayers; }
    for (const combined of ownedBatches) { combined.removeFromParent(); combined.dispose(); }
    for (const material of ownedMaterials) material.dispose();
    throw error;
  }

  // A real geometry-derived outline, independent of batch material/instance colors.
  const outline = new THREE.Box3Helper(new THREE.Box3(), 0xffce66);
  outline.name = 'object-selection-outline';
  outline.visible = false;
  outline.raycast = () => {};
  outline.material.depthTest = false;
  outline.material.toneMapped = false;
  outline.renderOrder = 10000;
  root.add(outline);
  const box = new THREE.Box3();
  const transform = new THREE.Matrix4();
  const pointer = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();
  const oldTabIndex = canvas?.getAttribute('tabindex');
  const oldKeyShortcuts = canvas?.getAttribute('aria-keyshortcuts');
  if (canvas) { canvas.tabIndex = 0; canvas.setAttribute('aria-keyshortcuts', 'Tab Shift+Tab Enter Escape'); }
  const oldLive = liveRegion?.getAttribute('aria-live');
  if (liveRegion) liveRegion.setAttribute('aria-live', 'polite');

  function describe(record) {
    return { ...record.entry, selected: record.entry.objectId === selected, hidden: record.hidden,
      visible: shown(record),
      finish: selectedFinishes.get(record.entry.finishGroup) ?? null, bakedLightingLimit: BAKED_GI_LIMIT };
  }
  function say(text) { if (liveRegion) liveRegion.textContent = text; announce(text); }
  function updateOutline() {
    const record = selected ? records.get(selected) : null;
    outline.visible = !!record && record.highlighted && shown(record);
    if (!outline.visible) return;
    root.updateWorldMatrix(true, true);
    inverseRoot.copy(root.matrixWorld).invert();
    outline.box.makeEmpty();
    for (const mesh of record.meshes) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      transform.multiplyMatrices(inverseRoot, mesh.matrixWorld);
      box.copy(mesh.geometry.boundingBox).applyMatrix4(transform);
      outline.box.union(box);
    }
  }
  function visibility() {
    for (const record of records.values()) {
      const visible = shown(record);
      for (const part of record.parts) {
        if (part.instance !== undefined) part.mesh.setVisibleAt(part.instance, visible && part.original.initiallyVisible);
        else part.mesh.visible = visible && part.original.originalVisible;
      }
    }
    updateOutline();
    onChange('visibility');
  }
  function select(id) {
    check();
    if (selected) records.get(selected).highlighted = false;
    const record = id === null ? null : lookup(id);
    selected = id;
    if (record) record.highlighted = true;
    updateOutline();
    const value = record ? describe(record) : null;
    if (record) say(`${record.entry.label}. ${record.entry.room}, ${record.entry.class}${record.entry.condition ? `. ${describeCondition(record.entry.condition)}` : ''}.`);
    onSelect(value);
    onChange('selection');
    return value;
  }
  // Nearest valid hit for a ready-made raycaster (used by the house-wide picker and by pick()).
  function raycast(ray) {
    check();
    root.updateWorldMatrix(true, true);
    for (const hit of ray.intersectObjects(renderables, false)) {
      if (!visibleInTree(hit.object, root)) continue;
      const material = Array.isArray(hit.object.material) ? hit.object.material[hit.face?.materialIndex ?? 0] : hit.object.material;
      if (!material?.visible || (material.transparent && material.opacity === 0)) continue;
      const id = hit.object.isBatchedMesh ? hit.object.userData.objectIds.get(hit.batchId) : meshRecords.get(hit.object)?.record.entry.objectId;
      if (!id) throw new Error('Picked geometry has no registry mapping.');
      if (shown(lookup(id))) return { objectId: id, distance: hit.distance };
    }
    return null;
  }
  function visibleIds() { return [...records.values()].filter(shown).map(record => record.entry.objectId); }
  function pick(event) {
    check();
    if (!canvas || !camera || !isInteractive()) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    camera.updateWorldMatrix(true, false);
    raycaster.setFromCamera(pointer, camera);
    return select(raycast(raycaster)?.objectId ?? null);
  }
  function keydown(event) {
    if (!isInteractive() || event.target !== canvas || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Tab') {
      const ids = visibleIds();
      if (!ids.length) return;
      event.preventDefault();
      const current = ids.indexOf(selected);
      const index = current < 0 ? (event.shiftKey ? ids.length - 1 : 0) : (current + (event.shiftKey ? -1 : 1) + ids.length) % ids.length;
      select(ids[index]);
    } else if (event.key === 'Enter' && selected) {
      event.preventDefault(); onInspect(describe(lookup(selected)));
    } else if (event.key === 'Escape') {
      select(null);
      // Allow keyboard users to leave the canvas rather than trapping Tab forever.
      canvas.blur();
    }
  }
  let pointerDown = null;
  function down(event) { if (event.button === 0) pointerDown = { id: event.pointerId, x: event.clientX, y: event.clientY }; }
  function up(event) {
    const start = pointerDown; pointerDown = null;
    if (start && start.id === event.pointerId && Math.hypot(start.x - event.clientX, start.y - event.clientY) < 5) pick(event);
  }
  function cancel() { pointerDown = null; }
  canvas?.addEventListener('keydown', keydown);
  canvas?.addEventListener('pointerdown', down);
  canvas?.addEventListener('pointerup', up);
  canvas?.addEventListener('pointercancel', cancel);

  return {
    renderables,
    bakedLightingLimit: BAKED_GI_LIMIT,
    list: () => { check(); return [...records.values()].map(describe); },
    select, pick, raycast, visibleIds,
    get selectedId() { return selected; },
    ownsObject: id => records.has(id),
    hasFinishGroup: group => finishMaterials.has(group),
    setForeignIsolation(flag) { check(); foreign = !!flag; visibility(); },
    highlight(id, enabled = true) { const record = lookup(id); if (enabled) select(id); record.highlighted = enabled; updateOutline(); onChange('highlight'); },
    hide(id) { const record = lookup(id); record.hidden = true; visibility(); say(`${record.entry.label} hidden. ${BAKED_GI_LIMIT}`); return describe(record); },
    show(id) { const record = lookup(id); record.hidden = false; visibility(); say(`${record.entry.label} shown.`); return describe(record); },
    isolate(id, { quiet = false } = {}) { check(); if (id !== null) lookup(id); isolated = id; visibility(); if (!quiet) say(id ? `${lookup(id).entry.label} isolated. ${BAKED_GI_LIMIT}` : 'All non-hidden objects shown.'); },
    setFinish(group, variantId, { quiet = false } = {}) {
      check();
      const options = variantsByGroup.get(group);
      const variant = options?.find(option => option.id === variantId);
      if (!variant || !finishMaterials.has(group)) throw new Error(`Unknown or unloaded finish ${group}/${variantId}`);
      const base = variant === options[0];
      const baseColor = new THREE.Color(options[0].color);
      if (!base && [baseColor.r, baseColor.g, baseColor.b].some(channel => channel === 0)) throw new Error(`Finish group ${group} has a zero base channel; relative tint is undefined.`);
      const tint = new THREE.Color(variant.color);
      if (!base) tint.setRGB(tint.r / baseColor.r, tint.g / baseColor.g, tint.b / baseColor.b);
      for (const [material, original] of finishMaterials.get(group)) {
        material.color.copy(original.color);
        if (!base) material.color.multiply(tint);
        material.roughness = base ? original.roughness : variant.roughness ?? original.roughness;
      }
      selectedFinishes.set(group, variantId);
      if (!quiet) say(`${variant.label} applied to ${group}. ${BAKED_GI_LIMIT}`);
      if (selected) onSelect(describe(lookup(selected)));
      onChange('finish');
      return true;
    },
    setWireframe(enabled) {
      check(); wireframe = !!enabled;
      for (const material of ownedMaterials) material.wireframe = wireframe;
      onChange('wireframe');
      return wireframe;
    },
    updateHighlight: updateOutline,
    dispose() {
      if (disposed) return;
      disposed = true;
      canvas?.removeEventListener('keydown', keydown);
      canvas?.removeEventListener('pointerdown', down);
      canvas?.removeEventListener('pointerup', up);
      canvas?.removeEventListener('pointercancel', cancel);
      if (canvas) {
        if (oldTabIndex === null) canvas.removeAttribute('tabindex'); else canvas.setAttribute('tabindex', oldTabIndex);
        if (oldKeyShortcuts === null) canvas.removeAttribute('aria-keyshortcuts'); else canvas.setAttribute('aria-keyshortcuts', oldKeyShortcuts);
      }
      if (liveRegion) { if (oldLive === null) liveRegion.removeAttribute('aria-live'); else liveRegion.setAttribute('aria-live', oldLive); }
      outline.removeFromParent(); outline.geometry.dispose(); outline.material.dispose();
      for (const combined of ownedBatches) { combined.removeFromParent(); combined.dispose(); }
      for (const item of meshRecords.values()) { item.mesh.material = item.originalMaterial; item.mesh.visible = item.originalVisible; item.mesh.layers.mask = item.originalLayers; }
      for (const material of ownedMaterials) material.dispose();
    },
  };
}

/**
 * One selection/visibility/finish surface over the per-room controllers of a house. Controllers
 * are created with `canvas: null` and the callbacks below, then registered with add(); this
 * object owns the canvas pointer/keyboard handling so a pick resolves across every visible room.
 * Finish groups are global; selection may name an object in any loaded room.
 */
export function createHouseObjects({ canvas, camera, liveRegion, roomOrder, variants = [], getCurrentRoom,
  isInteractive = () => true, onSelect = () => {}, onInspect = () => {}, onChange = () => {} }) {
  const controllers = new Map();
  const declaredGroups = new Set(variants.map(group => group.group));
  const finishes = new Map();
  const pointer = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();
  const oldTabIndex = canvas?.getAttribute('tabindex');
  const oldKeyShortcuts = canvas?.getAttribute('aria-keyshortcuts');
  const oldLive = liveRegion?.getAttribute('aria-live');
  let selectedRoom = null, isolatedId = null, wireframe = false, suppress = false, disposed = false;
  if (canvas) { canvas.tabIndex = 0; canvas.setAttribute('aria-keyshortcuts', 'Tab Shift+Tab Enter Escape'); }
  if (liveRegion) liveRegion.setAttribute('aria-live', 'polite');
  const check = () => { if (disposed) throw new Error('House object controller is disposed.'); };
  const say = text => { if (liveRegion) liveRegion.textContent = text; };
  const ordered = () => [...roomOrder].filter(id => controllers.has(id)).map(id => controllers.get(id));
  function owner(id) {
    check();
    for (const controller of controllers.values()) if (controller.ownsObject(id)) return controller;
    throw new Error(`Unknown object ${id}`);
  }
  function describeSelected() {
    const controller = controllers.get(selectedRoom);
    return controller?.list().find(item => item.objectId === controller.selectedId) ?? null;
  }
  function select(id) {
    check();
    if (id === null) {
      const controller = controllers.get(selectedRoom);
      if (controller) controller.select(null);
      return null;
    }
    const target = owner(id);
    const previous = controllers.get(selectedRoom);
    if (previous && previous !== target) {
      suppress = true;
      try { previous.select(null); } finally { suppress = false; }
    }
    return target.select(id);
  }
  function pick(event) {
    check();
    if (!canvas || !camera || !isInteractive()) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    camera.updateWorldMatrix(true, false);
    raycaster.setFromCamera(pointer, camera);
    let best = null;
    for (const controller of controllers.values()) {
      const hit = controller.raycast(raycaster);
      if (hit && (!best || hit.distance < best.distance)) best = hit;
    }
    return select(best?.objectId ?? null);
  }
  function keydown(event) {
    if (!isInteractive() || event.target !== canvas || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Tab') {
      const ids = controllers.get(getCurrentRoom())?.visibleIds() ?? [];
      if (!ids.length) return;
      event.preventDefault();
      const selectedId = controllers.get(selectedRoom)?.selectedId ?? null;
      const current = ids.indexOf(selectedId);
      const index = current < 0 ? (event.shiftKey ? ids.length - 1 : 0) : (current + (event.shiftKey ? -1 : 1) + ids.length) % ids.length;
      select(ids[index]);
    } else if (event.key === 'Enter' && selectedRoom !== null) {
      event.preventDefault(); onInspect(describeSelected());
    } else if (event.key === 'Escape') {
      select(null);
      canvas.blur();
    }
  }
  let pointerDown = null;
  const down = event => { if (event.button === 0) pointerDown = { id: event.pointerId, x: event.clientX, y: event.clientY }; };
  const up = event => {
    const start = pointerDown; pointerDown = null;
    if (start && start.id === event.pointerId && Math.hypot(start.x - event.clientX, start.y - event.clientY) < 5) pick(event);
  };
  const cancel = () => { pointerDown = null; };
  canvas?.addEventListener('keydown', keydown);
  canvas?.addEventListener('pointerdown', down);
  canvas?.addEventListener('pointerup', up);
  canvas?.addEventListener('pointercancel', cancel);

  return {
    say,
    /** Callbacks for a room controller: pass `onSelect`, `onChange` and `announce` below to createObjectController. */
    handleSelect(roomId, value) {
      if (suppress || disposed) return;
      if (value) selectedRoom = roomId; else if (selectedRoom === roomId) selectedRoom = null;
      onSelect(value);
    },
    handleChange(reason) { if (!disposed) onChange(reason); },
    add(roomId, controller) {
      check();
      if (controllers.has(roomId)) throw new Error(`Room ${roomId} already has an object controller.`);
      controllers.set(roomId, controller);
      // A room that streams in later joins the house-wide state.
      if (isolatedId !== null) controller.setForeignIsolation(true);
      if (wireframe) controller.setWireframe(true);
      for (const [group, variant] of finishes) if (controller.hasFinishGroup(group)) controller.setFinish(group, variant, { quiet: true });
    },
    has: roomId => controllers.has(roomId),
    remove(roomId) {
      const controller = controllers.get(roomId);
      if (!controller) return;
      if (selectedRoom === roomId) selectedRoom = null;
      controllers.delete(roomId);
      controller.dispose();
    },
    get selectedRoom() { return selectedRoom; },
    get renderables() { return ordered().flatMap(controller => controller.renderables); },
    list() { check(); return ordered().flatMap(controller => controller.list()); },
    select, pick,
    hide(id) { return owner(id).hide(id); },
    show(id) { return owner(id).show(id); },
    isolate(id) {
      check();
      const target = id === null ? null : owner(id);
      isolatedId = id;
      for (const controller of controllers.values()) {
        controller.setForeignIsolation(id !== null && controller !== target);
        controller.isolate(controller === target ? id : null, { quiet: true });
      }
      if (target) say(`${target.list().find(item => item.objectId === id).label} isolated. ${BAKED_GI_LIMIT}`);
      else say('All non-hidden objects shown.');
    },
    setFinish(group, variantId) {
      check();
      if (!declaredGroups.has(group)) throw new Error(`Unknown finish group: ${group}`);
      if (!variants.find(item => item.group === group).options.some(option => option.id === variantId)) throw new Error(`Unknown or unloaded finish ${group}/${variantId}`);
      let applied = 0;
      for (const controller of controllers.values()) {
        if (controller.hasFinishGroup(group)) { controller.setFinish(group, variantId, { quiet: applied > 0 }); applied++; }
      }
      finishes.set(group, variantId);
      return true;
    },
    setWireframe(enabled) {
      check();
      wireframe = !!enabled;
      for (const controller of controllers.values()) controller.setWireframe(wireframe);
      return wireframe;
    },
    updateHighlight() { for (const controller of controllers.values()) controller.updateHighlight(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      canvas?.removeEventListener('keydown', keydown);
      canvas?.removeEventListener('pointerdown', down);
      canvas?.removeEventListener('pointerup', up);
      canvas?.removeEventListener('pointercancel', cancel);
      if (canvas) {
        if (oldTabIndex === null) canvas.removeAttribute('tabindex'); else canvas.setAttribute('tabindex', oldTabIndex);
        if (oldKeyShortcuts === null) canvas.removeAttribute('aria-keyshortcuts'); else canvas.setAttribute('aria-keyshortcuts', oldKeyShortcuts);
      }
      if (liveRegion) { if (oldLive === null) liveRegion.removeAttribute('aria-live'); else liveRegion.setAttribute('aria-live', oldLive); }
      for (const controller of controllers.values()) controller.dispose();
      controllers.clear();
    },
  };
}
