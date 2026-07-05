# DinoBrain OS v2 Contract

DinoBrain v2 closes the memory OS loop around a mandatory pre-response contract:

1. `os_begin_task` is the default entrypoint for agents and hooks. It starts a task, creates a Context Pack, evaluates action gates, writes a gate report, and returns `fail_closed`.
2. If OS context is unavailable, the hook must inject fail-closed instructions and the agent must avoid substantial work until preflight is restored.
3. Context Packs report the actual retrieval mode. With configured dense vectors they use `hybrid_contextual_v2`: chunk context, BM25 sparse scoring, dense vector cosine scoring, reciprocal rank fusion, and provenance-aware reranking. Without a usable dense vector index/provider they report `lexical_fallback_v2` and expose dense-lite lexical fallback as a caveat.
4. Node lifecycle is applied through `apply_node_lifecycle`, which detects merge, hold/exclude, delete-candidate, promotion-review repair, and provenance repair work. With `apply=true`, it archives rejected/merged records, marks held records out of retrieval, writes provenance repair records, and writes review evidence for each action.
5. Durable provenance is stored with `create_source_chunk`, which redacts and bounds source chunks under `30_Sources/chunks` and links claims under `.dino/provenance`.
6. Direct user corrections are promoted with `record_feedback_correction` into accepted behavior memory so later Context Packs can retrieve them.
7. Behavior lift is checked with `evaluate_behavior` / `npm run eval:behavior`, comparing memory-on retrieval against a memory-off baseline.
8. Risk is evaluated with `os_gate`; destructive work, missing verified context traces, auto-detected sensitive prompts, sync/release risk, and missing OS tools produce safe actions.
9. Recovery equivalence is verified by `npm run verify:v2` plus installer/version alignment checks. A restored PC must expose the same v2 MCP tools and pass the same gate/retrieval/lifecycle/provenance/eval loop.

The practical target is not model-weight learning. The target is a closed, inspectable loop:

user session -> OS preflight -> hybrid memory retrieval -> gated action -> trace/audit/eval -> lifecycle/provenance/writeback -> next session behavior.
