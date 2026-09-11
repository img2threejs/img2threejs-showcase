import { promises as fs } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';
import type { Connect } from 'vite';
import { defineConfig, type Plugin } from 'vite';

const sourceRoot = resolve(process.cwd(), 'public/iphone-duo');
const publicPrefix = '/iphone-duo/';

const mimeTypes: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

async function listFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(fullPath)));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

function isInsideRoot(filePath: string): boolean {
  const root = `${sourceRoot}${sep}`;
  return filePath === sourceRoot || filePath.startsWith(root);
}

function serveSelectiveAssets(): Plugin {
  const handler: Connect.NextHandleFunction = async (request, response, next) => {
    const requestUrl = request.url?.split('?')[0] ?? '';
    if (!requestUrl.startsWith(publicPrefix)) {
      next();
      return;
    }
    const encodedRelativePath = requestUrl.slice(publicPrefix.length);
    let decodedRelativePath: string;
    try {
      decodedRelativePath = decodeURIComponent(encodedRelativePath);
    } catch {
      response.statusCode = 400;
      response.end('Bad request');
      return;
    }
    const filePath = resolve(sourceRoot, decodedRelativePath);
    if (!isInsideRoot(filePath)) {
      response.statusCode = 403;
      response.end('Forbidden');
      return;
    }
    try {
      const stats = await fs.stat(filePath);
      if (!stats.isFile()) {
        next();
        return;
      }
      response.statusCode = 200;
      response.setHeader('Content-Type', mimeTypes[extname(filePath).toLowerCase()] ?? 'application/octet-stream');
      response.setHeader('Content-Length', String(stats.size));
      response.end(await fs.readFile(filePath));
    } catch {
      next();
    }
  };

  return {
    name: 'iphone-duo-selective-assets',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    async generateBundle() {
      const files = await listFiles(sourceRoot);
      for (const filePath of files) {
        this.emitFile({
          type: 'asset',
          fileName: `iphone-duo/${relative(sourceRoot, filePath).split(sep).join('/')}`,
          source: await fs.readFile(filePath),
        });
      }
    },
  };
}

export default defineConfig({
  base: '/',
  publicDir: false,
  plugins: [serveSelectiveAssets()],
  build: {
    outDir: 'dist-iphone-duo',
    emptyOutDir: true,
    copyPublicDir: false,
    rollupOptions: {
      input: 'iphone-duo.html',
    },
  },
});
