# Releasing FileBridge

Three platforms, one draft release:

| OS | Arch | Built where | Signing |
|---|---|---|---|
| Windows | x64 | GitHub Actions `windows` job (`.github/workflows/release.yml`) | Azure Trusted Signing, OIDC (setup below) |
| Linux | x64 only | GitHub Actions `linux` job: AppImage + .deb + SHA256 sums | none (see the Linux section) |
| macOS | arm64 only | **locally on T.J.'s Mac**, uploaded to the same draft | Developer ID + notarization, already set up on that Mac (see the macOS section) |

A tag push makes CI build Windows and Linux into a **draft**. The Mac build is then added to that
draft. T.J. approves the release notes before anything is published. Nothing here needs T.J. to
supply a password or secret.

## One-time setup (done once per repo)

- A federated credential on the Azure app registration `github-actions-code-signing`, with
  subject `repo:TeeJS@4136437/filebridge@<repo-id>:environment:release`.
- A `release` environment with the variables `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
  `AZURE_SUBSCRIPTION_ID` (IDs, not secrets).

## Dry run

```bash
gh workflow run release.yml -R TeeJS/filebridge -f dry_run=true
```

The run must pass **Verify every binary is signed**: the installer, `FileBridge.exe` and
`filebridge_dpapi.node` each print `signed ... (CN=Thomas Schmitz, ...)`.

## Release

1. Set `package.json` `version` and write `release-notes/vX.Y.Z.md`. T.J. approves the notes
   before anything is published.
2. With T.J.'s go: `git tag vX.Y.Z` then `git push origin vX.Y.Z`. The workflow builds, signs and
   creates a **draft** release with the installer and those notes. The tag must match
   `package.json`.
3. Check the draft's assets and the signing proof lines in the job log.
4. With T.J.'s go: `gh release edit vX.Y.Z -R TeeJS/filebridge --draft=false --latest`.

Small updates are patch bumps (2.0.0 -> 2.0.1); ask before a minor bump.

## Fallback: sign on the PC

Copy `D:\Github\open-quake\repo\.signing` into the repo (gitignored), `Connect-AzAccount`, then
`npm run dist`. `sign.js` signs each file through the same Trusted Signing library.

## macOS (arm64 dmg + zip)

Built on T.J.'s Mac, not in CI, then uploaded to the draft the tag created. CI would need five
Apple secrets in the repo; this Mac already has working credentials.

**Do not ask T.J. for an Apple ID, password or team ID.** The certificate lives in the login
keychain and the Apple ID plus app-specific password live inside a notarytool credential profile.
Both are referenced by name, so nothing reads or stores a secret. Confirm with:

```bash
security find-identity -v -p codesigning                 # Developer ID Application: ...
cat .signing/mac-identity .signing/notary-profile        # gitignored, per machine
xcrun notarytool history --keychain-profile "$(cat .signing/notary-profile)"
```

### Build and upload

```bash
npm ci && npm test        # npm ci matters: a stale node_modules fails the pack step
npm run dist:mac          # about ten minutes; two round trips to Apple
spctl -a -t exec -vv "dist/mac-arm64/FileBridge.app"     # want: accepted, Notarized Developer ID
xcrun stapler validate dist/filebridge-*-mac-arm64.dmg
gh release upload vX.Y.Z dist/filebridge-*-mac-arm64.{dmg,zip} -R TeeJS/filebridge
```

`build/mac-build.js` prints the identity and credential source it chose in its first two lines.
Read them. If the identity says `ad-hoc`, stop: that signature differs on every build, so macOS
treats each build as a new app. `build/verify-mac-build.js` refuses to finish a build whose
artifacts are not notarized — it checks the files, because `notarize: true` with no credentials
logs a skip and exits 0.

### Four traps, each of which cost a failed run

- **`CSC_NAME` takes the common name only.** electron-builder refuses the
  `Developer ID Application:` prefix and `codesign` requires it; `mac-build.js` sets both forms.
- **No double hyphen inside an XML comment in `build/entitlements.mac.plist`.** `plutil -lint`
  accepts it, Apple's AMFI parser does not, and codesign then fails on the first nested binary a
  minute in — so it reads as a certificate problem rather than a typo. Guarded by
  `test/mac.test.js`.
- **electron-builder signs and notarizes the `.app` only**, leaving the `.dmg` unsigned, which
  Gatekeeper rejects outright. `build/notarize-dmg.js` signs, submits, then staples the image, in
  that order — signing invalidates an existing staple.
- **Never add `build.mac.files`.** A per-platform list replaces the global `build.files`.

After adding a dependency anywhere, `npm ci` before building, or the pack step fails with
"production dependency not found".

## Linux (x64 AppImage + .deb)

CI builds both in release.yml's `linux` job (ubuntu-latest), alongside SHA256SUMS-linux-<version>.txt, and the tag-push draft includes them. Nothing is signed: Linux users don't check a signature.

Build and test on the Linux box (Kubuntu, KDE Wayland):

```bash
npm ci
npm test
npx electron-builder --linux --x64 --publish never   # or: npm run dist:linux
# -> dist/filebridge-<version>-x86_64.AppImage, dist/filebridge_<version>_amd64.deb
npx electron-builder --linux dir                     # quick unpacked build: dist/linux-unpacked/filebridge
```

Installing needs sudo, so the person at the keyboard runs it. Use the absolute path, and use apt rather than `dpkg -i`, because apt resolves the Ubuntu 24.04+ `t64` library names:

```bash
sudo apt install /home/tschmitz/github/filebridge/dist/filebridge_<version>_amd64.deb
sudo apt remove filebridge
```

Things that have already cost time:
- The AppImage needs FUSE 2. On Ubuntu 24.04+ it exits with a libfuse error until `libfuse2t64` is installed. Run it with `--appimage-extract-and-run` to test without it. The .deb is the recommended download.
- Don't set `deb.afterInstall`/`afterRemove`. They replace electron-builder's stock scripts, which set up chrome-sandbox and the AppArmor profile that Ubuntu 24.04+ needs.
- Don't add `build.linux.files`. A platform files list replaces the global `build.files`.
- Keep the top-level `desktopName` (`filebridge.desktop`). Without it KDE/GNOME show the wrong taskbar icon.
- Stock Ubuntu sets `kernel.apparmor_restrict_unprivileged_userns=1`; test the .deb with it on.
- Don't test shutdown with `timeout`. It signals twice, and Chromium force-exits on the second signal. A single SIGTERM (logout, `kill`) shuts down cleanly.
