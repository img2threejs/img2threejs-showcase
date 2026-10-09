#!/usr/bin/env node
// Keep this exhibit code-only without changing the asset contracts of other demos.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const violations = [];
const forbiddenFile = /\.(?:glb|gltf|bin|png|jpe?g|webp|ktx2?)$/i;
const forbiddenLoader = /(?:GLTFLoader|DRACOLoader|TextureLoader|ImageBitmapLoader)(?:\.|$)/;

function scan(directory, source = false) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const label = relative(root, path);
    if (entry.isSymbolicLink()) {
      violations.push(`${label}: runtime asset symlinks are prohibited`);
    } else if (entry.isDirectory()) {
      scan(path, source);
    } else if (entry.isFile()) {
      if (forbiddenFile.test(entry.name)) violations.push(`${label}: external model/image assets are prohibited`);
      if (!source || !/\.[cm]?[jt]s$/.test(entry.name)) continue;
      const ast = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = node => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
          && forbiddenLoader.test(node.moduleSpecifier.text)) {
          violations.push(`${label}: model/image loader import is prohibited`);
        }
        if (ts.isIdentifier(node) && /^(?:GLB_BINARY_BASE64|GLTF_SOURCE)$/.test(node.text)) {
          violations.push(`${label}: an embedded original model is not an encoded surface`);
        }
        if (ts.isCallExpression(node)) {
          const call = ts.isIdentifier(node.expression) ? node.expression.text
            : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : '';
          const arg = node.arguments[0];
          if (/^(?:fetch|load|loadAsync)$/.test(call) && arg && ts.isStringLiteralLike(arg)
            && forbiddenFile.test(arg.text.split(/[?#]/, 1)[0])) {
            violations.push(`${label}: runtime model/image request is prohibited`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
    }
  }
}

scan(resolve(root, 'src/demos/tropical-island'), true);
scan(resolve(root, 'public/tropical-island'));
if (process.argv.includes('--dist')) scan(resolve(root, 'dist/tropical-island'));
if (violations.length) {
  console.error([...new Set(violations)].join('\n'));
  process.exit(1);
}
console.log('Tropical Island code-only check passed: no runtime model/image assets, loaders or embedded original model.');
