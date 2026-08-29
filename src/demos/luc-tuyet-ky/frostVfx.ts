import * as THREE from 'three';

/**
 * The frost package: six layers that read as one effect.
 *
 * Everything here is generated — the one texture is a canvas gradient built at runtime — so the demo
 * still fetches nothing, which is the property the rest of this reconstruction is built on.
 *
 * The palette is taken from the reference rather than invented: the gown's filigree glows at a pale
 * cyan (#8fdcff), the belt and hem crystals at a deeper blue (#2f7fd6), and the fabric itself sits
 * around #9fb6cf. Additive blending on that cyan over the gown's own colour is what makes the
 * filigree read as emitting rather than as a lighter paint.
 *
 * Layers, cheapest first:
 *   `snow`     drifting flakes in a cylinder around the figure
 *   `ground`   a frost disc under the feet, hex pattern, pulsing rim
 *   `aura`     an additive fresnel shell over the gown — the glow on the filigree
 *   `shards`   ice crystals orbiting at reading height
 *   `motes`    slow rising sparks, the cold coming off her
 *   `trail`    frost thrown from the hands and feet, emitted by measured joint speed
 *
 * Each is independently switchable so a reviewer can isolate one, and the whole set runs off a
 * single `update(dt, elapsed)` so the viewer's own ticker drives it.
 */

export const VFX_LAYERS = ['snow', 'ground', 'aura', 'shards', 'motes', 'trail'] as const;
export type VfxLayer = (typeof VFX_LAYERS)[number];

const ICE_BRIGHT = new THREE.Color('#8fdcff');
const ICE_DEEP = new THREE.Color('#2f7fd6');
const ICE_PALE = new THREE.Color('#dff2ff');

/** A soft round sprite, built once as a canvas gradient so no image is ever fetched. */
function makeSparkTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context) {
    const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.35, 'rgba(190,232,255,0.65)');
    gradient.addColorStop(1, 'rgba(140,200,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

interface DriftPoints {
  points: THREE.Points;
  /** x,y,z per particle, in the figure's own units. */
  seeds: Float32Array;
  speeds: Float32Array;
}

/**
 * A field of particles that loops in height.
 *
 * Height is wrapped in the shader rather than on the CPU: the whole field is one draw call and one
 * static buffer, and a flake that falls off the bottom reappears at the top without any per-frame
 * upload. `uTime` is the only thing that changes.
 */
function makeDriftField(
  count: number,
  height: number,
  radius: number,
  texture: THREE.Texture,
  options: { size: number; fall: number; swirl: number; colour: THREE.Color; opacity: number; rise?: boolean },
): DriftPoints {
  const seeds = new Float32Array(count * 3);
  const speeds = new Float32Array(count);
  const sizes = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    // Square-root on the radius keeps the field even instead of crowding the axis.
    const r = radius * Math.sqrt(Math.random());
    const a = Math.random() * Math.PI * 2;
    seeds[i * 3] = Math.cos(a) * r;
    seeds[i * 3 + 1] = Math.random() * height;
    seeds[i * 3 + 2] = Math.sin(a) * r;
    speeds[i] = 0.4 + Math.random() * 0.9;
    sizes[i] = 0.4 + Math.random() * 0.9;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(seeds, 3));
  geometry.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, height / 2, 0), Math.hypot(radius, height));

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uHeight: { value: height },
      uFall: { value: options.fall },
      uSwirl: { value: options.swirl },
      uSize: { value: options.size },
      uColour: { value: options.colour.clone() },
      uOpacity: { value: options.opacity },
      uMap: { value: texture },
      uPixelRatio: { value: 1 },
      uRise: { value: options.rise ? -1 : 1 },
    },
    vertexShader: /* glsl */ `
      attribute float aSpeed;
      attribute float aSize;
      uniform float uTime, uHeight, uFall, uSwirl, uSize, uPixelRatio, uRise;
      varying float vFade;
      void main() {
        vec3 p = position;
        // Wrap in height so the field never empties; mod keeps it exact at any elapsed time.
        float travel = uTime * uFall * aSpeed * uRise;
        p.y = mod(p.y - travel, uHeight);
        float sway = uTime * uSwirl * (0.5 + aSpeed);
        p.x += sin(sway + position.z * 9.0) * 0.035;
        p.z += cos(sway + position.x * 9.0) * 0.035;
        // Fade at both ends of the column so wrapping is never a visible pop.
        vFade = smoothstep(0.0, 0.18, p.y / uHeight) * (1.0 - smoothstep(0.72, 1.0, p.y / uHeight));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = uSize * aSize * uPixelRatio * (1.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform vec3 uColour;
      uniform float uOpacity;
      varying float vFade;
      void main() {
        vec4 texel = texture2D(uMap, gl_PointCoord);
        gl_FragColor = vec4(uColour * texel.rgb, texel.a * uOpacity * vFade);
      }
    `,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return { points, seeds, speeds };
}

/** The frost disc under the feet: hex cells that bloom outward, plus a breathing rim. */
function makeGroundFrost(radius: number): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uBright: { value: ICE_BRIGHT.clone() },
      uDeep: { value: ICE_DEEP.clone() },
      uIntensity: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime, uIntensity;
      uniform vec3 uBright, uDeep;
      varying vec2 vUv;

      // Distance to the nearest hexagon edge, which is what draws the frost cells.
      float hexEdge(vec2 p) {
        p = abs(p);
        return max(dot(p, normalize(vec2(1.0, 1.73))), p.x);
      }
      float cells(vec2 uv, float scale) {
        vec2 s = vec2(1.0, 1.73);
        vec2 p = uv * scale;
        vec2 a = mod(p, s) - s * 0.5;
        vec2 b = mod(p + s * 0.5, s) - s * 0.5;
        vec2 g = dot(a, a) < dot(b, b) ? a : b;
        return hexEdge(g);
      }

      void main() {
        vec2 c = vUv * 2.0 - 1.0;
        float r = length(c);
        if (r > 1.0) discard;

        float edge = cells(c, 7.0);
        // Rings of frost travelling out from the feet, so the disc reads as freezing, not as decal.
        float bloom = smoothstep(0.42, 0.5, edge + 0.12 * sin(r * 14.0 - uTime * 1.4));
        float veins = smoothstep(0.46, 0.5, cells(c, 15.0)) * 0.5;

        float falloff = 1.0 - smoothstep(0.15, 1.0, r);
        float rim = smoothstep(0.86, 0.94, r) * (1.0 - smoothstep(0.94, 1.0, r));
        rim *= 0.6 + 0.4 * sin(uTime * 1.9);

        vec3 colour = mix(uDeep, uBright, bloom + veins);
        float alpha = ((bloom * 0.5 + veins * 0.35) * falloff + rim * 0.9) * uIntensity;
        gl_FragColor = vec4(colour, alpha);
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(radius, 96), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = -1;
  return mesh;
}

/**
 * The glow shell over the gown.
 *
 * A second, slightly inflated copy of the costume geometry, drawn additively with a fresnel falloff:
 * where the surface turns away from the eye the glow piles up, which is exactly where the reference
 * puts its brightest filigree. It shares the source geometry, so it costs one draw call and no extra
 * memory — and it is a SkinnedMesh bound to the same skeleton, so it tracks the cloth solver for
 * free instead of needing its own copy of the dynamics.
 */
function makeAuraMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
    uniforms: {
      uTime: { value: 0 },
      uColour: { value: ICE_BRIGHT.clone() },
      uIntensity: { value: 0.55 },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <skinning_pars_vertex>
      varying vec3 vNormalView;
      varying vec3 vViewPosition;
      varying float vHeight;
      void main() {
        vHeight = position.y;
        vec3 objectNormal = normal;
        #include <skinbase_vertex>
        #include <skinnormal_vertex>
        vec3 transformed = position + normal * 0.004;
        #include <skinning_vertex>
        vec4 mv = modelViewMatrix * vec4(transformed, 1.0);
        vNormalView = normalize(normalMatrix * objectNormal);
        vViewPosition = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime, uIntensity;
      uniform vec3 uColour;
      varying vec3 vNormalView;
      varying vec3 vViewPosition;
      varying float vHeight;
      void main() {
        float fresnel = 1.0 - abs(dot(normalize(vNormalView), normalize(vViewPosition)));
        fresnel = pow(clamp(fresnel, 0.0, 1.0), 2.2);
        // A slow band travelling up the gown, so the glow moves the way the filigree suggests.
        float band = 0.72 + 0.28 * sin(vHeight * 11.0 - uTime * 1.1);
        gl_FragColor = vec4(uColour * fresnel * band * uIntensity, fresnel * band * uIntensity);
      }
    `,
  });
}

/** Ice crystals orbiting the figure — the only opaque layer, so it anchors the rest. */
function makeShards(count: number, texture: THREE.Texture): { group: THREE.Group; orbits: Array<{ mesh: THREE.Mesh; radius: number; height: number; speed: number; phase: number; tumble: THREE.Vector3 }> } {
  const group = new THREE.Group();
  const geometry = new THREE.OctahedronGeometry(1, 0);
  // Stretched along Y so each reads as a shard rather than a gem.
  geometry.scale(1, 1.9, 1);
  const material = new THREE.MeshPhysicalMaterial({
    color: ICE_PALE,
    emissive: ICE_DEEP,
    emissiveIntensity: 0.5,
    metalness: 0,
    roughness: 0.08,
    transmission: 0.75,
    thickness: 0.05,
    ior: 1.31, // ice
    transparent: true,
    opacity: 0.85,
  });
  const orbits: Array<{ mesh: THREE.Mesh; radius: number; height: number; speed: number; phase: number; tumble: THREE.Vector3 }> = [];
  for (let i = 0; i < count; i += 1) {
    const mesh = new THREE.Mesh(geometry, material);
    const scale = 0.012 + Math.random() * 0.022;
    mesh.scale.setScalar(scale);
    mesh.castShadow = false;
    group.add(mesh);
    orbits.push({
      mesh,
      radius: 0.34 + Math.random() * 0.3,
      height: 0.15 + Math.random() * 1.35,
      speed: (0.12 + Math.random() * 0.22) * (Math.random() < 0.5 ? -1 : 1),
      phase: Math.random() * Math.PI * 2,
      tumble: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(1.4),
    });
  }
  void texture;
  return { group, orbits };
}

/**
 * Frost thrown off the hands and feet, emitted by how fast the joint is actually moving.
 *
 * Reading the speed off the posed skeleton rather than scripting it per clip is what makes this
 * work for all eighteen clips without a table: a kick throws frost off the foot because the foot is
 * moving, and a bow throws none because nothing is.
 */
class TrailEmitter {
  readonly points: THREE.Points;
  private readonly capacity: number;
  private readonly position: Float32Array;
  private readonly velocity: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private cursor = 0;
  private readonly previous = new Map<THREE.Bone, THREE.Vector3>();
  private readonly world = new THREE.Vector3();

  constructor(capacity: number, texture: THREE.Texture) {
    this.capacity = capacity;
    this.position = new Float32Array(capacity * 3);
    this.velocity = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.position, 3));
    geometry.setAttribute('aLife', new THREE.BufferAttribute(this.life, 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 4);
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uMap: { value: texture }, uColour: { value: ICE_BRIGHT.clone() }, uPixelRatio: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute float aLife;
        uniform float uPixelRatio;
        varying float vLife;
        void main() {
          vLife = aLife;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = (6.0 + 26.0 * aLife) * uPixelRatio * (1.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform vec3 uColour;
        varying float vLife;
        void main() {
          if (vLife <= 0.0) discard;
          vec4 texel = texture2D(uMap, gl_PointCoord);
          gl_FragColor = vec4(uColour * texel.rgb, texel.a * vLife * 0.85);
        }
      `,
    });
    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
  }

  emitFrom(bones: THREE.Bone[], dt: number): void {
    for (const bone of bones) {
      this.world.setFromMatrixPosition(bone.matrixWorld);
      const last = this.previous.get(bone);
      if (!last) {
        this.previous.set(bone, this.world.clone());
        continue;
      }
      const speed = this.world.distanceTo(last) / Math.max(dt, 1e-4);
      last.copy(this.world);
      // Below this the joint is drifting, not striking; emitting there would fog the whole figure.
      if (speed < 0.55) continue;
      const budget = Math.min(6, Math.floor((speed - 0.55) * 5));
      for (let i = 0; i < budget; i += 1) {
        const at = this.cursor;
        this.cursor = (this.cursor + 1) % this.capacity;
        this.position[at * 3] = this.world.x + (Math.random() - 0.5) * 0.03;
        this.position[at * 3 + 1] = this.world.y + (Math.random() - 0.5) * 0.03;
        this.position[at * 3 + 2] = this.world.z + (Math.random() - 0.5) * 0.03;
        this.velocity[at * 3] = (Math.random() - 0.5) * 0.35;
        this.velocity[at * 3 + 1] = Math.random() * 0.28;
        this.velocity[at * 3 + 2] = (Math.random() - 0.5) * 0.35;
        this.maxLife[at] = 0.5 + Math.random() * 0.6;
        this.life[at] = 1;
      }
    }
  }

  step(dt: number): void {
    for (let i = 0; i < this.capacity; i += 1) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt / this.maxLife[i];
      if (this.life[i] <= 0) {
        this.life[i] = 0;
        continue;
      }
      this.velocity[i * 3 + 1] -= 0.45 * dt;
      for (let a = 0; a < 3; a += 1) this.position[i * 3 + a] += this.velocity[i * 3 + a] * dt;
    }
    (this.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.points.geometry.getAttribute('aLife') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

export interface FrostVfx {
  group: THREE.Group;
  /** Toggle one layer; returns the state it settled on. */
  setLayer(layer: VfxLayer, on: boolean): boolean;
  isLayerOn(layer: VfxLayer): boolean;
  /** 0..2 master strength, for a reviewer who wants the model unobscured. */
  intensity: number;
  update(deltaSeconds: number, elapsedSeconds: number): void;
  setPixelRatio(ratio: number): void;
  dispose(): void;
}

export interface FrostVfxOptions {
  /** Figure height in the units the model is added at; every layer is sized from it. */
  height: number;
  /** Costume geometries the aura shell is drawn over, with the skeleton they are bound to. */
  auraSources?: Array<{ geometry: THREE.BufferGeometry; skeleton: THREE.Skeleton; bindMatrix: THREE.Matrix4; bindMatrixInverse: THREE.Matrix4 }>;
  /** Joints the trail reads its speed from. */
  trailBones?: THREE.Bone[];
}

export function createFrostVfx(options: FrostVfxOptions): FrostVfx {
  const { height } = options;
  const group = new THREE.Group();
  group.name = 'luc-tuyet-ky-frost-vfx';
  const texture = makeSparkTexture();

  const snow = makeDriftField(900, height * 1.35, height * 0.62, texture, {
    size: 40, fall: 0.16, swirl: 0.5, colour: ICE_PALE, opacity: 0.55,
  });
  const motes = makeDriftField(220, height * 0.95, height * 0.3, texture, {
    size: 26, fall: 0.07, swirl: 0.9, colour: ICE_BRIGHT, opacity: 0.5, rise: true,
  });
  const ground = makeGroundFrost(height * 0.55);
  const shards = makeShards(16, texture);
  const trail = new TrailEmitter(600, texture);

  const auraMaterial = makeAuraMaterial();
  const aura = new THREE.Group();
  for (const source of options.auraSources ?? []) {
    const mesh = new THREE.SkinnedMesh(source.geometry, auraMaterial);
    mesh.bind(source.skeleton, source.bindMatrix);
    mesh.bindMatrixInverse.copy(source.bindMatrixInverse);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    aura.add(mesh);
  }

  const nodes: Record<VfxLayer, THREE.Object3D> = {
    snow: snow.points,
    ground,
    aura,
    shards: shards.group,
    motes: motes.points,
    trail: trail.points,
  };
  for (const node of Object.values(nodes)) group.add(node);

  let intensity = 1;
  const applyIntensity = (): void => {
    (snow.points.material as THREE.ShaderMaterial).uniforms.uOpacity.value = 0.55 * intensity;
    (motes.points.material as THREE.ShaderMaterial).uniforms.uOpacity.value = 0.5 * intensity;
    (ground.material as THREE.ShaderMaterial).uniforms.uIntensity.value = intensity;
    auraMaterial.uniforms.uIntensity.value = 0.55 * intensity;
    for (const orbit of shards.orbits) (orbit.mesh.material as THREE.MeshPhysicalMaterial).opacity = 0.85 * Math.min(1, intensity);
  };

  const vfx: FrostVfx = {
    group,
    get intensity(): number { return intensity; },
    set intensity(value: number) {
      intensity = THREE.MathUtils.clamp(value, 0, 2);
      applyIntensity();
    },
    setLayer: (layer, on) => {
      nodes[layer].visible = on;
      return on;
    },
    isLayerOn: (layer) => nodes[layer].visible,
    setPixelRatio: (ratio) => {
      const scaled = Math.min(ratio, 2) * 90;
      (snow.points.material as THREE.ShaderMaterial).uniforms.uPixelRatio.value = scaled;
      (motes.points.material as THREE.ShaderMaterial).uniforms.uPixelRatio.value = scaled;
      (trail.points.material as THREE.ShaderMaterial).uniforms.uPixelRatio.value = Math.min(ratio, 2) * 3;
    },
    update: (dt, elapsed) => {
      const step = Math.min(dt, 1 / 20);
      (snow.points.material as THREE.ShaderMaterial).uniforms.uTime.value = elapsed;
      (motes.points.material as THREE.ShaderMaterial).uniforms.uTime.value = elapsed;
      (ground.material as THREE.ShaderMaterial).uniforms.uTime.value = elapsed;
      auraMaterial.uniforms.uTime.value = elapsed;

      if (shards.group.visible) {
        for (const orbit of shards.orbits) {
          const angle = orbit.phase + elapsed * orbit.speed;
          orbit.mesh.position.set(
            Math.cos(angle) * orbit.radius,
            orbit.height + Math.sin(elapsed * 0.6 + orbit.phase) * 0.045,
            Math.sin(angle) * orbit.radius,
          );
          orbit.mesh.rotation.x += orbit.tumble.x * step;
          orbit.mesh.rotation.y += orbit.tumble.y * step;
          orbit.mesh.rotation.z += orbit.tumble.z * step;
        }
      }

      if (trail.points.visible) {
        if (options.trailBones?.length) trail.emitFrom(options.trailBones, step);
        trail.step(step);
      }
    },
    dispose: () => {
      texture.dispose();
      snow.points.geometry.dispose();
      (snow.points.material as THREE.Material).dispose();
      motes.points.geometry.dispose();
      (motes.points.material as THREE.Material).dispose();
      ground.geometry.dispose();
      (ground.material as THREE.Material).dispose();
      auraMaterial.dispose();
      for (const orbit of shards.orbits) {
        orbit.mesh.geometry.dispose();
        (orbit.mesh.material as THREE.Material).dispose();
        break; // geometry and material are shared across every shard
      }
      trail.dispose();
    },
  };
  applyIntensity();
  return vfx;
}
