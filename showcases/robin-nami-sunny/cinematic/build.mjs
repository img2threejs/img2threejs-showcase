import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
const root = new URL('./', import.meta.url);
await mkdir(new URL('dist/', root), { recursive: true });
// Resolve the shared studio modules and this viewer to one Three installation.
await build({ absWorkingDir: root.pathname, entryPoints: ['viewer.mjs'], bundle: true, format: 'esm', target: 'es2022', platform: 'browser', alias: { three: 'three' }, outfile: 'dist/viewer.js', sourcemap: true });
