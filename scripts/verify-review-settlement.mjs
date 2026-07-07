import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modulePath = pathToFileURL(path.join(root, "dist", "review-settlement.js")).href;
const {
  buildAndWriteReviewSettlements,
  settleReviewQueueActions,
  REVIEW_QUEUE_STATUS_RELATIVE_PATH,
  REVIEW_SETTLEMENT_ACTIONS_RELATIVE_PATH,
  SEMANTIC_JOBS_RELATIVE_PATH,
} = await import(modulePath);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function json(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function candidate(dataRoot, id, extra = {}) {
  json(path.join(dataRoot, "50_Instances", "candidates", `${id}.json`), {
    candidate_id: id,
    type: "behavior_rule",
    status: "pending_review",
    claim: `Behavior rule: ${id}`,
    behavior_rule: `Use ${id} when relevant.`,
    evidence: {
      source: `.dino/traces/${id}.json`,
      snippet: `Evidence for ${id}.`,
    },
    confidence: "medium",
    last_verified: "2026-07-07",
    tags: ["behavior-rule", "auto-compounded"],
    auto_generated: true,
    promotion_blockers: ["manual_review_required", "auto_compounded_behavior_rule"],
    ...extra,
  });
}

function review(dataRoot, id, extra = {}) {
  json(path.join(dataRoot, "80_Review_Queue", "promotion", `${id}.json`), {
    review_id: id,
    type: "promotion",
    status: "pending",
    candidate_path: `50_Instances/candidates/${id}.json`,
    required_checks: ["evidence_snippet", "confidence", "last_verified", "scope"],
    promotion_blockers: ["manual_review_required", "auto_compounded_behavior_rule"],
    ...extra,
  });
}

async function main() {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-review-settlement-"));
  try {
    candidate(dataRoot, "behavior-ready");
    review(dataRoot, "behavior-ready");

    candidate(dataRoot, "legacy-hold", {
      promotion_blockers: ["manual_review_required", "legacy_unreviewed_accepted"],
      legacy_accepted_path: "50_Instances/accepted/legacy-hold.json",
    });
    review(dataRoot, "legacy-hold", {
      promotion_blockers: ["manual_review_required", "legacy_unreviewed_accepted"],
      previous_accepted_path: "50_Instances/accepted/legacy-hold.json",
    });

    candidate(dataRoot, "missing-evidence", {
      evidence: {},
      confidence: "",
      last_verified: "",
      promotion_blockers: ["manual_review_required"],
    });
    review(dataRoot, "missing-evidence", { promotion_blockers: ["manual_review_required"] });

    candidate(dataRoot, "candidate-without-review");

    review(dataRoot, "review-without-candidate", {
      candidate_path: "50_Instances/candidates/review-without-candidate.json",
      promotion_blockers: ["manual_review_required"],
    });

    candidate(dataRoot, "closed");
    review(dataRoot, "closed", { status: "approved" });

    const result = await buildAndWriteReviewSettlements(dataRoot);
    const reviewReport = result.review;
    const semanticReport = result.semantic;
    assert(existsSync(path.join(dataRoot, REVIEW_QUEUE_STATUS_RELATIVE_PATH)), "review status report missing");
    assert(existsSync(path.join(dataRoot, SEMANTIC_JOBS_RELATIVE_PATH)), "semantic jobs report missing");
    assert(reviewReport.counts.candidates === 5, `candidate count mismatch: ${reviewReport.counts.candidates}`);
    assert(reviewReport.counts.promotion_reviews === 5, `review count mismatch: ${reviewReport.counts.promotion_reviews}`);
    assert(reviewReport.counts.unclassified_open === 0, "review settlement left unclassified open items");
    assert(reviewReport.counts.candidate_without_review === 1, "candidate-without-review not classified");
    assert(reviewReport.counts.review_without_candidate === 1, "review-without-candidate not classified");
    assert(reviewReport.by_decision_class.auto_compounded_behavior_hold >= 1, "behavior hold class missing");
    assert(reviewReport.by_decision_class.legacy_unreviewed_hold === 1, "legacy hold class missing");
    assert(reviewReport.by_decision_class.evidence_repair_required === 1, "evidence repair class missing");
    assert(semanticReport.counts.unclassified_open === 0, "semantic settlement left unclassified jobs");
    assert(semanticReport.counts.manual_review >= 2, "manual semantic review jobs missing");
    assert(semanticReport.jobs.every((job) => job.reason_code && job.next_action), "semantic job missing reason or next action");

    const persisted = JSON.parse(readFileSync(path.join(dataRoot, REVIEW_QUEUE_STATUS_RELATIVE_PATH), "utf8"));
    assert(persisted.visible_status, "review report missing visible status");

    const dryRun = await settleReviewQueueActions(dataRoot);
    assert(dryRun.actions.status === "needs_attention", "dry-run should require auto-hold apply");
    assert(dryRun.actions.counts.auto_hold_candidates_before === 2, "dry-run did not find both auto-hold candidates");
    assert(dryRun.actions.counts.auto_hold_applied === 0, "dry-run should not apply actions");
    assert(existsSync(path.join(dataRoot, REVIEW_SETTLEMENT_ACTIONS_RELATIVE_PATH)), "settlement action report missing");

    const applied = await settleReviewQueueActions(dataRoot, { apply: true, now: new Date("2026-07-07T00:00:00.000Z") });
    assert(applied.actions.status === "healthy", "apply should clear auto-hold candidates");
    assert(applied.actions.counts.auto_hold_applied === 2, "apply did not hold both deterministic candidates");
    assert(applied.review.by_decision_class.auto_compounded_behavior_hold === 0, "behavior hold remained open after apply");
    assert(applied.review.by_decision_class.legacy_unreviewed_hold === 0, "legacy hold remained open after apply");
    assert(applied.review.by_decision_class.evidence_repair_required === 1, "evidence repair blocker disappeared");
    assert(applied.review.counts.closed === 3, "closed count did not include held reviews");
    assert(applied.review.counts.open === 3, "manual repair/mapping items should remain open");

    const heldCandidate = JSON.parse(readFileSync(path.join(dataRoot, "50_Instances", "candidates", "behavior-ready.json"), "utf8"));
    const heldReview = JSON.parse(readFileSync(path.join(dataRoot, "80_Review_Queue", "promotion", "behavior-ready.json"), "utf8"));
    assert(heldCandidate.status === "held" && heldCandidate.quarantine === true, "held candidate was not quarantined");
    assert(heldReview.status === "settled_hold" && heldReview.decision === "hold", "review was not settled as hold");

    console.log("review settlement verification ok");
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  console.error(`cwd=${root}`);
  process.exit(1);
});
