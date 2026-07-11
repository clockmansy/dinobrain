# DinoBrain OS v2 Contract

DinoBrain v2 closes the memory OS loop around a mandatory pre-response contract:

1. `os_begin_task` is the default entrypoint for agents and hooks. It starts a task, creates a Context Pack, evaluates action gates, writes a gate report, and returns `fail_closed`.
2. If OS context is unavailable, the hook must inject fail-closed instructions and the agent must avoid substantial work until preflight is restored.
3. Context Packs report the actual retrieval mode. With configured dense vectors they use `hybrid_contextual_v2`: chunk context, BM25 sparse scoring, dense vector cosine scoring, reciprocal rank fusion, and provenance-aware reranking. Without a usable dense vector index/provider they report `lexical_fallback_v2` and expose dense-lite lexical fallback as a caveat.
4. Node lifecycle is applied through `apply_node_lifecycle`, which detects merge, hold/exclude, delete-candidate, promotion-review repair, and provenance repair work. With `apply=true`, it archives rejected/merged records, marks held records out of retrieval, writes provenance repair records, and writes review evidence for each action.
5. Durable provenance is stored with `create_source_chunk`, which transactionally binds a fetched-source hash snapshot under `30_Sources/fetched`, a redacted bounded chunk under `30_Sources/chunks`, provenance under `.dino/provenance`, exact claim/evidence hashes, and a lineage generation receipt. Verified support requires an explicit verification method/date; anchor-only, stale, changed-claim, internal-trace-only, or partial generations fail the lineage gate.
6. `record_feedback_correction` creates a provenance-backed pending candidate bound to the source task prompt hash and pre-links contradicted accepted behavior. `review_candidate` requires an explicit `no_conflict`, `hold_superseded`, or `demote_superseded` resolution; accepted correction and superseded-node transitions commit atomically before later Context Packs can retrieve the correction.
7. Completed task traces are distilled by `run_compounding_cycle` into accepted behavior rules. The cycle also merges duplicate behavior rules, holds evidence-poor behavior rules, writes an operation index, and refreshes retrieval indexes. When `DINOBRAIN_AUTO_COMPOUND=1`, `finish_task` runs this cycle before auto sync.
8. Behavior lift is checked with `evaluate_behavior` / `npm run eval:behavior`, comparing memory-on retrieval and selected structured action against a memory-off baseline. Correction cases must retrieve the reviewed rule, change the action, and match the expected memory-on action.
9. RAG and generated-answer completion use explicit version-2 goldens only. Evaluation retrieval excludes recent task/judge records. Answer quality requires blinded independent calibration bound to the golden, generated answers, combined answer/retrieval runtime, dense index, judge protocol, and durable review artifact; stale or tampered evidence fails closed.
10. Live query vectors, semantic pipelines, and Observatory state are bounded. One process reuses a pipeline per model/configuration and serializes inference; Observatory coalesces in-flight work and serves a compact snapshot.
11. Risk is evaluated with `os_gate`; destructive work, missing verified context traces, auto-detected sensitive prompts, sync/release risk, and missing OS tools produce safe actions.
12. Recovery equivalence is verified by `npm run verify:v2` plus installer/version alignment checks. A restored PC must expose the same v2 MCP tools and pass the same gate/retrieval/lifecycle/provenance/eval loop.

The practical target is not model-weight learning. The target is a closed, inspectable loop:

user session -> OS preflight -> hybrid memory retrieval -> gated action -> finish trace -> auto growth -> behavior-rule compounding/cleanup -> behavior eval -> auto sync -> next session behavior.
