#!/usr/bin/env node
// Static safety scan for showcase-demo PRs. Plain Node, no dependencies.
// Usage:
//   node scripts/check-showcase-safety.mjs                 (CI: diffs against origin/<base>)
//   node scripts/check-showcase-safety.mjs --base main
//   node scripts/check-showcase-safety.mjs --files a.ts,b.png   (self-test: skip git diff)

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const MAX_REFERENCE_IMAGE_BYTES = 800 * 1024;
const ALLOWED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

const BANNED_PATTERNS = [
  { re: /\bfetch\s*\(/, message: 'network call (fetch) is not allowed in a demo factory' },
  { re: /XMLHttpRequest/, message: 'network call (XMLHttpRequest) is not allowed in a demo factory' },
  { re: /new\s+WebSocket/, message: 'network call (WebSocket) is not allowed in a demo factory' },
  { re: /\beval\s*\(/, message: 'eval() is banned' },
  { re: /new\s+Function\s*\(/, message: 'new Function() is banned' },
  { re: /document\.write/, message: 'document.write is banned' },
  { re: /\.innerHTML\s*=/, message: 'assigning innerHTML is banned' },
];

const URL_LITERAL = /https?:\/\//;
// An SVG namespace identifies the vocabulary; it is not a fetched resource URL.
const SVG_NAMESPACE = /\bxmlns\s*=\s*(["'])http:\/\/www\.w3\.org\/2000\/svg\1/g;

function parseArgs(argv) {
  const out = { base: process.env.GITHUB_BASE_REF || 'main', files: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') out.base = argv[++i];
    else if (argv[i] === '--files') out.files = argv[++i].split(',').filter(Boolean);
  }
  return out;
}

function getChangedFiles(base) {
  try {
    const out = execFileSync('git', ['diff', '--name-only', `origin/${base}...HEAD`], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    const out = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  }
}

function isCommentLine(line) {
  return /^\s*\/\//.test(line);
}

function scanDemoFile(relPath, violations) {
  const absPath = join(ROOT, relPath);
  if (!existsSync(absPath)) return; // deleted file
  const content = readFileSync(absPath, 'utf8');
  const isRegistry = relPath === 'src/demos/registry.ts' || relPath === 'src/pixi/registry.ts';
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    if (isCommentLine(line)) return;
    for (const { re, message } of BANNED_PATTERNS) {
      if (re.test(line)) {
        violations.push({ file: relPath, line: idx + 1, message });
      }
    }
    if (!isRegistry && URL_LITERAL.test(line.replace(SVG_NAMESPACE, ''))) {
      violations.push({
        file: relPath,
        line: idx + 1,
        message:
          'external URL literal found — demos must bundle everything and make no external references (registry.ts metadata fields are exempt)',
      });
    }
  });
}

function scanReferenceImage(relPath, violations) {
  const absPath = join(ROOT, relPath);
  if (!existsSync(absPath)) return; // deleted file
  const dotIdx = relPath.lastIndexOf('.');
  const ext = dotIdx === -1 ? '' : relPath.slice(dotIdx).toLowerCase();
  if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
    violations.push({
      file: relPath,
      message: `disallowed reference-image extension "${ext || '(none)'}" — only .png/.jpg/.jpeg/.webp are allowed`,
    });
    return;
  }
  const size = statSync(absPath).size;
  if (size > MAX_REFERENCE_IMAGE_BYTES) {
    violations.push({
      file: relPath,
      message: `reference image is ${Math.round(size / 1024)} KB, over the ${MAX_REFERENCE_IMAGE_BYTES / 1024} KB cap`,
    });
  }
}

function checkRegistryFolderCrossReference(violations) {
  const kebabCase = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  const demosDir = join(ROOT, 'src/demos');
  const existingFolders = new Set(
    existsSync(demosDir) ? readdirSync(demosDir).filter((f) => statSync(join(demosDir, f)).isDirectory()) : []
  );
  const registeredIds = new Set();
  for (const registry of ['src/demos/registry.ts', 'src/pixi/registry.ts']) {
    const registryPath = join(ROOT, registry);
    if (!existsSync(registryPath)) continue;
    const content = readFileSync(registryPath, 'utf8');
    const idPattern = /\bid:\s*'([^']+)'/g;
    let match;
    while ((match = idPattern.exec(content)) !== null) {
      const id = match[1];
      if (!kebabCase.test(id)) {
        violations.push({ file: registry, message: `registry id "${id}" is not kebab-case` });
        continue;
      }
      if (registeredIds.has(id)) {
        violations.push({ file: registry, message: `registry id "${id}" is duplicated` });
      }
      registeredIds.add(id);
      if (!existingFolders.has(id)) {
        violations.push({
          file: registry,
          message: `registry id "${id}" has no matching folder under src/demos/${id}/`,
        });
      }
    }
  }
}

function report(violations) {
  if (violations.length === 0) {
    console.log('check-showcase-safety: no violations found.');
    return 0;
  }
  for (const v of violations) {
    const loc = v.line ? `${v.file}:${v.line}` : v.file;
    if (process.env.GITHUB_ACTIONS) {
      const lineAttr = v.line ? `,line=${v.line}` : '';
      console.log(`::error file=${v.file}${lineAttr}::${v.message}`);
    }
    console.error(`FAIL ${loc} — ${v.message}`);
  }
  console.error(`\ncheck-showcase-safety: ${violations.length} violation(s) found.`);
  return 1;
}

function main() {
  const { base, files } = parseArgs(process.argv.slice(2));
  const changed = files ?? getChangedFiles(base);
  const violations = [];

  for (const relPath of changed) {
    const norm = relPath.replace(/\\/g, '/');
    if ((norm.startsWith('src/demos/') || norm.startsWith('src/pixi/')) && norm.endsWith('.ts')) {
      scanDemoFile(norm, violations);
    } else if (norm.startsWith('public/references/')) {
      scanReferenceImage(norm, violations);
    }
  }

  checkRegistryFolderCrossReference(violations);

  process.exit(report(violations));
}

main();
