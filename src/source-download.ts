import { getDemo } from './demos/registry';

/**
 * Showcase source archives are hosted as content-addressed GitHub Release assets. The deployed
 * site only carries `source/index.json`; this module validates the entry for the requested
 * showcase and hands the exact release URL to the browser as a native download. The ZIP is never
 * fetched, buffered or re-wrapped here (the release blob host does not send CORS headers).
 */
const RELEASE_BASE_URL = 'https://github.com/img2threejs/img2threejs-showcase/releases/download';
const TAG_PATTERN = /^showcase-sources-[a-f0-9]{64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CATALOG_HINT = 'The source catalog is unavailable or invalid. Please try again after the site has finished deploying.';

export interface ShowcaseSourceDownload {
  filename: string;
  /** Archive size from the release manifest; unknown for the dev same-origin download. */
  bytes?: number;
}

function validateEntry(id: string, manifest: unknown): Required<ShowcaseSourceDownload> & { url: string } {
  if (typeof manifest !== 'object' || manifest === null) throw new Error(CATALOG_HINT);
  const { schemaVersion, tag, archives } = manifest as Record<string, unknown>;
  if (schemaVersion !== 1 || typeof tag !== 'string' || !TAG_PATTERN.test(tag)) throw new Error(CATALOG_HINT);
  if (typeof archives !== 'object' || archives === null) throw new Error(CATALOG_HINT);
  if (!Object.prototype.hasOwnProperty.call(archives, id)) {
    throw new Error(`No source archive is published for showcase "${id}".`);
  }
  const entry = (archives as Record<string, unknown>)[id];
  if (typeof entry !== 'object' || entry === null) throw new Error(CATALOG_HINT);
  const { filename, bytes, sha256, url } = entry as Record<string, unknown>;
  const expectedFilename = `${id}-source.zip`;
  if (
    filename !== expectedFilename ||
    typeof bytes !== 'number' ||
    !Number.isSafeInteger(bytes) ||
    bytes <= 0 ||
    typeof sha256 !== 'string' ||
    !SHA256_PATTERN.test(sha256) ||
    url !== `${RELEASE_BASE_URL}/${tag}/${expectedFilename}`
  ) {
    throw new Error(CATALOG_HINT);
  }
  return { filename: expectedFilename, bytes, url };
}

function startNativeDownload(url: string, filename: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
  }
}

/**
 * Starts a browser-native download of the showcase's source archive. Resolves once the download
 * has been handed to the browser; transfer completion is not observable from here.
 */
export async function downloadShowcaseSource(id: string, signal?: AbortSignal): Promise<ShowcaseSourceDownload> {
  if (!getDemo(id)) throw new Error(`Unknown Three.js showcase: ${id}`);
  const baseUrl = import.meta.env.BASE_URL;

  if (import.meta.env.DEV) {
    // The dev server generates archives on demand through the existing /source/<id>.zip middleware.
    signal?.throwIfAborted();
    startNativeDownload(`${baseUrl}source/${encodeURIComponent(id)}.zip`, `${id}-source.zip`);
    return { filename: `${id}-source.zip` };
  }

  const response = await fetch(`${baseUrl}source/index.json`, { signal });
  if (!response.ok) throw new Error(`Source catalog request failed (HTTP ${response.status}). Please try again.`);
  let manifest: unknown;
  try {
    manifest = await response.json();
  } catch {
    throw new Error(CATALOG_HINT);
  }
  const entry = validateEntry(id, manifest);
  signal?.throwIfAborted();
  startNativeDownload(entry.url, entry.filename);
  return { filename: entry.filename, bytes: entry.bytes };
}
