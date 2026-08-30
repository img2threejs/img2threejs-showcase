/**
 * A water surface, and what happens when something hits it.
 *
 * HAND-WRITTEN. No textures — the surface is a sum of sine waves displaced in the vertex shader
 * with its normal derived analytically, so the whole thing is arithmetic and ships as source like
 * everything else here.
 *
 * WHY THERE IS WATER AT ALL. `preset:dive` sends the hip from 0.71 down to −0.17 world units: the
 * character leaps and then descends straight through the floor. Watching that clip on a bare stage
 * is what "there are lots of errors during the motion" means — the dive is not broken, it is
 * landing in water that was never built. The surface height is taken from the clip rather than
 * chosen: at y = 0.22 the hip breaks the surface at t = 1.678 s, which is measured in
 * `tools/stitch.ts` and lands between the descent and the lowest point.
 *
 * The ripples here are deliberate, and worth distinguishing from the ones removed from under the
 * feet. Expanding rings on a floor read as wrong because a footfall displaces dirt. Expanding rings
 * on water read as right because that is what water does.
 */
import * as THREE from 'three';
import { FIGURE_HEIGHT, PALETTE, ACCENT } from './characterProfile';
import { ParticleField } from './vfx/particles';

const H = FIGURE_HEIGHT;

/**
 * Where the surface sits.
 *
 * Measured, not picked: this is the height at which the dive's hip crosses on the way down, far
 * enough below the apex that the descent reads, far enough above the lowest point that the body
 * genuinely submerges.
 */
export const WATER_LEVEL = 0.22;

/** The dive time at which the body meets that surface. From `evidence/stitches.json`. */
export const WATER_ENTRY_TIME = 1.678;

const VERTEX = /* glsl */`
  uniform float uTime;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec2 vUv;

  /**
   * Height and slope from the same three waves.
   *
   * The normal is the analytic derivative rather than something recomputed from neighbouring
   * vertices, so the shading stays correct however coarse the mesh is — and the mesh can then be
   * coarse, which is the point.
   */
  vec3 waveAt(vec2 p, out float height) {
    float h = 0.0;
    vec2 slope = vec2(0.0);

    // Three scales, non-harmonic frequencies so the pattern never visibly repeats.
    float a1 = 0.016, f1 = 1.7,  s1 = 0.55;
    float a2 = 0.010, f2 = 3.1,  s2 = 0.83;
    float a3 = 0.005, f3 = 6.7,  s3 = 1.30;
    vec2 d1 = normalize(vec2( 1.0, 0.35));
    vec2 d2 = normalize(vec2(-0.6, 1.0));
    vec2 d3 = normalize(vec2( 0.3, -1.0));

    float p1 = dot(p, d1) * f1 + uTime * s1;
    float p2 = dot(p, d2) * f2 + uTime * s2;
    float p3 = dot(p, d3) * f3 + uTime * s3;

    h += a1 * sin(p1) + a2 * sin(p2) + a3 * sin(p3);
    slope += a1 * f1 * cos(p1) * d1 + a2 * f2 * cos(p2) * d2 + a3 * f3 * cos(p3) * d3;

    height = h;
    return normalize(vec3(-slope.x, 1.0, -slope.y));
  }

  void main() {
    vUv = uv;
    float h;
    vec3 n = waveAt(position.xz, h);
    vNormal = n;
    vec3 displaced = position + vec3(0.0, h, 0.0);
    vec4 world = modelMatrix * vec4(displaced, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FRAGMENT = /* glsl */`
  uniform vec3 uDeep;
  uniform vec3 uShallow;
  uniform vec3 uSpecular;
  uniform vec3 uLightDirection;
  uniform float uOpacity;
  uniform float uRadius;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec2 vUv;

  void main() {
    vec3 view = normalize(cameraPosition - vWorld);
    vec3 n = normalize(vNormal);

    // Fresnel: water is nearly a mirror at grazing angles and nearly clear looking straight down.
    // Without this the surface reads as flat coloured glass.
    float fresnel = pow(1.0 - clamp(dot(n, view), 0.0, 1.0), 3.0);

    vec3 lightDir = normalize(uLightDirection);
    float diffuse = clamp(dot(n, lightDir), 0.0, 1.0);
    vec3 halfway = normalize(lightDir + view);
    float specular = pow(clamp(dot(n, halfway), 0.0, 1.0), 90.0);

    vec3 colour = mix(uDeep, uShallow, clamp(fresnel * 0.7 + diffuse * 0.3, 0.0, 1.0));
    colour += uSpecular * specular * 1.1;

    // Fade the sheet out toward its rim so it has no visible edge, which is cheaper and steadier
    // than trying to fog it.
    float edge = 1.0 - smoothstep(uRadius * 0.55, uRadius, length(vWorld.xz));
    float alpha = (uOpacity * (0.55 + fresnel * 0.45)) * edge;
    gl_FragColor = vec4(colour, alpha);
  }
`;

export interface Water {
  group: THREE.Group;
  /** Ripple rings + droplets at a point on the surface. `force` 0..1 scales the whole thing. */
  splash(at: THREE.Vector3, force?: number): void;
  update(dt: number, elapsed: number): void;
  setVisible(on: boolean): void;
  setViewport(pixelHeight: number, fovDegrees: number): void;
  dispose(): void;
}

export function createWater(radius = 9 * H): Water {
  const group = new THREE.Group();
  group.name = 'monster-cute-water';
  group.position.y = WATER_LEVEL;

  const uniforms = {
    uTime: { value: 0 },
    // The pool is the character's own palette: its deep tone below, its pale belly at the crests.
    uDeep: { value: PALETTE.furDeep.clone().multiplyScalar(0.55) },
    uShallow: { value: PALETTE.furLight.clone() },
    uSpecular: { value: PALETTE.sclera.clone() },
    uLightDirection: { value: new THREE.Vector3(1.5 * H, 1.55 * H, 0.95 * H).normalize() },
    uOpacity: { value: 0.78 },
    uRadius: { value: radius },
  };

  const surface = new THREE.Mesh(
    // Coarse on purpose: the normal is analytic, so density buys nothing but vertices.
    new THREE.PlaneGeometry(radius * 2, radius * 2, 96, 96).rotateX(-Math.PI / 2),
    new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms,
      transparent: true,
      depthWrite: false,   // the body has to stay visible through it
      side: THREE.DoubleSide,
    }),
  );
  surface.renderOrder = 6;
  group.add(surface);

  // ---- ripple rings ----
  const RINGS = 6;
  const rings: { mesh: THREE.Mesh; material: THREE.MeshBasicMaterial; age: number; life: number; radius: number }[] = [];
  for (let i = 0; i < RINGS; i += 1) {
    // Thin. A wide band reads as a painted circle; a ripple is a line.
    const geometry = new THREE.RingGeometry(0.94, 1, 96).rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({
      color: PALETTE.belly.clone(), transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.visible = false;
    mesh.renderOrder = 7;
    group.add(mesh);
    rings.push({ mesh, material, age: 0, life: 0, radius: 1 });
  }

  // ---- droplets ----
  // Glowing, unlike the ground dust: water throws real highlights, and the droplets are the part
  // that catches the key light.
  const droplets = new ParticleField(700, true);
  droplets.points.renderOrder = 12;
  group.add(droplets.points);

  const scratch = new THREE.Vector3();
  const scratchB = new THREE.Vector3();

  function ring(at: THREE.Vector3, radiusOut: number, life: number, delay = 0): void {
    const slot = rings.find((r) => !r.mesh.visible) ?? rings.reduce((a, b) => (a.age > b.age ? a : b));
    slot.mesh.position.set(at.x, 0.002 + delay * 0.001, at.z);
    slot.mesh.scale.setScalar(0.001);
    slot.mesh.visible = true;
    slot.age = -delay;
    slot.life = life;
    slot.radius = radiusOut;
  }

  function splash(at: THREE.Vector3, force = 1): void {
    const f = THREE.MathUtils.clamp(force, 0.15, 1);

    // Three rings leaving at different speeds. One ring reads as a decal; a set reads as a
    // disturbance travelling outward through a medium.
    ring(at, (0.55 + f * 0.8) * H, 1.5);
    ring(at, (0.34 + f * 0.5) * H, 1.1, 0.12);
    ring(at, (0.2 + f * 0.28) * H, 0.85, 0.26);

    // The crown: droplets thrown up and out, gravity-bound so they arc back to the surface.
    const count = Math.round(40 + f * 70);
    for (let i = 0; i < count; i += 1) {
      const a = Math.random() * Math.PI * 2;
      // Biased to the rim, which is where a crown throws its water.
      const r = 0.35 + Math.random() * 0.65;
      const out = (0.5 + f * 1.5) * H * r * (0.5 + Math.random() * 0.7);
      const up = (0.9 + f * 1.6) * H * (0.35 + Math.random() * 0.9);
      droplets.spawn({
        position: scratch.set(at.x + Math.cos(a) * 0.05 * H * r, 0.01 * H, at.z + Math.sin(a) * 0.05 * H * r),
        velocity: scratchB.set(Math.cos(a) * out, up, Math.sin(a) * out),
        colour: Math.random() < 0.7 ? PALETTE.sclera : ACCENT.core,
        size: (0.012 + Math.random() * 0.02) * H,
        life: 0.55 + Math.random() * 0.7,
        drag: 0.55,
        gravity: -2.6 * H,     // real weight, so the crown falls back rather than drifting
        growth: 0.7,           // droplets shrink as they break up
        alpha: 0.95,
        shape: 0,              // water beads, not stars
      });
    }

    // A low sheet of mist that lingers after the crown has fallen.
    for (let i = 0; i < Math.round(18 + f * 26); i += 1) {
      const a = Math.random() * Math.PI * 2;
      const s = (0.25 + f * 0.5) * H * (0.3 + Math.random());
      droplets.spawn({
        position: scratch.set(at.x, 0.005 * H, at.z),
        velocity: scratchB.set(Math.cos(a) * s, 0.12 * H * Math.random(), Math.sin(a) * s),
        colour: PALETTE.belly,
        size: (0.05 + Math.random() * 0.06) * H,
        life: 0.9 + Math.random() * 0.8,
        drag: 0.75,
        gravity: 0.02 * H,
        growth: 2.4,
        alpha: 0.22,
        shape: 0,
      });
    }
  }

  return {
    group,
    splash,
    update(dt, elapsed) {
      uniforms.uTime.value = elapsed;
      for (const slot of rings) {
        if (!slot.mesh.visible) continue;
        slot.age += dt;
        if (slot.age < 0) continue;              // still in its delay
        const t = slot.age / slot.life;
        if (t >= 1) { slot.mesh.visible = false; continue; }
        // Decelerating, like a real ripple losing energy to the surface.
        slot.mesh.scale.setScalar(slot.radius * (1 - (1 - t) ** 2.4));
        slot.material.opacity = (1 - t) ** 1.7 * 0.38;
      }
      droplets.update(dt);
    },
    setVisible(on) { group.visible = on; if (!on) droplets.clear(); },
    setViewport(pixelHeight, fovDegrees) { droplets.setViewport(pixelHeight, fovDegrees); },
    dispose() {
      surface.geometry.dispose();
      (surface.material as THREE.Material).dispose();
      for (const r of rings) { r.mesh.geometry.dispose(); r.material.dispose(); }
      droplets.dispose();
    },
  };
}
