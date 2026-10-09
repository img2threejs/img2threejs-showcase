import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../../src/demos/tropical-island/campfire.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const resolved = outputText.replace(/from ['"]three['"]/, `from ${JSON.stringify(import.meta.resolve('three'))}`);
const { createCampfireVfx } = await import(`data:text/javascript;base64,${Buffer.from(resolved).toString('base64')}`);

function disposeResources(fire) {
  fire.group.traverse((object) => {
    object.geometry?.dispose();
    object.material?.dispose();
  });
}

test('an extinguished campfire stays dark through normal and reduced-motion day/night ticks', () => {
  const fire = createCampfireVfx();
  const light = fire.group.children.find((object) => object.isPointLight);
  assert.equal(fire.lit, true);
  fire.tick(1, 1, false);
  assert.ok(light.intensity > 0);
  fire.extinguish();
  for (const reduced of [false, true]) {
    for (const night of [0, 1]) {
      fire.tick(15 + night, night, reduced);
      assert.equal(fire.lit, false);
      assert.equal(light.intensity, 0);
    }
  }
  fire.dispose();
  disposeResources(fire);
});

test('only explicit relight restores flame and illumination; disposal cannot resurrect it', () => {
  const fire = createCampfireVfx();
  const light = fire.group.children.find((object) => object.isPointLight);
  fire.extinguish();
  fire.relight();
  fire.tick(6, 0.5, false);
  assert.equal(fire.lit, true);
  assert.ok(light.intensity > 0);
  fire.extinguish();
  fire.tick(120, 1, false);
  assert.equal(fire.lit, false);
  assert.equal(light.intensity, 0);
  fire.dispose();
  fire.dispose();
  fire.relight();
  fire.tick(121, 1, false);
  assert.equal(fire.lit, false);
  assert.equal(light.intensity, 0);
  disposeResources(fire);
});
