import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { createServer, type ViteDevServer } from 'vite';
import type { downloadShowcaseSource as DownloadShowcaseSource } from '../src/source-download';

const ID = 'leesin';
const TAG = `showcase-sources-${'a'.repeat(64)}`;
const RELEASE = 'https://github.com/img2threejs/img2threejs-showcase/releases/download';

const globals = globalThis as unknown as Record<string, unknown>;
const originalFetch = globals.fetch;
let server: ViteDevServer;
let downloadShowcaseSource: typeof DownloadShowcaseSource;
let requested: string[];
let catalogResponse: () => Response;

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    filename: `${ID}-source.zip`,
    bytes: 1234,
    sha256: 'b'.repeat(64),
    url: `${RELEASE}/${TAG}/${ID}-source.zip`,
    ...overrides,
  };
}

function catalog(archives: Record<string, unknown>, overrides: Record<string, unknown> = {}): Response {
  return Response.json({ schemaVersion: 1, tag: TAG, archives, ...overrides });
}

// Load the real module through Vite's SSR transform so import.meta.env resolves as in the app;
// DEV is forced off to exercise the production catalog path.
before(async () => {
  server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('..', import.meta.url)),
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false },
    define: { 'import.meta.env.DEV': 'false' },
  });
  const loaded = (await server.ssrLoadModule('/src/source-download.ts')) as { downloadShowcaseSource: typeof DownloadShowcaseSource };
  downloadShowcaseSource = loaded.downloadShowcaseSource;
});

after(async () => {
  await server.close();
});

beforeEach(() => {
  requested = [];
  catalogResponse = () => catalog({ [ID]: entry() });
  globals.fetch = async (input: unknown) => {
    requested.push(String(input));
    return catalogResponse();
  };
});

afterEach(() => {
  globals.fetch = originalFetch;
});

// None of the cases below may reach the anchor handoff: with no `document` in Node, an
// accidental download attempt would surface as a ReferenceError and fail the assertions.

test('rejects non-OK catalog responses', async () => {
  catalogResponse = () => new Response('nope', { status: 503 });
  await assert.rejects(downloadShowcaseSource(ID), /HTTP 503/);
});

test('rejects unparsable catalogs, wrong schema and missing entries', async () => {
  catalogResponse = () => new Response('<html>', { status: 200 });
  await assert.rejects(downloadShowcaseSource(ID), /catalog is unavailable or invalid/);
  catalogResponse = () => catalog({ other: entry() });
  await assert.rejects(downloadShowcaseSource(ID), /No source archive is published/);
  catalogResponse = () => catalog({ [ID]: entry() }, { schemaVersion: 2 });
  await assert.rejects(downloadShowcaseSource(ID), /catalog is unavailable or invalid/);
});

test('rejects tampered catalog metadata instead of following it', async () => {
  const tampered: Array<[string, () => Response]> = [
    ['foreign url', () => catalog({ [ID]: entry({ url: `https://evil.example/${ID}-source.zip` }) })],
    ['wrong tag in url', () => catalog({ [ID]: entry({ url: `${RELEASE}/showcase-sources-${'c'.repeat(64)}/${ID}-source.zip` }) })],
    ['other filename', () => catalog({ [ID]: entry({ filename: 'other-source.zip', url: `${RELEASE}/${TAG}/other-source.zip` }) })],
    ['zero bytes', () => catalog({ [ID]: entry({ bytes: 0 }) })],
    ['fractional bytes', () => catalog({ [ID]: entry({ bytes: 1.5 }) })],
    ['unsafe bytes', () => catalog({ [ID]: entry({ bytes: 2 ** 60 }) })],
    ['uppercase sha', () => catalog({ [ID]: entry({ sha256: 'B'.repeat(64) }) })],
    ['short sha', () => catalog({ [ID]: entry({ sha256: 'b'.repeat(63) }) })],
    ['bad tag', () => catalog({ [ID]: entry() }, { tag: 'latest' })],
  ];
  for (const [label, response] of tampered) {
    catalogResponse = response;
    await assert.rejects(downloadShowcaseSource(ID), /catalog is unavailable or invalid/, label);
  }
});

test('does not download when aborted after catalog response but before handoff', async () => {
  const controller = new AbortController();
  globals.fetch = async () => {
    controller.abort();
    return catalog({ [ID]: entry() });
  };
  await assert.rejects(downloadShowcaseSource(ID, controller.signal), (error: unknown) => (error as Error).name === 'AbortError');
});

test('rejects unknown showcase ids without network', async () => {
  for (const id of ['not-a-showcase', '../etc/passwd']) {
    await assert.rejects(downloadShowcaseSource(id), /Unknown Three\.js showcase/);
  }
  assert.equal(requested.length, 0);
});
