import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync, constants as zlib } from 'node:zlib';
import { defineConfig } from 'vite';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Resolved through Node resolution (not a fixed ./node_modules path): a workspace/root install may hoist three elsewhere.
const BASIS_DIR = path.join(path.dirname(createRequire(import.meta.url).resolve('three')), '..', 'examples', 'jsm', 'libs', 'basis') + path.sep;
const BASIS_FILES = ['basis_transcoder.js', 'basis_transcoder.wasm'];

const TYPES = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.png': 'image/png',
  '.ktx2': 'image/ktx2', '.hdr': 'image/vnd.radiance', '.bin': 'application/octet-stream', '.blend': 'application/octet-stream',
};
// Text-like files: precompressed .br / .gz siblings are served when the build produced them.
const PRECOMPRESS = new Set(['.js', '.mjs', '.css', '.html', '.json', '.svg', '.wasm', '.txt']);
// The runtime GLB (meshopt geometry + KTX2 textures), the KTX2 lightmaps and the half-float sample table are already compressed
// or incompressible binary: they are streamed as-is with their Content-Length (the loader's byte progress needs it), so no
// precompressed copies are made. `no-transform` tells intermediaries not to re-encode them either. (Preview's own compression()
// only touches text/json/xml types, so it never sees these.)
const HASHED_ASSET = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.(?:js|css|wasm|woff2?|svg|png|jpg|webp)$/;

function cacheControlFor(pathname) {
  if (HASHED_ASSET.test(pathname)) return 'public, max-age=31536000, immutable';
  if (pathname.startsWith('/vendor/basis/')) return 'public, max-age=86400';
  // Stable names that an export / `npm run optimize:assets` rewrites in place (/assets/interior*/): always revalidate
  // (ETag / Last-Modified -> 304), never serve stale.
  return pathname.endsWith('.html') || pathname === '/' ? 'no-cache' : 'no-cache, no-transform';
}

function etagFor(stats, encoding) {
  return `W/"${stats.size}-${Math.floor(stats.mtimeMs)}${encoding ? `-${encoding}` : ''}"`;
}

function statFile(file) {
  try {
    const stats = fs.statSync(file);
    return stats.isFile() ? stats : null;
  } catch { return null; }
}

// `Accept-Encoding` lookup with q=0 meaning "refused".
function acceptsEncoding(header, token) {
  return header.split(',').some(part => {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (name !== token) return false;
    const q = params.map(item => item.trim()).find(item => item.startsWith('q='));
    return !q || Number(q.slice(2)) > 0;
  });
}

// Serves files from `root` with deliberate caching headers, precompressed siblings and plain streaming for the big binaries.
// Everything it does not recognise falls through to the next middleware.
function createStaticMiddleware(root) {
  return function interiorStaticMiddleware(req, res, next) {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || req.headers.range) return next();
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return next(); }
    if (pathname.includes('\0') || pathname.split('/').includes('..')) return next();
    const ext = path.extname(pathname).toLowerCase();
    const type = TYPES[ext];
    if (!type || pathname.endsWith('/')) return next();
    const file = path.join(root, pathname);
    const stats = statFile(file);
    if (!stats) return next();

    let served = file, servedStats = stats, encoding = '';
    if (PRECOMPRESS.has(ext)) {
      const accept = String(req.headers['accept-encoding'] ?? '');
      for (const [token, suffix] of [['br', '.br'], ['gzip', '.gz']]) {
        if (!acceptsEncoding(accept, token)) continue;
        const candidate = statFile(file + suffix);
        // A stale sibling (the original was rewritten after compression) must never be served.
        if (candidate && candidate.mtimeMs >= stats.mtimeMs) { served = file + suffix; servedStats = candidate; encoding = token; break; }
      }
    }

    const etag = etagFor(stats, encoding);
    res.setHeader('Cache-Control', cacheControlFor(pathname));
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', stats.mtime.toUTCString());
    res.setHeader('Content-Type', type);
    if (PRECOMPRESS.has(ext)) res.setHeader('Vary', 'Accept-Encoding');
    if (encoding) res.setHeader('Content-Encoding', encoding);
    if (req.headers['if-none-match'] === etag) {
      res.statusCode = 304;
      return res.end();
    }
    res.setHeader('Content-Length', servedStats.size);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(served);
    stream.on('error', () => { if (!res.headersSent) { res.statusCode = 500; } res.end(); });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  };
}

function compressBuild(dir) {
  const stack = [dir];
  const written = [];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      // Symlinked directories (the private builds link assets/interior to the working tree) are never entered, and the
      // interior assets are stable-named files an export rewrites: no precompressed copies of those.
      if (entry.isSymbolicLink() || full.includes(`${path.sep}assets${path.sep}interior`)) continue;
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!entry.isFile() || !PRECOMPRESS.has(path.extname(entry.name).toLowerCase())) continue;
      const source = fs.readFileSync(full);
      if (source.length < 1024) continue;
      const variants = [
        ['.br', brotliCompressSync(source, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11, [zlib.BROTLI_PARAM_SIZE_HINT]: source.length } })],
        ['.gz', gzipSync(source, { level: 9 })],
      ];
      for (const [suffix, data] of variants) {
        if (data.length < source.length * 0.95) { fs.writeFileSync(full + suffix, data); written.push(full + suffix); }
      }
    }
  }
  return written;
}

function interiorServing({ precompress }) {
  let config;
  return {
    name: 'interior-serving',
    configResolved(resolved) { config = resolved; },

    // Basis/KTX2 transcoder, copied from three at build time to a stable, cacheable URL: /vendor/basis/.
    generateBundle() {
      for (const name of BASIS_FILES) {
        this.emitFile({ type: 'asset', fileName: `vendor/basis/${name}`, source: fs.readFileSync(path.join(BASIS_DIR, name)) });
      }
    },
    writeBundle(options) {
      if (options.dir && precompress) compressBuild(options.dir);
    },

    configureServer(server) {
      // Dev server: the same URL, served straight from node_modules (connect strips the mount prefix from req.url).
      const serveBasis = createStaticMiddleware(BASIS_DIR.replace(/[\\/]$/, ''));
      server.middlewares.use('/vendor/basis', (req, res, next) => {
        if (!BASIS_FILES.includes(decodeURIComponent(new URL(req.url, 'http://x').pathname).slice(1))) return next();
        serveBasis(req, res, next);
      });
    },

    configurePreviewServer(server) {
      const root = path.resolve(config.root, config.build.outDir);
      const handler = createStaticMiddleware(root);
      server.middlewares.use(handler);
      return () => {
        // Vite installs its Host-header check and compression() after plugin hooks: run right before its static file
        // middleware, i.e. behind both, so only allowed hosts reach us and an already set Content-Encoding is respected.
        const stack = server.middlewares.stack;
        const mine = stack.findIndex(layer => layer.handle === handler);
        const sirv = stack.findIndex(layer => layer.handle.name === 'viteAssetMiddleware');
        if (mine !== -1 && sirv !== -1 && mine < sirv) {
          const [layer] = stack.splice(mine, 1);
          stack.splice(sirv - 1, 0, layer);
        }
      };
    },
  };
}

function packageSource(output) {
  const args = [path.join(ROOT, 'scripts', 'package_source.py'), '--output', output];
  const result = spawnSync('python3', args, { cwd: ROOT, stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    throw new Error(`package_source.py failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status})`}`);
  }
}

// Showcase (Pages) build: hard-link ONLY the files pinned in assets.lock.json (the optimized runtime set: meshopt + KTX2 GLB,
// KTX2 lightmaps, samples sidecars, RGBE probes, manifest) into a staging public dir. The portable GLB, the Blender master and the
// Source ZIP are never staged; they are release downloads declared in assets.lock.json. The Basis transcoder is emitted by the
// interior-serving plugin to <base>vendor/basis/.
function stageShowcasePublic(lock) {
  if (!Array.isArray(lock.files) || !lock.files.length) {
    throw new Error('assets.lock.json is pending (no pinned runtime files): run scripts/lock_assets.py first');
  }
  const stage = path.join(ROOT, '.site-public');
  fs.rmSync(stage, { recursive: true, force: true });
  for (const { path: rel } of lock.files) {
    const to = path.join(stage, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.linkSync(path.join(ROOT, 'public', rel), to);
  }
  return stage;
}

export default defineConfig(({ command, mode }) => {
  const showcase = mode === 'showcase';
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets.lock.json'), 'utf8'));
  // Release download URLs (source ZIP, portable GLB, Blender master) in every mode: those files are never served by the app.
  const downloads = Object.fromEntries(Object.entries(lock.downloads).map(([key, item]) => [key, typeof item === 'string' ? item : item.url]));
  const config = {
    appType: 'mpa',
    plugins: [interiorServing({ precompress: !showcase })],
    define: { 'import.meta.env.VITE_MODERN_BEDROOM_DOWNLOADS': JSON.stringify(downloads) },
  };
  if (showcase) {
    config.base = '/modern-bedroom/';
    config.build = { outDir: path.resolve(ROOT, '../../public/modern-bedroom'), emptyOutDir: true };
  }
  if (command === 'build') {
    // Generated next to the output for release upload only; the page links the release URL, never this file.
    packageSource(path.join(ROOT, '.release', 'modern-bedroom-source.zip'));
    if (showcase) config.publicDir = stageShowcasePublic(lock);
  }
  return config;
});
