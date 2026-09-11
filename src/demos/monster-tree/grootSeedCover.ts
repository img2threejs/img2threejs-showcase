import * as THREE from 'three';
import { forestGround, grassGeometry } from './grootTerrain';

const PATCH_CAPACITY = 10;
const TUFTS_PER_PATCH = 128;
const GROW_SECONDS = 0.82;

export interface GrootSeedPatch {
  readonly centre: THREE.Vector3;
  radius: number;
  age: number;
  active: boolean;
  ice: boolean;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * Persistent, bounded cover grown where Life Seeds actually meet the terrain.
 *
 * One InstancedMesh owns every blade. Recasts overwrite the oldest patch instead of allocating
 * scene objects forever, while nearby seeds merge into the same dense patch.
 */
export class GrootSeedCover {
  readonly group = new THREE.Group();
  readonly grass: THREE.InstancedMesh;
  readonly patches: GrootSeedPatch[] = Array.from({ length: PATCH_CAPACITY }, () => ({
    centre: new THREE.Vector3(), radius: 0, age: 0, active: false, ice:false,
  }));
  private readonly dummy = new THREE.Object3D();
  private readonly colour = new THREE.Color();
  private readonly offsets = new Float32Array(PATCH_CAPACITY * TUFTS_PER_PATCH * 2);
  private readonly yaw = new Float32Array(PATCH_CAPACITY * TUFTS_PER_PATCH);
  private readonly width = new Float32Array(PATCH_CAPACITY * TUFTS_PER_PATCH);
  private readonly heightScale = new Float32Array(PATCH_CAPACITY * TUFTS_PER_PATCH);
  private readonly tone = new Float32Array(PATCH_CAPACITY * TUFTS_PER_PATCH);
  private readonly wind = { value: 0 };
  private cursor = 0;
  private dirty = false;

  constructor(readonly height: number) {
    this.group.name = 'groot-life-seed-cover';
    this.group.visible = false;
    const material = new THREE.MeshStandardMaterial({
      color: '#ffffff', emissive: '#14220d', emissiveIntensity: 0.42,
      roughness: 0.94, side: THREE.DoubleSide, vertexColors: true,
    });
    material.onBeforeCompile = (shader) => {
      shader.uniforms.seedCoverWind = this.wind;
      shader.vertexShader = `uniform float seedCoverWind;\n${shader.vertexShader}`;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         transformed.x += sin(seedCoverWind * 1.55 + instanceMatrix[3].x * 1.7 + instanceMatrix[3].z * 2.1)
           * position.y * position.y * .13;`,
      );
    };
    this.grass = new THREE.InstancedMesh(grassGeometry(), material, PATCH_CAPACITY * TUFTS_PER_PATCH);
    this.grass.name = 'life-seed-tall-grass';
    this.grass.count = 0;
    this.grass.visible = false;
    this.grass.frustumCulled = false;
    // Dense blades turning black under overlapping tree shadows looked like wire. They still take
    // the world lighting and fog, but do not multiply the canopy shadow a second time.
    this.grass.receiveShadow = false;
    this.group.add(this.grass);

    const random = seededRandom(0x8eedc0de);
    for (let slot = 0; slot < PATCH_CAPACITY; slot += 1) {
      for (let tuft = 0; tuft < TUFTS_PER_PATCH; tuft += 1) {
        const index = slot * TUFTS_PER_PATCH + tuft;
        const angle = random() * Math.PI * 2;
        const radius = Math.sqrt(random());
        this.offsets[index * 2] = Math.cos(angle) * radius;
        this.offsets[index * 2 + 1] = Math.sin(angle) * radius;
        this.yaw[index] = random() * Math.PI * 2;
        this.width[index] = 0.16 + random() * 0.10;
        this.heightScale[index] = 0.46 + random() * 0.26;
        this.tone[index] = random();
      }
    }
  }

  get activePatchCount(): number {
    return this.patches.reduce((count, patch) => count + Number(patch.active), 0);
  }

  get tuftCount(): number {
    return this.activePatchCount * TUFTS_PER_PATCH;
  }

  plant(worldPoint: THREE.Vector3,ice=false): void {
    const mergeDistance = this.height * 0.32;
    let patch = this.patches.find((candidate) => candidate.active && candidate.ice===ice
      && Math.hypot(candidate.centre.x - worldPoint.x, candidate.centre.z - worldPoint.z) < mergeDistance);
    if (patch) {
      patch.centre.x = THREE.MathUtils.lerp(patch.centre.x, worldPoint.x, 0.16);
      patch.centre.z = THREE.MathUtils.lerp(patch.centre.z, worldPoint.z, 0.16);
      patch.centre.y = forestGround(patch.centre.x, patch.centre.z, this.height);
      patch.age = Math.min(patch.age, GROW_SECONDS * 0.42);
      patch.radius = Math.min(this.height * 0.82, patch.radius + this.height * 0.025);
    } else {
      patch = this.patches[this.cursor++ % PATCH_CAPACITY];
      patch.centre.set(
        worldPoint.x,
        forestGround(worldPoint.x, worldPoint.z, this.height),
        worldPoint.z,
      );
      patch.radius = this.height * (0.60 + (this.cursor % 3) * 0.045);
      patch.age = 0;
      patch.active = true;patch.ice=ice;
    }
    this.dirty = true;
    this.rebuild();
  }

  contains(worldPoint: THREE.Vector3): boolean {
    return this.patches.some((patch) => patch.active && patch.age >= GROW_SECONDS * 0.58
      && Math.hypot(patch.centre.x - worldPoint.x, patch.centre.z - worldPoint.z) <= patch.radius * 0.72);
  }

  update(dt: number): void {
    this.wind.value += dt;
    let growing = false;
    for (const patch of this.patches) {
      if (!patch.active) continue;
      patch.age += dt;
      growing ||= patch.age < GROW_SECONDS;
    }
    if (this.dirty || growing) this.rebuild();
  }

  clear(): void {
    for (const patch of this.patches) patch.active = false;
    this.grass.count = 0;
    this.grass.visible = false;
    this.group.visible = false;
    this.dirty = false;
  }

  private rebuild(): void {
    let at = 0;
    for (let slot = 0; slot < this.patches.length; slot += 1) {
      const patch = this.patches[slot];
      if (!patch.active) continue;
      const growth = THREE.MathUtils.smoothstep(patch.age, 0, GROW_SECONDS);
      for (let tuft = 0; tuft < TUFTS_PER_PATCH; tuft += 1) {
        const source = slot * TUFTS_PER_PATCH + tuft;
        const x = patch.centre.x + this.offsets[source * 2] * patch.radius;
        const z = patch.centre.z + this.offsets[source * 2 + 1] * patch.radius;
        this.dummy.position.set(x, forestGround(x, z, this.height) + this.height * 0.006, z);
        this.dummy.rotation.set(0, this.yaw[source], 0);
        const width = this.width[source] * this.height * (0.62 + growth * 0.38);
        this.dummy.scale.set(width, this.heightScale[source] * this.height * growth, width);
        this.dummy.updateMatrix();
        this.grass.setMatrixAt(at, this.dummy.matrix);
        this.colour.setHSL(patch.ice?.51+this.tone[source]*.045:0.205 + this.tone[source] * 0.075, patch.ice?.55:.48, (patch.ice?.60:.31) + this.tone[source] * 0.15);
        this.grass.setColorAt(at, this.colour);
        at += 1;
      }
    }
    this.grass.count = at;
    this.grass.visible = at > 0;
    this.group.visible = at > 0;
    this.grass.instanceMatrix.needsUpdate = true;
    if (this.grass.instanceColor) this.grass.instanceColor.needsUpdate = true;
    this.dirty = false;
  }
}
