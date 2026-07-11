# Direct MCP Proof Protocol

Status: implemented protocol, current local two-client evidence verified;
clean-machine certification pending

## Purpose

LOOP-03 must prove that the named real client invoked DinoBrain through its MCP
tool surface. Configuration, a hook, a list-tools response, a synthetic stdio
client, or a hand-written JSON report is not direct-client evidence.

## Required Calls

One proof session must record these canonical names against one active task:

1. `os_begin_task`
2. `get_context_pack`
3. `wiki_search`
4. `search_memory`
5. `finish_task`

The task-producing call is first, `get_context_pack` uses the same task id, and
`finish_task` is the last required call. Proof tasks use
`growth_policy: trace_only`.

## Protocol

1. `proof:mcp:challenge` creates a random one-time challenge under
   `.dino/proofs/client-mcp/challenges/`. The challenge expires within one hour
   and is authenticated by a key stored outside the data repo.
2. The named client calls `begin_client_mcp_proof`. The server reads MCP
   initialize `clientInfo`, observes its direct parent process, and rejects a
   mismatch before activating the challenge.
3. The MCP server hashes each required input and result. It writes no raw prompt,
   query, result, command line, or executable path to the proof. Each receipt is
   HMAC-authenticated and linked to the previous receipt hash.
4. `finalize_client_mcp_proof` verifies call success, order, task binding, client
   identity, server instance, challenge freshness, and the full receipt chain.
   It then writes the final v2 proof and marks the challenge non-reusable.
5. `status:mcp-direct` independently revalidates the proof, challenge, local
   identity, and receipt ledger. Release parity is `verified` only when both a
   fresh Codex proof and a fresh Claude proof pass.

## Local Identity

The 32-byte proof key is generated on first challenge at:

```text
%LOCALAPPDATA%\DinoBrain\identity\client-mcp-proof-hmac.key
```

It is not stored in `dinobrain-data`, is not eligible for Git sync, and is
deleted by purge uninstall. A proof copied from another machine is reported as
foreign identity evidence rather than silently accepted.

## Accepted Evidence

- v2 proof HMAC and SHA-256 are valid;
- challenge is finalized, fresh, one-use, and bound to the proof;
- MCP client name/version identifies the expected client;
- the MCP server's direct parent is `codex.exe` or `claude.exe` as expected;
- all five canonical tool receipts are successful and bound to one task;
- receipt ledger HMAC, sequence, previous hash, and head hash all verify;
- proof is no older than 24 hours.

## Rejected Evidence

- legacy or hand-authored proof JSON;
- config-only, hook-only, bootstrap, or list-tools-only reports;
- a synthetic client that launches the server below Node, PowerShell, or another
  wrapper even when Codex appears deeper in the process tree;
- missing or aliased canonical tool calls;
- stale, replayed, foreign-identity, edited, truncated, or reordered artifacts;
- Claude `not_configured` as release evidence.

## Operator Flow

After installation or update, fully restart the target client and run one of:

```powershell
npm run proof:mcp:codex
npm run proof:mcp:claude
```

Installed systems also expose `DinoBrain Codex MCP Proof.cmd` and
`DinoBrain Claude MCP Proof.cmd`. Each launcher creates the challenge, copies the
exact prompt, and waits for the matching client-generated v2 proof.

## Current Local Evidence

On 2026-07-11, `status:mcp-direct` independently revalidated fresh v2 proofs
from both installed clients and reported `release_parity_verified: true`:

- Codex MCP client `0.144.0-alpha.4` produced
  `.dino/proofs/client-mcp/codex-client-mcp-6e10d97c-558a-48b7-9a13-f8a29fe8c1f9.json`
  with SHA-256
  `adbdef85d5cd74f51006cbd8a8b741db26a329edcda83ae1dfe5c9d4386a3dab`.
- Claude Code `2.1.207` produced
  `.dino/proofs/client-mcp/claude-client-mcp-930b7d11-fe19-4a13-8584-3ecff1018b7e.json`
  with SHA-256
  `1636160353d5b856d80cc1c7bf6ec0733f6323c724e933aa6cca40d7f7ab7fd3`.

The Claude run exposed and then verified the fix for proof launches being
filtered before a durable task id was returned. A verified active challenge now
forces server-observed `client_mcp_proof` launch provenance; the proof prompt
must stop if `os_begin_task` does not return a task id and may never substitute
the challenge id. Both proofs contain successful, ordered receipts for all five
required tools against one task. This is current-machine evidence only and does
not replace the DIST-02 clean Windows recovery run.

## Trust Boundary

This protocol prevents accidental self-certification, ordinary file editing,
cross-machine replay, and synthetic MCP substitution. It is local evidence, not
hardware-backed remote attestation: an administrator or malicious process that
can replace DinoBrain code and read the local identity key controls the machine's
trust boundary. Release certification therefore also requires a clean-machine
run and a hash-bound completion-audit import.
