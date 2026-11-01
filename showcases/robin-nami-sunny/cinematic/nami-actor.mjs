import * as THREE from 'three';
import { createSoftRig } from '../softbody.mjs';
import { roundChestMasks } from '../chest-field.mjs';
import { createGarments } from './nami-cloth/garment.mjs';
import { createInteraction } from './interaction.mjs';
import { createDeckWalker, gaitPhase, gaitRate } from './deck-walker.mjs';
import { COLORWAYS, TOP_SPECS, createWardrobe } from './nami-colorways.mjs';
import { collectDisposer } from './resources.mjs';
import { pinSortSpheres } from './bounds.mjs';

const GLB_URL = '../native/nami-showcase/export/scene.glb';
const SIDECAR_URL = '../native/nami-showcase/export/softbody.json';
const CLIPS = Object.freeze(['StandingIdle', 'Walking', 'Running', 'Jump']);
const SOFT_MESHES = Object.freeze(['Body', 'BikiniTop', 'Jeans']);

/**
 * Nami: skinned GLB + soft-tissue rig + connected top garment + colorways + deck walking.
 * She owns her clock, so pausing, seeking or restyling Robin never stops her.
 * `others()` returns deck-local {x, z} positions of characters she must not crowd;
 * `occluded(raycaster, distance)` reports whether another character is in front of a ray.
 */
export async function loadNamiActor({ parent, loader, patrol, canvas, camera, controls, pointerEvents, others, occluded,
  onStatus, onRegion, anisotropy = 1, reducedMotion = false }) {
  const [gltf, sidecar] = await Promise.all([
    loader.loadAsync(GLB_URL),
    fetch(SIDECAR_URL).then(response => { if (!response.ok) throw new Error(`${SIDECAR_URL}: HTTP ${response.status}`); return response.json(); }),
  ]);
  const entity = gltf.scene, release = collectDisposer(entity);
  const anchor = new THREE.Group();
  anchor.name = 'Nami deck position';
  anchor.add(entity);
  let mixer, rig, garments, wardrobe, interaction;
  try {
    const clips = new Map(gltf.animations.map(clip => [clip.name, clip]));
    if (clips.size !== CLIPS.length || CLIPS.some(id => !clips.has(id))) throw new Error('Nami must carry exactly the four basic animations.');
    if (!Array.isArray(sidecar?.meshes) || sidecar.meshes.some(spec => !SOFT_MESHES.includes(spec.name))) throw new Error('Nami soft-body sidecar is invalid.');
    const bones = [], meshes = [];
    entity.traverse(node => {
      if (node.isBone) bones.push(node);
      if (node.isMesh) {
        node.castShadow = true; node.receiveShadow = true; meshes.push(node);
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
          for (const value of Object.values(material)) if (value?.isTexture) value.anisotropy = anisotropy;
        }
      }
    });
    if (!bones.length) throw new Error('Nami has no skeleton.');
    const mesh = name => { const found = meshes.filter(item => item.name === name); if (found.length !== 1) throw new Error(`Nami mesh ${name} must exist exactly once.`); return found[0]; };

    entity.updateMatrixWorld(true);
    const round = roundChestMasks(entity, sidecar);
    rig = createSoftRig(entity, round.sidecar);
    const cupMasks = round.original.BikiniTop;
    if (!cupMasks) throw new Error('Nami is missing the original chest masks on BikiniTop.');
    garments = createGarments({ bikini: mesh('BikiniTop'), rig, reducedMotion, colorways: TOP_SPECS,
      membership: { 1: cupMasks['chest-left'], [-1]: cupMasks['chest-right'] } });
    const pinBounds = pinSortSpheres(rig);
    wardrobe = createWardrobe({ entity, garments, anisotropy, reducedMotion });
    const walker = createDeckWalker({ patrol, startSeconds: 0, others });
    const route = patrol.snapshot(), navBrief = { radius: route.radius, height: route.height, speed: route.speed, length: route.length, duration: route.duration };
    const rest = [];
    entity.traverse(node => rest.push({ node, p: node.position.clone(), q: node.quaternion.clone(), s: node.scale.clone() }));
    mixer = new THREE.AnimationMixer(entity);
    let mode = 'patrol', clipId = 'Walking', seconds = 0, playing = true, disposed = false, action, interactionMode = 'squeeze';
    const lightTint = new THREE.Color(1, 1, 1);
    // 'patrol' walks the deck loop, 'patrol-run' runs it; every other mode plays a clip in place.
    const patrolGait = value => value === 'patrol' ? 'Walking' : value === 'patrol-run' ? 'Running' : null;

    interaction = createInteraction({ canvas, camera, controls, root: entity, meshes, rig, garments, pointerEvents,
      owner: 'Nami', initialMode: interactionMode, enabled: () => !disposed, occluded, onStatus, onRegion });

    const assertLive = () => { if (disposed) throw new Error('Nami has been disposed.'); };
    function bind(id) {
      mixer.stopAllAction();
      for (const row of rest) { row.node.position.copy(row.p); row.node.quaternion.copy(row.q); row.node.scale.copy(row.s); }
      clipId = id;
      action = mixer.clipAction(clips.get(id));
      action.reset().setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      action.play();
    }
    function sample(updateWorld = true) {
      let phase = seconds;
      const gait = patrolGait(mode);
      if (gait) {
        const p = walker.position;
        anchor.position.set(p.x, p.y, p.z);
        anchor.rotation.y = p.yaw;
        phase = gaitPhase(gait, p.distance);
      }
      const duration = clips.get(clipId).duration;
      action.paused = false; action.enabled = true;
      mixer.setTime(clipId === 'Jump' ? Math.min(phase, duration) : phase % duration);
      if (updateWorld) anchor.updateWorldMatrix(true, true);
    }
    function snapshot() {
      let finite = true, scaleDeviation = 0, quaternionDeviation = 0, checksum = 2166136261;
      for (const bone of bones) {
        for (const value of [...bone.position, ...bone.quaternion, ...bone.scale]) {
          finite &&= Number.isFinite(value);
          checksum = Math.imul(checksum ^ Math.round(value * 1e6), 16777619);
        }
        scaleDeviation = Math.max(scaleDeviation, Math.abs(bone.scale.x - 1), Math.abs(bone.scale.y - 1), Math.abs(bone.scale.z - 1));
        quaternionDeviation = Math.max(quaternionDeviation, Math.abs(bone.quaternion.length() - 1));
      }
      const duration = clips.get(clipId).duration;
      return {
        asset: GLB_URL, mode, clip: clipId, seconds, playing, disposed, blocked: walker.blocked,
        held: interaction.active, clipTime: action.time, duration, clips: [...clips.keys()],
        position: anchor.position.toArray(), yaw: anchor.rotation.y,
        pose: { bones: bones.length, finite, scaleDeviation, quaternionDeviation, checksum: (checksum >>> 0).toString(16) },
        outfit: wardrobe.snapshot(), colorways: COLORWAYS.map(c => c.id),
        interaction: { mode: interactionMode, contacts: interaction.active ? 1 : 0, regions: [...rig.regions.keys()] },
        navigation: { ...navBrief, clear: patrol.isClear(anchor.position.x, anchor.position.z) },
      };
    }
    function setMode(value) {
      assertLive();
      if (!patrolGait(value) && !CLIPS.includes(value)) throw new Error(`Invalid Nami motion: ${value}`);
      interaction.releaseAll();
      mode = value; seconds = 0; playing = true;
      bind(patrolGait(value) ?? value); sample();
      return snapshot();
    }
    function seek(value) {
      assertLive();
      if (!Number.isFinite(value) || value < 0) throw new Error('Nami time must be finite and non-negative.');
      interaction.releaseAll();
      if (patrolGait(mode)) walker.set(value); else seconds = clipId === 'Jump' ? Math.min(value, clips.get(clipId).duration) : value;
      playing = false; sample(); return snapshot();
    }
    bind('Walking'); sample(); parent.add(anchor);
    garments.apply();
    return {
      anchor, interaction, rig, garments, snapshot, setMode, seek,
      meshes,
      colorwayList: COLORWAYS,
      setOutfit(id) { assertLive(); const started = wardrobe.apply(id); return { started, ...wardrobe.snapshot() }; },
      get outfitBusy() { return wardrobe.busy; },
      setInteractionMode(value) { assertLive(); interaction.setMode(value); interactionMode = value; },
      get interactionMode() { return interactionMode; },
      /** Her painted atlas is unlit, so the scene's light is applied as a colour multiplier. */
      setLighting(color) {
        assertLive();
        if (lightTint.equals(color)) return;
        lightTint.copy(color); wardrobe.setTint(color);
        for (const mesh of meshes) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) if (material.isMeshBasicMaterial) material.color.copy(color);
      },
      diagnostics: () => ({ ...snapshot(), rig: rig.getDiagnostics(), garments: garments.getState() }),
      play() { assertLive(); if (clipId === 'Jump' && seconds >= clips.get(clipId).duration) seconds = 0; playing = true; sample(); return snapshot(); },
      pause() { assertLive(); playing = false; interaction.releaseAll(); return snapshot(); },
      reset: () => setMode('patrol'),
      /** Returns true when a one-shot motion (Jump) just finished. */
      update(dt, deformGeometry = true, beforeDeform) {
        if (disposed) return false;
        if (!Number.isFinite(dt) || dt < 0) throw new Error('Nami time step is invalid.');
        wardrobe.update(dt);
        let completed = false;
        // A held character is frozen like a grabbed doll: her pose and place wait for release.
        if (playing && !interaction.active) {
          if (patrolGait(mode)) walker.advance(dt, gaitRate(patrolGait(mode)));
          else {
            seconds += dt;
            completed = clipId === 'Jump' && seconds >= clips.get(clipId).duration;
            if (completed) { seconds = clips.get(clipId).duration; playing = false; }
          }
          sample(false); // rig.update refreshes the hierarchy immediately below
        }
        beforeDeform?.();
        garments.update(dt); rig.update(dt, deformGeometry); garments.apply(); pinBounds();
        return completed;
      },
      dispose() {
        if (disposed) return;
        disposed = true; playing = false;
        interaction.dispose(); wardrobe.dispose(); garments.dispose(); rig.dispose();
        mixer.stopAllAction(); mixer.uncacheRoot(entity);
        anchor.removeFromParent(); release();
      },
    };
  } catch (error) {
    interaction?.dispose(); wardrobe?.dispose(); garments?.dispose(); rig?.dispose();
    mixer?.stopAllAction(); mixer?.uncacheRoot(entity);
    anchor.removeFromParent(); release();
    throw error;
  }
}
