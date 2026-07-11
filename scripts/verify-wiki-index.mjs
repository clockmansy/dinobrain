import { existsSync, mkdtempSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-wiki-index-"));
const modulePath = pathToFileURL(path.join(root, "dist", "wiki-index.js")).href;

const {
  buildAndWriteWikiIndex,
  getIndexedPackItems,
  getWikiIndexPath,
  invalidateWikiIndex,
  queryIndexedWiki,
} = await import(modulePath);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function seedVault(fileCount) {
  for (const dir of [
    "20_Wiki",
    "30_Sources",
    "40_Projects",
    "50_Instances/accepted",
    "60_Operations",
    "70_Error_Book",
    ".dino/tasks",
  ]) {
    mkdirSync(path.join(dataRoot, dir), { recursive: true });
  }

  writeFileSync(
    path.join(dataRoot, "20_Wiki", "Graph-Speed-Target.md"),
    `---
title: Obsidian Graph Speed Target
summary: DinoBrain should use a persistent graph index to avoid full vault scans as session-derived knowledge grows.
tags: [obsidian, graph-index, llm-wiki, retrieval]
---

# Obsidian Graph Speed Target

The narrow phrase durable-index-target proves indexed retrieval can find a specific Wiki record without scanning every source file on each query.

Related: [[Cold Archive Policy]]
`,
    "utf8",
  );

  writeFileSync(
    path.join(dataRoot, "20_Wiki", "Cold-Archive-Policy.md"),
    `---
title: Cold Archive Policy
summary: Rarely used session details should move into cold storage and stay out of the hot context path.
tags: [cold-storage, llm-wiki]
---

# Cold Archive Policy
`,
    "utf8",
  );

  for (let index = 0; index < fileCount; index += 1) {
    const bucket = index % 2 === 0 ? "30_Sources" : "40_Projects";
    writeFileSync(
      path.join(dataRoot, bucket, `Synthetic-${String(index).padStart(5, "0")}.md`),
      `---
title: Synthetic Record ${index}
summary: Synthetic filler record ${index} for index scale verification.
tags: [synthetic, scale]
---

# Synthetic Record ${index}

This file exists so the verifier can prove queries are narrowed through the persistent Wiki index.
`,
      "utf8",
    );
  }
}

seedVault(1500);

const buildStarted = Date.now();
const index = await buildAndWriteWikiIndex(dataRoot);
const buildElapsedMs = Date.now() - buildStarted;
const indexPath = getWikiIndexPath(dataRoot);
const indexSizeBytes = statSync(indexPath).size;
assert(existsSync(indexPath), "wiki index file was not written");
assert(index.record_count === 1502, `unexpected index record count: ${index.record_count}`);
assert(index.stats.node_count > index.record_count, "graph nodes were not built");
assert(index.stats.edge_count > index.record_count, "graph edges were not built");
assert(index.inverted_index["durable-index-target"]?.includes("20_Wiki/Graph-Speed-Target.md"), "target term missing from inverted index");
const targetRow = index.records.find((record) => record.path === "20_Wiki/Graph-Speed-Target.md");
assert(targetRow?.contextual_chunk?.length > 0, "wiki row contextual chunk missing");
assert(/^[a-f0-9]{64}$/.test(targetRow?.source_sha256 ?? ""), "wiki row source hash missing");
assert(targetRow?.knowledge_role === "internal_memory", "wiki row knowledge role missing");
assert(targetRow?.retrieval_lane === "wiki", "wiki row retrieval lane missing");

const searchStarted = Date.now();
const search = await queryIndexedWiki(dataRoot, "durable-index-target graph speed", 5);
const searchElapsedMs = Date.now() - searchStarted;
assert(search.ranked.some((record) => record.path === "20_Wiki/Graph-Speed-Target.md"), "indexed wiki_search missed target record");
assert(search.ranked.every((record) => record.score_breakdown), "indexed search score contribution breakdown missing");
assert(
  search.stats.candidate_record_count < index.record_count,
  `indexed search did not narrow candidates: ${search.stats.candidate_record_count}/${index.record_count}`,
);

const pack = await getIndexedPackItems(dataRoot, "Why should DinoBrain use an Obsidian graph index for LLM Wiki speed?", 5);
assert(pack.ranked.some((record) => record.path === "20_Wiki/Graph-Speed-Target.md"), "indexed Context Pack missed target record");
assert(pack.stats.retrieval_mode === "lexical_fallback_v2", "Context Pack did not report lexical fallback mode without dense vectors");
assert(pack.stats.candidate_source === "wiki_index_v2", "Context Pack did not report wiki index candidate source");

const invalidated = await invalidateWikiIndex(dataRoot);
assert(invalidated === true, "wiki index was not invalidated");
assert(!existsSync(indexPath), "wiki index file still exists after invalidation");

console.log(
  JSON.stringify(
    {
      ok: true,
      data_root: dataRoot,
      index_path: indexPath,
      record_count: index.record_count,
      term_count: index.stats.term_count,
      node_count: index.stats.node_count,
      edge_count: index.stats.edge_count,
      index_size_bytes: indexSizeBytes,
      build_elapsed_ms: buildElapsedMs,
      search_elapsed_ms: searchElapsedMs,
      search_candidate_records: search.stats.candidate_record_count,
      search_total_candidates: search.stats.total_candidate_count,
      pack_candidate_records: pack.stats.candidate_record_count,
      matched_path: "20_Wiki/Graph-Speed-Target.md",
    },
    null,
    2,
  ),
);
