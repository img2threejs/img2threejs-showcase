import './interior.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { createCurtainInteraction } from './interior-curtains.js';
import { createInteriorNavigation } from './interior-navigation.js';

const ui = Object.fromEntries([
  'app', 'viewport', 'canvas-host', 'source-panel', 'source-view', 'source-thumbnail', 'source-link',
  'mode-3d', 'mode-source', 'view-label', 'viewer-message', 'message-title', 'message-detail',
  'load-status', 'load-progress', 'retry-load', 'finish-swatches', 'finish-label', 'wireframe',
  'reset', 'download-glb', 'download-blend', 'download-source', 'panel-toggle',
  'curtain-amount', 'curtain-percent', 'curtain-open', 'curtain-close', 'curtain-wind',
].map(id => [id, document.getElementById(id)]));
const viewButtons = [...document.querySelectorAll('[data-view]')];
const state = { status: 'loading', error: null, mode: '3d', view: 'source', finish: 'cream', wireframe: false, frames: 0 };
const offset = new THREE.Vector3();
const orbit = new THREE.Spherical();
const baseUrl = import.meta.env.BASE_URL;
// Optional published-download URLs (release builds); undefined keeps the local exports.
const downloads = import.meta.env.VITE_LIVING_ROOM_DOWNLOADS ?? {};
const phaseCount = 4;
let phase = 0;

// Manifest paths are authored as root-absolute /assets/... values. Validate that shape, then
// resolve against the deployment base at each use site; the manifest bytes are never rewritten.
function assetUrl(path, label) {
  if (typeof path !== 'string' || !path.startsWith('/assets/') || path.includes('//', 1) || path.includes('\\') || path.split('/').includes('..')) {
    throw new Error(`Invalid local asset path: ${label}`);
  }
  if ((label === 'portableModel' || label === 'blender') && downloads[label]) return downloads[label];
  return `${baseUrl}${path.slice(1)}`;
}

function setPhase(index, failed = false) {
  phase = index;
  for (const item of document.querySelectorAll('[data-phase-step]')) {
    const step = Number(item.dataset.phaseStep);
    item.dataset.state = step < index ? 'done' : step === index ? (failed ? 'error' : 'active') : 'pending';
  }
}
const iblDiffuseLine = 'iblIrradiance += getIBLIrradiance( geometryNormal );';
const lightsInclude = '#include <lights_fragment_maps>';
let session = null;
let loading = false;
let renderRequest = 0;
let applyingPose = false;

function cameraSnapshot() {
  if (!session?.camera) return null;
  const { camera, controls } = session;
  return { position: camera.position.toArray(), quaternion: camera.quaternion.toArray(),
    target: controls.target.toArray(), fov: camera.fov, aspect: camera.aspect,
    near: camera.near, far: camera.far, view: state.view };
}

function textureSnapshot(texture) {
  if (!texture) return null;
  return { uuid: texture.uuid, channel: texture.channel, colorSpace: texture.colorSpace,
    flipY: texture.flipY, width: texture.image?.width, height: texture.image?.height };
}

function materialSnapshot(material) {
  const textures = {};
  for (const [name, value] of Object.entries(material)) {
    if (value?.isTexture) textures[name] = textureSnapshot(value);
  }
  return { uuid: material.uuid, name: material.name, type: material.type,
    color: material.color?.toArray(), roughness: material.roughness, metalness: material.metalness,
    transparent: material.transparent, opacity: material.opacity, alphaTest: material.alphaTest,
    transmission: material.transmission ?? 0, emissive: material.emissive?.toArray(),
    emissiveIntensity: material.emissiveIntensity,
    side: material.side, depthWrite: material.depthWrite, lightMapIntensity: material.lightMapIntensity,
    textures };
}

function inventorySnapshot() {
  return session?.entries.map(({ mesh, pbr, diagnostic }) => ({
    component: mesh.userData.component, uuid: mesh.uuid, name: mesh.name,
    geometryUuid: mesh.geometry.uuid, finish: mesh.userData.finish ?? null,
    currentFinish: mesh.userData.finish === 'sofa' ? state.finish : null,
    curtain: mesh.userData.curtain_id ?? null, curtainPart: mesh.userData.curtain_part ?? null,
    lightmap: mesh.userData.lightmap ?? null,
    attributes: Object.fromEntries(Object.entries(mesh.geometry.attributes).map(([name, attribute]) =>
      [name, { count: attribute.count, itemSize: attribute.itemSize, version: attribute.version }])),
    indexCount: mesh.geometry.index?.count ?? null,
    materials: (Array.isArray(pbr) ? pbr : [pbr]).map(materialSnapshot),
    activeMaterialUuids: (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map(material => material.uuid),
    diagnosticMaterialUuids: (Array.isArray(diagnostic) ? diagnostic : [diagnostic]).map(material => material.uuid),
  })) ?? [];
}

Object.defineProperty(window, 'interiorStudy', {
  value: Object.freeze({
    get status() { return state.status; },
    get error() { return state.error; },
    get camera() { return cameraSnapshot(); },
    get frames() { return state.frames; },
    get stats() { return session?.stats ? structuredClone(session.stats) : null; },
    get inventory() { return inventorySnapshot(); },
    get mode() { return state.mode; },
    get finish() { return state.finish; },
    get wireframe() { return state.wireframe; },
    get curtains() { return session?.curtains?.snapshot() ?? null; },
    get navigation() { return session?.navigation?.snapshot() ?? null; },
    get lighting() { return session?.sun ? { model: session.manifest.lighting.model,
      exposure: session.renderer.toneMappingExposure, sunIntensity: session.sun.intensity,
      shadowMapSize: session.sun.shadow.mapSize.toArray() } : null; },
    setView, setFinish, setMode, setWireframe, setCurtainClosure, setCurtainWind, reset,
  }),
});

function syncCurtainControls() {
  const curtain = session?.curtains;
  const percent = Math.round((curtain?.targetClosure ?? 0) * 100);
  if (ui['curtain-amount'].value !== String(percent)) ui['curtain-amount'].value = percent;
  ui['curtain-percent'].textContent = `${percent}%`;
  ui['curtain-amount'].setAttribute('aria-valuetext', `${ui['curtain-amount'].value}% coverage`);
  ui['curtain-wind'].setAttribute('aria-pressed', String(curtain?.wind ?? false));
  ui['curtain-wind'].disabled = state.status !== 'ready' || state.mode !== '3d' || !!curtain?.reducedMotion;
  ui['curtain-wind'].title = curtain?.reducedMotion ? 'Wind disabled by your reduced-motion setting.' : 'Toggle the gentle breeze that animates the fabric.';
}

function syncControls() {
  const ready = state.status === 'ready';
  const interactive = ready && state.mode === '3d';
  for (const mode of ['3d', 'source']) {
    ui[`mode-${mode}`].disabled = !ready;
    ui[`mode-${mode}`].setAttribute('aria-pressed', String(state.mode === mode));
  }
  for (const button of viewButtons) {
    button.disabled = !interactive;
    button.setAttribute('aria-pressed', String(state.view === button.dataset.view));
  }
  for (const button of ui['finish-swatches'].children) {
    button.disabled = !interactive;
    button.setAttribute('aria-pressed', String(state.finish === button.dataset.finish));
  }
  ui.wireframe.disabled = !interactive;
  ui.wireframe.setAttribute('aria-pressed', String(state.wireframe));
  ui.reset.disabled = !ready;
  for (const id of ['curtain-amount', 'curtain-open', 'curtain-close', 'curtain-wind']) ui[id].disabled = !interactive;
  syncCurtainControls();
  ui['canvas-host'].hidden = state.mode !== '3d';
  ui['source-panel'].hidden = state.mode !== 'source';
  ui['viewer-message'].hidden = ready;
  ui['load-progress'].hidden = state.status !== 'loading';
  ui['retry-load'].hidden = state.status !== 'error';
  ui.viewport.setAttribute('aria-busy', String(state.status === 'loading'));
  ui['load-status'].dataset.state = state.status;
  ui['viewer-message'].dataset.state = state.status;
  ui['view-label'].textContent = state.mode === 'source' ? 'Source image · synthetic design reference'
    : state.wireframe ? '3D · geometry wireframe' : '3D · sunlight and interactive curtains';
  for (const [id, field] of [['download-glb', 'portableModel'], ['download-blend', 'blender']]) {
    const link = ui[id];
    link.setAttribute('aria-disabled', String(!ready));
    link.tabIndex = ready ? 0 : -1;
    if (ready) link.href = session.assets[field];
    else link.removeAttribute('href');
  }
  if (session?.controls) {
    session.curtains?.setEnabled(interactive);
    session.controls.enabled = interactive && !session.curtains?.grabbing;
    session.renderer.domElement.tabIndex = interactive ? 0 : -1;
    session.renderer.domElement.setAttribute('aria-disabled', String(!interactive));
  }
}

function fail(error) {
  state.status = 'error';
  state.error = error instanceof Error ? error.message : String(error);
  setPhase(phase, true);
  session?.curtains?.setEnabled(false);
  cancelAnimationFrame(renderRequest);
  renderRequest = 0;
  ui['message-title'].textContent = 'Could not open the room';
  ui['message-detail'].textContent = state.error;
  ui['load-status'].textContent = 'Scene load did not finish. Check your connection, then choose “Retry load”.';
  syncControls();
}

function requestRender() {
  if (renderRequest || state.status !== 'ready' || state.mode !== '3d' || document.hidden) return;
  renderRequest = requestAnimationFrame(time => {
    renderRequest = 0;
    if (!session || state.status !== 'ready' || state.mode !== '3d' || document.hidden) return;
    try {
      const previous = session.lastRenderTime;
      session.lastRenderTime = time;
      const moving = session.curtains?.update(previous === null ? 0 : (time-previous)/1000, time/1000);
      syncCurtainControls();
      session.renderer.render(session.scene, session.camera);
      if (session.shaderError) throw session.shaderError;
      state.frames++;
      if (moving) requestRender();
      else session.lastRenderTime = null;
    } catch (error) { fail(error); }
  });
}

function resize() {
  if (!session?.camera) return;
  const width = ui.viewport.clientWidth;
  const height = ui.viewport.clientHeight;
  if (!width || !height) return;
  session.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  session.renderer.setSize(width, height, false);
  session.camera.aspect = width / height;
  session.camera.updateProjectionMatrix();
  requestRender();
}

function applyView(name) {
  const { manifest, camera, controls } = session;
  const pose = name === 'source' ? manifest.camera : manifest.views[name];
  applyingPose = true;
  camera.position.fromArray(pose.position);
  camera.fov = pose.fov ?? manifest.camera.fov;
  camera.updateProjectionMatrix();
  controls.target.fromArray(pose.target);
  camera.lookAt(controls.target);
  controls.update();
  applyingPose = false;
  state.view = name;
}

function setView(name) {
  if (!['source', 'left', 'right', 'detail', 'curtain'].includes(name)) throw new Error(`Unknown view: ${name}`);
  if (state.status !== 'ready' || state.mode !== '3d') return false;
  if (session.curtains?.grabbing) session.curtains.setEnabled(false);
  applyView(name);
  syncControls();
  requestRender();
  return true;
}

function setFinish(id) {
  if (state.status !== 'ready' || state.mode !== '3d') return false;
  const variant = session.manifest.variants.find(item => item.id === id);
  if (!variant) throw new Error(`Unknown fabric finish: ${id}`);
  for (const [material, original] of session.finishes) {
    if (id === 'cream') material.color.copy(original.color);
    else material.color.copy(original.color).multiply(session.finishTints.get(id));
    material.roughness = id === 'cream' ? original.roughness : variant.roughness ?? original.roughness;
  }
  state.finish = id;
  ui['finish-label'].textContent = variant.label;
  syncControls();
  requestRender();
  return true;
}

function setMode(mode) {
  if (!['3d', 'source'].includes(mode)) throw new Error(`Unknown mode: ${mode}`);
  if (state.status !== 'ready') return false;
  state.mode = mode;
  syncControls();
  if (mode === '3d') resize();
  return true;
}

function setWireframe(enabled) {
  if (typeof enabled !== 'boolean') throw new TypeError('Wireframe requires a boolean.');
  if (state.status !== 'ready' || state.mode !== '3d') return false;
  state.wireframe = enabled;
  for (const { mesh, pbr, diagnostic } of session.entries) mesh.material = enabled ? diagnostic : pbr;
  syncControls();
  requestRender();
  return true;
}

function setCurtainClosure(value) {
  if (state.status !== 'ready' || state.mode !== '3d') return false;
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError('Curtain coverage must be between 0 and 1.');
  session.curtains.setClosure(value);
  requestRender();
  return true;
}

function setCurtainWind(enabled) {
  if (state.status !== 'ready' || state.mode !== '3d') return false;
  if (typeof enabled !== 'boolean') throw new TypeError('Gentle breeze requires a boolean.');
  const actual = session.curtains.setWind(enabled);
  syncCurtainControls();
  requestRender();
  return actual === enabled;
}

function reset() {
  if (state.status !== 'ready') return false;
  setMode('3d');
  session.curtains.reset();
  setWireframe(false);
  setFinish('cream');
  setView('source');
  return true;
}

function cameraKeys(event) {
  if (!session?.controls.enabled || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', '_', 'Home'].includes(event.key)) return;
  event.preventDefault();
  if (event.key === 'Home') { setView('source'); return; }
  const { camera, controls } = session;
  orbit.setFromVector3(offset.copy(camera.position).sub(controls.target));
  if (event.key === 'ArrowLeft') orbit.theta -= 0.045;
  if (event.key === 'ArrowRight') orbit.theta += 0.045;
  if (event.key === 'ArrowUp') orbit.phi -= 0.035;
  if (event.key === 'ArrowDown') orbit.phi += 0.035;
  if (event.key === '+' || event.key === '=') orbit.radius *= 0.9;
  if (event.key === '-' || event.key === '_') orbit.radius *= 1.1;
  orbit.phi = THREE.MathUtils.clamp(orbit.phi, controls.minPolarAngle, controls.maxPolarAngle);
  orbit.radius = THREE.MathUtils.clamp(orbit.radius, controls.minDistance, controls.maxDistance);
  camera.position.copy(controls.target).add(offset.setFromSpherical(orbit));
  controls.update();
}

function validateManifest(manifest) {
  if (manifest.schemaVersion !== 2 || manifest.lighting?.model !== 'ambient-bake+shadowed-sun-v1') throw new Error('Scene needs the new ambient atlas and a compatible dynamic sun model.');
  for (const field of ['sourceImage', 'model', 'portableModel', 'blender', 'environment']) {
    if (typeof manifest[field] !== 'string' || !manifest[field].startsWith('/assets/')) throw new Error(`Missing local asset path: ${field}`);
  }
  if (manifest.background !== undefined) {
    if (typeof manifest.background !== 'string' || !manifest.background.startsWith('/assets/')) throw new Error('Outdoor HDR background path is invalid.');
    if (!Number.isFinite(manifest.backgroundIntensity) || manifest.backgroundIntensity < 0) throw new Error('Outdoor background intensity is invalid.');
  }
  for (const [name, pose] of Object.entries({ source: manifest.camera, left: manifest.views?.left, right: manifest.views?.right, detail: manifest.views?.detail, curtain: manifest.views?.curtain })) {
    for (const key of ['position', 'target']) {
      if (!Array.isArray(pose?.[key]) || pose[key].length !== 3 || !pose[key].every(Number.isFinite)) throw new Error(`View ${name} is missing a Y-up ${key}.`);
    }
    if (pose.position.every((value, index) => value === pose.target[index])) throw new Error(`View ${name} has position equal to its target.`);
    const fov = pose.fov ?? manifest.camera.fov;
    if (!Number.isFinite(fov) || fov <= 0 || fov >= 180) throw new Error(`Invalid FOV: ${name}`);
  }
  for (const key of ['min', 'max']) {
    if (!Array.isArray(manifest.roomBounds?.[key]) || manifest.roomBounds[key].length !== 3 || !manifest.roomBounds[key].every(Number.isFinite)) throw new Error('Scene is missing a Y-up interior bound.');
  }
  if (manifest.roomBounds.min.some((value, i) => value+0.5 >= manifest.roomBounds.max[i])) throw new Error('Interior volume is invalid.');
  const sun = manifest.lighting.sun;
  for (const key of ['position', 'target', 'color']) {
    if (!Array.isArray(sun?.[key]) || sun[key].length !== 3 || !sun[key].every(Number.isFinite)) throw new Error(`Sun config is missing ${key}.`);
  }
  if (!Number.isFinite(sun.intensity) || sun.intensity <= 0 || !Number.isInteger(sun.shadowMapSize) || sun.shadowMapSize < 512 || sun.shadowMapSize > 4096) throw new Error('Sun intensity or shadow map size is invalid.');
  if (manifest.toneMapping !== 'neutral' || !Number.isFinite(manifest.exposure) || manifest.exposure <= 0) throw new Error('Need Neutral tone mapping and a valid exposure.');
  if (!Array.isArray(manifest.lightmaps) || !manifest.lightmaps.length) throw new Error('Manifest has no lightmap atlas.');
  const ids = new Set();
  for (const atlas of manifest.lightmaps) {
    if (typeof atlas.id !== 'string' || ids.has(atlas.id) || !atlas.url?.startsWith('/assets/') || !Number.isFinite(atlas.intensity) || atlas.intensity <= 0) throw new Error('Lightmap atlas is invalid or has a duplicate id.');
    ids.add(atlas.id);
  }
  if (!Array.isArray(manifest.variants) || manifest.variants.length !== 3 || new Set(manifest.variants.map(item => item.id)).size !== 3 || !manifest.variants.some(item => item.id === 'cream')) throw new Error('Need exactly three fabric finishes including the original cream.');
  for (const variant of manifest.variants) {
    if (!variant.id || !variant.label || !/^#[\da-f]{6}$/i.test(variant.color) || (variant.roughness !== undefined && (!Number.isFinite(variant.roughness) || variant.roughness < 0 || variant.roughness > 1))) throw new Error('Fabric finish parameters are invalid.');
  }
}

function resolveAssets(manifest) {
  return {
    sourceImage: assetUrl(manifest.sourceImage, 'sourceImage'),
    model: assetUrl(manifest.model, 'model'),
    portableModel: assetUrl(manifest.portableModel, 'portableModel'),
    blender: assetUrl(manifest.blender, 'blender'),
    environment: assetUrl(manifest.environment, 'environment'),
    background: manifest.background === undefined ? undefined : assetUrl(manifest.background, 'background'),
    lightmaps: new Map(manifest.lightmaps.map(atlas => [atlas.id, assetUrl(atlas.url, `lightmap ${atlas.id}`)])),
  };
}

function createSwatches(manifest) {
  ui['finish-swatches'].replaceChildren();
  for (const variant of manifest.variants) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'finish-swatch';
    button.dataset.finish = variant.id;
    button.disabled = true;
    button.setAttribute('aria-pressed', String(variant.id === 'cream'));
    const chip = document.createElement('span');
    chip.className = 'swatch-chip';
    chip.style.setProperty('--swatch-color', variant.color);
    chip.setAttribute('aria-hidden', 'true');
    button.append(chip, document.createTextNode(variant.label));
    button.addEventListener('click', () => setFinish(variant.id));
    ui['finish-swatches'].append(button);
  }
  ui['finish-label'].textContent = manifest.variants.find(item => item.id === 'cream').label;
}

function collectResources(root, current) {
  root.traverse(object => {
    if (!object.isMesh) return;
    current.geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      current.materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) current.textures.add(value);
    }
  });
}

function bindMaterials(root, current) {
  const chunk = THREE.ShaderChunk.lights_fragment_maps;
  if (typeof chunk !== 'string' || chunk.split(iblDiffuseLine).length !== 2) throw new Error('Three.js shader does not match the bake version: missing the IBL diffuse line.');
  const bakedChunk = chunk.replace(iblDiffuseLine, '// Diffuse is supplied by the Blender lightmap only.');
  const cache = new Map();
  const wireCache = new Map();
  const clothTextures = new Map();
  const clothAnisotropy = Math.max(1, Math.min(8, current.renderer.capabilities.getMaxAnisotropy()));
  const finishUsage = new Map();
  let triangles = 0;
  root.traverse(mesh => {
    if (mesh.isLight) throw new Error('Runtime GLB must not contain lights outside the manifest sun configuration.');
    if (!mesh.isMesh) return;
    // glTF node extras live on a Group when an object has multiple material primitives.
    // Carry those authored semantics to the rendered primitive, never infer a missing atlas.
    for (const key of ['component', 'lightmap', 'finish', 'curtain_id', 'curtain_part']) {
      if (mesh.userData[key] !== undefined) continue;
      let owner = mesh.parent;
      while (owner && owner !== root && owner.userData[key] === undefined) owner = owner.parent;
      if (owner?.userData[key] !== undefined) mesh.userData[key] = owner.userData[key];
    }
    const component = mesh.userData.component;
    const atlasId = mesh.userData.lightmap;
    const atlas = current.atlases.get(atlasId);
    if (!component) throw new Error(`Mesh ${mesh.name || mesh.uuid} is missing a component.`);
    if (atlasId !== undefined && !atlas) throw new Error(`Mesh ${component} has an invalid lightmap.`);
    const { position, uv, uv1 } = mesh.geometry.attributes;
    if (!position || !uv || uv.count !== position.count || uv.itemSize !== 2) throw new Error(`Mesh ${component} is missing a full UV0 channel.`);
    if (atlas && (!uv1 || uv1.count !== position.count || uv1.itemSize !== 2)) throw new Error(`Mesh ${component} is missing a full UV1 channel for the atlas.`);
    const configurable = mesh.userData.finish === 'sofa';
    const dynamic = mesh.userData.curtain_id !== undefined;
    function bind(source) {
      if (!source.isMeshStandardMaterial) throw new Error(`Material ${source.name} of ${component} is not a standard PBR material.`);
      if (dynamic) {
        const key = `${source.uuid}:cloth`;
        if (cache.has(key)) return cache.get(key);
        const material = source.clone();
        material.lightMap = null;
        material.side = material.shadowSide = THREE.DoubleSide;
        // Keep the scan's yarn detail at grazing angles without changing sofa samplers.
        for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap']) {
          const sourceTexture = material[key];
          if (!sourceTexture) continue;
          if (!clothTextures.has(sourceTexture)) {
            const texture = sourceTexture.clone();
            texture.anisotropy = clothAnisotropy;
            texture.needsUpdate = true;
            current.textures.add(texture);
            clothTextures.set(sourceTexture, texture);
          }
          material[key] = clothTextures.get(sourceTexture);
        }
        current.materials.add(material);
        cache.set(key, material);
        return material;
      }
      // Glass and the emissive bulb intentionally have no baked atlas.
      // Leave their native physical/emissive material and environment response intact.
      if (!atlas) {
        if (configurable) throw new Error(`Sofa material ${component} is missing a lightmap atlas.`);
        cache.set(`${source.uuid}:unbaked`, source);
        return source;
      }
      const key = `${source.uuid}:${atlas.id}`;
      if (finishUsage.has(key) && finishUsage.get(key) !== configurable) throw new Error(`Material ${source.name} is shared between the sofa and a non-configurable part.`);
      finishUsage.set(key, configurable);
      if (cache.has(key)) return cache.get(key);
      const material = source.clone();
      current.materials.add(material);
      material.lightMap = atlas.texture;
      material.lightMapIntensity = atlas.intensity;
      material.onBeforeCompile = shader => {
        if (!shader.fragmentShader.includes(lightsInclude)) throw new Error('PBR shader is missing lights_fragment_maps for the diffuse bake.');
        shader.fragmentShader = shader.fragmentShader.replace(lightsInclude, bakedChunk);
      };
      material.customProgramCacheKey = () => 'interior-baked-diffuse-r180';
      // Cloning retains authored alpha blending, alpha test, side and depth settings (including foliage).
      cache.set(key, material);
      if (configurable) current.finishes.set(material, { color: material.color.clone(), roughness: material.roughness });
      return material;
    }
    function diagnostic(material) {
      if (!wireCache.has(material.uuid)) {
        const wire = new THREE.MeshBasicMaterial({ color: '#d8d2c6', wireframe: true, side: material.side });
        current.materials.add(wire);
        wireCache.set(material.uuid, wire);
      }
      return wireCache.get(material.uuid);
    }
    const pbr = Array.isArray(mesh.material) ? mesh.material.map(bind) : bind(mesh.material);
    const wire = Array.isArray(pbr) ? pbr.map(diagnostic) : diagnostic(pbr);
    mesh.material = pbr;
    const materials = Array.isArray(pbr) ? pbr : [pbr];
    mesh.castShadow = !materials.some(material => (material.transmission ?? 0) > 0.5);
    mesh.receiveShadow = true;
    current.entries.push({ mesh, pbr, diagnostic: wire });
    triangles += (mesh.geometry.index?.count ?? position.count) / 3;
  });
  if (!current.entries.length || !current.finishes.size) throw new Error('Scene has no meshes or no recolourable sofa material.');
  current.stats = { meshes: current.entries.length, components: new Set(current.entries.map(entry => entry.mesh.userData.component)).size,
    triangles, geometries: current.geometries.size, pbrMaterials: cache.size, lightmaps: current.atlases.size,
    environmentTextureUuid: current.environmentTarget.texture.uuid, manifest: current.manifest.stats ?? {} };
}

function disposeSession() {
  cancelAnimationFrame(renderRequest);
  renderRequest = 0;
  if (!session) return;
  session.curtains?.dispose();
  session.navigation?.dispose();
  session.sun?.dispose();
  session.controls?.dispose();
  session.environmentTarget?.dispose();
  for (const geometry of session.geometries) geometry.dispose();
  for (const material of session.materials) material.dispose();
  const closedImages = new Set();
  for (const texture of session.textures) {
    texture.dispose();
    if (texture.image?.close && !closedImages.has(texture.image)) {
      texture.image.close();
      closedImages.add(texture.image);
    }
  }
  session.renderer?.dispose();
  session.renderer?.domElement.remove();
  session = null;
}

async function start() {
  if (loading) return;
  loading = true;
  disposeSession();
  Object.assign(state, { status: 'loading', error: null, mode: '3d', view: 'source', finish: 'cream', wireframe: false, frames: 0 });
  ui['message-title'].textContent = 'Opening room';
  ui['message-detail'].textContent = 'Reading model, materials and lightmap atlases.';
  ui['load-status'].textContent = 'Reading scene manifest…';
  ui['load-progress'].removeAttribute('value');
  setPhase(0);
  syncControls();
  try {
    const response = await fetch(`${baseUrl}assets/interior/manifest.json`, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Could not load manifest (${response.status}).`);
    const manifest = await response.json();
    validateManifest(manifest);
    const assets = resolveAssets(manifest);
    setPhase(1);
    createSwatches(manifest);
    const current = { manifest, assets, geometries: new Set(), materials: new Set(), textures: new Set(),
      atlases: new Map(), finishes: new Map(), finishTints: new Map(), entries: [], shaderError: null, lastRenderTime: null };
    session = current;
    // The neutral weave map already contains the cream albedo. Apply relative linear
    // color factors, not another absolute tint; retain each loaded factor exactly.
    const cream = new THREE.Color(manifest.variants.find(variant => variant.id === 'cream').color);
    for (const variant of manifest.variants) {
      const tint = new THREE.Color(variant.color);
      tint.setRGB(tint.r / cream.r, tint.g / cream.g, tint.b / cream.b);
      current.finishTints.set(variant.id, tint);
    }
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    current.renderer = renderer;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = manifest.exposure;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor('#282722');
    renderer.debug.onShaderError = () => { current.shaderError = new Error('Could not compile the PBR/lightmap shader on this device.'); };
    const canvas = renderer.domElement;
    canvas.tabIndex = -1;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', '3D interior room. Grab and drag the fabric to adjust the curtains; drag elsewhere or use the arrow keys to rotate, plus/minus to zoom, Home returns to the source view.');
    canvas.setAttribute('aria-describedby', 'interaction-hint');
    canvas.addEventListener('keydown', cameraKeys);
    canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); fail(new Error('Lost the WebGL context. Choose Retry load to rebuild the viewer.')); });
    ui['canvas-host'].append(canvas);
    const scene = new THREE.Scene();
    current.scene = scene;
    current.camera = new THREE.PerspectiveCamera(manifest.camera.fov, 2752 / 1536, 0.03, 250);
    const controls = new OrbitControls(current.camera, canvas);
    current.controls = controls;
    controls.enabled = false;
    controls.enableDamping = false;
    controls.enablePan = true;
    controls.rotateSpeed = 0.55;
    controls.zoomSpeed = 0.7;
    current.navigation = createInteriorNavigation(current.camera, controls, manifest.roomBounds);
    controls.addEventListener('change', () => {
      if (!applyingPose && state.status === 'ready') { state.view = 'custom'; syncControls(); }
      requestRender();
    });
    applyView('source');
    resize();
    let completed = 0;
    const total = manifest.lightmaps.length + 3 + (manifest.background !== undefined ? 1 : 0);
    ui['load-progress'].max = total;
    ui['load-progress'].value = 0;
    const tracked = async (promise, label) => {
      try {
        const value = await promise;
        completed++;
        if (state.status === 'loading') {
          ui['load-progress'].value = completed;
          ui['load-status'].textContent = `Loaded ${completed}/${total} asset groups · ${label}`;
        }
        return value;
      } catch (error) { throw new Error(`Could not load ${label}: ${error.message}`); }
    };
    for (const id of ['source-view', 'source-thumbnail']) ui[id].src = assets.sourceImage;
    ui['source-link'].href = assets.sourceImage;
    const exrLoader = new EXRLoader();
    const tasks = [
      tracked(new GLTFLoader().loadAsync(assets.model).then(async gltf => {
        current.root = gltf.scene;
        collectResources(gltf.scene, current);
        // GLTFLoader deliberately resolves failed texture loads as null. Never call that ready.
        const textures = await gltf.parser.getDependencies('texture');
        for (const texture of textures) if (texture) current.textures.add(texture);
        if (textures.some(texture => !texture)) throw new Error('One or more textures inside the GLB are missing.');
      }), 'model and PBR textures'),
      tracked(exrLoader.loadAsync(assets.environment).then(texture => {
        texture.colorSpace = THREE.NoColorSpace;
        texture.mapping = THREE.EquirectangularReflectionMapping;
        current.probe = texture;
        current.textures.add(texture);
      }), 'room reflection probe'),
      tracked(Promise.all([ui['source-view'].decode(), ui['source-thumbnail'].decode()]), 'source design image'),
      ...manifest.lightmaps.map(atlas => tracked(exrLoader.loadAsync(assets.lightmaps.get(atlas.id)).then(texture => {
        current.textures.add(texture);
        current.atlases.set(atlas.id, { ...atlas, texture });
      }), `atlas ${atlas.id}`)),
    ];
    if (assets.background !== undefined) {
      tasks.push(tracked(new HDRLoader().loadAsync(assets.background).then(texture => {
        texture.mapping = THREE.EquirectangularReflectionMapping;
        texture.colorSpace = THREE.NoColorSpace;
        current.background = texture;
        current.textures.add(texture);
        scene.background = texture;
        scene.backgroundIntensity = manifest.backgroundIntensity;
      }), 'garden HDR beyond the glazing'));
    }
    // Settle every load before disposal/retry; a late texture must not leak into another session.
    const results = await Promise.allSettled(tasks);
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected) throw rejected.reason;
    if (state.error) throw new Error(state.error);
    // r180 EXRLoader decodes bottom-row-first. glTF exports UV1 top-origin.
    // Reverse lightmap rows only, keeping the environment's equirectangular convention intact.
    let rowScratch;
    for (const { texture } of current.atlases.values()) {
      const { data, width, height } = texture.image;
      const stride = data.length / height;
      if (!width || !height || !Number.isInteger(stride) || stride !== width * 4) throw new Error('EXR atlas does not contain valid RGBA data.');
      if (!rowScratch || rowScratch.constructor !== data.constructor || rowScratch.length < stride) rowScratch = new data.constructor(stride);
      for (let y = 0; y < Math.floor(height / 2); y++) {
        const top = y * stride;
        const bottom = (height - 1 - y) * stride;
        rowScratch.set(data.subarray(top, top + stride));
        data.copyWithin(top, bottom, bottom + stride);
        data.set(rowScratch.subarray(0, stride), bottom);
      }
      texture.channel = 1;
      texture.colorSpace = THREE.NoColorSpace;
      texture.flipY = false;
      texture.needsUpdate = true;
    }
    ui['load-status'].textContent = 'Preparing reflection probe and compiling materials…';
    setPhase(2);
    const pmrem = new THREE.PMREMGenerator(renderer);
    try { current.environmentTarget = pmrem.fromEquirectangular(current.probe); }
    finally { pmrem.dispose(); current.probe.dispose(); current.textures.delete(current.probe); }
    scene.environment = current.environmentTarget.texture;
    bindMaterials(current.root, current);
    scene.add(current.root);
    const sunSpec = manifest.lighting.sun;
    const sun = new THREE.DirectionalLight();
    sun.color.setRGB(...sunSpec.color);
    sun.intensity = sunSpec.intensity;
    sun.target.position.fromArray(sunSpec.target);
    sun.position.fromArray(sunSpec.position).sub(sun.target.position).normalize().multiplyScalar(25).add(sun.target.position);
    sun.castShadow = true;
    sun.shadow.mapSize.setScalar(sunSpec.shadowMapSize);
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = 55;
    sun.shadow.camera.left = sun.shadow.camera.bottom = -9;
    sun.shadow.camera.right = sun.shadow.camera.top = 9;
    sun.shadow.bias = -0.00008;
    sun.shadow.normalBias = 0.015;
    sun.shadow.camera.updateProjectionMatrix();
    current.sun = sun;
    scene.add(sun, sun.target);
    current.curtains = createCurtainInteraction({ root: current.root, camera: current.camera,
      canvas, controls, onChange: requestRender, isInteractive: () => state.status === 'ready' && state.mode === '3d' });
    await renderer.compileAsync(scene, current.camera);
    if (state.error) throw new Error(state.error);
    if (current.shaderError) throw current.shaderError;
    setPhase(3);
    renderer.render(scene, current.camera);
    if (current.shaderError) throw current.shaderError;
    state.frames++;
    state.status = 'ready';
    setPhase(phaseCount);
    ui['load-status'].textContent = 'Ready · all assets loaded and first frame rendered.';
    syncControls();
    requestRender();
  } catch (error) {
    disposeSession();
    fail(error);
  } finally { loading = false; }
}

for (const button of viewButtons) button.addEventListener('click', () => setView(button.dataset.view));
ui['mode-3d'].addEventListener('click', () => setMode('3d'));
ui['mode-source'].addEventListener('click', () => setMode('source'));
ui.wireframe.addEventListener('click', () => setWireframe(!state.wireframe));
ui.reset.addEventListener('click', reset);
ui['retry-load'].addEventListener('click', start);
ui['download-source'].href = downloads.source ?? `${baseUrl}source/living-room.zip`;
ui['panel-toggle'].addEventListener('click', () => {
  const open = ui['panel-toggle'].getAttribute('aria-expanded' ) !== 'true';
  ui['panel-toggle'].setAttribute('aria-expanded', String(open));
  ui['panel-toggle'].textContent = open ? 'Hide panel' : 'Show panel';
  ui.app.dataset.panel = open ? 'open' : 'collapsed';
});
ui['curtain-amount'].addEventListener('input', () => setCurtainClosure(Number(ui['curtain-amount'].value)/100));
ui['curtain-open'].addEventListener('click', () => setCurtainClosure(0));
ui['curtain-close'].addEventListener('click', () => setCurtainClosure(1));
ui['curtain-wind'].addEventListener('click', () => setCurtainWind(!session.curtains.wind));
const resizeObserver = new ResizeObserver(resize);
resizeObserver.observe(ui.viewport);
window.addEventListener('resize', resize);
document.addEventListener('visibilitychange', requestRender);
window.addEventListener('pagehide', event => {
  if (!event.persisted) { resizeObserver.disconnect(); disposeSession(); }
});
start();
