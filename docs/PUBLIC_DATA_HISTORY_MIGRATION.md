# Public Data History Migration

## Purpose

The public `dinobrain-data` repository must not retain machine-local paths,
secret shapes, raw conversation payloads, unsupported blobs, or unreviewed
accepted memory in any reachable Git history. Deleting a value in a later
commit is insufficient because the old blob remains public and reachable.

## Safety Contract

`scripts/public-data-history-migration.mjs` prepares a replacement history in
an isolated local repository. Preparation never changes the source worktree or
the remote branch.

The preparation path:

1. resolves one immutable source commit;
2. creates a mirror backup and verified Git bundle outside both repositories;
3. clones the exact committed tree with Windows long-path support;
4. replaces machine-local paths and redacts private review-worklist fields;
5. appends local status generations to the data `.gitignore`;
6. initializes a new root history and scans the snapshot, staged tree, complete
   history, and pre-push surface with the unified classifier;
7. writes a local manifest with before/after hashes for every changed file.

The prepared repository is eligible for push only when every blocking count is
zero. Evaluation fixtures may contain forbidden-output canaries; only the
known `forbidden_terms`, `forbidden_answer_terms`, and
`forbidden_context_terms` fields in known evaluation artifacts are omitted from
content scanning. The same text anywhere else still blocks.

## Commands

Prepare only:

```powershell
npm run safety:history:prepare
```

Apply requires the exact source commit shown in the manifest and uses
`--force-with-lease`. A stale or unexpected remote head blocks the push:

```powershell
node scripts/public-data-history-migration.mjs `
  --apply <local-manifest-path> `
  --confirm-source-head <exact-source-sha>
```

Rollback requires the exact sanitized commit and restores the original branch
from the verified mirror backup, also with `--force-with-lease`:

```powershell
node scripts/public-data-history-migration.mjs `
  --rollback <local-manifest-path> `
  --confirm-sanitized-head <exact-sanitized-sha>
```

Never commit or upload the migration manifest, mirror repository, or backup
bundle. They intentionally preserve the old private-risk history for local
recovery.

## Verification

`npm run safety:history:verify` proves:

- a historical secret removed in a later commit is still detected before the
  migration;
- long Windows paths and nested escaped JSON survive preparation;
- the replacement history has one clean root and zero history blockers;
- an incorrect confirmation SHA cannot apply or roll back;
- the exact remote branch can be replaced and restored;
- the source worktree remains byte- and ref-untouched.

## Applied Evidence

The 2026-07-12 preparation used source commit
`42af157fc65092d278385f5f65f0341cb71db258`. It found 1,907 risky historical
file versions and produced the first sanitized candidate
`54a72e5e7797bba021ccbe2b3670f6baccb7e7dd`. A second structural pass redacted
decoded JSON/JSONL strings, rewrote unsafe filename references, masked all
known evaluation canary fields, and restored executable Git-hook modes. The
final root is `ec9a1a5c27b082dba94de4eeecca0fe4a9238854`.

The approved `--force-with-lease` replacement is applied to public
`origin/main`. A fresh clone and the migrated local checkout each report 5,057
committed files, zero current or historical blockers, zero warnings, and the
same HEAD. Local migration retained an external recovery ref and exact index
backup and preserved all 28,007 worktree files, 372,849,563 bytes, and the
aggregate worktree SHA-256.
