// GPU rain for the Sunny scene.
//
//   * Streaks: one instanced draw (fixed pool). Every drop is a pure function of absolute time, so
//     seeking is deterministic and update() does no per-streak work. Drops are world-fixed and wrap
//     inside three nested boxes centred on the camera (near = dense, far = sparse and thicker), so the
//     volume follows the camera without any visible re-seeding.
//   * Depth: streaks depth-test against the scene (sails, rigging and characters occlude them) and
//     never write depth.
//   * Splashes: a second instanced draw of expanding rings on the deck plane (deck-local y = 0.03).
//     Their matrix follows `deck.matrixWorld`, and their wrap region is centred on the camera
//     expressed in deck-local space, so they ride the rocking ship.
//   * Colour: normal alpha blending with a day tint (dark blue-grey, reads against the bright sky) and
//     a night tint (pale blue, reads against the dark sky); `setNight()` blends between them.
import * as THREE from 'three';

const STREAKS = 9000;
const SPLASHES = 900;
// size = box edge in metres (the volume wraps around the camera), height = box height, share = fraction of the pool
const LAYERS = [
  { size: 12, height: 10, share: 0.5 },
  { size: 30, height: 20, share: 0.32 },
  { size: 80, height: 40, share: 0.18 },
];

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STREAK_VERTEX = /* glsl */`
  attribute vec4 aSeed;   // xyz = start inside the unit box, w = speed factor
  attribute vec4 aBox;    // xyz = box size (m), w = per-drop brightness
  uniform float uTime; uniform vec3 uCam; uniform vec3 uWind; uniform float uFall; uniform float uLen;
  uniform float uPx; uniform float uIntensity;
  varying float vAlpha;
  varying float vAcross;
  void main() {
    vec3 box = aBox.xyz;
    float speed = uFall * (0.8 + 0.4 * aSeed.w);
    vec3 vel = vec3(uWind.x, -speed, uWind.z) * (0.8 + 0.4 * aSeed.w);
    vec3 p0 = aSeed.xyz * box + vel * uTime;
    // wrap the drop into the box that is centred on the camera
    vec3 rel = mod(p0 - uCam + box * 0.5, box) - box * 0.5;
    vec3 head = uCam + rel;
    float dist = length(rel);
    vec3 tail = head - vel * uLen * (1.0 + 0.9 * (1.0 - smoothstep(1.5, 16.0, dist)));
    vec3 a = (viewMatrix * vec4(head, 1.0)).xyz;
    vec3 b = (viewMatrix * vec4(tail, 1.0)).xyz;
    vec3 dir = b - a;
    vec3 side = normalize(cross(dir, a));
    // keep far streaks at least ~1.2 px wide so they stay visible but faint
    float width = max(0.0045, dist * uPx * 1.1);
    vec3 pos = mix(a, b, position.y) + side * position.x * width;
    // fade near the faces of the box and with distance
    vec3 edge = smoothstep(vec3(0.0), vec3(0.12), 0.5 - abs(rel / box));
    float boxFade = edge.x * edge.y * edge.z;
    float far = 1.0 - smoothstep(0.55, 1.0, dist / (box.x * 0.5));
    float near = smoothstep(0.8, 2.6, -a.z);
    vAlpha = boxFade * far * near * aBox.w * (0.55 + 0.45 * smoothstep(40.0, 2.0, dist)) * (1.0 - 0.5 * position.y);
    vAcross = position.x;
    gl_Position = (-a.z < 0.05 && -b.z < 0.05) ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * vec4(pos, 1.0);
  }`;

const STREAK_FRAGMENT = /* glsl */`
  uniform vec3 uColor; uniform float uOpacity; uniform float uBoost;
  varying float vAlpha; varying float vAcross;
  void main() {
    float soft = 1.0 - smoothstep(0.35, 1.0, abs(vAcross) * 2.0);
    float a = vAlpha * soft * uOpacity;
    if (a < 0.003) discard;
    gl_FragColor = vec4(uColor * (1.0 + uBoost), a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

const SPLASH_VERTEX = /* glsl */`
  attribute vec4 aSp;     // x,z in unit square, phase, size
  attribute float aRate;
  uniform float uTime; uniform vec2 uCamXZ; uniform float uRegion; uniform float uIntensity; uniform float uThreshold;
  varying vec2 vUv; varying float vAge; varying float vOn;
  void main() {
    vec2 base = aSp.xy * uRegion;
    vec2 p = mod(base - uCamXZ + uRegion * 0.5, uRegion) + uCamXZ - uRegion * 0.5;
    float cyc = fract(uTime * aRate + aSp.z);
    float r = (0.03 + 0.17 * sqrt(cyc)) * aSp.w;
    // only on the ship: ellipse over the promenade + lawn, not the cabin
    vec2 q = vec2(p.x / 6.5, (p.y - 1.8) / 14.0);
    float onDeck = step(dot(q, q), 1.0) * step(-8.2, p.y);
    float count = step(aSp.z * 0.0 + fract(aSp.x * 17.3 + aSp.y * 5.1), uThreshold);
    vOn = onDeck * count;
    vUv = position.xz * 2.0; vAge = cyc;
    vec3 world = vec3(p.x + position.x * r * 2.0, 0.03, p.y + position.z * r * 2.0);
    vec4 mv = modelViewMatrix * vec4(world, 1.0);
    gl_Position = projectionMatrix * mv;
  }`;

const SPLASH_FRAGMENT = /* glsl */`
  uniform vec3 uColor; uniform float uOpacity;
  varying vec2 vUv; varying float vAge; varying float vOn;
  void main() {
    if (vOn < 0.5) discard;
    float d = length(vUv);
    if (d > 1.0) discard;
    float ring = smoothstep(0.55, 0.78, d) * (1.0 - smoothstep(0.86, 1.0, d));
    float crown = (1.0 - smoothstep(0.0, 0.35, d)) * (1.0 - smoothstep(0.0, 0.25, vAge));
    float a = (ring * 0.9 + crown) * pow(1.0 - vAge, 1.6) * uOpacity;
    if (a < 0.01) discard;
    gl_FragColor = vec4(uColor, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

export function createRain({ scene, camera, deck, viewportHeight = 1000 }) {
  const group = new THREE.Group();
  group.name = 'Rain';
  group.visible = false;

  const rand = mulberry(0x5eed);
  // ---- streaks ----------------------------------------------------------------------------------------------
  const quad = new THREE.PlaneGeometry(1, 1);
  quad.translate(0, 0.5, 0); // y in [0,1]: 0 = head, 1 = tail; x in [-0.5,0.5]: across
  const streakGeometry = new THREE.InstancedBufferGeometry();
  streakGeometry.index = quad.index;
  streakGeometry.setAttribute('position', quad.attributes.position);
  const seeds = new Float32Array(STREAKS * 4), boxes = new Float32Array(STREAKS * 4);
  for (let i = 0; i < STREAKS; i++) {
    let r = rand(), layer = 0, acc = 0;
    for (let l = 0; l < LAYERS.length; l++) { acc += LAYERS[l].share; if (r <= acc) { layer = l; break; } layer = l; }
    const L = LAYERS[layer];
    seeds.set([rand(), rand(), rand(), rand()], i * 4);
    boxes.set([L.size, L.height, L.size, 0.55 + 0.45 * rand()], i * 4);
  }
  streakGeometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  streakGeometry.setAttribute('aBox', new THREE.InstancedBufferAttribute(boxes, 4));
  streakGeometry.instanceCount = 0;
  const U = {
    uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uWind: { value: new THREE.Vector3(2.2, 0, 0.9) }, uFall: { value: 9.2 }, uLen: { value: 0.045 },
    uPx: { value: 0.001 }, uIntensity: { value: 0 }, uColor: { value: new THREE.Color() }, uOpacity: { value: 0.5 }, uBoost: { value: 0 },
  };
  const streakMaterial = new THREE.ShaderMaterial({
    uniforms: U, vertexShader: STREAK_VERTEX, fragmentShader: STREAK_FRAGMENT,
    transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
  });
  const streaks = new THREE.Mesh(streakGeometry, streakMaterial);
  streaks.name = 'Rain streaks'; streaks.frustumCulled = false; streaks.renderOrder = 20;
  group.add(streaks);

  // ---- splashes --------------------------------------------------------------------------------------------
  const splashQuad = new THREE.PlaneGeometry(1, 1); splashQuad.rotateX(-Math.PI / 2);
  const splashGeometry = new THREE.InstancedBufferGeometry();
  splashGeometry.index = splashQuad.index;
  splashGeometry.setAttribute('position', splashQuad.attributes.position);
  const sp = new Float32Array(SPLASHES * 4), rate = new Float32Array(SPLASHES);
  for (let i = 0; i < SPLASHES; i++) { sp.set([rand(), rand(), rand(), 0.7 + 0.8 * rand()], i * 4); rate[i] = 1.4 + 1.4 * rand(); }
  splashGeometry.setAttribute('aSp', new THREE.InstancedBufferAttribute(sp, 4));
  splashGeometry.setAttribute('aRate', new THREE.InstancedBufferAttribute(rate, 1));
  splashGeometry.instanceCount = SPLASHES;
  const SU = { uTime: U.uTime, uCamXZ: { value: new THREE.Vector2() }, uRegion: { value: 18 }, uIntensity: U.uIntensity, uThreshold: { value: 0 }, uColor: { value: new THREE.Color() }, uOpacity: { value: 0.6 } };
  const splashMaterial = new THREE.ShaderMaterial({
    uniforms: SU, vertexShader: SPLASH_VERTEX, fragmentShader: SPLASH_FRAGMENT,
    transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const splashes = new THREE.Mesh(splashGeometry, splashMaterial);
  splashes.name = 'Deck splashes'; splashes.frustumCulled = false; splashes.matrixAutoUpdate = false; splashes.renderOrder = 19;
  group.add(splashes);
  scene.add(group);

  const DAY = new THREE.Color(0.30, 0.38, 0.50), NIGHT = new THREE.Color(0.74, 0.84, 1.0);
  const SPLASH_DAY = new THREE.Color(0.85, 0.9, 0.96), SPLASH_NIGHT = new THREE.Color(0.55, 0.68, 0.9);
  const inv = new THREE.Matrix4();
  const local = new THREE.Vector3();
  let intensity = 0, night = 0, flash = 0, wind = 1, time = 0, destroyed = false;

  const applyIntensity = () => {
    group.visible = intensity > 0.001 && !destroyed;
    streakGeometry.instanceCount = Math.min(STREAKS, Math.round(STREAKS * Math.pow(intensity, 0.9)));
    U.uIntensity.value = intensity;
    U.uOpacity.value = 0.3 + 0.38 * intensity;
    U.uFall.value = 8.4 + 2.4 * intensity;
    SU.uThreshold.value = Math.min(1, intensity * 1.05);
    SU.uOpacity.value = 0.35 + 0.4 * intensity;
  };
  const applyNight = () => {
    U.uColor.value.copy(DAY).lerp(NIGHT, night);
    SU.uColor.value.copy(SPLASH_DAY).lerp(SPLASH_NIGHT, night);
    U.uBoost.value = flash * 1.6;
  };
  applyIntensity(); applyNight();

  const api = {
    group,
    /** Rain amount 0..1 (light rain ~0.35, storm 1). Optional second argument sets the night blend 0..1. */
    setIntensity(value, nightValue) {
      if (destroyed) return;
      intensity = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
      applyIntensity();
      if (nightValue !== undefined) api.setNight(nightValue);
    },
    /** 0 = bright day sky (dark blue-grey streaks), 1 = night sky (pale blue streaks). */
    setNight(value) {
      if (destroyed) return;
      night = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
      applyNight();
    },
    /** Lightning flash 0..1 brightens the streaks for a frame or two. */
    setFlash(value) { if (destroyed) return; flash = Math.min(1, Math.max(0, value || 0)); applyNight(); },
    /** Horizontal wind in m/s along world x and z (default 2.2, 0.9). */
    setWind(x, z) { U.uWind.value.set(x, 0, z); },
    update(absoluteSeconds, dt = 0) {
      if (destroyed || intensity <= 0.001) return;
      time = Number.isFinite(absoluteSeconds) ? absoluteSeconds : 0;
      U.uTime.value = time;
      // slow gusts modulate the slant
      wind = 0.75 + 0.25 * Math.sin(time * 0.37) + 0.12 * Math.sin(time * 1.31 + 1.7);
      U.uWind.value.setLength(Math.max(0.1, (1.0 + 2.6 * intensity) * wind) * 0.9);
      U.uCam.value.copy(camera.position);
      U.uPx.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / viewportHeight;
      // deck splashes ride the ship
      deck.updateMatrixWorld();
      splashes.matrix.copy(deck.matrixWorld); splashes.matrixWorldNeedsUpdate = true;
      inv.copy(deck.matrixWorld).invert();
      local.copy(camera.position).applyMatrix4(inv);
      SU.uCamXZ.value.set(local.x, local.z);
    },
    snapshot() {
      return {
        intensity, night, flash, visible: group.visible,
        streaks: streakGeometry.instanceCount, streakPool: STREAKS, splashPool: SPLASHES,
        splashes: Math.round(SPLASHES * SU.uThreshold.value),
        wind: U.uWind.value.toArray(), fallSpeed: U.uFall.value, layers: LAYERS.map((l) => ({ ...l })),
        drawCalls: group.visible ? 2 : 0, triangles: group.visible ? streakGeometry.instanceCount * 2 + SPLASHES * 2 : 0,
        depthTested: true, followsCamera: true, splashesFollowDeck: true,
      };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      group.removeFromParent();
      streakGeometry.dispose(); splashGeometry.dispose(); quad.dispose(); splashQuad.dispose();
      streakMaterial.dispose(); splashMaterial.dispose();
      group.clear();
    },
  };
  return api;
}
