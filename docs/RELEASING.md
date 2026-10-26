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
