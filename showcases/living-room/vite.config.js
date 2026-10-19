import { spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = dirname(fileURLToPath(import.meta.url));
const MANIFEST = 'assets/interior/manifest.json';

function packageSource(output) {
  const args = [join(root, 'scripts', 'package_source.py')];
  if (output) args.push('--output', output);
  const result = spawnSync('python3', args, { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    throw new Error(`package_source.py failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status})`}`);
  }
}

// Showcase (Pages) build: stage hard links of the runtime assets only, so the multi-hundred-MB
// portable GLB and Blend master never enter the Pages output; those two files and the Source ZIP
// are served from release URLs declared in assets.lock.json.
function stageShowcasePublic(lock) {
  const manifest = JSON.parse(readFileSync(join(root, 'public', MANIFEST), 'utf8'));
  const excluded = new Set([manifest.portableModel, manifest.blender].map((url) => String(url).replace(/^\//, '')));
  const stage = join(root, '.site-public');
  rmSync(stage, { recursive: true, force: true });
  for (const { path } of lock.files) {
    if (excluded.has(path)) continue;
    const from = join(root, 'public', path);
    const to = join(stage, path);
    mkdirSync(dirname(to), { recursive: true });
    linkSync(from, to);
  }
  return stage;
}

export default defineConfig(({ command, mode }) => {
  const config = { appType: 'mpa' };
  const showcase = mode === 'showcase';
  const lock = showcase ? JSON.parse(readFileSync(join(root, 'assets.lock.json'), 'utf8')) : null;
  if (showcase) {
    config.define = { 'import.meta.env.VITE_LIVING_ROOM_DOWNLOADS': JSON.stringify(lock.downloads) };
  }
  // Generation runs here, before Vite copies the public directory; dev and preview never repackage.
  if (command === 'build') {
    if (showcase) {
      packageSource(join(root, '.release', 'living-room-source.zip'));
      config.publicDir = stageShowcasePublic(lock);
    } else {
      packageSource();
    }
  }
  return config;
});
