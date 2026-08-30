import * as THREE from 'three';
import { VFX, MEASURED } from './palette';
import type { RigFrame } from './rigFrame';

/**
 * The floor and the backdrop.
 *
 * Both are palette-driven for the same reason the lights are: a neutral grey stage under a green
 * rim light turns green anyway, but muddily, and the figure stops sitting in a place. The floor
 * here is dark leather-shadow with a faint toxic grid that fades out with distance, so the eye
 * gets a ground plane and a sense of scale without a second light.
 */
export interface Stage {
  group: THREE.Group;
  ground: THREE.Mesh;
  /**
   * Slide the grid by a world-space XZ distance. The plane is laid flat by a -90 degree rotation
   * about X, which maps its local (x, y) to world (x, -z), so the world offset is converted here
   * rather than at every call site.
   */
  scroll(worldX: number, worldZ: number): void;
}

export function createStage(frame: RigFrame): Stage {
  const h = frame.figureHeight;
  const group = new THREE.Group();
  group.name = 'roblin-stage';

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uBase: { value: new THREE.Color(MEASURED.crevice.hex) },
      uGrid: { value: new THREE.Color(VFX.venom.value) },
      uRadius: { value: h * 5.5 },
      uCell: { value: h * 0.42 },
      uScroll: { value: new THREE.Vector2(0, 0) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vLocal;
      void main() {
        vLocal = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uBase;
      uniform vec3 uGrid;
      uniform float uRadius;
      uniform float uCell;
      uniform vec2 uScroll;
      varying vec3 vLocal;

      void main() {
        // The radial falloff does NOT scroll: the pool of floor stays under the figure while the
        // grid pattern slides through it, which is what makes running in place read as travel.
        float d = length(vLocal.xy) / uRadius;
        if (d > 1.0) discard;
        // Analytic anti-aliased grid: distance to the nearest cell line, in pixels.
        vec2 cell = (vLocal.xy + uScroll) / uCell;
        vec2 grid = abs(fract(cell - 0.5) - 0.5) / fwidth(cell);
        float line = 1.0 - min(min(grid.x, grid.y), 1.0);
        float falloff = pow(1.0 - d, 2.2);
        vec3 colour = uBase * (0.35 + 0.65 * falloff) + uGrid * line * 0.5 * falloff;
        gl_FragColor = vec4(colour, falloff * 0.96 + 0.04);
      }
    `,
    transparent: true,
    // NO DEPTH WRITE, and this is the fix for a real defect: the toes are grounded to y = 0 and the
    // floor sits at y = 0 too. A transparent surface that writes depth is drawn in the transparent
    // pass and then occludes anything at or below its own plane, so the bottom of each foot was
    // being cut away by the floor it was standing on — invisible at gallery framing, obvious the
    // moment you zoom in on the feet.
    depthWrite: false,
  });

  // A disc, not an infinite plane: the edge fading into black is what keeps the backdrop from
  // needing a horizon it does not have.
  const ground = new THREE.Mesh(new THREE.CircleGeometry(h * 5.5, 96), material);
  ground.rotation.x = -Math.PI / 2;
  ground.name = 'roblin-ground';
  // Below the feet, not level with them, and drawn first.
  ground.position.y = -0.004;
  ground.renderOrder = -2;

  // Shadows land on their own surface so the shader floor above stays cheap and unlit.
  const shadowMaterial = new THREE.ShadowMaterial({ opacity: 0.45 });
  // Same reason as the floor above: ShadowMaterial is transparent and writes depth by default, and
  // at y = +0.001 it was slicing the last millimetre off every toe.
  shadowMaterial.depthWrite = false;
  const shadowCatcher = new THREE.Mesh(new THREE.CircleGeometry(h * 3.2, 64), shadowMaterial);
  shadowCatcher.rotation.x = -Math.PI / 2;
  shadowCatcher.position.y = -0.002;
  shadowCatcher.renderOrder = -1;
  shadowCatcher.receiveShadow = true;

  group.add(ground, shadowCatcher);
  return {
    group,
    ground,
    scroll(worldX: number, worldZ: number) {
      material.uniforms.uScroll.value.set(worldX, -worldZ);
    },
  };
}

/**
 * A framing that shows Roblin's face AND lets a bolt cross the frame.
 *
 * The download's `MONSTER_1_CAMERA` puts the camera on +z. This rig's measured lateral axis is
 * ALSO z — the T-pose arm span is what makes the exported bounding box 2.11 "deep" on a 1.9-tall
 * figure — so that camera looks straight at the character's right ear. The camera below is built
 * from the MEASURED basis instead.
 *
 * The lateral SIGN is the part that matters and it is not arbitrary. With the body basis
 * orthonormal and right-handed (left x up = forward), a camera placed on the character's LEFT
 * sees +forward running to screen LEFT: screen-right works out to `0.39*left - 0.91*forward`. A
 * ranged bolt travelling down +forward then leaves frame immediately, which is exactly what the
 * first capture of this scene did. Placing the camera on the character's RIGHT flips that term to
 * `+0.91*forward`, so the bolt crosses the frame left to right and the impact stays on screen.
 *
 * The two components are balanced rather than lateral-heavy: at 2.0 forward against 2.2 lateral
 * the view sits 42 degrees off a profile, which reads as a three-quarter portrait, and screen-right
 * still resolves to `0.74*forward` so a bolt crosses about three quarters of the frame. A
 * lateral-heavy version of this camera was tried first and gave a clean profile with no face in it.
 */
export function frameCamera(frame: RigFrame, camera: THREE.PerspectiveCamera): THREE.Vector3 {
  const h = frame.figureHeight;
  // The orbit target is pushed down the firing line, which sits Roblin left of centre and leaves
  // the right of the frame for the bolt and its impact. How far it can be pushed is a trade, and
  // both ends of it were tried: framing the figure dead centre throws every detonation off the
  // right edge, and pushing the target a full figure-height shrinks Roblin to a third of the frame.
  // 0.8 keeps the figure at roughly 60% of frame height, clear of the left-hand panel, and puts
  // the detonation at about 0.75 in normalised device coordinates — inside the frame with margin.
  const target = new THREE.Vector3()
    .addScaledVector(frame.up, h * 0.58)
    .addScaledVector(frame.forward, h * 0.8);
  camera.position.copy(target)
    .addScaledVector(frame.forward, h * 2.0)
    .addScaledVector(frame.left, -h * 2.3)
    .addScaledVector(frame.up, h * 0.3);
  camera.lookAt(target);
  return target;
}
