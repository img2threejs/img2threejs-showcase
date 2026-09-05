#!/usr/bin/env node

/**
 * Production-browser export evidence runner.
 *
 * This deliberately clicks the same buttons a visitor clicks. Every resulting
 * browser download is retained, hashed, structurally inspected, and recorded
 * in manifest.json so export claims can be audited outside the app.
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHOWCASES = [
  { id: 'raz', status: 'final' },
  { id: 'mars-cat', status: 'final' },
  { id: 'monster', status: 'placeholder' },
  { id: 'leesin', status: 'final' },
  { id: 'boxing-man', status: 'placeholder' },
  { id: 'regret-warrior-reconstruction', status: 'placeholder' },
  { id: 'warrior', status: 'placeholder' },
  { id: 'starship-super-heavy', status: 'final' },
  { id: 'girl-character', status: 'placeholder' },
  { id: 'low-poly-humanoid', status: 'placeholder' },
  { id: 'awp-medusa-v2', status: 'final' },
  { id: 'electric-mouse-mascot', status: 'placeholder' },
  { id: 'glock-ghost-protocol', status: 'final' },
  { id: 'classic-fade', status: 'final' },
  { id: 'bmx-endurance', status: 'final' },
  { id: 'm9-doppler', status: 'final' },
  { id: 'sony-wf1000xm3', status: 'final' },
  { id: 'issaca-shotgun', status: 'final' },
  { id: 'gerber-knife', status: 'final' },
  { id: 'doraemon-house', status: 'final' },
  { id: 'warhauler', status: 'final' },
  { id: 'crown-chest', status: 'placeholder' },
  { id: 'talon-doppler-ruby', status: 'final' },
  { id: 'girl-character-3', status: 'final' },
];
const ALL_FORMATS = ['glb', 'gltf', 'obj', 'stl', 'ply', 'usdz'];

function option(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

const baseUrl = option('base-url', 'http://127.0.0.1:4173');
const outputRoot = resolve(option('output', 'export-validation/latest'));
const requestedIds = option('only', '').split(',').filter(Boolean);
const formats = option('formats', ALL_FORMATS.join(',')).split(',').filter(Boolean);
const resume = process.argv.includes('--resume');
const selected = requestedIds.length
  ? SHOWCASES.filter(({ id }) => requestedIds.includes(id))
  : SHOWCASES;

if (!selected.length) throw new Error('No matching showcase ids');
if (formats.some((format) => !ALL_FORMATS.includes(format))) {
  throw new Error(`Unknown format in ${formats.join(', ')}`);
}

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    return import(pathToFileURL(join(globalRoot, 'playwright', 'index.mjs')).href);
  }
}

async function sha256(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

async function readPrefix(path, length = 64 * 1024) {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

async function containsObjRecords(path) {
  let carry = '';
  let hasVertices = false;
  let hasNormals = false;
  let hasFaces = false;
  let hasUvs = false;
  let objects = 0;
  for await (const chunk of createReadStream(path, { encoding: 'utf8' })) {
    const text = carry + chunk;
    hasVertices ||= /(^|\n)v /.test(text);
    hasNormals ||= /(^|\n)vn /.test(text);
    hasFaces ||= /(^|\n)f /.test(text);
    hasUvs ||= /(^|\n)vt /.test(text);
    objects += (text.match(/(^|\n)o /g) ?? []).length;
    carry = text.slice(-4);
  }
  return { hasVertices, hasNormals, hasFaces, hasUvs, objects };
}

async function readGlbDocument(path) {
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(20);
    const headerRead = await file.read(header, 0, header.length, 0);
    if (headerRead.bytesRead !== header.length || header.toString('ascii', 0, 4) !== 'glTF') {
      throw new Error('GLB JSON inspection failed: invalid header');
    }
    const jsonLength = header.readUInt32LE(12);
    if (header.readUInt32LE(16) !== 0x4e4f534a) {
      throw new Error('GLB JSON inspection failed: first chunk is not JSON');
    }
    const json = Buffer.alloc(jsonLength);
    const jsonRead = await file.read(json, 0, json.length, 20);
    if (jsonRead.bytesRead !== json.length) throw new Error('GLB JSON inspection failed: truncated JSON chunk');
    return JSON.parse(json.toString('utf8').trimEnd());
  } finally {
    await file.close();
  }
}

function materialTextureIndices(materials = []) {
  const indices = [];
  const visit = (value, key = '') => {
    if (!value || typeof value !== 'object') return;
    if (key.endsWith('Texture') && Number.isInteger(value.index)) {
      indices.push(value.index);
      return;
    }
    for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
  };
  for (const material of materials) visit(material);
  return indices;
}

function inspectGltfDocument(document, expected) {
  if (document.asset?.version !== '2.0') throw new Error('glTF asset.version is not 2.0');
  const invalidAccessor = (document.accessors ?? []).findIndex((accessor) => (
    [...(accessor.min ?? []), ...(accessor.max ?? [])]
      .some((value) => typeof value !== 'number' || !Number.isFinite(value))
  ));
  if (invalidAccessor >= 0) {
    throw new Error(`glTF accessor ${invalidAccessor} contains non-finite bounds`);
  }
  const primitives = (document.meshes ?? []).flatMap((mesh) => mesh.primitives ?? []);
  const primitivesForNode = (node) => (
    node.mesh === undefined ? [] : document.meshes?.[node.mesh]?.primitives ?? []
  );
  const textureIndices = materialTextureIndices(document.materials);
  const result = {
    gltfVersion: document.asset.version,
    scenes: document.scenes?.length ?? 0,
    nodes: document.nodes?.length ?? 0,
    meshNodes: (document.nodes ?? []).filter((node) => node.mesh !== undefined).length,
    namedMeshNodes: (document.nodes ?? []).filter((node) => node.mesh !== undefined && node.name).length,
    meshes: document.meshes?.length ?? 0,
    primitives: primitives.length,
    materials: document.materials?.length ?? 0,
    textures: document.textures?.length ?? 0,
    images: document.images?.length ?? 0,
    textureBindings: textureIndices.length,
    uvPrimitives: primitives.filter((primitive) => primitive.attributes?.TEXCOORD_0 !== undefined).length,
    colouredPrimitives: primitives.filter((primitive) => primitive.attributes?.COLOR_0 !== undefined).length,
    skinnedPrimitives: primitives.filter((primitive) => (
      primitive.attributes?.JOINTS_0 !== undefined && primitive.attributes?.WEIGHTS_0 !== undefined
    )).length,
    uvMeshNodes: (document.nodes ?? []).filter((node) => primitivesForNode(node).some(
      (primitive) => primitive.attributes?.TEXCOORD_0 !== undefined,
    )).length,
    colouredMeshNodes: (document.nodes ?? []).filter((node) => primitivesForNode(node).some(
      (primitive) => primitive.attributes?.COLOR_0 !== undefined,
    )).length,
    weightedMeshNodes: (document.nodes ?? []).filter((node) => (
      node.skin !== undefined && primitivesForNode(node).some((primitive) => (
        primitive.attributes?.JOINTS_0 !== undefined && primitive.attributes?.WEIGHTS_0 !== undefined
      ))
    )).length,
    skins: document.skins?.length ?? 0,
    joints: (document.skins ?? []).reduce((sum, skin) => sum + (skin.joints?.length ?? 0), 0),
    animations: document.animations?.length ?? 0,
    animationChannels: (document.animations ?? []).reduce(
      (sum, animation) => sum + (animation.channels?.length ?? 0), 0,
    ),
  };
  if (!result.scenes || !result.nodes || !result.meshes || !result.primitives) {
    throw new Error(`glTF scene structure is incomplete: ${JSON.stringify(result)}`);
  }
  if (textureIndices.some((index) => index < 0 || index >= result.textures)) {
    throw new Error('glTF material references an invalid texture index');
  }
  if ((document.textures ?? []).some((texture) => (
    !Number.isInteger(texture.source) || texture.source < 0 || texture.source >= result.images
  ))) {
    throw new Error('glTF texture references an invalid image index');
  }
  if (expected) {
    const requirements = [
      ['meshNodes', expected.meshCount],
      ['namedMeshNodes', expected.namedPartCount],
      ['materials', expected.portableMaterialCount],
      ['textureBindings', expected.textureBindingCount],
      ['uvMeshNodes', expected.uvMeshCount],
      ['colouredMeshNodes', expected.vertexColourMeshCount],
      ['weightedMeshNodes', expected.skinnedMeshCount],
      ['skins', expected.skinnedMeshCount],
      ['animations', expected.animationCount],
    ];
    for (const [field, minimum] of requirements) {
      if (result[field] < minimum) {
        throw new Error(`glTF parity failed: ${field} expected >= ${minimum}, found ${result[field]}`);
      }
    }
    if (expected.portableTextureCount > 0 && (!result.textures || !result.images)) {
      throw new Error('glTF parity failed: source textures have no embedded image payload');
    }
  }
  return result;
}

async function inspectArtifact(path, format, expected) {
  const info = await stat(path);
  const prefix = await readPrefix(path);
  const evidence = { bytes: info.size, sha256: await sha256(path) };
  if (format === 'glb') {
    if (prefix.toString('ascii', 0, 4) !== 'glTF') throw new Error('GLB magic is missing');
    const version = prefix.readUInt32LE(4);
    const declaredBytes = prefix.readUInt32LE(8);
    if (version !== 2 || declaredBytes !== info.size) {
      throw new Error(`GLB header mismatch: version=${version}, declared=${declaredBytes}, actual=${info.size}`);
    }
    const document = await readGlbDocument(path);
    return { ...evidence, declaredBytes, ...inspectGltfDocument(document, expected) };
  }
  if (format === 'gltf') {
    const document = JSON.parse(await readFile(path, 'utf8'));
    return { ...evidence, ...inspectGltfDocument(document, expected) };
  }
  if (format === 'obj') {
    const records = await containsObjRecords(path);
    if (!records.hasVertices || !records.hasNormals || !records.hasFaces) {
      throw new Error(`OBJ records are incomplete: ${JSON.stringify(records)}`);
    }
    if (expected?.namedPartCount > records.objects) {
      throw new Error(`OBJ part parity failed: expected ${expected.namedPartCount}, found ${records.objects}`);
    }
    if (expected?.uvMeshCount > 0 && !records.hasUvs) {
      throw new Error('OBJ UV parity failed: source UVs are missing');
    }
    return { ...evidence, ...records };
  }
  if (format === 'stl') {
    if (info.size < 84) throw new Error('STL is shorter than its binary header');
    const triangles = prefix.readUInt32LE(80);
    if (84 + triangles * 50 !== info.size) throw new Error('STL triangle count does not match byte length');
    return { ...evidence, triangles };
  }
  if (format === 'ply') {
    const headerEnd = prefix.indexOf('end_header\n');
    if (prefix.toString('ascii', 0, 3) !== 'ply' || headerEnd < 0) throw new Error('PLY header is invalid');
    const header = prefix.toString('ascii', 0, headerEnd + 11);
    if (!header.includes('format binary_little_endian 1.0')) throw new Error('PLY is not binary little-endian');
    const vertices = Number(header.match(/element vertex (\d+)/)?.[1] ?? -1);
    const faces = Number(header.match(/element face (\d+)/)?.[1] ?? -1);
    if (vertices < 0 || faces < 0) throw new Error('PLY vertex/face counts are missing');
    const hasVertexColors = header.includes('property uchar red');
    const hasUvs = header.includes('property float s');
    if (expected?.vertexColourMeshCount > 0 && !hasVertexColors) {
      throw new Error('PLY colour parity failed: source vertex colours are missing');
    }
    if (expected?.uvMeshCount > 0 && !hasUvs) {
      throw new Error('PLY UV parity failed: source UVs are missing');
    }
    return { ...evidence, vertices, faces, hasVertexColors, hasUvs };
  }
  if (prefix.readUInt32LE(0) !== 0x04034b50) throw new Error('USDZ ZIP magic is missing');
  const usdcheck = spawnSync('/usr/bin/usdchecker', [path], { encoding: 'utf8', timeout: 5 * 60 * 1000 });
  const checkerText = `${usdcheck.stdout ?? ''}\n${usdcheck.stderr ?? ''}`;
  if (usdcheck.status !== 0 || !checkerText.includes('Success!')) {
    throw new Error(`usdchecker failed (${usdcheck.status}): ${checkerText.slice(-1000)}`);
  }
  return { ...evidence, usdchecker: 'Success!' };
}

async function waitForDownloadOrError(page, button) {
  let downloaded;
  let onDownload;
  const downloadPromise = new Promise((resolveDownload) => {
    onDownload = (download) => resolveDownload(download);
    page.once('download', onDownload);
  }).then((download) => {
    downloaded = download;
    return download;
  });
  // Schedule the real DOM click after this CDP evaluation returns. Some animation-heavy exports
  // enter a long microtask before Playwright receives the acknowledgement for locator.click(),
  // incorrectly turning successful work into a 15-minute actionability timeout.
  await button.evaluate((element) => {
    window.setTimeout(() => element.click(), 0);
  });
  const deadline = Date.now() + 15 * 60 * 1000;
  while (!downloaded && Date.now() < deadline) {
    await Promise.race([
      downloadPromise,
      new Promise((resolveWait) => setTimeout(resolveWait, 250)),
    ]);
    if (downloaded) return downloaded;
    const ui = await page.evaluate(() => ({
      state: document.querySelector('#demo-export-status')?.getAttribute('data-state') ?? '',
      status: document.querySelector('#demo-export-status')?.textContent?.trim() ?? '',
      summary: document.querySelector('#demo-export-summary')?.textContent?.trim() ?? '',
    }));
    if (ui.state === 'error') {
      page.off('download', onDownload);
      throw new Error(`${ui.status}: ${ui.summary}`);
    }
  }
  if (downloaded) return downloaded;
  page.off('download', onDownload);
  throw new Error('Timed out after 15 minutes waiting for a validated browser download');
}

await mkdir(outputRoot, { recursive: true });
const manifestPath = join(outputRoot, 'manifest.json');
let manifest;
if (resume) {
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    // A missing/incomplete prior manifest simply starts a fresh run.
  }
}
manifest ??= {
  generatedAt: new Date().toISOString(),
  baseUrl,
  outputRoot,
  requestedShowcases: selected.map(({ id }) => id),
  requestedFormats: formats,
  results: [],
};
manifest.completedAt = undefined;
manifest.success = undefined;
const recalculateTotals = () => {
  manifest.totals = {
    requested: selected.length * formats.length,
    passed: manifest.results.filter((result) => result.status === 'passed').length,
    failed: manifest.results.filter((result) => result.status === 'failed').length,
  };
};
recalculateTotals();
const persist = () => writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
await persist();

const { chromium } = await loadPlaywright();
for (const showcase of selected) {
    const completed = formats.map((format) => manifest.results.find((result) => (
      result.showcase === showcase.id && result.format === format && result.status === 'passed'
    )));
    if (completed.every(Boolean)) {
      for (const prior of completed) {
        const priorInfo = await stat(prior.path);
        if (priorInfo.size !== prior.file?.bytes) {
          throw new Error(`Saved evidence changed for ${showcase.id}.${prior.format}`);
        }
      }
      process.stdout.write(`SHOWCASE ${showcase.id} (${showcase.status}) — SKIP complete prior PASS\n`);
      continue;
    }
    // A fresh browser process is intentional: very large Blob downloads and WebGL resources can
    // survive context disposal in Chromium and make later showcases fail from accumulated memory.
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    page.setDefaultTimeout(15 * 60 * 1000);
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    process.stdout.write(`SHOWCASE ${showcase.id} (${showcase.status})\n`);
    try {
      await page.goto(`${baseUrl}/#/demo/${showcase.id}`, { waitUntil: 'domcontentloaded', timeout: 15 * 60 * 1000 });
      await page.waitForFunction(() => typeof window.__IMG2THREEJS_EXPORT__ === 'function');
      for (const format of formats) {
        const previous = manifest.results.find((result) => (
          result.showcase === showcase.id && result.format === format && result.status === 'passed'
        ));
        if (previous) {
          const previousInfo = await stat(previous.path);
          if (previousInfo.size !== previous.file?.bytes) {
            throw new Error(`Saved evidence changed for ${showcase.id}.${format}`);
          }
          process.stdout.write(`  SKIP ${format.toUpperCase()} prior PASS ${previousInfo.size} bytes\n`);
          continue;
        }
        manifest.results = manifest.results.filter((result) => !(
          result.showcase === showcase.id && result.format === format
        ));
        recalculateTotals();
        const startedAt = Date.now();
        const destinationDirectory = join(outputRoot, showcase.id);
        const destination = join(destinationDirectory, `${showcase.id}.${format}`);
        const result = {
          showcase: showcase.id,
          showcaseStatus: showcase.status,
          format,
          path: destination,
          status: 'failed',
        };
        try {
          await mkdir(destinationDirectory, { recursive: true });
          const button = page.locator(`[data-export-format="${format}"]`);
          const download = await waitForDownloadOrError(page, button);
          await download.saveAs(destination);
          await page.waitForFunction(() => {
            const node = document.querySelector('#demo-export-status');
            return node?.getAttribute('data-state') !== 'busy';
          });
          const ui = await page.evaluate(() => ({
            state: document.querySelector('#demo-export-status')?.getAttribute('data-state') ?? '',
            status: document.querySelector('#demo-export-status')?.textContent?.trim() ?? '',
            summary: document.querySelector('#demo-export-summary')?.textContent?.trim() ?? '',
            warnings: [...document.querySelectorAll('#demo-export-warnings li')]
              .map((node) => node.textContent?.trim() ?? '')
              .filter(Boolean),
            report: window.__IMG2THREEJS_LAST_EXPORT_REPORT__ ?? null,
          }));
          if (!['success', 'warning'].includes(ui.state)) {
            throw new Error(`UI validation state is ${ui.state || 'empty'}: ${ui.status}`);
          }
          result.durationMs = Date.now() - startedAt;
          result.suggestedFilename = download.suggestedFilename();
          result.ui = ui;
          result.file = await inspectArtifact(destination, format, ui.report);
          result.pageErrors = [...pageErrors];
          result.status = 'passed';
          process.stdout.write(`  PASS ${format.toUpperCase()} ${result.file.bytes} bytes ${result.durationMs} ms\n`);
        } catch (error) {
          result.durationMs = Date.now() - startedAt;
          result.error = error instanceof Error ? error.stack ?? error.message : String(error);
          result.pageErrors = [...pageErrors];
          process.stdout.write(`  FAIL ${format.toUpperCase()} ${result.error.split('\n')[0]}\n`);
        }
        manifest.results.push(result);
        recalculateTotals();
        await persist();
      }
    } catch (error) {
      for (const format of formats) {
        const alreadyPassed = manifest.results.some((result) => (
          result.showcase === showcase.id && result.format === format && result.status === 'passed'
        ));
        if (alreadyPassed) continue;
        manifest.results = manifest.results.filter((result) => !(
          result.showcase === showcase.id && result.format === format
        ));
        manifest.results.push({
          showcase: showcase.id,
          showcaseStatus: showcase.status,
          format,
          status: 'failed',
          error: error instanceof Error ? error.stack ?? error.message : String(error),
          pageErrors,
        });
      }
      recalculateTotals();
      await persist();
      process.stdout.write(`  PAGE FAIL ${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      await context.close();
      await browser.close();
    }
  }

manifest.completedAt = new Date().toISOString();
manifest.success = manifest.totals.failed === 0 && manifest.totals.passed === manifest.totals.requested;
await persist();
process.stdout.write(`MANIFEST ${manifestPath}\n`);
process.stdout.write(`RESULT ${manifest.totals.passed}/${manifest.totals.requested} passed\n`);
process.exitCode = manifest.success ? 0 : 1;
