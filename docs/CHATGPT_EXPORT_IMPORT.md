# ChatGPT Export Import

DinoBrain imports a ChatGPT data export as a privacy-preserving source layer and
a reviewed Wiki profile. It does not copy raw full transcripts into the data
repository.

## Run

```powershell
npm run chatgpt:import -- --zip "C:\path\to\chatgpt-export.zip"
```

Use `--data-root` when the DinoBrain data repository is not configured through
`DINOBRAIN_DATA_DIR`.

## Output

- `20_Wiki/ChatGPT-Conversation-Registry.md`: complete aggregate registration.
- `20_Wiki/ChatGPT-Session-Knowledge-Profile.md`: reviewed repeated operating preferences.
- `60_Operations/session-imports/chatgpt-export-registry.json`: entry, shard, conversation, and message coverage ledger.
- `60_Operations/session-promotions/chatgpt-session-knowledge-promotion.json`: pattern evidence using conversation references and message hashes.
- `10_Conversations/raw/chatgpt-*.json`: local-only message metadata and hashes.
- `30_Sources/private/chatgpt/conversations/chatgpt-*.json`: local-only searchable source cards with bounded redacted user excerpts.

## Privacy Contract

- The original ZIP SHA-256 anchors every exported file and attachment.
- Every conversation message is represented by metadata and a redacted-content hash.
- Raw full transcripts and assistant response text are never persisted.
- A source card may contain at most three redacted user excerpts, each capped at 420 characters.
- Conversations marked `is_do_not_remember` receive metadata coverage only.
- `user.json` is hash-registered but its account identifiers are not parsed into memory.
- `10_Conversations/raw/` and `30_Sources/private/` are Git-ignored local-only roots.

## Verify

```powershell
npm run chatgpt:import:verify
```

The regression verifies ZIP streaming, full message coverage, secret redaction,
do-not-remember handling, public-artifact non-disclosure, and idempotent local
records.
