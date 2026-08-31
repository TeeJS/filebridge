'use strict';
// FileBridge engine — pure logic, no Electron, no dependencies. Plan-then-execute:
// plan() walks source (and dest for mirror jobs) and returns the exact action list;
// execute() performs it. A dry-run is simply plan() without execute() — same code path,
// so the preview always matches what a real run would do.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

// FAT stores mtimes in 2 s steps and network filesystems round too — a smaller delta
// than this is "unchanged", or every changed-only run would recopy the whole tree.
const MTIME_TOLERANCE_MS = 2000;

// ── change detection (Karen parity: time / newer-only / size / content) ─────────
// A file already present in the destination is re-copied when it looks CHANGED. The
// criteria are independent and OR'd: any enabled test that flags a difference means copy.
// Mode 'all' copies every file; with no criteria enabled, only missing files copy
// (never overwrite existing). Old jobs used a single boolean — map it forward.
function resolveCompare(job) {
  if (job.compare && typeof job.compare === 'object') return job.compare;
  if (job.changedOnly === false) return { mode: 'all' };
  return { mode: 'changed', time: true, size: true };
}
async function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('error', reject).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}
// Why the source file differs from the destination under the enabled criteria, or null if
// it matches. Cheap tests (time, size) run before the expensive content hash and short-circuit.
async function diffReason(cmp, srcPath, s, dstPath, d) {
  if (cmp.time) {
    if (cmp.newerOnly) { if (s.mtimeMs - d.mtimeMs > MTIME_TOLERANCE_MS) return 'source newer'; }
    else if (Math.abs(s.mtimeMs - d.mtimeMs) > MTIME_TOLERANCE_MS) return 'time differs';
  }
  if (cmp.size && s.size !== d.size) return 'size differs';
  if (cmp.content && (await hashFile(srcPath)) !== (await hashFile(dstPath))) return 'content differs';
  return null;
}

// ── wildcards ─────────────────────────────────────────────────────────────────
// "*.docx; backup*; temp" -> [RegExp]. Matched case-insensitively (Windows) against
// the entry NAME and the forward-slash relative path. `*` does not cross `/`.
// Karen-compatible semantics: `?` one char, `#` one digit, `[abc]`/`[a-z]` character
// sets with `[!...]` negation, and `*.*` means every file — extensionless included.
function globToRx(g) {
  if (g === '*.*') g = '*';
  let rx = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') rx += '[^/]*';
    else if (c === '?') rx += '[^/]';
    else if (c === '#') rx += '\\d';
    else if (c === '[') {
      const neg = g[i + 1] === '!';
      const close = g.indexOf(']', i + (neg ? 3 : 2)); // body is at least one char
      if (close < 0) { rx += '\\['; continue; }        // unmatched [ stays literal
      const body = g.slice(i + (neg ? 2 : 1), close).replace(/[\\\]^]/g, '\\$&');
      rx += '[' + (neg ? '^/' : '') + body + ']';      // a negated set still can't cross /
      i = close;
    } else rx += c.replace(/[.+^${}()|\]\\]/g, '\\$&');
  }
  return rx;
}
function compileGlobs(list) {
  return (Array.isArray(list) ? list : String(list || '').split(';'))
    .map(g => String(g).trim().replace(/\\/g, '/')).filter(Boolean)
    .map(g => {
      try { return new RegExp('^' + globToRx(g) + '$', 'i'); }
      catch { // an invalid class like [z-a] (legal pre-1.3 as literal text) matches literally
        return new RegExp('^' + g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
      }
    });
}
function matches(globs, name, rel) {
  return globs.some(rx => rx.test(name) || rx.test(rel));
}

// ── date tokens in paths ──────────────────────────────────────────────────────
// <…> segments in a job's source/destination expand at run time — <yyyy-mm-dd> becomes
// "2026-08-30" — enabling dated backup destinations like D:\Backup\<yyyy>\<mm>. Tokens are
// case-insensitive, longest name wins, and unrecognized characters inside <> pass through
// (so <yyyy-mm-dd> needs no separators escaping). `<` and `>` are illegal in real Windows
// paths, so a path without tokens is never altered.
const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function expandTokens(p, when) {
  const s = String(p == null ? '' : p);
  if (s.indexOf('<') < 0) return s;
  const d = when instanceof Date ? when : new Date(when || Date.now());
  const p2 = n => String(n).padStart(2, '0');
  // Calendar day arithmetic via UTC day numbers — an elapsed-ms subtraction would run an
  // hour short under DST and put a 00:30 run in yesterday's <doy> folder all summer.
  const doy = (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 1)) / 86400000 + 1;
  const qtr = Math.floor(d.getMonth() / 3) + 1;
  const dow = d.getDay() + 1; // 1 = Sunday … 7 = Saturday
  const map = {
    quarter: qtr, julian: doy, month: MON_ABBR[d.getMonth()], year: d.getFullYear(),
    wwoy: p2(Math.floor((doy - 1) / 7) + 1), ddoy: String(doy).padStart(3, '0'),
    yyyy: String(d.getFullYear()).padStart(4, '0'),
    day: DAY_ABBR[d.getDay()], dow: dow, doy: doy, jjj: String(doy).padStart(3, '0'),
    qtr: qtr, wom: Math.floor((d.getDate() - 1) / 7) + 1, woy: Math.floor((doy - 1) / 7) + 1,
    yy: p2(d.getFullYear() % 100), mm: p2(d.getMonth() + 1), dd: p2(d.getDate()),
    hh: p2(d.getHours()), nn: p2(d.getMinutes()), ss: p2(d.getSeconds()),
    y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(),
    h: d.getHours(), n: d.getMinutes(), s: d.getSeconds(),
    w: dow, x: dow, q: qtr,
  };
  const names = Object.keys(map).sort((a, b) => b.length - a.length);
  return s.replace(/<([^<>]*)>/g, (_, body) => {
    let out = '';
    for (let i = 0; i < body.length;) {
      const low = body.slice(i).toLowerCase();
      const hit = names.find(n => low.startsWith(n));
      if (hit) { out += map[hit]; i += hit.length; }
      else { out += body[i]; i++; }
    }
    return out;
  });
}

// ── Google Drive folder links ─────────────────────────────────────────────────
// A pasted Drive folder URL can BE a job's source/dest. It resolves to the local Google
// Drive for Desktop mount at every run: the folder id in the URL is the directory name
// under <mount>:\.shortcut-targets-by-id — the mapping the user previously translated by
// hand. Per-run resolution means jobs survive folder renames and drive-letter changes.
function parseDriveLink(str) {
  const s = String(str || '').trim();
  if (!/^https?:\/\/(drive|docs)\.google\.com\//i.test(s)) return null;
  const m = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(s) || /[?&]id=([A-Za-z0-9_-]{10,})/.exec(s);
  return m ? m[1] : null;
}
function resolveDriveLink(str, roots) {
  const id = parseDriveLink(str);
  if (!id) throw new Error('not a Google Drive folder link');
  if (!roots) {
    roots = [];
    for (let c = 65; c <= 90; c++) {
      const p = String.fromCharCode(c) + ':\\.shortcut-targets-by-id';
      try { if (fs.statSync(p).isDirectory()) roots.push(p); } catch {}
    }
  }
  if (!roots.length) throw new Error('Google Drive for Desktop does not appear to be running or signed in (no Drive mount found)');
  for (const root of roots) {
    const dir = path.join(root, id);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      // The id dir normally holds exactly the one named folder; fall back to the id dir itself.
      const kids = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory());
      return kids.length === 1 ? path.join(dir, kids[0].name) : dir;
    } catch {}
  }
  throw new Error('this Drive folder has no shortcut on the mount — in Drive, right-click the folder → Organize → Add shortcut, then run again');
}

// ── job validation ────────────────────────────────────────────────────────────
function isAbsWin(p) { return /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\[^\\]/.test(p); }
function norm(p) { return path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase(); }

// Returns an error string or null. Nesting either path inside the other is refused:
// dest-inside-source recurses forever, source-inside-dest + mirror deletes the source.
function validateJob(job) {
  if (!job || !String(job.name || '').trim()) return 'a job name is required';
  const src = String(job.source || '').trim(), dst = String(job.dest || '').trim();
  if (!src || !dst) return 'source and destination folders are both required';
  const srcDrive = parseDriveLink(src), dstDrive = parseDriveLink(dst);
  if (!srcDrive && !isAbsWin(src)) return 'source must be a full path (C:\\…, \\\\server\\share\\…) or a Google Drive folder link';
  if (!dstDrive && !isAbsWin(dst)) return 'destination must be a full path (C:\\…, \\\\server\\share\\…) or a Google Drive folder link';
  if (srcDrive && dstDrive && srcDrive === dstDrive) return 'source and destination are the same Drive folder';
  if (!srcDrive && !dstDrive) {
    // Nesting/same-folder checks need real paths; Drive links get the same checks at run
    // time, after resolution (pump() re-validates the resolved job).
    const a = norm(src), b = norm(dst);
    if (a === b) return 'source and destination are the same folder';
    if (b.startsWith(a + path.sep)) return 'destination is inside the source folder';
    if (a.startsWith(b + path.sep)) return 'source is inside the destination folder';
  }
  const sc = job.schedule || {};
  if (sc.type === 'cron') { try { parseCron(sc.expr); } catch (e) { return e.message; } }
  if (sc.type === 'interval' && !(Number(sc.every) >= 1)) return 'interval must be at least 1 minute';
  if (sc.type === 'every') {
    const units = [sc.mins, sc.hours, sc.days, sc.weeks, sc.months];
    // Whole numbers only: setDate/setMonth truncate fractions, so 0.5 days would validate
    // yet never fire (the step never advances) and 1.5 days would silently mean 1 day.
    if (units.some(v => v != null && (!Number.isInteger(Number(v)) || Number(v) < 0))) return 'repeat values must be whole numbers, 0 or more';
    if (!(units.reduce((a, v) => a + (Number(v) || 0), 0) > 0)) return 'a repeat interval is required (at least 1 minute)';
    if (!(Number(sc.start) > 0)) return 'a starting date and time is required';
    if (sc.skipDays != null && (!Array.isArray(sc.skipDays) || sc.skipDays.length > 7 ||
        sc.skipDays.some(x => !Number.isInteger(x) || x < 0 || x > 6))) return 'skip-days must be weekday numbers 0-6';
    if (Array.isArray(sc.skipDays) && new Set(sc.skipDays).size >= 7) return "the job can't skip every day of the week";
  }
  if ((sc.type === 'daily' || sc.type === 'weekly') && !/^\d{2}:\d{2}$/.test(sc.at || '')) return 'a run time (HH:MM) is required';
  if (sc.type === 'weekly' && !(Array.isArray(sc.days) && sc.days.length)) return 'pick at least one weekday';
  try { compileGlobs(job.include); compileGlobs(job.exclude); } catch { return 'bad wildcard pattern'; }
  return null;
}

// ── schedule math (pure, tested) ──────────────────────────────────────────────
// Standard 5-field cron: minute hour day-of-month month day-of-week.
// Supports *, lists (a,b), ranges (a-b), steps (*/n, a-b/n, a/n), 3-letter month and
// weekday names, and 0 or 7 for Sunday. Vixie semantics: when BOTH day fields are
// restricted, a day matching EITHER runs.
function parseCron(expr) {
  const fields = String(expr || '').trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('cron needs 5 fields: minute hour day-of-month month day-of-week');
  const names = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const val = (s, lo, hi) => {
    const n = /^\d+$/.test(s) ? +s : names[s.toLowerCase()];
    if (n == null || n < lo || n > hi) throw new Error(`bad cron value "${s}"`);
    return n;
  };
  const field = (f, lo, hi) => {
    const set = new Set();
    for (const part of f.split(',')) {
      const m = /^(.+?)(?:\/(\d+))?$/.exec(part);
      if (!m || !m[1]) throw new Error(`bad cron field "${f}"`);
      const step = m[2] ? +m[2] : 1;
      if (!step) throw new Error('cron step cannot be 0');
      let a = lo, b = hi;
      if (m[1] !== '*') {
        const r = m[1].split('-');
        if (r.length > 2) throw new Error(`bad cron range "${part}"`);
        a = val(r[0], lo, hi);
        b = r.length === 2 ? val(r[1], lo, hi) : (m[2] ? hi : a); // "5/10" = 5-max/10 (Vixie)
        if (b < a) throw new Error(`bad cron range "${part}" (end before start)`);
      }
      for (let v = a; v <= b; v += step) set.add(v);
    }
    return set;
  };
  const [mi, h, dom, mon, dow] = fields;
  const p = {
    min: field(mi, 0, 59), hour: field(h, 0, 23), dom: field(dom, 1, 31),
    mon: field(mon, 1, 12), dow: field(dow, 0, 7), domStar: dom === '*', dowStar: dow === '*',
  };
  if (p.dow.has(7)) p.dow.add(0);
  return p;
}

// Next matching minute (ms epoch) strictly after `afterMs`, or null within a year.
// Steps whole days/hours when they can't match, so worst case is a few thousand checks.
function cronNext(expr, afterMs) {
  const p = typeof expr === 'string' ? parseCron(expr) : expr;
  const d = new Date(afterMs);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = afterMs + 366 * 86400000;
  while (d.getTime() <= limit) {
    if (!p.mon.has(d.getMonth() + 1)) { d.setDate(1); d.setMonth(d.getMonth() + 1); d.setHours(0, 0, 0, 0); continue; }
    const dayOk = p.domStar && p.dowStar ? true
      : p.domStar ? p.dow.has(d.getDay())
      : p.dowStar ? p.dom.has(d.getDate())
      : p.dom.has(d.getDate()) || p.dow.has(d.getDay());
    if (!dayOk) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    if (!p.hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
    if (!p.min.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1); continue; }
    return d.getTime();
  }
  return null;
}

// Sliding repeat interval (Karen parity): "every N mins/hours/days/weeks/months" — the
// units are ADDITIVE (1 day + 1 hour = every 25 hours) — anchored to an explicit first-run
// datetime (`start`, ms epoch). An occurrence landing on a skipDays weekday (0=Sun..6=Sat)
// is skipped by advancing another whole interval, matching Karen's roll-forward. Month
// steps clamp to the target month's last day (Jan 31 + 1 month = Feb 28) and, like Karen,
// step cumulatively (… = Mar 28). Day/week/month steps keep wall-clock time across DST.
function everyNext(sc, afterMs) {
  const iv = v => Math.max(0, Math.floor(Number(v) || 0)); // whole units only — see validateJob
  const mins = iv(sc.mins) + iv(sc.hours) * 60;
  const days = iv(sc.days) + iv(sc.weeks) * 7;
  const months = iv(sc.months);
  if (!(mins > 0 || days > 0 || months > 0)) return null;
  const skip = Array.isArray(sc.skipDays) ? sc.skipDays : [];
  if (new Set(skip).size >= 7) return null;
  let t = new Date(Number(sc.start) || 0);
  if (isNaN(t.getTime())) return null;
  // Unit order matches Karen's DateAdd sequence (minutes … months LAST): with "1 month +
  // 2 days" from Jan 30, days advance past month-end BEFORE the clamped month step, giving
  // Mar 1 — months-first would clamp to Feb 28 and drift the series by a day forever.
  const step = dt => {
    let x = dt;
    if (mins) x = new Date(x.getTime() + mins * 60000);
    if (days) { x = new Date(x); x.setDate(x.getDate() + days); }
    if (months) {
      const day = x.getDate();
      x = new Date(x); x.setDate(1); x.setMonth(x.getMonth() + months);
      x.setDate(Math.min(day, new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate()));
    }
    return x;
  };
  // Pure-time intervals fast-forward arithmetically so "every 15 min" started years ago
  // doesn't iterate; calendar-unit intervals are >= 1 day, so the loop stays small.
  if (!days && !months) {
    const k = Math.floor((afterMs - t.getTime()) / (mins * 60000));
    if (k > 0) t = new Date(t.getTime() + k * mins * 60000);
  }
  for (let i = 0; i < 20000; i++) {
    if (t.getTime() > afterMs && !skip.includes(t.getDay())) return t.getTime();
    t = step(t);
  }
  return null;
}

// Next due time (ms epoch) strictly after `afterMs`, or null for manual/none.
// The interval/daily/weekly branches survive only for jobs saved before v1.1 — the UI
// now writes cron, 'every', or manual.
function nextOccurrence(sc, afterMs) {
  if (!sc || sc.type === 'manual' || !sc.type) return null;
  if (sc.type === 'cron') { try { return cronNext(sc.expr, afterMs); } catch { return null; } }
  if (sc.type === 'every') return everyNext(sc, afterMs);
  if (sc.type === 'interval') return afterMs + Math.max(1, Number(sc.every) | 0) * 60000;
  const m = /^(\d{2}):(\d{2})$/.exec(sc.at || '');
  if (!m) return null;
  const days = sc.type === 'weekly' ? (Array.isArray(sc.days) && sc.days.length ? sc.days : [0]) : null;
  const d = new Date(afterMs);
  d.setHours(+m[1], +m[2], 0, 0);
  for (let i = 0; i < 9; i++) {
    if (d.getTime() > afterMs && (!days || days.includes(d.getDay()))) return d.getTime();
    d.setDate(d.getDate() + 1);
    d.setHours(+m[1], +m[2], 0, 0); // re-set after the date change so DST can't drift the time
  }
  return null;
}

// ── plan ──────────────────────────────────────────────────────────────────────
// Walks source and decides what a run would do. Mirror deletions are decided by presence
// AND protection: a dest entry is deleted only when nothing exists at that path in the
// source, and never when it matches a Skip (exclude) pattern — excluded items are
// protected from the deletion pass (Karen parity), so a mirror can hold e.g. *.log files
// that exist only in the destination. Include filters never widen or narrow deletion.
//
// Returns { actions:[{op:'copy'|'del'|'deldir', rel, size?, mtimeMs?}], scanned,
//           unchanged, filtered, mirrorProtected, totalBytes, errors:[{path,error}] }.
async function plan(job, opts = {}) {
  const src = String(job.source), dst = String(job.dest);
  const inc = compileGlobs(job.include), exc = compileGlobs(job.exclude);
  const sub = job.subfolders !== false;
  const cmp = resolveCompare(job);
  const out = { actions: [], scanned: 0, unchanged: 0, filtered: 0, mirrorProtected: 0, foldersScanned: 0, totalBytes: 0, errors: [], mirrorSkipped: null };
  const stop = () => opts.shouldStop && opts.shouldStop();
  // Report the file currently being examined so the UI can show live Source/Destination
  // paths — first without a verdict (content compare can take a while on a big file),
  // then again with the decision, so the run bar shows UP-TO-DATE / copy / filtered
  // per file as the scan moves (Karen's live status band).
  const prog = (rel, op, reason) => { if (opts.onProgress) opts.onProgress({ phase: 'scan', scanned: out.scanned, rel, op, reason }); };

  const st = await fsp.stat(src);
  if (!st.isDirectory()) throw new Error('source is not a folder');
  // "Test connection to source" (Karen parity, default on): a source that reads as EMPTY is
  // almost always an unmounted share or a wrong path, not a deliberately emptied folder — and
  // mirroring empty-over-full wipes the whole destination. Count the source's top-level entries
  // up front; if it's empty and this guard is on, we skip the mirror deletions below.
  const testSource = job.testSource !== false;
  let srcTopCount = 0;
  try { srcTopCount = (await fsp.readdir(src)).length; } catch {}

  // Follow shortcuts (opt-in): a .lnk in the source expands to its target's content under
  // the shortcut's own name (minus .lnk). Resolution is injected by the host — only the
  // Windows shell can resolve a Drive placeholder .lnk (raw reads fail with EINVAL).
  const followLnk = job.followShortcuts === true && typeof opts.resolveShortcut === 'function';
  // Dest-relative paths materialized through a shortcut: the mirror walk must treat them
  // as present in the source, or it would delete what the expansion just copied. Keys are
  // LOWERCASED — dest dirent casing can drift from the shortcut's (Windows is
  // case-insensitive everywhere else in this file: globs, access checks, the loop chain).
  const viaShortcut = new Set();
  // Expansion roots whose target could not be reached THIS run: the walk never learned
  // their children, so the mirror must skip the whole dest subtree, not just the root.
  const viaShortcutStale = new Set();
  let dstKey = path.resolve(dst).toLowerCase();
  try { dstKey = String(await fsp.realpath(dst)).toLowerCase(); } catch {} // dest may not exist yet

  async function planFile(abs, rel, name, s, virtual) {
    out.scanned++;
    prog(rel); // every file — the UI shows the live Source/Destination path being examined
    if (virtual) viaShortcut.add(rel.toLowerCase());
    if (exc.length && matches(exc, name, rel)) { out.filtered++; prog(rel, 'filtered'); return; }
    if (inc.length && !matches(inc, name, rel)) { out.filtered++; prog(rel, 'filtered'); return; }
    if (!s) {
      try { s = await fsp.stat(abs); }
      catch (e) { out.errors.push({ path: rel, error: e.message }); prog(rel, 'error'); return; }
    }
    let reason = 'all files';
    if (cmp.mode !== 'all') {
      const dstPath = path.join(dst, rel);
      try {
        const d = await fsp.stat(dstPath);
        reason = await diffReason(cmp, abs, s, dstPath, d);
      } catch { reason = 'new file'; } // dest missing -> always copy
    }
    if (reason) {
      const a = { op: 'copy', rel, size: s.size, mtimeMs: s.mtimeMs, reason };
      if (virtual) a.from = abs; // execute copies from the shortcut target, not src+rel
      out.actions.push(a); out.totalBytes += s.size; prog(rel, 'copy', reason);
    } else { out.unchanged++; prog(rel, 'same'); }
  }

  async function expandShortcut(abs, relDir, lnkName, chain, siblings) {
    const base = lnkName.replace(/\.lnk$/i, '');
    const rel = relDir ? relDir + '/' + base : base;
    const lnkRel = relDir ? relDir + '/' + lnkName : lnkName;
    // A real "X" beside "X.lnk" would land both at the same dest path — refuse the
    // ambiguity loudly instead of letting readdir order pick a silent winner.
    if (siblings && siblings.has(base.toLowerCase())) {
      out.errors.push({ path: lnkRel, error: 'shortcut skipped — "' + base + '" already exists in the same folder' });
      return;
    }
    // A target that can't be resolved or reached right now (Drive for Desktop not
    // running) still protects its previous expansion from mirror deletion — a transient
    // outage must never turn into a mirror wipe (same philosophy as testSource).
    let target = null;
    try { target = await opts.resolveShortcut(abs); } catch {}
    if (!target) { viaShortcutStale.add(rel.toLowerCase()); out.errors.push({ path: lnkRel, error: 'shortcut target could not be resolved' }); return; }
    let ts;
    try { ts = await fsp.stat(target); }
    catch { viaShortcutStale.add(rel.toLowerCase()); out.errors.push({ path: lnkRel, error: 'shortcut target is unreachable: ' + target }); return; }
    let real = target;
    try { real = await fsp.realpath(target); } catch {}
    const key = String(real).toLowerCase();
    // A shortcut into (or above) the DESTINATION would copy the destination into itself,
    // nesting one level deeper every scheduled run. The job validator can't see it —
    // shortcut targets only exist at plan time — so refuse it here.
    if (key === dstKey || dstKey.startsWith(key + path.sep) || key.startsWith(dstKey + path.sep)) {
      out.errors.push({ path: lnkRel, error: 'shortcut points at the destination — skipped' });
      return;
    }
    if (ts.isDirectory()) {
      if (!sub) return; // a folder shortcut is a subfolder — top-level-only jobs skip it
      if (exc.length && matches(exc, base, rel)) { out.filtered++; return; }
      if (chain.has(key)) { out.errors.push({ path: lnkRel, error: 'shortcut loop skipped — already visiting ' + target }); return; }
      viaShortcut.add(rel.toLowerCase());
      const next = new Set(chain); next.add(key);
      await walkSrc(target, rel, next, true);
    } else {
      await planFile(target, rel, base, ts, true);
    }
  }

  async function walkSrc(absDir, relDir, chain, virtual) {
    if (stop()) return;
    let entries;
    try { entries = await fsp.readdir(absDir, { withFileTypes: true }); }
    catch (e) { out.errors.push({ path: relDir || absDir, error: e.message }); return; }
    out.foldersScanned++; // every source folder actually read, the root included (Karen's Processed folders)
    const siblings = followLnk ? new Set(entries.map(e => e.name.toLowerCase())) : null;
    for (const ent of entries) {
      if (stop()) return;
      const rel = relDir ? relDir + '/' + ent.name : ent.name;
      if (ent.isDirectory()) {
        if (virtual) viaShortcut.add(rel.toLowerCase());
        if (exc.length && matches(exc, ent.name, rel)) { out.filtered++; continue; }
        if (sub) await walkSrc(path.join(absDir, ent.name), rel, chain, virtual);
        continue;
      }
      if (!ent.isFile()) continue; // symlinks/junctions are out of scope — logged nowhere, copied never
      if (followLnk && /\.lnk$/i.test(ent.name)) {
        // The literal .lnk name stays excludable — "*.lnk" or "Foo.lnk" opts a shortcut
        // out of expansion exactly as it opts the file out of copying with follow off.
        if (exc.length && matches(exc, ent.name, rel)) { out.filtered++; continue; }
        await expandShortcut(path.join(absDir, ent.name), relDir, ent.name, chain, siblings);
        continue;
      }
      await planFile(path.join(absDir, ent.name), rel, ent.name, null, virtual);
    }
  }
  {
    let rootKey = src;
    try { rootKey = await fsp.realpath(src); } catch {}
    await walkSrc(src, '', new Set([String(rootKey).toLowerCase()]), false);
  }

  if (job.mirror && testSource && srcTopCount === 0) {
    // Refuse to plan any deletions — protects against wiping the destination when the
    // source is unreachable/empty. Surfaced to the UI and log; the user can turn off
    // "Test connection to source" to mirror a genuinely empty source.
    out.mirrorSkipped = 'source is empty or unreachable — deletions skipped (Test connection to source is on)';
  } else if (job.mirror && !stop()) {
    // Mirror planning walks the DESTINATION — emit its own progress phase so the UI can say
    // so instead of freezing on the last source file's verdict for the whole dest walk.
    const progD = rel => { if (opts.onProgress) opts.onProgress({ phase: 'mirror', scanned: out.scanned, rel }); };
    async function walkDst(relDir) {
      if (stop()) return;
      let entries;
      try { entries = await fsp.readdir(path.join(dst, relDir), { withFileTypes: true }); }
      catch (e) { if (relDir) out.errors.push({ path: relDir, error: e.message }); return; }
      for (const ent of entries) {
        if (stop()) return;
        const rel = relDir ? relDir + '/' + ent.name : ent.name;
        progD(rel);
        // Skip-pattern protection: an excluded dest entry (and everything under an
        // excluded dest folder) is never deleted, mirroring the copy-side pruning.
        if (exc.length && matches(exc, ent.name, rel)) { out.mirrorProtected++; continue; }
        // A shortcut whose target was unreachable this run keeps its whole previous
        // expansion — a transient outage must never turn into a mirror wipe.
        if (viaShortcutStale.has(rel.toLowerCase())) { out.mirrorProtected++; continue; }
        let inSrc = viaShortcut.has(rel.toLowerCase()); // materialized via a followed shortcut = present
        if (!inSrc) { try { await fsp.access(path.join(src, rel)); inSrc = true; } catch {} }
        if (ent.isDirectory()) {
          if (!sub) continue; // top-level-only jobs never touch dest subfolders
          if (!inSrc) out.actions.push({ op: 'deldir', rel });
          else await walkDst(rel);
        } else if (!inSrc) {
          out.actions.push({ op: 'del', rel });
        }
      }
    }
    await walkDst('');
  }
  return out;
}

// ── execute ───────────────────────────────────────────────────────────────────
// Windows: overwriting or deleting a read-only file fails EPERM/EACCES — clear the
// attribute and retry once, then record the error and keep going (a bad file must not
// abort the whole job).
async function unlock(p) { try { await fsp.chmod(p, 0o666); } catch {} }

// Google-native formats on a Drive mount (.gdoc etc.): listed as tiny placeholder FILES,
// but the Drive filesystem opens them as directory-like objects, so copyfile fails with
// EISDIR (Drive's spelling) or EPERM (NTFS's spelling for a directory source). They have
// no copyable content (just a pointer into Google's cloud) — that failure is a benign
// skip, not an error. The same codes on anything else stay errors.
const GOOGLE_PLACEHOLDER = /\.(gdoc|gsheet|gslides|gdraw|gform|gtable|gjam|gmap|gsite|gscript|glink)$/i;
async function isPlaceholderFailure(e, rel, srcPath) {
  if (!GOOGLE_PLACEHOLDER.test(rel)) return false;
  if (e.code === 'EISDIR') return true; // Drive lies in stat too — trust the open failure
  if (e.code !== 'EPERM' && e.code !== 'EACCES') return false;
  return fsp.stat(srcPath).then(s => s.isDirectory()).catch(() => false);
}

async function execute(job, actions, opts = {}) {
  const src = String(job.source), dst = String(job.dest);
  const res = { copied: 0, deleted: 0, bytes: 0, recycled: 0, foldersCreated: 0, foldersDeleted: 0, errors: [], skipped: [], stopped: false };
  // mkdir(recursive) returns the FIRST directory it created (undefined if all existed), so
  // the segments from there down to the target are exactly the folders created just now.
  async function ensureDir(dir) {
    const made = await fsp.mkdir(dir, { recursive: true });
    if (made) res.foldersCreated += 1 + (dir.length > made.length ? dir.slice(made.length).split(path.sep).filter(Boolean).length : 0);
  }
  // Recycle Bin (Karen parity, default on): the host passes opts.trash to move a path to the
  // Recycle Bin. If recycling is asked for but fails (e.g. a network destination, where Windows
  // has no Recycle Bin), we record an error and DO NOT fall back to a permanent delete — the
  // user asked for recoverable deletion, so silently destroying the file would betray that.
  const recycle = job.recycle !== false && typeof opts.trash === 'function';
  async function removePath(to, rel) {
    if (recycle) {
      const ok = await opts.trash(to);
      if (ok) { res.recycled++; return true; }
      res.errors.push({ path: rel, error: 'could not move to Recycle Bin (network destinations have none — turn off Recycle Bin for this job)' });
      return false;
    }
    try { await fsp.rm(to, { recursive: true, force: true, maxRetries: 2 }); }
    catch (e) {
      if (e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
      await unlock(to);
      await fsp.rm(to, { recursive: true, force: true, maxRetries: 2 });
    }
    return true;
  }
  let done = 0;
  for (const a of actions) {
    if (opts.shouldStop && opts.shouldStop()) { res.stopped = true; break; }
    const to = path.join(dst, a.rel);
    try {
      if (a.op === 'copy') {
        await ensureDir(path.dirname(to));
        // "Delete old copy before creating new" (Karen's KillBeforeCopy): remove any existing
        // destination file first so the copy writes fresh — frees the old blocks and sidesteps
        // in-place-overwrite quirks (read-only attrs, locked handles). Permanent, since it's
        // being replaced this instant. Best-effort: a failure here just falls through to copy.
        if (job.deleteBeforeCopy) { await unlock(to); try { await fsp.rm(to, { force: true }); } catch {} }
        // Safe replace (Karen parity): move the existing destination file aside before
        // copying, and put it back if the copy fails — a failed or interrupted copy must
        // never leave a truncated destination file where a good backup used to be. If the
        // rename itself fails (file locked), fall through to the old in-place overwrite.
        let aside = null;
        if (!job.deleteBeforeCopy) {
          const tmp = to + '.~fsync-old';
          // A leftover .~fsync-old from a crashed or failed earlier attempt holds the last
          // known-good copy — RESTORE it over whatever half-state sits at the destination
          // (never delete it first: if this copy fails too, that file is all that's left).
          try {
            await fsp.access(tmp);
            try { await fsp.rm(to, { force: true }); } catch {}
            await fsp.rename(tmp, to);
          } catch {}
          try { await fsp.rename(to, tmp); aside = tmp; } catch {} // ENOENT: nothing to save
        }
        const from = a.from || path.join(src, a.rel); // a.from = followed-shortcut target
        try {
          try { await fsp.copyFile(from, to); }
          catch (e) {
            if (e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
            await unlock(to);
            await fsp.copyFile(from, to);
          }
        } catch (e) {
          if (aside) { // restore the previous destination file
            try { await fsp.rm(to, { force: true }); } catch {}
            try { await fsp.rename(aside, to); }
            catch { await unlock(to); try { await fsp.rename(aside, to); } catch {} }
          }
          throw e;
        }
        if (aside) {
          try { await fsp.rm(aside, { force: true }); }
          catch { await unlock(aside); try { await fsp.rm(aside, { force: true }); } catch {} }
        }
        // Preserve the source mtime, or the next changed-only pass recopies everything.
        // A copied file is KEPT even when the timestamp can't be set (Karen warns and keeps
        // it — NAS shares sometimes allow data writes but deny attribute writes); the only
        // cost is that changed-only passes recopy it until the timestamp sticks.
        try { await fsp.utimes(to, new Date(), new Date(a.mtimeMs)); }
        catch (e) { res.errors.push({ path: a.rel, error: 'copied, but could not set the timestamp: ' + e.message }); }
        res.copied++; res.bytes += a.size || 0;
      } else if (a.op === 'del' || a.op === 'deldir') {
        if (await removePath(to, a.rel)) { res.deleted++; if (a.op === 'deldir') res.foldersDeleted++; }
      }
    } catch (e) {
      if (a.op === 'copy' && await isPlaceholderFailure(e, a.rel, a.from || path.join(src, a.rel))) {
        res.skipped.push({ path: a.rel, note: 'Google-native placeholder — no copyable content' });
      } else {
        res.errors.push({ path: a.rel, error: e.message });
      }
    }
    done++;
    if (opts.onProgress) opts.onProgress({ phase: 'run', done, total: actions.length, op: a.op, rel: a.rel, reason: a.reason, bytes: res.bytes });
  }
  return res;
}

module.exports = { compileGlobs, matches, validateJob, resolveCompare, diffReason, parseCron, cronNext, nextOccurrence, expandTokens, parseDriveLink, resolveDriveLink, plan, execute, MTIME_TOLERANCE_MS };
