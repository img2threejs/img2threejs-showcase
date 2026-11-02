import { textureByteLength } from './interior-assets.js';

// Track real buffer storage, including shared/interleaved attributes and BatchedMesh.
// Texture/target ownership stays with the loader, pipeline and scene owners.
export class InteriorResidency {
  constructor(renderer) {
    this.renderer = renderer;
    this.gl = renderer.getContext();
    this.buffers = new Map();
    this.bindings = new Map();
    this.elements = new Map();
    this.vao = null;
    this.original = new Map();
    this.serial = 0;
    this.targets = new Map();
    this.textures = new Map();
    const gl = this.gl;
    const wrap = (name, after) => {
      const original = gl[name];
      this.original.set(name, original);
      gl[name] = (...args) => { const result = original.apply(gl, args); after(...args); return result; };
    };
    wrap('bindVertexArray', vao => { this.vao = vao; });
    wrap('deleteVertexArray', vao => { this.elements.delete(vao); if (this.vao === vao) this.vao = null; });
    wrap('bindBuffer', (target, buffer) => {
      if (target === gl.ELEMENT_ARRAY_BUFFER) this.elements.set(this.vao, buffer);
      else this.bindings.set(target, buffer);
    });
    wrap('bufferData', (target, data, _usage, offset = 0, length = 0) => {
      const buffer = target === gl.ELEMENT_ARRAY_BUFFER ? this.elements.get(this.vao) : this.bindings.get(target);
      if (!buffer || data == null) return;
      const scalar = data?.BYTES_PER_ELEMENT ?? 1;
      const bytes = typeof data === 'number' ? data : length > 0 ? length * scalar : data.byteLength - offset * scalar;
      if (!Number.isSafeInteger(bytes) || bytes < 0) return;
      const old = this.buffers.get(buffer);
      this.buffers.set(buffer, { id: old?.id ?? `buffer-${++this.serial}`, kind: 'buffer', uploaded: true, bytes });
    });
    wrap('deleteBuffer', buffer => { this.buffers.delete(buffer); });
  }

  trackTarget(id, target) { this.targets.set(target, id); }
  trackTexture(id, texture) { if (texture) this.textures.set(texture, id); }

  trackBatches(root) {
    root.traverse(mesh => {
      if (!mesh.isBatchedMesh) return;
      // Pinned r180: data arrays contain the exact uploaded matrix/index/color formats.
      for (const slot of ['_matricesTexture', '_indirectTexture', '_colorsTexture']) {
        this.trackTexture(`${mesh.uuid}:${slot}`, mesh[slot]);
      }
    });
  }

  snapshot(includeResources = true) {
    const resources = includeResources ? [...this.buffers.values()].map(record => ({ ...record })) : [];
    let gpuBytes = 0;
    for (const record of this.buffers.values()) gpuBytes += record.bytes;
    const renderer = this.renderer;
    for (const [texture, id] of this.textures) {
      const uploaded = !!renderer.properties.get(texture).__webglTexture;
      const bytes = uploaded ? textureByteLength(texture) : 0;
      gpuBytes += bytes;
      if (includeResources) resources.push({ id, kind: 'batch-texture', uploaded, width: texture.image.width,
        height: texture.image.height, format: texture.format, type: texture.type,
        mipLevels: texture.mipmaps?.length || 1, bytes });
    }
    for (const [target, id] of this.targets) {
      const properties = renderer.properties.get(target);
      const uploaded = !!properties.__webglFramebuffer;
      const samples = Math.min(renderer.capabilities.maxSamples, target.samples);
      const separate = !!properties.__webglMultisampledFramebuffer;
      const colorBytes = textureByteLength(target.texture);
      let bytes = colorBytes;
      if (properties.__webglDepthbuffer) bytes += target.width * target.height * 4 * (samples && !separate ? samples : 1);
      if (properties.__webglColorRenderbuffer) bytes += colorBytes * samples;
      if (properties.__webglDepthRenderbuffer) bytes += target.width * target.height * 4 * samples;
      if (samples && !separate) bytes += colorBytes * (samples - 1);
      if (uploaded) gpuBytes += bytes;
      if (includeResources) resources.push({ id, kind: 'render-target', uploaded, width: target.width, height: target.height,
        format: target.texture.format, type: target.texture.type, faces: target.isWebGLCubeRenderTarget ? 6 : 1,
        depthBuffer: !!properties.__webglDepthbuffer, samples, bytes: uploaded ? bytes : 0 });
    }
    const gl = this.gl;
    // Production requests no default depth/MSAA: all scene depth lives in tracked HDR targets.
    const canvasBytes = gl.drawingBufferWidth * gl.drawingBufferHeight * 4;
    gpuBytes += canvasBytes;
    if (includeResources) resources.push({ id: 'canvas-color', kind: 'default-framebuffer', format: 'RGBA8', uploaded: true,
      width: gl.drawingBufferWidth, height: gl.drawingBufferHeight, bytes: canvasBytes });
    return { resources, gpuBytes };
  }

  dispose() {
    for (const [name, original] of this.original) this.gl[name] = original;
    this.original.clear();
    for (const collection of [this.buffers, this.bindings, this.elements, this.targets, this.textures]) collection.clear();
  }
}
