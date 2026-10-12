import * as THREE from 'three';

/** One complete noon → sunset → night → dawn cycle, in active-viewer seconds. */
export const DAY_NIGHT_SECONDS = 60;

export interface TropicalEnvironment {
  daylight: number;
  phase: number;
  tick(elapsed: number): void;
  dispose(): void;
}

const SKY_FRAGMENT = `
  uniform float daylight;
  uniform float twilight;
  uniform float skyTime;
  uniform vec3 sunDirection;
  uniform vec3 moonDirection;
  uniform vec3 dayZenith;
  uniform vec3 dayHorizon;
  uniform vec3 nightZenith;
  uniform vec3 nightHorizon;
  uniform vec3 duskHorizon;
  varying vec3 skyDirection;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0)), f.x), f.y);
  }
  void main() {
    vec3 d = normalize(skyDirection);
    float altitude = pow(max(d.y, 0.0), 0.45);
    vec3 horizon = mix(nightHorizon, dayHorizon, daylight);
    horizon = mix(horizon, duskHorizon, twilight * 0.65);
    vec3 sky = mix(horizon, mix(nightZenith, dayZenith, daylight), altitude);
    vec2 cloudUV = d.xz / max(d.y + 0.25, 0.12) * 1.1 + vec2(skyTime * 0.006, 0.0);
    float cloud = noise(cloudUV) * 0.65 + noise(cloudUV * 2.7) * 0.35;
    cloud = smoothstep(0.56, 0.82, cloud) * smoothstep(0.01, 0.3, d.y);
    sky = mix(sky, mix(vec3(0.04, 0.06, 0.10), vec3(0.8, 0.84, 0.83), daylight), cloud * 0.35);
    float sunDot = dot(d, sunDirection);
    float sunVisible = smoothstep(-0.05, 0.03, sunDirection.y);
    sky += vec3(1.0, 0.45, 0.13) * pow(max(sunDot, 0.0), 32.0) * twilight * 0.4;
    sky += vec3(8.0, 5.0, 2.0) * smoothstep(cos(0.032), cos(0.022), sunDot) * sunVisible;
    float moonDot = dot(d, moonDirection);
    float moonDisc = smoothstep(cos(0.025), cos(0.018), moonDot);
    sky += vec3(0.65, 0.77, 1.0) * (moonDisc + pow(max(moonDot, 0.0), 180.0) * 0.12) * (1.0 - daylight);
    vec2 starsUV = vec2(atan(d.z, d.x), asin(clamp(d.y, -1.0, 1.0))) * 140.0;
    vec2 cell = floor(starsUV), offset = fract(starsUV) - 0.5;
    float star = step(0.992, hash(cell)) * (1.0 - smoothstep(0.015, 0.10, length(offset)));
    star *= smoothstep(0.03, 0.25, d.y) * (1.0 - daylight) * (1.0 - cloud);
    sky += vec3(0.7, 0.8, 1.0) * star;
    gl_FragColor = vec4(sky, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function installTropicalIslandLights(scene: THREE.Scene): void {
  const hemisphere = new THREE.HemisphereLight(0xcae9f3, 0x6b6850, 0.55);
  const sun = new THREE.DirectionalLight(0xfff0d0, 1.6);
  sun.position.set(-7, 11, 4);
  sun.target.position.set(0, 0.4, -0.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10, near: 0.5, far: 40 });
  sun.shadow.bias = -0.0001;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 2.2;
  sun.shadow.camera.updateProjectionMatrix();
  const moon = new THREE.DirectionalLight(0x96baff, 0);
  moon.position.set(7, -11, -4);
  moon.target.position.copy(sun.target.position);
  scene.add(hemisphere, sun, sun.target, moon, moon.target);
  const uniforms = {
    daylight: { value: 1 }, twilight: { value: 0 }, skyTime: { value: 0 },
    sunDirection: { value: new THREE.Vector3().copy(sun.position).normalize() },
    moonDirection: { value: new THREE.Vector3().copy(moon.position).normalize() },
    dayZenith: { value: new THREE.Color(0x528ecc) }, dayHorizon: { value: new THREE.Color(0xcbe8e6) },
    nightZenith: { value: new THREE.Color(0x071329) }, nightHorizon: { value: new THREE.Color(0x152d48) },
    duskHorizon: { value: new THREE.Color(0xf9a073) },
  };
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.ShaderMaterial({
    uniforms, side: THREE.BackSide, depthWrite: false,
    vertexShader: `
      varying vec3 skyDirection;
      void main() {
        skyDirection = position;
        vec4 clip = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
        gl_Position = clip.xyww;
      }
    `,
    fragmentShader: SKY_FRAGMENT,
  }));
  sky.frustumCulled = false;
  sky.renderOrder = -1000;
  scene.add(sky);
  scene.background = new THREE.Color(0xcfe6ec);
  const daySun = new THREE.Color(0xfff0d0), duskSun = new THREE.Color(0xffa263);
  const dayHemi = new THREE.Color(0xcae9f3), nightHemi = new THREE.Color(0x617baf);
  const dayGround = new THREE.Color(0x6b6850), nightGround = new THREE.Color(0x202a40);
  const environment: TropicalEnvironment = {
    daylight: 1, phase: 0,
    tick(elapsed): void {
      const phase = (elapsed % DAY_NIGHT_SECONDS) / DAY_NIGHT_SECONDS;
      const angle = phase * Math.PI * 2;
      const elevation = Math.cos(angle);
      const daylight = THREE.MathUtils.smoothstep(elevation, -0.12, 0.35);
      const twilight = Math.exp(-Math.pow(elevation * 6, 2));
      environment.phase = phase;
      environment.daylight = daylight;
      sun.position.set(-7 * Math.cos(angle), 11 * elevation, 4 + 9 * Math.sin(angle));
      sun.intensity = Math.max(elevation, 0) * 1.6 + twilight * 0.16;
      sun.color.lerpColors(duskSun, daySun, daylight);
      moon.position.copy(sun.position).multiplyScalar(-1);
      moon.intensity = 0.22 * (1 - daylight);
      hemisphere.intensity = 0.10 + daylight * 0.45;
      hemisphere.color.lerpColors(nightHemi, dayHemi, daylight);
      hemisphere.groundColor.lerpColors(nightGround, dayGround, daylight);
      scene.environmentIntensity = 0.045 + daylight * 0.70;
      uniforms.daylight.value = daylight;
      uniforms.twilight.value = twilight;
      uniforms.skyTime.value = elapsed;
      uniforms.sunDirection.value.copy(sun.position).sub(sun.target.position).normalize();
      uniforms.moonDirection.value.copy(moon.position).sub(moon.target.position).normalize();
    },
    dispose(): void {
      sun.shadow.dispose();
      moon.shadow.dispose();
    },
  };
  scene.userData.tropicalEnvironment = environment;
  environment.tick(0);
}
