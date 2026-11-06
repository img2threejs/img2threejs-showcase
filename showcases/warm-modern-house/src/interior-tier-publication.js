// SPDX-License-Identifier: Apache-2.0
// Preparing, uploading and committing a room's high texture tier.
//
// The publication is atomic: the new textures are created and uploaded while the room still
// shows its standard textures, and only then are the material slots swapped, in one synchronous
// step. No frame ever renders a texture that was not uploaded.
//
// The publication is also conditional: it is only committed while the session lives, the
// publication epoch is unchanged and the room was not evicted or switched to the standard tier
// while the upload ran. A discarded publication releases the textures it prepared.
import * as THREE from 'three';
import { uploadTextures } from './interior-room-upload.js';

// The texture slots of a material that the runtime can swap.
export function textureSlots(material) {
  return Object.keys(material).filter(key => material[key]?.isTexture);
}

/**
 * Prepare a room's high tier without exposing it.
 *
 * @param {THREE.Object3D} root the room root
 * @param {Map<string, THREE.Texture>} textures the high tier's textures, by texture id
 * @param {string} tier the tier the prepared textures belong to
 * @returns {{prepared: {material: object, key: string, old: object, clone: object}[], replacements: Map}}
 */
export function prepareTier(root, textures, tier) {
  const prepared = [];
  const replacements = new Map();
  root.traverse(node => {
    if (!node.isMesh) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      for (const key of textureSlots(material)) {
        const old = material[key];
        const source = textures.get(old.userData?.textureId);
        if (!source || old.userData?.tier === tier) continue;
        if (!replacements.has(old)) {
          const texture = source.clone();
          for (const property of ['channel', 'wrapS', 'wrapT', 'magFilter', 'minFilter', 'anisotropy', 'matrixAutoUpdate']) {
            texture[property] = old[property];
          }
          texture.offset.copy(old.offset); texture.repeat.copy(old.repeat); texture.center.copy(old.center);
          texture.rotation = old.rotation; texture.matrix.copy(old.matrix);
          texture.needsUpdate = true;
          replacements.set(old, texture);
        }
        prepared.push({ material, key, old, clone: replacements.get(old) });
      }
    }
  });
  return { prepared, replacements };
}

/** The distinct textures a prepared tier would install. */
export function preparedTextures(prepared) {
  return [...new Set(prepared.prepared.map(entry => entry.clone))];
}

/**
 * Install a prepared tier: every material slot is swapped in one synchronous step.
 *
 * @param {{prepared: object[]}} prepared the prepared tier
 * @returns {number} how many distinct textures were installed
 */
export function commitTier(prepared) {
  for (const entry of prepared.prepared) entry.material[entry.key] = entry.clone;
  return prepared.replacements.size;
}

/**
 * True when the publication may still be committed.
 *
 * @param {object} check the liveness of the publication
 * @returns {boolean}
 */
export function publicationIsLive({ sessionAlive, epochMatches, tierIsHigh, roomIsCurrent, roomIsStandard }) {
  return Boolean(sessionAlive && epochMatches && tierIsHigh && roomIsCurrent && roomIsStandard);
}

/**
 * True when a room has a material whose texture slots take part in the shadow depth pass.
 *
 * three.js copies material.alphaMap and, for an alpha-tested material, material.map into the
 * shadow depth material, so replacing those slots changes the shadow-casting silhouette. An
 * ordinary albedo swap does not, and the shadow map stays valid.
 *
 * @param {object} room the room whose materials are inspected
 * @returns {boolean}
 */
export function tierAffectsShadow(room) {
  let affects = false;
  room?.root?.traverse(mesh => {
    if (affects || !mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (material?.alphaMap) { affects = true; return; }
      if (material?.map && (material.alphaTest ?? 0) > 0) { affects = true; return; }
    }
  });
  return affects;
}

/**
 * Publish a loaded high tier: prepare it, upload its textures one per task while the room still
 * shows the standard tier, then swap every slot in one synchronous step.
 *
 * The publication is registered in `uploads` under the room id, so an eviction can abort it. When
 * the upload finishes, `liveness()` is read again; a publication that was aborted, or whose
 * session, epoch, global tier or room changed meanwhile, is discarded and installs nothing. A
 * failing upload leaves the room at the standard tier and goes to `onFailure`.
 *
 * @param {object} options
 * @param {object} options.loader prepareTier/preparedTextures/commitTier/discardPreparedTier
 * @param {object} options.renderer the renderer that uploads the textures
 * @param {object} options.room the room whose tier is published
 * @param {string} options.roomId the room id
 * @param {object} options.result the loaded high tier
 * @param {Map<string, AbortController>} options.uploads the pending publications by room id
 * @param {() => Promise<void>} options.yieldToBrowser ends the current task between textures
 * @param {() => object} options.liveness the publicationIsLive() input, read when the upload ends
 * @param {() => void} options.onCommitted called after the tier is installed
 * @param {(error: Error) => void} options.onFailure called when preparing, uploading or installing failed
 * @returns {Promise<'committed'|'discarded'|'failed'>}
 */
export async function publishTier({ loader, renderer, room, roomId, result, uploads, yieldToBrowser,
  liveness, onCommitted, onFailure }) {
  const controller = new AbortController();
  uploads.set(roomId, controller);
  let prepared = null;
  try {
    prepared = loader.prepareTier(room.root, result);
    const uploaded = await uploadTextures(renderer, loader.preparedTextures(prepared), { yieldToBrowser, signal: controller.signal });
    if (uploaded.aborted || controller.signal.aborted || !publicationIsLive(liveness())) {
      loader.discardPreparedTier(roomId, prepared, result);
      return 'discarded';
    }
    loader.commitTier(roomId, prepared);
    room.tier = 'high';
  } catch (error) {
    if (prepared) loader.discardPreparedTier(roomId, prepared, result);
    // An aborted publication has nobody to report to: its upload may have thrown because the
    // session it belonged to was already closed.
    if (controller.signal.aborted || !liveness().sessionAlive) return 'discarded';
    onFailure(error);
    return 'failed';
  } finally {
    // A newer publication of the same room owns the entry; leave it alone.
    if (uploads.get(roomId) === controller) uploads.delete(roomId);
  }
  onCommitted();
  return 'committed';
}
