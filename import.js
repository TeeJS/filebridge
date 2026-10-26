'use strict';
// One-time import from the Bedrock Panel FileBridge drop-in (%APPDATA%\bedrock-panel\file-bridge,
// or the pre-0.9.2 "Bedrock Panel\file-bridge") into this app's data folder.
//
// The single-scheduler guarantee lives here: the drop-in reads its jobs from its own jobs.json on
// every scheduler tick, so the import RENAMES that file (jobs.migrated-<stamp>.json) BEFORE this
// app's jobs.json exists. From that moment the drop-in sees no jobs and schedules nothing — even
// before it is updated to the read-only monitor — and at no instant do both apps hold the jobs.
// Nothing is deleted: the old folder and every file in it stay where they were.

const fs = require('fs');
const path = require('path');

// Never carried over: this app's own feed and sign-in, and half-written temp files.
const SKIP = new Set(['jobs.json', 'status.json', 'oauth.json']);
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

// What the app offers on its main screen: only while this app has no jobs of its own and a
// drop-in folder still holds some.
function findImport({ appData, dataDir }) {
  if (countJobs(path.join(dataDir, 'jobs.json')) > 0) return null;
  for (const from of panelDataDirs(appData)) {
    const n = countJobs(path.join(from, 'jobs.json'));
    if (n > 0) return { from, jobs: n };
  }
  return null;
}

function stamp(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function copyTree(src, dst, copied) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (skipName(ent.name)) continue;
    const s = path.join(src, ent.name), d = path.join(dst, ent.name);
    if (ent.isDirectory()) { copyTree(s, d, copied); continue; }
    if (!ent.isFile()) continue;
    if (ent.name.toLowerCase() === 'log.txt' && fs.existsSync(d)) {
      // Keep the drop-in's history first, then whatever this app has logged so far.
      fs.writeFileSync(d, fs.readFileSync(s, 'utf8') + fs.readFileSync(d, 'utf8'));
    } else {
      fs.copyFileSync(s, d);
    }
    copied.push(path.relative(dst, d) || ent.name);
  }
}

function runImport({ appData, dataDir, now = new Date() }) {
  const offer = findImport({ appData, dataDir });
  if (!offer) throw new Error('there is nothing to import (or FileBridge already has jobs)');
  const { from } = offer;
  const oldJobs = path.join(from, 'jobs.json');
  const text = fs.readFileSync(oldJobs, 'utf8');
  JSON.parse(text); // refuse a corrupt file before touching anything

  // 1. Everything except jobs.json: filters, rules, seen-ledgers, results, backups, log.
  const copied = [];
  copyTree(from, dataDir, copied);

  // 2. Take the jobs away from the drop-in first...
  const renamedTo = path.join(from, `jobs.migrated-${stamp(now)}.json`);
  fs.renameSync(oldJobs, renamedTo);

  // 3. ...then give them to this app. On failure, hand them back.
  const newJobs = path.join(dataDir, 'jobs.json');
  try {
    if (fs.existsSync(newJobs)) fs.copyFileSync(newJobs, `${newJobs}.${now.toISOString().replace(/[:.]/g, '-')}.bak`);
    const tmp = newJobs + '.tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, newJobs);
  } catch (e) {
    try { fs.renameSync(renamedTo, oldJobs); } catch {}
    throw e;
  }
  return { ok: true, jobs: offer.jobs, from, renamedTo, copied: copied.length };
}

module.exports = { findImport, runImport, panelDataDirs, countJobs };
