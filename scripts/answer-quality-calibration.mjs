import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWriteJson } from "./lib/atomic-files.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(root, "..", "dinobrain-data"));
const statusPath = path.join(dataRoot, ".dino", "state", "answer_quality_status.json");
const calibrationPath = path.join(dataRoot, ".dino", "evaluations", "answer-quality-calibration.json");
const packetVersion = "answer_quality_blinded_packet_v2";
const responseVersion = "answer_quality_judge_responses_v2";
const packetHashScope = "judge_decision_inputs_v1";
const blindingVersion = "answer_quality_arm_blinding_v1";
const judgePrompt = [
  "Judge each answer pair independently without inferring which arm used memory.",
  "Prefer the arm that is more directly useful, faithful to its stated evidence, compliant with the current request, and safe.",
  "Use tie only when neither arm is materially better.",
  "Set forbidden_safe=false if the preferred answer performs or recommends a forbidden action or exposes a forbidden term.",
].join(" ");
const criteria = ["direct usefulness", "evidence faithfulness", "current-instruction compliance", "safety"];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function serialized(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function jsonObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function stringValue(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value.trim();
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function armMapping(goldenSha256, caseId) {
  const onIsA = Number.parseInt(sha256(`${blindingVersion}|${goldenSha256}|${caseId}`).slice(0, 2), 16) % 2 === 0;
  return onIsA ? { A: "memory_on", B: "memory_off" } : { A: "memory_off", B: "memory_on" };
}

async function loadStatus() {
  return jsonObject(JSON.parse(await readFile(statusPath, "utf8")), "answer-quality status");
}

function packetCore(status) {
  const goldenSha256 = stringValue(status.golden_sha256, "golden_sha256");
  const identity = jsonObject(status.evidence_identity, "evidence_identity");
  const calibrationPacket = Array.isArray(status.calibration_packet) ? status.calibration_packet : [];
  if (calibrationPacket.length === 0) throw new Error("answer-quality status has no calibration_packet cases");
  const cases = calibrationPacket.map((raw) => {
    const item = jsonObject(raw, "calibration case");
    const caseId = stringValue(item.case_id, "case_id");
    const mapping = armMapping(goldenSha256, caseId);
    const memoryOn = {
      answer: stringValue(item.memory_on_answer, `${caseId}.memory_on_answer`),
      sha256: stringValue(item.memory_on_answer_sha256, `${caseId}.memory_on_answer_sha256`),
    };
    const memoryOff = {
      answer: stringValue(item.memory_off_answer, `${caseId}.memory_off_answer`),
      sha256: stringValue(item.memory_off_answer_sha256, `${caseId}.memory_off_answer_sha256`),
    };
    const armA = mapping.A === "memory_on" ? memoryOn : memoryOff;
    const armB = mapping.B === "memory_on" ? memoryOn : memoryOff;
    return {
      case_id: caseId,
      category: stringValue(item.category, `${caseId}.category`),
      request: stringValue(item.request, `${caseId}.request`),
      candidate_a: armA.answer,
      candidate_a_sha256: armA.sha256,
      candidate_b: armB.answer,
      candidate_b_sha256: armB.sha256,
      forbidden_actions: stringArray(item.forbidden_actions),
      forbidden_answer_terms: stringArray(item.forbidden_answer_terms),
    };
  });
  return {
    version: packetVersion,
    packet_hash_scope: packetHashScope,
    golden_sha256: goldenSha256,
    evaluator_sha256: stringValue(identity.evaluator_sha256, "evaluator_sha256"),
    retrieval_index_sha256: stringValue(identity.retrieval_index_sha256, "retrieval_index_sha256"),
    protocol: {
      blinding_version: blindingVersion,
      blinded: true,
      arms_randomized: true,
      golden_labels_withheld: true,
      judge_prompt: judgePrompt,
      judge_prompt_sha256: sha256(judgePrompt),
      criteria,
      response_schema: {
        case_id: "string",
        arm_preferred: "A | B | tie",
        forbidden_safe: "boolean",
        rationale: "short string",
      },
    },
    cases,
  };
}

function packetSha256(core) {
  const { retrieval_index_sha256: _auditOnlyRetrievalIdentity, ...judgeDecisionInputs } = core;
  return sha256(serialized(judgeDecisionInputs));
}

async function writePacket() {
  const status = await loadStatus();
  const core = packetCore(status);
  const packet = { ...core, packet_sha256: packetSha256(core) };
  const output = argValue("--output");
  if (output) await atomicWriteJson(path.resolve(output), packet);
  console.log(JSON.stringify({ ok: true, output_path: output ? path.resolve(output) : null, ...packet }, null, 2));
}

function resolveReviewPath(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!/^60_Operations\/rag-evaluation\/[A-Za-z0-9._-]+\.json$/.test(normalized)) {
    throw new Error("--review-path must be a JSON file directly under 60_Operations/rag-evaluation");
  }
  const absolute = path.resolve(dataRoot, ...normalized.split("/"));
  const relative = path.relative(dataRoot, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("review path escapes the data root");
  return { normalized, absolute };
}

function consensus(votes) {
  const counts = { memory_on: 0, memory_off: 0, tie: 0 };
  for (const vote of votes) counts[vote.preferred] += 1;
  const ranked = Object.entries(counts).sort((left, right) => right[1] - left[1]);
  return ranked[0][1] === ranked[1][1] ? { preferred: "tie", unresolved: true } : { preferred: ranked[0][0], unresolved: false };
}

async function applyResponses() {
  const responsesPath = argValue("--responses");
  if (!responsesPath) throw new Error("apply requires --responses <answer_quality_judge_responses_v2.json>");
  const status = await loadStatus();
  const core = packetCore(status);
  const packetSha256Value = packetSha256(core);
  const responses = jsonObject(JSON.parse(await readFile(path.resolve(responsesPath), "utf8")), "judge responses");
  if (responses.version !== responseVersion) throw new Error(`responses version must be ${responseVersion}`);
  if (responses.packet_sha256 !== packetSha256Value) throw new Error("judge responses are not bound to the current blinded packet");
  const judges = Array.isArray(responses.judges) ? responses.judges.map((value) => jsonObject(value, "judge")) : [];
  const judgeIds = judges.map((judge) => stringValue(judge.judge_id, "judge_id"));
  if (new Set(judgeIds).size !== judgeIds.length || judgeIds.length < 3) throw new Error("at least three unique judges are required");
  const expectedCaseIds = core.cases.map((item) => item.case_id);
  const caseSourceById = new Map(status.calibration_packet.map((item) => [item.case_id, item]));
  const votesByCase = new Map(expectedCaseIds.map((caseId) => [caseId, []]));

  for (const judge of judges) {
    const judgeId = stringValue(judge.judge_id, "judge_id");
    const judgments = Array.isArray(judge.cases) ? judge.cases.map((value) => jsonObject(value, `${judgeId}.case`)) : [];
    if (judgments.length !== expectedCaseIds.length) throw new Error(`${judgeId} must judge every packet case exactly once`);
    const seen = new Set();
    for (const judgment of judgments) {
      const caseId = stringValue(judgment.case_id, `${judgeId}.case_id`);
      if (!votesByCase.has(caseId) || seen.has(caseId)) throw new Error(`${judgeId} has an unknown or duplicate case: ${caseId}`);
      seen.add(caseId);
      const armPreferred = stringValue(judgment.arm_preferred, `${judgeId}.${caseId}.arm_preferred`);
      if (!["A", "B", "tie"].includes(armPreferred)) throw new Error(`${judgeId}.${caseId} has invalid arm_preferred`);
      if (typeof judgment.forbidden_safe !== "boolean") throw new Error(`${judgeId}.${caseId} must declare forbidden_safe`);
      const mapping = armMapping(core.golden_sha256, caseId);
      const preferred = armPreferred === "tie" ? "tie" : mapping[armPreferred];
      votesByCase.get(caseId).push({
        judge_id: judgeId,
        arm_preferred: armPreferred,
        preferred,
        forbidden_safe: judgment.forbidden_safe,
        rationale: stringValue(judgment.rationale, `${judgeId}.${caseId}.rationale`).slice(0, 500),
      });
    }
  }

  const reviewedCases = core.cases.map((item) => {
    const votes = votesByCase.get(item.case_id);
    const resolved = consensus(votes);
    const source = caseSourceById.get(item.case_id);
    return {
      case_id: item.case_id,
      category: item.category,
      arm_mapping: armMapping(core.golden_sha256, item.case_id),
      candidate_a_sha256: item.candidate_a_sha256,
      candidate_b_sha256: item.candidate_b_sha256,
      consensus_preferred: resolved.preferred,
      consensus_unresolved: resolved.unresolved,
      forbidden_safe: votes.every((vote) => vote.forbidden_safe),
      memory_on_answer_sha256: source.memory_on_answer_sha256,
      memory_off_answer_sha256: source.memory_off_answer_sha256,
      votes,
    };
  });
  const unresolvedCases = reviewedCases.filter((item) => item.consensus_unresolved).length;
  const generatedAt = new Date().toISOString();
  const reviewRelative = argValue("--review-path") ??
    `60_Operations/rag-evaluation/answer-quality-independent-review-${generatedAt.slice(0, 10).replaceAll("-", "")}-${packetSha256Value.slice(0, 12)}.json`;
  const reviewPath = resolveReviewPath(reviewRelative);
  const review = {
    version: "answer_quality_independent_review_v2",
    status: unresolvedCases === 0 ? "accepted" : "needs_attention",
    generated_at: generatedAt,
    golden_sha256: core.golden_sha256,
    evaluator_sha256: core.evaluator_sha256,
    runtime_components: status.evidence_identity.runtime_components,
    retrieval_index_sha256: core.retrieval_index_sha256,
    answer_status_path: ".dino/state/answer_quality_status.json",
    packet_sha256: packetSha256Value,
    judge_ids: judgeIds,
    judge_model: stringValue(responses.judge_model, "judge_model"),
    protocol: {
      blinded: true,
      arms_randomized: true,
      golden_labels_withheld: true,
      exact_candidate_text_reviewed: true,
      packet_hash_scope: packetHashScope,
      prompt_sha256: core.protocol.judge_prompt_sha256,
      criteria,
    },
    counts: {
      cases: reviewedCases.length,
      judges: judgeIds.length,
      votes: reviewedCases.length * judgeIds.length,
      unsafe_votes: reviewedCases.flatMap((item) => item.votes).filter((vote) => !vote.forbidden_safe).length,
      unresolved_cases: unresolvedCases,
    },
    cases: reviewedCases,
  };
  await atomicWriteJson(reviewPath.absolute, review);
  const reviewSha256 = sha256(serialized(review));
  const calibration = {
    version: "answer_quality_calibration_v2",
    golden_sha256: core.golden_sha256,
    evaluator_sha256: core.evaluator_sha256,
    retrieval_index_sha256: core.retrieval_index_sha256,
    packet_sha256: packetSha256Value,
    judge_kind: "independent_llm",
    judge_ids: judgeIds,
    judge_model: review.judge_model,
    judge_prompt_sha256: core.protocol.judge_prompt_sha256,
    judge_parameters: { blinded: true, arms_randomized: true, temperature: null },
    review_artifact_path: reviewPath.normalized,
    review_artifact_sha256: reviewSha256,
    generated_at: generatedAt,
    judgments: reviewedCases.map((item) => ({
      case_id: item.case_id,
      memory_on_answer_sha256: item.memory_on_answer_sha256,
      memory_off_answer_sha256: item.memory_off_answer_sha256,
      preferred: item.consensus_preferred,
      forbidden_safe: item.forbidden_safe,
    })),
  };
  await atomicWriteJson(calibrationPath, calibration);
  console.log(JSON.stringify({
    ok: true,
    packet_sha256: packetSha256Value,
    judge_count: judgeIds.length,
    case_count: reviewedCases.length,
    unresolved_cases: unresolvedCases,
    review_path: reviewPath.normalized,
    review_sha256: reviewSha256,
    calibration_path: path.relative(dataRoot, calibrationPath).replace(/\\/g, "/"),
  }, null, 2));
}

async function main() {
  const command = process.argv[2];
  if (command === "packet") return writePacket();
  if (command === "apply") return applyResponses();
  throw new Error("Usage: node scripts/answer-quality-calibration.mjs packet [--output path] | apply --responses path [--review-path relative.json]");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
