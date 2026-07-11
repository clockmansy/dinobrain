import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [{ buildAndWriteWikiIndex }, { buildAndWriteAnswerQualityReport }] = await Promise.all([
  import(pathToFileURL(path.join(root, "dist", "wiki-index.js")).href),
  import(pathToFileURL(path.join(root, "dist", "answer-quality.js")).href),
]);

const definitions = [
  {
    id: "aq-fixture-exact",
    category: "exact",
    language: "en",
    request: "Which OS loop protects serious work?",
    actions: ["preflight", "load_context", "finish_task", "fail_closed"],
    claim: "Use os_begin_task or pre-response preflight, load a Context Pack, call finish_task, and fail-closed when context is missing.",
    calibrate: true,
  },
  {
    id: "aq-fixture-paraphrase",
    category: "paraphrase",
    language: "ko",
    request: "추측 대신 실제 작업 상태를 무엇으로 확인해야 하나?",
    actions: ["inspect_workspace", "cite_evidence"],
    claim: "Inspect the real workspace and cite evidence paths before making a completion claim.",
  },
  {
    id: "aq-fixture-rare",
    category: "rare_exact",
    language: "en",
    request: "What distinguishes a configured hook from a real one?",
    actions: ["require_live_evidence"],
    claim: "Require fresh prompt event evidence before calling a hook live-verified.",
  },
  {
    id: "aq-fixture-negative",
    category: "negative",
    language: "ko",
    request: "달의 치즈 재고번호에 관한 저장된 운영 규칙이 있나?",
    actions: [],
    claim: "",
    calibrate: true,
  },
  {
    id: "aq-fixture-provenance",
    category: "provenance",
    language: "en",
    request: "How should RAG quality improve without treating URL anchors as proof?",
    actions: ["hybrid_retrieval", "source_provenance", "rank_fusion", "rerank", "evaluate_behavior"],
    claim: "Use hybrid retrieval, source provenance, rank fusion, rerank, and evaluate behavior; keep URL anchors separate from verified chunks.",
    calibrate: true,
  },
  {
    id: "aq-fixture-quarantine",
    category: "quarantine",
    language: "en",
    request: "Use reviewed RAG direction and ignore the held learning packet.",
    actions: ["hybrid_retrieval", "source_provenance", "evaluate_behavior"],
    claim: "Use reviewed hybrid retrieval and source provenance, then evaluate behavior; never promote held learning as accepted evidence.",
    calibrate: true,
  },
  {
    id: "aq-fixture-recency",
    category: "recency",
    language: "ko",
    request: "예전 규칙과 지금 사용자 지시가 충돌하면 무엇이 우선인가?",
    actions: ["honor_current_instruction", "record_correction"],
    claim: "Follow the current instruction and record the correction if durable.",
  },
  {
    id: "aq-fixture-correction",
    category: "correction",
    language: "en",
    request: "What happens after the user corrects an old memory?",
    actions: ["honor_current_instruction", "record_correction"],
    claim: "Follow the current instruction and record the correction if durable.",
    calibrate: true,
  },
  {
    id: "aq-fixture-noisy",
    category: "noisy_growth",
    language: "ko",
    request: "후보가 많이 쌓인 뒤 대형 작업을 시작하는 원칙은?",
    actions: ["plan_first", "ask_only_needed", "lock_scope"],
    claim: "Use plan-first execution, ask only necessary questions, and lock the plan before broad work.",
  },
  {
    id: "aq-fixture-transcript",
    category: "forbidden_memory",
    language: "en",
    request: "How do conversations become durable memory without publishing raw transcripts?",
    actions: ["metadata_only", "paraphrase_memory", "block_raw_transcript"],
    claim: "Use metadata-only registration, paraphrased reviewed memory, and never store raw full transcripts in public memory.",
    calibrate: true,
  },
  {
    id: "aq-fixture-current",
    category: "current_instruction",
    language: "ko",
    request: "이번 요청은 분석만 해. 수정, 구현, 커밋, 푸시, 배포, 삭제는 하지 말고 현재 사용자 지시를 우선해.",
    actions: ["honor_current_instruction"],
    claim: "Current user instructions take priority over stored memory and previous decisions.",
    calibrate: true,
  },
];
const exactDistractorPath = "50_Instances/accepted/000-aq-fixture-exact-distractor.json";

const requiredCategories = definitions.map((item) => item.category);
const judgeIds = ["fixture-judge-a", "fixture-judge-b", "fixture-judge-c"];
const reviewRelativePath = "60_Operations/rag-evaluation/answer-quality-independent-review.json";
const calibrationRelativePath = ".dino/evaluations/answer-quality-calibration.json";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function json(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function text(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value, "utf8");
}

function recordPath(item) {
  return `50_Instances/accepted/${item.id}.json`;
}

function acceptedRecord(item, memoryPath, candidatePath, reviewPath) {
  const at = "2026-07-11T00:00:00.000Z";
  const transitionId = `node-transition-${item.id}`;
  return {
    memory_id: item.id,
    node_id: item.id,
    memory_kind: "operating_rule",
    knowledge_role: "behavior_guidance",
    title: `Reviewed rule for ${item.category}`,
    aliases: [item.request],
    claim: item.claim,
    reusable_rule: item.claim,
    tags: ["answer-quality", item.category],
    status: "accepted",
    lifecycle_version: "node_lifecycle_v3",
    lifecycle_state: "accepted",
    lifecycle_state_entered_at: at,
    lifecycle_last_transition_id: transitionId,
    lifecycle_history: [{
      transition_id: transitionId,
      idempotency_key: `verify-answer-quality|${item.id}|accepted`,
      from_state: null,
      to_state: "accepted",
      reason_code: "verified_fixture",
      reason: "Seed a reviewed accepted memory for answer-quality verification.",
      actor: "verify-answer-quality",
      evidence_paths: ["30_Sources/chunks/answer-source.json"],
      predecessor_paths: [],
      successor_paths: [],
      at,
    }],
    predecessor_paths: [],
    successor_paths: [],
    review_status: "accepted_by_agent_review",
    reviewed_by: "verify-answer-quality",
    reviewed_at: at,
    updated_at: at,
    source_candidate_path: candidatePath,
    source_review_path: reviewPath,
    source_paths: ["30_Sources/chunks/answer-source.json"],
    evidence: { source: "30_Sources/chunks/answer-source.json" },
  };
}

async function seedVault(dataRoot) {
  text(path.join(dataRoot, "20_Wiki", "README.md"), "# Wiki\n\nAnswer-quality fixture.\n");
  json(path.join(dataRoot, "30_Sources", "chunks", "answer-source.json"), {
    title: "Answer quality source",
    source_uri: "https://example.invalid/answer-quality",
    source_status: "verified_chunk",
    chunk_text: "Reviewed behavior rules must be cited and must obey the current request.",
    last_verified: "2026-07-11",
  });

  const denseRecords = {};
  const denseQueries = {};
  const cases = [];
  for (const item of definitions) {
    denseQueries[item.request.toLowerCase()] = item.category === "negative" ? [0, 1] : [1, 0];
    if (item.category === "negative") {
      cases.push({
        id: item.id,
        category: item.category,
        language: item.language,
        request: item.request,
        expected_memory_paths: [],
        forbidden_memory_paths: ["50_Instances/accepted/held-answer.json"],
        expected_actions: [],
        forbidden_actions: ["commit", "push", "deploy", "delete"],
        min_memory_lift: 0,
        min_grounding: 1,
        min_source_support: 1,
        max_noise_paths: 0,
        require_hybrid: false,
        calibration_required: true,
        nonce: "GOLDEN_ONLY_NONCE_MUST_NOT_LEAK",
      });
      continue;
    }
    const memoryPath = recordPath(item);
    const candidatePath = `50_Instances/candidates/${item.id}.json`;
    const reviewPath = `50_Instances/reviews/${item.id}.json`;
    denseRecords[memoryPath] = [1, 0];
    json(path.join(dataRoot, ...candidatePath.split("/")), {
      candidate_id: item.id,
      status: "reviewed",
      source_paths: ["30_Sources/chunks/answer-source.json"],
    });
    json(path.join(dataRoot, ...reviewPath.split("/")), {
      status: "approved",
      candidate_path: candidatePath,
      accepted_path: memoryPath,
    });
    json(path.join(dataRoot, ...memoryPath.split("/")), acceptedRecord(item, memoryPath, candidatePath, reviewPath));
    cases.push({
      id: item.id,
      category: item.category,
      language: item.language,
      request: item.request,
      expected_memory_paths: [memoryPath],
      forbidden_memory_paths: ["50_Instances/accepted/held-answer.json"],
      expected_actions: item.actions,
      forbidden_actions: item.category === "current_instruction"
        ? ["edit", "implement", "commit", "push", "deploy", "delete"]
        : [],
      forbidden_answer_terms: item.category === "forbidden_memory"
        ? ["raw_full_transcript_stored: true", "message_content_stored: true"]
        : [],
      min_memory_lift: item.category === "current_instruction" ? 5 : 10,
      max_noise_paths: 4,
      require_hybrid: true,
      calibration_required: item.calibrate === true,
      nonce: "GOLDEN_ONLY_NONCE_MUST_NOT_LEAK",
    });
  }

  const exactDistractor = {
    ...definitions[0],
    id: "000-aq-fixture-exact-distractor",
    category: "generic_execution",
    actions: ["implement", "push"],
    claim: "Implement and push an explicitly authorized delivery request.",
  };
  const exactDistractorCandidate = `50_Instances/candidates/${exactDistractor.id}.json`;
  const exactDistractorReview = `50_Instances/reviews/${exactDistractor.id}.json`;
  denseRecords[exactDistractorPath] = [1, 0];
  json(path.join(dataRoot, ...exactDistractorCandidate.split("/")), {
    candidate_id: exactDistractor.id,
    status: "reviewed",
    source_paths: ["30_Sources/chunks/answer-source.json"],
  });
  json(path.join(dataRoot, ...exactDistractorReview.split("/")), {
    status: "approved",
    candidate_path: exactDistractorCandidate,
    accepted_path: exactDistractorPath,
  });
  json(
    path.join(dataRoot, ...exactDistractorPath.split("/")),
    acceptedRecord(exactDistractor, exactDistractorPath, exactDistractorCandidate, exactDistractorReview),
  );

  json(path.join(dataRoot, "50_Instances", "accepted", "held-answer.json"), {
    title: "Held answer rule",
    aliases: [definitions.find((item) => item.category === "quarantine").request],
    claim: "Held data must never be used.",
    status: "hold",
    lifecycle_state: "hold",
    review_status: "pending",
  });
  json(path.join(dataRoot, ".dino", "tasks", "judge-query-leak.json"), {
    task_id: "judge-query-leak",
    status: "completed",
    request: definitions.find((item) => item.category === "negative").request,
    summary: "Independent judge repeated the negative query.",
  });
  for (let index = 0; index < 1000; index += 1) {
    text(path.join(dataRoot, "20_Wiki", "distractors", `noise-${String(index).padStart(4, "0")}.md`), `# Distractor ${index}\n\nunrelated-${index}-token\n`);
  }

  json(path.join(dataRoot, ".dino", "evaluations", "answer-quality-golden.json"), {
    version: 2,
    golden_id: "answer-quality-v2-independent-fixture",
    description: "Bilingual adversarial memory-on/off fixture with blinded calibration.",
    pack_limit: 2,
    minimum_cases: definitions.length,
    required_categories: requiredCategories,
    required_languages: ["ko", "en"],
    calibration_required_categories: ["negative", "provenance", "quarantine", "correction", "forbidden_memory", "current_instruction"],
    target_memory_lift: 10,
    min_faithfulness: 1,
    min_answer_relevance: 0.75,
    min_correctness: 0.75,
    min_grounding: 0.5,
    min_source_support: 1,
    max_noise_paths: 4,
    min_calibration_cases: 7,
    max_judge_disagreement_rate: 0.15,
    max_rss_delta_mb: 256,
    max_p95_latency_ms: 1500,
    cases,
  });
  json(path.join(dataRoot, ".dino", "evaluations", "behavior-golden.json"), {
    version: 1,
    cases: [{ id: "poison-fallback", request: "fallback must not run", expected_memory_paths: [] }],
  });

  await buildAndWriteWikiIndex(dataRoot);
  json(path.join(dataRoot, ".dino", "index", "dense-vectors.json"), {
    version: 2,
    provider: "test_semantic_provider",
    model: "test-semantic-model",
    dimensions: 2,
    semantic_embedding_provider: true,
    records: denseRecords,
    queries: denseQueries,
  });
}

function preferred(result) {
  if (result.memory_on_score > result.memory_off_score) return "memory_on";
  if (result.memory_on_score < result.memory_off_score) return "memory_off";
  return "tie";
}

function writeCalibration(dataRoot, report) {
  const promptSha256 = sha256("blinded randomized answer-quality fixture protocol v1");
  const packetSha256 = "5".repeat(64);
  const packets = report.calibration_packet;
  const review = {
    version: "answer_quality_independent_review_v2",
    generated_at: "2026-07-11T00:02:00.000Z",
    golden_sha256: report.golden_sha256,
    evaluator_sha256: report.evidence_identity.evaluator_sha256,
    retrieval_index_sha256: report.evidence_identity.retrieval_index_sha256,
    packet_sha256: packetSha256,
    judge_ids: judgeIds,
    protocol: { blinded: true, arms_randomized: true, prompt_sha256: promptSha256 },
    cases: packets.map((packet) => {
      const result = report.results.find((item) => item.id === packet.case_id);
      const consensus = packet.category === "negative" ? "memory_on" : preferred(result);
      return {
        case_id: packet.case_id,
        category: packet.category,
        arm_mapping: packet.case_id.length % 2 === 0 ? { A: "memory_on", B: "memory_off" } : { A: "memory_off", B: "memory_on" },
        candidate_a_sha256: packet.case_id.length % 2 === 0 ? packet.memory_on_answer_sha256 : packet.memory_off_answer_sha256,
        candidate_b_sha256: packet.case_id.length % 2 === 0 ? packet.memory_off_answer_sha256 : packet.memory_on_answer_sha256,
        memory_on_answer_sha256: packet.memory_on_answer_sha256,
        memory_off_answer_sha256: packet.memory_off_answer_sha256,
        consensus_preferred: consensus,
        forbidden_safe: true,
        votes: judgeIds.map((judgeId) => ({ judge_id: judgeId, preferred: consensus, forbidden_safe: true })),
      };
    }),
  };
  const reviewPath = path.join(dataRoot, ...reviewRelativePath.split("/"));
  json(reviewPath, review);
  const reviewSha256 = sha256(readFileSync(reviewPath));
  const calibration = {
    version: "answer_quality_calibration_v2",
    golden_sha256: report.golden_sha256,
    evaluator_sha256: report.evidence_identity.evaluator_sha256,
    retrieval_index_sha256: report.evidence_identity.retrieval_index_sha256,
    packet_sha256: packetSha256,
    judge_kind: "independent_llm",
    judge_ids: judgeIds,
    judge_model: "fixture-independent-judge",
    judge_prompt_sha256: promptSha256,
    judge_parameters: { blinded: true, arms_randomized: true, temperature: 0 },
    review_artifact_path: reviewRelativePath,
    review_artifact_sha256: reviewSha256,
    generated_at: "2026-07-11T00:02:00.000Z",
    judgments: packets.map((packet) => {
      const result = report.results.find((item) => item.id === packet.case_id);
      return {
        case_id: packet.case_id,
        memory_on_answer_sha256: packet.memory_on_answer_sha256,
        memory_off_answer_sha256: packet.memory_off_answer_sha256,
        preferred: packet.category === "negative" ? "memory_on" : preferred(result),
        forbidden_safe: true,
      };
    }),
  };
  json(path.join(dataRoot, ...calibrationRelativePath.split("/")), calibration);
  return calibration;
}

async function main() {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-answer-quality-v2-"));
  try {
    await seedVault(dataRoot);
    let result = await buildAndWriteAnswerQualityReport(dataRoot, { now: new Date("2026-07-11T00:01:00.000Z") });
    assert(result.report.golden_source === "answer_quality_golden_v2", "explicit answer golden was not selected");
    assert(result.report.status === "needs_attention", "missing calibration produced a false-green answer report");
    assert(result.report.calibration.status === "missing", "missing independent calibration was not reported");
    assert(
      result.report.counts.failed === 0,
      `local adversarial behavior cases should pass before calibration: ${JSON.stringify(
        result.report.results.filter((item) => !item.pass).map((item) => ({
          id: item.id,
          issues: item.issue_codes,
          returned: item.returned_paths,
          actions: item.memory_on.applied_actions,
          metrics: item.memory_on_metrics,
        })),
      )}`,
    );
    assert(result.report.counts.forbidden_returned_paths === 0, "held memory leaked into answer evaluation");
    assert(result.report.coverage.missing_categories.length === 0, "answer category coverage is incomplete");
    assert(result.report.coverage.missing_languages.length === 0, "answer language coverage is incomplete");
    const exact = result.report.results.find((item) => item.id === "aq-fixture-exact");
    assert(exact?.memory_on.citations.includes(exactDistractorPath), "adversarial top-ranked guidance was not present");
    assert(exact?.memory_on.citations.includes(recordPath(definitions[0])), "second reviewed guidance was not synthesized");
    const negative = result.report.results.find((item) => item.category === "negative");
    assert(negative?.returned_paths.length === 0, "judge/task text leaked into the negative answer case");
    assert(
      result.report.results.every((item) => !item.memory_on_answer.includes("GOLDEN_ONLY_NONCE_MUST_NOT_LEAK")),
      "golden-only labels leaked into generated answers",
    );

    const calibration = writeCalibration(dataRoot, result.report);
    result = await buildAndWriteAnswerQualityReport(dataRoot, { now: new Date("2026-07-11T00:03:00.000Z") });
    assert(
      result.report.status === "healthy",
      `calibrated answer fixture should be healthy: ${JSON.stringify({
        status: result.report.status,
        failing_cases: result.report.failing_cases,
        calibration: result.report.calibration,
        evidence_identity: result.report.evidence_identity,
      })}`,
    );
    assert(result.report.calibration.status === "healthy", "independent calibration did not become healthy");
    assert(result.report.calibration.sample_cases === 7, "calibration sample size mismatch");
    assert(result.report.calibration.disagreements === 1, "declared negative-case judge disagreement was not preserved");
    assert(result.report.calibration.disagreement_rate <= 0.15, "judge disagreement exceeded the declared bound");
    assert(result.report.metrics.forbidden_memory_avoidance === 1, "forbidden-memory safety regressed");
    assert(result.report.metrics.current_instruction_compliance === 1, "current instruction was violated");
    assert(result.report.resource_usage.within_budget === true, "1,000-distractor evaluation exceeded the RAM budget");

    const stableRetrievalIdentity = result.report.evidence_identity.retrieval_index_sha256;
    const densePath = path.join(dataRoot, ".dino", "index", "dense-vectors.json");
    const dense = JSON.parse(readFileSync(densePath, "utf8"));
    const operationalPath = "60_Operations/rag-evaluation/new-independent-review.json";
    dense.records[operationalPath] = Array.from({ length: dense.dimensions }, () => 0);
    dense.record_metadata ??= {};
    dense.record_metadata[operationalPath] = {
      contextual_chunk: "generated answer-quality judge operation",
      source_sha256: "f".repeat(64),
      parent_record_path: null,
      language: "en",
      lifecycle_state: "active",
      verification_status: "internal",
      retrieval_lane: "operations",
      knowledge_role: "operations_evidence",
    };
    dense.record_count = Object.keys(dense.records).length;
    dense.record_count_verified = dense.record_count;
    json(densePath, dense);
    const operationalDrift = await buildAndWriteAnswerQualityReport(dataRoot, { now: new Date("2026-07-11T00:03:30.000Z") });
    assert(operationalDrift.report.status === "healthy", "operational evaluation artifact invalidated calibration");
    assert(
      operationalDrift.report.evidence_identity.retrieval_index_sha256 === stableRetrievalIdentity,
      "operational evaluation artifact changed the curated retrieval identity",
    );
    assert(
      operationalDrift.report.results.every((item) => item.returned_paths.every((returnedPath) => !returnedPath.startsWith("60_Operations/"))),
      "operational evaluation artifact leaked into answer retrieval",
    );

    const eligiblePath = Object.keys(dense.records).find((recordPath) => !recordPath.startsWith("60_Operations/"));
    dense.record_metadata ??= {};
    dense.record_metadata[eligiblePath] = { ...(dense.record_metadata[eligiblePath] ?? {}), identity_test_nonce: "metadata-only-drift" };
    json(densePath, dense);
    const metadataDrift = await buildAndWriteAnswerQualityReport(dataRoot, { now: new Date("2026-07-11T00:03:45.000Z") });
    assert(metadataDrift.report.status === "healthy", "stable sampled answers were invalidated by metadata-only index drift");
    assert(
      metadataDrift.report.evidence_identity.retrieval_index_sha256 !== stableRetrievalIdentity,
      "metadata-only drift did not change the retrieval audit identity",
    );
    assert(metadataDrift.report.calibration.retrieval_index_match === false, "calibration index drift was not exposed");
    assert(metadataDrift.report.calibration.review_retrieval_index_match === false, "review index drift was not exposed");
    assert(
      metadataDrift.report.calibration.results.every((item) => item.answer_hashes_match),
      "metadata-only drift changed sampled candidate answers",
    );

    calibration.judgments[0].memory_on_answer_sha256 = "0".repeat(64);
    json(path.join(dataRoot, ...calibrationRelativePath.split("/")), calibration);
    const stale = await buildAndWriteAnswerQualityReport(dataRoot, { now: new Date("2026-07-11T00:04:00.000Z") });
    assert(stale.report.status === "needs_attention", "tampered answer hash produced a false-green report");
    assert(stale.report.calibration.status === "stale", "tampered answer hash was not marked stale");

    console.log("answer quality v2 verification ok");
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  console.error(`cwd=${root}`);
  process.exit(1);
});
