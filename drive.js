'use strict';
// Google Drive API source for folder jobs (opt-in per job "driveApi"): the source folder
// is read through the Drive REST API instead of the local Drive for Desktop mount. The
// mount HIDES other members' files in some shared folders (verified on a real vault) —
// the API sees everything the signed-in account can see. The host owns the OAuth tokens
// (app.json `oauth` block, ctx.oauth in server.js); this module only ever receives a
// getToken() closure so refreshed tokens are picked up mid-run. Read-only scope: this
// module can never modify, delete, or upload anything in Drive.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const sync = require('./sync');

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const API = 'https://www.googleapis.com/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
const SHORTCUT = 'application/vnd.google-apps.shortcut';
const GNATIVE = /^application\/vnd\.google-apps\./;
const FIELDS = 'nextPageToken,files(id,name,mimeType,size,md5Checksum,modifiedTime,shortcutDetails)';

// Google-native editor docs have no downloadable bytes, but the files.export endpoint
// converts them on the fly. When a job opts into "exportNative", these three map to
// their Office equivalents (the extension is appended to the doc's own name). Other
// native kinds (Forms, Sites, Maps, Jamboard…) have no clean file export and stay skips.
// Caveat baked into the API: files.export refuses anything whose export exceeds 10 MB
// (exportSizeLimitExceeded) — surfaced per file as an error, never a silent drop. And
// an exported doc has NO md5 and NO byte size in Drive, so change detection for it is
// modification-time only (handled in planDrive).
const EXPORT_MAP = {
  'application/vnd.google-apps.spreadsheet': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' },
  'application/vnd.google-apps.document': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' },
  'application/vnd.google-apps.presentation': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx' },
};

function sanitizeName(name) {
  const s = String(name || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim();
  return s || '_';
}

// ── API plumbing ──────────────────────────────────────────────────────────────
// Bearer-token JSON fetch with backoff on 429/5xx (Drive rate limits burst listings).
// 401/403 surface as clear errors — the caller turns them into "reconnect Google Drive".
async function apiJson(deps, url) {
  const f = deps.fetchImpl || fetch;
  let wait = 1000;
  for (let attempt = 0; ; attempt++) {
    if (deps.shouldStop && deps.shouldStop()) throw new Error('stopped');
    const token = await deps.getToken();
    if (!token) throw new Error('Google Drive is not connected — use Connect Google Drive in the editor');
    const res = await f(url, { headers: { Authorization: 'Bearer ' + token } });
    if (res.ok) return res.json();
    const body = await res.text().catch(() => '');
    // Google spells per-user rate limiting as 403 userRateLimitExceeded/rateLimitExceeded,
    // not only 429 — its docs prescribe the same exponential backoff for those.
    const rateLimited = res.status === 429 || (res.status === 403 && /rateLimitExceeded/i.test(body));
    if ((rateLimited || res.status >= 500) && attempt < 5) {
      await new Promise(r => setTimeout(r, wait)); wait = Math.min(wait * 2, 16000);
      continue;
    }
    if (res.status === 401) throw new Error('Google Drive rejected the connection (401) — reconnect Google Drive in the editor');
    if (res.status === 403) throw new Error('Google Drive refused access (403) — the account may lack access to this folder, or the Drive API quota is exhausted: ' + body.slice(0, 200));
    if (res.status === 404) throw new Error('Drive folder or file not found (404) — the link may be wrong or access was removed');
    throw new Error('Drive API error HTTP ' + res.status + ': ' + body.slice(0, 200));
  }
}

async function fileMeta(deps, id) {
  return apiJson(deps, `${API}/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=` +
    encodeURIComponent('id,name,mimeType,size,md5Checksum,modifiedTime,shortcutDetails'));
}

// Resolve what a pasted link's id ACTUALLY is before walking it. Two traps: the ?id=
// link form also matches FILE links, and a "Copy link" taken on a Drive shortcut
// carries the SHORTCUT's id — Drive answers "'<shortcutId>' in parents" with an empty
// 200, which would read as an empty source (and, with the safety guard off, could
// mirror-wipe the destination). Follow shortcut hops to the real folder and refuse
// anything that isn't one. The NAME kept is the pasted item's own (shortcut's) name.
async function resolveRootFolder(deps, id) {
  let m = await fileMeta(deps, id);
  const name = sanitizeName(m.name);
  for (let hop = 0; m.mimeType === SHORTCUT && hop < 3; hop++) {
    const tid = m.shortcutDetails && m.shortcutDetails.targetId;
    if (!tid) throw new Error('the Drive link points at a shortcut with no target');
    m = await fileMeta(deps, tid);
  }
  if (m.mimeType !== FOLDER) throw new Error('the Drive link points at a file, not a folder');
  return { id: m.id, name };
}

async function folderName(deps, id) {
  return (await resolveRootFolder(deps, id)).name;
}

async function listChildren(deps, folderId) {
  const out = [];
  let pageToken = '';
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
    const url = `${API}/files?q=${q}&fields=${encodeURIComponent(FIELDS)}&pageSize=1000` +
      `&supportsAllDrives=true&includeItemsFromAllDrives=true` + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    const data = await apiJson(deps, url);
    out.push(...(data.files || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return out;
}

// ── remote tree ───────────────────────────────────────────────────────────────
// Walks the remote folder into { files, natives, errors, foldersScanned, dirRels }.
// files: [{ rel, id, name, size, mtimeMs, md5 }] — rel uses '/' like the local engine.
// natives: Google-native docs (no downloadable bytes at this scope) reported as skips,
// matching the mount's placeholder-skip behavior. Shortcut files follow the job's
// followShortcuts option: on -> expand target under the shortcut's name (Drive gives us
// the target id directly — no .lnk parsing); off -> reported as a skip (a shortcut has
// no bytes to copy). Loop protection via visited folder ids per branch.
async function listTree(job, deps) {
  const exc = sync.compileGlobs(job.exclude);
  const sub = job.subfolders !== false;
  const follow = job.followShortcuts === true;
  const exportNative = job.exportNative === true;
  const out = { files: [], natives: [], errors: [], foldersScanned: 0, dirRels: new Set(), topCount: 0, filteredDirs: 0, stopped: false };

  async function walkFolder(folderId, relDir, chain) {
    if (deps.shouldStop && deps.shouldStop()) { out.stopped = true; return; }
    let kids;
    try { kids = await listChildren(deps, folderId); }
    catch (e) {
      // A stop mid-listing is not a listing FAILURE — flagging it as one would both
      // report a phantom error and (via the incomplete-listing guard) look scarier
      // than "the user pressed Stop".
      if (e.message === 'stopped') { out.stopped = true; return; }
      out.errors.push({ path: relDir || '(root)', error: e.message }); return;
    }
    out.foldersScanned++;
    if (!relDir) out.topCount = kids.length;
    const seenNames = new Set();
    for (const k of kids) {
      if (deps.shouldStop && deps.shouldStop()) return;
      let name = sanitizeName(k.name), mime = k.mimeType, id = k.id;
      let size = k.size, md5 = k.md5Checksum, mtime = k.modifiedTime;
      const lnkRel = relDir ? relDir + '/' + name : name;
      if (mime === SHORTCUT) {
        if (!follow) { out.natives.push({ path: lnkRel, note: 'Drive shortcut — turn on Follow shortcuts to copy its target' }); continue; }
        const tid = k.shortcutDetails && k.shortcutDetails.targetId;
        if (!tid) { out.errors.push({ path: lnkRel, error: 'shortcut has no target' }); continue; }
        let t;
        try { t = await fileMeta(deps, tid); }
        catch (e) { out.errors.push({ path: lnkRel, error: 'shortcut target is unreachable: ' + e.message }); continue; }
        mime = t.mimeType; id = t.id; size = t.size; md5 = t.md5Checksum; mtime = t.modifiedTime;
        // keep the shortcut's own (sanitized) name — same rule as the .lnk expansion
      }
      // A Google-native doc that isn't being exported produces NO on-disk file — it's a
      // skip and can't collide with anything, so it never enters the name dedup.
      const exp = (mime !== FOLDER && GNATIVE.test(mime)) ? (exportNative && EXPORT_MAP[mime]) : undefined;
      if (mime !== FOLDER && GNATIVE.test(mime) && !exp) {
        const rel = relDir ? relDir + '/' + name : name;
        out.natives.push({ path: rel, note: exportNative ? 'Google-native document — no Office export for this type' : 'Google-native document — no downloadable file content' });
        continue;
      }
      // Dedup on the ON-DISK name: an exported doc's name carries the Office extension,
      // so "Budget" (Sheet -> Budget.xlsx) collides with a real "Budget.xlsx" but NOT
      // with "Budget" (Doc -> Budget.docx). Two entries that would land on one Windows
      // path collide (Windows can't hold both); the first listed wins, the rest report.
      const outName = exp ? name + '.' + exp.ext : name;
      const dupKey = outName.toLowerCase();
      const rel = relDir ? relDir + '/' + outName : outName;
      if (mime === FOLDER && exc.length && sync.matches(exc, outName, rel)) { out.filteredDirs++; continue; }
      if (seenNames.has(dupKey)) { out.errors.push({ path: rel, error: 'duplicate name in the same Drive folder — only the first was used' }); continue; }
      seenNames.add(dupKey);
      if (mime === FOLDER) {
        if (chain.has(id)) { out.errors.push({ path: rel, error: 'shortcut loop skipped — folder already being visited' }); continue; }
        out.dirRels.add(rel.toLowerCase());
        if (sub) { const next = new Set(chain); next.add(id); await walkFolder(id, rel, next); }
        continue;
      }
      if (exp) {
        // No md5/size from Drive for a generated export — exportMime marks it for
        // time-only compare in planDrive.
        out.files.push({ rel, name: outName, id, size: 0, md5: '', mtimeMs: Date.parse(mtime || '') || 0, exportMime: exp.mime });
        continue;
      }
      out.files.push({ rel, name, id, size: Number(size) || 0, md5: md5 || '', mtimeMs: Date.parse(mtime || '') || 0 });
    }
  }
  const root = await resolveRootFolder(deps, job.folderId);
  await walkFolder(root.id, '', new Set([root.id]));
  return out;
}

// ── plan ──────────────────────────────────────────────────────────────────────
// Same summary shape as sync.plan so the band, stats, results view, and grand totals
// work unchanged. Compare modes: time (Drive modifiedTime vs local mtime, same
// tolerance), size, and content — Drive publishes each binary's md5Checksum, so content
// compare hashes only the LOCAL file (no download needed to know a file is unchanged).
async function md5OfFile(p) {
  const h = crypto.createHash('md5');
  await pipeline(fs.createReadStream(p), async function* (src) { for await (const c of src) h.update(c); });
  return h.digest('hex');
}

async function planDrive(job, deps) {
  const dst = String(job.dest);
  const inc = sync.compileGlobs(job.include), exc = sync.compileGlobs(job.exclude);
  const cmp = sync.resolveCompare(job);
  const out = { actions: [], scanned: 0, unchanged: 0, filtered: 0, mirrorProtected: 0, foldersScanned: 0, totalBytes: 0, errors: [], mirrorSkipped: null, nativeSkipped: [] };
  const stop = () => deps.shouldStop && deps.shouldStop();
  const prog = (rel, op, reason) => { if (deps.onProgress) deps.onProgress({ phase: 'scan', scanned: out.scanned, rel, op, reason }); };

  const tree = await listTree(job, deps);
  out.errors.push(...tree.errors);
  out.foldersScanned = tree.foldersScanned;
  out.filtered += tree.filteredDirs; // excluded remote folders count as filtered (local-engine parity)
  out.nativeSkipped = tree.natives;
  const remote = new Set(tree.dirRels); // lowercased rels present remotely (dirs + files)
  // Natives and unfollowed shortcuts ARE remote-present — without them in the set, a
  // same-named destination entry would be mirror-deleted out from under them.
  for (const n of tree.natives) remote.add(String(n.path).toLowerCase());

  for (const f of tree.files) {
    if (stop()) break;
    remote.add(f.rel.toLowerCase());
    out.scanned++;
    prog(f.rel);
    if (exc.length && sync.matches(exc, f.name, f.rel)) { out.filtered++; prog(f.rel, 'filtered'); continue; }
    if (inc.length && !sync.matches(inc, f.name, f.rel)) { out.filtered++; prog(f.rel, 'filtered'); continue; }
    let reason = 'all files';
    if (cmp.mode !== 'all') {
      const to = path.join(dst, f.rel);
      let d = null;
      try { d = await fsp.stat(to); } catch {}
      if (!d) reason = 'new file';
      else if (f.exportMime) {
        // An exported doc carries no Drive checksum or byte size — modification time is
        // the only comparable signal (we stamp the local file with it on write). If the
        // job compares by size/content only, re-export so the copy can't silently drift.
        reason = '';
        if (cmp.time) {
          const diff = f.mtimeMs - d.mtimeMs;
          if (Math.abs(diff) > sync.MTIME_TOLERANCE_MS && (!cmp.newerOnly || diff > 0)) reason = cmp.newerOnly ? 'source newer' : 'time differs';
        } else if (cmp.size || cmp.content) reason = 'exported doc'; // no time signal for an export; size/content can't apply -> re-export. Pure no-criteria leaves it (parity with binaries).
      }
      else {
        reason = '';
        if (cmp.time) {
          const diff = f.mtimeMs - d.mtimeMs;
          if (Math.abs(diff) > sync.MTIME_TOLERANCE_MS && (!cmp.newerOnly || diff > 0)) reason = cmp.newerOnly ? 'source newer' : 'time differs';
        }
        if (!reason && cmp.content && !f.md5) {
          // Drive publishes no checksum for this file (rare) — saying nothing would make
          // content compare silently blind to its changes forever.
          out.errors.push({ path: f.rel, error: 'Drive provides no checksum for this file — content compare cannot see its changes (time/size compares still work)' });
        }
        if (!reason && cmp.size && f.size !== d.size) reason = 'size differs';
        if (!reason && cmp.content && f.md5) {
          try { if ((await md5OfFile(to)) !== f.md5.toLowerCase()) reason = 'content differs'; }
          catch (e) { out.errors.push({ path: f.rel, error: e.message }); prog(f.rel, 'error'); continue; }
        }
      }
    }
    if (reason) { out.actions.push({ op: 'copy', rel: f.rel, size: f.size, mtimeMs: f.mtimeMs, driveId: f.id, exportMime: f.exportMime, reason }); out.totalBytes += f.size; prog(f.rel, 'copy', reason); }
    else { out.unchanged++; prog(f.rel, 'same'); }
  }

  if (job.mirror && tree.errors.length) {
    // Any listing failure means the remote picture is INCOMPLETE — planning deletions
    // from an incomplete listing could wipe dest content that still exists remotely.
    out.mirrorSkipped = 'the Drive listing had errors — deletions skipped to protect the destination';
  } else if (job.mirror && job.testSource !== false && tree.topCount === 0) {
    out.mirrorSkipped = 'the Drive folder reads as empty — deletions skipped (Test connection to source is on)';
  } else if (job.mirror && !stop()) {
    const progD = rel => { if (deps.onProgress) deps.onProgress({ phase: 'mirror', scanned: out.scanned, rel }); };
    async function walkDst(relDir) {
      if (stop()) return;
      let entries;
      try { entries = await fsp.readdir(path.join(dst, relDir), { withFileTypes: true }); }
      catch (e) { if (relDir) out.errors.push({ path: relDir, error: e.message }); return; }
      for (const ent of entries) {
        if (stop()) return;
        const rel = relDir ? relDir + '/' + ent.name : ent.name;
        progD(rel);
        if (exc.length && sync.matches(exc, ent.name, rel)) { out.mirrorProtected++; continue; }
        // The engine's own swap temps are never mirror fodder — a leftover .~fsync-old
        // is the last good copy of a file whose replacement failed mid-swap.
        if (/\.~fsync-(old|dl)$/i.test(ent.name)) continue;
        const present = remote.has(rel.toLowerCase());
        if (ent.isDirectory()) {
          if (job.subfolders === false) continue;
          if (!present) out.actions.push({ op: 'deldir', rel });
          else await walkDst(rel);
        } else if (!present) {
          out.actions.push({ op: 'del', rel });
        }
      }
    }
    await walkDst('');
  }
  return out;
}

// ── execute ───────────────────────────────────────────────────────────────────
// Downloads land in a temp file beside the target, then swap in with the same
// safe-replace guarantees as the local engine: the previous good copy is set aside
// first and restored if the download fails — an interrupted download can never leave
// a truncated file where a good backup used to be. Deletions (mirror) are delegated
// to sync.execute so Recycle Bin/unlock behavior stays identical.
async function downloadTo(deps, driveId, dest, exportMime) {
  const f = deps.fetchImpl || fetch;
  const token = await deps.getToken();
  if (!token) throw new Error('Google Drive is not connected');
  // Native docs come through files.export (converted bytes); binaries through alt=media.
  const url = exportMime
    ? `${API}/files/${encodeURIComponent(driveId)}/export?mimeType=${encodeURIComponent(exportMime)}`
    : `${API}/files/${encodeURIComponent(driveId)}?alt=media&supportsAllDrives=true`;
  const res = await f(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // files.export refuses anything over 10 MB — give the real reason, not a raw 403.
    if (exportMime && /exportSizeLimitExceeded/i.test(body)) {
      throw new Error('too large to export — Google caps document export at 10 MB');
    }
    throw new Error((exportMime ? 'export' : 'download') + ' failed HTTP ' + res.status + ': ' + body.slice(0, 200));
  }
  await pipeline(res.body, fs.createWriteStream(dest));
}

async function executeDrive(job, actions, deps) {
  const dst = String(job.dest);
  const res = { copied: 0, deleted: 0, bytes: 0, recycled: 0, foldersCreated: 0, foldersDeleted: 0, errors: [], skipped: [], stopped: false };
  async function ensureDir(dir) {
    const made = await fsp.mkdir(dir, { recursive: true });
    if (made) res.foldersCreated += 1 + (dir.length > made.length ? dir.slice(made.length).split(path.sep).filter(Boolean).length : 0);
  }
  const dl = deps.downloadTo || ((id, to, exportMime) => downloadTo(deps, id, to, exportMime));
  const copies = actions.filter(x => x.op === 'copy');
  const dels = actions.filter(x => x.op === 'del' || x.op === 'deldir');
  const total = copies.length + dels.length;
  let done = 0;
  const prog = a => { done++; if (deps.onProgress) deps.onProgress({ phase: 'run', done, total, op: a.op, rel: a.rel, reason: a.reason, bytes: res.bytes }); };
  for (const a of copies) {
    if (deps.shouldStop && deps.shouldStop()) { res.stopped = true; break; }
    const to = path.join(dst, a.rel);
    const tmp = to + '.~fsync-dl';
    try {
      await ensureDir(path.dirname(to));
      // A leftover .~fsync-old from a crashed earlier swap holds the last known-good
      // copy — restore it BEFORE anything can fail (sync.execute's order): if this
      // download fails too, the restored file is what remains at the destination.
      if (!job.deleteBeforeCopy) {
        const old = to + '.~fsync-old';
        try { await fsp.access(old); try { await fsp.rm(to, { force: true }); } catch {}; await fsp.rename(old, to); } catch {}
      }
      await dl(a.driveId, tmp, a.exportMime);
      // An export's byte size is unknown until it's written — measure it for the stats
      // (a second attempt after the swap covers a transient stat failure on the temp).
      let wrote = a.size || 0;
      if (a.exportMime) { try { wrote = (await fsp.stat(tmp)).size; } catch {} }
      if (job.deleteBeforeCopy) { try { await fsp.rm(to, { force: true }); } catch {} }
      let aside = null;
      if (!job.deleteBeforeCopy) {
        try { await fsp.rename(to, to + '.~fsync-old'); aside = to + '.~fsync-old'; } catch {} // ENOENT: nothing to save
      }
      try { await fsp.rename(tmp, to); }
      catch (e) {
        if (aside) { try { await fsp.rm(to, { force: true }); } catch {}; try { await fsp.rename(aside, to); } catch {} }
        throw e;
      }
      if (aside) { try { await fsp.rm(aside, { force: true }); } catch {} }
      // Fallback for an export whose temp stat failed: read the size off the swapped-in
      // file so the byte total isn't silently short.
      if (a.exportMime && !wrote) { try { wrote = (await fsp.stat(to)).size; } catch {} }
      try { await fsp.utimes(to, new Date(), new Date(a.mtimeMs)); }
      catch (e) { res.errors.push({ path: a.rel, error: 'downloaded, but could not set the timestamp: ' + e.message }); }
      res.copied++; res.bytes += wrote;
    } catch (e) {
      try { await fsp.rm(tmp, { force: true }); } catch {}
      if (e.message === 'stopped') { res.stopped = true; break; }
      res.errors.push({ path: a.rel, error: e.message });
    }
    prog(a);
  }
  if (dels.length && !res.stopped) {
    const d = await sync.execute(job, dels, { trash: deps.trash, shouldStop: deps.shouldStop, onProgress: deps.onProgress ? p => deps.onProgress({ ...p, done: done + p.done, total }) : undefined });
    res.deleted = d.deleted; res.recycled = d.recycled; res.foldersDeleted = d.foldersDeleted;
    res.errors.push(...d.errors);
    if (d.stopped) res.stopped = true;
  }
  return res;
}

module.exports = { SCOPES, sanitizeName, listTree, planDrive, executeDrive, folderName, fileMeta };
