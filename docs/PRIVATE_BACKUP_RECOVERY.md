# DinoBrain Private Backup And Recovery

Date: 2026-07-11
Status: SAFE-03 implementation verified; real off-machine recovery proof pending

## Purpose

GitHub is the durable store for reviewed, classifier-approved DinoBrain memory.
It is not a safe destination for raw conversations, private attachments,
credentials, or machine-local client configuration. SAFE-03 protects that
local-only layer in a separate authenticated encrypted archive.

A complete new-PC recovery therefore has two inputs:

1. the exact DinoBrain app and data Git commits;
2. a `.dinobrain` private archive plus its separately stored recovery key.

## Default Inventory

The private data inventory includes existing regular files under:

- `10_Conversations/raw`
- `30_Sources/private`
- `50_Instances/raw`
- `attachments/private`
- `.dino/secrets.json`
- `.dino/local.json`
- `.dino/events`
- `.dino/review-admissions`

The installed backup launcher also includes Codex `config.toml`/`hooks.json`,
Claude `settings.json`, and recognized credential files. Local backup nesting is
excluded unless explicitly requested. Symlinks, junctions, path escapes, and
files changing during inventory capture fail the backup.

## Cryptographic And Resource Contract

- format: `dinobrain_private_backup_v1`
- inventory policy: `private_inventory_20260711_v1`
- authenticated encryption: AES-256-GCM
- key derivation: scrypt with a random salt
- per-archive random IV
- 1 MiB streaming I/O; files are not buffered in full
- default limits: 100,000 files and 32 GiB plaintext

The public archive header is authenticated as additional data but is not trusted
until full restore authentication succeeds. It contains algorithm and source Git
identity metadata, not private inventory paths. The private manifest and file
frames are encrypted. Evidence stores archive/inventory hashes and a key id, not
the recovery key or plaintext paths.

## Create A Backup

Double-click:

```text
DinoBrain Private Backup.cmd
```

Defaults:

```text
archive: Documents\DinoBrain Backups\DinoBrain-Private-Backup-<timestamp>.dinobrain
key:     Documents\DinoBrain Recovery Key.txt
```

The first run creates the recovery key with exclusive file permissions. Move a
copy to a different secure device or password vault. Do not keep the only key on
the same PC or beside the only backup. DinoBrain cannot decrypt the archive
without that key.

For a scripted custom run, call `scripts/start-private-backup.ps1` with explicit
`-AppPath`, `-VaultPath`, and `-NodeExe`; optional switches control user config,
credentials, and nested local backups.

## Restore On A New PC

1. Install or clone the app and data repositories.
2. Check out the app/data commits recorded for the backup. Restore rejects a
   different source identity instead of silently combining versions.
3. Put the archive and recovery key outside both repositories.
4. Double-click `DinoBrain Private Restore.cmd`.
5. Review the displayed header, then type exactly `RESTORE DINOBRAIN`.
6. Restart Codex and Claude Code after configuration restore.

The restore launcher selects the newest default archive when one exists. It
uses a 90-day age limit by default. Existing private target files block restore;
`-OverwritePrivate` is a deliberate operator action. Explicit overwrite first
creates and verifies rollback copies, then restores or rolls back as one unit.

## Fail-Closed Behavior

Restore decrypts to isolated staging and performs no target promotion until the
complete GCM authentication tag and encrypted manifest are valid. It blocks:

- wrong keys and archive tampering;
- truncated or stale archives;
- app/data source-identity mismatch;
- unknown scope, absolute path, traversal, symlink, or junction targets;
- file-count or total-byte limit violations;
- existing targets without explicit overwrite;
- archive or recovery key placement inside protected roots;
- any changed source file during backup.

Restore receipts and staging live under `.dino/restore-receipts` and
`.dino/restore-staging`; both are classifier-blocked and ignored by Git.

## Verification

Run:

```powershell
npm run backup:private:verify
npm run installer:verify:launchers
```

The first command proves authenticated round trip, wrong-key/truncation/stale
blocks, conflict and path safety, CLI behavior, Git-clone recovery, and bounded
RSS. It writes `.dino/state/encrypted_restore_status.json` without local paths or
secrets. The second proves install-root and app-root launchers are generated.

These fixture results do not prove that a real recovery key was moved off the
machine or that a real clean PC was restored. Those remain external HG-09/HG-11
evidence and must not be inferred from the regression alone.
