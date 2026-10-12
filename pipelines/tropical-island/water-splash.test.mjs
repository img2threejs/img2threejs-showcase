import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { loadPhysicsModule } from './load-physics.mjs';

const { ShallowWater } = await loadPhysicsModule('shallowWater');
const { EntrySplash } = await loadPhysicsModule('entrySplash');

function volume(flow) {
  let total = 0;
  for (let i = 0; i < flow.depth.length; i++) {
    total += flow.depth[i] * flow.cellWidths[i % flow.size] * flow.cellWidths[(i / flow.size) | 0];
  }
  return total;
}

function fixture(vx, vy, vz = 0, sampleSurface) {
  const flow = new ShallowWater(() => -2);
  const radius = 0.72, bodyVolume = 4 / 3 * Math.PI * radius ** 3;
  const body = { x: 0, y: 0.3, z: 0, vx, vy, vz, wx: 0, wy: 0, wz: 0,
    radius, mass: bodyVolume * 2650, volume: bodyVolume, inertia: 1, submergedVolume: 0.3 };
  const water = { height: 0, depth: 2, bed: -2, slopeX: 0, slopeZ: 0, velocityX: 0, velocityY: 0, velocityZ: 0 };
  const rockGeometry = new THREE.SphereGeometry(radius, 24, 16);
  const geometry = new THREE.SphereGeometry(1, 12, 8);
  const material = new THREE.MeshPhysicalMaterial(), foamMaterial = new THREE.MeshStandardMaterial();
  const rock = new THREE.Mesh(rockGeometry, material);
  rock.position.set(body.x, body.y, body.z);
  const splash = new EntrySplash({ simulation: flow, sampleSurface: sampleSurface ?? flow.sample.bind(flow) },
    rock, material, geometry, geometry, foamMaterial);
  splash.begin(0, 0, radius);
  return {
    flow, splash, body, water,
    emit(work, final = true) {
      const step = { impulseX: 0, impulseY: 0, impulseZ: 0, displacedVolume: 0.3,
        submerged: 0.3 / bodyVolume, normalSpeed: -vy, work, grounded: false };
      splash.feed(body, step, water);
      // Complete immersion: existing detached parcels remain physical, not timed away.
      if (final) splash.feed({ ...body, y: -1 }, { ...step, displacedVolume: 0, submerged: 1, work: 0 }, water);
      splash.render();
    },
    dispose() { splash.dispose(); rockGeometry.dispose(); geometry.dispose(); material.dispose(); foamMaterial.dispose(); },
  };
}

for (const vy of [-12, -0.0001]) {
  test(`an excess work budget cannot exceed local pressure-head discharge speed (vy=${vy})`, () => {
    const f = fixture(13, vy);
    try {
      const beforeVolume = volume(f.flow);
      f.emit(1e6);
      const before = f.splash.drops.instanceMatrix.array.slice();
      assert.ok(f.splash.drops.visible, 'the impact must actually emit liquid');
      assert.ok(volume(f.flow) < beforeVolume, 'ejecta must withdraw real water');
      f.splash.advance(0.02); f.splash.render();
      const after = f.splash.drops.instanceMatrix.array;
      const maxTravel = Math.hypot(13, vy) * 0.02 + 0.5 * 9.81 * 0.02 ** 2 + 1e-4;
      for (let i = 0; i < before.length; i += 16) {
        if (before[i] <= 0 || after[i] <= 0) continue;
        const travel = Math.hypot(after[i + 12] - before[i + 12], after[i + 13] - before[i + 13], after[i + 14] - before[i + 14]);
        assert.ok(travel <= maxTravel, `liquid travelled ${travel}, pressure-head bound ${maxTravel}`);
      }
      f.splash.reset(true);
      assert.ok(Math.abs(volume(f.flow) - beforeVolume) < 1e-6, 'cancellation must return every remaining parcel');
    } finally { f.dispose(); }
  });
}

test('ballistic liquid re-entry restores water instead of expiring particles mid-flight', () => {
  const f = fixture(0.5, -2);
  try {
    const before = volume(f.flow);
    f.emit(100);
    assert.ok(f.splash.drops.visible);
    for (let i = 0; i < 240; i++) f.splash.advance(1 / 120);
    f.splash.render();
    assert.equal(f.splash.drops.visible, false);
    assert.ok(Math.abs(volume(f.flow) - before) < 1e-6, 'all ejected water must be back in the solver');
    assert.ok(f.flow.momentumX.some(v => Math.abs(v) > 1e-6), 're-entry must transfer momentum into real secondary waves');
  } finally { f.dispose(); }
});

for (const separation of [0.0001, 0.12, 4]) {
  test(`material rows ${separation} body radii apart never create long or sliver sheet triangles`, () => {
    // Hold the interface flat for the compressed-row case so cavity depth
    // cannot mask its near-coincident geometry. Liquid exchange uses the real solver.
    const compressed = separation < 0.01;
    const f = fixture(9, -12, 3, compressed ? (_x, _z, target) => target.set(0, 0, 0) : undefined);
    try {
      const beforeVolume = volume(f.flow);
      f.emit(1e6, false);
      f.body.x += separation * f.body.radius;
      f.body.z += separation * f.body.radius * 0.4;
      f.emit(1e6);
      const sheet = f.splash.sheet.geometry;
      const positions = sheet.getAttribute('position'), indices = sheet.getIndex();
      if (!compressed && separation < 1) {
        assert.ok(sheet.drawRange.count > 0, 'nearby material rows must still form real sheets');
      }
      const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
      const ab = new THREE.Vector3(), ac = new THREE.Vector3();
      for (let i = 0; i < sheet.drawRange.count; i += 3) {
        for (let edge = 0; edge < 3; edge++) {
          const a = indices.getX(i + edge), b = indices.getX(i + (edge + 1) % 3);
          const span = Math.hypot(
            positions.getX(a) - positions.getX(b),
            positions.getY(a) - positions.getY(b),
            positions.getZ(a) - positions.getZ(b),
          );
          assert.ok(span <= f.body.radius * 2, `triangle spans ${span}, body diameter ${f.body.radius * 2}`);
        }
        a.fromBufferAttribute(positions, indices.getX(i));
        b.fromBufferAttribute(positions, indices.getX(i + 1));
        c.fromBufferAttribute(positions, indices.getX(i + 2));
        const longestSquared = Math.max(a.distanceToSquared(b), a.distanceToSquared(c), b.distanceToSquared(c));
        const twiceArea = ab.subVectors(b, a).cross(ac.subVectors(c, a)).length();
        assert.ok(longestSquared <= (12 + 1e-4) * twiceArea,
          `rendered triangle is a sliver: edge²/twiceArea=${longestSquared / twiceArea}`);
      }
      if (compressed || separation > 1) {
        assert.equal(sheet.drawRange.count, 0, 'compressed or widely separated rows must detach instead of stitching a strip');
        assert.ok(f.splash.drops.visible, 'unlinked liquid must remain visible as real droplets');
        const matrices = f.splash.drops.instanceMatrix.array;
        let representedVolume = 0;
        for (let i = 0; i < matrices.length; i += 16) {
          assert.equal(matrices[i], matrices[i + 5], 'drop X/Y scale must match');
          assert.equal(matrices[i], matrices[i + 10], 'drop X/Z scale must match');
          representedVolume += 4 / 3 * Math.PI * matrices[i] ** 3;
        }
        assert.ok(Math.abs(representedVolume - (beforeVolume - volume(f.flow))) < 1e-6,
          'detached geometry must retain the entire withdrawn liquid volume');
      }
      f.splash.reset(true);
      assert.ok(Math.abs(volume(f.flow) - beforeVolume) < 1e-6, 'sheet rupture must not change refund volume');
      f.splash.reset(true);
      assert.ok(Math.abs(volume(f.flow) - beforeVolume) < 1e-6, 'a cancelled parcel must never refund twice');
    } finally { f.dispose(); }
  });
}

for (const [vx, vz] of [[13, 0], [9, 9]]) {
  for (const vy of [-12, -0.0001]) {
    test(`oblique liquid fans to both sides without losing trajectory asymmetry (${vx}, ${vy}, ${vz})`, () => {
      const f = fixture(vx, vy, vz);
      try {
        f.emit(1e6);
        assert.ok(f.splash.drops.visible, 'the distribution must contain actual emitted liquid');
        const before = f.splash.drops.instanceMatrix.array.slice();
        f.splash.advance(0.01); f.splash.render();
        const after = f.splash.drops.instanceMatrix.array;
        const speed = Math.hypot(vx, vz), ux = vx / speed, uz = vz / speed;
        let left = 0, right = 0, netAlong = 0, netAcross = 0, front = 0, rear = 0;
        for (let i = 0; i < before.length; i += 16) {
          if (before[i] <= 0 || after[i] <= 0) continue;
          assert.equal(after[i], after[i + 5], 'ballistic drops must remain compact on Y');
          assert.equal(after[i], after[i + 10], 'ballistic drops must remain compact on Z');
          const dx = after[i + 12] - before[i + 12], dz = after[i + 14] - before[i + 14];
          const along = dx * ux + dz * uz, across = dz * ux - dx * uz;
          netAlong += along; netAcross += across;
          if (across > 0.001 && across > Math.abs(along) * 0.25) left++;
          if (across < -0.001 && -across > Math.abs(along) * 0.25) right++;
          if (before[i + 12] * ux + before[i + 14] * uz > 0) front += Math.hypot(dx, dz);
          else rear += Math.hypot(dx, dz);
        }
        assert.ok(left >= 3 && right >= 3, `expected a broad two-sided fan, got ${left} left / ${right} right parcels`);
        assert.ok(netAlong > Math.abs(netAcross) * 2, 'the fan must retain a net trajectory-directed reaction');
        assert.ok(front > rear * 1.2, `leading liquid must travel farther than trailing liquid (${front} vs ${rear})`);
      } finally { f.dispose(); }
    });
  }
}
