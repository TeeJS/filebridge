'use strict';
// status.json — FileBridge's one-way status feed for read-only viewers (the Bedrock Panel
// monitor). Contract v1 (PROJECT.md):
// - written atomically (temp file + rename), so a reader never sees a half-written file;
// - on demand via touch(), at most once per minIntervalMs (1 s): run start/end, live progress,
//   job and settings changes;
// - rewritten every heartbeatMs (30 s) regardless, so a stale heartbeatAt means "not running"
//   (a clean quit also writes running:false right away);
// - never contains secrets, tokens, cookies, or rule contents — snapshot() builds it from
//   run state and job metadata only.

const fs = require('fs');
const path = require('path');

const SCHEMA = 1;

// A reader that opens the file without FILE_SHARE_DELETE (.NET File.Open, PowerShell) makes the
// replace fail with EPERM/EBUSY for the moment it holds it — wait briefly and try again.
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function replaceWithRetry(tmp, file, tries = 4) {
  for (let i = 1; ; i++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) {
      if (i >= tries || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      sleepSync(50);
    }
  }
}

function createStatusWriter({ file, snapshot, now = Date.now, minIntervalMs = 1000, heartbeatMs = 30000, onError = () => {} }) {
  let lastWrite = 0;
  let timer = null;
  let heartbeat = null;
  let stopped = false;   // after stop()'s final write, nothing may overwrite running:false
  let failing = false;   // report a failure once, not every second until it clears

  function write(extra) {
    clearTimeout(timer);
    timer = null;
    lastWrite = now();
    try {
      const doc = Object.assign({ schema: SCHEMA, running: true }, snapshot(), extra || {}, { heartbeatAt: new Date(lastWrite).toISOString() });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
      replaceWithRetry(tmp, file);
      failing = false;
    } catch (e) { // best-effort: a viewer just sees an older heartbeat
      if (!failing) { failing = true; onError(e); }
    }
  }
  function writeNow() { if (!stopped) write(); }

  // Coalesce bursts: the first change writes immediately, later ones within the window are
  // folded into one trailing write.
  function touch() {
    if (stopped || timer) return;
    const wait = lastWrite + minIntervalMs - now();
    if (wait <= 0) writeNow();
    else { timer = setTimeout(writeNow, wait); if (timer.unref) timer.unref(); }
  }

  function start() {
    stopped = false;
    writeNow();
    heartbeat = setInterval(writeNow, heartbeatMs);
    if (heartbeat.unref) heartbeat.unref();
  }

  // On quit: one last write saying the app is no longer running, so a viewer can say so at
  // once instead of waiting for the heartbeat to go stale. Later touches (a run unwinding
  // after the stop flag) are ignored.
  function stop() {
    if (stopped) return;
    clearInterval(heartbeat); heartbeat = null;
    write({ running: false, current: null, queue: [] });
    stopped = true;
  }

  return { touch, writeNow, start, stop };
}

module.exports = { createStatusWriter, SCHEMA };
