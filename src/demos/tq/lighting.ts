import * as THREE from 'three';
import { SIGNATURE } from './characterPalette';

/**
 * The lighting rig, coloured from the character rather than from a neutral studio preset.
 *
 * The export shipped `createStudioLights`: three white lamps at fixed offsets. White lamps are the
 * safe choice and the reason a model can look correct and still look like nobody. Here every lamp
 * takes its hue from `SIGNATURE`, which is the palette measured off her own baked vertex colour:
 *
 *   key    gold, warm and high on her right — the light the filigree is meant to catch, so the
 *          ornament separates from the lacquer instead of dissolving into it.
 *   fill   indigo, low and opposite, lifting the shadow side toward the blue of her plates and
 *          trousers rather than toward grey.
 *   rim    crimson, behind and above, drawing her silhouette in her own dominant colour. This is
 *          the lamp doing the most identity work, which is why it is the brightest of the three.
 *   bounce a dim upward hemisphere standing in for the floor, so the underside of the skirt plates
 *          and the jaw are not black.
 *
 * Every intensity is expressed against the figure's measured height, so the rig re-scales correctly
 * if the character is ever rebuilt at a different normalisation.
 */

export interface StageLights {
  group: THREE.Group;
  key: THREE.DirectionalLight;
  fill: THREE.DirectionalLight;
  rim: THREE.DirectionalLight;
  ambient: THREE.HemisphereLight;
  /** Pulsed by the skills; a cast lifts the room, not just the effect. */
  accent: THREE.PointLight;
}

export function createStageLights(height: number): StageLights {
  const group = new THREE.Group();
  group.name = 'tq:lights';
  const h = height || 1.9;

  const key = new THREE.DirectionalLight(SIGNATURE.gold.clone().lerp(new THREE.Color(0xffffff), 0.45), 2.4);
  key.position.set(h * 0.9, h * 1.35, h * 1.1);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0012;
  // Tight frustum around the figure: a loose one spends the whole shadow map on empty stage.
  const d = h * 1.1;
  key.shadow.camera.left = -d;
  key.shadow.camera.right = d;
  key.shadow.camera.top = d;
  key.shadow.camera.bottom = -d;
  key.shadow.camera.near = 0.1;
  key.shadow.camera.far = h * 6;

  const fill = new THREE.DirectionalLight(SIGNATURE.indigo.clone().lerp(new THREE.Color(0xffffff), 0.25), 1.15);
  fill.position.set(-h * 1.25, h * 0.55, h * 0.8);

  const rim = new THREE.DirectionalLight(SIGNATURE.crimson.clone().lerp(new THREE.Color(0xffffff), 0.15), 2.0);
  rim.position.set(-h * 0.5, h * 1.15, -h * 1.4);

  const ambient = new THREE.HemisphereLight(
    SIGNATURE.gold.clone().lerp(new THREE.Color(0xffffff), 0.6),
    SIGNATURE.indigo.clone().multiplyScalar(0.5),
    0.55,
  );

  // Sits at chest height and brightens while a skill fires; the skills own its intensity.
  const accent = new THREE.PointLight(SIGNATURE.crimson.clone(), 0, h * 4, 2);
  accent.position.set(0, h * 0.62, h * 0.35);

  group.add(key, fill, rim, ambient, accent);
  return { group, key, fill, rim, ambient, accent };
}
