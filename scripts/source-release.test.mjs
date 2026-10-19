import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSourceReleaseManifest } from './source-release.mjs';

const digest = (text) => createHash('sha256').update(text).digest('hex');
const record = (id, content = id) => ({ id, filename: `${id}-source.zip`, bytes: content.length + 1, sha256: digest(content) });
const base = () => [record('beta'), record('alpha'), record('gamma-2')];

test('manifest is independent of input order and metadata property order', () => {
  const forward = createSourceReleaseManifest(base());
  const shuffled = createSourceReleaseManifest(base().reverse().map(({ sha256, bytes, filename, id }) => ({ sha256, bytes, filename, id })));
  assert.equal(JSON.stringify(shuffled), JSON.stringify(forward));
  assert.deepEqual(Object.keys(forward.archives), ['alpha', 'beta', 'gamma-2']);
  assert.equal(forward.schemaVersion, 1);
});

test('a changed archive digest or size produces a new immutable tag', () => {
  const original = createSourceReleaseManifest(base());
  const changedDigest = base();
  changedDigest[1].sha256 = digest('changed archive bytes');
  const changedBytes = base();
  changedBytes[0].bytes += 1;
  const tags = new Set([original.tag, createSourceReleaseManifest(changedDigest).tag, createSourceReleaseManifest(changedBytes).tag]);
  assert.equal(tags.size, 3);
});

test('invalid, duplicate, traversal and empty metadata is rejected', () => {
  assert.throws(() => createSourceReleaseManifest([]), /at least one/);
  assert.throws(() => createSourceReleaseManifest(null), /at least one/);
  assert.throws(() => createSourceReleaseManifest([...base(), record('alpha')]), /Duplicate/);
  for (const id of ['../escape', 'a/b', 'Upper', 'under_score', '-lead', 'trail-', 'a--b', '']) {
    assert.throws(() => createSourceReleaseManifest([{ ...record('ok'), id, filename: `${id}-source.zip` }]), /Invalid source release id/, id);
  }
  for (const filename of ['../alpha-source.zip', 'alpha.zip', 'nested/alpha-source.zip', 'ALPHA-source.zip', undefined]) {
    assert.throws(() => createSourceReleaseManifest([{ ...record('alpha'), filename }]), /filename/, String(filename));
  }
  for (const bytes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '10', NaN]) {
    assert.throws(() => createSourceReleaseManifest([{ ...record('alpha'), bytes }]), /byte size/, String(bytes));
  }
  for (const sha256 of ['', 'A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), undefined]) {
    assert.throws(() => createSourceReleaseManifest([{ ...record('alpha'), sha256 }]), /sha256/, String(sha256));
  }
});
