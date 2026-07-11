import path from "node:path";
import { pathToFileURL } from "node:url";

import { ANSWER_QUALITY_STATUS_RELATIVE_PATH, buildAndWriteAnswerQualityReport } from "./answer-quality.js";
import { buildAndWriteBehaviorRecallReport } from "./behavior-recall.js";
import { applyBehaviorRecallEvidenceMigration } from "./behavior-recall-migration.js";
import { buildAndWriteClientMcpDirectStatus } from "./client-mcp-direct-status.js";
import { applyColdPartitions } from "./cold-partitions.js";
import { buildAndWriteControlledCompoundingStatus } from "./controlled-compounding.js";
import { buildAndWriteFullMemoryAudit } from "./full-memory-audit.js";
import { buildAndWriteGraphHealth } from "./graph-health.js";
import { buildAndWriteHealthStatus } from "./health-status.js";
import { buildAndWriteLiveSemanticQueryReport, LIVE_SEMANTIC_QUERY_STATUS_RELATIVE_PATH } from "./live-semantic-query-status.js";
import { applyNodeLifecycle } from "./lifecycle.js";
import { buildAndWriteNativeInstructionAuthorityReport } from "./native-instruction-authority.js";
import { buildAndWriteOperationsIndex, OPERATIONS_INDEX_RELATIVE_PATH } from "./operations-index.js";
import { buildAndWriteRagEvalReport, RAG_EVAL_STATUS_RELATIVE_PATH } from "./rag-eval.js";
import { buildAndWriteRagProof } from "./rag-proof.js";
import { buildAndWriteReleaseManifestReport, RELEASE_MANIFEST_STATUS_RELATIVE_PATH } from "./release-manifest.js";
import { settleReviewQueueActions } from "./review-settlement.js";
import { buildReviewQueueBackpressure } from "./review-backpressure.js";
import { buildReviewWorklist } from "./review-worklist.js";
import { buildReviewWorklistActions } from "./review-worklist-actions.js";
import { buildAndWriteSourceLineageReport } from "./source-lineage.js";
import { buildAndWriteSqliteShards, SQLITE_MANIFEST_RELATIVE_PATH } from "./sqlite-shards.js";
import { buildAndWriteStatusFreshness } from "./status-freshness.js";
import { publishStatusGeneration, STATUS_GENERATION_POINTER_RELATIVE_PATH } from "./status-generation.js";
import { buildAndWriteTaskLifecycleReport } from "./task-lifecycle.js";
import { settleTaskLifecycle } from "./task-lifecycle-settlement.js";
import { buildAndWriteWikiIndex, WIKI_INDEX_RELATIVE_PATH } from "./wiki-index.js";

export type RefreshStatusArtifactStep = {
  id: string;
  status: string | null;
  path: string | null;
};

export type RefreshStatusArtifactsOptions = {
  taskStaleAfterMs?: number;
};

export async function refreshStatusArtifacts(
  dataRoot: string,
  options: RefreshStatusArtifactsOptions = {},
): Promise<{
  ok: boolean;
  steps: RefreshStatusArtifactStep[];
  monitoring_status_path: string;
  status: string;
  visible_status: string;
  counts: Record<string, number>;
  warnings: string[];
  status_generation_id: string;
  status_generation_pointer_path: string;
}> {
  const taskStaleAfterMs = options.taskStaleAfterMs ?? 24 * 60 * 60 * 1000;
  const steps: RefreshStatusArtifactStep[] = [];

  const behaviorRecallMigration = await applyBehaviorRecallEvidenceMigration(dataRoot);
  steps.push({
    id: "behavior_recall_evidence_migration",
    status: behaviorRecallMigration.report.status,
    path: behaviorRecallMigration.statusPath,
  });

  const review = await settleReviewQueueActions(dataRoot);
  steps.push({ id: "review_queue_settlement", status: review.review.status, path: review.reviewPath });
  steps.push({ id: "semantic_jobs", status: review.semantic.status, path: review.semanticPath });
  steps.push({ id: "review_queue_settlement_actions", status: review.actions.status, path: review.actionsPath });

  const reviewWorklist = await buildReviewWorklist(dataRoot);
  steps.push({ id: "review_worklist", status: reviewWorklist.report.status, path: reviewWorklist.statePath });

  const reviewActions = await buildReviewWorklistActions(dataRoot);
  steps.push({ id: "review_worklist_actions", status: reviewActions.report.status, path: reviewActions.statePath });

  const reviewBackpressure = await buildReviewQueueBackpressure(dataRoot, { reconcileAdmission: true });
  steps.push({ id: "review_queue_backpressure", status: reviewBackpressure.report.status, path: reviewBackpressure.statePath });

  const coldPartitions = await applyColdPartitions(dataRoot);
  steps.push({ id: "cold_partitions", status: coldPartitions.report.status, path: coldPartitions.statusPath });

  const nodeLifecycle = await applyNodeLifecycle(dataRoot, { apply: false, reviewer: "status-refresh" });
  steps.push({
    id: "node_lifecycle",
    status: typeof nodeLifecycle.status === "string" ? nodeLifecycle.status : null,
    path: typeof nodeLifecycle.lifecycle_path === "string" ? nodeLifecycle.lifecycle_path : null,
  });

  const lifecycle = await buildAndWriteTaskLifecycleReport(dataRoot, { staleAfterMs: taskStaleAfterMs });
  steps.push({ id: "task_lifecycle", status: lifecycle.report.status, path: lifecycle.statusPath });

  const lifecycleSettlement = await settleTaskLifecycle(dataRoot, { staleAfterMs: taskStaleAfterMs });
  steps.push({
    id: "task_lifecycle_settlement",
    status: lifecycleSettlement.report.status,
    path: lifecycleSettlement.statusPath,
  });

  await buildAndWriteWikiIndex(dataRoot);
  steps.push({ id: "wiki_index", status: "written", path: WIKI_INDEX_RELATIVE_PATH });

  await buildAndWriteOperationsIndex(dataRoot);
  steps.push({ id: "operations_index", status: "written", path: OPERATIONS_INDEX_RELATIVE_PATH });

  await buildAndWriteSqliteShards(dataRoot);
  steps.push({ id: "sqlite_manifest", status: "written", path: SQLITE_MANIFEST_RELATIVE_PATH });

  const ragProof = await buildAndWriteRagProof(dataRoot);
  steps.push({ id: "rag_proof", status: ragProof.report.status, path: ragProof.statusPath });

  const graph = await buildAndWriteGraphHealth(dataRoot);
  steps.push({ id: "graph_health", status: graph.health.status, path: graph.path });

  const ragEval = await buildAndWriteRagEvalReport(dataRoot);
  steps.push({ id: "rag_eval", status: ragEval.report.status, path: RAG_EVAL_STATUS_RELATIVE_PATH });

  const liveSemanticQuery = await buildAndWriteLiveSemanticQueryReport(dataRoot);
  steps.push({
    id: "live_semantic_query",
    status: liveSemanticQuery.report.status,
    path: LIVE_SEMANTIC_QUERY_STATUS_RELATIVE_PATH,
  });

  const answerQuality = await buildAndWriteAnswerQualityReport(dataRoot);
  steps.push({
    id: "answer_quality",
    status: answerQuality.report.status,
    path: ANSWER_QUALITY_STATUS_RELATIVE_PATH,
  });

  const releaseManifest = await buildAndWriteReleaseManifestReport(dataRoot, { appRoot: process.cwd() });
  steps.push({
    id: "release_manifest",
    status: releaseManifest.report.status,
    path: RELEASE_MANIFEST_STATUS_RELATIVE_PATH,
  });

  const sourceLineage = await buildAndWriteSourceLineageReport(dataRoot);
  steps.push({ id: "source_lineage", status: sourceLineage.report.status, path: sourceLineage.path });

  const behaviorRecall = await buildAndWriteBehaviorRecallReport(dataRoot);
  steps.push({ id: "behavior_recall", status: behaviorRecall.report.status, path: behaviorRecall.path });

  const controlledCompounding = await buildAndWriteControlledCompoundingStatus(dataRoot);
  steps.push({ id: "controlled_compounding", status: controlledCompounding.report.status, path: controlledCompounding.path });

  const audit = await buildAndWriteFullMemoryAudit(dataRoot);
  steps.push({ id: "full_memory_audit", status: audit.report.status, path: audit.statusPath });

  const clientMcp = await buildAndWriteClientMcpDirectStatus(dataRoot);
  steps.push({ id: "client_mcp_direct_status", status: clientMcp.report.status, path: clientMcp.path });

  const nativeAuthority = await buildAndWriteNativeInstructionAuthorityReport(dataRoot);
  steps.push({ id: "native_instruction_authority", status: nativeAuthority.report.status, path: nativeAuthority.path });

  const health = await buildAndWriteHealthStatus(dataRoot);
  steps.push({ id: "health_status", status: health.report.status, path: health.path });

  const freshness = await buildAndWriteStatusFreshness(dataRoot);
  steps.push({ id: "status_freshness", status: freshness.report.status, path: freshness.path });

  const generation = await publishStatusGeneration(dataRoot);
  steps.push({
    id: "status_generation",
    status: generation.pointer.status,
    path: STATUS_GENERATION_POINTER_RELATIVE_PATH,
  });

  const auditOk = !["drift_unclassified", "parse_error"].includes(audit.report.status);

  return {
    ok: freshness.report.status === "healthy" && auditOk,
    steps,
    monitoring_status_path: freshness.path,
    status: freshness.report.status,
    visible_status: freshness.report.visible_status,
    counts: freshness.report.counts,
    warnings: [...freshness.report.warnings, ...(auditOk ? [] : ["full_memory_audit_not_cleanly_classified"])],
    status_generation_id: generation.pointer.generation_id,
    status_generation_pointer_path: STATUS_GENERATION_POINTER_RELATIVE_PATH,
  };
}

const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"));

async function main(): Promise<void> {
  const started = Date.now();
  const result = await refreshStatusArtifacts(dataRoot);
  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        data_root: dataRoot,
        elapsed_ms: Date.now() - started,
        monitoring_status_path: result.monitoring_status_path,
        status: result.status,
        visible_status: result.visible_status,
        counts: result.counts,
        warnings: result.warnings,
        status_generation_id: result.status_generation_id,
        status_generation_pointer_path: result.status_generation_pointer_path,
        steps: result.steps,
      },
      null,
      2,
    ),
  );
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
