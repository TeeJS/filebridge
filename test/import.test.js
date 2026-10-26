'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findImport, runImport, followUp, heldJobs, runsInProgress } = require('../import');

function setup({ legacy = false, jobs = 2, log = 'old line\n' } = {}) {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-import-'));
  const from = legacy ? path.join(appData, 'Bedrock Panel', 'file-bridge') : path.join(appData, 'bedrock-panel', 'file-bridge');
  const dataDir = path.join(appData, 'FileBridge');
  fs.mkdirSync(path.join(from, 'rules'), { recursive: true });
  const cfg = { jobs: Array.from({ length: jobs }, (_, i) => ({ id: 'j' + i, name: 'Job ' + i, stats: { runs: 7 } })), grand: { runs: 42, copied: 100 } };
  fs.writeFileSync(path.join(from, 'jobs.json'), JSON.stringify(cfg));
  fs.writeFileSync(path.join(from, 'filters.json'), '{"groups":[{"id":"g","name":"x","wildcards":["*.log"]}]}');
  fs.writeFileSync(path.join(from, 'rules', 'site.json'), '{"site":"site"}');
  fs.writeFileSync(path.join(from, 'seen-j1.json'), JSON.stringify({ collections: { a: 1 }, items: { x: 1 } }));
  fs.writeFileSync(path.join(from, 'result-j0.json'), '{"ok":true}');
  fs.writeFileSync(path.join(from, 'log.txt'), log);
  fs.writeFileSync(path.join(from, 'jobs.json.tmp'), 'half');
  return { appData, from, dataDir, cfg };
}
const NOW = new Date(2026, 9, 26, 15, 4, 5);
const later = (ms) => NOW.getTime() + ms;
const readJ = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const touchLater = (f, ms) => { const t = new Date(Date.now() + ms); fs.utimesSync(f, t, t); };

test('offers the import only when the drop-in has jobs and this app has none', () => {
  const { appData, dataDir, from } = setup();
  const o = findImport({ appData, dataDir });
  assert.equal(o.from, from);
  assert.equal(o.jobs, 2);
  assert.ok(o.lastActivity, 'says when the drop-in last wrote');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'jobs.json'), '{"jobs":[]}');
  assert.ok(findImport({ appData, dataDir }), 'an empty jobs.json still counts as no jobs');
  fs.writeFileSync(path.join(dataDir, 'jobs.json'), '{"jobs":[{"id":"mine"}]}');
  assert.equal(findImport({ appData, dataDir }), null);
});

test('with both folders holding jobs, the most recently written one is offered', () => {
  const { appData, dataDir } = setup();
  const legacy = path.join(appData, 'Bedrock Panel', 'file-bridge');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'jobs.json'), '{"jobs":[{"id":"l"}]}');
  touchLater(path.join(legacy, 'jobs.json'), 60000);
  assert.equal(findImport({ appData, dataDir }).from, legacy);
});

test('no jobs, or a corrupt jobs.json, in the drop-in -> nothing to offer', () => {
  const a = setup({ jobs: 0 });
  assert.equal(findImport({ appData: a.appData, dataDir: a.dataDir }), null);
  assert.throws(() => runImport({ appData: a.appData, dataDir: a.dataDir }), /nothing to import/);
  const b = setup();
  fs.writeFileSync(path.join(b.from, 'jobs.json'), '{"jobs":[{"id":"x"}],');
  assert.equal(findImport({ appData: b.appData, dataDir: b.dataDir }), null);
});

test('import: jobs move (waiting for their next slot), every other file copies, nothing in the drop-in is deleted', () => {
  const { appData, dataDir, from, cfg } = setup();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'log.txt'), 'new line\n');
  fs.writeFileSync(path.join(dataDir, 'status.json'), '{"mine":true}');
  const r = runImport({ appData, dataDir, now: NOW });
  assert.equal(r.jobs, 2);
  const got = readJ(path.join(dataDir, 'jobs.json'));
  assert.deepEqual(got.grand, cfg.grand, 'grand totals intact');
  assert.equal(got.jobs[0].stats.runs, 7, 'stats intact');
  assert.ok(got.jobs.every(j => j.lastSkippedDue === NOW.getTime()), 'each job waits for its next scheduled time');
  for (const f of ['filters.json', path.join('rules', 'site.json'), 'seen-j1.json', 'result-j0.json']) assert.ok(fs.existsSync(path.join(dataDir, f)), f + ' copied');
  assert.equal(fs.readFileSync(path.join(dataDir, 'log.txt'), 'utf8'), 'old line\nnew line\n', 'logs joined, old first');
  assert.deepEqual(readJ(path.join(dataDir, 'status.json')), { mine: true }, 'own status untouched');
  assert.ok(!fs.existsSync(path.join(dataDir, 'jobs.json.tmp')), 'temp files not copied');
  assert.ok(!fs.existsSync(path.join(from, 'jobs.json')), 'the drop-in has no jobs.json any more');
  assert.equal(r.renamedTo, path.join(from, 'jobs.migrated-20261026-150405.json'));
  assert.deepEqual(readJ(r.renamedTo), cfg);
  for (const f of ['filters.json', 'seen-j1.json', 'log.txt', path.join('rules', 'site.json')]) assert.ok(fs.existsSync(path.join(from, f)), f + ' left in place');
  assert.equal(findImport({ appData, dataDir }), null, 'not offered again');
});

test('files this app already had are kept as .pre-import copies, identical ones are left alone', () => {
  const { appData, dataDir } = setup();
  fs.mkdirSync(path.join(dataDir, 'rules'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'filters.json'), '{"groups":[]}');
  fs.writeFileSync(path.join(dataDir, 'rules', 'site.json'), '{"site":"site"}');
  runImport({ appData, dataDir, now: NOW });
  assert.equal(fs.readFileSync(path.join(dataDir, 'filters.json.pre-import-20261026-150405'), 'utf8'), '{"groups":[]}');
  assert.ok(!fs.existsSync(path.join(dataDir, 'rules', 'site.json.pre-import-20261026-150405')));
});

test('a junctioned rules folder is followed, not skipped', () => {
  const { appData, dataDir, from } = setup();
  const elsewhere = path.join(appData, 'my-rules');
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, 'linked.json'), '{"site":"linked"}');
  fs.rmSync(path.join(from, 'rules'), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(from, 'rules'), 'junction');
  runImport({ appData, dataDir, now: NOW });
  assert.ok(fs.existsSync(path.join(dataDir, 'rules', 'linked.json')));
});

test('if writing the new jobs.json fails, the drop-in gets its jobs back and a retry does not double the log', () => {
  const { appData, dataDir, from } = setup();
  fs.mkdirSync(path.join(dataDir, 'jobs.json.tmp'), { recursive: true }); // a directory where the temp file must go
  assert.throws(() => runImport({ appData, dataDir, now: NOW }));
  assert.ok(fs.existsSync(path.join(from, 'jobs.json')), 'jobs.json handed back');
  assert.ok(!fs.existsSync(path.join(dataDir, 'jobs.json')));
  fs.rmSync(path.join(dataDir, 'jobs.json.tmp'), { recursive: true });
  runImport({ appData, dataDir, now: NOW });
  assert.equal(fs.readFileSync(path.join(dataDir, 'log.txt'), 'utf8'), 'old line\n');
});

test('runsInProgress: unanswered scheduled runs, minus finished and stopped ones', () => {
  const log = [
    '[x] schedule due: A', '[x] run A (schedule): copied 1',
    '[x] schedule due: B', '[x] schedule due: C', '[x] preview D (manual): would copy 0',
  ].join('\n');
  assert.deepEqual([...runsInProgress(log)].sort(), ['B', 'C'], 'every unanswered due line counts (holding too much is the safe side)');
  assert.deepEqual([...runsInProgress('[x] schedule due: A\n[x] run A (schedule): FAILED — x')], []);
  assert.deepEqual([...runsInProgress('[x] schedule due: A\n[x] schedule due: B\n[x] stop all: cleared the run queue')], [], 'stop all clears them');
});

test('runsInProgress: with the summary log off, a newer result file closes the due line', () => {
  const t = new Date(2026, 9, 26, 10, 0, 0);
  const log = `[${t.toLocaleString()}] schedule due: A\n[${t.toLocaleString()}] schedule due: B`;
  const results = { A: t.getTime() + 60000, B: t.getTime() - 60000 };
  assert.deepEqual([...runsInProgress(log, n => results[n] || 0)], ['B']);
});

// A held-job import: the drop-in's log has an unanswered "schedule due" for Job 0.
function heldSetup() {
  const t = new Date(Date.now() - 60000);
  const s = setup({ log: `[${t.toLocaleString()}] schedule due: Job 0\n` });
  const old = new Date(Date.now() - 3600000);
  fs.utimesSync(path.join(s.from, 'result-j0.json'), old, old); // its last result predates the due line
  return s;
}

test('a job whose scheduled run was still going in Bedrock Panel is held until its result appears', () => {
  const { appData, dataDir, from } = heldSetup();
  const r = runImport({ appData, dataDir, now: NOW });
  assert.deepEqual(r.held, ['Job 0']);
  assert.ok(heldJobs(dataDir).has('j0'));
  assert.deepEqual(followUp({ dataDir, nowMs: later(60000), mergeLate: () => {} }), [], 'still held, nothing happened');
  assert.ok(heldJobs(dataDir).has('j0'));
  touchLater(path.join(from, 'result-j0.json'), 5000); // the drop-in finished the run
  const did = followUp({ dataDir, nowMs: later(120000), mergeLate: () => {} });
  assert.ok(did.some(l => /Job 0" finished/.test(l)));
  assert.equal(heldJobs(dataDir).size, 0);
});

test('follow-up: a late run that saved into a job-less jobs.json adds its totals as-is; its ledger is merged', () => {
  const { appData, dataDir, from } = setup();
  runImport({ appData, dataDir, now: NOW });
  // the drop-in's in-flight run ends: loadCfg() found no jobs.json, so its grand starts at zero
  fs.writeFileSync(path.join(from, 'jobs.json'), JSON.stringify({ jobs: [], grand: { since: 'x', runs: 1, copied: 5, foldersCreated: 2 } }));
  fs.writeFileSync(path.join(from, 'seen-j1.json'), JSON.stringify({ collections: { a: 1, b: 2 }, items: { x: 1, y: 2 } }));
  touchLater(path.join(from, 'seen-j1.json'), 5000);
  const cfg = readJ(path.join(dataDir, 'jobs.json'));
  let late = null;
  followUp({ dataDir, nowMs: later(60000), mergeLate: l => { late = l; } });
  require('../import').applyLate(cfg, late, later(60000));
  assert.deepEqual(cfg.grand, { runs: 43, copied: 105, foldersCreated: 2, since: 'x' }, 'added, never subtracted');
  assert.ok(!fs.existsSync(path.join(from, 'jobs.json')), 'set aside');
  assert.deepEqual(readJ(path.join(dataDir, 'seen-j1.json')).items, { x: 1, y: 2 }, 'ledger merged');
  late = null;
  followUp({ dataDir, nowMs: later(90000), mergeLate: l => { late = l; } });
  assert.equal(late, null, 'not counted twice');
});

test('a drop-in run that finishes DURING the import still reaches the grand totals', () => {
  const { appData, dataDir, from } = setup();
  const orig = fs.copyFileSync;
  let fired = false;
  fs.copyFileSync = function (...a) {
    if (!fired) { fired = true; fs.writeFileSync(path.join(from, 'jobs.json'), JSON.stringify({ jobs: [], grand: { runs: 1, copied: 2 } })); }
    return orig.apply(this, a);
  };
  try { runImport({ appData, dataDir, now: NOW }); } finally { fs.copyFileSync = orig; }
  assert.deepEqual(readJ(path.join(dataDir, 'jobs.json')).grand, { runs: 43, copied: 102 });
  assert.ok(!fs.existsSync(path.join(from, 'jobs.json')));
});

test('follow-up: a jobs.json back WITH jobs gives up newer run results and new jobs, then is renamed away again', () => {
  const { appData, dataDir, from, cfg } = setup();
  runImport({ appData, dataDir, now: NOW });
  const revived = JSON.parse(JSON.stringify(cfg));
  revived.jobs[0].lastRun = { at: '2026-10-26T23:00:00.000Z', ok: true, copied: 3 };
  revived.jobs[0].stats = { runs: 8 };
  revived.jobs.push({ id: 'jnew', name: 'Added later' });
  revived.grand = { runs: 43, copied: 103 };
  fs.writeFileSync(path.join(from, 'jobs.json'), JSON.stringify(revived));
  const ours = readJ(path.join(dataDir, 'jobs.json'));
  let late = null;
  const did = followUp({ dataDir, nowMs: later(60000), mergeLate: l => { late = l; } });
  require('../import').applyLate(ours, late, later(60000));
  assert.ok(did.some(l => /came back/.test(l)));
  assert.equal(ours.jobs.find(j => j.id === 'j0').stats.runs, 8, 'newer bookkeeping taken');
  assert.ok(ours.jobs.find(j => j.id === 'jnew').lastSkippedDue, 'a job added there is imported, waiting for its slot');
  assert.deepEqual(ours.grand, { runs: 43, copied: 103 }, 'only the growth since the import is added');
  assert.ok(!fs.existsSync(path.join(from, 'jobs.json')));
  assert.equal(fs.readdirSync(from).filter(f => /-again\.json$/.test(f)).length, 1);
});

test('a failed import after a late job-less save still hands the jobs back, with that run counted', () => {
  const { appData, dataDir, from } = setup();
  fs.mkdirSync(path.join(dataDir, 'jobs.json.tmp'), { recursive: true }); // makes the final write fail
  const orig = fs.copyFileSync;
  let fired = false;
  fs.copyFileSync = function (...a) {
    if (!fired) { fired = true; fs.writeFileSync(path.join(from, 'jobs.json'), JSON.stringify({ jobs: [], grand: { runs: 1, copied: 2 } })); }
    return orig.apply(this, a);
  };
  try { assert.throws(() => runImport({ appData, dataDir, now: NOW })); } finally { fs.copyFileSync = orig; }
  const back = readJ(path.join(from, 'jobs.json'));
  assert.equal(back.jobs.length, 2, 'Bedrock Panel has its jobs again');
  assert.deepEqual(back.grand, { runs: 43, copied: 102 });
  assert.ok(findImport({ appData, dataDir }), 'and the import is offered again');
});

test('follow-up stops after 24 hours', () => {
  const { appData, dataDir } = setup();
  runImport({ appData, dataDir, now: NOW });
  assert.equal(followUp({ dataDir, nowMs: later(25 * 3600 * 1000), mergeLate: () => {} }), null);
});
