import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast, disposeBoundsTree } from 'three-mesh-bvh';

const FLAKE_COUNT = 240;
const AREA_RADIUS = 6.3;
const MELT_DURATION = 0.28;
const TAU = Math.PI * 2;

export interface SnowyVillageSnowfallVfx {
  update(
    delta: number,
    elapsed: number,
    staticBounds: readonly THREE.Box3[],
    dynamicBounds: readonly THREE.Box3[],
    houseMesh: THREE.Object3D | null,
    fireBounds: THREE.Box3 | null,
  ): void;
  dispose(): void;
}

const snowVertexShader = `
attribute float aOpacity;
attribute float aSize;
attribute float aPhase;
uniform float uTime;
varying float vOpacity;
void main() {
  vOpacity = aOpacity * (0.9 + 0.1 * sin(uTime * 1.8 + aPhase));
  vec3 p = position;
  p.x += sin(uTime * 0.75 + aPhase) * 0.01;
  p.z += cos(uTime * 0.65 + aPhase) * 0.01;
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = aSize * (300.0 / max(1.0, -mvPosition.z));
  gl_Position = projectionMatrix * mvPosition;
}
`;

const snowFragmentShader = `
varying float vOpacity;
void main() {
  float radius = length(gl_PointCoord - vec2(0.5));
  float edgeFade = 1.0 - smoothstep(0.12, 0.5, radius);
  gl_FragColor = vec4(0.9, 0.95, 1.0, edgeFade * vOpacity);
}
`;

export function createSnowyVillageSnowfallVfx(parent: THREE.Object3D): SnowyVillageSnowfallVfx {
  const positions = new Float32Array(FLAKE_COUNT * 3);
  const opacities = new Float32Array(FLAKE_COUNT);
  const sizes = new Float32Array(FLAKE_COUNT);
  const phases = new Float32Array(FLAKE_COUNT);
  const baseOpacities = new Float32Array(FLAKE_COUNT);
  const baseSizes = new Float32Array(FLAKE_COUNT);
  const fallSpeeds = new Float32Array(FLAKE_COUNT);
  const driftX = new Float32Array(FLAKE_COUNT);
  const driftZ = new Float32Array(FLAKE_COUNT);
  const meltTimes = new Float32Array(FLAKE_COUNT);
  const melting = new Uint8Array(FLAKE_COUNT);

  const randomBetween = (min: number, max: number): number => min + Math.random() * (max - min);
  const spawnFlake = (index: number): void => {
    const offset = index * 3;
    positions[offset] = randomBetween(-AREA_RADIUS, AREA_RADIUS);
    positions[offset + 1] = randomBetween(7.5, 12.5);
    positions[offset + 2] = randomBetween(-AREA_RADIUS, AREA_RADIUS);
    fallSpeeds[index] = randomBetween(0.9, 1.8);
    driftX[index] = randomBetween(-0.16, 0.16);
    driftZ[index] = randomBetween(-0.16, 0.16);
    baseOpacities[index] = randomBetween(0.55, 0.9);
    baseSizes[index] = randomBetween(0.11, 0.23);
    sizes[index] = baseSizes[index];
    opacities[index] = baseOpacities[index];
    phases[index] = Math.random() * TAU;
    meltTimes[index] = 0;
    melting[index] = 0;
  };
  for (let index = 0; index < FLAKE_COUNT; index += 1) spawnFlake(index);

  const geometry = new THREE.BufferGeometry();
  const positionAttribute = new THREE.BufferAttribute(positions, 3);
  positionAttribute.setUsage(THREE.DynamicDrawUsage);
  const opacityAttribute = new THREE.BufferAttribute(opacities, 1);
  opacityAttribute.setUsage(THREE.DynamicDrawUsage);
  const sizeAttribute = new THREE.BufferAttribute(sizes, 1);
  sizeAttribute.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positionAttribute);
  geometry.setAttribute('aOpacity', opacityAttribute);
  geometry.setAttribute('aSize', sizeAttribute);
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: snowVertexShader,
    fragmentShader: snowFragmentShader,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  const flakes = new THREE.Points(geometry, material);
  flakes.name = 'falling snow particle pool';
  flakes.frustumCulled = false;
  flakes.renderOrder = 30;
  parent.add(flakes);

  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;

  const rayOrigin = new THREE.Vector3();
  const rayDirection = new THREE.Vector3();
  const intersections: THREE.Intersection[] = [];
  const originalHouseRaycasts = new Map<THREE.Mesh, THREE.Mesh['raycast']>();
  const houseBvhGeometries = new Set<THREE.BufferGeometry>();
  let acceleratedHouseMesh: THREE.Object3D | null = null;
  const prepareHouseRaycasts = (houseMesh: THREE.Object3D): void => {
    if (acceleratedHouseMesh === houseMesh) return;
    acceleratedHouseMesh = houseMesh;
    houseMesh.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const geometry = object.geometry;
      if (!geometry.boundsTree) {
        geometry.boundsTree = new MeshBVH(geometry, { indirect: true, verbose: false });
        houseBvhGeometries.add(geometry);
      }
      if (object.raycast !== acceleratedRaycast) {
        originalHouseRaycasts.set(object, object.raycast);
        object.raycast = acceleratedRaycast;
      }
    });
  };

  let windX = 0;
  let windZ = 0;
  let targetWindX = 0;
  let targetWindZ = 0;
  let gustTime = 0;
  let disposed = false;

  const containsPoint = (bounds: THREE.Box3, x: number, y: number, z: number): boolean =>
    x >= bounds.min.x && x <= bounds.max.x
    && y >= bounds.min.y && y <= bounds.max.y
    && z >= bounds.min.z && z <= bounds.max.z;
  const crossesBox = (
    bounds: THREE.Box3,
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
  ): boolean =>
    Math.max(x0, x1) >= bounds.min.x && Math.min(x0, x1) <= bounds.max.x
    && Math.max(y0, y1) >= bounds.min.y && Math.min(y0, y1) <= bounds.max.y
    && Math.max(z0, z1) >= bounds.min.z && Math.min(z0, z1) <= bounds.max.z;

  return {
    update(delta, elapsed, staticBounds, dynamicBounds, houseMesh, fireBounds): void {
      if (disposed) return;
      if (houseMesh && houseMesh !== acceleratedHouseMesh) prepareHouseRaycasts(houseMesh);

      const dt = Math.min(0.05, Math.max(0, delta));
      gustTime -= dt;
      if (gustTime <= 0) {
        const angle = Math.random() * TAU;
        const strength = randomBetween(0.25, 1.2);
        targetWindX = Math.cos(angle) * strength;
        targetWindZ = Math.sin(angle) * strength;
        gustTime = randomBetween(2, 5.5);
      }
      windX = THREE.MathUtils.damp(windX, targetWindX, 0.65, dt);
      windZ = THREE.MathUtils.damp(windZ, targetWindZ, 0.65, dt);
      material.uniforms.uTime.value = elapsed;
      const houseBounds = dynamicBounds[0];

      for (let index = 0; index < FLAKE_COUNT; index += 1) {
        const offset = index * 3;
        if (melting[index]) {
          meltTimes[index] += dt;
          const remaining = Math.max(0, 1 - meltTimes[index] / MELT_DURATION);
          opacities[index] = baseOpacities[index] * remaining;
          sizes[index] = baseSizes[index] * (1 + 0.25 * (1 - remaining));
          if (remaining === 0) spawnFlake(index);
          continue;
        }

        const x = positions[offset];
        const y = positions[offset + 1];
        const z = positions[offset + 2];
        const gust = Math.sin(elapsed * 0.9 + phases[index]) * 0.08;
        const nextX = x + (driftX[index] + windX + gust) * dt;
        const nextY = y - fallSpeeds[index] * dt;
        const nextZ = z + (driftZ[index] + windZ + Math.cos(elapsed * 0.7 + phases[index]) * 0.05) * dt;
        let hit = false;
        let impactX = nextX;
        let impactY = nextY;
        let impactZ = nextZ;

        if (nextY <= 0.015) {
          hit = true;
          impactY = 0.02;
        }
        if (Math.abs(nextX) > AREA_RADIUS + 0.6 || Math.abs(nextZ) > AREA_RADIUS + 0.6) {
          spawnFlake(index);
          continue;
        }
        if (!hit) {
          for (const bounds of staticBounds) {
            if (!containsPoint(bounds, nextX, nextY, nextZ)
              && !crossesBox(bounds, x, y, z, nextX, nextY, nextZ)) continue;
            hit = true;
            if (y > bounds.max.y && nextY <= bounds.max.y) impactY = bounds.max.y + 0.02;
            break;
          }
        }
        if (!hit) {
          for (let boundIndex = 1; boundIndex < dynamicBounds.length; boundIndex += 1) {
            const bounds = dynamicBounds[boundIndex];
            if (!containsPoint(bounds, nextX, nextY, nextZ)
              && !crossesBox(bounds, x, y, z, nextX, nextY, nextZ)) continue;
            hit = true;
            if (y > bounds.max.y && nextY <= bounds.max.y) impactY = bounds.max.y + 0.02;
            break;
          }
        }
        if (!hit && fireBounds
          && (containsPoint(fireBounds, nextX, nextY, nextZ)
            || crossesBox(fireBounds, x, y, z, nextX, nextY, nextZ))) {
          hit = true;
          if (y > fireBounds.max.y && nextY <= fireBounds.max.y) impactY = fireBounds.max.y + 0.02;
        }
        if (!hit && houseMesh && houseBounds
          && crossesBox(houseBounds, x, y, z, nextX, nextY, nextZ)) {
          rayOrigin.set(x, y, z);
          rayDirection.set(nextX - x, nextY - y, nextZ - z);
          const distance = rayDirection.length();
          if (distance > 0) {
            rayDirection.multiplyScalar(1 / distance);
            raycaster.set(rayOrigin, rayDirection);
            raycaster.near = 0;
            raycaster.far = distance;
            intersections.length = 0;
            const hits = raycaster.intersectObject(houseMesh, true, intersections);
            if (hits.length > 0) {
              hit = true;
              impactX = hits[0].point.x;
              impactY = hits[0].point.y + 0.02;
              impactZ = hits[0].point.z;
            }
          }
        }

        positions[offset] = hit ? impactX : nextX;
        positions[offset + 1] = hit ? impactY : nextY;
        positions[offset + 2] = hit ? impactZ : nextZ;
        if (hit) {
          melting[index] = 1;
          meltTimes[index] = 0;
        }
      }

      positionAttribute.needsUpdate = true;
      opacityAttribute.needsUpdate = true;
      sizeAttribute.needsUpdate = true;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const [mesh, raycast] of originalHouseRaycasts) mesh.raycast = raycast;
      for (const geometry of houseBvhGeometries) disposeBoundsTree.call(geometry);
      originalHouseRaycasts.clear();
      houseBvhGeometries.clear();
      acceleratedHouseMesh = null;

      parent.remove(flakes);
      geometry.dispose();
      material.dispose();
    },
  };
}
