#!/usr/bin/env node
/**
 * Capture the depth / normal / semantic-id passes that `render-profile.v2.json` requires.
 *
 * The reference loop had been running on two of the six declared passes — `beauty` and
 * `alpha-silhouette` — and both encode only the OUTLINE. Every question about what lies inside it
 * was therefore answered by guessing: how far a foot projects, how thick the hair volume is, where
 * cloth ends and skin begins. Those guesses were wrong repeatedly and each wrong one cost a round.
 *
 *   depth    — camera-space depth, so projection and recess become numbers
 *   normal   — view-space normals, i.e. the facet structure itself
 *   semantic — one flat colour per named part, so cloth/skin boundaries are readable per pixel
 *
 * The swap runs HERE rather than in the page because the GLB branch loads asynchronously: doing it
 * at build time silently misses every mesh in the reference, which is exactly the branch the
 * measurements are for. This script waits for both readiness flags first.
 *
 * Usage: capture-diagnostic-passes.mjs <port> <outDir> <depth|normal|semantic>
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// cloakbrowser is installed GLOBALLY and is not a dependency of this project, so it has to be
// located rather than imported by name. This mirrors the resolver in capture-views.mjs; that file
// does its work at top level, so it cannot be imported for the function without running a capture.
// An absolute path under one developer's home lived here previously: it worked on exactly one
// machine and silently leaked a username into a public repository.
async function loadLauncher() {
  const home = process.env.HOME ?? '';
  let globalRoot = '';
  try {
    globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  } catch { /* npm not on PATH */ }
  const roots = [
    process.env.CLOAKBROWSER_MODULE,
    home && `${home}/cloakbrowser-e2e/node_modules/cloakbrowser`,
    globalRoot && `${globalRoot}/cloakbrowser`,
  ].filter(Boolean);

  const tried = [];
  for (const root of roots) {
    const pkgPath = `${root}/package.json`;
    if (!existsSync(pkgPath)) { tried.push(`${root} (absent)`); continue; }
    // Read the package's own entry rather than guessing index.js -- cloakbrowser's is dist/index.js.
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
    const rel = pkg.exports?.['.']?.import ?? pkg.module ?? pkg.main ?? 'index.js';
    const entry = `${root}/${String(rel).replace(/^\.\//, '')}`;
    if (!existsSync(entry)) { tried.push(`${root} (entry ${rel} missing)`); continue; }
    try {
      return (await import(entry)).launch;
    } catch (error) {
      tried.push(`${root} (${error.code ?? 'import failed'}: ${String(error.message).split('\n')[0]})`);
    }
  }
  console.error('FAIL: cannot load cloakbrowser. It is not a dependency of this project.');
  tried.forEach((t) => console.error(`  tried ${t}`));
  console.error('  Set CLOAKBROWSER_MODULE to a complete install to override.');
  process.exit(1);
}

const launch = await loadLauncher();

const port = process.argv[2] ?? '5180';
const outDir = process.argv[3] ?? 'artifacts/low-poly-humanoid-glb/pass';
const pass = process.argv[4] ?? 'normal';
if (!['depth', 'normal', 'semantic'].includes(pass)) {
  console.error(`unknown pass ${pass}`);
  process.exit(2);
}

const viewport = { width: 1024, height: 1024 };
const views = [
  { id: 'front', azimuth: 0 },
  { id: 'profile', azimuth: 90 },
];
const branches = [
  { branch: 'glb-baseline', demoId: 'low-poly-humanoid-glb-baseline', reference: true },
  { branch: 'procedural-factory', demoId: 'low-poly-humanoid-glb-reference', reference: false },
];

await mkdir(outDir, { recursive: true });
const browser = await launch({ headless: true });
const context = await browser.newContext({ viewport });
const records = [];

for (const { branch, demoId, reference } of branches) {
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/img2threejs-showcase/?capture=1#/demo/${demoId}`,
    { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction('window.__IMG2THREEJS_READY__ === true', undefined, { timeout: 90000 });
  await page.waitForFunction('window.__IMG2THREEJS_VIEWER__ != null', undefined, { timeout: 90000 });
  if (reference) {
    await page.waitForFunction('window.__IMG2THREEJS_REFERENCE_READY__ === true', undefined, { timeout: 90000 });
  }
  await page.waitForTimeout(400);

  const swapped = await page.evaluate((mode) => {
    const viewer = window.__IMG2THREEJS_VIEWER__;
    const THREE = window.__IMG2THREEJS_THREE__;
    if (!viewer || !THREE) return { error: 'no viewer or THREE on window' };

    // Unlit encodings: tone mapping and the sRGB transfer would gamma-encode the values and every
    // measurement taken from them would be silently wrong.
    viewer.renderer.toneMapping = THREE.NoToneMapping;
    viewer.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    viewer.scene.environment = null;
    viewer.scene.background = new THREE.Color(0x000000);

    // Stable per-part colour: the same part must get the same id in both branches, so the hash is
    // over the part name and not over traversal order.
    const semanticColor = (key) => {
      let h = 2166136261;
      for (let i = 0; i < key.length; i += 1) {
        h ^= key.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return new THREE.Color(
        (((h >>> 0) & 0xff) / 255) * 0.75 + 0.25,
        (((h >>> 8) & 0xff) / 255) * 0.75 + 0.25,
        (((h >>> 16) & 0xff) / 255) * 0.75 + 0.25,
      );
    };

    let count = 0;
    const names = new Set();
    viewer.scene.traverse((object) => {
      if (!object.isMesh || !object.geometry) return;
      if (object.userData.isGround || /ground|plinth|stage/i.test(object.name)) return;
      count += 1;
      if (mode === 'normal') {
        object.material = new THREE.MeshNormalMaterial({ flatShading: true, side: THREE.DoubleSide });
        return;
      }
      if (mode === 'depth') {
        object.material = new THREE.MeshDepthMaterial({ side: THREE.DoubleSide });
        return;
      }
      let owner = object;
      while (owner && typeof owner.userData.partId !== 'string') owner = owner.parent;
      const key = owner ? String(owner.userData.partId) : (object.name || 'unnamed');
      names.add(key);
      object.material = new THREE.MeshBasicMaterial({ color: semanticColor(key), side: THREE.DoubleSide });
    });
    return { count, parts: [...names].slice(0, 40) };
  }, pass);

  if (swapped.error) {
    console.error(`${branch}: ${swapped.error}`);
    await browser.close();
    process.exit(1);
  }

  // Same camera contract as the beauty capture: azimuth driven through the controls, one fixed
  // target and distance per branch, so a pass and its beauty frame are pixel-comparable.
  const initial = await page.evaluate(() => {
    const viewer = window.__IMG2THREEJS_VIEWER__;
    return {
      target: viewer.controls.target.toArray(),
      distance: viewer.camera.position.distanceTo(viewer.controls.target),
    };
  });

  for (const view of views) {
    await page.evaluate(({ azimuth, target, distance }) => {
      const viewer = window.__IMG2THREEJS_VIEWER__;
      const controls = viewer.controls;
      const radians = (azimuth * Math.PI) / 180;
      controls.target.set(target[0], target[1], target[2]);
      controls.minAzimuthAngle = radians;
      controls.maxAzimuthAngle = radians;
      controls.minPolarAngle = Math.PI / 2;
      controls.maxPolarAngle = Math.PI / 2;
      viewer.camera.position.set(
        target[0] + Math.sin(radians) * distance,
        target[1],
        target[2] + Math.cos(radians) * distance,
      );
      controls.update();
      viewer.camera.updateProjectionMatrix();
      // The composer would re-apply post effects the pass must not carry, so a pass always goes
      // straight through the renderer.
      viewer.renderer.render(viewer.scene, viewer.camera);
    }, { ...view, target: initial.target, distance: initial.distance });
    await page.waitForTimeout(200);
    const path = `${outDir}/${branch}.${view.id}.png`;
    await page.screenshot({ path });
    records.push({ branch, view: view.id, path, meshes: swapped.count });
  }
  await page.close();
}

await browser.close();
await writeFile(`${outDir}/manifest.json`,
  `${JSON.stringify({ pass, records }, null, 2)}\n`);
console.log(JSON.stringify({ pass, outDir, shots: records.length, meshes: records[0]?.meshes }, null, 2));
