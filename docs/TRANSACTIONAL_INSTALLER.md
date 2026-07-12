# Transactional Installer

Date: 2026-07-11

The Windows installer treats app, data, client configuration, and generated
launchers as one recoverable transaction. A successful process exit is not the
authority. The local `dinobrain-install-result.json` transaction record is.

## Install Sequence

1. Acquire `<install-root>\.dinobrain-installer\install.lock`. A second installer
   for the same root fails closed.
2. Recover any nonterminal journal left by an interrupted earlier run.
3. Resolve the requested app and data refs to full 40-character commit SHAs.
4. Copy or clone both repositories into short sibling stage paths.
5. Verify the Microsoft Visual C++ x64 runtime, install the Microsoft-signed
   redistributable if required, prove the ONNX native binding loads, then build,
   index, prewarm semantic retrieval, generate temporary client config, and run
   verification entirely against the stage paths.
6. Generate final-path config and snapshot every file or managed directory that
   can be changed.
7. Rename existing repositories to rollback siblings and promote the verified
   stages.
8. Atomically publish normalized TOML/JSON files, hooks, and launchers.
9. Run final-path verification, delete rollback copies and temporary config
   copies, and publish a terminal result.

The moving branch can advance after step 3 without changing the transaction.
Every checkout and the final result remain bound to the SHAs resolved in step 3.

## Result Contract

The installer writes:

```text
<install-root>\dinobrain-install-result.json
```

Important fields are:

- `status`: `complete`, `rolled_back`, or `rollback_failed`;
- `app.requested_ref` and `app.resolved_commit`;
- `data.requested_ref` and `data.resolved_commit`;
- `stage_verified` and `verification_skipped`;
- `full_equivalence`;
- `recovered_from_interrupt` and `recovery_quarantine_paths`.

The GUI parses this file after PowerShell exits. Missing or malformed JSON,
nonterminal status, or missing full commit identities changes the UI result to
failed even when the child process returned exit code 0. A deliberately skipped
verification or no-Git archive install is shown as degraded and never counts as
clean-machine equivalence.

## Failure And Crash Recovery

Ordinary exceptions roll back before `install.ps1` exits. The journal also
records stage, rollback, and snapshot paths before promotion so process kill,
power loss, or a terminated GUI can be recovered on the next run.

Recovery validates the transaction directory, expected app/data targets, safe
sibling stage paths, and an allowlist of client-config snapshot targets before
moving anything. It uses filesystem state rather than trusting only the last
`promoted` flag, covering interruption between a directory rename and the next
journal write. Replaced bytes from an interrupted run remain under the recorded
recovery quarantine instead of being silently discarded.

Temporary copies of Codex and Claude configuration are deleted after normal
completion and caught rollback. Recovery quarantine is retained only when an
actual interrupted transaction needs forensic preservation.

## Dirty State

Local data-vault changes are copied into the stage and preserved across
reinstall/update. An app checkout that must move to another commit fails closed
when it contains user changes. Installer-generated launcher files are the only
explicit app-side exception; they are regenerated after promotion.

## Git And Degraded Archives

Git-backed installation is required for full equivalence, later scoped sync,
and push recovery. When Git is unavailable, a fresh install can resolve refs
through the GitHub API and download immutable commit archives. The result marks
`full_equivalence: false`. Existing non-Git targets are not overwritten.

## Uninstall

Normal uninstall unregisters integrations and keeps app/data repositories.
`-Purge -Yes` is the separate destructive path for removing repositories,
private backups, and runtime state. `npm run uninstall:verify` proves both modes.

## Verification

```powershell
npm run installer:verify:native-result
npm run installer:verify:transaction
npm run installer:verify:matrix
npm run installer:verify:sandbox-proof
npm run uninstall:verify
```

The transaction verifier covers exact rollback, dirty-data preservation, moving
ref freezing, dirty-app refusal, network/build/config interruption containment,
abrupt-rename recovery, no-Git degraded non-equivalence, and concurrent-install
locking. The isolated matrix performs clean install, reinstall, update, an
after-config failure with byte-exact rollback, and normal uninstall. It also
reports elapsed time and peak working set per install phase without retaining
the full child-process output in memory.

`DinoBrain Recovery Equivalence Proof.cmd` is the external layer above these
fixtures. It validates the real install result and encrypted restore receipt on
the target PC, binds fresh Codex and Claude direct MCP proofs to matching live
pre-response events, runs capability checks sequentially, and emits a signed
public-safe evidence record. The Ed25519 private key and raw command logs never
enter the data repository.

`DinoBrain Windows Sandbox Proof.cmd` supplies the external clean-Windows layer
when no second physical machine is available. The host prepares a disposable
WSB from hash-bound release inputs and maps only an evidence exchange plus
optional read-only recovery inputs. The guest runs the transactional installer
and matrix from scratch, installs pinned Codex/Claude clients, and exports only
public-safe signed evidence. Sandbox preparation alone is not equivalence;
private restore and both client challenge proofs must still pass.

These local proofs do not replace the external clean-Windows Codex and Claude
live-client evidence required by HG-11.
