import * as THREE from 'three';
import { PALETTE } from './measured';
import { lifeColour } from './vfx';

/**
 * The stage rig, lit in the character's own colours.
 *
 * Every colour here is either a measured hex from `PALETTE` — sampled off the reference photograph
 * — or built from `LIFE_HUE`, the hue of the character's iris. There is no neutral white light in
 * this rig, because a treant lit in studio white reads as grey driftwood: the bark's measured
 * albedo is only #4b3e2b, so what little colour it has has to come from the light.
 *
 * The four lights, and what each is for:
 *
 *   key      warm and high, tinted toward `barkLight`. Carries the bark relief — the deep vertical
 *            grain is the character's whole silhouette read close up, and it only shows under a
 *            light with a strong angle to it.
 *   fill     the reference's own NEUTRAL studio grey, `studioAmbient` #6b6f69, from the opposite
 *            side. This one is load-bearing. Every other measured colour in the palette is warm or
 *            green, and lighting the figure only from those drove the render's blue channel to
 *            about 4/255 — measured off the torso — which reads as lime however the greens are
 *            balanced. The reference's bark is grey-brown and only its moss and eyes are green;
 *            recovering that needed a light with blue in it, and the photograph had one.
 *   rim      the life hue at full saturation, low and behind. This is the one that sells the
 *            character: it separates the branch crown from the background and puts the same green
 *            as the eyes along every edge.
 *   bounce   dim, upward, `barkDark`. Stands in for ground bounce so the underside of the arms and
 *            the root-feet do not go to black.
 *
 * Intensities are in three's physical units and assume `useLegacyLights = false`, which is the
 * default from r155 on.
 *
 * The rig is deliberately UNBALANCED toward the key and the rim, with the ambient terms — fill,
 * bounce, hemisphere, environment — held low. Raising the ambient lifts the backdrop and the floor
 * at the same rate as the figure, so the whole frame gets brighter and nothing gains attention.
 * Keeping them down lets the character and the light streams be the only things above the floor
 * of the image. They are high — the key sits at 6.4 — because the measured bark albedo is
 * only #4b3e2b, about 0.06 in linear. Lighting this figure at the intensities a mid-grey subject
 * wants leaves it a silhouette.
 */
export function createMonsterTreeLights(figureHeight = 1.9): THREE.Group {
  const group = new THREE.Group();
  group.name = 'monster-tree-lights';
  const h = figureHeight;

  const key = new THREE.DirectionalLight(new THREE.Color(PALETTE.barkLight).convertSRGBToLinear(), 6.4);
  key.name = 'key';
  key.position.set(h * 1.15, h * 1.30, h * 0.85);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0006;
  key.shadow.normalBias = 0.02;
  const extent = h * 1.25;
  key.shadow.camera.left = -extent;
  key.shadow.camera.right = extent;
  key.shadow.camera.top = extent;
  key.shadow.camera.bottom = -extent;
  key.shadow.camera.near = 0.1;
  key.shadow.camera.far = h * 6;
  group.add(key, key.target);

  const fill = new THREE.DirectionalLight(new THREE.Color(PALETTE.studioAmbient).convertSRGBToLinear(), 2.5);
  fill.name = 'fill';
  fill.position.set(-h * 1.0, h * 0.75, -h * 0.55);
  group.add(fill, fill.target);

  // Behind and low, so it catches the branch crown and the outer edge of every limb.
  const rim = new THREE.DirectionalLight(lifeColour(0.46, 0.88), 1.35);
  rim.name = 'rim';
  rim.position.set(-h * 0.55, h * 0.42, -h * 1.25);
  group.add(rim, rim.target);

  const bounce = new THREE.DirectionalLight(new THREE.Color(PALETTE.barkMid).convertSRGBToLinear(), 0.75);
  bounce.name = 'bounce';
  bounce.position.set(0, -h * 0.6, h * 0.5);
  group.add(bounce, bounce.target);

  // A hemisphere pair rather than an ambient: sky takes the rim's green, ground takes the bark's
  // dark, so ambient fill still has a direction to it.
  const sky = new THREE.HemisphereLight(new THREE.Color(PALETTE.studioAmbient).convertSRGBToLinear(), new THREE.Color(PALETTE.barkMid).convertSRGBToLinear(), 0.72);
  sky.name = 'hemi';
  group.add(sky);

  return group;
}

/**
 * A dark radial backdrop in the bark's own dark tone, so the figure sits in a grove rather than on
 * a white sweep. Painted into a canvas — no texture file, nothing fetched.
 */
export function createBackdrop(): THREE.Texture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size * 0.42, 0, size / 2, size * 0.42, size * 0.72);
  // Neutral-brown, not olive. This texture is also the scene ENVIRONMENT, so whatever colour it
  // is gets multiplied into every lit surface as ambient — an olive backdrop tints the whole
  // figure green before a single light is added.
  g.addColorStop(0, '#20211d');
  g.addColorStop(0.55, '#121110');
  g.addColorStop(1, '#050505');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.mapping = THREE.EquirectangularReflectionMapping;
  return texture;
}

/**
 * The ground the shockwaves land on.
 *
 * Faded out with an alpha map rather than ended at a rim, because a lit disc that stops has a
 * horizon, and a horizon across the frame reads as a green field with a tree standing on it — the
 * rim light alone is enough to turn the whole disc into a lawn. Dissolving the edge keeps the
 * contact shadow and the shockwaves while letting the figure sit in the dark.
 */
export function createGround(figureHeight = 1.9): THREE.Mesh {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.26, '#9a9a9a');
  g.addColorStop(0.54, '#101010');
  g.addColorStop(1, '#000000');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const alphaMap = new THREE.CanvasTexture(canvas);

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(figureHeight * 1.9, 96),
    new THREE.MeshStandardMaterial({
      // Far darker than the bark it is tinted from. A horizontal plane faces straight up into the
      // green hemisphere and takes the green rim at a grazing angle, so anything near the bark's
      // own #231f12 pools into a lit lawn under the figure.
      color: new THREE.Color(PALETTE.barkDark).convertSRGBToLinear().multiplyScalar(0.10),
      roughness: 1,
      metalness: 0,
      alphaMap,
      transparent: true,
      depthWrite: false,
    }),
  );
  ground.name = 'ground';
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.renderOrder = -1;
  return ground;
}
