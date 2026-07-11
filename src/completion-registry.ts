export const COMPLETION_CONTRACT_VERSION = "completion_contract_20260710_v1";

export const HARD_GATE_IDS = [
  "HG-01",
  "HG-02",
  "HG-03",
  "HG-04",
  "HG-05",
  "HG-06",
  "HG-07",
  "HG-08",
  "HG-09",
  "HG-10",
  "HG-11",
  "HG-12",
] as const;

export type HardGateId = (typeof HARD_GATE_IDS)[number];

export type CompletionCommandSpec = {
  id: string;
  npm_script: string;
  gates: HardGateId[];
  timeout_ms: number;
  environment?: Record<string, string>;
  final?: boolean;
};

export type CompletionArtifactSpec = {
  id: string;
  relative_path: string;
  kind: "json" | "jsonl" | "sqlite";
  gates: HardGateId[];
  accepted_statuses?: string[];
  freshness_ms?: number;
};

export type CompletionExternalEvidenceSpec = {
  id: string;
  gates: HardGateId[];
  freshness_ms: number | null;
  description: string;
};

export type CompletionGateSpec = {
  id: HardGateId;
  title: string;
  command_ids: string[];
  artifact_ids: string[];
  external_evidence_ids: string[];
};

const DEFAULT_TIMEOUT_MS = 180_000;
const LONG_TIMEOUT_MS = 600_000;

function command(
  npmScript: string,
  gates: HardGateId[],
  options: Partial<Pick<CompletionCommandSpec, "id" | "timeout_ms" | "environment" | "final">> = {},
): CompletionCommandSpec {
  return {
    id: options.id ?? `npm:${npmScript}`,
    npm_script: npmScript,
    gates,
    timeout_ms: options.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    environment: options.environment,
    final: options.final,
  };
}

export const COMPLETION_COMMANDS: CompletionCommandSpec[] = [
  command("build", [...HARD_GATE_IDS], { timeout_ms: LONG_TIMEOUT_MS }),
  command("completion:audit:verify", ["HG-08", "HG-10", "HG-12"], { timeout_ms: LONG_TIMEOUT_MS }),
  command("atomic:writers:verify", ["HG-03", "HG-10"]),
  command("status:generation:verify", ["HG-08", "HG-10", "HG-12"]),
  command("prompt:eligibility:verify", ["HG-01", "HG-03", "HG-06"]),
  command("pre-response:gate:verify", ["HG-01", "HG-02", "HG-09"]),
  command("audit:full-memory", ["HG-09", "HG-10", "HG-12"], { timeout_ms: LONG_TIMEOUT_MS }),
  command("status:freshness:verify", ["HG-08", "HG-12"]),
  command("index:verify:operations", ["HG-03", "HG-10"]),
  command("index:verify:sqlite", ["HG-04", "HG-10"]),
  command("task:lifecycle", ["HG-03"]),
  command("task:lifecycle:verify", ["HG-03"]),
  command("task:lifecycle:settle", ["HG-03"]),
  command("task:lifecycle:settle:verify", ["HG-03"]),
  command("memory:lifecycle", ["HG-05", "HG-06", "HG-10"]),
  command("memory:lifecycle:verify", ["HG-05", "HG-06", "HG-10"]),
  command("review:settle", ["HG-06"]),
  command("review:worklist", ["HG-06"]),
  command("review:worklist:actions", ["HG-06"]),
  command("review:settle:verify", ["HG-06"]),
  command("review:worklist:verify", ["HG-06"]),
  command("review:worklist:actions:verify", ["HG-06"]),
  command("review:backpressure", ["HG-04", "HG-06"]),
  command("review:backpressure:verify", ["HG-04", "HG-06", "HG-10"]),
  command("cold:partitions", ["HG-04", "HG-06"]),
  command("cold:partitions:verify", ["HG-04", "HG-06", "HG-10"]),
  command("status:mcp-direct", ["HG-01", "HG-02"]),
  command("verify:mcp-direct", ["HG-02"]),
  command("status:native-authority", ["HG-02"]),
  command("verify:native-authority", ["HG-02"]),
  command("status:source-lineage", ["HG-05"]),
  command("verify:source-lineage", ["HG-05"]),
  command("source:lineage:transaction:verify", ["HG-05", "HG-10"]),
  command("status:behavior-recall", ["HG-07"]),
  command("status:compounding", ["HG-06", "HG-07"]),
  command("behavior:recall:migrate", ["HG-07", "HG-10"]),
  command("behavior:recall:migrate:verify", ["HG-07", "HG-10"]),
  command("verify:behavior-recall", ["HG-07"]),
  command("rag:proof", ["HG-04", "HG-05"]),
  command("eval:rag", ["HG-04", "HG-07"]),
  command("status:live-semantic-query", ["HG-04"]),
  command("status:answer-quality", ["HG-04", "HG-07"]),
  command("rag:proof:verify", ["HG-04"]),
  command("rag:retrieval:verify", ["HG-04", "HG-05"]),
  command("rag:vector:migration:verify", ["HG-04", "HG-10"]),
  command("eval:rag:verify", ["HG-04"]),
  command("verify:live-semantic-query", ["HG-04"]),
  command("verify:live-query-cache-budget", ["HG-04", "HG-10"]),
  command("verify:semantic-pipeline-cache", ["HG-04", "HG-10"]),
  command("verify:answer-quality", ["HG-04", "HG-07"]),
  command("scale:50k:verify", ["HG-04", "HG-08", "HG-10"], { timeout_ms: LONG_TIMEOUT_MS }),
  command("scale:50k:check", ["HG-04", "HG-08", "HG-10"], { timeout_ms: LONG_TIMEOUT_MS }),
  command("observatory:verify", ["HG-08", "HG-10"]),
  command("graph:health", ["HG-05", "HG-08"]),
  command("graph:health:verify", ["HG-08"]),
  command("session:verify", ["HG-03", "HG-06", "HG-09"]),
  command("safety:classifier:verify", ["HG-09", "HG-10"]),
  command("safety:public-data:check", ["HG-09"]),
  command("hooks:data:verify", ["HG-09"]),
  command("verify:os", ["HG-01", "HG-02", "HG-03", "HG-04", "HG-05", "HG-06", "HG-07", "HG-08", "HG-09"], {
    timeout_ms: LONG_TIMEOUT_MS,
  }),
  command("verify:v2", ["HG-01", "HG-02", "HG-03", "HG-04", "HG-05", "HG-06", "HG-07"], {
    timeout_ms: LONG_TIMEOUT_MS,
  }),
  command("flow:audit", ["HG-01", "HG-03"]),
  command("verify:compounding", ["HG-06", "HG-07"], { timeout_ms: LONG_TIMEOUT_MS }),
  command("verify:codex-live:recent", ["HG-01"]),
  command("verify:codex-mcp-preflight", ["HG-01", "HG-02"]),
  command("status:release-manifest", ["HG-11", "HG-12"]),
  command("verify:release-manifest", ["HG-11", "HG-12"]),
  command("installer:verify:version", ["HG-11", "HG-12"], { timeout_ms: LONG_TIMEOUT_MS }),
  command("installer:verify:path-ux", ["HG-11"], { timeout_ms: LONG_TIMEOUT_MS }),
  command("installer:verify:approval", ["HG-01", "HG-11"], { timeout_ms: LONG_TIMEOUT_MS }),
  command("installer:verify:launchers", ["HG-08", "HG-11"], { timeout_ms: LONG_TIMEOUT_MS }),
  command("installer:verify:managed-hook", ["HG-01", "HG-11"], { timeout_ms: LONG_TIMEOUT_MS }),
  command("installer:verify:semantic-rag", ["HG-04", "HG-11"], { timeout_ms: LONG_TIMEOUT_MS }),
  command("uninstall:verify", ["HG-11"], { timeout_ms: LONG_TIMEOUT_MS }),
  ...[1, 2, 3].map((run) =>
    command("index:verify:concurrency", ["HG-10"], {
      id: `npm:index:verify:concurrency:${run}`,
      timeout_ms: LONG_TIMEOUT_MS,
      environment: { DINOBRAIN_CONCURRENCY_CLIENTS: "24", DINOBRAIN_CONCURRENCY_RUN: String(run) },
    }),
  ),
  command("status:refresh", ["HG-03", "HG-04", "HG-05", "HG-06", "HG-07", "HG-08", "HG-10", "HG-12"], {
    timeout_ms: LONG_TIMEOUT_MS,
  }),
  command("verify:goal", ["HG-12"], { timeout_ms: LONG_TIMEOUT_MS, final: true }),
];

const DAY_MS = 24 * 60 * 60 * 1000;

export const COMPLETION_ARTIFACTS: CompletionArtifactSpec[] = [
  {
    id: "current_status_generation",
    relative_path: ".dino/state/current-status-generation.json",
    kind: "json",
    gates: ["HG-08", "HG-10", "HG-12"],
    accepted_statuses: ["published"],
  },
  {
    id: "client_mcp_direct_status",
    relative_path: ".dino/state/client_mcp_direct_status.json",
    kind: "json",
    gates: ["HG-01", "HG-02"],
    accepted_statuses: ["healthy", "verified"],
    freshness_ms: DAY_MS,
  },
  {
    id: "native_instruction_authority",
    relative_path: ".dino/state/native_instruction_authority.json",
    kind: "json",
    gates: ["HG-02"],
    accepted_statuses: ["healthy"],
  },
  {
    id: "task_sessions",
    relative_path: ".dino/state/task_sessions.json",
    kind: "json",
    gates: ["HG-03"],
    accepted_statuses: ["healthy"],
  },
  {
    id: "task_lifecycle_settlement",
    relative_path: ".dino/state/task_lifecycle_settlement.json",
    kind: "json",
    gates: ["HG-03"],
    accepted_statuses: ["healthy"],
  },
  {
    id: "task_finish_grounding",
    relative_path: ".dino/state/task_finish_grounding_classifications.jsonl",
    kind: "jsonl",
    gates: ["HG-03"],
  },
  {
    id: "rag_proof",
    relative_path: ".dino/state/rag_proof_status.json",
    kind: "json",
    gates: ["HG-04"],
    accepted_statuses: ["healthy"],
  },
  {
    id: "rag_eval",
    relative_path: ".dino/state/rag_eval_status.json",
    kind: "json",
    gates: ["HG-04"],
    accepted_statuses: ["healthy"],
  },
  {
    id: "vector_index_migration",
    relative_path: ".dino/state/vector_index_migration.json",
    kind: "json",
    gates: ["HG-04", "HG-10"],
    accepted_statuses: ["initialized", "same_identity_updated", "applied"],
  },
  {
    id: "live_semantic_query",
    relative_path: ".dino/state/live_semantic_query_status.json",
    kind: "json",
    gates: ["HG-04"],
    accepted_statuses: ["healthy"],
  },
  {
    id: "answer_quality",
    relative_path: ".dino/state/answer_quality_status.json",
    kind: "json",
    gates: ["HG-04", "HG-07"],
    accepted_statuses: ["healthy"],
  },
  {
    id: "source_lineage",
    relative_path: ".dino/state/source_lineage_status.json",
    kind: "json",
    gates: ["HG-05"],
    accepted_statuses: ["healthy"],
  },
  {
    id: "node_lifecycle",
    relative_path: ".dino/state/node_lifecycle.json",
    kind: "json",
    gates: ["HG-05", "HG-06", "HG-10"],
    accepted_statuses: ["healthy"],
  },
  {
    id: "review_queue",
    relative_path: ".dino/state/wiki-review-queue.json",
    kind: "json",
    gates: ["HG-06"],
    accepted_statuses: ["ready"],
  },
  {
    id: "semantic_jobs",
    relative_path: ".dino/state/semantic_jobs.json",
    kind: "json",
    gates: ["HG-06"],
    accepted_statuses: ["ready"],
  },
  {
    id: "review_settlement_actions",
    relative_path: ".dino/state/review_queue_settlement_actions.json",
    kind: "json",
    gates: ["HG-06"],
    accepted_statuses: ["healthy"],
  },
  {
    id: "review_worklist",
    relative_path: ".dino/state/review_worklist.json",
    kind: "json",
    gates: ["HG-06"],
    accepted_statuses: ["empty"],
  },
  {
    id: "review_worklist_actions",
    relative_path: ".dino/state/review_worklist_actions.json",
    kind: "json",
    gates: ["HG-06"],
    accepted_statuses: ["empty", "ready"],
  },
  {
    id: "review_queue_backpressure",
    relative_path: ".dino/state/review_queue_backpressure.json",
    kind: "json",
    gates: ["HG-04", "HG-06"],
    accepted_statuses: ["healthy"],
  },
  {
    id: "cold_partitions",
    relative_path: ".dino/state/cold_partitions.json",
    kind: "json",
    gates: ["HG-04", "HG-06"],
    accepted_statuses: ["healthy"],
  },
  {
    id: "cold_partition_index",
    relative_path: ".dino/index/cold-partitions.json",
    kind: "json",
    gates: ["HG-04", "HG-06", "HG-10"],
  },
  {
    id: "behavior_recall_evidence_migration",
    relative_path: ".dino/state/behavior_recall_evidence_migration.json",
    kind: "json",
    gates: ["HG-07", "HG-10"],
    accepted_statuses: ["healthy"],
  },
  {
    id: "behavior_recall",
    relative_path: ".dino/state/behavior_recall_status.json",
    kind: "json",
    gates: ["HG-07"],
    accepted_statuses: ["healthy"],
  },
  {
    id: "controlled_compounding",
    relative_path: ".dino/state/controlled_compounding_status.json",
    kind: "json",
    gates: ["HG-06", "HG-07"],
    accepted_statuses: ["healthy"],
  },
  {
    id: "graph_health",
    relative_path: ".dino/index/graph-health.json",
    kind: "json",
    gates: ["HG-08"],
    accepted_statuses: ["healthy"],
  },
  {
    id: "health_status",
    relative_path: ".dino/state/health_status.json",
    kind: "json",
    gates: ["HG-08", "HG-12"],
    accepted_statuses: ["healthy"],
  },
  {
    id: "monitoring_status",
    relative_path: ".dino/state/monitoring_status.json",
    kind: "json",
    gates: ["HG-08", "HG-12"],
    accepted_statuses: ["healthy"],
  },
  {
    id: "full_memory_manifest",
    relative_path: ".dino/state/full_memory_manifest.json",
    kind: "json",
    gates: ["HG-09", "HG-10"],
  },
  {
    id: "full_memory_audit",
    relative_path: ".dino/state/full_memory_audit_status.json",
    kind: "json",
    gates: ["HG-09", "HG-10"],
    accepted_statuses: ["healthy", "drift_classified"],
  },
  {
    id: "operations_index",
    relative_path: ".dino/index/operations-index.json",
    kind: "json",
    gates: ["HG-10"],
  },
  {
    id: "sqlite_manifest",
    relative_path: ".dino/index/sqlite/manifest.json",
    kind: "json",
    gates: ["HG-04", "HG-10"],
  },
  {
    id: "wiki_sqlite",
    relative_path: ".dino/index/sqlite/wiki.sqlite",
    kind: "sqlite",
    gates: ["HG-04", "HG-10"],
  },
  {
    id: "operations_sqlite",
    relative_path: ".dino/index/sqlite/operations.sqlite",
    kind: "sqlite",
    gates: ["HG-10"],
  },
  {
    id: "release_manifest",
    relative_path: ".dino/state/release_manifest_status.json",
    kind: "json",
    gates: ["HG-11", "HG-12"],
    accepted_statuses: ["healthy"],
  },
];

export const COMPLETION_EXTERNAL_EVIDENCE: CompletionExternalEvidenceSpec[] = [
  {
    id: "codex_live_pre_response",
    gates: ["HG-01"],
    freshness_ms: DAY_MS,
    description: "Fresh trusted Codex Desktop pre-response proof with ordered events",
  },
  {
    id: "claude_live_pre_response",
    gates: ["HG-01", "HG-02", "HG-11"],
    freshness_ms: DAY_MS,
    description: "Fresh Claude Code pre-response and direct MCP proof from a real client",
  },
  {
    id: "encrypted_restore_drill",
    gates: ["HG-09", "HG-11"],
    freshness_ms: null,
    description: "Encrypted local-only backup and isolated restore drill",
  },
  {
    id: "clean_machine_equivalence",
    gates: ["HG-01", "HG-02", "HG-09", "HG-11"],
    freshness_ms: null,
    description: "Clean Windows machine install/update/rollback/uninstall proof with both clients",
  },
  {
    id: "github_release_asset",
    gates: ["HG-12"],
    freshness_ms: null,
    description: "Downloaded GitHub release asset checksum and embedded-version parity proof",
  },
  {
    id: "scale_50k",
    gates: ["HG-04", "HG-08", "HG-10"],
    freshness_ms: null,
    description: "50k-record retrieval, rebuild, graph, and polling performance proof",
  },
];

export const COMPLETION_GATES: CompletionGateSpec[] = HARD_GATE_IDS.map((id) => ({
  id,
  title:
    {
      "HG-01": "Live pre-response and fail-closed loop",
      "HG-02": "Direct MCP parity and native authority",
      "HG-03": "Closed task lifecycle and observable memory use",
      "HG-04": "Retrieval quality, scale, and answer quality",
      "HG-05": "Durable source, chunk, claim, and provenance lineage",
      "HG-06": "Memory lifecycle, review, and compounding hygiene",
      "HG-07": "Feedback writeback and behavior improvement",
      "HG-08": "Graph, Observatory, health, and evidence coherence",
      "HG-09": "Privacy, public sync, backup, and restore safety",
      "HG-10": "Data integrity, atomic publication, concurrency, and performance",
      "HG-11": "Installer, clean-machine recovery, versioning, and rollback",
      "HG-12": "Repository, release, and final aggregate parity",
    }[id],
  command_ids: COMPLETION_COMMANDS.filter((entry) => entry.gates.includes(id)).map((entry) => entry.id),
  artifact_ids: COMPLETION_ARTIFACTS.filter((entry) => entry.gates.includes(id)).map((entry) => entry.id),
  external_evidence_ids: COMPLETION_EXTERNAL_EVIDENCE.filter((entry) => entry.gates.includes(id)).map(
    (entry) => entry.id,
  ),
}));

export function assertCompletionRegistry(): void {
  const commandIds = new Set<string>();
  for (const entry of COMPLETION_COMMANDS) {
    if (commandIds.has(entry.id)) throw new Error(`Duplicate completion command id: ${entry.id}`);
    commandIds.add(entry.id);
  }
  const artifactIds = new Set<string>();
  for (const entry of COMPLETION_ARTIFACTS) {
    if (artifactIds.has(entry.id)) throw new Error(`Duplicate completion artifact id: ${entry.id}`);
    artifactIds.add(entry.id);
  }
  const externalIds = new Set(COMPLETION_EXTERNAL_EVIDENCE.map((entry) => entry.id));
  if (externalIds.size !== COMPLETION_EXTERNAL_EVIDENCE.length) {
    throw new Error("Duplicate completion external evidence id");
  }
  for (const gate of COMPLETION_GATES) {
    if (gate.command_ids.length === 0) throw new Error(`${gate.id} has no mandatory command`);
    if (gate.artifact_ids.length === 0) throw new Error(`${gate.id} has no required artifact`);
    for (const id of gate.command_ids) if (!commandIds.has(id)) throw new Error(`${gate.id} references unknown command ${id}`);
    for (const id of gate.artifact_ids) if (!artifactIds.has(id)) throw new Error(`${gate.id} references unknown artifact ${id}`);
    for (const id of gate.external_evidence_ids) if (!externalIds.has(id)) throw new Error(`${gate.id} references unknown evidence ${id}`);
  }
}

assertCompletionRegistry();
