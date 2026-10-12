import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPhysicsModule } from './load-physics.mjs';

const { createEntrySteams } = await loadPhysicsModule('entrySteam');

test('reused and cancelled steam slots age from their new contact, not the previous plume', () => {
  const pool = createEntrySteams(2);
  const [steam, neighbour] = pool.steams;
  const lifecycle = () => {
    steam.begin(6, 0, 1, 0.72);
    return [0.2, 0.6, 10].map(age => {
      steam.tick(age, 1);
      return { visible: steam.group.visible, finished: steam.finished };
    });
  };
  try {
    neighbour.begin(8, 0, 2, 0.72);
    neighbour.tick(0.2, 1);
    const first = lifecycle();
    assert.equal(first[0].visible, true, 'a fresh hot contact must produce vapor');
    assert.deepEqual(first.at(-1), { visible: false, finished: true }, 'a cooled plume must release its slot');
    assert.deepEqual(lifecycle(), first, 'natural retirement must not carry age into the next contact');
    steam.begin(6, 0, 1, 0.72);
    steam.tick(0.6, 1);
    steam.hide();
    steam.tick(0.7, 1);
    assert.equal(steam.group.visible, false, 'cancelled vapor must not resume on later ticks');
    assert.equal(steam.finished, true);
    assert.equal(neighbour.group.visible, true, 'cancelling one plume must not cancel its neighbour');
    assert.deepEqual(lifecycle(), first, 'cancellation must also reset contact-relative lifetime');
  } finally {
    pool.dispose();
  }
});
