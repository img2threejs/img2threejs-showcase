import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createServer } from 'vite';

// Regression: the elbow surface must not develop a narrow neck in Shoot.
// Measure real triangle/plane intersections, not skin-matrix determinants:
// a rigid transform at each vertex can still fold the surface between vertices.
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { createSoraShowcase } = await server.ssrLoadModule('/src/demos/sora/soraShowcase.ts');
  const root = createSoraShowcase({ initialSkin: 'kingdom-key' });
  const rig = root.children.find((child) => child.userData.rigged).userData.rigged;
  const mesh = rig.mesh;
  const geometry = mesh.geometry;
  const positions = geometry.getAttribute('position');
  const weights = geometry.getAttribute('skinWeight');
  const indices = geometry.getAttribute('skinIndex');
  const faces = geometry.getIndex();
  const bones = mesh.skeleton.bones;
  const posed = Array.from({ length: positions.count }, () => new THREE.Vector3());
  const sides = ['L', 'R'].map((side) => ({
    side,
    elbow: bones.find((bone) => bone.name === `${side}_Forearm`),
    shoulder: bones.find((bone) => bone.name === `${side}_Upperarm`),
    wrist: bones.find((bone) => bone.name === `${side}_Hand`),
    arm: Array.from({ length: positions.count }, (_, i) => {
      let total = 0;
      for (let slot = 0; slot < 4; slot++) {
        const name = bones[indices.getComponent(i, slot)].name;
        if (name.startsWith(`${side}_`) && /arm/.test(name)) total += weights.getComponent(i, slot);
      }
      return total > 0.99;
    }),
  }));
  const rows = [];
  const delta = new THREE.Vector3();
  const keys = Array.from({ length: positions.count }, (_, i) =>
    `${positions.getX(i)},${positions.getY(i)},${positions.getZ(i)}`);
  const elbowBlend = geometry.getAttribute('soraElbowBlend');
  const shadingNormals = geometry.getAttribute('soraElbowNormal');
  const edge = new THREE.Vector3();
  const faceNormal = new THREE.Vector3();
  for (const clip of ['preset:biped:idle', 'preset:biped:shoot']) {
    assert(rig.play(clip, 0));
    rig.update(0.5);
    for (let i = 0; i < posed.length; i++) mesh.getVertexPosition(i, posed[i]).applyMatrix4(mesh.matrixWorld);
    // Lighting at the joint must follow the bent surface, not just rotate the
    // bind-pose normal. Otherwise the false dent returns even with good volume.
    const expectedNormals = new Map();
    for (let i = 0; i < faces.count; i += 3) {
      const a = faces.getX(i), b = faces.getX(i + 1), c = faces.getX(i + 2);
      edge.copy(posed[b]).sub(posed[a]);
      faceNormal.copy(posed[c]).sub(posed[a]);
      faceNormal.crossVectors(edge, faceNormal);
      for (const vertex of [a, b, c]) {
        if (elbowBlend.getX(vertex) < 0.999) continue;
        const sum = expectedNormals.get(keys[vertex]) ?? new THREE.Vector3();
        sum.add(faceNormal);
        expectedNormals.set(keys[vertex], sum);
      }
    }
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    for (let i = 0; i < positions.count; i++) {
      if (elbowBlend.getX(i) < 0.999) continue;
      delta.fromBufferAttribute(shadingNormals, i).applyNormalMatrix(normalMatrix);
      const expected = expectedNormals.get(keys[i]);
      assert(delta.lengthSq() > 0.99 && expected?.lengthSq() > 0,
        `${clip}: invalid elbow shading normal`);
      assert(delta.angleTo(expected) < 0.02, `${clip}: shading produces a false elbow crease`);
    }
    for (const { side, elbow, shoulder, wrist, arm } of sides) {
      const e = elbow.getWorldPosition(new THREE.Vector3());
      const s = shoulder.getWorldPosition(new THREE.Vector3());
      const h = wrist.getWorldPosition(new THREE.Vector3());
      const length = h.distanceTo(e);
      const axis = e.clone().sub(s).normalize().add(h.clone().sub(e).normalize()).normalize();
      const u = new THREE.Vector3(1, 0, 0).cross(axis).normalize();
      const v = axis.clone().cross(u).normalize();
      const diameters = [];
      for (const offset of [-0.1, 0, 0.1]) {
        const center = e.clone().addScaledVector(axis, offset * length);
        const points = [];
        for (let i = 0; i < faces.count; i += 3) {
          const a = faces.getX(i), b = faces.getX(i + 1), c = faces.getX(i + 2);
          if (!arm[a] || !arm[b] || !arm[c]) continue;
          for (const [from, to] of [[a, b], [b, c], [c, a]]) {
            const da = delta.copy(posed[from]).sub(center).dot(axis);
            const db = delta.copy(posed[to]).sub(center).dot(axis);
            if (da * db >= 0) continue;
            delta.copy(posed[from]).lerp(posed[to], da / (da - db)).sub(center);
            if (delta.length() < length * 0.5) points.push([delta.dot(u), delta.dot(v)]);
          }
        }
        assert(points.length >= 3, `${clip}/${side}: elbow cross-section is missing`);
        let diameter = Infinity;
        for (let direction = 0; direction < 32; direction++) {
          const angle = direction * Math.PI / 32;
          let min = Infinity, max = -Infinity;
          for (const [x, y] of points) {
            const projection = x * Math.cos(angle) + y * Math.sin(angle);
            min = Math.min(min, projection);
            max = Math.max(max, projection);
          }
          diameter = Math.min(diameter, max - min);
        }
        assert(Number.isFinite(diameter) && diameter > 0, `${clip}/${side}: invalid surface`);
        diameters.push(diameter);
      }
      const ratio = Math.min(...diameters) / Math.max(...diameters);
      // The original left Shoot elbow falls to 0.833. A smooth joint retains
      // at least 86% of its neighboring diameter across this short band.
      assert(ratio >= 0.86, `${clip}/${side}: pinched elbow (${ratio.toFixed(3)})`);
      rows.push({ clip, side, thicknessRatio: Number(ratio.toFixed(4)) });
    }
  }
  console.log(JSON.stringify({ passed: true, elbows: rows }, null, 2));
} finally {
  await server.close();
}
