import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modulePath = pathToFileURL(path.join(root, "dist", "review-worklist-actions.js")).href;
const {
  buildReviewWorklistActions,
  REVIEW_WORKLIST_ACTIONS_STATE_RELATIVE_PATH,
  REVIEW_WORKLIST_ACTIONS_OPERATIONS_DIR,
  REVIEW_WORKLIST_MERGE_QUEUE_DIR,
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
    evidence: {
      source: `10_Conversations/raw/${id}.json#m0001`,
      snippet: claim,
    },
    confidence: "medium",
    last_verified: "2026-07-07",
    tags: ["session-import", "project:dinobrain"],
    promotion_blockers: ["manual_review_required", "session_extraction_v0"],
    ...extra,
  });
  json(path.join(dataRoot, "80_Review_Queue", "promotion", `${id}.json`), {
    review_id: id,
    type: "promotion",
    status: "pending",
    candidate_path: `50_Instances/candidates/${id}.json`,
    promotion_blockers: ["manual_review_required", "session_extraction_v0"],
  });
}

async function main() {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-review-worklist-actions-"));
  try {
    candidate(dataRoot, "pref-a", "User preference: Prefer concise Korean progress updates.");
    candidate(dataRoot, "pref-b", "User preference: Prefer concise Korean progress updates.");
    candidate(dataRoot, "state-a", "Project state: Current UI screenshot is stale.");
    candidate(dataRoot, "general-a", "Task outcome for dinobrain: This was a local proof run under C:\\Users\\alice\\dinobrain.");
    candidate(dataRoot, "howto-a", "How-to note: Preserve release notes after publishing.");

    const dryRun = await buildReviewWorklistActions(dataRoot, { now: new Date("2026-07-07T00:00:00.000Z") });
    assert(dryRun.report.status === "needs_apply", "dry run should require explicit apply flags");
    assert(dryRun.report.counts.actions === 4, "dry run action count mismatch");
    assert(dryRun.report.counts.merge_review_actions === 1, "merge review action missing");
    assert(dryRun.report.counts.deterministic_hold_actions === 0, "unexpected deterministic hold actions");
    assert(dryRun.report.counts.manual_only_actions === 3, "manual-only action count mismatch");
    assert(dryRun.report.counts.applied === 0, "dry run should not apply actions");
    assert(existsSync(path.join(dataRoot, REVIEW_WORKLIST_ACTIONS_STATE_RELATIVE_PATH)), "action state report missing");
    const publicSummaryPath = path.join(dataRoot, REVIEW_WORKLIST_ACTIONS_OPERATIONS_DIR, "review-worklist-actions-20260707-4.json");
    assert(existsSync(publicSummaryPath), "public action summary missing");
    const publicSummary = JSON.parse(readFileSync(publicSummaryPath, "utf8"));
    assert(!JSON.stringify(publicSummary).includes("C:\\Users\\alice"), "public action summary leaked local home path");
    assert(!JSON.stringify(publicSummary).includes("Task outcome for dinobrain"), "public action summary leaked representative claim");

    const dryCandidate = JSON.parse(readFileSync(path.join(dataRoot, "50_Instances", "candidates", "state-a.json"), "utf8"));
    assert(dryCandidate.status === "pending_review", "dry run mutated a candidate");

    const applied = await buildReviewWorklistActions(dataRoot, {
      now: new Date("2026-07-07T00:00:00.000Z"),
      applyHolds: true,
      applyMergeReviews: true,
      requireGitRecoveryRef: false,
    });
    assert(applied.report.status === "ready", "apply run should be ready");
    assert(applied.report.counts.applied === 1, "apply run should apply one duplicate merge");
    assert(applied.report.after_counts.open_promotion_items === 3, "merged members should leave three promotion items");
    assert(applied.report.after_counts.pending_merge_reviews === 1, "merged cluster should create one review unit");
    assert(typeof applied.report.transaction_id === "string", "migration transaction missing");
    assert(
      applied.report.last_applied_transaction_id === applied.report.transaction_id,
      "applied transaction was not retained as last successful apply",
    );
    const mergeRecords = readdirSync(path.join(dataRoot, REVIEW_WORKLIST_MERGE_QUEUE_DIR)).filter((file) => file.endsWith(".json"));
    assert(mergeRecords.length === 1, "merge review record missing");

    const heldCandidate = JSON.parse(readFileSync(path.join(dataRoot, "50_Instances", "candidates", "pref-a.json"), "utf8"));
    const heldReview = JSON.parse(readFileSync(path.join(dataRoot, "80_Review_Queue", "promotion", "pref-a.json"), "utf8"));
    assert(heldCandidate.status === "held" && heldCandidate.quarantine === true, "merged candidate was not cold-held");
    assert(heldReview.status === "merged" && heldReview.decision === "merge", "member review was not merged");
    const mergeRecord = JSON.parse(readFileSync(path.join(dataRoot, REVIEW_WORKLIST_MERGE_QUEUE_DIR, mergeRecords[0]), "utf8"));
    assert(mergeRecord.provenance_complete === true, "merge review provenance marker missing");
    assert(mergeRecord.members.length === 2, "merge review did not preserve every member");
    assert(mergeRecord.members.every((member) => /^[a-f0-9]{64}$/.test(member.candidate_sha256)), "candidate hashes missing");

    const postApplyDryRun = await buildReviewWorklistActions(dataRoot, {
      now: new Date("2026-07-07T00:00:30.000Z"),
      requireGitRecoveryRef: false,
    });
    assert(postApplyDryRun.report.transaction_id === null, "dry run should not claim a current transaction");
    assert(
      postApplyDryRun.report.last_applied_transaction_id === applied.report.transaction_id,
      "dry run erased the last successful apply transaction",
    );
    assert(
      postApplyDryRun.report.last_recovery_ref === applied.report.recovery_ref,
      "dry run erased the last successful recovery ref",
    );

    const rolledBack = await buildReviewWorklistActions(dataRoot, {
      now: new Date("2026-07-07T00:01:00.000Z"),
      rollbackTransactionId: applied.report.transaction_id,
      requireGitRecoveryRef: false,
    });
    assert(rolledBack.report.status === "rolled_back", "rollback status missing");
    assert(
      rolledBack.report.last_applied_transaction_id === applied.report.transaction_id,
      "rollback report erased historical apply evidence",
    );
    assert(
      rolledBack.report.last_rollback_transaction_id === applied.report.transaction_id,
      "rollback transaction evidence missing",
    );
    const restoredCandidate = JSON.parse(readFileSync(path.join(dataRoot, "50_Instances", "candidates", "pref-a.json"), "utf8"));
    assert(restoredCandidate.status === "pending_review", "rollback did not restore candidate");
    assert(!existsSync(path.join(dataRoot, REVIEW_WORKLIST_MERGE_QUEUE_DIR, mergeRecords[0])), "rollback did not remove merge review");

    console.log("review worklist actions verification ok");
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  console.error(`cwd=${root}`);
  process.exit(1);
});
