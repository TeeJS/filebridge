'use strict';
// FileBridge web jobs — download new releases from subscription sites via per-site
// rule files, driving a hidden Electron BrowserWindow with a persistent, signed-in
// session partition. Pure helpers up top (tested by test.js without Electron); the
// runner at the bottom requires Electron lazily, so this module loads anywhere.
//
// Auth model: the user signs in ONCE per site in a real visible window (their password
// goes to the site's own page, never through this app); runs reuse those cookies. A run
// that finds itself signed out stops with a clear "open the sign-in window" status.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// ── rule validation ───────────────────────────────────────────────────────────
// A rule file is the user-supplied "instructions file" for a family of sites: which
// hostnames it applies to (`match`), where the drops are listed, what counts as an
// item, and how its download is triggered. The app ships NO site-specific rules —
// every user brings rule files for the sites they subscribe to. Returns error or null.
function validateRule(r) {
  if (!r || typeof r !== 'object') return 'a rule must be a JSON object';
  if (!String(r.site || '').match(/^[a-z0-9-]{2,40}$/)) return 'rule.site must be a short lowercase id (a-z, 0-9, -)';
  const match = Array.isArray(r.match) ? r.match : [r.match];
  if (!match.length || match.some(m => !/^[a-z0-9.-]{3,120}$/i.test(String(m || '')))) {
    return 'rule.match must be a hostname (or list of hostnames) the rule applies to, e.g. "example.com"';
  }
  if (!Array.isArray(r.sources) || !r.sources.length) return 'rule.sources must list at least one source';
  for (const s of r.sources) {
    if (!s || typeof s !== 'object') return 'each source must be an object';
    if (!String(s.id || '').match(/^[a-z0-9-]{1,40}$/)) return 'source.id must be a short lowercase id';
    if (s.mode !== 'sequential' && s.mode !== 'listing') return `source "${s.id}": mode must be "sequential" or "listing"`;
    if (s.mode === 'sequential' && !/\{n\}/.test(String(s.pattern || ''))) return `source "${s.id}": sequential mode needs a pattern containing {n}`;
    if (s.mode === 'listing' && !String(s.collectionHrefIncludes || '').trim()) return `source "${s.id}": listing mode needs collectionHrefIncludes (a substring that identifies collection links)`;
    // listUrl is optional — it defaults to the page of the URL pasted into the job.
  }
  if (!r.collection || (!String(r.collection.itemSel || '') && r.collection.selfItem !== true)) {
    return 'rule.collection needs itemSel (selector for item links on a collection page) or selfItem: true (each collection page IS the downloadable item)';
  }
  // downloadClickText: "text" | ["menu text", "download text"] | ["menu text", ["a","b"]] —
  // texts clicked in order; the LAST step may be a list, downloading several files.
  // downloadAllSel (optional): a selector for the chooser's rows — the control inside
  // EVERY visible match is clicked, so per-product label differences don't matter; with
  // it set, all downloadClickText steps are treated as drill-in clicks only.
  const okStr = v => typeof v === 'string' && v.trim();
  const dct = r.item && r.item.downloadClickText;
  const dctOk = okStr(dct) || (Array.isArray(dct) && dct.length &&
    dct.every((v, i) => okStr(v) || (i === dct.length - 1 && Array.isArray(v) && v.length && v.every(okStr))));
  if (!dctOk) return 'rule.item.downloadClickText must be the download control\'s visible text — a string, or a list of texts clicked in order (the last may itself be a list to download several files)';
  if (r.item.downloadAllSel != null && !okStr(r.item.downloadAllSel)) return 'rule.item.downloadAllSel must be a CSS selector string';
  if (r.delayMs != null && !(Number(r.delayMs) >= 500)) return 'delayMs must be at least 500';
  return null;
}

// Which rule handles this URL? Hostname suffix match against rule.match — so
// "example.com" in a rule matches www.example.com. Returns the rule or null.
function findRule(urlStr, rules) {
  let host;
  try { host = new URL(String(urlStr)).hostname.toLowerCase(); } catch { return null; }
  for (const r of Object.values(rules || {})) {
    const match = Array.isArray(r.match) ? r.match : [r.match];
    for (const m of match) {
      const mm = String(m || '').toLowerCase();
      if (mm && (host === mm || host.endsWith('.' + mm))) return r;
    }
  }
  return null;
}

// ── names and destination paths ───────────────────────────────────────────────
function sanitizeName(s) {
  const clean = String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  return (clean || 'unnamed').slice(0, 120);
}

// pathPattern -> relative folder for one item. Tokens: {site} {collection} {item} {yyyy} {mm} {dd}.
function itemDir(pattern, parts, when) {
  const d = when instanceof Date ? when : new Date();
  const p2 = n => String(n).padStart(2, '0');
  const map = {
    site: parts.site, collection: parts.collection, item: parts.item,
    yyyy: String(d.getFullYear()), mm: p2(d.getMonth() + 1), dd: p2(d.getDate()),
  };
  // A token whose part is missing empties its segment (dropped below) rather than
  // materializing an "unnamed" folder level.
  const rel = String(pattern || '{collection}\\{item}')
    .replace(/\{(site|collection|item|yyyy|mm|dd)\}/g, (_, k) => String(map[k] == null ? '' : map[k]))
    .split(/[\\/]+/).map(s => s.trim()).filter(Boolean).map(sanitizeName).join(path.sep);
  return rel || sanitizeName(parts.item);
}

// ── seen ledger decisions ─────────────────────────────────────────────────────
// The ledger maps a stable site identity (item URL path) to what we downloaded.
// Collections complete when every item in them succeeded; the walk stops after N
// consecutive fully-seen collections so nightly runs never re-crawl history.
function collectionKey(sourceId, collectionId) { return sourceId + ':' + collectionId; }

// Given collection ids NEWEST-FIRST, pick which to visit this run: the newest `cap`
// not-yet-seen collections ('all' = every unseen one). The cap applies to EVERY run,
// so a deep backlog is worked through a few collections per scheduled run and the
// seen-ledger converges night by night without tying the machine up.
function planCollections(idsNewestFirst, seenCollections, cap) {
  const limit = cap === 'all' || cap == null ? Infinity : Math.max(0, Number(cap) || 0);
  const out = [];
  for (const id of idsNewestFirst) {
    if (out.length >= limit) break;
    if (seenCollections.has(id)) continue;
    out.push(id);
  }
  return out;
}

// Sequential ids from a pattern: "/drops/drop-{n}" + numbers found on the list page.
function sequentialIds(pattern, numbersOnListPage) {
  const nums = [...new Set(numbersOnListPage.filter(n => Number.isInteger(n) && n > 0))].sort((a, b) => b - a);
  return nums.map(n => pattern.replace('{n}', String(n)));
}

// Extract the {n} numbers for a sequential pattern from hrefs on the listing page.
function numbersFromHrefs(pattern, hrefs) {
  const esc = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\{n\\}', '(\\d+)');
  const rx = new RegExp(esc + '$');
  const out = [];
  for (const h of hrefs || []) {
    const m = rx.exec(String(h || '').replace(/[?#].*$/, ''));
    if (m) out.push(Number(m[1]));
  }
  return out;
}

// ── seen ledger files ─────────────────────────────────────────────────────────
const seenPath = (dataDir, id) => path.join(dataDir, 'seen-' + String(id).replace(/[^a-z0-9]/gi, '') + '.json');
function loadSeen(dataDir, jobId) {
  try {
    const s = JSON.parse(fs.readFileSync(seenPath(dataDir, jobId), 'utf8'));
    return { collections: s.collections || {}, items: s.items || {} };
  } catch { return { collections: {}, items: {} }; }
}
function saveSeen(dataDir, jobId, seen) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = seenPath(dataDir, jobId) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(seen, null, 2));
  fs.renameSync(tmp, seenPath(dataDir, jobId));
}

// ── validation for web jobs (kind: 'web') ─────────────────────────────────────
// A web job is just a URL + a folder; the URL picks the rule file by hostname.
function validateWebJob(job, rules) {
  if (!job || !String(job.name || '').trim()) return 'a job name is required';
  if (!/^https:\/\/[^\s]+$/i.test(String(job.url || ''))) return 'paste the site page to watch as an https:// URL';
  if (!findRule(job.url, rules)) return 'no rule file matches this URL — add one under Rules (match its hostname)';
  if (!/^[a-zA-Z]:[\\/]/.test(String(job.dest || '')) && !/^\\\\[^\\]/.test(String(job.dest || ''))) {
    return 'destination must be a full path (C:\\… or \\\\server\\share\\…)';
  }
  const bf = job.backfill;
  if (bf !== 'all' && bf != null && !(Number.isInteger(Number(bf)) && Number(bf) >= 0)) return 'backfill must be "all" or a whole number';
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

class NeedsLogin extends Error {
  constructor(site) { super('not signed in to ' + site + ' — open the sign-in window, log in, then run again'); this.needsLogin = true; }
}

// ── the browser runner ────────────────────────────────────────────────────────
// opts: { dataDir, dryRun, log(line), setPhase(phase, detail), setCounts(counts), shouldStop() }
async function runWebJob(job, rule, opts) {
  const { BrowserWindow, session } = require('electron');
  const partition = 'persist:webdrops-' + rule.site;
  const ses = session.fromPartition(partition);
  const win = new BrowserWindow({
    show: false, width: 1366, height: 950,
    // backgroundThrottling off: hidden windows otherwise throttle timers, and sites that
    // poll for server-side download preparation would stall.
    webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const dryRun = !!opts.dryRun;
  // The JOB's pasted URL is the anchor: its origin is the base for every path in the
  // rule, and its page is the default listing when a source names no listUrl of its own.
  const jobUrl = new URL(job.url);
  const base = jobUrl.origin;
  const defaultListPath = jobUrl.pathname + (jobUrl.search || '');
  const stop = () => opts.shouldStop && opts.shouldStop();
  const summary = {
    downloaded: [], wouldDownload: [], skippedSeen: 0, collectionsVisited: 0,
    bytes: 0, errors: [],
  };
  const seen = loadSeen(opts.dataDir, job.id);

  // Download capture: the session outlives the run, so the listener MUST be removed in
  // the finally. Only downloads we asked for (pending != null) are accepted — anything
  // arriving between items (a stray from a timed-out click) is refused outright.
  let pending = null; // { dir, items: [], files: [], doneReports: 0, failedDownloads: 0, lastEvent }
  const onDownload = (event, item) => {
    if (!pending) { event.preventDefault(); return; }
    const p = pending;
    p.lastEvent = Date.now();
    p.items.push(item);
    const file = path.join(p.dir, sanitizeName(item.getFilename() || 'download'));
    item.setSavePath(file);
    item.once('done', (_e, state) => {
      p.lastEvent = Date.now();
      p.doneReports++;
      if (state === 'completed') p.files.push({ file, bytes: item.getReceivedBytes() });
      else p.failedDownloads++;
    });
  };
  ses.on('will-download', onDownload);

  // Find an element by its visible text: exact match on any visible element first (so
  // "stl" hits the dialog's STL row, not a nav item merely containing the letters), then
  // substring match on real controls; the LAST match wins (dialogs render last). The
  // CLICK lands on the real control even when the text itself is inert: many sites pair
  // an icon-only <button> with a text label beside it — so resolve, in order, a clickable
  // ancestor, the single control inside the text's element, then the single control in a
  // nearby ancestor (the row), before falling back to the text element itself.
  const textFinderJs = (text, doClick) => `(() => {
    const t = ${JSON.stringify(String(text).toLowerCase())};
    const vis = e => e.offsetParent !== null;
    const all = [...document.querySelectorAll('a,button,[role=button],div,span,label,p')].filter(vis);
    const exact = all.filter(e => (e.innerText || '').trim().toLowerCase() === t);
    const controls = [...document.querySelectorAll('a,button,[role=button]')].filter(vis);
    const inc = controls.filter(e => (e.innerText || '').trim().toLowerCase().includes(t));
    const pool = exact.length ? exact : inc;
    const el = pool[pool.length - 1];
    if (!el) return false;
    ${doClick ? `
    let target = el.closest('a,button,[role=button]');
    if (!target) {
      const inside = el.querySelectorAll('a,button,[role=button]');
      if (inside.length === 1) target = inside[0];
    }
    if (!target) {
      let anc = el.parentElement;
      for (let i = 0; i < 3 && anc && !target; i++, anc = anc.parentElement) {
        const btns = anc.querySelectorAll('a,button,[role=button]');
        if (btns.length === 1) target = btns[0];
      }
    }
    (target || el).click();` : ''}
    return true;
  })()`;

  const nav = async url => {
    if (stop()) throw new Error('stopped');
    await win.loadURL(url);
    // Some pages defer work while document.hidden — a hidden runner window reports
    // hidden, so shim visibility to keep prep-pollers and download triggers alive.
    await win.webContents.executeJavaScript(`try {
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
      Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    } catch (e) {} true`, true).catch(() => {});
    await sleep(1800); // SPA settle — content renders after load
    // A session that expired mid-run turns every navigation into a login redirect —
    // surface that as needs-sign-in, not as N cryptic per-item errors.
    const outs = (rule.auth && rule.auth.loggedOutUrlIncludes) || [];
    const here = win.webContents.getURL();
    if (outs.some(s => here.includes(s))) throw new NeedsLogin(rule.site);
  };
  const evalJs = code => win.webContents.executeJavaScript(code, true);
  const waitFor = async (predicateJs, timeoutMs) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (stop()) throw new Error('stopped');
      if (await evalJs(predicateJs).catch(() => false)) return true;
      await sleep(500);
    }
    return false;
  };
  const assertSignedIn = async () => {
    const url = win.webContents.getURL();
    const outs = (rule.auth && rule.auth.loggedOutUrlIncludes) || [];
    if (outs.some(s => url.includes(s))) throw new NeedsLogin(rule.site);
    if (rule.auth && rule.auth.probeSel) {
      // Generous wait: some sites verify membership with a third party (e.g. a
      // "Checking Patreon access…" phase) before the signed-in UI renders.
      const there = await waitFor(`!!document.querySelector(${JSON.stringify(rule.auth.probeSel)})`, 20000);
      if (!there) throw new NeedsLogin(rule.site);
    }
  };

  try {
    for (const source of rule.sources) {
      if (stop()) break;
      opts.setPhase('listing', source.id);
      await nav(base + (source.listUrl || defaultListPath));
      await assertSignedIn();
      // Wait for the listing to actually SHOW collection links — some sites render the
      // list only after a membership check that outlives the SPA settle. And zero
      // collections is an ERROR, never a quiet success: an empty listing means "not
      // rendered / not signed in / wrong selector", not "nothing exists".
      const includes = String(source.collectionHrefIncludes || '');
      const patternRx = source.mode === 'sequential'
        ? source.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\{n\\}', '\\d+') + '$'
        : null;
      const linkProbeJs = source.mode === 'sequential'
        ? `[...document.querySelectorAll('a[href]')].some(a => new RegExp(${JSON.stringify(patternRx)}).test(a.href.replace(/[?#].*$/, '')))`
        : `[...document.querySelectorAll('a[href]')].some(a => a.href.includes(${JSON.stringify(includes)}))`;
      await waitFor(linkProbeJs, 20000);
      const seenColls = new Set(Object.keys(seen.collections)
        .filter(k => k.startsWith(source.id + ':')).map(k => k.slice(source.id.length + 1)));
      const toColl = pth => ({ path: pth, name: pth.replace(/\/+$/, '').split('/').pop() });
      // Accumulate matching links across scroll rounds (a virtualized list may DROP
      // earlier DOM nodes as it renders later ones, so a single snapshot lies twice).
      const matched = new Set();
      const harvest = async () => {
        const hrefs = await evalJs(`[...document.querySelectorAll('a[href]')].map(a => a.href)`).catch(() => []);
        for (const h of hrefs) {
          if (typeof h !== 'string') continue;
          if (source.mode === 'sequential') { if (new RegExp(patternRx).test(h.replace(/[?#].*$/, ''))) matched.add(h); }
          else if (includes && h.includes(includes)) matched.add(h);
        }
        return source.mode === 'sequential'
          ? sequentialIds(source.pattern, numbersFromHrefs(source.pattern, [...matched])).map(toColl)
          : [...new Set([...matched].map(h => new URL(h).pathname))].map(toColl);
      };
      let colls = await harvest(); // [{ path, name }] newest-first — the NAME is the ledger identity
      // Lazy/infinite-scroll listings render only a screenful at first, which would trap
      // every run on the same few newest cards. Scroll-and-recount until enough UNSEEN
      // collections exist to satisfy the per-run cap, or three scrolls add nothing
      // (the listing is fully rendered / has no more to load).
      const capRaw = job.backfill == null ? 4 : job.backfill;
      const capN = capRaw === 'all' ? Infinity : Math.max(0, Number(capRaw) || 0);
      let flat = 0;
      for (let round = 0; round < 200 && flat < 3 && !stop(); round++) {
        if (colls.filter(c => !seenColls.has(c.name)).length >= capN) break;
        const before = colls.length;
        await evalJs(`window.scrollTo(0, document.scrollingElement.scrollHeight); true`).catch(() => {});
        await sleep(1200);
        colls = await harvest();
        flat = colls.length > before ? 0 : flat + 1;
      }
      if (!colls.length) {
        summary.errors.push({ item: source.listUrl || defaultListPath, error: 'no collections found on the listing page — check that the session is signed in and the rule\'s pattern/collectionHrefIncludes matches' });
        opts.log(`ERROR ${job.name}: ${source.id} — no collections found on the listing`);
        continue;
      }
      // Per-run cap (default 4): every run takes the newest unseen collections up to the
      // cap — a scheduled job digests a deep backlog a few collections per run.
      const plannedNames = planCollections(colls.map(c => c.name), seenColls, capRaw);
      const nSeen = colls.filter(c => seenColls.has(c.name)).length;
      opts.log(`${job.name}: ${source.id} — ${colls.length} collections on the listing (${nSeen} already seen) — visiting ${plannedNames.length} this run`);

      for (const c of plannedNames.slice().reverse().map(nm => colls.find(x => x.name === nm))) { // oldest first
        if (stop()) break;
        const collName = c.name;
        opts.setPhase('collection', collName);
        summary.collectionsVisited++;
        let itemHrefs;
        let collErrors = 0;
        if (rule.collection.selfItem) {
          // Single-level site: the collection page itself is the downloadable item.
          itemHrefs = [base + c.path];
        } else {
          await nav(base + c.path);
          // A slow render or an errored page must NOT read as "empty collection, complete":
          // wait for at least one item link, and treat none as a retryable error.
          await waitFor(`!!document.querySelector(${JSON.stringify(rule.collection.itemSel)})`, 15000);
          itemHrefs = [...new Set(await evalJs(
            `[...document.querySelectorAll(${JSON.stringify(rule.collection.itemSel)})].map(a => a.href)`))]
            .filter(h => typeof h === 'string' && h.startsWith(base));
          if (!itemHrefs.length) {
            summary.errors.push({ item: c.path, error: 'no items found on the collection page — will retry next run' });
            opts.log(`ERROR ${job.name}: ${c.path} — no items found`);
            continue; // NOT marked complete
          }
        }
        for (const itemHref of itemHrefs) {
          if (stop()) break;
          const itemPath = new URL(itemHref).pathname;
          if (seen.items[itemPath]) { summary.skippedSeen++; continue; }
          if (dryRun) { summary.wouldDownload.push({ collection: collName, item: itemPath }); continue; }
          opts.setPhase('item', itemPath);
          try {
            await nav(itemHref);
            const name = sanitizeName(
              (rule.item.nameSel ? await evalJs(
                `(document.querySelector(${JSON.stringify(rule.item.nameSel)}) || {}).innerText || ''`).catch(() => '') : '')
              || itemPath.split('/').pop());
            const dir = path.join(job.dest, itemDir(job.pathPattern || rule.pathPattern, { site: rule.site, collection: collName, item: name }));
            await fsp.mkdir(dir, { recursive: true });
            // Click through the download steps: drill clicks open menus/dialogs, then either
            // downloadAllSel clicks the control in EVERY chooser row (label-proof — row names
            // vary per item on some sites), or the last downloadClickText step's text(s) are
            // clicked by name. A click that NAVIGATES AWAY is an immediate error: it kills
            // the page's prep-pollers, so waiting any longer would be silent failure.
            const stepsRaw = Array.isArray(rule.item.downloadClickText) ? rule.item.downloadClickText : [rule.item.downloadClickText];
            const allSel = String(rule.item.downloadAllSel || '');
            const terminal = allSel ? [] : (Array.isArray(stepsRaw[stepsRaw.length - 1]) ? stepsRaw[stepsRaw.length - 1] : [stepsRaw[stepsRaw.length - 1]]);
            const drill = allSel ? stepsRaw.filter(s => typeof s === 'string') : stepsRaw.slice(0, -1);
            const pagePath = new URL(win.webContents.getURL()).pathname;
            const samePage = () => { try { return new URL(win.webContents.getURL()).pathname === pagePath; } catch { return false; } };
            const p = { dir, items: [], files: [], doneReports: 0, failedDownloads: 0, lastEvent: Date.now() };
            pending = p;
            for (const stepText of drill) {
              if (!await waitFor(textFinderJs(stepText, false), 15000)) throw new Error('"' + stepText + '" control not found on the page');
              await evalJs(textFinderJs(stepText, true));
              await sleep(900); // let the menu/dialog render
              if (!samePage()) throw new Error('clicking "' + stepText + '" navigated away — check the rule\'s texts/selectors');
            }
            const timeout = Number(rule.item.downloadTimeoutMs) || 600000;
            let clickFailures = 0;
            // Click EVERY download control up front — sites that prepare files server-side
            // (spinner on the button, download starts when ready) then prepare them all in
            // parallel, so an item costs max(prep times), not the sum of the timeouts.
            let expected = 0;
            if (allSel) {
              if (!await waitFor(`!![...document.querySelectorAll(${JSON.stringify(allSel)})].find(e => e.offsetParent !== null)`, 15000)) {
                throw new Error('no download rows matched ' + allSel);
              }
              expected = Number(await evalJs(`(() => {
                const rows = [...document.querySelectorAll(${JSON.stringify(allSel)})].filter(e => e.offsetParent !== null);
                let n = 0;
                for (const row of rows) { ((row.querySelector('a,button,[role=button]')) || row).click(); n++; }
                return n;
              })()`)) || 0;
              if (!expected) throw new Error('no clickable download rows found for ' + allSel);
              await sleep(900);
              if (!samePage()) throw new Error('a download-row click navigated away — check downloadAllSel');
            } else {
              for (const dlText of terminal) {
                if (stop()) throw new Error('stopped');
                if (!await waitFor(textFinderJs(dlText, false), 15000)) {
                  clickFailures++;
                  opts.log(`ERROR ${job.name}: "${dlText}" control not found for ${itemPath}`);
                  continue;
                }
                await evalJs(textFinderJs(dlText, true));
                expected++;
                await sleep(1200); // brief gap between clicks
                if (!samePage()) throw new Error('clicking "' + dlText + '" navigated away — check the rule\'s texts');
              }
            }
            // Stop-aware wait for the downloads to BEGIN (preparation can take minutes).
            const startDeadline = Date.now() + timeout;
            while (p.items.length < expected && Date.now() < startDeadline) {
              if (stop()) throw new Error('stopped');
              opts.setPhase('item', itemPath + ' — ' + p.items.length + '/' + expected + ' downloads started');
              await sleep(500);
            }
            if (p.items.length < expected) {
              clickFailures += expected - p.items.length;
              opts.log(`ERROR ${job.name}: ${expected - p.items.length} download(s) never started for ${itemPath}`);
            }
            // Settle: every accepted download reports done and nothing new arrives for
            // 1.5 s. Stop-aware; generous cap because media packages can be large.
            const settleCap = Date.now() + Math.max(timeout, 600000);
            while (Date.now() < settleCap) {
              if (stop()) throw new Error('stopped');
              const inFlight = p.items.length > p.doneReports;
              if (!inFlight && Date.now() - p.lastEvent >= 1500) break;
              opts.setPhase('item', itemPath + ' — ' + p.doneReports + '/' + p.items.length + ' downloads finished');
              await sleep(300);
            }
            pending = null;
            if (!p.files.length) throw new Error('no file was downloaded');
            // Partial success is NOT recorded as seen — the whole item retries next run
            // (already-fetched files just get overwritten), so nothing is silently missing.
            if (clickFailures || p.failedDownloads) {
              throw new Error((clickFailures + p.failedDownloads) + ' of ' + terminal.length + ' downloads failed — the item will retry next run');
            }
            summary.bytes += p.files.reduce((a, f) => a + (f.bytes || 0), 0);
            for (const f of p.files) summary.downloaded.push({ collection: collName, item: name, file: f.file, bytes: f.bytes });
            seen.items[itemPath] = { at: new Date().toISOString(), name, files: p.files.map(f => path.relative(job.dest, f.file)) };
            saveSeen(opts.dataDir, job.id, seen); // after every item — crash-safe
            opts.setCounts({ downloaded: summary.downloaded.length, skippedSeen: summary.skippedSeen });
          } catch (e) {
            // Cancel anything still writing (a timed-out DownloadItem keeps streaming to
            // disk otherwise); strays that fire later hit the pending==null refusal.
            if (pending) { for (const it of pending.items) { try { it.cancel(); } catch {} } pending = null; }
            if (e.needsLogin || String(e.message) === 'stopped') throw e;
            collErrors++;
            summary.errors.push({ item: itemPath, error: e.message });
            opts.log(`ERROR ${job.name}: ${itemPath} — ${e.message}`);
          }
          await sleep(Math.max(500, Number(rule.delayMs) || 4000));
        }
        if (!collErrors && !stop() && !dryRun) {
          seen.collections[collectionKey(source.id, collName)] = { at: new Date().toISOString() };
          saveSeen(opts.dataDir, job.id, seen);
        }
      }
    }
  } catch (e) {
    // A user-initiated Stop is not a failure: the caller marks the run stopped from its
    // own stop flag; recording it as fatal would inflate error stats forever.
    if (String(e.message) !== 'stopped') {
      summary.fatal = e.message;
      if (e.needsLogin) summary.needsLogin = true;
    }
  } finally {
    ses.removeListener('will-download', onDownload);
    try { win.destroy(); } catch {}
  }
  return summary;
}

module.exports = {
  validateRule, findRule, sanitizeName, itemDir, collectionKey, planCollections, sequentialIds,
  numbersFromHrefs, seenPath, loadSeen, saveSeen, validateWebJob, runWebJob, NeedsLogin,
};
