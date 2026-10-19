import { readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const limit = 1_000_000_000; // Conservative interpretation of GitHub Pages' 1 GB published-site limit.
let bytes = 0;
let files = 0;

async function measure(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await measure(filename);
    else if (entry.isFile()) {
      bytes += (await lstat(filename)).size;
      files++;
    } else throw new Error(`Unsupported Pages artifact entry: ${filename}`);
  }
}

await measure(path.join(root, 'dist'));
console.log(`Pages output: ${bytes.toLocaleString('en-US')} bytes in ${files} files (limit ${limit.toLocaleString('en-US')} bytes).`);
if (bytes > limit) {
  throw new Error('Pages output exceeds 1 GB. Move downloads out of dist before publishing; do not reduce scene quality to hide the excess.');
}
