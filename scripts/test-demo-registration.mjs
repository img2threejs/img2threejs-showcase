#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))));

const ID = 'vijay-ghume-mini-dragon-character';
const DESIGN_FILE = 'DESIGN.md';
const MANIFEST_FILE = 'src/demos/vijay-ghume-mini-dragon-character/dragon-demo-manifest.json';
const FACTORY_FILE = 'src/demos/vijay-ghume-mini-dragon-character/createVijayGhumeMiniDragonCharacterModel.ts';
const RIG_FILE = 'src/demos/vijay-ghume-mini-dragon-character/createRiggedDragon.ts';
const REGISTRY_FILE = 'src/demos/registry.ts';
const PUBLIC_REFERENCE_FILE = 'public/references/vijay-ghume-mini-dragon-character.jpg';
const MAX_PUBLIC_REFERENCE_BYTES = 800 * 1024;
const VIEWER_SYMBOLS = ['RoomEnvironment', 'EffectComposer', 'BokehPass', 'UnrealBloomPass', 'OrbitControls'];
const PBR_STEMS = ['dragon-body-skin', 'dragon-skin', 'gold-ornament', 'horn-black', 'loincloth-purple', 'wing-membrane-pink'];
const PBR_CHANNELS = ['albedo', 'roughness', 'height', 'normal', 'ao'];
const EXPECTED_FACTORY_PNGS = PBR_STEMS.flatMap((stem) => PBR_CHANNELS.map((channel) => `${stem}_${channel}.png`));
const EXPECTED_PROVENANCE_JSONS = ['src/demos/vijay-ghume-mini-dragon-character/provenance/admission-manifest.json', 'src/demos/vijay-ghume-mini-dragon-character/provenance/cloth-authoritative-report.json', 'src/demos/vijay-ghume-mini-dragon-character/provenance/cloth-report.json', 'src/demos/vijay-ghume-mini-dragon-character/provenance/dragon-assessment-enriched.json', 'src/demos/vijay-ghume-mini-dragon-character/provenance/dragon-body-skin-report.json', 'src/demos/vijay-ghume-mini-dragon-character/provenance/dragon-body-skin-texture-analysis.json', 'src/demos/vijay-ghume-mini-dragon-character/provenance/dragon-character-spec.json', 'src/demos/vijay-ghume-mini-dragon-character/provenance/dragon-routing-report.json', 'src/demos/vijay-ghume-mini-dragon-character/provenance/dragon-tail-skin-report.json', 'src/demos/vijay-ghume-mini-dragon-character/provenance/eye-amber-report.json', 'src/demos/vijay-ghume-mini-dragon-character/provenance/fang-ivory-report.json', 'src/demos/vijay-ghume-mini-dragon-character/provenance/gold-authoritative-report.json', 'src/demos/vijay-ghume-mini-dragon-character/provenance/gold-report.json', 'src/demos/vijay-ghume-mini-dragon-character/provenance/horn-report.json', 'src/demos/vijay-ghume-mini-dragon-character/provenance/wing-authoritative-report.json', 'src/demos/vijay-ghume-mini-dragon-character/provenance/wing-membrane-report.json'];
const EXPECTED_RUNTIME_ASSETS = [...EXPECTED_FACTORY_PNGS.map((fileName) => `src/demos/vijay-ghume-mini-dragon-character/${fileName}`), PUBLIC_REFERENCE_FILE];

const failures = [];
let checkCount = 0;

function verify(condition, message) {
  checkCount += 1;
  if (!condition) failures.push(message);
}

function rel(filePath) {
  return relative(ROOT, filePath);
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function hasMatch(text, pattern) {
  return pattern.test(text);
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveRepoPath(rawPath, context) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    failures.push(`${context} must be a non-empty repo-relative path`);
    return null;
  }
  if (isAbsolute(rawPath)) {
    failures.push(`${context} must be repo-relative, not absolute: ${rawPath}`);
    return null;
  }
  if (rawPath.split(/[\\/]+/).includes('..')) {
    failures.push(`${context} must not contain .. traversal: ${rawPath}`);
    return null;
  }
  const resolved = resolve(ROOT, rawPath);
  if (resolved !== ROOT && !resolved.startsWith(`${ROOT}/`)) {
    failures.push(`${context} must resolve under repo ROOT: ${rawPath}`);
    return null;
  }
  return resolved;
}

function readTextIfExisting(rawPath, context) {
  const resolvedPath = resolveRepoPath(rawPath, context);
  if (resolvedPath === null) return null;
  if (!existsSync(resolvedPath)) {
    failures.push(`${context} is missing`);
    return null;
  }
  try {
    const realPath = realpathSync(resolvedPath);
    if (realPath !== ROOT && !realPath.startsWith(`${ROOT}/`)) {
      failures.push(`${context} resolves outside repo ROOT: ${rawPath}`);
      return null;
    }
    return readFileSync(realPath, 'utf8');
  } catch (error) {
    failures.push(`${context} could not be read: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function readJsonStatus(rawPath, context) {
  const text = readTextIfExisting(rawPath, context);
  if (text === null) return { kind: 'missing-or-unreadable' };
  try {
    return { kind: 'parsed', value: JSON.parse(text) };
  } catch (error) {
    failures.push(`${context} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return { kind: 'invalid-json' };
  }
}

function realExistingPath(rawPath, context) {
  const resolvedPath = resolveRepoPath(rawPath, context);
  if (resolvedPath === null) return null;
  if (!existsSync(resolvedPath)) {
    failures.push(`${context} is missing`);
    return null;
  }
  try {
    const realPath = realpathSync(resolvedPath);
    if (realPath !== ROOT && !realPath.startsWith(`${ROOT}/`)) {
      failures.push(`${context} resolves outside repo ROOT: ${rawPath}`);
      return null;
    }
    return realPath;
  } catch (error) {
    failures.push(`${context} could not resolve real path: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function validateExactDigestEntries(entries, expectedPaths, bucketName) {
  if (!Array.isArray(entries) || entries.length === 0) {
    failures.push(`manifest integrity.sha256.${bucketName} must be a non-empty array`);
    return;
  }

  const actualPaths = new Set();
  const seenPaths = new Set();
  const seenRecords = new Set();

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      failures.push(`manifest integrity.sha256.${bucketName} entry must be an object`);
      continue;
    }

    const record = entry;
    const entryPath = typeof record.path === 'string' ? record.path : '';
    const entrySha = typeof record.sha256 === 'string' ? record.sha256 : '';

    verify(entryPath.length > 0, `manifest integrity.sha256.${bucketName} entry missing path`);
    verify(!isAbsolute(entryPath), `manifest integrity.sha256.${bucketName} entry path must be repo-relative: ${entryPath}`);
    verify(!entryPath.split(/[\\/]+/).includes('..'), `manifest integrity.sha256.${bucketName} entry path must not contain .. traversal: ${entryPath}`);
    verify(/^[A-Za-z0-9_./-]+$/.test(entryPath), `manifest integrity.sha256.${bucketName} entry path contains invalid characters: ${entryPath}`);
    verify(/^[0-9a-f]{64}$/.test(entrySha), `manifest integrity.sha256.${bucketName} entry sha256 must be 64 lowercase hex characters: ${entrySha || '(missing)'}`);

    if (entryPath.length > 0) {
      if (seenPaths.has(entryPath)) failures.push(`manifest integrity.sha256.${bucketName} duplicate path: ${entryPath}`);
      seenPaths.add(entryPath);
      actualPaths.add(entryPath);
    }

    const recordKey = `${entryPath}\u0000${entrySha}`;
    if (seenRecords.has(recordKey)) failures.push(`manifest integrity.sha256.${bucketName} duplicate digest record: ${entryPath}`);
    seenRecords.add(recordKey);
  }

  const expected = new Set(expectedPaths);
  for (const path of expectedPaths) {
    if (!actualPaths.has(path)) failures.push(`manifest integrity.sha256.${bucketName} missing expected path: ${path}`);
  }
  for (const path of actualPaths) {
    if (!expected.has(path)) failures.push(`manifest integrity.sha256.${bucketName} unexpected path: ${path}`);
  }
}

function hashExistingTarget(rawPath, context, expectedSha) {
  const realPath = realExistingPath(rawPath, context);
  if (realPath === null) return;
  verify(sha256(realPath) === expectedSha, `${rawPath} SHA-256 mismatch`);
}

function validateIntegrityBucket(entries, expectedPaths, bucketName) {
  validateExactDigestEntries(entries, expectedPaths, bucketName);
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry;
    const entryPath = typeof record.path === 'string' ? record.path : '';
    const entrySha = typeof record.sha256 === 'string' ? record.sha256 : '';
    if (!/^[0-9a-f]{64}$/.test(entrySha)) continue;
    hashExistingTarget(entryPath, `manifest integrity.sha256.${bucketName} target ${entryPath}`, entrySha);
  }
}

function main() {
  verify(readTextIfExisting(DESIGN_FILE, DESIGN_FILE) !== null, 'DESIGN.md does not exist');

  const manifestStatus = readJsonStatus(MANIFEST_FILE, MANIFEST_FILE);
  if (manifestStatus.kind === 'parsed') {
    const manifest = manifestStatus.value;
    verify(manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest), 'manifest must be a non-null non-array object');
    if (manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)) {
    verify(manifest.buildPassState?.blockout?.completed === 0, 'manifest buildPassState.blockout.completed must be 0');
    verify(manifest.buildPassState?.blockout?.review === 'unreviewed', "manifest buildPassState.blockout.review must be 'unreviewed'");
    verify(manifest.integrity?.sha256?.algorithm === 'SHA-256', 'manifest integrity.sha256.algorithm must be exactly SHA-256');
    validateIntegrityBucket(manifest.integrity?.sha256?.provenanceJson, EXPECTED_PROVENANCE_JSONS, 'provenanceJson');
    validateIntegrityBucket(manifest.integrity?.sha256?.runtimeAssets, EXPECTED_RUNTIME_ASSETS, 'runtimeAssets');
    }
  }

  const publicReferenceRealPath = realExistingPath(PUBLIC_REFERENCE_FILE, PUBLIC_REFERENCE_FILE);
  if (publicReferenceRealPath !== null) {
    verify(statSync(publicReferenceRealPath).size <= MAX_PUBLIC_REFERENCE_BYTES, `${rel(PUBLIC_REFERENCE_FILE)} must be <= 800KB`);
  }

  const registryText = readTextIfExisting(REGISTRY_FILE, REGISTRY_FILE);
  if (registryText !== null) {
    const registryIdPattern = new RegExp(String.raw`id:\s*['"]${ID}['"]`, 'g');
    verify(countMatches(registryText, registryIdPattern) === 1, `registry.ts must declare '${ID}' exactly once`);
    const registryEntryPattern = new RegExp(String.raw`^\s*\{\s*id:\s*(['"])${escapeRegExp(ID)}\1[\s\S]*?\n\s*\},`, 'm');
    const registryEntryMatch = registryText.match(registryEntryPattern);
    verify(registryEntryMatch !== null, `registry.ts entry '${ID}' could not be located`);
    const registryEntry = registryEntryMatch?.[0] ?? '';
    verify(hasMatch(registryEntry, /subjectClass:\s*'character'/), `registry.ts entry '${ID}' must use subjectClass 'character'`);
    verify(hasMatch(registryEntry, /status:\s*'placeholder'/), `registry.ts entry '${ID}' must use status 'placeholder'`);
    verify(
      hasMatch(registryText, /from ['"]\.\/vijay-ghume-mini-dragon-character\/createVijayGhumeMiniDragonCharacterModel['"]/),
      `registry.ts missing import from ./vijay-ghume-mini-dragon-character/createVijayGhumeMiniDragonCharacterModel`,
    );
  }

  const factoryText = readTextIfExisting(FACTORY_FILE, FACTORY_FILE);
  if (factoryText !== null) {
    const mapImports = [...factoryText.matchAll(/^import\s+[^;]+from\s+['"](\.\/[^'"]+\.png)['"];$/gm)].map((match) => match[1].slice(2));
    verify(mapImports.length === EXPECTED_FACTORY_PNGS.length, `${FACTORY_FILE} must import exactly ${EXPECTED_FACTORY_PNGS.length} flat PBR maps`);
    verify(new Set(mapImports).size === mapImports.length, `${FACTORY_FILE} must not duplicate flat PBR map imports`);
    verify(
      mapImports.length === EXPECTED_FACTORY_PNGS.length &&
        EXPECTED_FACTORY_PNGS.every((fileName) => mapImports.includes(fileName)) &&
        mapImports.every((fileName) => EXPECTED_FACTORY_PNGS.includes(fileName)),
      `${FACTORY_FILE} must import the exact expected 6 stems × 5 channels PBR map set`,
    );
    for (const fileName of EXPECTED_FACTORY_PNGS) {
      const assetPath = `src/demos/${ID}/${fileName}`;
      const realPath = realExistingPath(assetPath, assetPath);
      if (realPath === null) continue;
    }
    for (const symbol of VIEWER_SYMBOLS) {
      verify(!hasMatch(factoryText, new RegExp(String.raw`\b${symbol}\b`)), `${FACTORY_FILE} must not reference ${symbol}`);
    }
    verify(!factoryText.includes('/private/tmp/'), `${FACTORY_FILE} must not contain /private/tmp/ paths`);
    verify(!factoryText.includes('/Users/nhonh/Desktop/'), `${FACTORY_FILE} must not contain /Users/nhonh/Desktop/ paths`);
    verify(
      hasMatch(factoryText, /export\s+function\s+createVijayGhumeMiniDragonCharacterModel\b/),
      `${FACTORY_FILE} missing export createVijayGhumeMiniDragonCharacterModel`,
    );
    verify(
      hasMatch(factoryText, /export\s+function\s+createVijayGhumeMiniDragonCharacterLookDevLights\b/),
      `${FACTORY_FILE} missing export createVijayGhumeMiniDragonCharacterLookDevLights`,
    );
    verify(hasMatch(factoryText, /new\s+THREE\.SkeletonHelper\b/), `${FACTORY_FILE} missing rig debug SkeletonHelper`);
    verify(hasMatch(factoryText, /rigType:\s*['"]THREE\.SkinnedMesh['"]/), `${FACTORY_FILE} missing explicit rigType evidence`);
  }

  const rigText = readTextIfExisting(RIG_FILE, RIG_FILE);
  if (rigText !== null) {
    verify(hasMatch(rigText, /new\s+MarchingCubes\b/), `${RIG_FILE} missing implicit-surface polygonizer`);
    verify(hasMatch(rigText, /\bmergeVertices\(/), `${RIG_FILE} must weld the polygonized body before smoothing`);
    verify(!hasMatch(rigText, /\bmergeGeometries\(/), `${RIG_FILE} must not pretend buffer concatenation is a topology union`);
    verify(hasMatch(rigText, /new\s+THREE\.SkinnedMesh\b/), `${RIG_FILE} missing THREE.SkinnedMesh`);
    verify(hasMatch(rigText, /new\s+THREE\.Skeleton\b/), `${RIG_FILE} missing THREE.Skeleton`);
    verify(hasMatch(rigText, /new\s+THREE\.Bone\b/), `${RIG_FILE} missing THREE.Bone hierarchy`);
    verify(hasMatch(rigText, /setAttribute\(['"]skinIndex['"]/), `${RIG_FILE} missing skinIndex attribute`);
    verify(hasMatch(rigText, /setAttribute\(['"]skinWeight['"]/), `${RIG_FILE} missing skinWeight attribute`);
    verify(hasMatch(rigText, /Uint16BufferAttribute\([^;]+,\s*4\)/), `${RIG_FILE} skinIndex must use four influences`);
    verify(hasMatch(rigText, /Float32BufferAttribute\([^;]+,\s*4\)/), `${RIG_FILE} skinWeight must use four influences`);
    verify(hasMatch(rigText, /\bbody\.bind\(skeleton\)/), `${RIG_FILE} body must bind the generated skeleton`);
    verify(hasMatch(rigText, /wing\.bindMode\s*=\s*THREE\.AttachedBindMode/), `${RIG_FILE} wings must share attached skeleton space`);
    verify(hasMatch(rigText, /\bsubdivideGeometry\(/), `${RIG_FILE} wing membranes must use subdivided deformation topology`);
    verify(hasMatch(rigText, /type:\s*['"]continuous-implicit-surface['"]/), `${RIG_FILE} missing continuous topology evidence`);
  }

  if (failures.length > 0) {
    console.error('test-demo-registration: FAILED');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  console.log(`test-demo-registration: PASS (${checkCount} checks)`);
}

try {
  main();
} catch (error) {
  console.error('test-demo-registration: FAILED');
  console.error(`  - ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
