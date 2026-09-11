#!/usr/bin/env node
// Enforce the iPhone Duo no-GLB contract without changing other demos.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const violations = [];
const runtimeRoot = resolve(root, 'src/iphone-duo');
function scan(directory, archive = false) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const label = relative(root, path);
    if (entry.isSymbolicLink()) {
      // Local research builds may link unrelated site assets; source/assets may not.
      if (!archive || /\.(glb|gltf|bin)$/i.test(entry.name)) {
        violations.push(`${label}: model links or source/asset symlinks are prohibited`);
      }
    } else if (entry.isDirectory()) {
      scan(path, archive);
    } else if (entry.isFile()) {
      if (/\.(glb|gltf|bin)$/i.test(entry.name)) {
        violations.push(`${label}: external model files are prohibited`);
      }
      if (path.startsWith(runtimeRoot + '/') && /\.[cm]?[jt]sx?$/.test(extname(path))) {
        if (/\bGLTFLoader\b/.test(readFileSync(path, 'utf8'))) {
          violations.push(`${label}: GLTFLoader is prohibited in the runtime`);
        }
      }
    }
  }
}
for (const directory of ['src/iphone-duo', 'public/iphone-duo', 'work/iphone-duo', 'dist-iphone-duo', 'dist/iphone-duo']) {
  scan(resolve(root, directory), directory === 'work/iphone-duo');
}
if (existsSync(resolve(root, 'scripts/encode-iphone-duo-source.mjs'))) {
  violations.push('The removed GLB encoder must not be restored.');
}
if (violations.length) {
  console.error(violations.join('\n'));
  process.exit(1);
}
console.log('iPhone Duo no-GLB check passed: no GLB/GLTF/BIN files, runtime GLTFLoader, or GLB encoder.');
