// SPDX-License-Identifier: Apache-2.0
// Uploading a room's textures one at a time, so no single main-thread task blocks the frames
// that are being presented. The runtime gate rejects a navigation-phase task above 50 ms; a
// room's high tier carries 27 textures, and uploading them together blocked the main thread for
// hundreds of milliseconds while the camera was moving.
//
// The upload is also abortable: a session that is closed, or a tier publication that is
// discarded, must not keep uploading textures that nothing will ever render.
import * as THREE from 'three';

// Every texture of a room, in a stable order, without the render-target textures.
export function roomTextures(room) {
  const textures = new Set();
  room.root.traverse(mesh => {
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value?.isTexture && !value.isRenderTargetTexture) textures.add(value);
      }
    }
  });
  return [...textures];
}

/**
 * Upload a list of textures, one per task.
 *
 * The upload stops as soon as the signal is aborted: an aborted upload leaves the remaining
 * textures unuploaded and reports how many were uploaded, so the caller can discard them.
 *
 * @param {THREE.WebGLRenderer} renderer the renderer that owns the textures
 * @param {THREE.Texture[]} textures the textures to upload
 * @param {object} [options]
 * @param {() => Promise<void>} [options.yieldToBrowser] ends the current task between textures
 * @param {AbortSignal} [options.signal] aborts the upload
 * @returns {Promise<{uploaded: number, aborted: boolean}>} how many textures were uploaded
 */
export async function uploadTextures(renderer, textures, { yieldToBrowser = () => new Promise(resolve => setTimeout(resolve, 0)),
  signal = null } = {}) {
  let uploaded = 0;
  for (const texture of textures) {
    if (signal?.aborted) return { uploaded, aborted: true };
    renderer.initTexture(texture);
    uploaded++;
    await yieldToBrowser();
    // The liveness is checked after every yield: a session that closed during the upload must
    // not keep the main thread busy.
    if (signal?.aborted) return { uploaded, aborted: true };
  }
  return { uploaded, aborted: false };
}

/**
 * Upload every texture of a room, one per task.
 *
 * @param {THREE.WebGLRenderer} renderer the renderer that owns the textures
 * @param {object} room the room whose textures are uploaded
 * @param {object} [options] see uploadTextures
 * @returns {Promise<{uploaded: number, aborted: boolean}>} how many textures were uploaded
 */
export async function uploadRoomTextures(renderer, room, options = {}) {
  return uploadTextures(renderer, roomTextures(room), options);
}
