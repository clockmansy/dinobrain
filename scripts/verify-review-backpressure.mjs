import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modulePath = pathToFileURL(path.join(root, "dist", "review-backpressure.js")).href;
const {
  buildReviewQueueBackpressure,
  getReviewQueueAdmissionPath,
  simulateReviewQueueAdmissions,
  writeReviewGatedBatch,
} = await import(modulePath);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function json(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function candidate(dataRoot, id, claim, extra = {}) {
  json(path.join(dataRoot, "50_Instances", "candidates", `${id}.json`), {
    candidate_id: id,
    status: "pending_review",
    claim,
    evidence: { source: `.dino/traces/${id}.json`, snippet: claim },
    confidence: "medium",
    last_verified: "2026-07-11",
    tags: ["project:dinobrain"],
    promotion_blockers: ["manual_review_required"],
    ...extra,
  });
  json(path.join(dataRoot, "80_Review_Queue", "promotion", `${id}.json`), {
    review_id: id,
    status: "pending",
    candidate_path: `50_Instances/candidates/${id}.json`,
    promotion_blockers: extra.promotion_blockers ?? ["manual_review_required"],
  });
}

function gatedItem(id, at = "2026-07-11T00:00:00.000Z") {
  return {
    idempotency_key: `verify-${id}`,
    lane: "manual_semantic",
    candidate_path: `50_Instances/candidates/${id}.json`,
    candidate_record: {
      candidate_id: id,
      status: "pending_review",
      claim: `Candidate ${id}`,
      evidence: { source: `.dino/traces/${id}.json`, snippet: `Candidate ${id}` },
      confidence: "medium",
      last_verified: "2026-07-11",
      promotion_blockers: ["manual_review_required"],
      created_at: at,
      updated_at: at,
    },
    review_path: `80_Review_Queue/promotion/${id}.json`,
    review_record: {
      review_id: id,
      status: "pending",
      candidate_path: `50_Instances/candidates/${id}.json`,
      created_at: at,
      updated_at: at,
    },
    candidate_evidence_paths: [`.dino/traces/${id}.json`],
    at,
  };
}

async function main() {
  const roots = [];
  try {
    const reportRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-review-pressure-report-"));
    roots.push(reportRoot);
    candidate(reportRoot, "manual-a", "User preference: Keep progress concise.");
    candidate(reportRoot, "manual-b", "User preference: Keep progress concise.");
    candidate(reportRoot, "behavior-a", "Behavior rule: Always mention every file.", {
      type: "behavior_rule",
      behavior_rule: "Always mention every file.",
      auto_generated: true,
      promotion_blockers: ["manual_review_required", "auto_compounded_behavior_rule"],
    });
    const report = await buildReviewQueueBackpressure(reportRoot, {
      now: new Date("2026-07-11T00:00:00.000Z"),
      reconcileAdmission: true,
    });
    assert(report.report.status === "needs_settlement", "deterministic hold must constrain queue");
    assert(report.report.counts.deterministic_hold_pending === 1, "deterministic hold count mismatch");
    assert(report.report.lanes.merge_review.hot_units === 1, "duplicate cluster must consume one merge-review unit");
    assert(report.report.growth_mode === "cold_only", "unsettled queue must fail closed to cold admission");
    assert(existsSync(getReviewQueueAdmissionPath(reportRoot)), "reconciled admission state missing");

    const simulation = simulateReviewQueueAdmissions(
      { manual_semantic: 103, merge_review: 35 },
      Array.from({ length: 1000 }, () => "manual_semantic"),
    );
    assert(simulation.hot_total <= 500, "1000-session simulation exceeded total hot budget");
    assert(simulation.final_hot_counts.manual_semantic <= 300, "1000-session simulation exceeded lane budget");
    assert(simulation.hot_admitted === 197, "simulation admitted an unexpected number of hot sessions");
    assert(simulation.cold_held === 803, "simulation did not route overflow to cold hold");

    const failClosedRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-review-pressure-closed-"));
    roots.push(failClosedRoot);
    const machinePathItem = gatedItem("missing-state");
    machinePathItem.candidate_record.claim = "Read C:\\Users\\sample-user\\private\\notes.md";
    machinePathItem.review_record.notes = "/home/sample-user/private/review.md";
    const failClosed = await writeReviewGatedBatch(failClosedRoot, {
      items: [machinePathItem],
      extra_writes: [
        {
          target_path: ".dino/state/extra-write.json",
          record: { evidence: "C:\\Users\\sample-user\\private\\extra.json" },
          expected_before_sha256: null,
        },
      ],
      actor: "verification",
      reason: "Prove missing admission state fails closed.",
    });
    assert(failClosed.decisions[0].destination === "cold_hold", "missing state did not fail closed");
    const held = JSON.parse(readFileSync(path.join(failClosedRoot, "50_Instances", "candidates", "missing-state.json"), "utf8"));
    assert(held.status === "held" && held.temperature === "cold", "fail-closed candidate was not cold-held");
    const heldReview = JSON.parse(readFileSync(path.join(failClosedRoot, "80_Review_Queue", "promotion", "missing-state.json"), "utf8"));
    assert(!JSON.stringify(held).includes("sample-user"), "candidate persisted a machine-local path");
    assert(!JSON.stringify(heldReview).includes("sample-user"), "review persisted a machine-local path");
    const extraWrite = JSON.parse(readFileSync(path.join(failClosedRoot, ".dino", "state", "extra-write.json"), "utf8"));
    assert(!JSON.stringify(extraWrite).includes("sample-user"), "extra lifecycle write persisted a machine-local path");

    const concurrentRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-review-pressure-concurrent-"));
    roots.push(concurrentRoot);
    await buildReviewQueueBackpressure(concurrentRoot, {
      now: new Date("2026-07-11T00:00:00.000Z"),
      reconcileAdmission: true,
    });
    const concurrent = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        writeReviewGatedBatch(concurrentRoot, {
          items: [gatedItem(`parallel-${index}`, new Date(Date.UTC(2026, 6, 11, 0, 0, index)).toISOString())],
          actor: "verification",
          reason: `Parallel admission ${index}`,
        }),
      ),
    );
    assert(concurrent.every((result) => result.decisions[0].destination === "hot_review"), "parallel safe admissions were not hot");
    const concurrentState = JSON.parse(readFileSync(getReviewQueueAdmissionPath(concurrentRoot), "utf8"));
    assert(concurrentState.hot_total === 24, "parallel admission counter lost updates");
    assert(concurrentState.sequence === 24, "parallel admission sequence collided");

    const faultRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-review-pressure-fault-"));
    roots.push(faultRoot);
    await buildReviewQueueBackpressure(faultRoot, {
      now: new Date("2026-07-11T00:00:00.000Z"),
      reconcileAdmission: true,
    });
    const stateBefore = readFileSync(getReviewQueueAdmissionPath(faultRoot));
    let faulted = false;
    try {
      await writeReviewGatedBatch(faultRoot, {
        items: [gatedItem("fault")],
        actor: "verification",
        reason: "Inject fault into admission transaction.",
        fault_after_write_index_for_test: 1,
      });
    } catch {
      faulted = true;
    }
    assert(faulted, "fault injection did not fail");
    assert(!existsSync(path.join(faultRoot, "50_Instances", "candidates", "fault.json")), "fault left candidate behind");
    assert(!existsSync(path.join(faultRoot, "80_Review_Queue", "promotion", "fault.json")), "fault left review behind");
    assert(readFileSync(getReviewQueueAdmissionPath(faultRoot)).equals(stateBefore), "fault did not restore admission counter exactly");

    console.log(
      JSON.stringify({
        ok: true,
        simulation_sessions: 1000,
        simulation_hot: simulation.hot_admitted,
        simulation_cold: simulation.cold_held,
        parallel_writers: 24,
        fault_rollback: true,
        machine_local_redaction: true,
      }),
    );
  } finally {
    for (const dataRoot of roots) rmSync(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
