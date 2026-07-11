import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modulePath = pathToFileURL(path.join(root, "dist", "full-memory-audit.js")).href;
const {
  buildAndWriteFullMemoryAudit,
  FULL_MEMORY_AUDIT_STATUS_RELATIVE_PATH,
  FULL_MEMORY_MANIFEST_RELATIVE_PATH,
} = await import(modulePath);

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

async function main() {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-full-memory-audit-"));
  try {
    text(
      path.join(dataRoot, "20_Wiki", "Stable.md"),
      `---
title: Stable
summary: Stable memory record
---

# Stable
`,
    );
    json(path.join(dataRoot, "50_Instances", "accepted", "stable.json"), {
      candidate_id: "stable",
      claim: "Full-memory audit should hash accepted memory.",
      source_paths: ["20_Wiki/Stable.md"],
      evidence: { snippet: "Stable source exists." },
      confidence: "high",
      last_verified: "2026-07-07",
    });

    let result = await buildAndWriteFullMemoryAudit(dataRoot);
    assert(result.report.status === "baseline_created", `expected baseline_created, got ${result.report.status}`);
    assert(existsSync(path.join(dataRoot, FULL_MEMORY_MANIFEST_RELATIVE_PATH)), "manifest missing");
    assert(existsSync(path.join(dataRoot, FULL_MEMORY_AUDIT_STATUS_RELATIVE_PATH)), "status missing");
    const stableEntry = result.manifest.entries.find((entry) => entry.path === "20_Wiki/Stable.md");
    assert(stableEntry, "stable wiki path not audited");
    assert(stableEntry.encoding_class === "utf8", "stable wiki encoding class missing");
    assert(Number.isInteger(stableEntry.text_char_count) && stableEntry.text_char_count > 0, "stable wiki char count missing");
    assert(Number.isInteger(stableEntry.text_line_count) && stableEntry.text_line_count > 0, "stable wiki line count missing");
    assert(result.report.counts.text_files > 0, "text file count missing");
    assert(result.report.counts.text_chars > 0, "text char total missing");
    assert(result.report.counts.text_lines > 0, "text line total missing");

    text(path.join(dataRoot, ".dino", "events", "2026-07-07.jsonl"), `${JSON.stringify({ event: "task_started" })}\n`);
    result = await buildAndWriteFullMemoryAudit(dataRoot);
    assert(result.report.status === "drift_classified", `expected classified drift, got ${result.report.status}`);
    assert(result.report.counts.unclassified_drift === 0, "live OS write was treated as unclassified");
    assert(result.report.drift.by_class.live_os_write > 0, "live OS drift class missing");
    assert(result.report.drift.by_class.audit_artifact > 0, "audit artifact drift class missing");

    json(path.join(dataRoot, ".dino", "evaluations", "rag-golden.json"), {
      version: 1,
      cases: [],
    });
    result = await buildAndWriteFullMemoryAudit(dataRoot);
    assert(result.report.status === "drift_classified", `expected generated evaluation drift, got ${result.report.status}`);
    assert(
      result.report.drift.added.some(
        (entry) => entry.path === ".dino/evaluations/rag-golden.json" && entry.drift_class === "live_os_write",
      ),
      "generated evaluation artifact was not classified as live OS drift",
    );

    json(path.join(dataRoot, ".dino", "tmp", "hook-receipts", "receipt.json"), {
      version: "hook_receipt_v1",
      status: "completed",
    });
    result = await buildAndWriteFullMemoryAudit(dataRoot);
    assert(
      !result.manifest.entries.some((entry) => entry.path.startsWith(".dino/tmp/")),
      "ephemeral hook receipt was included in the full-memory manifest",
    );
    assert(result.report.counts.unclassified_drift === 0, "ephemeral hook receipt created content drift");

    text(path.join(dataRoot, ".dino", "local-backups", "node-lifecycle", "tx", "before.bin"), "private exact bytes");
    result = await buildAndWriteFullMemoryAudit(dataRoot);
    assert(
      !result.manifest.entries.some((entry) => entry.path.startsWith(".dino/local-backups/")),
      "local lifecycle backup was included in the full-memory manifest",
    );
    assert(result.report.counts.unclassified_drift === 0, "local lifecycle backup created content drift");

    json(path.join(dataRoot, "60_Operations", "public-data-safety", "public-data-safety-report.json"), {
      report_type: "dinobrain_public_data_safety",
      status: "fail",
      result: { blocker_count: 1 },
    });
    text(
      path.join(dataRoot, "60_Operations", "public-data-safety", "public-data-safety-report.md"),
      "# Public Data Safety\n\nStatus: fail\n",
    );
    result = await buildAndWriteFullMemoryAudit(dataRoot);
    const publicSafetyDrift = result.report.drift.added.filter((entry) =>
      entry.path.startsWith("60_Operations/public-data-safety/"),
    );
    assert(publicSafetyDrift.length === 2, "public-data safety audit artifacts were not observed");
    assert(
      publicSafetyDrift.every((entry) => entry.drift_class === "audit_artifact"),
      "public-data safety reports were treated as unclassified content drift",
    );
    assert(result.report.counts.unclassified_drift === 0, "public-data safety reports created content drift");

    json(path.join(dataRoot, "60_Operations", "rag-evaluation", "answer-quality-independent-review.json"), {
      version: "answer_quality_independent_review_v2",
      status: "accepted",
      judge_ids: ["judge-a", "judge-b", "judge-c"],
    });
    result = await buildAndWriteFullMemoryAudit(dataRoot);
    assert(
      result.report.drift.added.some(
        (entry) =>
          entry.path === "60_Operations/rag-evaluation/answer-quality-independent-review.json" &&
          entry.drift_class === "audit_artifact",
      ),
      "RAG evaluation review was not classified as an audit artifact",
    );
    assert(result.report.counts.unclassified_drift === 0, "RAG evaluation review created content drift");

    text(path.join(dataRoot, "20_Wiki", "New-Decision.md"), "# New Decision\n\nThis is unclassified content drift.\n");
    result = await buildAndWriteFullMemoryAudit(dataRoot);
    assert(result.report.status === "drift_unclassified", `expected unclassified drift, got ${result.report.status}`);
    assert(result.report.counts.unclassified_drift > 0, "content drift was not counted as unclassified");
    assert(
      result.report.drift.added.concat(result.report.drift.changed).some((entry) => entry.current_parse_status),
      "drift entries did not include current parse status",
    );

    text(path.join(dataRoot, ".dino", "events", "bad.jsonl"), "{bad json}\n");
    result = await buildAndWriteFullMemoryAudit(dataRoot);
    assert(result.report.status === "parse_error", `expected parse_error, got ${result.report.status}`);
    assert(result.report.parse_errors.some((entry) => entry.path === ".dino/events/bad.jsonl"), "parse error path missing");

    const persisted = JSON.parse(readFileSync(path.join(dataRoot, FULL_MEMORY_AUDIT_STATUS_RELATIVE_PATH), "utf8"));
    assert(persisted.manifest_sha256 && persisted.manifest_sha256.length === 64, "manifest sha missing");

    console.log("full memory audit verification ok");
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  console.error(`cwd=${root}`);
  process.exit(1);
});
