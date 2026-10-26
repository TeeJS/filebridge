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

function createStatusWriter({ file, snapshot, now = Date.now, minIntervalMs = 1000, heartbeatMs = 30000, onError = () => {} }) {
  let lastWrite = 0;
  let timer = null;
  let heartbeat = null;

  function writeNow(extra) {
    clearTimeout(timer);
    timer = null;
    lastWrite = now();
    try {
      const doc = Object.assign({ schema: SCHEMA, running: true }, snapshot(), extra || {}, { heartbeatAt: new Date(lastWrite).toISOString() });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
      fs.renameSync(tmp, file);
    } catch (e) { onError(e); } // best-effort: a viewer just sees an older heartbeat
  }

  // Coalesce bursts: the first change writes immediately, later ones within the window are
  // folded into one trailing write.
  function touch() {
    if (timer) return;
    const wait = lastWrite + minIntervalMs - now();
    if (wait <= 0) writeNow();
    else { timer = setTimeout(writeNow, wait); if (timer.unref) timer.unref(); }
  }

  function start() {
    writeNow();
    heartbeat = setInterval(writeNow, heartbeatMs);
    if (heartbeat.unref) heartbeat.unref();
  }

  // On quit: one last write saying the app is no longer running, so a viewer can say so at
  // once instead of waiting for the heartbeat to go stale.
  function stop() {
    clearInterval(heartbeat); heartbeat = null;
    writeNow({ running: false, current: null, queue: [] });
  }

  return { touch, writeNow, start, stop };
}

module.exports = { createStatusWriter, SCHEMA };
