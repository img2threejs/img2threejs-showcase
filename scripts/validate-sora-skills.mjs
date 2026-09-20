import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { createSoraShowcase } = await server.ssrLoadModule('/src/demos/sora/soraShowcase.ts');
  const rows = [];
  for (const initialSkin of ['default', 'kingdom-key']) {
    const scene = new THREE.Scene();
    const root = createSoraShowcase({ initialSkin });
    scene.add(root);
    const runtime = root.userData.sculptRuntime;
    const animation = runtime.animationController;
    const effects = scene.getObjectByName('sora-inspired-skills');
    const step = (seconds) => {
      let remaining = seconds;
      while (remaining > 1e-8) {
        const delta = Math.min(remaining, 1 / 60);
        root.userData.tick(delta);
        remaining -= delta;
      }
    };
    step(0.1);
    assert.equal(effects.visible, false, 'Idle must not emit combat effects');
    assert.equal(root.getObjectByName('sora-inspired-skills'), undefined,
      'effects must not become explodable body parts');

    for (const [clip, time] of [
      ['preset:biped:slash', 1.35],
      ['preset:biped:run', 0.65], ['preset:biped:jump', 0.55],
    ]) {
      animation.play(clip);
      step(time);
      assert(effects.visible, `${initialSkin}/${clip}: missing skill effect`);
      runtime.strikeVfx.setElement('off');
      assert.equal(effects.visible, false, 'Off must clear an effect immediately');
      step(0.2);
      assert.equal(effects.visible, false, 'Off must suppress continued emission');
      runtime.strikeVfx.setElement('sora');
      animation.play(clip);
      step(time);
      assert(effects.visible, `${clip}: replay must re-arm the effect`);
      animation.stop();
      assert.equal(effects.visible, false, 'Stop must clear combat effects');
      rows.push({ skin: initialSkin, clip, passed: true });
    }

    animation.play('preset:biped:slash');
    step(1.35);
    animation.play('preset:biped:shoot');
    for (let i = 0; i < 600; i++) {
      step(1 / 60);
      assert.equal(effects.visible, false, 'Shoot must never emit or retain combat VFX');
    }
    animation.play('preset:biped:slash');
    step(1.35);
    assert(runtime.outfitController.switchSkin());
    assert.equal(effects.visible, false, 'outfit reveal must cancel active combat effects');
    step(1);
    assert.equal(effects.visible, false, 'combat effects must stay suppressed during reveal');
    step(1.3);
    assert.equal(runtime.outfitController.state.switching, false);
    assert.notEqual(runtime.outfitController.state.skinId, initialSkin);
    animation.play('preset:biped:slash');
    step(1.35);
    assert(effects.visible, 'effects must bind to the replacement skeleton');

    // Root-motion compensation keeps the showcase framed without suppressing
    // jump height or modifying any bone tracks.
    animation.play('preset:biped:run');
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const hip = new THREE.Vector3();
    for (let i = 0; i < 180; i++) {
      step(1 / 60);
      const rig = root.children.find((child) => child.userData.rigged).userData.rigged;
      rig.mesh.skeleton.bones.find((bone) => bone.name === 'Hip').getWorldPosition(hip);
      minX = Math.min(minX, hip.x); maxX = Math.max(maxX, hip.x);
      minZ = Math.min(minZ, hip.z); maxZ = Math.max(maxZ, hip.z);
    }
    assert(maxX - minX < 0.001 && maxZ - minZ < 0.001, 'run escaped the showcase frame');
    animation.play('preset:biped:jump');
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < 100; i++) {
      step(1 / 60);
      const rig = root.children.find((child) => child.userData.rigged).userData.rigged;
      rig.mesh.skeleton.bones.find((bone) => bone.name === 'Hip').getWorldPosition(hip);
      minY = Math.min(minY, hip.y); maxY = Math.max(maxY, hip.y);
    }
    assert(maxY - minY > 0.2, 'framing must preserve vertical jump motion');
  }
  console.log(JSON.stringify({ passed: true, scenarios: rows }, null, 2));
} finally {
  await server.close();
}
