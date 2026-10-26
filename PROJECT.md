# FileBridge standalone — project charter

Status: DRAFT, awaiting T.J.'s sign-off (2026-10-26). Nothing built yet.

FileBridge (today: the `file-bridge` drop-in, v1.7.4, in TeeJS/bedrock-panel at
`community-apps/file-bridge/`) becomes its own signed Windows Electron app. Bedrock Panel keeps a
**read-only monitor** of transfer status and no longer manages anything.

## Charter

**1. The one thing it must do.**
Run every FileBridge job (folder, Google Drive, web-drop) on its schedule from its own app,
managed in its own normal desktop window, while the Panel can still show what it is doing.

**2. What would be wrong if it "worked" without...**
- **One scheduler only.** If the old drop-in and the new app both run the same jobs, files copy
  twice and mirror jobs delete twice. Cutover must make that impossible, not just unlikely.
- **No lost state.** Jobs, lifetime stats, grand totals, filter groups, rule files, seen-ledgers
  and last results all come across.
- **Same data safety.** Safe replace, the mirror test-source guard, Recycle Bin and skip-pattern
  protection keep working unchanged.

**3. Off-limits as workarounds.**
- Rewriting the engine or the UI. `sync.js`, `drive.js`, `web.js`, `server.js`, `app.js` and
  `index.html` move over as they are, with only the edits listed below.
- A localhost web server for the app's UI or for status (EDR rule #16).
- "Copy jobs.json by hand" as the migration path.
- Any controls in the Panel monitor. Report only.
- Shipping site-specific web-drop rules (the community-software rule still applies).

**4. Deployment target and backup location.**
- Target: Windows 11, signed with Azure Trusted Signing, built and released through GitHub Actions
  (the `electron-signed-release` skill). macOS and Linux are out of scope for v2.0.
- Code: new repo `TeeJS/filebridge` at `D:\Github\filebridge`, created from the drop-in's git
  history. Git is the backup for code.
- User data: the import never deletes the old folder. `%APPDATA%\bedrock-panel\file-bridge\` stays
  in place, and its `jobs.json` is renamed `jobs.migrated-<yyyymmdd-hhmmss>.json`.

**5. How we verify it is done.** See "Done when" below.

## How it splits

| Piece | Owns | Where |
|---|---|---|
| **FileBridge.exe** (new) | Jobs, scheduler, runs, Drive sign-in, web-drop sign-ins, all editing | `%APPDATA%\FileBridge\` |
| **`status.json`** | One-way status feed, written by the app | `%APPDATA%\FileBridge\status.json` |
| **`file-bridge` drop-in** (converted) | Read-only monitor page on the 1920×480 panel | Bedrock Panel catalog |

## Host seams and what replaces them

Today the drop-in leans on Bedrock Panel in four places. The new Electron shell (`main.js`)
supplies each one:

| Today (Bedrock Panel host) | Standalone replacement |
|---|---|
| `/app-api/<action>` HTTP route to `server.js` `handle()` | A privileged `filebridge://` protocol registered with `protocol.handle`. The page's existing `fetch('/app-api/...')` calls resolve against it, in-process. **No socket.** |
| `/app-host/pick-folder` | The same protocol route, answered with `dialog.showOpenDialog` |
| `ctx.oauth` (status / connect / disconnect / getAccessToken) | Port `src/auth/oauth-handler.js` and `token-storage.js` (MIT) with one Google provider. Tokens and the client secret are encrypted with Electron `safeStorage`. |
| Serve the page plus `serverAutoStart` | `BrowserWindow` loads `filebridge://app/index.html`, and `main.js` loads `server.js` at startup so schedules arm immediately |

The Electron calls FileBridge already makes directly (`BrowserWindow` for sign-in windows,
`session.fromPartition`, `shell.trashItem`, `readShortcutLink`, `openPath`) work unchanged.

**EDR notes:**
- The only listening socket is the OAuth loopback callback, open only while you click
  **Connect** for Drive. Google desktop clients require a loopback redirect. Unlike the Panel's
  fixed `5173`, use an OS-assigned port so it can't collide with Bedrock Panel's own sign-in.
- "Start with Windows" uses Electron's `setLoginItemSettings`, the standard per-user Run entry.
  Off by default and toggled in the app.
- No shell spawning and no downloaded executables.

## Edits to the moved code (the full list)

1. `server.js`: `DATA_DIR` becomes the app's `userData`. `openWindow` and the `127.0.0.1` origin
   check are removed because the app already is the window.
2. `app.js` / `index.html`: default to the `window` surface. Remove the editor-embed code
   (`LAUNCHER`, `oq-embed-height`) and the 1920×480 panel surface.
3. Drive chip: add a **Change client…** action. This fixes the 2026-10-01 blocker: the Google
   projects were deleted, and with a dead client stored the UI offered no way to enter a new one.
4. New `status.js`: writes `status.json` (see below).
5. New `import.js`: the first-run migration (see below).

## status.json contract (v1)

- Written atomically (temp file, then rename) on run start and end, on job and settings changes,
  and at most once per second during a run. Also rewritten every 30 s as a heartbeat.
- Fields: `schema: 1`, `appVersion`, `heartbeatAt`, `paused`, and `current`: the job name, kind,
  phase, current file, files and bytes done/total, rate, the up-to-date · copy · filtered tally,
  and paused state. Then `queue` (job names), per-job rows (name, kind, enabled, nextRunAt,
  last-run ok/at/copied/bytes/errors/warnings), and `grand` totals.
- No secrets, tokens, cookies or rule contents. Local paths are fine.

## Migration (first run of the new app)

1. If `%APPDATA%\bedrock-panel\file-bridge\jobs.json` exists and the new data folder is empty,
   offer **Import from Bedrock Panel**.
2. Copy everything across: jobs, filters, rules, ledgers, results and the log.
3. Rename the old `jobs.json` to `jobs.migrated-<timestamp>.json`. The old drop-in then finds no
   jobs, so it schedules nothing, even before its update lands. This is how the single-scheduler
   rule is enforced.
4. Expected re-dos, each stated in the app:
   - Drive needs a new Google client and **Connect**. The 2026-10-01 project deletion forces this
     anyway, and the Panel's tokens aren't portable.
   - Each web-drop site needs one fresh sign-in. Sign-in sessions live in Bedrock Panel's
     Chromium profile, and I expect its cookie encryption to block copying them across.

## Panel monitor (the `file-bridge` drop-in, converted)

- **Same app id.** Your existing FileBridge page turns into the monitor through **Check for
  updates**, with no page to re-create. Version bump plus rebuilt zip and index, per the drop-in
  rule.
- `server.js` shrinks to a single read-only `status` action that reads `status.json`. No scheduler.
- The page shows the live run band (job, file, progress, rate, tally), next runs, last results and
  grand totals. **"FileBridge isn't running"** appears when the heartbeat is over 90 s old, with
  the last-known state kept visible.
- No buttons that change anything. Designed to the panel design system (`quake-touch-ui`).

## Order of work (each step reviewed before the next)

1. **Repo:** create `D:\Github\filebridge` from the drop-in's history (`git subtree split`). Add an
   Electron 44 + electron-builder skeleton, the same versions Bedrock Panel uses.
2. **Shell:** `main.js` with single-instance lock, tray icon (closing the window keeps the
   scheduler running), the `filebridge://` protocol, folder picker, OAuth port and login item.
3. **De-host edits:** items 1–3 above. `test.js` carries over and must pass.
4. **status.json and import:** with new `node:test` coverage (writer, schema, heartbeat,
   import plus tombstone).
5. **Adversarial review** of the shell, import and status writer, as every FileBridge release has
   had.
6. **Signed release v2.0.0:** through GitHub Actions. You review the release notes before
   publishing.
7. **Your live test of the app:** import, then one run of each job kind.
8. **Panel monitor:** convert the drop-in, verify it in the harness, merge, then you update it
   through **Check for updates**. This step comes last on purpose: if the monitor ships first,
   your jobs stop running until the app is installed.

## Done when

- [ ] Signed installer; `Get-AuthenticodeSignature` reports Valid.
- [ ] Import brings over every job, stat, filter, rule, ledger and result. The old drop-in then
      schedules nothing.
- [ ] A folder job, a Drive-API job (new client) and a web-drop job each complete a real run.
- [ ] A cron job fires with the window closed (tray), and again after a reboot with "Start with
      Windows" on.
- [ ] `Get-NetTCPConnection -State Listen -OwningProcess <FileBridge pids>` returns nothing
      outside a Drive Connect.
- [ ] The Panel monitor shows a live run within about 2 s, last results and next runs, and shows
      "isn't running" when the app is quit. It has no controls.
- [ ] `node test.js` and `npm test` pass.

## Defaults I've taken (say if you want different)

- Repo **public**, `TeeJS/filebridge`, matching where FileBridge lives today.
- Name stays **FileBridge**. Version starts at **2.0.0** to mark the move.
- Auto-update (electron-updater) is **out of v2.0**. Install new versions from the GitHub release
  for now, and we add it as a follow-up.

## Effort

About **3–4 days of work**. This is up from my first 1–2-day estimate, which covered only the
shell. The migration, the status feed and the Panel monitor add the rest.
