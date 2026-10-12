/** Art-directed meteor fire; emitted smoke/embers stay in the launch frame, not on the sinking rock. */
import * as THREE from 'three';

export interface MeteorTrail {
  readonly group: THREE.Group;
  /** Fixed ocean-local launch frame; only the flame rotates with flight velocity. */
  reset(x: number, y: number, z: number, velocityX: number, velocityZ: number): void;
  tick(age: number, headY: number, waterY: number, daylight: number): void;
  quench(contactAge: number): void;
  hide(): void;
}

const SMOKE_LIFE = 0.55;
const SPARK_LIFE = 0.32;
const NOISE = `
  float hash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x),
                   mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                   mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
`;

function particleGeometry(count: number): THREE.BufferGeometry {
  const seeds = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    seeds[i * 3] = (i + 0.5) / count;
    seeds[i * 3 + 1] = (i * 0.61803398875) % 1;
    seeds[i * 3 + 2] = (i * 0.75487766625) % 1;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(seeds, 3));
  return geometry;
}

const VERTICAL_AXIS = new THREE.Vector3(0, 1, 0);

/** One shared set of geometry, three draws per active stone, no per-frame particle uploads. */
export function createMeteorTrails(count: number, radius: number, entrySpeed: number, gravity: number): {
  trails: MeteorTrail[];
  dispose(): void;
} {
  const length = radius * 5.2, halfWidth = radius * 1.5, bottom = -radius * 1.2;
  const volumeGeometry = new THREE.BoxGeometry(halfWidth * 2, length - bottom, halfWidth * 2);
  volumeGeometry.translate(0, (length + bottom) * 0.5, 0);
  const sparkGeometry = particleGeometry(64), smokeGeometry = particleGeometry(36);
  const inverse = new THREE.Matrix4(), cameraPosition = new THREE.Vector3(), viewport = new THREE.Vector2();
  const inverseRotation = new THREE.Quaternion(), tailDirection = new THREE.Vector3();
  const materials: THREE.ShaderMaterial[] = [];
  const trails: MeteorTrail[] = [];
  let disposed = false;

  for (let i = 0; i < count; i++) {
    const group = new THREE.Group();
    group.name = 'Meteor wake';
    group.visible = false;
    const uniforms = {
      uTime: { value: 0 }, uStop: { value: 1000 }, uActive: { value: 0 },
      uHead: { value: 0 }, uWater: { value: -10 }, uLength: { value: radius * 0.5 },
      uDaylight: { value: 1 }, uPixelScale: { value: 1 }, uSeed: { value: i * 0.173 },
      uCamera: { value: new THREE.Vector3() },
      uWaterNormal: { value: new THREE.Vector3(0, 1, 0) },
      uVelocity: { value: new THREE.Vector3(0, -entrySpeed, 0) },
      uHot: { value: new THREE.Color(0xffe7a9).multiplyScalar(2.0) },
      uMid: { value: new THREE.Color(0xff650e).multiplyScalar(1.6) },
      uOuter: { value: new THREE.Color(0xa51c04) },
      uEmber: { value: new THREE.Color(0xffda84) },
      uSmoke: { value: new THREE.Color(0x494440) },
    };
    const flameMaterial = new THREE.ShaderMaterial({
      uniforms, depthWrite: false, side: THREE.BackSide,
      transparent: true,
      vertexShader: `
        varying vec3 vPosition;
        void main() {
          vPosition = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime, uStop, uActive, uHead, uWater, uLength, uSeed;
        uniform vec3 uCamera, uHot, uMid, uOuter, uWaterNormal;
        varying vec3 vPosition;
        ${NOISE}
        float densityAt(vec3 p) {
          // The horizontal water plane becomes tilted in the flame's local frame.
          if (dot(p, uWaterNormal) + uHead < uWater) return 0.0;
          float height = clamp((p.y + ${radius * 0.55}) / ${length + radius * 0.55}, 0.0, 1.0);
          vec2 bend = vec2(sin(p.y * 2.3 + uTime * 13.0 + uSeed * 19.0),
                           cos(p.y * 3.1 - uTime * 11.0)) * height * height * ${radius * 0.35};
          vec2 radial = p.xz - bend;
          float angle = atan(radial.y, radial.x);
          float r = ${radius} * (1.02 * pow(1.0 - height, 0.85) + 0.04);
          r *= 1.0 + 0.15 * sin(angle * 3.0 - p.y * 2.4 + uTime * 18.0);
          float body = 1.0 - smoothstep(r * 0.28, r, length(radial));
          vec3 q = p * vec3(5.5, 3.0, 5.5) + vec3(uSeed * 71.0, -uTime * 24.0, 0.0);
          float turbulence = noise(q) * 0.65 + noise(q * 2.03) * 0.35;
          float tongues = smoothstep(0.27 + height * 0.18, 0.72 + height * 0.1, turbulence);
          body *= mix(0.24 + tongues * 0.76, tongues, smoothstep(0.05, 0.4, height));
          body *= smoothstep(${bottom}, ${-radius * 0.3}, p.y);
          body *= 1.0 - smoothstep(uLength - 0.35, uLength, p.y);
          return body;
        }
        void main() {
          if (uActive < 0.5 || uTime >= uStop) discard;
          vec3 ray = normalize(vPosition - uCamera);
          vec3 safeRay = sign(ray) * max(abs(ray), vec3(0.00001));
          safeRay += vec3(equal(safeRay, vec3(0))) * 0.00001;
          vec3 a = (vec3(${-halfWidth}, ${bottom}, ${-halfWidth}) - uCamera) / safeRay;
          vec3 b = (vec3(${halfWidth}, ${length}, ${halfWidth}) - uCamera) / safeRay;
          vec3 lo = min(a, b), hi = max(a, b);
          float entry = max(0.0, max(lo.x, max(lo.y, lo.z)));
          float exit = min(hi.x, min(hi.y, hi.z));
          if (exit <= entry) discard;
          float stepLength = (exit - entry) / 30.0;
          vec3 p = uCamera + ray * (entry + stepLength * 0.5);
          vec3 light = vec3(0);
          float alpha = 0.0;
          for (int step = 0; step < 30; step++) {
            float density = densityAt(p);
            float opacity = 1.0 - exp(-density * stepLength * 6.5);
            float heat = density * (1.0 - smoothstep(0.0, ${length * 0.55}, p.y));
            vec3 color = mix(uOuter, uMid, smoothstep(0.03, 0.4, density));
            color = mix(color, uHot, smoothstep(0.5, 0.9, heat));
            light += (1.0 - alpha) * opacity * color;
            alpha += (1.0 - alpha) * opacity;
            p += ray * stepLength;
          }
          if (alpha < 0.005) discard;
          gl_FragColor = vec4(light / alpha, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    const flame = new THREE.Mesh(volumeGeometry, flameMaterial);
    flame.name = 'Meteor flame';
    flame.renderOrder = 18;
    flame.frustumCulled = false;
    flame.userData.isRuntimeEffect = true;
    flame.userData.isPointerTransparent = true;
    flame.onBeforeRender = (_renderer, _scene, camera): void => {
      inverse.copy(flame.matrixWorld).invert();
      cameraPosition.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inverse);
      uniforms.uCamera.value.copy(cameraPosition);
    };
    group.add(flame);
    materials.push(flameMaterial);

    for (const smoke of [true, false]) {
      const lifetime = smoke ? SMOKE_LIFE : SPARK_LIFE;
      const material = new THREE.ShaderMaterial({
        uniforms, transparent: true, depthWrite: false,
        blending: smoke ? THREE.NormalBlending : THREE.AdditiveBlending,
        vertexShader: `
          uniform float uTime, uStop, uActive, uSeed, uPixelScale;
          uniform vec3 uVelocity;
          varying float vHeight, vLife, vSeed;
          ${smoke ? '' : 'varying vec2 vStreak;'}
          void main() {
            vec3 seed = fract(position + vec3(0.0, uSeed, uSeed * 1.73));
            float phase = seed.x * ${lifetime};
            // After quenching, retain the last birth; never cycle into a new particle.
            float born = floor((min(uTime, uStop) - phase) / ${lifetime}) * ${lifetime} + phase;
            float age = uTime - born;
            vLife = age / ${lifetime};
            vSeed = seed.z;
            vec3 velocity = uVelocity - vec3(0.0, ${gravity.toFixed(5)} * born, 0.0);
            vec3 tail = normalize(-velocity);
            vec3 side = normalize(vec3(tail.z, 0.0, -tail.x));
            vec3 across = cross(tail, side);
            float angle = seed.y * 6.28318530718;
            vec3 radial = cos(angle) * side + sin(angle) * across;
            // Birth positions stay in the untranslated, unrotated launch frame.
            vec3 p = uVelocity * born - vec3(0.0, 0.5 * ${gravity.toFixed(5)} * born * born, 0.0);
            p += radial * ${radius} * (0.6 + seed.z * 0.35) + tail * ${radius * 0.5};
            float drag = (1.0 - exp(-age / 0.055)) * 0.055;
            p += velocity * ${smoke ? '0.08' : '0.18'} * drag;
            p += radial * age * ${smoke ? '0.55' : '1.4'};
            p += vec3(0.18, ${smoke ? '1.05' : '0.5'}, 0.08) * age;
            ${smoke ? '' : `p.y -= 0.5 * ${gravity.toFixed(5)} * age * age;`}
            vHeight = p.y;
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            float size = ${smoke ? '0.36 * (1.0 + vLife * 2.0)' : '0.17'} * (0.65 + seed.z * 0.7);
            gl_PointSize = clamp(size * uPixelScale / max(0.01, -mv.z), 1.0, 64.0);
            gl_Position = projectionMatrix * mv;
            ${smoke ? '' : `
              vec4 next = projectionMatrix * vec4(mv.xyz + mat3(modelViewMatrix) * velocity * 0.015, 1.0);
              vec2 screenVelocity = next.xy / next.w - gl_Position.xy / gl_Position.w;
              vStreak = normalize(vec2(screenVelocity.x, -screenVelocity.y) + vec2(0.000001));
            `}
            if (uActive < 0.5 || born < 0.0 || age < 0.0 || vLife >= 1.0) {
              vLife = -1.0;
              gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            }
          }
        `,
        fragmentShader: `
          uniform vec3 uOuter, uMid, uEmber, uSmoke;
          uniform float uDaylight, uWater;
          varying float vHeight, vLife, vSeed;
          ${smoke ? '' : 'varying vec2 vStreak;'}
          void main() {
            if (vLife <= 0.0 || vLife >= 1.0) discard;
            if (vHeight < uWater - 0.02) discard;
            vec2 uv = gl_PointCoord * 2.0 - 1.0;
            ${smoke ? '' : 'uv = vec2(dot(uv, vStreak), dot(uv, vec2(-vStreak.y, vStreak.x))) * vec2(1.0, 3.8);'}
            float d = dot(uv, uv);
            if (d > 1.0) discard;
            float envelope = smoothstep(0.0, 0.08, vLife) * (1.0 - smoothstep(0.35, 1.0, vLife));
            ${smoke ? `
              // Irregular soft-edged smoke: not a smooth blob.
              float edge = 1.0 - smoothstep(0.32, 1.0, d);
              float warp = 0.7 + 0.3 * sin(uv.x * 11.0 + vSeed * 19.0)
                * sin(uv.y * 13.0 + vSeed * 7.0);
              float alpha = 0.24 * exp(-2.4 * d) * edge * warp * envelope;
              gl_FragColor = vec4(uSmoke * (0.7 + 0.3 * uDaylight), alpha);
            ` : `
              vec3 base = mix(uEmber, uMid, smoothstep(0.0, 0.5, vLife));
              gl_FragColor = vec4(mix(base, uOuter, smoothstep(0.4, 1.0, vLife)),
                pow(1.0 - d, 1.6) * envelope);
            `}
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }
        `,
      });
      const points = new THREE.Points(smoke ? smokeGeometry : sparkGeometry, material);
      points.name = smoke ? 'Meteor smoke' : 'Meteor sparks';
      points.renderOrder = smoke ? 17 : 18;
      points.frustumCulled = false;
      points.userData.isRuntimeEffect = true;
      points.userData.isPointerTransparent = true;
      points.onBeforeRender = (renderer, _scene, camera): void => {
        renderer.getDrawingBufferSize(viewport);
        uniforms.uPixelScale.value = viewport.y * camera.projectionMatrix.elements[5]! * 0.5;
      };
      group.add(points);
      materials.push(material);
    }
    trails.push({
      group,
      reset(x, y, z, vx, vz): void {
        if (disposed) return;
        group.position.set(x, y, z);
        group.visible = flame.visible = true;
        uniforms.uActive.value = 1;
        uniforms.uStop.value = 1000;
        uniforms.uTime.value = 0;
        uniforms.uVelocity.value.set(vx, -entrySpeed, vz);
      },
      tick(age, headY, waterY, daylight): void {
        if (disposed || !group.visible) return;
        if (age >= uniforms.uStop.value + SMOKE_LIFE) {
          group.visible = false;
          uniforms.uActive.value = 0;
          return;
        }
        uniforms.uTime.value = age;
        uniforms.uHead.value = headY - group.position.y;
        uniforms.uWater.value = waterY - group.position.y;
        uniforms.uDaylight.value = daylight;
        if (!flame.visible) return;
        const velocity = uniforms.uVelocity.value;
        flame.position.set(velocity.x * age, uniforms.uHead.value, velocity.z * age);
        tailDirection.set(-velocity.x, entrySpeed + gravity * age, -velocity.z).normalize();
        flame.quaternion.setFromUnitVectors(VERTICAL_AXIS, tailDirection);
        inverseRotation.copy(flame.quaternion).invert();
        uniforms.uWaterNormal.value.copy(VERTICAL_AXIS).applyQuaternion(inverseRotation);
        uniforms.uLength.value = Math.min(length, Math.max(radius * 0.5, flame.position.length() + radius * 0.4));
      },
      quench(contactAge): void {
        uniforms.uStop.value = contactAge;
        flame.visible = false;
      },
      hide(): void {
        group.visible = false;
        flame.visible = false;
        uniforms.uActive.value = 0;
      },
    });
  }
  return {
    trails,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const trail of trails) { trail.hide(); trail.group.removeFromParent(); }
      for (const material of materials) material.dispose();
      volumeGeometry.dispose(); sparkGeometry.dispose(); smokeGeometry.dispose();
    },
  };
}