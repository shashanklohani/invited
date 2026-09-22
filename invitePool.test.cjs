const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rollingPool } = require('./dist/invitePool');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('four workers refill immediately without repeating jobs', async () => {
  const started = [];
  const release = new Map();
  let active = 0;
  let peak = 0;
  const run = rollingPool([0, 1, 2, 3, 4, 5], 4, async id => {
    started.push(id);
    peak = Math.max(peak, ++active);
    await new Promise(resolve => release.set(id, resolve));
    active--;
  });
  assert.deepEqual(started, [0, 1, 2, 3]);
  release.get(1)();
  await tick();
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  assert.equal(active, 4);
  release.get(4)();
  await tick();
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
  for (const resolve of release.values()) resolve();
  await run;
  assert.equal(peak, 4);
  assert.equal(active, 0);
  assert.equal(new Set(started).size, started.length);
});

test('fatal errors stop new work and wait for active workers', async () => {
  const started = [];
  let finish;
  let settled = false;
  const run = rollingPool([0, 1, 2], 2, async id => {
    started.push(id);
    if (id === 0) throw new Error('storage failure');
    await new Promise(resolve => { finish = resolve; });
  });
  const checked = assert.rejects(run, /storage failure/).then(() => { settled = true; });
  await tick();
  assert.equal(settled, false);
  assert.deepEqual(started, [0, 1]);
  finish();
  await checked;
});
