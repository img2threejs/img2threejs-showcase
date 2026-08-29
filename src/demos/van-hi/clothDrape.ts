import * as THREE from 'three';

/**
 * Secondary motion for the gown, added after skinning in the vertex shader.
 *
 * WHY IT IS NEEDED. `garmentSeparation` hangs the whole robe from the trunk and the two collarbones
 * and from nothing else, because letting the sleeves track their own forearm is what tore the fabric
 * apart — the right sleeve panel lies against the skirt at mid-thigh, and two vertices 9.7 mm apart
 * pulling toward an arm and a hip end up 1.74 m apart. That repair is correct and it is also inert:
 * a garment welded to the spine is a painted cone. Everything the skinning gave up is given back
 * here, where it costs nothing, because a displacement applied after skinning cannot separate two
 * vertices that agree about it — and neighbouring vertices agree by construction, since the
 * displacement is a smooth function of position and of `aDrape`.
 *
 * WHAT DRIVES IT, IN THREE LAYERS.
 *
 *   drift    A travelling wave down the cloth. Two frequencies that do not divide each other, so
 *            the loop never lines up with itself and the fabric does not visibly repeat.
 *   lag      The garment trails the body. The hip's own velocity is low-passed and the difference —
 *            what the body did that the cloth has not caught up with yet — pushes the fabric the
 *            other way. This is the layer that reads as weight.
 *   swing    Angular lag about the vertical, from the same filter applied to the body's facing, so
 *            a turn makes the hem sweep out instead of rotating rigidly with the hips.
 *
 * Every layer scales with `aDrape`, which `garmentSeparation` measures as geodesic distance from the
 * cloth's attachment: 0 where the gown is held against the body and 1 at the end of its reach. So
 * the collar and the bodice do not move at all, and the train and the sleeve tips move most. Scaling
 * by `aDrape` SQUARED rather than linearly keeps the middle of a panel from flapping — cloth pinned
 * at one end bends, it does not translate.
 *
 * WHAT IT DOES NOT DO. It does not collide. A skirt hem driven by wind can pass through a shin; this
 * is a display effect over a skinned mesh, not a solver, and it is tuned small enough — see
 * `HEM_TRAVEL` — that the intersection stays inside the fabric's own thickness for the shipped clips.
 * Normals are left as skinned, which is right for a displacement this size: recomputing them per
 * frame would cost a second pass over 204,256 triangles to change the shading by less than the
 * dither.
 */

/**
 * How far the furthest cloth may travel from where skinning put it, in figure heights.
 *
 * 0.012 is 2.3 cm on the 1.9 m figure. Set against the gown's own clearance: the hem sits 3-5 cm off
 * the shin through the walk and run cycles, so travel at this amplitude stays inside the gap and the
 * leg does not surface through the skirt. At 0.03 it does, on `preset:run`, twice a cycle.
 */
const HEM_TRAVEL = 0.012;

/** Seconds the lag filter takes to catch up. Longer reads as heavier cloth; 0.28 s reads as silk. */
const LAG_SECONDS = 0.28;

/** Metres of lag that produce one unit of `HEM_TRAVEL`, so a fast turn saturates instead of exploding. */
const LAG_SATURATION = 0.35;

export interface ClothDrape {
  /** Call once per frame, before rendering, with the frame delta in seconds. */
  update: (deltaSeconds: number) => void;
  /** Amplitude scale, 0 disables the effect entirely. Exposed so a capture run can freeze the cloth. */
  setStrength: (strength: number) => void;
  dispose: () => void;
}

/**
 * Attach the drape to a garment mesh.
 *
 * `carrier` is the bone the lag is read from — the hip, whose motion is the body's motion. It must
 * be a bone of the same skeleton, so its world matrix is already up to date when `update` runs.
 */
export function attachClothDrape(
  mesh: THREE.SkinnedMesh,
  drape: Float32Array,
  carrier: THREE.Object3D,
): ClothDrape {
  mesh.geometry.setAttribute('aDrape', new THREE.BufferAttribute(drape, 1));

  const uniforms = {
    uClothTime: { value: 0 },
    uClothStrength: { value: 1 },
    /** Body motion the cloth has not caught up with, in the mesh's own local space. */
    uClothLag: { value: new THREE.Vector3() },
    /** Angular lag about the vertical, radians. */
    uClothSwing: { value: 0 },
  };

  const material = mesh.material as THREE.MeshStandardMaterial;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aDrape;
        uniform float uClothTime;
        uniform float uClothStrength;
        uniform vec3 uClothLag;
        uniform float uClothSwing;`)
      // After skinning, so the displacement rides the posed surface rather than the bind pose.
      .replace('#include <skinning_vertex>', `#include <skinning_vertex>
        {
          float hold = aDrape * aDrape * uClothStrength;
          if (hold > 0.0) {
            // Two frequencies with an irrational-ish ratio: the wave never repeats on the loop.
            float a = uClothTime * 1.7 + transformed.y * -9.0 + transformed.x * 3.1;
            float b = uClothTime * 1.13 + transformed.y * -6.4 + transformed.z * 3.7;
            vec3 drift = vec3(sin(a) * 0.6, sin(a + b) * 0.18, cos(b) * 0.6);
            // Swing about the vertical: the hem sweeps out of a turn instead of following it.
            vec2 radial = vec2(transformed.x, transformed.z);
            vec3 swing = vec3(-radial.y, 0.0, radial.x) * uClothSwing;
            transformed += (drift * ${HEM_TRAVEL.toFixed(4)} + uClothLag + swing) * hold;
          }
        }`);
  };
  // Forces a recompile if the material was already used, and keys the program cache to this variant.
  material.customProgramCacheKey = () => 'van-hi-cloth-drape';
  material.needsUpdate = true;

  const carrierWorld = new THREE.Vector3();
  const carrierSmoothed = new THREE.Vector3();
  const carrierForward = new THREE.Vector3();
  const smoothedForward = new THREE.Vector3(0, 0, 1);
  const scratch = new THREE.Vector3();
  const inverse = new THREE.Matrix4();
  let started = false;

  const update = (deltaSeconds: number): void => {
    const step = Math.min(deltaSeconds, 1 / 20);
    uniforms.uClothTime.value += step;

    carrier.getWorldPosition(carrierWorld);
    carrier.getWorldDirection(carrierForward);
    if (!started) {
      started = true;
      carrierSmoothed.copy(carrierWorld);
      smoothedForward.copy(carrierForward);
    }
    // One-pole low pass. The alpha is derived from the time constant rather than fixed per frame, so
    // the cloth behaves the same at 30 fps and at 144.
    const alpha = 1 - Math.exp(-step / LAG_SECONDS);
    carrierSmoothed.lerp(carrierWorld, alpha);
    smoothedForward.lerp(carrierForward, alpha).normalize();

    // Where the body has got to, minus where the cloth thinks it is — in the mesh's local space, so
    // the displacement is added to `transformed` in the units the shader works in.
    scratch.subVectors(carrierSmoothed, carrierWorld);
    inverse.copy(mesh.matrixWorld).invert();
    scratch.transformDirection(inverse);
    const reach = scratch.length() / LAG_SATURATION;
    // Saturating rather than clamping: a hard clamp shows as the cloth stopping dead mid-swing.
    scratch.setLength(HEM_TRAVEL * (reach > 0 ? Math.tanh(reach) : 0));
    uniforms.uClothLag.value.copy(scratch);

    const swing = Math.atan2(smoothedForward.x, smoothedForward.z) - Math.atan2(carrierForward.x, carrierForward.z);
    const wrapped = Math.atan2(Math.sin(swing), Math.cos(swing));
    uniforms.uClothSwing.value = Math.tanh(wrapped) * 0.6;
  };

  return {
    update,
    setStrength: (strength: number) => { uniforms.uClothStrength.value = strength; },
    dispose: () => {
      mesh.geometry.deleteAttribute('aDrape');
      material.onBeforeCompile = () => {};
      material.customProgramCacheKey = () => '';
      material.needsUpdate = true;
    },
  };
}
