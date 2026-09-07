#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const baseUrl = process.argv.find((value) => value.startsWith('--base-url='))?.split('=')[1]
  ?? 'http://127.0.0.1:4173';
const output = resolve(process.argv.find((value) => value.startsWith('--output='))?.split('=')[1]
  ?? 'export-validation/2026-09-05-multi-model-zip/sony-selections');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    return import(pathToFileURL(join(globalRoot, 'playwright', 'index.mjs')).href);
  }
}

function glbNames(bytes) {
  assert(bytes.toString('ascii', 0, 4) === 'glTF', 'Downloaded selection is not a GLB');
  const jsonLength = bytes.readUInt32LE(12);
  const document = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').trimEnd());
  return {
    nodes: document.nodes?.length ?? 0,
    meshes: document.meshes?.length ?? 0,
    materials: document.materials?.length ?? 0,
    textures: document.textures?.length ?? 0,
    names: (document.nodes ?? []).map((node) => node.name).filter(Boolean),
  };
}

await mkdir(output, { recursive: true });
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

try {
  await page.goto(`${baseUrl}/#/demo/sony-wf1000xm3`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.__IMG2THREEJS_EXPORT__ === 'function');
  const exportTab = page.locator('#demo-tab-export');
  if (await exportTab.count()) await exportTab.click();
  await page.waitForFunction(() => document.querySelectorAll('#demo-export-scope-select option').length === 4);
  const scopes = await page.locator('#demo-export-scope-select option').evaluateAll((options) => (
    options.map((option) => ({ id: option.value, label: option.textContent?.trim() }))
  ));
  assert(JSON.stringify(scopes) === JSON.stringify([
    { id: 'all', label: 'All models (3)' },
    { id: 'charging-case', label: 'Charging case' },
    { id: 'left-earbud', label: 'Left earbud' },
    { id: 'right-earbud', label: 'Right earbud' },
  ]), `Unexpected Sony scopes: ${JSON.stringify(scopes)}`);

  const selections = {};
  for (const scope of scopes.slice(1)) {
    await page.locator('#demo-export-scope-select').selectOption(scope.id);
    const pending = page.waitForEvent('download', { timeout: 5 * 60 * 1000 });
    await page.locator('[data-export-format="glb"]').evaluate((button) => button.click());
    const download = await pending;
    const path = join(output, `sony-wf1000xm3--${scope.id}.glb`);
    await download.saveAs(path);
    await page.waitForFunction(() => (
      document.querySelector('#demo-export-status')?.getAttribute('data-state') !== 'busy'
    ));
    const bytes = await readFile(path);
    selections[scope.id] = { path, bytes: bytes.byteLength, ...glbNames(bytes) };
  }

  assert(selections['charging-case'].names.includes('chargingCase'), 'Charging case hierarchy is missing');
  assert(!selections['charging-case'].names.includes('leftEarbud'), 'Charging case includes an earbud');
  assert(selections['left-earbud'].names.includes('leftEarbud'), 'Left earbud hierarchy is missing');
  assert(!selections['left-earbud'].names.includes('rightEarbud'), 'Left selection includes the right earbud');
  assert(selections['right-earbud'].names.includes('rightEarbud'), 'Right earbud hierarchy is missing');
  assert(!selections['right-earbud'].names.includes('leftEarbud'), 'Right selection includes the left earbud');
  assert(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
  await writeFile(join(output, 'qa-result.json'), `${JSON.stringify({ scopes, selections, errors }, null, 2)}\n`);
  process.stdout.write(`PASS scopes=${scopes.length} selections=${Object.keys(selections).length}\n`);
  process.stdout.write(`OUTPUT ${output}\n`);
} finally {
  await context.close();
  await browser.close();
}
