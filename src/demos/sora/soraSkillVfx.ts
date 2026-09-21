import * as THREE from 'three';

/** Sora ability motifs adapted to the supplied clips, not canonical attack animations.
 * Blitz/Sliding Dash/Finishing Leap retain their slash/rush/ground-impact motifs.
 */
export const SORA_SKILLS: Readonly<Record<string, { name: string; kind: 'slash' | 'rush' | 'break' }>> = {
  'preset:biped:slash': { name: 'Blitz', kind: 'slash' },
  'preset:biped:run': { name: 'Sliding Dash', kind: 'rush' },
  'preset:biped:jump': { name: 'Finishing Leap', kind: 'break' },
};

// Normalized cues measured against Jump's five short hops.
const LANDING_CUES = [0.195, 0.425, 0.625, 0.8, 0.995];
const TRAIL_LENGTH = 20;
const PARTICLES = 96;

export function createSoraSkillVfx() {
  const group = new THREE.Group();
  group.name = 'sora-inspired-skills';
  group.visible = false;

  const ribbons = Array.from({ length: 2 }, (_, index) => {
    const geometry = new THREE.BufferGeometry();
    const position = new THREE.BufferAttribute(new Float32Array(TRAIL_LENGTH * 6), 3);
    position.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', position);
    const uv = new Float32Array(TRAIL_LENGTH * 4);
    const indices: number[] = [];
    for (let i = 0; i < TRAIL_LENGTH; i++) {
      uv.set([i / (TRAIL_LENGTH - 1), 0, i / (TRAIL_LENGTH - 1), 1], i * 4);
      if (i) indices.push(i * 2 - 2, i * 2 - 1, i * 2, i * 2 - 1, i * 2 + 1, i * 2);
    }
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geometry.setIndex(indices);
    const material = new THREE.ShaderMaterial({
      uniforms: { strength: { value: 0 }, tint: { value: new THREE.Color(0xffcc66) } },
      vertexShader: `varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying vec2 vUv; uniform float strength; uniform vec3 tint;
        void main() {
          float edge = 1.0 - abs(vUv.y * 2.0 - 1.0);
          float tail = pow(1.0 - vUv.x, 1.6);
          vec3 color = mix(tint, vec3(1.0, 0.98, 0.88), pow(edge, 4.0));
          gl_FragColor = vec4(color, edge * tail * strength);
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, toneMapped: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `sora-action-trail-${index}`;
    mesh.frustumCulled = false;
    group.add(mesh);
    return { mesh, position, samples: 0, lastEmission: -Infinity };
  });

  const particleGeometry = new THREE.BufferGeometry();
  const particlePosition = new THREE.BufferAttribute(new Float32Array(PARTICLES * 3), 3);
  particlePosition.setUsage(THREE.DynamicDrawUsage);
  particleGeometry.setAttribute('position', particlePosition);
  const particleMaterial = new THREE.ShaderMaterial({
    uniforms: { strength: { value: 0 } },
    vertexShader: `void main() {
      vec4 p = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * p;
      gl_PointSize = clamp(16.0 / max(0.1, -p.z), 1.0, 12.0);
    }`,
    fragmentShader: `uniform float strength; void main() {
      vec2 p = abs(gl_PointCoord - 0.5);
      float d = length(p);
      float star = exp(-min(p.x, p.y) * 35.0) * (1.0 - smoothstep(0.1, 0.5, max(p.x, p.y)));
      float alpha = star * strength;
      if (alpha < 0.01) discard;
      vec3 edge = vec3(1.0, 0.72, 0.25);
      gl_FragColor = vec4(mix(edge, vec3(1.0, 0.96, 0.7), 1.0 - d * 2.0), alpha);
    }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  });
  const particles = new THREE.Points(particleGeometry, particleMaterial);
  particles.name = 'sora-sparks';
  particles.frustumCulled = false;
  group.add(particles);

  const shardGeometry = new THREE.OctahedronGeometry(0.07);
  const shardMaterial = new THREE.MeshBasicMaterial({ color: 0xffdf87, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  const shards = new THREE.InstancedMesh(shardGeometry, shardMaterial, 24);
  shards.name = 'finishing-leap-light-burst';
  shards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  shards.frustumCulled = false;
  shards.visible = false;
  group.add(shards);

  const right = new THREE.Vector3(), left = new THREE.Vector3();
  const hip = new THREE.Vector3();
  const rightFoot = new THREE.Vector3(), leftFoot = new THREE.Vector3();
  const forward = new THREE.Vector3(), side = new THREE.Vector3();
  const start = new THREE.Vector3(), tip = new THREE.Vector3(), scratch = new THREE.Vector3();
  const impact = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const shardPose = new THREE.Object3D();
  let bound: THREE.SkinnedMesh | null = null;
  let bones: Record<string, THREE.Object3D> = {};
  let clip = '';
  let revision = -1;
  let previousTime = 0;
  let impactTime = -Infinity;

  const clear = (): void => {
    group.visible = false;
    bound = null;
    impactTime = -Infinity;
    shards.visible = false;
    particleMaterial.uniforms.strength.value = 0;
    for (const ribbon of ribbons) {
      ribbon.samples = 0;
      ribbon.lastEmission = -Infinity;
      ribbon.mesh.visible = false;
      ribbon.mesh.geometry.setDrawRange(0, 0);
    }
  };

  const socket = (name: string, target: THREE.Vector3): void => {
    bones[name].getWorldPosition(target);
    group.worldToLocal(target);
  };

  const update = (mesh: THREE.SkinnedMesh, clipId: string, time: number, duration: number, playRevision: number): void => {
    const skill = SORA_SKILLS[clipId];
    if (!skill || duration <= 0) { if (bound) clear(); return; }
    const changed = bound !== mesh || clip !== clipId || revision !== playRevision;
    const looped = !changed && time < previousTime;
    if (changed || looped) {
      clear();
      bound = mesh;
      clip = clipId;
      revision = playRevision;
      bones = Object.fromEntries(mesh.skeleton.bones.map((bone) => [bone.name, bone]));
      // Do not replay past impacts when enabled mid-clip or after a skin swap.
      previousTime = looped ? 0 : time;
    }
    const delta = Math.max(0, time - previousTime);
    const phase = time / duration;
    mesh.updateWorldMatrix(true, true);
    socket('R_Hand', right); socket('L_Hand', left);
    socket('Hip', hip);
    socket('R_Foot', rightFoot); socket('L_Foot', leftFoot);
    socket('R_Upperarm', side); socket('L_Upperarm', scratch);
    side.sub(scratch).normalize();
    forward.copy(up).cross(side).normalize();
    shards.visible = false;
    particleMaterial.uniforms.strength.value = 0;
    let particleCenter = hip;
    let particleSpread = 0.12;
    let particleStrength = 0;
    let trailActive = false;

    if (skill.kind === 'slash') {
      trailActive = (phase >= 0.145 && phase <= 0.235) || (phase >= 0.27 && phase <= 0.36);
      particleCenter = right;
      particleStrength = trailActive ? 0.55 : 0;
      particleSpread = 0.2;
    } else if (skill.kind === 'rush') {
      trailActive = phase >= 0.025 && phase <= 0.93;
      hip.copy(rightFoot).add(leftFoot).multiplyScalar(0.5);
      particleStrength = trailActive ? 0.5 : 0;
      particleSpread = 0.18;
    } else {
      trailActive = Math.min(rightFoot.y, leftFoot.y) > 0.16;
      for (const cue of LANDING_CUES) {
        const eventTime = cue * duration;
        if (previousTime < eventTime && time >= eventTime && time - eventTime < 0.12) {
          impact.copy(rightFoot).add(leftFoot).multiplyScalar(0.5);
          impact.y = Math.min(rightFoot.y, leftFoot.y) - 0.075;
          impactTime = eventTime;
        }
      }
      const age = time - impactTime;
      if (age >= 0 && age < 0.38) {
        const progress = age / 0.38;
        shards.visible = true;
        shardMaterial.opacity = (1 - progress) * 0.8;
        for (let i = 0; i < 24; i++) {
          const angle = i * 2.399963;
          const speed = 0.4 + ((i * 7) % 13) / 13;
          shardPose.position.copy(impact);
          shardPose.position.x += Math.cos(angle) * age * speed * 2.2;
          shardPose.position.z += Math.sin(angle) * age * speed * 2.2;
          shardPose.position.y += Math.max(0, age * (1.5 + speed) - age * age * 3);
          scratch.set(Math.cos(angle) * 0.55, 1 - progress, Math.sin(angle) * 0.55).normalize();
          shardPose.quaternion.setFromUnitVectors(up, scratch);
          const scale = (0.5 + speed * 0.55) * (1 - progress);
          shardPose.scale.set(scale, scale * 3.5, scale);
          shardPose.updateMatrix();
          shards.setMatrixAt(i, shardPose.matrix);
        }
        shards.instanceMatrix.needsUpdate = true;
        particleCenter = impact;
        particleSpread = 0.08 + progress * 0.35;
        particleStrength = 0.7 * (1 - progress);
      }
    }

    for (let i = 0; i < ribbons.length; i++) {
      const ribbon = ribbons[i];
      ribbon.mesh.material.uniforms.tint.value.setHex(skill.kind === 'rush' ? 0x83d8ff : 0xffcc66);
      if (trailActive && (skill.kind !== 'slash' || i === 0)) {
        if (skill.kind === 'break' || skill.kind === 'rush') {
          start.copy(i ? leftFoot : rightFoot);
          tip.copy(start).addScaledVector(up, skill.kind === 'rush' ? 0.18 : 0.42);
        } else {
          start.copy(i ? left : right);
          socket(i ? 'L_Forearm' : 'R_Forearm', scratch);
          tip.copy(start).sub(scratch).normalize().multiplyScalar(skill.kind === 'slash' ? 0.4 : 0.14).add(start);
        }
        const values = ribbon.position.array as Float32Array;
        values.copyWithin(6, 0, values.length - 6);
        if (skill.kind === 'rush') {
          for (let at = 6; at < values.length; at += 3) {
            values[at] -= forward.x * delta * 2.3;
            values[at + 2] -= forward.z * delta * 2.3;
          }
        }
        start.toArray(values, 0); tip.toArray(values, 3);
        ribbon.samples = Math.min(TRAIL_LENGTH, ribbon.samples + 1);
        ribbon.position.needsUpdate = true;
        ribbon.mesh.geometry.setDrawRange(0, Math.max(0, ribbon.samples - 1) * 6);
        ribbon.lastEmission = time;
      }
      const strength = Math.max(0, 1 - (time - ribbon.lastEmission) / 0.2);
      ribbon.mesh.material.uniforms.strength.value = strength * 0.8;
      ribbon.mesh.visible = ribbon.samples > 1 && strength > 0;
    }
    particles.visible = particleStrength > 0;
    if (particles.visible) {
      for (let i = 0; i < PARTICLES; i++) {
        const age = (i / PARTICLES + time * 1.6) % 1;
        const angle = i * 2.399963 + time * 2;
        const spread = particleSpread * (0.2 + age);
        scratch.copy(particleCenter);
        scratch.x += Math.cos(angle) * spread;
        scratch.z += Math.sin(angle * 1.7) * spread;
        scratch.y += (age - 0.25) * particleSpread * 1.8;
        if (skill.kind === 'rush') scratch.addScaledVector(forward, -age * 0.8);
        particlePosition.setXYZ(i, scratch.x, scratch.y, scratch.z);
      }
      particlePosition.needsUpdate = true;
      particleMaterial.uniforms.strength.value = particleStrength;
    }
    group.visible = shards.visible || particles.visible || ribbons.some((ribbon) => ribbon.mesh.visible);
    previousTime = time;
  };

  return { group, clear, update };
}
