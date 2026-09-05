#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const baseUrl = process.argv.find((value) => value.startsWith('--base-url='))?.split('=')[1]
  ?? 'http://127.0.0.1:4173';
const output = resolve(process.argv.find((value) => value.startsWith('--output='))?.split('=')[1]
  ?? 'export-validation/2026-09-05-multi-model-zip');

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

async function waitForDownload(page, locator, destination) {
  const pending = page.waitForEvent('download', { timeout: 15 * 60 * 1000 });
  await locator.evaluate((element) => element.click());
  const download = await pending;
  await download.saveAs(destination);
  await page.waitForFunction(() => (
    document.querySelector('#demo-export-status')?.getAttribute('data-state') !== 'busy'
  ), undefined, { timeout: 15 * 60 * 1000 });
  const state = await page.locator('#demo-export-status').getAttribute('data-state');
  const summary = await page.locator('#demo-export-summary').textContent();
  assert(state === 'success' || state === 'warning', `Export UI ended in ${state}: ${summary}`);
  return download.suggestedFilename();
}

async function inspectGlb(path) {
  const bytes = await readFile(path);
  assert(bytes.toString('ascii', 0, 4) === 'glTF', `${path} has no GLB magic`);
  assert(bytes.readUInt32LE(4) === 2, `${path} is not GLB v2`);
  assert(bytes.readUInt32LE(8) === bytes.byteLength, `${path} has an invalid declared length`);
  const jsonLength = bytes.readUInt32LE(12);
  const document = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').trimEnd());
  const names = (document.nodes ?? []).map((node) => node.name).filter(Boolean);
  return {
    bytes: bytes.byteLength,
    nodes: document.nodes?.length ?? 0,
    meshes: document.meshes?.length ?? 0,
    materials: document.materials?.length ?? 0,
    textures: document.textures?.length ?? 0,
    animations: document.animations?.length ?? 0,
    names,
  };
}

await mkdir(output, { recursive: true });
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 960 } });
const page = await context.newPage();
page.setDefaultTimeout(15 * 60 * 1000);
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

try {
  await page.goto(`${baseUrl}/#/demo/starship-super-heavy`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.__IMG2THREEJS_EXPORT__ === 'function');
  const exportTab = page.locator('#demo-tab-export');
  if (await exportTab.count()) await exportTab.click();
  await page.waitForFunction(() => document.querySelectorAll('#demo-export-scope-select option').length === 3);

  const scopeOptions = await page.locator('#demo-export-scope-select option').evaluateAll((options) => (
    options.map((option) => ({ value: option.value, label: option.textContent?.trim() }))
  ));
  assert(JSON.stringify(scopeOptions) === JSON.stringify([
    { value: 'all', label: 'All models (2)' },
    { value: 'super-heavy', label: 'Super Heavy booster' },
    { value: 'starship', label: 'Starship upper stage' },
  ]), `Unexpected export scopes: ${JSON.stringify(scopeOptions)}`);

  const tooltipAudit = [];
  const infoButtons = page.locator('[data-export-info]');
  assert(await infoButtons.count() === 6, 'Expected one info control for each of six formats');
  for (let index = 0; index < 6; index += 1) {
    const button = infoButtons.nth(index);
    await button.focus();
    const tooltipId = await button.getAttribute('aria-describedby');
    assert(tooltipId, `Info control ${index} has no described tooltip`);
    const tooltip = page.locator(`#${tooltipId}`);
    const text = (await tooltip.textContent())?.replace(/\s+/g, ' ').trim() ?? '';
    const display = await tooltip.evaluate((element) => getComputedStyle(element).display);
    assert(display !== 'none', `${tooltipId} is not visible on keyboard focus`);
    assert(text.includes('Keeps') && text.includes('Limits'), `${tooltipId} omits portability detail`);
    tooltipAudit.push({ id: tooltipId, text });
  }

  await infoButtons.first().click();
  await page.locator('#demo-export').evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: join(output, 'desktop-export-ui.png') });

  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.locator('#demo-panel').getAttribute('data-expanded') !== 'true') {
    await page.locator('.demo-panel-bar').click();
  }
  await page.waitForFunction(() => document.querySelector('#demo-panel')?.getAttribute('data-expanded') === 'true');
  if (await exportTab.count()) await exportTab.click();
  if (await infoButtons.first().getAttribute('aria-expanded') !== 'true') await infoButtons.first().click();
  const inspectorPanes = page.locator('.demo-inspector-panes');
  if (await inspectorPanes.count()) {
    await inspectorPanes.evaluate((element) => { element.scrollTop = 0; });
  }
  const mobileLayout = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const nodes = [...document.querySelectorAll('.demo-export, .demo-export-format-row, .demo-export-tooltip')];
    return {
      viewportWidth,
      documentWidth: document.documentElement.scrollWidth,
      overflows: nodes.map((node) => {
        const box = node.getBoundingClientRect();
        return { className: node.className, left: box.left, right: box.right };
      }).filter((box) => box.left < -1 || box.right > viewportWidth + 1),
    };
  });
  assert(mobileLayout.documentWidth <= mobileLayout.viewportWidth + 1, 'Mobile page has horizontal overflow');
  assert(mobileLayout.overflows.length === 0, `Mobile export controls overflow: ${JSON.stringify(mobileLayout.overflows)}`);
  await page.screenshot({ path: join(output, 'mobile-export-ui.png') });

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator('#demo-export-scope-select').selectOption('starship');
  const starshipPath = join(output, 'starship-super-heavy--starship.glb');
  const starshipFilename = await waitForDownload(
    page,
    page.locator('[data-export-format="glb"]'),
    starshipPath,
  );
  assert(starshipFilename === 'starship-super-heavy--starship.glb', `Unexpected filename ${starshipFilename}`);

  await page.locator('#demo-export-scope-select').selectOption('super-heavy');
  const boosterPath = join(output, 'starship-super-heavy--super-heavy.glb');
  const boosterFilename = await waitForDownload(
    page,
    page.locator('[data-export-format="glb"]'),
    boosterPath,
  );
  assert(boosterFilename === 'starship-super-heavy--super-heavy.glb', `Unexpected filename ${boosterFilename}`);

  await page.locator('#demo-export-scope-select').selectOption('starship');
  const selectedZipPath = join(output, 'starship-super-heavy--starship-all-formats.zip');
  const selectedZipFilename = await waitForDownload(page, page.locator('#demo-export-all'), selectedZipPath);
  assert(
    selectedZipFilename === 'starship-super-heavy--starship-all-formats.zip',
    `Unexpected selected ZIP filename ${selectedZipFilename}`,
  );
  execFileSync('/usr/bin/unzip', ['-t', selectedZipPath], { stdio: 'pipe' });
  const selectedEntries = execFileSync('/usr/bin/unzip', ['-Z1', selectedZipPath], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  assert(selectedEntries.length === 7 && selectedEntries.includes('starship-super-heavy--starship.glb'),
    `Selected ZIP entries are invalid: ${selectedEntries.join(', ')}`);
  const selectedManifest = JSON.parse(execFileSync(
    '/usr/bin/unzip',
    ['-p', selectedZipPath, 'manifest.json'],
    { encoding: 'utf8' },
  ));
  assert(selectedManifest.scope?.id === 'starship' && selectedManifest.scope?.kind === 'declared-model',
    'Selected ZIP manifest scope is invalid');

  await page.locator('#demo-export-scope-select').selectOption('all');
  const zipPath = join(output, 'starship-super-heavy-all-formats.zip');
  const zipFilename = await waitForDownload(page, page.locator('#demo-export-all'), zipPath);
  assert(zipFilename === 'starship-super-heavy-all-formats.zip', `Unexpected ZIP filename ${zipFilename}`);

  const entries = execFileSync('/usr/bin/unzip', ['-Z1', zipPath], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  const expectedEntries = [
    'starship-super-heavy.glb',
    'starship-super-heavy.gltf',
    'starship-super-heavy.obj',
    'starship-super-heavy.stl',
    'starship-super-heavy.ply',
    'starship-super-heavy.usdz',
    'manifest.json',
  ];
  assert(JSON.stringify(entries) === JSON.stringify(expectedEntries), `Unexpected ZIP entries: ${entries.join(', ')}`);
  execFileSync('/usr/bin/unzip', ['-t', zipPath], { stdio: 'pipe' });
  const extracted = join(output, 'unzipped');
  await mkdir(extracted, { recursive: true });
  execFileSync('/usr/bin/unzip', ['-oq', zipPath, '-d', extracted]);
  const manifest = JSON.parse(await readFile(join(extracted, 'manifest.json'), 'utf8'));
  assert(manifest.scope?.id === 'all' && manifest.scope?.kind === 'full-assembly', 'ZIP manifest scope is invalid');
  assert(manifest.files?.length === 6, 'ZIP manifest does not describe all six formats');
  for (const file of manifest.files) {
    const info = await stat(join(extracted, file.filename));
    assert(info.size === file.bytes, `${file.filename} size differs from its manifest`);
  }

  const starshipGlb = await inspectGlb(starshipPath);
  const boosterGlb = await inspectGlb(boosterPath);
  const assemblyGlb = await inspectGlb(join(extracted, 'starship-super-heavy.glb'));
  assert(starshipGlb.names.includes('starship') && starshipGlb.names.includes('shipEngineBay'), 'Starship selection lost its expected hierarchy');
  assert(!starshipGlb.names.includes('boosterHull'), 'Starship selection incorrectly contains Super Heavy geometry');
  assert(boosterGlb.names.includes('superHeavy') && boosterGlb.names.includes('boosterHull'), 'Super Heavy selection lost its expected hierarchy');
  assert(!boosterGlb.names.includes('shipEngineBay'), 'Super Heavy selection incorrectly contains Starship geometry');
  assert(assemblyGlb.names.includes('boosterHull') && assemblyGlb.names.includes('shipEngineBay'), 'All-model GLB does not contain both declared models');

  const result = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    scopeOptions,
    tooltipAudit,
    mobileLayout,
    downloads: {
      starship: starshipGlb,
      superHeavy: boosterGlb,
      assembly: assemblyGlb,
      selectedZip: {
        path: selectedZipPath,
        bytes: (await stat(selectedZipPath)).size,
        entries: selectedEntries,
      },
      zip: { path: zipPath, bytes: (await stat(zipPath)).size, entries },
    },
    manifest,
    pageErrors,
    success: pageErrors.length === 0,
  };
  await writeFile(join(output, 'qa-result.json'), `${JSON.stringify(result, null, 2)}\n`);
  assert(result.success, `Browser page errors: ${pageErrors.join('; ')}`);
  process.stdout.write(`PASS tooltips=${tooltipAudit.length} scopes=${scopeOptions.length} zipEntries=${entries.length}\n`);
  process.stdout.write(`OUTPUT ${output}\n`);
} finally {
  await context.close();
  await browser.close();
}
