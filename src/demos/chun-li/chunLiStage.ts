import * as THREE from 'three';
import { FIGURE_HEIGHT } from './chunLiEvents';

/**
 * The look-dev rig.
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
 * and third only produce crossing shadows across her own body. There is no floor to catch a cast
 * shadow any more, so what the map still buys is SELF-shadowing — the raised arm darkening the
 * chest under it, the skirt panel on the thigh — which is most of what gives the shell its depth.
 * The camera is fitted to a 1.4 H box around the origin, tight enough for 2048 to stay sharp.
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

  // Two stationary accents at ankle height. With the floor gone they no longer have a large
  // surface to tint, so they are dimmer than they were and now do one job only: keeping the boots
  // and the lower thigh from falling into the background.
  const accentCool = new THREE.PointLight(0x2f7fe8, 5, H * 2.4, 2);
  accentCool.position.set(-H * 0.85, H * 0.3, -H * 0.55);
  const accentWarm = new THREE.PointLight(0xffb444, 3.5, H * 2.0, 2);
  accentWarm.position.set(H * 0.95, H * 0.24, H * 0.6);

  rig.add(key, fill, rim, rimB, bounce, ambient, accentCool, accentWarm);
  return rig;
}
