import * as THREE from 'three';
import { FIGURE_HEIGHT } from './chunLiEvents';

/**
 * The look-dev rig and the floor she stands on.
 *
 * WHY THIS IS NOT THE DEFAULT STUDIO RIG. The download ships `createStudioLights` — a neutral
 * three-point rig that exists so a fresh model is never lit by nothing. It is the right default and
 * the wrong answer here: it lights a subject, and this demo has to light a subject AND the effects
 * that fly off her. Two things follow from that.
 *
 *   THE FILL IS DELIBERATELY LOW. Ki reads as light only where the surroundings are darker than it
 *   is. A generous ambient fill is flattering to the qipao and fatal to the effects: the blue is
 *   still there, but it stops looking emitted. The fill here is a quarter of the key and cool, so
 *   the shadow side keeps its shape without ever competing with a spark.
 *
 *   THE RIM IS THE STRONGEST LIGHT IN THE RIG. She is a blue figure against a dark stage, which is
 *   exactly the case where a silhouette disappears. A hard cool backlight at 3.4 draws a bright
 *   edge down her arm, her thigh and the boot, and that edge is what makes the pose readable
 *   through a burst of particles crossing in front of it.
 *
 * THE KEY IS THE ONLY SHADOW CASTER. Three shadow maps for one figure is two too many: the second
 * and third only produce crossing shadows the eye reads as dirt on the floor. The camera is fitted
 * to a 1.4 H box around the origin, which is tight enough for 2048 to be sharp at the boot laces.
 *
 * The colours are hers: a warm key against a cool fill and rim, because her palette is cobalt and
 * gold and a neutral-white rig makes cobalt read grey.
 */
export function createChunLiStageLights(): THREE.Group {
  const rig = new THREE.Group();
  rig.name = 'chun-li-stage';
  const H = FIGURE_HEIGHT;

  const key = new THREE.DirectionalLight(0xfff0d8, 3.1);
  key.position.set(H * 1.5, H * 2.1, H * 1.35);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 0.05;
  key.shadow.camera.far = H * 8;
  const span = H * 1.4;
  key.shadow.camera.left = -span;
  key.shadow.camera.right = span;
  key.shadow.camera.top = span;
  key.shadow.camera.bottom = -span;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.018;

  const fill = new THREE.DirectionalLight(0x8fb8ff, 0.78);
  fill.position.set(-H * 1.9, H * 1.0, H * 1.5);

  const rim = new THREE.DirectionalLight(0xdaf0ff, 3.4);
  rim.position.set(-H * 0.9, H * 1.7, -H * 2.1);

  // A second rim on the other shoulder, so a three-quarter turn never loses the edge entirely.
  const rimB = new THREE.DirectionalLight(0xbfd8ff, 1.5);
  rimB.position.set(H * 1.4, H * 1.5, -H * 1.7);

  // Bounce off the floor: without it the underside of the thigh and the boot go to black.
  const bounce = new THREE.DirectionalLight(0xffd9a8, 0.42);
  bounce.position.set(H * 0.4, -H * 0.6, H * 1.1);

  const ambient = new THREE.HemisphereLight(0xbcd6ff, 0x14161f, 0.42);

  // Two stationary accents at ankle height. They do almost nothing to her and a great deal to the
  // floor, which is where they put the colour that separates the stage from the background.
  const accentCool = new THREE.PointLight(0x2f7fe8, 9, H * 3.2, 2);
  accentCool.position.set(-H * 0.85, H * 0.28, -H * 0.55);
  const accentWarm = new THREE.PointLight(0xffb444, 6, H * 2.6, 2);
  accentWarm.position.set(H * 0.95, H * 0.22, H * 0.6);

  rig.add(key, fill, rim, rimB, bounce, ambient, accentCool, accentWarm);
  rig.add(createStageFloor(H));
  return rig;
}

/**
 * The floor. A lit disc that takes the key's shadow, and above it two unlit rings that turn — one
 * cobalt, one gold, counter-rotating.
 *
 * The disc's alpha map fades it to nothing at the edge. A hard-edged floor plate against a gradient
 * background draws a horizon line the eye follows instead of following her, and cropping the plate
 * to the shadow's reach is the cheapest way to not have one.
 */
function createStageFloor(H: number): THREE.Group {
  const floor = new THREE.Group();
  floor.name = 'chun-li-floor';

  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(H * 1.65, 96),
    new THREE.MeshStandardMaterial({
      color: 0x2a3346,
      roughness: 0.62,
      metalness: 0.28,
      transparent: true,
      alphaMap: radialFade(),
      depthWrite: false,
    }),
  );
  disc.rotation.x = -Math.PI / 2;
  disc.receiveShadow = true;
  disc.name = 'stage-floor';
  // Not part of the subject: keeps it out of the parts list, the framing fit and the picker.
  disc.userData.isHighlight = true;

  const ringOuter = turnRing(H * 1.18, H * 1.24, 0x4fc3ff, 0.5);
  const ringInner = turnRing(H * 0.72, H * 0.75, 0xffcf5c, 0.42);
  const ticks = tickRing(H * 0.96, 0x9fd8ff, 0.34);

  floor.add(disc, ringOuter, ringInner, ticks);
  floor.userData.tick = (dt: number): void => {
    ringOuter.rotation.z += dt * 0.16;
    ringInner.rotation.z -= dt * 0.26;
    ticks.rotation.z += dt * 0.08;
  };
  return floor;
}

function turnRing(inner: number, outer: number, colour: number, opacity: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(inner, outer, 128, 1),
    new THREE.MeshBasicMaterial({
      color: colour, transparent: true, opacity,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.006;
  mesh.userData.isHighlight = true;
  return mesh;
}

/** Twenty-four short radial marks — a dial, not a solid ring, so the floor reads as a fighting stage. */
function tickRing(radius: number, colour: number, opacity: number): THREE.Group {
  // Laid out in the group's XY plane and the GROUP tipped flat, so the ticker can spin the whole
  // dial on one axis. Rotating each mark individually would need the same turn applied 24 times.
  const dial = new THREE.Group();
  dial.rotation.x = -Math.PI / 2;
  dial.position.y = 0.007;
  dial.userData.isHighlight = true;
  const geometry = new THREE.PlaneGeometry(radius * 0.055, radius * 0.012);
  const material = new THREE.MeshBasicMaterial({
    color: colour, transparent: true, opacity,
    side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const mark = new THREE.Mesh(geometry, material);
    mark.position.set(Math.cos(a) * radius, Math.sin(a) * radius, 0);
    mark.rotation.z = a;
    mark.userData.isHighlight = true;
    dial.add(mark);
  }
  return dial;
}

/** White at the centre, transparent at the rim — used as the floor disc's alpha map. */
function radialFade(): THREE.Texture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(size, size);
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - half) / half;
      const dy = (y + 0.5 - half) / half;
      const r = Math.min(1, Math.sqrt(dx * dx + dy * dy));
      // Flat out to 45% of the radius, then a smooth shoulder to nothing at the edge.
      const t = r < 0.45 ? 1 : Math.pow(1 - (r - 0.45) / 0.55, 1.6);
      const i = (y * size + x) * 4;
      image.data[i] = 255;
      image.data[i + 1] = 255;
      image.data[i + 2] = 255;
      image.data[i + 3] = Math.round(Math.max(0, t) * 255);
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
}
