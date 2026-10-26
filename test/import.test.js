'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findImport, runImport } = require('../import');

function setup({ legacy = false, jobs = 2 } = {}) {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-import-'));
  const from = legacy ? path.join(appData, 'Bedrock Panel', 'file-bridge') : path.join(appData, 'bedrock-panel', 'file-bridge');
  const dataDir = path.join(appData, 'FileBridge');
  fs.mkdirSync(path.join(from, 'rules'), { recursive: true });
  const cfg = { jobs: Array.from({ length: jobs }, (_, i) => ({ id: 'j' + i, name: 'Job ' + i, stats: { runs: 7 } })), grand: { runs: 42 } };
  fs.writeFileSync(path.join(from, 'jobs.json'), JSON.stringify(cfg));
  fs.writeFileSync(path.join(from, 'filters.json'), '{"groups":[{"id":"g","name":"x","wildcards":["*.log"]}]}');
  fs.writeFileSync(path.join(from, 'rules', 'site.json'), '{"site":"site"}');
  fs.writeFileSync(path.join(from, 'seen-j1.json'), '{"seen":["a"]}');
  fs.writeFileSync(path.join(from, 'result-j0.json'), '{"ok":true}');
  fs.writeFileSync(path.join(from, 'log.txt'), 'old line\n');
  fs.writeFileSync(path.join(from, 'jobs.json.tmp'), 'half');
  return { appData, from, dataDir, cfg };
}
const NOW = new Date(2026, 9, 26, 15, 4, 5);

test('offers the import only when the drop-in has jobs and this app has none', () => {
  const { appData, dataDir, from } = setup();
  assert.deepEqual(findImport({ appData, dataDir }), { from, jobs: 2 });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'jobs.json'), '{"jobs":[]}');
  assert.ok(findImport({ appData, dataDir }), 'an empty jobs.json still counts as no jobs');
  fs.writeFileSync(path.join(dataDir, 'jobs.json'), '{"jobs":[{"id":"mine"}]}');
  assert.equal(findImport({ appData, dataDir }), null);
});

test('finds the pre-0.9.2 "Bedrock Panel" folder too', () => {
  const { appData, dataDir, from } = setup({ legacy: true });
  assert.equal(findImport({ appData, dataDir }).from, from);
});

test('no jobs in the drop-in -> nothing to offer', () => {
  const { appData, dataDir } = setup({ jobs: 0 });
  assert.equal(findImport({ appData, dataDir }), null);
  assert.throws(() => runImport({ appData, dataDir }), /nothing to import/);
});

test('import moves the jobs and copies every other file; the drop-in keeps its folder but no jobs.json', () => {
  const { appData, dataDir, from, cfg } = setup();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'log.txt'), 'new line\n');
  fs.writeFileSync(path.join(dataDir, 'status.json'), '{"mine":true}');
  const r = runImport({ appData, dataDir, now: NOW });
  assert.equal(r.jobs, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'jobs.json'), 'utf8')), cfg, 'jobs, stats and grand totals intact');
  for (const f of ['filters.json', path.join('rules', 'site.json'), 'seen-j1.json', 'result-j0.json']) {
    assert.ok(fs.existsSync(path.join(dataDir, f)), f + ' copied');
  }
  assert.equal(fs.readFileSync(path.join(dataDir, 'log.txt'), 'utf8'), 'old line\nnew line\n', 'logs joined, old first');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'status.json'), 'utf8')), { mine: true }, 'own status untouched');
  assert.ok(!fs.existsSync(path.join(dataDir, 'jobs.json.tmp')), 'temp files not copied');
  // the single-scheduler guarantee: the drop-in has no jobs.json any more, but nothing was deleted
  assert.ok(!fs.existsSync(path.join(from, 'jobs.json')));
  assert.equal(r.renamedTo, path.join(from, 'jobs.migrated-20261026-150405.json'));
  assert.deepEqual(JSON.parse(fs.readFileSync(r.renamedTo, 'utf8')), cfg);
  for (const f of ['filters.json', 'seen-j1.json', 'log.txt']) assert.ok(fs.existsSync(path.join(from, f)), f + ' left in place');
  assert.equal(findImport({ appData, dataDir }), null, 'not offered again');
});

test('a corrupt drop-in jobs.json is refused before anything is touched', () => {
  const { appData, dataDir, from } = setup();
  fs.writeFileSync(path.join(from, 'jobs.json'), '{"jobs":[{"id":"x"}],');
  assert.equal(findImport({ appData, dataDir }), null, 'unreadable = not offered');
});

test('if writing the new jobs.json fails, the drop-in gets its jobs back', () => {
  const { appData, dataDir, from } = setup();
  fs.mkdirSync(path.join(dataDir, 'jobs.json.tmp'), { recursive: true }); // a directory where the temp file must go
  assert.throws(() => runImport({ appData, dataDir, now: NOW }));
  assert.ok(fs.existsSync(path.join(from, 'jobs.json')), 'jobs.json restored');
  assert.ok(!fs.existsSync(path.join(dataDir, 'jobs.json')));
});
