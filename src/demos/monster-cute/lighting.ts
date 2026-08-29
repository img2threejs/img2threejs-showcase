/**
 * A stage rig lit in the character's own colours.
 *
 * The neutral three-point rig the factory ships (`createMonsterCuteLookDevLights`) is the right
 * default for judging a surface: white light is what lets you see whether a colour is wrong. This
 * is the opposite job — the model has been measured and accepted, and the stage should now belong
 * to the subject. So every light here takes its colour from a region the measurement found, and
 * none of them are a hue the monster does not already wear:
 *
 *   key      the eye-white / fang off-white (#d7d3ce), which is very slightly warm
 *   fill     the pale belly patch (#80a8ba)
 *   rim      the fur hue pushed to saturation, the same accent the effects are made of
 *   bounce   the deep shaded fur, coming up off the floor
 *   ambient  sky from the lit fur, ground from the wristband violet
 *
 * That last pairing is what stops the shadow side going muddy: the only warm-ish, non-blue colour
 * on the whole character is the wristband, so it is the only honest choice for a bounce hue.
 */
import * as THREE from 'three';
import { ACCENT, FIGURE_HEIGHT, PALETTE } from './characterProfile';

const H = FIGURE_HEIGHT;

export interface StageLights {
  group: THREE.Group;
  /** The environment map contribution this rig expects. The scene's own IBL has to come down to
   * match, or five character-coloured lights land on top of a full room's worth of white light and
   * the fur washes out to near-white. */
  environmentIntensity: number;
  /** Slow drift on the rim light, so the silhouette reads while the camera is still. */
  update(elapsed: number): void;
}

export function createMonsterCuteStageLights(): StageLights {
  const group = new THREE.Group();
  group.name = 'monster-cute-stage-lights';

  const ambient = new THREE.HemisphereLight(PALETTE.furLight, PALETTE.band, 0.42);
  group.add(ambient);

  const key = new THREE.DirectionalLight(PALETTE.sclera, 1.75);
  key.position.set(1.5 * H, 1.55 * H, 0.95 * H);   // front-right and above, relative to the measured +X facing
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0012;
  // A shadow camera fitted to the figure rather than left at its default 5-unit box: the default
  // spreads the same map over 25x the area and the contact shadow under the feet goes soft.
  const extent = 1.35 * H;
  key.shadow.camera.left = -extent;
  key.shadow.camera.right = extent;
  key.shadow.camera.top = extent;
  key.shadow.camera.bottom = -extent;
  key.shadow.camera.near = 0.1;
  key.shadow.camera.far = 6 * H;
  group.add(key, key.target);

  const fill = new THREE.DirectionalLight(PALETTE.belly, 0.34);
  fill.position.set(0.35 * H, 0.8 * H, -1.6 * H);  // cool fill from the shadow side
  group.add(fill, fill.target);

  const rim = new THREE.DirectionalLight(ACCENT.energy, 1.15);
  rim.position.set(-1.5 * H, 1.3 * H, -0.7 * H);   // behind the head, so it edges the silhouette
  group.add(rim, rim.target);

  // Up from the floor. Weak and wide: a bounce that reads as a light source is too strong.
  const bounce = new THREE.PointLight(PALETTE.furDeep, 0.55, 3.2 * H, 2);
  bounce.position.set(0, -0.12 * H, 0.35 * H);
  group.add(bounce);

  const rimBase = rim.position.clone();

  return {
    group,
    environmentIntensity: 0.24,
    update(elapsed: number) {
      // A slow orbit of the rim, a quarter turn either side. The point is that the edge light
      // creeps around the silhouette while the subject animates, which keeps a still camera alive.
      const a = Math.sin(elapsed * 0.22) * 0.5;
      rim.position.set(
        rimBase.x * Math.cos(a) - rimBase.z * Math.sin(a),
        rimBase.y,
        rimBase.x * Math.sin(a) + rimBase.z * Math.cos(a),
      );
      rim.intensity = 1.0 + 0.25 * Math.sin(elapsed * 0.5);
    },
  };
}

/**
 * The floor.
 *
 * A shadow-only disc plus a faint additive ring in the fur's deep tone: enough to seat the figure
 * without introducing a surface that competes with it. The ring is what makes the ground read as
 * a stage rather than as nothing.
 */
export function createMonsterCuteGround(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'monster-cute-ground';

  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(2.0 * H, 96),
    new THREE.ShadowMaterial({ opacity: 0.42 }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.receiveShadow = true;
  group.add(shadow);

  const halo = new THREE.Mesh(
    new THREE.RingGeometry(0.42 * H, 1.5 * H, 96),
    new THREE.MeshBasicMaterial({
      color: PALETTE.furDeep, transparent: true, opacity: 0.09,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }),
  );
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = 0.002;
  group.add(halo);

  return group;
}
