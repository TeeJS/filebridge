# Releasing FileBridge

Windows only. Built, tested and signed in GitHub Actions (`.github/workflows/release.yml`),
copied from faction-wars-editor.

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
