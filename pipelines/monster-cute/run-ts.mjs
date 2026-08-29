// Bundle a TypeScript entry with esbuild and run it in this node process.
// Using the SHIPPED decoder rather than a re-implementation is the point: a measurement taken with
// a copy of the decoder measures the copy.
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = process.argv[2];
if (!entry) throw new Error('usage: node tools/run-ts.mjs <entry.ts> [args...]');

const result = await build({
  entryPoints: [entry],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  external: ['three', 'three/*'],
});
// Inside the project rather than a temp dir: `three` stays external, so the bundle has to sit
// somewhere node can resolve node_modules from.
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '.build');
mkdirSync(dir, { recursive: true });
const out = join(dir, 'entry.mjs');
writeFileSync(out, result.outputFiles[0].text);
await import(pathToFileURL(out).href);
