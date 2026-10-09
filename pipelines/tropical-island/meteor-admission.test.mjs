import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { loadPhysicsModule } from './load-physics.mjs';

const { ShallowWater } = await loadPhysicsModule('shallowWater');
const { createRockDrops } = await loadPhysicsModule('rockDrops');

function fixture(t, bed = () => -5) {
  const simulation = new ShallowWater(bed);
  const root = new THREE.Group();
  const owned = [];
  function mesh(parent = root) {
    const object = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshPhysicalMaterial());
    parent.add(object);
    owned.push(object);
    return object;
  }
  const waterMesh = mesh(), terrain = mesh();
  const ocean = {
    mesh: waterMesh, simulation,
    uniforms: { islandTime: { value: 0 } },
    sampleSurface: (x, z, target) => simulation.sample(x, z, target),
    sync: () => simulation.pack(),
    acknowledge: () => {},
  };
  const drops = createRockDrops(ocean, root, terrain);
  t.after(() => {
    drops.dispose();
    for (const object of owned) {
      object.geometry.dispose();
      object.material.dispose();
    }
  });
  return {
    root, ocean, simulation, drops, mesh, owned,
    step(dt = 1 / 60) {
      simulation.advance(dt);
      simulation.pack();
      ocean.uniforms.islandTime.value += dt;
      drops.tick();
    },
  };
}

function cell(sim, x, z) {
  const nearest = value => sim.axis.reduce((best, coordinate, i) =>
    Math.abs(coordinate - value) < Math.abs(sim.axis[best] - value) ? i : best, 0);
  return nearest(z) * sim.size + nearest(x);
}

test('admission checks the whole footprint against shallow bed, depressed water and domain edges', t => {
  const shore = fixture(t, x => x < 7.5 ? -0.05 : -5);
  assert.ok(shore.simulation.depth[cell(shore.simulation, 8, 1)] > 4, 'centre alone is deep enough');
  assert.equal(shore.drops.canDrop(8, 1), false, 'shallow edge blocks the whole boulder');
  const clear = fixture(t);
  assert.equal(clear.drops.canDrop(8, 1), true);
  clear.simulation.depth[cell(clear.simulation, 7.4, 1)] = 0.05;
  assert.equal(clear.drops.canDrop(8, 1), false, 'a depressed water cell under the edge also blocks');
  for (const [x, z] of [[99.9, 0], [-99.9, 0], [0, 99.9], [0, -99.9], [NaN, 0], [0, Infinity]]) {
    assert.equal(clear.drops.canDrop(x, z), false, `reject (${x},${z})`);
  }
});

test('flooded land remains forbidden even when every overlapping cell has deep water', t => {
  const { simulation, drops } = fixture(t, () => 0.5);
  simulation.depth.fill(5);
  simulation.pack();
  assert.equal(drops.canDrop(8, 1), false);
});

test('late props and moved, scaled parents are checked in the transformed ocean coordinate frame', t => {
  const fx = fixture(t);
  assert.equal(fx.drops.canDrop(8, 1), true);
  const parent = new THREE.Group();
  fx.root.add(parent);
  parent.position.set(8, 1, 1);
  fx.mesh(parent);
  assert.equal(fx.drops.canDrop(8, 1), false, 'late mount blocks');
  parent.position.x = 20;
  assert.equal(fx.drops.canDrop(8, 1), true, 'moving away frees the old column');
  parent.position.x = 8;
  parent.scale.set(4, 1, 1);
  parent.rotation.y = Math.PI / 4;
  const world = new THREE.Group();
  world.position.set(30, 5, -20);
  world.rotation.y = 0.67;
  world.scale.set(1.4, 0.8, 0.6);
  world.add(fx.root);
  assert.equal(fx.drops.canDrop(10.5, 1), false, 'scaled rotated edge blocks in ocean-local space');
  assert.equal(fx.drops.canDrop(12.5, 1), true, 'world transforms do not create a false obstacle');
});

test('pointer transparency does not remove solidity, but runtime descendants do not inflate a solid mesh', t => {
  const fx = fixture(t);
  const solid = fx.mesh();
  solid.position.set(8, 1, 1);
  solid.userData.isPointerTransparent = true;
  const flame = fx.mesh(solid);
  flame.position.set(20, 0, 0);
  flame.scale.setScalar(4);
  flame.userData.isRuntimeEffect = true;
  assert.equal(fx.drops.canDrop(8, 1), false, 'transparent-to-pointer solid blocks');
  assert.equal(fx.drops.canDrop(18, 1), true, 'runtime child cannot stretch the parent bounds');
  assert.equal(fx.drops.canDrop(28, 1), true, 'runtime child itself is not solid');
});

test('instance transforms, including changes after the first query, determine occupied columns', t => {
  const fx = fixture(t);
  const instance = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshPhysicalMaterial(), 1);
  fx.root.add(instance);
  fx.owned.push(instance);
  const matrix = new THREE.Matrix4().makeTranslation(8, 1, 1);
  instance.setMatrixAt(0, matrix);
  assert.equal(fx.drops.canDrop(8, 1), false, 'offset instance blocks, not just the origin geometry');
  instance.setMatrixAt(0, matrix.makeTranslation(20, 1, 1));
  assert.equal(fx.drops.canDrop(8, 1), true);
  assert.equal(fx.drops.canDrop(20, 1), false);
});

test('rejections preserve fluid state and pool capacity; active columns cannot overlap', t => {
  const fx = fixture(t);
  fx.mesh().position.set(8, 1, 1);
  const fields = ['depth', 'momentumX', 'momentumZ', 'wetness'];
  const before = fields.map(key => fx.simulation[key].slice());
  assert.equal(fx.drops.drop(8, 1), false);
  assert.equal(fx.drops.drop(NaN, 1), false);
  fields.forEach((key, i) => assert.deepEqual(fx.simulation[key], before[i]));
  assert.equal(fx.drops.drop(12, 1), true);
  assert.equal(fx.drops.canDrop(12.1, 1), false, 'overlap rejected while four slots are still free');
  const points = [[16, 1], [20, 1], [12, 5], [16, 5]];
  for (const [x, z] of points) assert.equal(fx.drops.drop(x, z), true, `free slot at (${x},${z})`);
  assert.equal(fx.drops.canDrop(20, 5), false, 'full pool reported by the input predicate');
  assert.equal(fx.drops.drop(20, 5), false);
  fields.forEach((key, i) => assert.deepEqual(fx.simulation[key], before[i], 'no flight/rejection mutates fluid'));
});

test('reduced motion never launches a body and cancellation releases its reserved column', t => {
  const fx = fixture(t);
  assert.equal(fx.drops.drop(8, 1, true), true);
  const rocks = fx.drops.group.children.filter(object => object.name === 'Falling rock');
  assert.ok(rocks.every(rock => !rock.visible));
  assert.equal(fx.drops.drop(8, 1), true);
  assert.equal(fx.drops.canDrop(8, 1), false);
  fx.drops.tick(true);
  assert.ok(rocks.every(rock => !rock.visible));
  assert.equal(fx.drops.canDrop(8, 1), true);
});

test('one vertical trajectory descends, submerges, rests above the bed and retires for reuse', t => {
  const fx = fixture(t);
  assert.equal(fx.drops.drop(8, 1), true);
  const rock = fx.drops.group.children.find(object => object.name === 'Falling rock' && object.visible);
  const vertex = new THREE.Vector3(), surface = new THREE.Vector3();
  const positions = rock.geometry.getAttribute('position');
  let previousY = rock.position.y;
  let fullySubmerged = false, grounded = false, retired = false;
  for (let frame = 0; frame < 600; frame++) {
    fx.step();
    let bottom = Infinity, top = -Infinity;
    for (let i = 0; i < positions.count; i++) {
      vertex.fromBufferAttribute(positions, i).applyQuaternion(rock.quaternion);
      bottom = Math.min(bottom, vertex.y + rock.position.y);
      top = Math.max(top, vertex.y + rock.position.y);
    }
    fx.simulation.sample(rock.position.x, rock.position.z, surface);
    if (bottom > surface.x) {
      assert.equal(rock.position.x, 8, 'airborne X never moves');
      assert.equal(rock.position.z, 1, 'airborne Z never moves');
    }
    if (rock.visible) assert.ok(rock.position.y <= previousY + 0.003, 'no visible upward bounce');
    previousY = rock.position.y;
    assert.ok(bottom >= -5 - 1e-8, 'rotated geometry cannot penetrate the bed');
    fullySubmerged ||= top < surface.x - 0.2;
    grounded ||= Math.abs(bottom + 5) < 1e-7;
    if (fx.drops.canDrop(8, 1)) { retired = true; break; }
  }
  assert.ok(fullySubmerged, 'whole rock passes below the surface');
  assert.ok(grounded, 'rock actually reaches the bed');
  assert.ok(retired, 'settled column is released');
  assert.equal(fx.drops.drop(8, 1), true, 'retired slot can be reused');
});
