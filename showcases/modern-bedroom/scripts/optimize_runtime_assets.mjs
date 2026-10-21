#!/usr/bin/env node
// Runtime-asset optimiser for the bedroom viewer: the ONLY producer of what the browser downloads.
//
//   npm run optimize:assets            (= node scripts/optimize_runtime_assets.mjs [outDir] [options])
//
// MUST be re-run after every Blender export (and after anything else that rewrites public/assets/interior): the viewer loads
// nothing but public/assets/interior-runtime/, and there is no EXR fallback in the browser.
//
// Reads the exported masters in --src (default public/assets/interior; never modified) and writes the runtime set to <outDir>
// (default public/assets/interior-runtime, i.e. /assets/interior-runtime/ in the viewer):
//
//   manifest.json         the source manifest with every runtime URL pointing into <outDir> (--url-base) and a `runtimeAssets`
//                         block (see below). `portableModel`, `blender` and `sourceImage` keep their URLs: the downloads stay in
//                         public/assets/interior, the viewer only links them.
//   room-runtime.glb      EXT_meshopt_compression (lossless: float32 attributes, vertex and triangle order untouched, so the
//                         curtain UV lattice / bed-cloth grid recovery and every name + extras survive bit-exactly) and
//                         KHR_texture_basisu textures (KTX2, GPU-compressed, with mip chains). The output is re-read and
//                         compared against the source (nodes, extras, materials, every accessor) before the receipt is written.
//   lightmap-*.ktx2       UASTC HDR 4x4 versions of the five atlases, already row-oriented for glTF UV1 and rim-repaired with
//                         src/interior-atlas-repair.js; the viewer uploads BC6H / ASTC-HDR (RGBA16F where the GPU has neither).
//                         manifest `lightmaps[i].url` is the KTX2; the exported EXR stays in the source dir (`sourceUrl`).
//   lightmap-samples.bin/.json   the nearest-texel RGB (half float) of the oriented + rim-repaired atlas at every vertex uv1 of every
//                         lightmapped mesh: every CPU-side lightmap lookup of the viewer, precomputed, so no atlas is ever
//                         decoded on the CPU (src/interior-lightmaps.js reads these and is bit-identical to reading the atlas).
//   room-environment.hdr, bedroom-sky.hdr   the reflection probe and the sky as Radiance RGBE (8-bit mantissa, shared exponent;
//                         worst relative error 0.4 %), decoded by three's HDRLoader: the viewer contains no EXR decoder.
//   optimized.json        receipt: tool versions, settings, per-file bytes + sha256 (source and output), per-texture codec/PSNR,
//                         verification result.
//
// The EXRs are read offline only (probe, sky, atlases). Files of a previous run that are no longer produced are removed from
// <outDir>; nothing outside <outDir> is written (besides the encode cache).
//
// Options
//   [outDir]               output directory (default public/assets/interior-runtime)
//   --src <dir>            source directory (default public/assets/interior)
//   --url-base <path>      URL prefix of <outDir> inside manifest.json (default /assets/interior-runtime)
//   --textures <mode>      uastc (default) | auto | etc1s | keep.  uastc = UASTC LDR 4x4 + RDO + zstd everywhere (validated
//                          visually identical: Chrome A/B mean |dRGB| 0.06). auto = colour maps use ETC1S where its BC7 PSNR >=
//                          --min-psnr, else UASTC; normal/data maps always UASTC. etc1s = ETC1S everywhere. NOTE: ETC1S roughness
//                          maps rendered a visibly glossier floor (mean |dRGB| 1.4, worst 32 px region 38), do not use for data maps.
//   --min-psnr <dB>        ETC1S acceptance threshold for auto (default 42)
//   --max-texture <px>     downscale textures larger than this (default 0 = keep)
//   --geometry <mode>      meshopt (default) | none
//   --lightmap-level <n>   UASTC HDR 4x4 -uastc_level (default 2)
//   --basisu <path>        basisu executable (default $BASISU, then PATH, then /opt/homebrew/bin/basisu; `brew install basis_universal`)
//   --cache <dir>          encode cache (default <os tmp>/opt-assets-cache); keyed by input hash + settings (a first run on an idle
//                          machine encodes 31 textures + 5 atlases; with the cache it takes about a minute)
//   --ktx2-roles <list>    comma list of texture roles to convert: colour,data,normal (default all; others stay PNG/JPEG)
//   --only-glb             write only room-runtime.glb + optimized.json (debug / A-B of single settings; not a complete runtime set)
//   --no-verify            skip the output verification pass
//   --force                ignore the cache
//
// manifest.json changes relative to the source manifest:
//   model, environment, background, lightmaps[i].url, lightmapSamples.{url,index}   -> <url-base>/...
//   lightmaps[i]: { ...source, url: '<url-base>/lightmap-<id>.ktx2', sourceUrl: '<source url>', format: 'uastc-hdr-4x4',
//                   container: 'ktx2', rimRepaired: true, rowOrder: 'uv1-top', bytes }
//   lightmapSamples: { url, index, format: 'half-rgb-per-vertex', bytes, sha256 }
//     index JSON: { version, orientation, rimRepaired, atlas: { id: { width, height } }, meshes: { <node name>: { atlas, offset, count } } };
//     bin: little-endian Uint16 half-float RGB per vertex, `offset` counted in Uint16 elements, vertex order = GLB accessor order.
//   runtimeAssets: { version: 2, receipt: '<url-base>/optimized.json', model: { meshopt, texturesKtx2 }, lightmaps: 'uastc-hdr-4x4',
//                    lightmapSamples: true, environment: 'rgbe' }
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, KHRTextureBasisu } from '@gltf-transform/extensions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const opts = {
    src: path.join(ROOT, 'public/assets/interior'), textures: 'uastc', minPsnr: 42, maxTexture: 0, geometry: 'meshopt',
    lightmapLevel: 2, basisu: null, cache: path.join(os.tmpdir(), 'opt-assets-cache'),
    verify: true, force: false, out: path.join(ROOT, 'public/assets/interior-runtime'), outGiven: false, urlBase: '/assets/interior-runtime',
    ktx2Roles: 'colour,data,normal', onlyGlb: false,
  };
  const flag = { '--no-verify': () => { opts.verify = false; }, '--force': () => { opts.force = true; }, '--only-glb': () => { opts.onlyGlb = true; } };
  const value = { '--src': 'src', '--textures': 'textures', '--min-psnr': 'minPsnr', '--max-texture': 'maxTexture', '--geometry': 'geometry',
    '--lightmap-level': 'lightmapLevel', '--ktx2-roles': 'ktx2Roles', '--basisu': 'basisu', '--cache': 'cache', '--url-base': 'urlBase' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (flag[arg]) flag[arg]();
    else if (value[arg]) {
      const raw = argv[++i];
      if (raw === undefined) throw new Error(`${arg} needs a value`);
      opts[value[arg]] = ['minPsnr', 'maxTexture', 'lightmapLevel'].includes(value[arg]) ? Number(raw) : raw;
    } else if (!arg.startsWith('--') && !opts.outGiven) { opts.out = arg; opts.outGiven = true; }
    else throw new Error(`Unknown argument ${arg}`);
  }
  opts.src = path.resolve(opts.src); opts.out = path.resolve(opts.out); opts.cache = path.resolve(opts.cache);
  opts.urlBase = opts.urlBase.replace(/\/+$/, '');
  if (!opts.urlBase.startsWith('/assets/')) throw new Error(`--url-base must start with /assets/ (got ${opts.urlBase})`);
  if (!['auto', 'uastc', 'etc1s', 'keep'].includes(opts.textures)) throw new Error(`--textures ${opts.textures}`);
  if (!['meshopt', 'none'].includes(opts.geometry)) throw new Error(`--geometry ${opts.geometry}`);
  if (path.relative(opts.src, opts.out) === '') throw new Error('outDir must differ from --src');
  return opts;
}

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
const mb = bytes => (bytes / 1048576).toFixed(2);
const log = (...args) => console.log(`[optimize] ${args.join(' ')}`);

function findBasisu(explicit) {
  const candidates = [explicit, process.env.BASISU, 'basisu', '/opt/homebrew/bin/basisu', '/usr/local/bin/basisu'].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['-version'], { encoding: 'utf8' });
    if (!result.error) {
      const text = `${result.stdout}${result.stderr}`;
      const version = /v(\d+\.\d+\.\d+)/.exec(text)?.[1];
      return { command: candidate, version: version ?? 'unknown' };
    }
  }
  throw new Error('basisu not found. `brew install basis_universal` (>= 2.50) or pass --basisu <path>.');
}

// ---------------------------------------------------------------------------------------------------------------------
// Textures

function parsePsnr(output) {
  // "Quality stats vs. transcoded BC7 texture:\nBC7 RGB Avg:  Max: .. Mean: .. RMS: .. PSNR: 42.701 dB"
  const block = output.split('Quality stats vs. transcoded BC7 texture:')[1] ?? output;
  const match = /RGB Avg:.*?PSNR:\s*([\d.]+) dB/.exec(block);
  return match ? Number(match[1]) : null;
}

function runBasisu(basisu, args, cwd) {
  const result = spawnSync(basisu.command, args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (result.error || result.status !== 0) throw new Error(`basisu ${args.join(' ')} failed: ${result.error ?? ''}\n${result.stdout?.slice(-2000)}\n${result.stderr?.slice(-2000)}`);
  return `${result.stdout}\n${result.stderr}`;
}

// One basisu encode, cached by (source bytes, codec, role, colour space, size cap, basisu version).
async function encodeOnce(codec, { image, role, srgb }, opts, basisu) {
  const settings = { codec, role, srgb, maxTexture: opts.maxTexture, basisu: basisu.version, v: 2 };
  const key = sha256(Buffer.concat([Buffer.from(image), Buffer.from(JSON.stringify(settings))])).slice(0, 24);
  const cached = path.join(opts.cache, `tex-${key}.ktx2`);
  const meta = `${cached}.json`;
  if (!opts.force && fs.existsSync(cached) && fs.existsSync(meta)) return { data: new Uint8Array(await fsp.readFile(cached)), ...JSON.parse(await fsp.readFile(meta, 'utf8')), cached: true };

  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'basisu-'));
  try {
    // Normalise to an 8-bit RGB PNG so basisu never sees JPEG / palette / 16-bit variants.
    let pipeline = sharp(image, { failOn: 'none' }).toColourspace('srgb');
    const info = await sharp(image).metadata();
    let { width, height } = info;
    if (opts.maxTexture && Math.max(width, height) > opts.maxTexture) {
      const scale = opts.maxTexture / Math.max(width, height);
      width = Math.max(4, Math.round(width * scale)); height = Math.max(4, Math.round(height * scale));
      pipeline = pipeline.resize(width, height, { kernel: 'lanczos3' });
    }
    await pipeline.removeAlpha().png().toFile(path.join(work, 'in.png'));
    const common = ['-ktx2', '-mipmap', srgb ? '-srgb' : '-linear', '-stats', '-no_alpha', '-file', 'in.png', '-output_file', 'out.ktx2'];
    const codecArgs = codec === 'etc1s' ? ['-etc1s', '-quality', '70', '-effort', '4']
      : ['-uastc', '-uastc_level', '3', '-uastc_rdo_l', '1.0', ...(role === 'normal' ? ['-normal_map'] : [])];
    const out = runBasisu(basisu, [...common, ...codecArgs], work);
    const data = fs.readFileSync(path.join(work, 'out.ktx2'));
    const record = { codec, psnr: parsePsnr(out), width, height, bytes: data.length };
    await fsp.mkdir(opts.cache, { recursive: true });
    await fsp.writeFile(cached, data);
    await fsp.writeFile(meta, JSON.stringify(record));
    return { data: new Uint8Array(data), ...record, cached: false };
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

// Codec policy. UASTC everywhere is the default: ETC1S transcodes (three r180 basis transcoder -> BC7) of the roughness maps
// rendered a visibly glossier floor in the Chrome A/B (mean |dRGB| 1.4, worst 32 px region 38), UASTC matched (0.06 / 1.4).
async function encodeTexture(texture, opts, basisu) {
  const { role } = texture;
  if (opts.textures === 'uastc' || (opts.textures === 'auto' && role !== 'colour')) return encodeOnce('uastc', texture, opts, basisu);
  if (opts.textures === 'etc1s') return encodeOnce('etc1s', texture, opts, basisu);
  const etc = await encodeOnce('etc1s', texture, opts, basisu);
  if (etc.psnr !== null && etc.psnr >= opts.minPsnr) return etc;
  return { ...(await encodeOnce('uastc', texture, opts, basisu)), etc1sPsnr: etc.psnr, etc1sBytes: etc.bytes };
}

// ---------------------------------------------------------------------------------------------------------------------
// GLB

function textureRoles(root) {
  const roles = new Map();
  const mark = (texture, role) => {
    if (!texture) return;
    const existing = roles.get(texture);
    // A texture shared across roles takes the strictest one (normal > data > colour).
    const rank = { colour: 0, data: 1, normal: 2 };
    if (!existing || rank[role] > rank[existing]) roles.set(texture, role);
  };
  for (const material of root.listMaterials()) {
    mark(material.getBaseColorTexture(), 'colour'); mark(material.getEmissiveTexture(), 'colour');
    mark(material.getNormalTexture(), 'normal'); mark(material.getMetallicRoughnessTexture(), 'data'); mark(material.getOcclusionTexture(), 'data');
  }
  // Extension textures (sheen / specular / transmission ...) are data; colour ones are named *ColorTexture.
  for (const material of root.listMaterials()) {
    for (const extension of material.listExtensions()) {
      for (const getter of Object.getOwnPropertyNames(Object.getPrototypeOf(extension)).filter(n => /^get.*Texture$/.test(n))) {
        const texture = extension[getter]();
        mark(texture, /Color|Emissive/.test(getter) ? 'colour' : 'data');
      }
    }
  }
  return roles;
}

async function buildGlb(opts, basisu, report) {
  await MeshoptEncoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  const source = path.join(opts.src, 'room-runtime.glb');
  const document = await io.read(source);
  const root = document.getRoot();
  const roles = textureRoles(root);
  const lightmapMeshes = [];
  for (const node of root.listNodes()) {
    const lightmap = node.getExtras().lightmap, mesh = node.getMesh();
    if (lightmap === undefined || !mesh) continue;
    const uv1 = mesh.listPrimitives()[0]?.getAttribute('TEXCOORD_1');
    if (!uv1 || mesh.listPrimitives().length !== 1) throw new Error(`Lightmapped node ${node.getName()} needs exactly one primitive with TEXCOORD_1.`);
    lightmapMeshes.push({ name: node.getName(), atlas: lightmap, uv1: Float32Array.from(uv1.getArray()) });
  }
  report.textures = [];
  if (opts.textures !== 'keep') {
    document.createExtension(KHRTextureBasisu).setRequired(true);
    let index = 0;
    for (const texture of root.listTextures()) {
      const role = roles.get(texture) ?? 'data';
      if (!opts.ktx2Roles.split(',').includes(role)) { ++index; continue; }
      const image = texture.getImage();
      const sourceMime = texture.getMimeType();
      const started = Date.now();
      const encoded = await encodeTexture({ image, role, srgb: role === 'colour' }, opts, basisu);
      texture.setImage(encoded.data).setMimeType('image/ktx2');
      report.textures.push({ name: texture.getName(), role, sourceBytes: image.length, sourceMime, bytes: encoded.bytes, codec: encoded.codec, psnrDb: encoded.psnr, etc1sPsnrDb: encoded.etc1sPsnr, etc1sBytes: encoded.etc1sBytes, width: encoded.width, height: encoded.height, cached: encoded.cached });
      log(`texture ${++index}/${root.listTextures().length} ${texture.getName()} [${role}] ${mb(image.length)} MB -> ${mb(encoded.bytes)} MB ${encoded.codec} PSNR ${encoded.psnr} ${encoded.cached ? '(cached)' : `(${((Date.now() - started) / 1000).toFixed(1)} s)`}`);
    }
  }
  if (opts.geometry === 'meshopt') {
    document.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  }
  const target = path.join(opts.out, 'room-runtime.glb');
  const started = Date.now();
  const binary = await io.writeBinary(document);
  await fsp.writeFile(target, binary);
  report.glb = { bytes: binary.length, sourceBytes: fs.statSync(source).size, writeMs: Date.now() - started, extensions: document.getRoot().listExtensionsUsed().map(e => e.extensionName) };
  log(`room-runtime.glb ${mb(report.glb.sourceBytes)} MB -> ${mb(binary.length)} MB`);
  return { target, source, lightmapMeshes };
}

// Re-read both GLBs; every node name / extras, mesh, material and accessor value must match exactly (geometry is lossless).
async function verifyGlb(source, target, opts) {
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const [a, b] = await Promise.all([io.read(source), io.read(target)]);
  const problems = [];
  const ra = a.getRoot(), rb = b.getRoot();
  const count = (label, x, y) => { if (x !== y) problems.push(`${label}: ${x} != ${y}`); };
  count('nodes', ra.listNodes().length, rb.listNodes().length);
  count('meshes', ra.listMeshes().length, rb.listMeshes().length);
  count('materials', ra.listMaterials().length, rb.listMaterials().length);
  count('textures', ra.listTextures().length, rb.listTextures().length);
  count('scenes', ra.listScenes().length, rb.listScenes().length);
  const nodesB = rb.listNodes();
  let compared = 0, rotatedIndexMeshes = 0;
  ra.listNodes().forEach((node, i) => {
    const other = nodesB[i];
    if (node.getName() !== other.getName()) problems.push(`node ${i} name ${node.getName()} != ${other.getName()}`);
    if (JSON.stringify(node.getExtras()) !== JSON.stringify(other.getExtras())) problems.push(`node ${node.getName()} extras differ`);
    if (JSON.stringify([node.getTranslation(), node.getRotation(), node.getScale()]) !== JSON.stringify([other.getTranslation(), other.getRotation(), other.getScale()])) problems.push(`node ${node.getName()} transform differs`);
    const ma = node.getMesh(), mb2 = other.getMesh();
    if (!!ma !== !!mb2) { problems.push(`node ${node.getName()} mesh presence`); return; }
    if (!ma) return;
    if (ma.getName() !== mb2.getName()) problems.push(`mesh name ${ma.getName()} != ${mb2.getName()}`);
    const pa = ma.listPrimitives(), pb = mb2.listPrimitives();
    if (pa.length !== pb.length) { problems.push(`mesh ${ma.getName()} primitive count`); return; }
    pa.forEach((prim, j) => {
      const q = pb[j];
      if (prim.getMaterial()?.getName() !== q.getMaterial()?.getName()) problems.push(`mesh ${ma.getName()} material`);
      const semantics = prim.listSemantics().sort();
      if (JSON.stringify(semantics) !== JSON.stringify(q.listSemantics().sort())) problems.push(`mesh ${ma.getName()} semantics`);
      for (const semantic of semantics) {
        const x = prim.getAttribute(semantic), y = q.getAttribute(semantic);
        if (!y || x.getComponentType() !== y.getComponentType() || x.getCount() !== y.getCount() || Buffer.compare(Buffer.from(x.getArray().buffer, x.getArray().byteOffset, x.getArray().byteLength), Buffer.from(y.getArray().buffer, y.getArray().byteOffset, y.getArray().byteLength))) problems.push(`mesh ${ma.getName()} ${semantic} differs`);
      }
      const ix = prim.getIndices(), iy = q.getIndices();
      if (!ix !== !iy) problems.push(`mesh ${ma.getName()} indices presence`);
      else if (ix) {
        // The meshopt index codec keeps triangle order and winding but may rotate the three corners of a triangle
        // (a b c -> b c a). That is the same triangle; anything else is a real difference.
        const x = ix.getArray(), y = iy.getArray();
        let exact = x.length === y.length, rotated = false;
        if (exact) for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) { exact = false; break; }
        if (!exact && x.length === y.length) {
          rotated = true;
          for (let t = 0; t < x.length && rotated; t += 3) {
            const ok = (x[t] === y[t] && x[t + 1] === y[t + 1] && x[t + 2] === y[t + 2]) || (x[t] === y[t + 1] && x[t + 1] === y[t + 2] && x[t + 2] === y[t])
              || (x[t] === y[t + 2] && x[t + 1] === y[t] && x[t + 2] === y[t + 1]);
            if (!ok) rotated = false;
          }
        }
        if (!exact && !rotated) problems.push(`mesh ${ma.getName()} indices differ`);
        if (rotated) rotatedIndexMeshes++;
      }
      compared++;
    });
  });
  const matsB = rb.listMaterials();
  ra.listMaterials().forEach((material, i) => {
    const other = matsB[i];
    const keys = m => JSON.stringify([m.getName(), m.getBaseColorFactor(), m.getRoughnessFactor(), m.getMetallicFactor(), m.getAlphaMode(), m.getDoubleSided(), m.getExtras(), m.listExtensions().map(e => e.extensionName),
      m.getBaseColorTexture()?.getName(), m.getNormalTexture()?.getName(), m.getMetallicRoughnessTexture()?.getName()]);
    if (keys(material) !== keys(other)) problems.push(`material ${material.getName()} differs`);
  });
  for (const texture of rb.listTextures()) {
    const [w, h] = texture.getSize() ?? [0, 0];
    if (opts.textures !== 'keep' && texture.getMimeType() !== 'image/ktx2') problems.push(`texture ${texture.getName()} not ktx2`);
    if (!w || !h) problems.push(`texture ${texture.getName()} has no size`);
  }
  return { ok: problems.length === 0, primitivesCompared: compared, meshesWithRotatedTriangleCorners: rotatedIndexMeshes, problems: problems.slice(0, 40) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Lightmaps (UASTC HDR 4x4 KTX2)

// Minimal uncompressed scanline OpenEXR writer (HALF, channels B,G,R), enough for basisu's EXR reader.
function writeExrHalfRGB(file, width, height, rgba) {
  const parts = [];
  const attr = (name, type, body) => parts.push(Buffer.from(`${name}\0${type}\0`), (() => { const l = Buffer.alloc(4); l.writeInt32LE(body.length); return l; })(), body);
  const chlist = [];
  for (const channel of ['B', 'G', 'R']) {
    const c = Buffer.alloc(16); c.writeInt32LE(1, 0); c.writeInt32LE(1, 8); c.writeInt32LE(1, 12);
    chlist.push(Buffer.from(`${channel}\0`), c);
  }
  chlist.push(Buffer.from([0]));
  const box = Buffer.alloc(16); box.writeInt32LE(width - 1, 8); box.writeInt32LE(height - 1, 12);
  const float = value => { const b = Buffer.alloc(4); b.writeFloatLE(value); return b; };
  parts.push(Buffer.from([0x76, 0x2f, 0x31, 0x01, 2, 0, 0, 0]));
  attr('channels', 'chlist', Buffer.concat(chlist));
  attr('compression', 'compression', Buffer.from([0]));
  attr('dataWindow', 'box2i', box); attr('displayWindow', 'box2i', box);
  attr('lineOrder', 'lineOrder', Buffer.from([0]));
  attr('pixelAspectRatio', 'float', float(1));
  attr('screenWindowCenter', 'v2f', Buffer.alloc(8));
  attr('screenWindowWidth', 'float', float(1));
  parts.push(Buffer.from([0]));
  const header = Buffer.concat(parts);
  const lineBytes = 8 + width * 3 * 2;
  const table = Buffer.alloc(height * 8);
  const base = header.length + table.length;
  for (let y = 0; y < height; y++) table.writeBigUInt64LE(BigInt(base + y * lineBytes), y * 8);
  const body = Buffer.alloc(height * lineBytes);
  for (let y = 0; y < height; y++) {
    const at = y * lineBytes;
    body.writeInt32LE(y, at); body.writeInt32LE(width * 6, at + 4);
    const row = y * width * 4;
    const out = new Uint16Array(body.buffer, body.byteOffset + at + 8, width * 3);
    // Channel order in the scanline is alphabetical: B then G then R, each a full row.
    for (let x = 0; x < width; x++) { out[x] = rgba[row + x * 4 + 2]; out[width + x] = rgba[row + x * 4 + 1]; out[2 * width + x] = rgba[row + x * 4]; }
  }
  fs.writeFileSync(file, Buffer.concat([header, table, body]));
}

// Per-vertex lightmap samples. Every CPU-side lightmap lookup in the viewer (vertexTexels, hole test, starved-island luma) reads the
// nearest texel at a vertex's ORIGINAL uv1 of the oriented + rim-repaired half-float atlas; precomputing them lets the viewer skip
// fetching and decoding the EXRs altogether. Layout: Uint16 half RGB per vertex, meshes concatenated in the order of the index file.
async function buildSamples(atlases, meshes, opts) {
  const repairHash = sha256(fs.readFileSync(path.join(ROOT, 'src/interior-atlas-repair.js'))).slice(0, 12);
  const atlasHashes = {};
  for (const atlas of atlases) atlasHashes[atlas.id] = await sha256File(path.join(opts.src, path.basename(new URL(atlas.url, 'http://x/').pathname)));
  const meshHash = crypto.createHash('sha256');
  for (const mesh of meshes) { meshHash.update(mesh.name); meshHash.update(mesh.atlas); meshHash.update(Buffer.from(mesh.uv1.buffer, mesh.uv1.byteOffset, mesh.uv1.byteLength)); }
  const key = sha256(Buffer.from(JSON.stringify({ atlasHashes, repairHash, mesh: meshHash.digest('hex'), v: 1 }))).slice(0, 24);
  const cachedBin = path.join(opts.cache, `samples-${key}.bin`), cachedIndex = `${cachedBin}.json`;
  if (!opts.force && fs.existsSync(cachedBin) && fs.existsSync(cachedIndex)) return { bin: await fsp.readFile(cachedBin), index: JSON.parse(await fsp.readFile(cachedIndex, 'utf8')), cached: true };
  const total = meshes.reduce((sum, mesh) => sum + mesh.uv1.length / 2, 0);
  const out = new Uint16Array(total * 3);
  const index = { version: 1, format: 'half-rgb-per-vertex', orientation: 'uv1-top', rimRepaired: true, texel: 'x=min(w-1,max(0,floor(uv1.x*w))), y=min(h-1,max(0,floor(uv1.y*h))), rgb=atlas[(y*w+x)*4..+2] (half float bits)', atlas: {}, meshes: {}, vertices: total };
  const atlasById = new Map(atlases.map(atlas => [atlas.id, atlas]));
  let offset = 0;
  for (const mesh of meshes) {
    const atlas = atlasById.get(mesh.atlas);
    if (!atlas) throw new Error(`Mesh ${mesh.name} uses unknown lightmap ${mesh.atlas}`);
    const { data, width, height } = await loadAtlas(atlas, opts);
    index.atlas[mesh.atlas] = { width, height };
    const count = mesh.uv1.length / 2;
    for (let i = 0; i < count; i++) {
      const x = Math.min(width - 1, Math.max(0, Math.floor(mesh.uv1[2 * i] * width)));
      const y = Math.min(height - 1, Math.max(0, Math.floor(mesh.uv1[2 * i + 1] * height)));
      const o = (y * width + x) * 4;
      out[offset + 3 * i] = data[o]; out[offset + 3 * i + 1] = data[o + 1]; out[offset + 3 * i + 2] = data[o + 2];
    }
    index.meshes[mesh.name] = { atlas: mesh.atlas, offset, count };
    offset += count * 3;
  }
  const bin = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
  await fsp.mkdir(opts.cache, { recursive: true });
  await fsp.writeFile(cachedBin, bin); await fsp.writeFile(cachedIndex, JSON.stringify(index));
  return { bin, index, cached: false };
}

// An EXR as three's EXRLoader decodes it (offline only; the viewer has no EXR decoder).
async function decodeExr(file) {
  const { EXRLoader } = await import('three/addons/loaders/EXRLoader.js');
  const THREE = await import('three');
  const buffer = await fsp.readFile(file);
  const loader = new EXRLoader(); loader.setDataType(THREE.HalfFloatType);
  // `data`: Uint16 half RGBA, bottom row first (EXRLoader's order).
  return loader.parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}

// Decoded + oriented + rim-repaired atlas (the exact RGBA half data the viewer once held after loading an EXR atlas), memoised.
const atlasMemo = new Map();
function loadAtlas(atlas, opts) {
  const file = path.join(opts.src, path.basename(new URL(atlas.url, 'http://x/').pathname));
  if (!atlasMemo.has(file)) {
    atlasMemo.set(file, (async () => {
      const { prepareAtlasData } = await import(pathToFileURL(path.join(ROOT, 'src/interior-atlas-repair.js')).href);
      const { data, width, height } = await decodeExr(file);
      // The same code the viewer once ran at load: orient the rows to glTF UV1 (top origin) and repair the island rims.
      const repair = prepareAtlasData(data, width, height);
      return { data, width, height, repair };
    })());
  }
  return atlasMemo.get(file);
}

// Radiance RGBE with new-style run-length scanlines, from the half-float RGBA rows EXRLoader returns (bottom row first). three's
// HDRLoader reads scanlines top first and the viewer sets flipY, so rows are written last to first. HDRLoader decodes
// mantissa * 2^(e - 128) / 255; the exponent is chosen so the largest channel lands in (127.5, 255].
async function writeRgbe(file, width, height, half) {
  const { DataUtils } = await import('three');
  const chunks = [Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`, 'latin1')];
  if (width < 8 || width > 0x7fff) throw new Error(`RGBE run-length scanlines need 8 <= width <= 32767 (got ${width})`);
  const planes = [0, 1, 2, 3].map(() => new Uint8Array(width));
  const out = [];
  const encode = plane => {
    for (let i = 0; i < plane.length;) {
      let run = 1;
      while (i + run < plane.length && plane[i + run] === plane[i] && run < 127) run++;
      if (run >= 3) { out.push(128 + run, plane[i]); i += run; continue; }
      let end = i, count = 0;
      while (end < plane.length && count < 128) {
        let ahead = 1;
        while (end + ahead < plane.length && plane[end + ahead] === plane[end] && ahead < 3) ahead++;
        if (ahead >= 3) break;
        end++; count++;
      }
      out.push(count);
      for (let k = i; k < end; k++) out.push(plane[k]);
      i = end;
    }
  };
  for (let row = height - 1; row >= 0; row--) {
    for (let x = 0; x < width; x++) {
      const o = (row * width + x) * 4;
      const channel = [DataUtils.fromHalfFloat(half[o]), DataUtils.fromHalfFloat(half[o + 1]), DataUtils.fromHalfFloat(half[o + 2])];
      const peak = Math.max(...channel);
      if (!(peak > 1e-30)) { for (const plane of planes) plane[x] = 0; continue; }
      let k = Math.ceil(Math.log2(peak));
      while (peak > 2 ** k) k++;
      while (peak <= 2 ** (k - 1)) k--;
      for (let c = 0; c < 3; c++) planes[c][x] = Math.min(255, Math.round(Math.max(0, channel[c]) / 2 ** k * 255));
      planes[3][x] = k + 128;
    }
    out.length = 0;
    out.push(2, 2, width >> 8, width & 255);
    for (const plane of planes) encode(plane);
    chunks.push(Buffer.from(out));
  }
  await fsp.writeFile(file, Buffer.concat(chunks));
}

// The probe / sky: an EXR source becomes a Radiance .hdr; a source that already is one is copied.
async function buildHdr(url, name, opts) {
  const source = path.join(opts.src, path.basename(new URL(url, 'http://x/').pathname));
  const target = path.join(opts.out, name);
  await fsp.rm(target, { force: true });
  if (/\.hdr$/i.test(source)) await fsp.copyFile(source, target);
  else {
    const { data, width, height } = await decodeExr(source);
    await writeRgbe(target, width, height, data);
  }
  return { source, target };
}

async function buildLightmapGpu(atlas, opts, basisu) {
  const sourceFile = path.join(opts.src, path.basename(new URL(atlas.url, 'http://x/').pathname));
  const sourceHash = await sha256File(sourceFile);
  const repairModule = path.join(ROOT, 'src/interior-atlas-repair.js');
  const settings = { level: opts.lightmapLevel, basisu: basisu.version, repair: sha256(fs.readFileSync(repairModule)).slice(0, 12), v: 1 };
  const key = sha256(Buffer.from(sourceHash + JSON.stringify(settings))).slice(0, 24);
  const cached = path.join(opts.cache, `lm-${key}.ktx2`);
  const meta = `${cached}.json`;
  if (!opts.force && fs.existsSync(cached) && fs.existsSync(meta)) return { data: await fsp.readFile(cached), ...JSON.parse(await fsp.readFile(meta, 'utf8')), cached: true };

  const { data, width, height, repair } = await loadAtlas(atlas, opts);
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'basisu-lm-'));
  try {
    writeExrHalfRGB(path.join(work, 'atlas.exr'), width, height, data);
    const started = Date.now();
    runBasisu(basisu, ['-ktx2', '-hdr_4x4', '-uastc_level', String(opts.lightmapLevel), '-linear', '-quiet', '-file', 'atlas.exr', '-output_file', 'atlas.ktx2'], work);
    const out = await fsp.readFile(path.join(work, 'atlas.ktx2'));
    const record = { bytes: out.length, width, height, repair, encodeMs: Date.now() - started };
    await fsp.mkdir(opts.cache, { recursive: true });
    await fsp.writeFile(cached, out); await fsp.writeFile(meta, JSON.stringify(record));
    return { data: out, ...record, cached: false };
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const basisu = findBasisu(opts.basisu);
  log(`basisu ${basisu.version}; src ${opts.src}; out ${opts.out}`);
  await fsp.mkdir(opts.out, { recursive: true });
  const manifest = JSON.parse(await fsp.readFile(path.join(opts.src, 'manifest.json'), 'utf8'));
  // Files the previous run wrote (receipt) and legacy symlinks: removed at the end unless this run produces them again.
  let previous = [];
  try { previous = Object.keys(JSON.parse(await fsp.readFile(path.join(opts.out, 'optimized.json'), 'utf8')).files ?? {}); } catch { /* first run */ }
  const report = { tool: 'scripts/optimize_runtime_assets.mjs', createdAt: new Date().toISOString(), node: process.version, host: { load: os.loadavg()[0], cpus: os.cpus().length },
    versions: { basisu: basisu.version, sharp: sharp.versions.sharp, meshoptimizer: JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/meshoptimizer/package.json'), 'utf8')).version,
      gltfTransform: JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/@gltf-transform/core/package.json'), 'utf8')).version },
    settings: { textures: opts.textures, minPsnr: opts.minPsnr, maxTexture: opts.maxTexture, geometry: opts.geometry, lightmapLevel: opts.lightmapLevel, urlBase: opts.urlBase }, files: {} };

  const produced = new Set(['optimized.json']);
  const sourceFileOf = url => path.join(opts.src, path.basename(new URL(url, 'http://x/').pathname));
  const urlOf = name => `${opts.urlBase}/${name}`;

  // GLB
  const modelName = path.basename(new URL(manifest.model, 'http://x/').pathname);
  if (modelName !== 'room-runtime.glb') throw new Error(`Unexpected runtime model ${manifest.model}`);
  await fsp.rm(path.join(opts.out, 'room-runtime.glb'), { force: true });
  const glb = await buildGlb(opts, basisu, report);
  produced.add('room-runtime.glb');
  report.files['room-runtime.glb'] = { sourceBytes: report.glb.sourceBytes, bytes: report.glb.bytes, sha256: await sha256File(glb.target), sourceSha256: await sha256File(glb.source) };
  report.verification = opts.verify ? await verifyGlb(glb.source, glb.target, opts) : { skipped: true };
  if (opts.verify) {
    log(`verify: ${report.verification.ok ? 'OK' : 'FAILED'} (${report.verification.primitivesCompared} primitives)`);
    if (!report.verification.ok) { console.error(report.verification.problems.join('\n')); }
  }

  if (opts.onlyGlb) {
    await fsp.writeFile(path.join(opts.out, 'optimized.json'), `${JSON.stringify(report, null, 2)}\n`);
    log('--only-glb: wrote room-runtime.glb + optimized.json only');
    if (opts.verify && !report.verification.ok) process.exitCode = 1;
    return;
  }

  const outManifest = structuredClone(manifest);
  outManifest.model = urlOf('room-runtime.glb');

  // Reflection probe + sky: Radiance RGBE
  for (const [field, name] of [['environment', 'room-environment.hdr'], ['background', 'bedroom-sky.hdr']]) {
    if (manifest[field] == null) continue;
    const hdr = await buildHdr(manifest[field], name, opts);
    produced.add(name);
    outManifest[field] = urlOf(name);
    report.files[name] = { bytes: fs.statSync(hdr.target).size, sourceBytes: fs.statSync(hdr.source).size, sha256: await sha256File(hdr.target), sourceSha256: await sha256File(hdr.source) };
    log(`${field}: ${path.basename(hdr.source)} ${mb(report.files[name].sourceBytes)} MB -> ${name} ${mb(report.files[name].bytes)} MB`);
  }

  // Lightmaps
  for (const atlas of outManifest.lightmaps) {
    const gpu = await buildLightmapGpu(atlas, opts, basisu);
    const name = path.basename(new URL(atlas.url, 'http://x/').pathname).replace(/\.exr$/i, '.ktx2');
    await fsp.rm(path.join(opts.out, name), { force: true });
    await fsp.writeFile(path.join(opts.out, name), gpu.data);
    produced.add(name);
    report.files[name] = { bytes: gpu.bytes, sha256: sha256(gpu.data), sourceBytes: fs.statSync(sourceFileOf(atlas.url)).size, sourceSha256: await sha256File(sourceFileOf(atlas.url)), width: gpu.width, height: gpu.height, rimRepair: gpu.repair, encodeMs: gpu.encodeMs, cached: gpu.cached };
    log(`lightmap ${atlas.id}: EXR ${mb(report.files[name].sourceBytes)} MB -> KTX2 ${mb(gpu.bytes)} MB ${gpu.cached ? '(cached)' : ''}`);
    atlas.sourceUrl = atlas.url;
    atlas.url = urlOf(name);
    Object.assign(atlas, { format: 'uastc-hdr-4x4', container: 'ktx2', rimRepaired: true, rowOrder: 'uv1-top', bytes: gpu.bytes });
  }

  // Per-vertex samples for every CPU-side lightmap lookup (sources: the atlases read above via loadAtlas, keyed by EXR URL).
  const samplesInput = outManifest.lightmaps.map(atlas => ({ id: atlas.id, url: atlas.sourceUrl }));
  const samples = await buildSamples(samplesInput, glb.lightmapMeshes, opts);
  await fsp.writeFile(path.join(opts.out, 'lightmap-samples.bin'), samples.bin);
  await fsp.writeFile(path.join(opts.out, 'lightmap-samples.json'), `${JSON.stringify(samples.index)}\n`);
  produced.add('lightmap-samples.bin'); produced.add('lightmap-samples.json');
  report.files['lightmap-samples.bin'] = { bytes: samples.bin.length, sha256: sha256(samples.bin), vertices: samples.index.vertices, meshes: Object.keys(samples.index.meshes).length, cached: samples.cached };
  report.files['lightmap-samples.json'] = { bytes: fs.statSync(path.join(opts.out, 'lightmap-samples.json')).size };
  outManifest.lightmapSamples = { url: urlOf('lightmap-samples.bin'), index: urlOf('lightmap-samples.json'), format: 'half-rgb-per-vertex', bytes: samples.bin.length, sha256: report.files['lightmap-samples.bin'].sha256 };
  log(`lightmap samples: ${samples.index.vertices} vertices, ${Object.keys(samples.index.meshes).length} meshes, ${mb(samples.bin.length)} MB ${samples.cached ? '(cached)' : ''}`);

  outManifest.runtimeAssets = { version: 2, receipt: urlOf('optimized.json'), model: { meshopt: opts.geometry === 'meshopt', texturesKtx2: opts.textures !== 'keep' }, lightmaps: 'uastc-hdr-4x4', lightmapSamples: true, environment: 'rgbe' };
  await fsp.writeFile(path.join(opts.out, 'manifest.json'), `${JSON.stringify(outManifest, null, 2)}\n`);
  produced.add('manifest.json');
  report.files['manifest.json'] = { bytes: fs.statSync(path.join(opts.out, 'manifest.json')).size, sourceBytes: fs.statSync(path.join(opts.src, 'manifest.json')).size, sourceSha256: await sha256File(path.join(opts.src, 'manifest.json')) };

  // Leftovers: files the previous run produced and this one does not, and legacy symlinks into the source dir.
  report.removed = [];
  for (const entry of await fsp.readdir(opts.out, { withFileTypes: true })) {
    if (produced.has(entry.name) || !(entry.isSymbolicLink() || previous.includes(entry.name))) continue;
    await fsp.rm(path.join(opts.out, entry.name), { force: true });
    report.removed.push(entry.name);
  }

  // What a browser fetches: the manifest and every runtime file. The source column is the old payload (GLB, atlas / probe / sky EXRs, manifest).
  const fetched = Object.keys(report.files);
  report.totals = {
    sourceRuntimeBytes: fetched.reduce((total, n) => total + (report.files[n].sourceBytes ?? 0), 0),
    runtimeBytes: fetched.reduce((total, n) => total + report.files[n].bytes, 0),
    elapsedSeconds: Math.round((Date.now() - started) / 1000),
  };
  await fsp.writeFile(path.join(opts.out, 'optimized.json'), `${JSON.stringify(report, null, 2)}\n`);
  log(`done in ${report.totals.elapsedSeconds} s: the browser fetches ${mb(report.totals.runtimeBytes)} MB (the exported runtime payload was ${mb(report.totals.sourceRuntimeBytes)} MB); output ${opts.out}`);
  if (report.removed.length) log(`removed leftovers: ${report.removed.join(', ')}`);
  if (opts.verify && !report.verification.ok) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exit(1); });
