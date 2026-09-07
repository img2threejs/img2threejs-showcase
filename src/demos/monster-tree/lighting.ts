import * as THREE from 'three';
import { PALETTE } from './measured';

/**
 * Low-key moonlit forest rig. Cool key/fill/rim separate the original brown bark from the dark
 * trees; a restrained bark-coloured bounce preserves the underside of the limbs. Hemisphere
 * and environment stay low so the sky shafts and summoned warm lanterns have room to read.
 * The moving point lights and tapered sky spotlights live in GrootAtmosphere, not this group.
 */
export function createMonsterTreeLights(figureHeight = 1.9): THREE.Group {
  const group = new THREE.Group();
  group.name = 'monster-tree-lights';
  const h = figureHeight;

  const key = new THREE.DirectionalLight(new THREE.Color('#d8e3f4'), 1.25);
  key.name = 'key';
  key.position.set(h * 1.15, h * 1.30, h * 0.85);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0006;
  key.shadow.normalBias = 0.02;
  const extent = h * 3.8;
  key.shadow.camera.left = -extent;
  key.shadow.camera.right = extent;
  key.shadow.camera.top = extent;
  key.shadow.camera.bottom = -extent;
  key.shadow.camera.near = 0.1;
  key.shadow.camera.far = h * 6;
  group.add(key, key.target);

  const fill = new THREE.DirectionalLight(new THREE.Color('#859cad'), .32);
  fill.name = 'fill';
  fill.position.set(-h * 1.0, h * 0.75, -h * 0.55);
  group.add(fill, fill.target);

  // Behind and low, so it catches the branch crown and the outer edge of every limb.
  const rim = new THREE.DirectionalLight(new THREE.Color('#a8c9eb'), 1.05);
  rim.name = 'rim';
  rim.position.set(-h * 0.55, h * 0.42, -h * 1.25);
  group.add(rim, rim.target);

  const bounce = new THREE.DirectionalLight(new THREE.Color(PALETTE.barkMid), 0.10);
  bounce.name = 'bounce';
  bounce.position.set(0, -h * 0.6, h * 0.5);
  group.add(bounce, bounce.target);

  // Cool sky and dark warm ground preserve a directional ambient cue.
  const sky = new THREE.HemisphereLight(new THREE.Color('#8398ac'), new THREE.Color('#17100b'), 0.14);
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
  g.addColorStop(0, '#101c29');
  g.addColorStop(0.55, '#050b12');
  g.addColorStop(1, '#020408');
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
      color: new THREE.Color(PALETTE.barkDark).multiplyScalar(0.10),
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
