import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "scripts", "answer-quality-calibration.mjs");

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

function answerCase(caseId, category) {
  const memoryOnAnswer = `Reviewed answer for ${caseId}`;
  const memoryOffAnswer = `No memory answer for ${caseId}`;
  return {
    case_id: caseId,
    category,
    request: `Request for ${caseId}`,
    memory_on_answer: memoryOnAnswer,
    memory_off_answer: memoryOffAnswer,
    memory_on_answer_sha256: sha256(memoryOnAnswer),
    memory_off_answer_sha256: sha256(memoryOffAnswer),
    forbidden_actions: [],
    forbidden_answer_terms: [],
  };
}

function run(dataRoot, args) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: root,
    env: { ...process.env, DINOBRAIN_DATA_DIR: dataRoot },
    encoding: "utf8",
  });
}

function main() {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-answer-quality-calibration-cli-"));
  try {
    const status = {
      golden_sha256: "1".repeat(64),
      evidence_identity: {
        evaluator_sha256: "2".repeat(64),
        retrieval_index_sha256: "3".repeat(64),
        runtime_components: { answer_quality: "4".repeat(64) },
      },
      calibration_packet: [
        answerCase("case-exact", "exact"),
        answerCase("case-negative", "negative"),
        answerCase("case-current", "current_instruction"),
      ],
    };
    json(path.join(dataRoot, ".dino", "state", "answer_quality_status.json"), status);
    const packetPath = path.join(dataRoot, ".dino", "tmp", "blinded-packet.json");
    const packetOutput = JSON.parse(run(dataRoot, ["packet", "--output", packetPath]));
    const packet = JSON.parse(readFileSync(packetPath, "utf8"));
    assert(packetOutput.ok === true && packet.packet_sha256 === packetOutput.packet_sha256, "packet output mismatch");
    assert(packet.version === "answer_quality_blinded_packet_v2", "packet version mismatch");
    assert(packet.packet_hash_scope === "judge_decision_inputs_v1", "packet hash scope mismatch");
    assert(packet.cases.length === 3, "packet case count mismatch");
    const packetText = readFileSync(packetPath, "utf8");
    assert(!packetText.includes("memory_on") && !packetText.includes("memory_off"), "blinded packet leaked arm labels");

    status.evidence_identity.retrieval_index_sha256 = "5".repeat(64);
    json(path.join(dataRoot, ".dino", "state", "answer_quality_status.json"), status);
    const driftedPacketPath = path.join(dataRoot, ".dino", "tmp", "blinded-packet-drifted.json");
    const driftedPacket = JSON.parse(run(dataRoot, ["packet", "--output", driftedPacketPath]));
    assert(driftedPacket.retrieval_index_sha256 !== packet.retrieval_index_sha256, "audit retrieval identity did not change");
    assert(driftedPacket.packet_sha256 === packet.packet_sha256, "audit-only index drift changed the judge decision hash");

    const judges = ["judge-a", "judge-b", "judge-c"].map((judgeId) => ({
      judge_id: judgeId,
      cases: packet.cases.map((item) => ({
        case_id: item.case_id,
        arm_preferred: "A",
        forbidden_safe: true,
        rationale: `Candidate A is more directly useful for ${item.case_id}.`,
      })),
    }));
    const responsesPath = path.join(dataRoot, ".dino", "tmp", "responses.json");
    json(responsesPath, {
      version: "answer_quality_judge_responses_v2",
      packet_sha256: packet.packet_sha256,
      judge_model: "isolated-fixture",
      judges,
    });
    const reviewRelative = "60_Operations/rag-evaluation/answer-quality-independent-review-fixture.json";
    const applied = JSON.parse(run(dataRoot, ["apply", "--responses", responsesPath, "--review-path", reviewRelative]));
    const review = JSON.parse(readFileSync(path.join(dataRoot, ...reviewRelative.split("/")), "utf8"));
    const calibration = JSON.parse(
      readFileSync(path.join(dataRoot, ".dino", "evaluations", "answer-quality-calibration.json"), "utf8"),
    );
    assert(applied.ok === true && applied.judge_count === 3, "calibration apply failed");
    assert(review.counts.votes === 9 && review.counts.unresolved_cases === 0, "review vote counts mismatch");
    assert(calibration.judge_ids.length === 3 && calibration.judgments.length === 3, "calibration output mismatch");
    assert(calibration.version === "answer_quality_calibration_v2", "calibration version mismatch");
    assert(calibration.packet_sha256 === packet.packet_sha256, "calibration decision binding mismatch");
    assert(calibration.review_artifact_sha256 === sha256(readFileSync(path.join(dataRoot, ...reviewRelative.split("/")))), "review hash mismatch");

    const tamperedPath = path.join(dataRoot, ".dino", "tmp", "tampered-responses.json");
    json(tamperedPath, {
      version: "answer_quality_judge_responses_v2",
      packet_sha256: "0".repeat(64),
      judge_model: "isolated-fixture",
      judges,
    });
    const tampered = spawnSync(process.execPath, [cli, "apply", "--responses", tamperedPath], {
      cwd: root,
      env: { ...process.env, DINOBRAIN_DATA_DIR: dataRoot },
      encoding: "utf8",
    });
    assert(tampered.status !== 0, "tampered packet binding was accepted");
    assert(tampered.stderr.includes("not bound to the current blinded packet"), "tamper failure reason missing");
    console.log("answer quality calibration CLI verification ok");
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
