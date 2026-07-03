import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildAndWriteGraphHealth, buildGraphHealth } from "../dist/graph-health.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function json(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function markdown(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value, "utf8");
}

async function main() {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-graph-health-"));
  try {
    let health = await buildGraphHealth(dataRoot);
    assert(health.status === "degraded", `empty graph should be degraded, got ${health.status}`);
    assert(health.warnings.includes("wiki_index_empty"), "empty graph warning missing");

    const candidatePath = path.join(dataRoot, "50_Instances", "candidates", "candidate-good.json");
    const acceptedGoodPath = path.join(dataRoot, "50_Instances", "accepted", "candidate-good.json");
    const acceptedMissingSourcePath = path.join(dataRoot, "50_Instances", "accepted", "missing-source.json");
    const candidateOrphanPath = path.join(dataRoot, "50_Instances", "candidates", "candidate-orphan.json");
    json(candidatePath, {
      candidate_id: "candidate-good",
      claim: "Graph health should preserve source lineage.",
      status: "accepted",
      tags: ["graph-health"],
      evidence: { snippet: "Source lineage exists." },
      confidence: "high",
      last_verified: "2026-07-03",
    });
    json(acceptedGoodPath, {
      candidate_id: "candidate-good",
      claim: "Graph health should preserve source lineage.",
      status: "accepted",
      tags: ["graph-health"],
      source_candidate_path: "50_Instances/candidates/candidate-good.json",
      evidence: { snippet: "Accepted instance points back to its candidate." },
      confidence: "high",
      last_verified: "2026-07-03",
    });
    json(acceptedMissingSourcePath, {
      candidate_id: "missing-source",
      claim: "This accepted instance has no durable source mapping.",
      status: "accepted",
      tags: ["graph-health"],
      evidence: { snippet: "The health check should flag this." },
      confidence: "medium",
      last_verified: "2026-07-03",
    });
    json(candidateOrphanPath, {
      candidate_id: "candidate-orphan",
      claim: "This candidate has no promotion review.",
      status: "pending_review",
      tags: ["graph-health"],
      evidence: { snippet: "The health check should surface retry candidates." },
      confidence: "low",
      last_verified: "2026-07-03",
    });
    json(path.join(dataRoot, "80_Review_Queue", "promotion", "candidate-good.json"), {
      review_id: "candidate-good",
      candidate_path: "50_Instances/candidates/candidate-good.json",
      status: "approved",
    });
    markdown(
      path.join(dataRoot, "20_Wiki", "Graph Health.md"),
      `---
title: Graph Health
summary: The LLM Wiki graph should report unresolved links.
tags: [graph-health]
---

# Graph Health

This note links to [[Missing Health Node]].
`,
    );

    health = await buildGraphHealth(dataRoot, {
      referencedPaths: ["50_Instances/accepted/candidate-good.json", "20_Wiki/Missing-Referenced.md"],
    });
    assert(health.accepted_instance_count === 2, "accepted instance count mismatch");
    assert(health.accepted_without_source_count === 1, "accepted without source was not flagged");
    assert(health.candidate_without_review_count === 1, "candidate without review was not flagged");
    assert(health.referenced_paths_missing_on_disk.includes("20_Wiki/Missing-Referenced.md"), "missing referenced path not flagged");
    assert(health.score < 100, "health score did not decrease for graph issues");
    assert(health.warnings.includes("accepted_instance_source_mapping_missing"), "source mapping warning missing");

    const written = await buildAndWriteGraphHealth(dataRoot, {
      referencedPaths: ["50_Instances/accepted/candidate-good.json"],
    });
    const persisted = JSON.parse(readFileSync(written.path, "utf8"));
    assert(persisted.version === "graph_health_v1", "persisted graph health version mismatch");
    assert(persisted.accepted_instance_count === 2, "persisted graph health count mismatch");

    console.log("graph health verification ok");
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  console.error(`cwd=${root}`);
  process.exit(1);
});
