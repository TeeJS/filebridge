'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStatusWriter, SCHEMA } = require('../status');

function setup(snap) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-status-'));
  const file = path.join(dir, 'status.json');
  let clock = 1_000_000;
  let calls = 0;
  const w = createStatusWriter({
    file, now: () => clock, minIntervalMs: 1000, heartbeatMs: 30000,
    snapshot: () => { calls++; return typeof snap === 'function' ? snap() : (snap || { current: null }); },
  });
  return { w, file, dir, read: () => JSON.parse(fs.readFileSync(file, 'utf8')), tick: ms => { clock += ms; }, calls: () => calls };
}

test('writes the v1 envelope: schema, running, heartbeat, snapshot fields', () => {
  const { w, read } = setup({ paused: true, jobs: [{ id: 'a' }] });
  w.writeNow();
  const s = read();
  assert.equal(s.schema, SCHEMA);
  assert.equal(s.running, true);
  assert.equal(s.paused, true);
  assert.deepEqual(s.jobs, [{ id: 'a' }]);
  assert.equal(s.heartbeatAt, new Date(1_000_000).toISOString());
});

test('touch() writes at most once per interval and folds a burst into one trailing write', async () => {
  const { w, tick, calls } = setup();
  w.touch();                 // immediate
  assert.equal(calls(), 1);
  w.touch(); w.touch();      // within the window: one trailing write scheduled
  assert.equal(calls(), 1);
  tick(1000);
  await new Promise(r => setTimeout(r, 1100));
  assert.equal(calls(), 2);
  w.stop();
});

test('atomic: no temp file left behind, and a reader never sees partial JSON', () => {
  const { w, file, dir, read } = setup({ big: 'x'.repeat(200000) });
  for (let i = 0; i < 5; i++) w.writeNow();
  assert.equal(read().big.length, 200000);
  assert.deepEqual(fs.readdirSync(dir), [path.basename(file)]);
});

test('stop() writes running:false with no current run or queue', () => {
  const { w, read } = setup({ current: { name: 'x' }, queue: ['y'] });
  w.start();
  assert.equal(read().running, true);
  w.stop();
  const s = read();
  assert.equal(s.running, false);
  assert.equal(s.current, null);
  assert.deepEqual(s.queue, []);
});

test('a failing snapshot never throws, and is reported once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-status-'));
  const errors = [];
  const w = createStatusWriter({ file: path.join(dir, 'status.json'), snapshot: () => { throw new Error('boom'); }, onError: e => errors.push(e) });
  assert.doesNotThrow(() => { w.writeNow(); w.writeNow(); });
  assert.equal(errors.length, 1);
});

test('nothing can overwrite running:false after stop()', async () => {
  const { w, read, tick } = setup({ current: { name: 'x' } });
  w.start();
  w.stop();
  tick(5000);
  w.touch(); w.writeNow();
  await new Promise(r => setTimeout(r, 50));
  assert.equal(read().running, false);
});

test('a reader holding the file open only delays the write (Windows EPERM retry)', () => {
  const { w, file, read } = setup({ n: 1 });
  w.writeNow();
  const realRename = fs.renameSync;
  let failures = 2;
  fs.renameSync = (a, b) => { if (failures-- > 0) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; } return realRename(a, b); };
  try { w.writeNow(); } finally { fs.renameSync = realRename; }
  assert.ok(fs.existsSync(file));
  assert.equal(read().n, 1);
  assert.equal(failures, -1, 'retried until the rename went through');
});
