#!/usr/bin/env node
// Repack runtime lightmaps at the exact HALF precision already used by this viewer.
// Native/source exports retain their original precision on the previous release.
// Usage: node scripts/pack_runtime_assets.mjs --tag <new-release-tag> --output <new-directory>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { DataTexture, HalfFloatType, RGBAFormat } from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { EXRExporter } from 'three/addons/exporters/EXRExporter.js';
import { Zip, ZipPassThrough } from 'three/addons/libs/fflate.module.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { tag: { type: 'string' }, output: { type: 'string' } } });
if (!values.tag || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(values.tag) || !values.output) {
  throw new Error('Required: --tag <new-release-tag> --output <new-directory>');
}
const output = path.resolve(values.output);
fs.mkdirSync(output); // Never overwrite a previous pack or the input assets.
const lock = JSON.parse(fs.readFileSync(path.join(root, 'assets.lock.json'), 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const asArrayBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const dataBytes = image => Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
const locations = new Map();
const proof = [];

for (const entry of lock.files) {
  const source = path.join(root, 'public', entry.path);
  const input = fs.readFileSync(source);
  if (input.length !== entry.bytes || digest(input) !== entry.sha256) {
    throw new Error(`Input differs from pinned export: ${entry.path}`);
  }
  locations.set(entry.path, source);
  if (!/^assets\/interior\/lightmap-[a-z-]+\.exr$/.test(entry.path)) continue;
  const decoded = new EXRLoader().parse(asArrayBuffer(input));
  if (decoded.type !== HalfFloatType) throw new Error('Viewer EXR precision changed; re-evaluate this pack.');
  const texture = new DataTexture(decoded.data, decoded.width, decoded.height, RGBAFormat, HalfFloatType);
  const encoded = await new EXRExporter().parse(texture, { type: HalfFloatType, compression: 3 });
  texture.dispose();
  const check = new EXRLoader().parse(asArrayBuffer(encoded));
  if (check.width !== decoded.width || check.height !== decoded.height || check.type !== decoded.type
      || check.colorSpace !== decoded.colorSpace || !dataBytes(decoded).equals(dataBytes(check))) {
    throw new Error(`Runtime texels changed: ${entry.path}`);
  }
  const target = path.join(output, 'public', entry.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, encoded);
  const row = { path: entry.path, before: entry.bytes, after: encoded.length,
    decodedSha256: digest(dataBytes(decoded)), identicalRuntimeTexels: true };
  proof.push(row);
  console.log(JSON.stringify(row));
  entry.bytes = encoded.length;
  entry.sha256 = digest(encoded);
  locations.set(entry.path, target);
}

// Stream the same locked inventory into a deterministic stored ZIP. EXRs/GLB/PNG
// are already compressed; buffering the entire bundle would duplicate hundreds of MB.
const bundle = path.join(output, 'living-room-assets.zip');
const handle = fs.openSync(bundle, 'wx');
const bundleHash = createHash('sha256');
let bundleBytes = 0;
try {
  const zip = new Zip((error, bytes) => {
    if (error) throw error;
    fs.writeFileSync(handle, bytes);
    bundleHash.update(bytes);
    bundleBytes += bytes.length;
  });
  const buffer = Buffer.allocUnsafe(1 << 20);
  for (const entry of lock.files) {
    const file = new ZipPassThrough(entry.path);
    file.mtime = new Date(2020, 0, 1);
    file.os = 3;
    file.attrs = (0o100644 << 16) >>> 0;
    zip.add(file);
    const input = fs.openSync(locations.get(entry.path), 'r');
    try {
      let count;
      while ((count = fs.readSync(input, buffer, 0, buffer.length, null))) file.push(buffer.subarray(0, count), false);
      file.push(new Uint8Array(0), true);
    } finally { fs.closeSync(input); }
  }
  zip.end();
} finally { fs.closeSync(handle); }
lock.bundle = {
  url: `https://github.com/img2threejs/img2threejs-showcase/releases/download/${values.tag}/living-room-assets.zip`,
  sha256: bundleHash.digest('hex'), bytes: bundleBytes,
};
fs.writeFileSync(path.join(output, 'assets.lock.json'), JSON.stringify(lock, null, 2) + '\n');
fs.writeFileSync(path.join(output, 'proof.json'), JSON.stringify(proof, null, 2) + '\n');
console.log(`Saved ${proof.reduce((sum, row) => sum + row.before - row.after, 0)} Pages bytes; bundle ${bundleBytes} bytes.`);
