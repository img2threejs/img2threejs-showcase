import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { demosFromRegistry } from './demos-json.mjs';

const entry = (id, updatedAt, status = 'final') => `{
    id: '${id}',
    title: 'Demo ${id}',
    subjectClass: 'object',
    status: '${status}',
    generatedWith: 'img2threejs v1.5.2 \\u00b7 test',
    updatedAt: '${updatedAt}',
    sourcePath: 'src/demos/${id}/create.ts',
    sourceUrl: REPO + '/src/demos/${id}/create.ts',
    loadRuntime: async () => ({}),
  }`;
const registry = (...entries) => `const BASE = import.meta.env.BASE_URL;\nconst authored: CatalogEntry[] = [\n  ${entries.join(',\n  ')},\n];\n`;

test('lists every authored demo newest first with resolved urls', () => {
  const demos = demosFromRegistry(registry(entry('old', '2026-01-01'), entry('new', '2026-02-01', 'placeholder')));
  assert.deepEqual(demos.map((d) => d.id), ['new', 'old']);
  assert.equal(demos[0].status, 'placeholder');
  assert.equal(demos[0].url, 'https://img2threejs.io/#/demo/new');
  assert.equal(demos[0].sourceUrl, 'https://github.com/img2threejs/img2threejs-showcase/blob/main/src/demos/new/create.ts');
  assert.equal(demos[0].generatedWith, 'img2threejs v1.5.2 · test');
  assert.equal(demos[0].version, 'v1.5.2');
});

test('joins literals wrapped with +', () => {
  const wrapped = registry(entry('w', '2026-01-01').replace("title: 'Demo w'", "title:\n      'Demo '\n      + 'w'"));
  assert.equal(demosFromRegistry(wrapped)[0].title, 'Demo w');
});

test('fails loud when a field is not a string literal', () => {
  const bad = registry(entry('x', '2026-01-01').replace("title: 'Demo x'", 'title: TITLE'));
  assert.throws(() => demosFromRegistry(bad), /`title` must be a string literal/);
});

test('the real registry parses', async () => {
  const demos = demosFromRegistry(await readFile(new URL('../src/demos/registry.ts', import.meta.url), 'utf8'));
  assert.ok(demos.length > 0);
  for (const demo of demos) assert.match(demo.updatedAt, /^\d{4}-\d{2}-\d{2}$/);
});
