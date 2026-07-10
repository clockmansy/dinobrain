import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modulePath = pathToFileURL(path.join(root, "dist", "review-worklist.js")).href;
const { buildReviewWorklist, REVIEW_WORKLIST_STATE_RELATIVE_PATH, REVIEW_WORKLIST_OPERATIONS_DIR } = await import(modulePath);

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
  const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-review-worklist-"));
  try {
    candidate(dataRoot, "pref-a", "User preference: Prefer concise Korean progress updates.");
    candidate(dataRoot, "pref-b", "User preference: Prefer concise Korean progress updates.");
    candidate(dataRoot, "state-a", "Project state: Folder under C:\\Users\\alice\\.codex\\memories should stay local.");
    candidate(dataRoot, "idea-a", "Idea: Maybe add another dashboard later.");

    const result = await buildReviewWorklist(dataRoot, { now: new Date("2026-07-07T00:00:00.000Z") });
    assert(result.report.status === "needs_review", "worklist should require review");
    assert(result.report.counts.open_items === 4, "open item count mismatch");
    assert(result.report.counts.clusters === 3, "duplicate candidates were not clustered");
    assert(result.report.counts.duplicate_clusters === 1, "duplicate cluster count mismatch");
    assert(result.report.counts.high_priority_clusters === 1, "high priority user preference cluster missing");
    assert(result.report.by_kind.user_preference === 1, "user preference kind missing");
    assert(result.report.by_kind.project_state === 1, "project state kind missing");
    assert(result.report.clusters[0].recommended_action === "merge_review_for_possible_feedback_memory", "wrong top recommendation");
    assert(existsSync(path.join(dataRoot, REVIEW_WORKLIST_STATE_RELATIVE_PATH)), "state worklist missing");
    assert(existsSync(path.join(dataRoot, REVIEW_WORKLIST_OPERATIONS_DIR, "review-worklist-20260707-4.json")), "operations worklist missing");
    const operations = JSON.parse(readFileSync(path.join(dataRoot, REVIEW_WORKLIST_OPERATIONS_DIR, "review-worklist-20260707-4.json"), "utf8"));
    assert(operations.note.includes("aggregate counts and hashes only"), "public summary safety note missing");
    assert(operations.source_review_status_path === ".dino/state/wiki-review-queue.json", "public source review path should be relative");
    assert(operations.source_semantic_jobs_path === ".dino/state/semantic_jobs.json", "public semantic job path should be relative");
    assert(!JSON.stringify(operations).includes("C:\\Users\\alice"), "public summary should scrub local home paths");
    assert(!JSON.stringify(operations).includes("Prefer concise Korean"), "public summary leaked a candidate claim");
    assert(!JSON.stringify(operations).includes("50_Instances/candidates"), "public summary leaked candidate paths");
    assert(!JSON.stringify(operations).includes("10_Conversations/raw"), "public summary leaked source session paths");
    assert(
      operations.clusters.every((cluster) => /^[a-f0-9]{64}$/.test(cluster.representative_claim_hash)),
      "public summary claim hashes missing",
    );
    assert(
      operations.clusters.every((cluster) => /^[a-f0-9]{64}$/.test(cluster.member_provenance_hash)),
      "public summary provenance hashes missing",
    );

    console.log("review worklist verification ok");
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  console.error(`cwd=${root}`);
  process.exit(1);
});
