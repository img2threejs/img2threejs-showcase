import * as THREE from 'three';

// One place that owns the scene lights and the slow transitions between looks:
//   theme  0..1  sunny ship  ->  Halloween ship (decorations, aged cloth)
//   night  0..1  day -> sunset -> night (sky, sea and lights; the sea module renders the sky)
//   rain   0..1  clear -> light rain -> storm with lightning
// Every value eases toward its target, so presets and sliders never pop.
const DAY = Object.freeze({
  hemiSky: new THREE.Color(0xe7f6ff), hemiGround: new THREE.Color(0x9b8464), hemi: 2.3,
  key: new THREE.Color(0xfff4dc), keyIntensity: 3.0, keyPosition: new THREE.Vector3(-12, 24, 16),
  fill: new THREE.Color(0xd2ebff), fillIntensity: 0.6, exposure: 1.05, background: new THREE.Color(0x9ddcff),
});
const NIGHT = Object.freeze({
  hemiSky: new THREE.Color(0x4a5e9e), hemiGround: new THREE.Color(0x1b2036), hemi: 1.1,
  key: new THREE.Color(0xa9bcff), keyIntensity: 1.25, keyPosition: new THREE.Vector3(14, 26, -10),
  fill: new THREE.Color(0x5b72b8), fillIntensity: 0.4, exposure: 1.18, background: new THREE.Color(0x070b1c),
});
const DUSK_KEY = new THREE.Color(0xffa05a), DUSK_SKY = new THREE.Color(0xf2b49a), DUSK_BG = new THREE.Color(0xd98b6a);
const WHITE = new THREE.Color(1, 1, 1), NAMI_NIGHT = new THREE.Color(0.3, 0.37, 0.62), NAMI_DUSK = new THREE.Color(1, 0.76, 0.6), STORM_FLASH = new THREE.Color(0xdbe6ff);
const smooth = x => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };
const approach = (value, target, step) => value < target ? Math.min(target, value + step) : Math.max(target, value - step);

export function createAmbience({ scene, renderer }) {
  const hemi = new THREE.HemisphereLight(DAY.hemiSky, DAY.hemiGround, DAY.hemi);
  const key = new THREE.DirectionalLight(DAY.key, DAY.keyIntensity); key.position.copy(DAY.keyPosition); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048); key.shadow.camera.left = key.shadow.camera.bottom = -12;
  key.shadow.camera.right = key.shadow.camera.top = 12; key.shadow.camera.near = 1; key.shadow.camera.far = 90;
  key.shadow.normalBias = .012; key.shadow.bias = -.0001;
  const fill = new THREE.DirectionalLight(DAY.fill, DAY.fillIntensity); fill.position.set(8, 5, -8);
  scene.add(hemi, key, key.target, fill, fill.target);
  scene.background = DAY.background.clone();

  const state = { theme: 0, themeTarget: 0, night: 0, nightTarget: 0, nightSpeed: 1 / 14, rain: 0, rainTarget: 0, flash: 0 };
  const tmp = new THREE.Color(), tmp2 = new THREE.Color(), tint = new THREE.Color(), direction = new THREE.Vector3();
  let parts = { environment: null, theme: null, rain: null };

  function lights(night, rain, flash, themeAmount) {
    const n = smooth(night), bell = 1 - Math.abs(2 * night - 1), storm = 1 - 0.45 * rain;
    hemi.color.copy(DAY.hemiSky).lerp(NIGHT.hemiSky, n).lerp(DUSK_SKY, bell * 0.45);
    hemi.groundColor.copy(DAY.hemiGround).lerp(NIGHT.hemiGround, n);
    hemi.intensity = THREE.MathUtils.lerp(DAY.hemi, NIGHT.hemi, n) * (1 - 0.25 * rain) + flash * 3.2;
    key.color.copy(DAY.key).lerp(NIGHT.key, n).lerp(DUSK_KEY, bell * 0.8).lerp(STORM_FLASH, Math.min(1, flash));
    key.intensity = (THREE.MathUtils.lerp(DAY.keyIntensity, NIGHT.keyIntensity, n) * (1 - 0.35 * bell) + flash * 2.6) * storm;
    const moon = parts.environment?.atmosphere?.moonDirection;
    key.position.copy(DAY.keyPosition).lerp(moon ? direction.copy(moon).multiplyScalar(32) : NIGHT.keyPosition, n);
    const voyage = parts.environment?.voyage;
    const x = voyage?.x ?? 0, z = voyage?.z ?? 0;
    key.position.x += x; key.position.z += z; key.target.position.set(x, 0, z);
    fill.position.set(8 + x, 5, -8 + z); fill.target.position.set(x, 0, z);
    fill.color.copy(DAY.fill).lerp(NIGHT.fill, n);
    fill.intensity = THREE.MathUtils.lerp(DAY.fillIntensity, NIGHT.fillIntensity, n) + flash * 0.8;
    renderer.toneMappingExposure = THREE.MathUtils.lerp(DAY.exposure, NIGHT.exposure, n);
    scene.background.copy(DAY.background).lerp(NIGHT.background, n).lerp(DUSK_BG, bell * 0.4).multiplyScalar(1 - 0.25 * rain);
    // Nami's painted atlas is unlit: apply the same light as a multiplier. Lanterns warm her at night.
    tint.copy(WHITE).lerp(NAMI_NIGHT, n * (1 - 0.1 * themeAmount)).lerp(NAMI_DUSK, bell * 0.4);
    tint.multiplyScalar(1 - 0.18 * rain);
    if (themeAmount > 0 && n > 0) tint.r += 0.12 * n * themeAmount;
    tint.lerp(tmp2.set(1, 1, 1), Math.min(0.6, flash * 0.7));
    return tint;
  }

  return {
    attach(next) { parts = { ...parts, ...next }; },
    get state() { return state; },
    setTheme(amount) { state.themeTarget = THREE.MathUtils.clamp(amount, 0, 1); },
    /** `animated` eases the sky over about `seconds`; otherwise (a slider drag) it follows at once. */
    setNight(value, { animated = false, seconds = 14 } = {}) {
      state.nightTarget = THREE.MathUtils.clamp(value, 0, 1); state.nightSpeed = animated ? 1 / seconds : Infinity;
      if (!animated) state.night = state.nightTarget;
    },
    setRain(value) { state.rainTarget = THREE.MathUtils.clamp(value, 0, 1); },
    /** Advances every transition and returns Nami's light multiplier. */
    update(dt, clock, camera) {
      state.theme = approach(state.theme, state.themeTarget, dt / 3.5);
      state.night = approach(state.night, state.nightTarget, state.nightSpeed === Infinity ? 1 : dt * state.nightSpeed);
      state.rain = approach(state.rain, state.rainTarget, dt / 2.5);
      const { environment, theme, rain } = parts;
      environment?.setAtmosphere({ night: state.night, rain: state.rain, lightning: state.rain > 0.5 ? 1 : 0 });
      state.flash = environment?.atmosphere?.flash ?? 0;
      theme?.setAmount(state.theme);
      theme?.update(clock, dt, { night: state.night, flash: state.flash, camera });
      if (rain) { rain.setIntensity(state.rain, state.night); rain.setFlash(state.flash); rain.update(clock, dt); }
      return lights(state.night, state.rain, state.flash, state.theme);
    },
    snapshot: () => ({ ...state, key: key.intensity, hemi: hemi.intensity, exposure: renderer.toneMappingExposure }),
    destroy() {
      for (const light of [hemi, key, fill]) light.removeFromParent();
      key.target.removeFromParent(); fill.target.removeFromParent(); key.shadow.dispose();
    },
  };
}
