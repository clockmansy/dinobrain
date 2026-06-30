# DinoBrain Sensitivity Policy

Date: 2026-07-01
Status: Phase 1 foundation

## Goal

Prevent DinoBrain from turning private or unsafe material into durable synced memory.

The default stance is conservative. If a record may contain sensitive data, it stays local or goes to review.

## Never Store In Git

The data repo must not store:

- passwords
- API keys
- access tokens
- refresh tokens
- private keys
- session cookies
- recovery codes
- payment information
- government IDs
- private addresses or phone numbers unless explicitly curated
- raw full conversation transcripts
- unreviewed personal document dumps
- employer confidential material unless explicitly approved

## Requires Review

These records require review before promotion or sync:

- external factual claims
- legal, medical, financial, or security claims
- inferred user preferences
- inferred user traits
- company or client information
- anything copied from private chat, email, or documents
- any record that conflicts with existing Wiki notes

## Evidence Rule

Promotion candidates must include evidence snippets.

Evidence should identify:

- source path or source URL
- date checked
- exact snippet or summary
- whether the claim is fact, inference, decision, question, or caveat

Claims without evidence are not auto-promoted.

## Confidence Rule

Curated knowledge records must include:

- `confidence`
- `last_verified`
- `source_status`

Low confidence or stale records may enter a Context Pack only with a visible warning.

## Demotion Rule

If a record is wrong, stale, unsafe, or over-promoted, it must be demotable.

Demoted or quarantined records must be excluded from default Context Packs.

## Candidate Rule

Candidate instances must not be treated as durable knowledge.

Candidates require:

- evidence snippet
- evidence source
- confidence
- last verified date

Candidates enter Review Queue before they can become accepted instances.
