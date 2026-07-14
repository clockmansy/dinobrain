# Local-only second-brain mode

Local-only mode turns one verified DinoBrain checkout into a private, continuously growing RAG system. Git remains useful for local history, but remote push is permanently disabled after the final reviewed public sync.

## Operating boundary

- `main` is the last public baseline for the app and data repositories.
- `local-main` is the private continuation branch on this machine.
- Remote fetch may remain available for reference, but push is blocked by Git push URL, `pre-push` hooks, MCP sync policy, and visible Observatory state.
- Runtime projections (indexes, state, task/event traces, audits, proofs, migrations, and local backups) are kept on disk but removed from local source history. They can always be rebuilt from source records.
- Actual user profile records, raw session excerpts, candidates, indexes, traces, and backup status never require a remote.

## Knowledge lanes

| Lane | Source | Retrieval role | Promotion rule |
| --- | --- | --- | --- |
| Profile | `15_Profile` | identity, preferences, constraints, stable context | explicit user statement or reviewed derivation |
| Wiki | `20_Wiki` | durable concepts and reusable knowledge | reviewed and evidence-backed |
| Sources | `30_Sources` | provenance and source excerpts | provenance required |
| Projects | `40_Projects` | active state, decisions, handoffs | project-scoped review |
| Candidates | `50_Instances/candidates` | untrusted extracted memory | never retrieved as accepted memory |
| Accepted | `50_Instances/accepted` | reusable behavioral and factual memory | explicit review required |
| Review | `80_Review_Queue` | promotion, merge, and safety decisions | human or policy approval |

The default semantic provider is `Xenova/paraphrase-multilingual-MiniLM-L12-v2`, so Korean and English queries use the same local vector space. Identity queries receive a dedicated Profile retrieval budget.

## Growth loop

1. The managed prompt hook captures a bounded, redacted session excerpt locally.
2. Extracted claims enter Candidate state and remain untrusted.
3. Review classifies each candidate as rejected, quarantined, merged, or accepted.
4. Only accepted records participate in reusable memory retrieval.
5. Index, evidence graph, health, and Observatory projections are rebuilt from source state.

Automatic capture and compounding may run locally. Automatic acceptance is always disabled.

## Activation

Run activation only after the final app and data commits are pushed and recorded:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\activate-local-only.ps1 `
  -AppPath F:\dino-os\dinobrain `
  -VaultPath F:\dino-os\dinobrain-data
```

The command creates or switches both repositories to `local-main`, removes upstream tracking, separates runtime projections, updates the managed hook, writes `.dino/state/local-only-mode.json`, and applies all push blocks.

## Backup and restore proof

`run-local-backup-cycle.ps1` creates an authenticated encrypted archive, decrypts it into isolated temporary targets, verifies every manifest entry and hash, removes the temporary restore, and only then writes `.dino/state/private-backup-status.json` with `status: verified`.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-local-backup-cycle.ps1 `
  -AppPath F:\dino-os\dinobrain `
  -VaultPath F:\dino-os\dinobrain-data `
  -NodeExe (Get-Command node).Source
```

To install the daily hidden task:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-local-backup-schedule.ps1 `
  -AppPath F:\dino-os\dinobrain `
  -VaultPath F:\dino-os\dinobrain-data `
  -NodeExe (Get-Command node).Source `
  -DailyAt 03:30
```

Keep a recovery-key copy on a different secure device. Observatory reports backup verification but never exposes the key or archive contents.

## Observatory contract

The local dashboard must expose:

- operating mode `local_only`;
- push policy `blocked`;
- evidence-graph generation and health;
- candidate/review/accepted lifecycle state;
- multilingual retrieval proof;
- most recent encrypted backup verification.

An `index missing` graph is not treated as an empty vault. Rebuild the final-path status generation and evidence graph before accepting the installation or recovery as healthy.
