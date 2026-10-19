import { createHash } from 'node:crypto';

export const sourceReleaseRepository = 'img2threejs/img2threejs-showcase';
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const hashPattern = /^[0-9a-f]{64}$/;

/** Canonical archive filename for a showcase id. */
export const sourceArchiveFilename = (id) => `${id}-source.zip`;

function validate(entry, index) {
  if (!entry || typeof entry !== 'object') throw new Error(`Source release entry ${index} must be an object`);
  const { id, filename, bytes, sha256 } = entry;
  if (typeof id !== 'string' || !idPattern.test(id)) throw new Error(`Invalid source release id: ${JSON.stringify(id)}`);
  if (filename !== sourceArchiveFilename(id)) throw new Error(`Invalid source release filename for ${id}: ${JSON.stringify(filename)}`);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`Invalid source release byte size for ${id}: ${bytes}`);
  if (typeof sha256 !== 'string' || !hashPattern.test(sha256)) throw new Error(`Invalid source release sha256 for ${id}: ${JSON.stringify(sha256)}`);
  return { id, filename, bytes, sha256 };
}

/**
 * Build the immutable, content-addressed release manifest. The tag is the SHA-256 of the canonical
 * metadata list, so any changed archive byte yields a new tag and URLs never point at mutable assets.
 */
export function createSourceReleaseManifest(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('Source release requires at least one archive');
  const records = entries.map(validate).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let index = 1; index < records.length; index++) {
    if (records[index].id === records[index - 1].id) throw new Error(`Duplicate source release id: ${records[index].id}`);
  }
  const tag = `showcase-sources-${createHash('sha256').update(JSON.stringify(records)).digest('hex')}`;
  const archives = {};
  for (const record of records) {
    archives[record.id] = {
      filename: record.filename,
      bytes: record.bytes,
      sha256: record.sha256,
      url: `https://github.com/${sourceReleaseRepository}/releases/download/${tag}/${record.filename}`,
    };
  }
  return { schemaVersion: 1, tag, archives };
}
