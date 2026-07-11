import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [{ buildAndWriteWikiIndex }, { buildAndWriteRagEvalReport, RAG_EVAL_STATUS_RELATIVE_PATH }] = await Promise.all([
  import(pathToFileURL(path.join(root, "dist", "wiki-index.js")).href),
  import(pathToFileURL(path.join(root, "dist", "rag-eval.js")).href),
]);

const categories = [
  "exact",
  "paraphrase",
  "rare_exact",
  "negative",
  "provenance",
  "quarantine",
  "recency",
  "correction",
  "noisy_growth",
  "forbidden_memory",
  "current_instruction",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function json(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function text(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value, "utf8");
}

function queryFor(category, index) {
  if (category === "negative") return "달의 치즈 재고번호 moon cheese inventory zxqv";
  return index % 2 === 0
    ? `검토된 ${category} 검색 규칙 marker-${category}`
    : `Find the reviewed ${category} retrieval rule marker-${category}`;
}

function acceptedRecord(category, query, recordPath, candidatePath, reviewPath) {
  const at = "2026-07-11T00:00:00.000Z";
  const transitionId = `node-transition-rule-${category}`;
  return {
    memory_id: `rule-${category}`,
    node_id: `rule-${category}`,
    knowledge_role: "behavior_guidance",
    title: `Reviewed ${category} retrieval rule`,
    aliases: [query],
    claim: `marker-${category} is the required reviewed evidence for ${category}.`,
    reusable_rule: `Use marker-${category} and cite its verified source.`,
    tags: ["rag-eval", "operating-rule", category],
    status: "accepted",
    lifecycle_version: "node_lifecycle_v3",
    lifecycle_state: "accepted",
    lifecycle_state_entered_at: at,
    lifecycle_last_transition_id: transitionId,
    lifecycle_history: [{
      transition_id: transitionId,
      idempotency_key: `verify-rag-eval|${category}|accepted`,
      from_state: null,
      to_state: "accepted",
      reason_code: "verified_fixture",
      reason: "Seed a reviewed accepted memory for RAG evaluation.",
      actor: "verify-rag-eval",
      evidence_paths: ["30_Sources/chunks/eval-source.json"],
      predecessor_paths: [],
      successor_paths: [],
      at,
    }],
    predecessor_paths: [],
    successor_paths: [],
    review_status: "accepted_by_agent_review",
    reviewed_by: "verify-rag-eval",
    reviewed_at: at,
    updated_at: at,
    source_candidate_path: candidatePath,
    source_review_path: reviewPath,
    source_paths: ["30_Sources/chunks/eval-source.json"],
    evidence: { source: "30_Sources/chunks/eval-source.json" },
  };
}

async function seedVault(dataRoot) {
  text(path.join(dataRoot, "20_Wiki", "README.md"), "# Wiki\n\nEvaluation fixture.\n");
  json(path.join(dataRoot, "30_Sources", "chunks", "eval-source.json"), {
    title: "Verified evaluation source",
    source_uri: "https://example.invalid/eval-source",
    source_status: "verified_chunk",
    chunk_text: "Evaluation records are reviewed and source-backed.",
    last_verified: "2026-07-11",
  });

  const cases = [];
  const records = {};
  const queries = {};
  for (const [index, category] of categories.entries()) {
    const query = queryFor(category, index);
    queries[query.toLowerCase()] = category === "negative" ? [0, 1] : [1, 0];
    if (category === "negative") {
      cases.push({
        id: `rag-v2-${category}`,
        category,
        language: "ko",
        query,
        expected_paths: [],
        forbidden_paths: ["50_Instances/accepted/held-exact.json"],
        min_memory_lift: 0,
        max_noise_paths: 0,
        require_hybrid: false,
      });
      continue;
    }
    const recordPath = `50_Instances/accepted/rule-${category}.json`;
    const candidatePath = `50_Instances/candidates/rule-${category}.json`;
    const reviewPath = `50_Instances/reviews/rule-${category}.json`;
    records[recordPath] = [1, 0];
    json(path.join(dataRoot, ...candidatePath.split("/")), { candidate_id: `rule-${category}`, status: "reviewed" });
    json(path.join(dataRoot, ...reviewPath.split("/")), {
      status: "approved",
      candidate_path: candidatePath,
      accepted_path: recordPath,
    });
    json(path.join(dataRoot, ...recordPath.split("/")), acceptedRecord(category, query, recordPath, candidatePath, reviewPath));
    cases.push({
      id: `rag-v2-${category}`,
      category,
      language: index % 2 === 0 ? "ko" : "en",
      query,
      expected_paths: [recordPath],
      forbidden_paths: ["50_Instances/accepted/held-exact.json"],
      required_terms: [`marker-${category}`],
      required_knowledge_roles: ["behavior_guidance"],
      max_noise_paths: 4,
      require_hybrid: true,
    });
  }

  json(path.join(dataRoot, "50_Instances", "accepted", "held-exact.json"), {
    title: "Held exact-match memory",
    aliases: [queryFor("quarantine", categories.indexOf("quarantine"))],
    claim: "This held memory must never satisfy default evaluation retrieval.",
    status: "hold",
    lifecycle_state: "hold",
    review_status: "pending",
  });
  json(path.join(dataRoot, ".dino", "tasks", "judge-leak.json"), {
    task_id: "judge-leak",
    status: "completed",
    request: queryFor("negative", categories.indexOf("negative")),
    summary: "The blinded judge repeated the negative golden query.",
  });
  for (let index = 0; index < 1000; index += 1) {
    text(path.join(dataRoot, "20_Wiki", "distractors", `noise-${String(index).padStart(4, "0")}.md`), `# Distractor ${index}\n\nunrelated-${index}-token\n`);
  }

  const golden = {
    version: 2,
    golden_id: "rag-eval-v2-independent-fixture",
    description: "Versioned bilingual adversarial retrieval fixture.",
    pack_limit: 5,
    target_recall: 1,
    target_required_term_recall: 1,
    target_memory_lift: 10,
    min_hybrid_ratio: 0.9,
    minimum_cases: categories.length,
    max_noise_paths: 4,
    max_p95_latency_ms: 1500,
    required_categories: categories,
    required_languages: ["ko", "en"],
    cases,
  };
  json(path.join(dataRoot, ".dino", "evaluations", "rag-golden.json"), golden);
  json(path.join(dataRoot, ".dino", "evaluations", "behavior-golden.json"), {
    version: 1,
    cases: [{ id: "poison-fallback", request: "fallback must not run", expected_memory_paths: [] }],
  });
  await buildAndWriteWikiIndex(dataRoot);
  return { golden, records, queries };
}

async function main() {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-rag-eval-v2-"));
  try {
    const fixture = await seedVault(dataRoot);
    const goldenPath = path.join(dataRoot, ".dino", "evaluations", "rag-golden.json");
    const goldenBytes = readFileSync(goldenPath);

    let result = await buildAndWriteRagEvalReport(dataRoot, { now: new Date("2026-07-11T00:00:00.000Z") });
    assert(result.report.golden_source === "rag_golden_v2", "explicit v2 golden was not selected");
    assert(result.report.status === "needs_attention", "lexical fallback produced a false-green RAG evaluation");
    assert(result.report.counts.lexical_fallback > 0, "lexical fallback was not reported");

    json(path.join(dataRoot, ".dino", "index", "dense-vectors.json"), {
      version: 2,
      provider: "test_semantic_provider",
      model: "test-semantic-model",
      dimensions: 2,
      semantic_embedding_provider: true,
      records: fixture.records,
      queries: fixture.queries,
    });
    result = await buildAndWriteRagEvalReport(dataRoot, { now: new Date("2026-07-11T00:01:00.000Z") });
    assert(
      result.report.status === "healthy",
      `hybrid v2 fixture should be healthy, got ${result.report.status}: ${JSON.stringify(
        result.report.results.filter((item) => !item.pass).map((item) => ({
          id: item.id,
          issues: item.issue_codes,
          returned: item.returned_paths,
        })),
      )}`,
    );
    assert(result.report.counts.cases === categories.length, "adversarial case count mismatch");
    assert(result.report.counts.failed === 0, "a v2 adversarial retrieval case failed");
    assert(result.report.coverage.missing_categories.length === 0, "required category coverage is incomplete");
    assert(result.report.coverage.missing_languages.length === 0, "bilingual coverage is incomplete");
    assert(result.report.counts.forbidden_returned_paths === 0, "held/quarantined memory leaked into retrieval");
    const negative = result.report.results.find((item) => item.category === "negative");
    assert(negative?.returned_paths.length === 0, "recent judge/task text leaked into the negative evaluation");
    assert(result.report.p95_latency_ms <= 1500, "1,000-distractor fixture exceeded the latency budget");
    assert(readFileSync(goldenPath).equals(goldenBytes), "RAG evaluation modified the explicit golden file");

    json(goldenPath, { ...fixture.golden, version: 1 });
    const invalid = await buildAndWriteRagEvalReport(dataRoot, { now: new Date("2026-07-11T00:02:00.000Z") });
    assert(invalid.report.status === "degraded", "invalid v1 golden did not fail closed");
    assert(invalid.report.golden_source === "invalid", "invalid golden source was mislabeled");

    assert(readFileSync(path.join(dataRoot, RAG_EVAL_STATUS_RELATIVE_PATH)).length > 0, "RAG eval status was not written");
    console.log("rag eval v2 verification ok");
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  console.error(`cwd=${root}`);
  process.exit(1);
});
