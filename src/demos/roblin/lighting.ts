import * as THREE from 'three';
import { VFX, MEASURED } from './palette';
import type { RigFrame } from './rigFrame';

/**
 * Roblin's light rig — every colour in it comes from the figure's own measured palette.
 *
 * The download shipped `createMonster1LookDevLights()`: a neutral three-point rig the generator
 * writes for every model it produces. It is honest and it is dull, and it is explicitly labelled
 * "replace with a look-dev rig when you have one". This is that rig.
 *
 * The reasoning, since "coloured lights" is easy to do badly:
 *
 *   KEY is nearly white, warmed a few percent toward the leather hue. Tint the key and the
 *   character's own albedo stops being readable — you end up reviewing the lighting instead of
 *   the model. It is the only light here that is close to neutral.
 *
 *   RIM is `toxic`, placed BEHIND and above, opposite the key. This is the light doing the most
 *   work: a saturated back-rim in the character's own hue separates a dark green figure from a
 *   dark background, which no amount of front light achieves. It also pre-lights the figure in
 *   the colour the effects will fire in, so a cast does not introduce a hue the scene has never
 *   shown.
 *
 *   FILL is `ember`, low and opposite the rim. Green rim against green fill would collapse into
 *   one hue; the warm fill is what keeps the shaded side of the model from going flat.
 *
 *   BOUNCE is `bounce` — the figure's own crevice colour — thrown up from the floor, standing in
 *   for the light a real floor would return.
 *
 *   HEMISPHERE is toxic over bounce at low intensity: ambient that still belongs to this palette
 *   rather than the grey that `RoomEnvironment` alone gives.
 *
 * Distances and heights are multiples of the MEASURED figure height, so the rig rescales with the
 * subject instead of carrying numbers tuned to one model.
 */

export interface LightRig {
  group: THREE.Group;
  key: THREE.DirectionalLight;
  rim: THREE.SpotLight;
  fill: THREE.DirectionalLight;
  bounce: THREE.PointLight;
  hemisphere: THREE.HemisphereLight;
  /** Push the rim toward a cast colour and back. 0 = resting, 1 = full cast tint. */
  surge(colour: THREE.Color, amount: number): void;
  update(delta: number): void;
  log: string[];
}

export function createRoblinLightRig(frame: RigFrame): LightRig {
  const h = frame.figureHeight;
  const group = new THREE.Group();
  group.name = 'roblin-light-rig';

  // The rig is built in the figure's own measured basis, not in world x/y/z, so it stays correct
  // whichever way the export happens to have the model facing.
  const { forward, up, left } = frame;
  const at = (f: number, u: number, l: number): THREE.Vector3 => new THREE.Vector3()
    .addScaledVector(forward, f * h)
    .addScaledVector(up, u * h)
    .addScaledVector(left, l * h);

  const chestHeight = new THREE.Vector3().addScaledVector(up, h * 0.62);

  const keyColour = new THREE.Color(MEASURED.leatherLit.hex).lerp(new THREE.Color(0xffffff), 0.86);
  const key = new THREE.DirectionalLight(keyColour, 3.1);
  // Camera side. The default camera sits at (forward 2.0, left -2.2), so a key on +left lights the
  // half of the figure the viewer cannot see — which is exactly what the first version of this rig
  // did. Keeping the key ~35 degrees off the camera axis is what puts modelling on the visible side.
  key.position.copy(at(0.95, 1.3, -1.85));
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 0.1;
  key.shadow.camera.far = h * 6;
  const extent = h * 0.95;
  Object.assign(key.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent });
  key.shadow.bias = -0.0009;
  key.shadow.normalBias = 0.02;

  // A spot rather than a directional: the cone puts the green edge on the figure and lets the
  // floor behind it stay dark, which is what makes the rim read as a rim and not as a wash.
  const rim = new THREE.SpotLight(VFX.toxic.value, 96, h * 5, Math.PI * 0.24, 0.55, 1.6);
  // Behind and across from the key, so the green edge traces the contour the camera reads as the
  // figure's back — the separation from the dark backdrop that no front light can produce.
  rim.position.copy(at(-1.55, 1.4, 0.85));
  rim.target.position.copy(chestHeight);

  // Low, frontal and warm: it opens up the shaded side without competing with the key, and it is
  // the only thing stopping a green rim over a green figure from collapsing into one hue.
  const fill = new THREE.DirectionalLight(VFX.ember.value, 1.35);
  fill.position.copy(at(1.7, 0.2, 0.5));

  const bounce = new THREE.PointLight(VFX.bounce.value, 6, h * 2.4, 2);
  bounce.position.copy(at(0.4, 0.06, 0));

  const hemisphere = new THREE.HemisphereLight(VFX.toxic.value, VFX.bounce.value, 0.42);

  group.add(key, key.target, rim, rim.target, fill, bounce, hemisphere);
  key.target.position.copy(chestHeight);

  const restingRim = new THREE.Color(VFX.toxic.value);
  const restingIntensity = rim.intensity;
  const surgeColour = new THREE.Color();
  let surgeAmount = 0;

  return {
    group,
    key,
    rim,
    fill,
    bounce,
    hemisphere,
    surge(colour, amount) {
      surgeColour.copy(colour);
      surgeAmount = Math.max(surgeAmount, amount);
    },
    update(delta) {
      // A cast recolours the rim for a moment, so the scene reacts to the effect instead of the
      // effect floating on top of a scene that never noticed.
      if (surgeAmount > 0) {
        rim.color.copy(restingRim).lerp(surgeColour, Math.min(1, surgeAmount));
        // 0.4, not the 1.35 this started at. A full surge used to more than double a 96-intensity
        // spot to 195 and the figure rendered as a white silhouette — measured off the live scene,
        // not guessed. The surge is meant to tint the rim, not to become the key light.
        rim.intensity = restingIntensity * (1 + surgeAmount * 0.4);
        surgeAmount = Math.max(0, surgeAmount - delta * 2.1);
        if (surgeAmount === 0) {
          rim.color.copy(restingRim);
          rim.intensity = restingIntensity;
        }
      }
    },
    log: [
      `key        ${'#' + keyColour.getHexString()}  ${MEASURED.leatherLit.id} lerped 86% to white, camera side, intensity ${key.intensity}`,
      `rim        ${VFX.toxic.hex}  ${VFX.toxic.id}, spot behind and across from the key, intensity ${rim.intensity}`,
      `fill       ${VFX.ember.hex}  ${VFX.ember.id}, opposite the rim, intensity ${fill.intensity}`,
      `bounce     ${VFX.bounce.hex}  ${VFX.bounce.id}, floor level, intensity ${bounce.intensity}`,
      `hemisphere ${VFX.toxic.hex} over ${VFX.bounce.hex}, intensity ${hemisphere.intensity}`,
      `all positions are multiples of the measured figure height ${h.toFixed(3)}`,
    ],
  };
}
