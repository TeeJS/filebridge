'use strict';
// One-time import from the Bedrock Panel FileBridge drop-in (%APPDATA%\bedrock-panel\file-bridge,
// or the pre-0.9.2 "Bedrock Panel\file-bridge") into this app's data folder.
//
// Single-scheduler guarantee. The drop-in reads its jobs from its own jobs.json on every tick:
// - runImport RENAMES that file (jobs.migrated-<stamp>.json) FIRST and only then reads it, so
//   the drop-in schedules nothing more and the new app gets the latest copy, at no instant do
//   both apps hold the jobs.
// - Every imported job waits for its NEXT scheduled time (lastSkippedDue = import time), so a
//   stale lastRun can't make the new app re-run a job the drop-in just ran.
// - A scheduled run still IN PROGRESS in the drop-in (its log says "schedule due: X" with no
//   finish line yet) can't be stopped from here: that job is HELD in the new app (no schedule,
//   no manual run) until the drop-in writes the run's result, or for HOLD_MAX_MS at most.
// - For FOLLOW_UP_MS afterwards, followUp() (called from the scheduler tick) watches the old
//   folder: a jobs.json that reappears WITH jobs is renamed away again; one that reappears with
//   no jobs (a run that finished after the import) has its grand-total delta folded in; seen-
//   ledgers the drop-in still writes are merged; newer run results are copied.
// Nothing is deleted: the old folder and every file in it stay (renamed at most).

const fs = require('fs');
const path = require('path');

const FOLLOW_UP_MS = 24 * 3600 * 1000;
const HOLD_MAX_MS = 24 * 3600 * 1000;
const RECORD = 'import.json';

// Never carried over: this app's own feed, sign-in and import record, half-written temp
// files, and the log (joined separately once the import has succeeded).
const SKIP = new Set(['jobs.json', 'status.json', 'oauth.json', RECORD, 'log.txt']);
const skipName = name => SKIP.has(name.toLowerCase()) || /\.tmp$/i.test(name);

function panelDataDirs(appData) {
  return [path.join(appData, 'bedrock-panel', 'file-bridge'), path.join(appData, 'Bedrock Panel', 'file-bridge')];
}

// -1 = missing/unreadable, else the number of jobs.
function countJobs(file) {
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return cfg && Array.isArray(cfg.jobs) ? cfg.jobs.length : 0;
  } catch { return -1; }
}
const mtime = f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };

// Newest write to the drop-in's folder — shown in the offer so the user can tell whether
// Bedrock Panel's FileBridge looks busy.
function lastActivity(dir) {
  let t = 0;
  try { for (const f of fs.readdirSync(dir)) t = Math.max(t, mtime(path.join(dir, f))); } catch {}
  return t ? new Date(t).toISOString() : null;
}

// What the app offers on its main screen: only while this app has no jobs of its own and a
// drop-in folder still holds some. With both folders holding jobs, the one written most
// recently is the live one (the drop-in picks its folder once, at load).
function findImport({ appData, dataDir }) {
  if (countJobs(path.join(dataDir, 'jobs.json')) > 0) return null;
  let best = null;
  for (const from of panelDataDirs(appData)) {
    const f = path.join(from, 'jobs.json');
    const n = countJobs(f);
    if (n > 0 && (!best || mtime(f) > best.m)) best = { from, jobs: n, m: mtime(f) };
  }
  return best && { from: best.from, jobs: best.jobs, lastActivity: lastActivity(best.from) };
}

function stamp(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function sameContent(a, b) {
  try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; }
}

// Copy the drop-in folder (links and junctions followed, loops refused). A file this app
// already has with different content is kept as <name>.pre-import-<stamp> first.
function copyTree(src, dst, tag, copied, seen = new Set()) {
  const real = fs.realpathSync(src);
  if (seen.has(real)) return;
  seen.add(real);
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (skipName(name)) continue;
    const s = path.join(src, name), d = path.join(dst, name);
    let st;
    try { st = fs.statSync(s); } catch { continue; } // a dangling link
    if (st.isDirectory()) { copyTree(s, d, tag, copied, seen); continue; }
    if (!st.isFile()) continue;
    if (fs.existsSync(d)) {
      if (sameContent(s, d)) continue;
      fs.renameSync(d, `${d}.pre-import-${tag}`);
    }
    fs.copyFileSync(s, d);
    copied.push(d);
  }
}

// The scheduled run the drop-in had started but not finished when its log was last written.
// Its log has "schedule due: NAME" when a run is queued and "run NAME (...): ..." when it ends;
// it runs ONE job at a time in queue order, so of the unfinished ones only the OLDEST can be
// running — the rest were merely queued, and the rename already cancelled them (its pump skips
// jobs it can no longer find). Manual runs are not logged at start, which is why the offer also
// asks the user to check.
function runsInProgress(logText) {
  const open = [];
  for (const line of String(logText || '').split(/\r?\n/).slice(-2000)) {
    const due = /\] schedule due: (.+)$/.exec(line);
    if (due) { open.push(due[1]); continue; }
    const end = /\] (?:run|preview) (.+?) \((?:schedule|manual)\): /.exec(line);
    if (end) { const i = open.indexOf(end[1]); if (i >= 0) open.splice(i, 1); }
  }
  return new Set(open.slice(0, 1));
}

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function writeJson(f, obj) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, f);
}

function runImport({ appData, dataDir, now = new Date() }) {
  const offer = findImport({ appData, dataDir });
  if (!offer) throw new Error('there is nothing to import (or FileBridge already has jobs)');
  const { from } = offer;
  const tag = stamp(now);
  const oldJobs = path.join(from, 'jobs.json');
  const renamedTo = path.join(from, `jobs.migrated-${tag}.json`);
  const handBack = () => { try { if (!fs.existsSync(oldJobs)) fs.renameSync(renamedTo, oldJobs); } catch {} };

  // 1. Take the jobs away from the drop-in FIRST, then read the copy it can no longer change.
  fs.renameSync(oldJobs, renamedTo);
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(renamedTo, 'utf8'));
    if (!cfg || !Array.isArray(cfg.jobs)) throw new Error('Bedrock Panel\'s jobs.json has no job list');
  } catch (e) { handBack(); throw e; }

  // 2. Every job waits for its next scheduled time; scheduled runs still in progress there are held.
  const at = now.getTime();
  for (const j of cfg.jobs) j.lastSkippedDue = Math.max(j.lastSkippedDue || 0, at);
  let oldLog = '';
  try { oldLog = fs.readFileSync(path.join(from, 'log.txt'), 'utf8'); } catch {}
  const inProgress = runsInProgress(oldLog);
  const held = {};
  for (const j of cfg.jobs) if (inProgress.has(j.name)) held[j.id] = { name: j.name, result: mtime(path.join(from, resultName(j.id))) };

  // 3. Everything else, then the jobs. On failure, hand the jobs back to the drop-in.
  const copied = [];
  const newJobs = path.join(dataDir, 'jobs.json');
  try {
    copyTree(from, dataDir, tag, copied);
    if (fs.existsSync(newJobs)) fs.copyFileSync(newJobs, `${newJobs}.pre-import-${tag}`);
    writeJson(newJobs, cfg);
  } catch (e) { handBack(); throw e; }

  // 4. The import record the follow-up works from (see followUp).
  const files = {};
  for (const f of fs.readdirSync(from)) if (/^(seen|result)-.+\.json$/i.test(f)) files[f] = mtime(path.join(from, f));
  writeJson(path.join(dataDir, RECORD), { from, at: now.toISOString(), renamedTo, grand: cfg.grand || null, files, held });

  // 5. Join the logs, the drop-in's history first. Last, so a failed import never doubles it.
  const newLog = path.join(dataDir, 'log.txt');
  try { if (oldLog) fs.writeFileSync(newLog, oldLog + (fs.existsSync(newLog) ? fs.readFileSync(newLog, 'utf8') : '')); } catch {}

  // 6. A drop-in write that raced the rename may already have brought jobs.json back (the
  //    engine isn't reading the new jobs.json yet, so the grand delta goes straight into it).
  const swept = followUp({ dataDir, nowMs: at, addToGrand: delta => {
    const c = readJson(newJobs) || cfg;
    const g = c.grand || (c.grand = { since: now.toISOString() });
    for (const [k, v] of Object.entries(delta)) if (k !== 'since') g[k] = (g[k] || 0) + v;
    writeJson(newJobs, c);
  } });
  return { ok: true, jobs: cfg.jobs.length, from, renamedTo, copied: copied.length, held: Object.values(held).map(h => h.name), swept };
}

const resultName = id => 'result-' + String(id).replace(/[^a-z0-9]/gi, '') + '.json';

function mergeSeen(theirFile, ourFile) {
  const theirs = readJson(theirFile) || {}, ours = readJson(ourFile) || {};
  writeJson(ourFile, {
    ...theirs, ...ours,
    collections: { ...(theirs.collections || {}), ...(ours.collections || {}) },
    items: { ...(theirs.items || {}), ...(ours.items || {}) },
  });
}

// Called from the scheduler tick for FOLLOW_UP_MS after an import (and once by runImport).
// addToGrand(delta) folds a late drop-in run's grand totals into this app's jobs.json.
// Returns a list of what it did (for the log), or null when there is no import to follow.
function followUp({ dataDir, nowMs = Date.now(), addToGrand }) {
  const recFile = path.join(dataDir, RECORD);
  const rec = readJson(recFile);
  if (!rec || !rec.from) return null;
  const age = nowMs - Date.parse(rec.at);
  if (age > FOLLOW_UP_MS && !Object.keys(rec.held || {}).length) return null;
  const did = [];
  const from = rec.from;
  const tag = stamp(new Date(nowMs));

  // a. jobs.json is back in the drop-in folder
  const jf = path.join(from, 'jobs.json');
  if (fs.existsSync(jf)) {
    const cfg = readJson(jf);
    if (cfg && Array.isArray(cfg.jobs) && cfg.jobs.length) {
      fs.renameSync(jf, path.join(from, `jobs.migrated-${tag}-again.json`));
      did.push(`Bedrock Panel's jobs.json came back with ${cfg.jobs.length} job(s) — renamed it away again so only FileBridge runs them`);
    } else if (cfg) {
      // A run that was in progress at import time finished and saved into an empty file.
      const delta = {};
      for (const [k, v] of Object.entries(cfg.grand || {})) {
        if (typeof v === 'number') delta[k] = v - ((rec.grand && typeof rec.grand[k] === 'number') ? rec.grand[k] : 0);
      }
      if (Object.values(delta).some(v => v > 0)) { addToGrand(delta); did.push('added a late Bedrock Panel run to the grand totals'); }
      rec.grand = cfg.grand || rec.grand;
      fs.renameSync(jf, path.join(from, `jobs.late-${tag}.json`));
    }
  }

  // b. seen-ledgers the drop-in is still writing, and results of runs it finished
  rec.files = rec.files || {};
  let names = [];
  try { names = fs.readdirSync(from); } catch {}
  for (const f of names) {
    const m = mtime(path.join(from, f));
    if (!(m > (rec.files[f] || 0))) continue;
    if (/^seen-.+\.json$/i.test(f)) { mergeSeen(path.join(from, f), path.join(dataDir, f)); did.push('merged a newer Bedrock Panel seen-ledger: ' + f); }
    else if (/^result-.+\.json$/i.test(f)) {
      if (mtime(path.join(dataDir, f)) < m) fs.copyFileSync(path.join(from, f), path.join(dataDir, f));
    } else continue;
    rec.files[f] = m;
  }

  // c. release held jobs whose drop-in run has finished (or that waited too long)
  for (const [id, h] of Object.entries(rec.held || {})) {
    if (mtime(path.join(from, resultName(id))) > (h.result || 0) || age > HOLD_MAX_MS) {
      delete rec.held[id];
      did.push(`"${h.name}" finished in Bedrock Panel — it runs here from now on`);
    }
  }
  writeJson(recFile, rec);
  return did;
}

// Jobs the new app must not start yet (a scheduled run of theirs is still going in Bedrock Panel).
function heldJobs(dataDir) {
  const rec = readJson(path.join(dataDir, RECORD));
  return new Set(Object.keys((rec && rec.held) || {}));
}

module.exports = { findImport, runImport, followUp, heldJobs, runsInProgress, panelDataDirs, countJobs, FOLLOW_UP_MS };
