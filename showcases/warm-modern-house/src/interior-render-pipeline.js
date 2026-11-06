import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const vertexShader = `varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// The sun and the whole house are static: the shadow map only changes when the shadow-casting
// geometry changes (a room becomes visible, an object is hidden or isolated, a tier is published).
// Redrawing it on every moving frame cost 3.5 ms of GPU time per 1080p frame on the benchmark house,
// ~30 % of a 60 Hz frame. The pipeline therefore owns the shadow map's update policy: the owner
// declares a change with invalidateShadows(), and the map is redrawn on the next frame that needs it.

// The object controller reports every change with a reason. Only a reason that alters the
// shadow-casting silhouette may redraw the map: hiding or isolating an object removes geometry,
// and wireframe changes the rasterised silhouette because three.js copies material.wireframe into
// the shadow depth material. A selection outline or a finish tint changes neither.
export const SHADOW_CHANGING_REASONS = new Set(['visibility', 'wireframe']);
export class ShadowUpdatePolicy {
  constructor() {
    this.dirty = true;
    this.updates = 0;
  }

  invalidate() { this.dirty = true; }

  // True when this frame must redraw the shadow map. The map is redrawn at most once per change.
  consume() {
    if (!this.dirty) return false;
    this.dirty = false;
    this.updates++;
    return true;
  }
}

// Rendering only: the owner schedules idle frames and invalidates on scene changes.
export class InteriorRenderPipeline {
  constructor(renderer, { sampleCap = 32 } = {}) {
    if (!Number.isInteger(sampleCap) || sampleCap < 16 || sampleCap > 32) {
      throw new RangeError('sampleCap must be an integer from 16 to 32.');
    }
    if (!renderer.extensions.has('EXT_color_buffer_float')) {
      throw new Error('Linear HDR accumulation requires EXT_color_buffer_float.');
    }
    this.renderer = renderer;
    this.sampleCap = sampleCap;
    this.samples = 0;
    this.scale = 1;
    this.disposed = false;
    this.lastSceneStats = { drawCalls: 0, triangles: 0 };
    this.stress = null;
    this.shadows = new ShadowUpdatePolicy();
    // three.js redraws the shadow map on every render unless the owner stops it. The pipeline
    // redraws it exactly when the owner declared a change, so the map is never stale.
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = false;
    const target = (type, depthBuffer) => new THREE.WebGLRenderTarget(1, 1, {
      type, depthBuffer, colorSpace: THREE.LinearSRGBColorSpace,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    });
    this.movingTarget = target(THREE.HalfFloatType, true);
    this.movingTarget.texture.minFilter = THREE.LinearFilter;
    this.movingTarget.texture.magFilter = THREE.LinearFilter;
    // Match the default framebuffer's MSAA for the scale-one direct-path comparison.
    this.movingTarget.samples = renderer.getContext().getParameter(renderer.getContext().SAMPLES);
    this.sampleTarget = target(THREE.HalfFloatType, true);
    this.history = [target(THREE.HalfFloatType, false), target(THREE.HalfFloatType, false)];
    this.average = new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
      uniforms: { current: { value: null }, previous: { value: null }, weight: { value: 1 } },
      vertexShader,
      fragmentShader: `varying vec2 vUv;
        uniform sampler2D current, previous; uniform float weight;
        void main() {
          vec4 sampleColor = texture2D(current, vUv);
          if (weight == 1.0) gl_FragColor = sampleColor;
          else gl_FragColor = mix(texture2D(previous, vUv), sampleColor, weight);
        }`,
    });
    this.output = new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
      uniforms: { image: { value: null } }, vertexShader,
      fragmentShader: `varying vec2 vUv; uniform sampler2D image;
        void main() {
          gl_FragColor = texture2D(image, vUv);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.quad = new FullScreenQuad(this.output);
    this.size = new THREE.Vector2();
    this.viewport = new THREE.Vector4();
    this.scissor = new THREE.Vector4();
    this.projection = new THREE.Matrix4();
    this.inverse = new THREE.Matrix4();
    this.width = this.height = 0;
    this.resize();
  }

  invalidate() { this.samples = 0; }

  // Declare that the shadow-casting geometry changed: the next rendered frame redraws the map.
  invalidateShadows() { this.shadows.invalidate(); }

  // Call after renderer.setSize/setPixelRatio; dimensions are physical drawing-buffer pixels.
  resize() {
    this.assertAlive();
    this.renderer.getDrawingBufferSize(this.size);
    if (this.width === this.size.x && this.height === this.size.y) return;
    this.width = this.size.x;
    this.height = this.size.y;
    this.sampleTarget.setSize(this.width, this.height);
    for (const target of this.history) target.setSize(this.width, this.height);
    this.resizeMoving();
    this.invalidate();
  }

  setScale(scale) {
    this.assertAlive();
    if (!Number.isFinite(scale) || scale < 0.5 || scale > 1) {
      throw new RangeError('renderScale must be in [0.5, 1].');
    }
    if (scale === this.scale) return;
    this.scale = scale;
    this.resizeMoving();
    this.invalidate();
  }

  // Full-size non-MSAA movement and idle samples have the same HDR/depth format.
  // Share that scene target instead of allocating another full-size attachment.
  get movingSceneTarget() {
    return this.scale === 1 && this.movingTarget.samples === 0 ? this.sampleTarget : this.movingTarget;
  }

  resizeMoving() {
    if (this.movingSceneTarget !== this.movingTarget) return;
    this.movingTarget.setSize(Math.max(1, Math.round(this.width * this.scale)),
      Math.max(1, Math.round(this.height * this.scale)));
  }

  setStress(enabled) {
    this.assertAlive();
    if (enabled && !this.stress) {
      this.stress = new THREE.ShaderMaterial({
        depthTest: false, depthWrite: false, transparent: true, toneMapped: false,
        uniforms: { iterations: { value: 2048 } }, vertexShader,
        fragmentShader: `varying vec2 vUv; uniform int iterations;
          void main() {
            float value = vUv.x + vUv.y;
            for (int i = 0; i < iterations; i++) value = sin(value * 1.0001 + float(i) * 0.01);
            gl_FragColor = vec4(vec3(value * 0.5 + 0.5), 0.04);
          }`,
      });
    }
    this.stressEnabled = !!enabled;
    this.invalidate();
  }

  renderScene(scene, camera) {
    const renderer = this.renderer;
    renderer.info.reset();
    // The shadow map is redrawn only when the owner declared a change to the shadow-casting
    // geometry; three.js keeps the last map bound to the material's shadow sampler.
    renderer.shadowMap.needsUpdate = this.shadows.consume();
    renderer.render(scene, camera);
    this.lastSceneStats.drawCalls = renderer.info.render.calls;
    this.lastSceneStats.triangles = renderer.info.render.triangles;
    if (this.stressEnabled) {
      this.quad.material = this.stress;
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      try { this.quad.render(renderer); } finally { renderer.autoClear = autoClear; }
    }
  }

  get residency() {
    if (this.disposed) return [];
    // Three r180 allocates targets lazily and removes these handles on resize/disposal.
    // Storage bytes include actual allocated attachments, not driver bookkeeping.
    return [
      ['motion-hdr', this.movingTarget, 8], ['idle-sample-hdr', this.sampleTarget, 8],
      ['idle-history-0', this.history[0], 8], ['idle-history-1', this.history[1], 8],
    ].map(([id, target, colorBytes]) => {
      const properties = this.renderer.properties.get(target);
      const uploaded = !!properties.__webglFramebuffer;
      const samples = Math.min(this.renderer.capabilities.maxSamples, target.samples);
      const separateMultisample = !!properties.__webglMultisampledFramebuffer;
      let bytesPerPixel = colorBytes;
      if (properties.__webglDepthbuffer) bytesPerPixel += 4 * (samples && !separateMultisample ? samples : 1);
      if (properties.__webglColorRenderbuffer) bytesPerPixel += colorBytes * samples;
      if (properties.__webglDepthRenderbuffer) bytesPerPixel += 4 * samples;
      return { id, kind: 'render-target', uploaded, format: colorBytes === 8 ? 'RGBA16F' : 'RGBA32F',
        width: target.width, height: target.height, samples, mipLevels: 1,
        bytes: uploaded ? target.width * target.height * bytesPerPixel : 0 };
    });
  }

  assertAlive() {
    if (this.disposed) throw new Error('InteriorRenderPipeline is disposed.');
  }

  // moving/animated frames always reset history. accumulate=true adds one idle sample.
  render(scene, camera, { accumulate = false } = {}) {
    this.assertAlive();
    this.resize();
    const renderer = this.renderer;
    if (renderer.xr.isPresenting) throw new Error('InteriorRenderPipeline does not support XR.');
    const target = renderer.getRenderTarget();
    const cubeFace = renderer.getActiveCubeFace();
    const mip = renderer.getActiveMipmapLevel();
    const toneMapping = renderer.toneMapping;
    const colorSpace = renderer.outputColorSpace;
    const autoClear = renderer.autoClear;
    const infoAutoReset = renderer.info.autoReset;
    const scissorTest = renderer.getScissorTest();
    renderer.getViewport(this.viewport);
    renderer.getScissor(this.scissor);
    this.projection.copy(camera.projectionMatrix);
    this.inverse.copy(camera.projectionMatrixInverse);
    try {
      // Scene targets are cleared explicitly; full-screen passes overwrite every
      // pixel. Automatic clears would repeat those clears between render passes.
      renderer.autoClear = false;
      renderer.info.autoReset = false;
      renderer.setScissorTest(false);
      renderer.toneMapping = THREE.NoToneMapping;
      let image;
      if (!accumulate) {
        this.invalidate();
        const sceneTarget = this.movingSceneTarget;
        renderer.setRenderTarget(sceneTarget);
        renderer.clear(true, true, true);
        this.renderScene(scene, camera);
        image = sceneTarget.texture;
      } else {
        // A shadow refresh changes the image, so the accumulated history must start over. The check
        // sits outside the sample-cap branch: an invalidation at the cap must still render one
        // frame with the new shadow map instead of leaving a stale map bound.
        if (this.shadows.dirty) this.invalidate();
        if (this.samples < this.sampleCap) {
          // Checkerboard ordering spreads the first 16 samples across the pixel.
          const index = this.samples;
          const cell = (index % 16) * 2 + ((Math.floor(index / 4) + Math.floor(index / 16)) % 2);
          const x = ((cell % 8) + 0.5) / 8 - 0.5;
          const y = (Math.floor(cell / 8) + 0.5) / 4 - 0.5;
          const e = camera.projectionMatrix.elements;
          const base = this.projection.elements;
          for (let column = 0; column < 4; column++) {
            e[column * 4] += 2 * x / this.width * base[column * 4 + 3];
            e[column * 4 + 1] += 2 * y / this.height * base[column * 4 + 3];
          }
          camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
          renderer.setRenderTarget(this.sampleTarget);
          renderer.clear(true, true, true);
          this.renderScene(scene, camera);
          const destination = this.history[index % 2];
          this.average.uniforms.current.value = this.sampleTarget.texture;
          this.average.uniforms.previous.value = this.history[(index + 1) % 2].texture;
          this.average.uniforms.weight.value = 1 / (index + 1);
          this.quad.material = this.average;
          renderer.setRenderTarget(destination);
          this.quad.render(renderer);
          this.samples++;
        }
        image = this.history[(this.samples - 1) % 2].texture;
      }
      renderer.setRenderTarget(null);
      renderer.setViewport(0, 0, this.width / renderer.getPixelRatio(), this.height / renderer.getPixelRatio());
      renderer.toneMapping = THREE.NeutralToneMapping;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.output.uniforms.image.value = image;
      this.quad.material = this.output;
      this.quad.render(renderer);
      return this.samples;
    } finally {
      camera.projectionMatrix.copy(this.projection);
      camera.projectionMatrixInverse.copy(this.inverse);
      renderer.toneMapping = toneMapping;
      renderer.outputColorSpace = colorSpace;
      renderer.autoClear = autoClear;
      renderer.info.autoReset = infoAutoReset;
      renderer.setRenderTarget(target, cubeFace, mip);
      renderer.setViewport(this.viewport);
      renderer.setScissor(this.scissor);
      renderer.setScissorTest(scissorTest);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.movingTarget.dispose();
    this.sampleTarget.dispose();
    for (const target of this.history) target.dispose();
    this.average.dispose();
    this.output.dispose();
    this.stress?.dispose();
    this.quad.dispose();
    this.invalidate();
  }
}
