import * as THREE from 'three';
import { createSnowyVillageSmokeVfx } from './snowyVillageSmokeVfx';

const EMBER_COUNT = 64;
const TAU = Math.PI * 2;

export interface SnowyVillageFireVfx {
  update(delta: number, elapsed: number, timeOfDay: number): void;
  dispose(): void;
}

const flameVertexShader = `
varying vec2 vUv;
uniform float uTime;
uniform float uPhase;
void main() {
  vUv = uv;
  vec3 p = position;
  float sway = sin(uTime * 6.0 + uPhase + uv.y * 4.0) * 0.035 * uv.y;
  p.x += sway;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const flameFragmentShader = `
varying vec2 vUv;
uniform float uTime;
uniform float uPhase;
uniform float uBrightness;
uniform vec3 uColor;
void main() {
  float y = vUv.y;
  float center = 0.5 + 0.10 * sin(uTime * 5.1 + uPhase + y * 5.0) * y;
  float halfWidth = mix(0.36, 0.035, y) * (0.78 + 0.22 * sin(uTime * 8.0 + uPhase + y * 11.0));
  float side = 1.0 - smoothstep(halfWidth - 0.045, halfWidth + 0.025, abs(vUv.x - center));
  float base = smoothstep(0.0, 0.13, y);
  float tip = 1.0 - smoothstep(0.79, 1.0, y);
  float flicker = 0.82 + 0.18 * sin(uTime * 12.0 + uPhase);
  float alpha = side * base * tip * flicker * uBrightness;
  vec3 hot = mix(uColor, vec3(1.0, 0.88, 0.55), smoothstep(0.02, 0.72, y));
  gl_FragColor = vec4(hot, alpha);
}
`;

const emberVertexShader = `
attribute float aOpacity;
attribute float aSize;
varying float vOpacity;
void main() {
  vOpacity = aOpacity;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (300.0 / max(1.0, -mvPosition.z));
  gl_Position = projectionMatrix * mvPosition;
}
`;

const emberFragmentShader = `
varying float vOpacity;
uniform float uBrightness;
void main() {
  float radius = length(gl_PointCoord - vec2(0.5));
  float alpha = (1.0 - smoothstep(0.12, 0.5, radius)) * vOpacity * uBrightness;
  gl_FragColor = vec4(1.0, 0.39, 0.06, alpha);
}
`;

function wrapDayTime(time: number): number {
  return THREE.MathUtils.euclideanModulo(time, 24);
}

function brightnessForTime(time: number): number {
  const hour = wrapDayTime(time);
  return hour >= 19 || hour < 4 ? 1 : hour < 5 ? 1 - (hour - 4) : 0;
}

export function createSnowyVillageFireVfx(parent: THREE.Object3D): SnowyVillageFireVfx {
  const effects = new THREE.Group();
  const emberSizeScale = Math.abs(parent.scale.x);
  effects.name = 'campfire animated VFX';
  effects.position.set(0, 0.23, 0);

  const flameUniforms = [0, 1, 2].map((index) => ({
    uTime: { value: 0 },
    uPhase: { value: index * 2.1 },
    uBrightness: { value: 1 },
    uColor: { value: new THREE.Color([0xff4b08, 0xff841b, 0xffcb64][index]) },
  }));
  const flameGeometry = new THREE.PlaneGeometry(0.76, 0.98);
  for (let index = 0; index < flameUniforms.length; index += 1) {
    const material = new THREE.ShaderMaterial({
      uniforms: flameUniforms[index],
      vertexShader: flameVertexShader,
      fragmentShader: flameFragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const flame = new THREE.Mesh(flameGeometry, material);
    flame.name = 'campfire flame layer ' + (index + 1);
    flame.position.y = 0.43 + index * 0.025;
    flame.rotation.y = index * Math.PI / 3;
    const size = 1 - index * 0.14;
    flame.scale.set(size, size, 1);
    flame.renderOrder = 10 + index;
    effects.add(flame);
  }

  const positions = new Float32Array(EMBER_COUNT * 3);
  const opacities = new Float32Array(EMBER_COUNT);
  const sizes = new Float32Array(EMBER_COUNT);
  const ages = new Float32Array(EMBER_COUNT);
  const lifetimes = new Float32Array(EMBER_COUNT);
  const velocityX = new Float32Array(EMBER_COUNT);
  const velocityZ = new Float32Array(EMBER_COUNT);
  const lift = new Float32Array(EMBER_COUNT);
  const phases = new Float32Array(EMBER_COUNT);
  for (let index = 0; index < EMBER_COUNT; index += 1) {
    ages[index] = Math.random() * 1.8;
    lifetimes[index] = 1.2 + Math.random() * 1.8;
    sizes[index] = (0.045 + Math.random() * 0.045) * emberSizeScale;
    phases[index] = Math.random() * TAU;
    velocityX[index] = 0.12 + Math.random() * 0.1;
    velocityZ[index] = -0.07 + Math.random() * 0.14;
    lift[index] = 0.42 + Math.random() * 0.38;
  }
  const emberGeometry = new THREE.BufferGeometry();
  const positionAttribute = new THREE.BufferAttribute(positions, 3);
  positionAttribute.setUsage(THREE.DynamicDrawUsage);
  const opacityAttribute = new THREE.BufferAttribute(opacities, 1);
  opacityAttribute.setUsage(THREE.DynamicDrawUsage);
  emberGeometry.setAttribute('position', positionAttribute);
  emberGeometry.setAttribute('aOpacity', opacityAttribute);
  emberGeometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  const emberUniforms = { uBrightness: { value: 1 } };
  const emberMaterial = new THREE.ShaderMaterial({
    uniforms: emberUniforms,
    vertexShader: emberVertexShader,
    fragmentShader: emberFragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const embers = new THREE.Points(emberGeometry, emberMaterial);
  embers.name = 'campfire ember pool (' + EMBER_COUNT + ')';
  embers.frustumCulled = false;
  embers.renderOrder = 20;
  effects.add(embers);

  const light = new THREE.PointLight(0xff9b42, 0, 1.5, 2);
  light.name = 'campfire local flicker light';
  light.position.set(0, 0.52, 0);
  light.castShadow = false;
  effects.add(light);
  parent.add(effects);
  const campfireSmoke = createSnowyVillageSmokeVfx(parent, new THREE.Vector3(0, 1.15, 0), {
    particleCount: 16,
    lifetime: [1.6, 2.6],
    riseSpeed: [0.42, 0.72],
    spread: 0.55,
    size: [0.28, 0.68],
    opacity: 0.55,
    color: 0x7f858b,
  });

  let disposed = false;
  const recycle = (index: number): void => {
    ages[index] = 0;
    lifetimes[index] = 1.2 + Math.random() * 1.8;
    positions[index * 3] = (Math.random() - 0.5) * 0.34;
    positions[index * 3 + 1] = 0.48 + Math.random() * 0.18;
    positions[index * 3 + 2] = (Math.random() - 0.5) * 0.28;
    phases[index] = Math.random() * TAU;
    velocityX[index] = 0.12 + Math.random() * 0.1;
    velocityZ[index] = -0.07 + Math.random() * 0.14;
    lift[index] = 0.42 + Math.random() * 0.38;
  };
  for (let index = 0; index < EMBER_COUNT; index += 1) {
    recycle(index);
    ages[index] = Math.random() * lifetimes[index] * 0.8;
    positions[index * 3 + 1] += lift[index] * ages[index];
  }

  return {
    update(delta: number, elapsed: number, timeOfDay: number): void {
      if (disposed) return;
      const dt = Math.min(0.05, Math.max(0, delta));
      const brightness = brightnessForTime(timeOfDay);
      const gust = Math.sin(elapsed * 0.63) * 0.045 + Math.sin(elapsed * 1.37 + 0.8) * 0.018;
      for (let index = 0; index < flameUniforms.length; index += 1) {
        flameUniforms[index].uTime.value = elapsed;
        flameUniforms[index].uBrightness.value = brightness;
      }
      light.intensity = brightness * (4.1 + 0.75 * Math.sin(elapsed * 8.7) + 0.38 * Math.sin(elapsed * 17.2));
      emberUniforms.uBrightness.value = brightness;
      campfireSmoke.update(dt, elapsed, brightness);
      for (let index = 0; index < EMBER_COUNT; index += 1) {
        let age = ages[index] + dt;
        if (age >= lifetimes[index]) {
          recycle(index);
          age = 0;
        }
        ages[index] = age;
        const offset = index * 3;
        const wind = velocityX[index] + gust;
        positions[offset] += wind * dt;
        positions[offset + 1] += lift[index] * dt;
        positions[offset + 2] += velocityZ[index] * dt + Math.sin(elapsed * 0.85 + phases[index]) * 0.012 * dt;
        const life = age / lifetimes[index];
        opacities[index] = brightness * Math.sin(Math.PI * life) * (1 - life * 0.35);
      }
      positionAttribute.needsUpdate = true;
      opacityAttribute.needsUpdate = true;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      campfireSmoke.dispose();
      parent.remove(effects);
      flameGeometry.dispose();
      for (const child of effects.children) {
        if (child instanceof THREE.Points) child.geometry.dispose();
        if (child instanceof THREE.Mesh) {
          const material = child.material;
          if (Array.isArray(material)) material.forEach((item) => item.dispose());
          else material.dispose();
        } else if (child instanceof THREE.Points) {
          const material = child.material;
          if (Array.isArray(material)) material.forEach((item) => item.dispose());
          else material.dispose();
        }
      }
      emberMaterial.dispose();
      light.dispose();
      effects.clear();
    },
  };
}
