import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(root, "..", "dinobrain-data"));
const apply = process.argv.includes("--apply");

function toSlash(value) {
  return value.split(path.sep).join("/");
}

function dataPath(...parts) {
  return path.join(dataRoot, ...parts);
}

function rel(filePath) {
  return toSlash(path.relative(dataRoot, filePath));
}

function hasReviewLineage(record) {
  return Boolean(
      record.source_candidate_path ||
      record.reviewed_by ||
      record.reviewed_at ||
      String(record.review_status || "").toLowerCase().includes("accepted"),
  );
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function listAcceptedFiles() {
  const dir = dataPath("50_Instances", "accepted");
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(dir, entry.name));
}

async function removeIfExists(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

const now = new Date().toISOString();
const acceptedFiles = await listAcceptedFiles();
const migrated = [];
const skipped = [];

for (const acceptedPath of acceptedFiles) {
  let record;
  try {
    record = await readJson(acceptedPath);
  } catch (error) {
    skipped.push({ path: rel(acceptedPath), reason: `unreadable: ${error.message}` });
    continue;
  }
  if (record.auto_generated !== true || hasReviewLineage(record)) {
    skipped.push({ path: rel(acceptedPath), reason: "not legacy unreviewed auto-generated accepted memory" });
    continue;
  }

  const fileName = path.basename(acceptedPath);
  const candidatePath = dataPath("50_Instances", "candidates", fileName);
  const reviewPath = dataPath("80_Review_Queue", "promotion", fileName);
  const candidateId = String(record.candidate_id || record.behavior_rule_id || record.memory_id || path.basename(fileName, ".json"));
  const candidate = {
    ...record,
    candidate_id: candidateId,
    status: "pending_review",
    auto_promote: false,
    legacy_accepted_path: rel(acceptedPath),
    migration_reason: "legacy_auto_generated_accepted_without_review_lineage",
    promotion_blockers: Array.from(
      new Set([...(Array.isArray(record.promotion_blockers) ? record.promotion_blockers.map(String) : []), "manual_review_required", "legacy_unreviewed_accepted"]),
    ),
    updated_at: now,
  };
  const review = {
    review_id: candidateId,
    type: "promotion",
    status: "pending",
    candidate_path: rel(candidatePath),
    previous_accepted_path: rel(acceptedPath),
    accepted_path: null,
    required_checks: ["evidence_snippet", "confidence", "last_verified", "source_candidate_path_or_review_lineage"],
    promotion_blockers: ["manual_review_required", "legacy_unreviewed_accepted"],
    reviewer: "migration-unreviewed-auto-generated-accepted",
    created_at: now,
    updated_at: now,
  };

  migrated.push({
    accepted_path: rel(acceptedPath),
    candidate_path: rel(candidatePath),
    review_path: rel(reviewPath),
  });

  if (apply) {
    await writeJson(candidatePath, candidate);
    await writeJson(reviewPath, review);
    await fs.unlink(acceptedPath);
  }
}

if (apply && migrated.length > 0) {
  await removeIfExists(dataPath(".dino", "index", "wiki-index.json"));
  await removeIfExists(dataPath(".dino", "index", "sqlite", "wiki.sqlite"));
}

const report = {
  ok: true,
  applied: apply,
  data_root: dataRoot,
  migrated_count: migrated.length,
  skipped_count: skipped.length,
  migrated,
  skipped_examples: skipped.slice(0, 20),
};

console.log(JSON.stringify(report, null, 2));
