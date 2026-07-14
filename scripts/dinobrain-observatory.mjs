import http from "node:http";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DINOBRAIN_VERSION } from "./lib/version-manifest.mjs";
import {
  loadCurrentStatusGeneration,
  resolveStatusGenerationArtifactPath,
  STATUS_GENERATION_ARTIFACT_PATHS,
  STATUS_GENERATION_POINTER_RELATIVE_PATH,
} from "../dist/status-generation.js";
import { buildReadiness as buildCanonicalReadiness } from "../dist/readiness.js";
import {
  EVIDENCE_GRAPH_SQLITE_RELATIVE_PATH,
  readEvidenceGraphWindow,
} from "../dist/evidence-graph.js";
import { localOnlyStatus } from "../dist/local-only.js";
import {
  readObservatorySyncState,
  setSyncSchedulerAutomaticEnabled,
} from "../dist/observatory-sync-state.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(root, "..", "dinobrain-data"));
const host = process.env.DINOBRAIN_OBSERVATORY_HOST ?? "127.0.0.1";
const port = Number(process.env.DINOBRAIN_OBSERVATORY_PORT ?? process.argv.find((arg) => arg.startsWith("--port="))?.split("=")[1] ?? 3847);
const observatoryVersion = "2026-07-14-local-only-v1";
const execFileAsync = promisify(execFile);
const configuredCacheTtlMs = Number(process.env.DINOBRAIN_OBSERVATORY_CACHE_TTL_MS ?? 5000);
const cacheTtlMs = Number.isFinite(configuredCacheTtlMs) ? Math.max(100, configuredCacheTtlMs) : 5000;
const configuredGenerationVerifyTtlMs = Number(process.env.DINOBRAIN_OBSERVATORY_GENERATION_VERIFY_TTL_MS ?? 30_000);
const generationVerifyTtlMs = Number.isFinite(configuredGenerationVerifyTtlMs)
  ? Math.max(1_000, configuredGenerationVerifyTtlMs)
  : 30_000;
const configuredSourceStatTtlMs = Number(process.env.DINOBRAIN_OBSERVATORY_SOURCE_STAT_TTL_MS ?? 1000);
const sourceStatTtlMs = Number.isFinite(configuredSourceStatTtlMs) ? Math.max(100, configuredSourceStatTtlMs) : 1000;
const statePayloadBudgetBytes = 256 * 1024;
const statePayloadTargetBytes = 240 * 1024;
const stateLimits = Object.freeze({ events: 40, tasks: 20, context_packs: 10, traces: 10, memory_audits: 8 });
const graphWindowLimits = Object.freeze({ wiki_nodes: 300, total_nodes: 340, total_edges: 400 });
const graphNodeTypeLimits = Object.freeze({ root: 32, folder: 80, kind: 16, tag: 60, wikilink: 12, record: 221 });
const statusGenerationArtifacts = new Set(STATUS_GENERATION_ARTIFACT_PATHS);
let statusGenerationCache = { loaded_at: 0, source_checked_at: 0, pointer_signature: null, value: null, in_flight: null };
let syncStateCache = { loaded_at: 0, value: null, in_flight: null };
let syncRunInFlight = null;
let automaticSyncNextProbeAt = 0;
const resourceCounters = {
  http_requests: 0,
  http_active: 0,
  http_peak_active: 0,
  directory_scans: 0,
  directory_entries_seen: 0,
  directory_files_selected: 0,
  json_files_read: 0,
  json_bytes_read: 0,
  jsonl_files_read: 0,
  jsonl_bytes_read: 0,
  sqlite_opens: 0,
  status_generation_verifications: 0,
  status_generation_stat_checks: 0,
};
const resourceCaches = new Map(
  ["state", "graph", "readiness", "snapshot"].map((name) => [name, {
    name,
    has_value: false,
    value: null,
    key: null,
    expires_at: 0,
    in_flight: null,
    hits: 0,
    misses: 0,
    coalesced: 0,
    loads: 0,
    errors: 0,
    last_load_ms: 0,
    last_loaded_at: null,
    payload_bytes: 0,
  }]),
);

function serializedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value, null, 2), "utf8");
}

async function cachedResource(name, key, loader) {
  const cache = resourceCaches.get(name);
  if (!cache) throw new Error(`Unknown Observatory resource cache: ${name}`);
  const now = Date.now();
  if (cache.has_value && cache.key === key && now < cache.expires_at) {
    cache.hits += 1;
    return cache.value;
  }
  if (cache.in_flight) {
    cache.coalesced += 1;
    await cache.in_flight;
    return cachedResource(name, key, loader);
  }

  cache.misses += 1;
  cache.loads += 1;
  const startedAt = Date.now();
  cache.in_flight = Promise.resolve()
    .then(loader)
    .then((value) => {
      cache.has_value = true;
      cache.value = value;
      cache.key = key;
      cache.expires_at = Date.now() + cacheTtlMs;
      cache.last_load_ms = Date.now() - startedAt;
      cache.last_loaded_at = new Date().toISOString();
      cache.payload_bytes = serializedBytes(value);
      return value;
    })
    .catch((error) => {
      cache.errors += 1;
      throw error;
    })
    .finally(() => {
      cache.in_flight = null;
    });
  return cache.in_flight;
}

function cacheHealth() {
  const now = Date.now();
  const resources = Object.fromEntries([...resourceCaches].map(([name, cache]) => [name, {
    hits: cache.hits,
    misses: cache.misses,
    coalesced: cache.coalesced,
    loads: cache.loads,
    errors: cache.errors,
    in_flight: Boolean(cache.in_flight),
    cached: cache.has_value,
    age_ms: cache.last_loaded_at ? Math.max(0, now - Date.parse(cache.last_loaded_at)) : null,
    expires_in_ms: cache.has_value ? Math.max(0, cache.expires_at - now) : 0,
    last_load_ms: cache.last_load_ms,
    last_loaded_at: cache.last_loaded_at,
    payload_bytes: cache.payload_bytes,
  }]));
  const totals = Object.values(resources).reduce((result, resource) => ({
    hits: result.hits + resource.hits,
    misses: result.misses + resource.misses,
    coalesced: result.coalesced + resource.coalesced,
    loads: result.loads + resource.loads,
    errors: result.errors + resource.errors,
    payload_bytes: result.payload_bytes + resource.payload_bytes,
  }), { hits: 0, misses: 0, coalesced: 0, loads: 0, errors: 0, payload_bytes: 0 });
  return { ttl_ms: cacheTtlMs, ...totals, resources };
}

function invalidateObservatoryStateCaches() {
  for (const name of ["state", "snapshot", "readiness"]) {
    const cache = resourceCaches.get(name);
    if (cache) cache.expires_at = 0;
  }
  syncStateCache.loaded_at = 0;
  syncStateCache.value = null;
}

async function readBoundedSyncState({ force = false } = {}) {
  const ttlMs = 15_000;
  if (!force && syncStateCache.value && Date.now() - syncStateCache.loaded_at < ttlMs) return syncStateCache.value;
  if (syncStateCache.in_flight) return syncStateCache.in_flight;
  syncStateCache.in_flight = readObservatorySyncState({ dataRoot })
    .then((value) => {
      syncStateCache.value = value;
      syncStateCache.loaded_at = Date.now();
      return value;
    })
    .finally(() => {
      syncStateCache.in_flight = null;
    });
  return syncStateCache.in_flight;
}

async function runSyncScheduler(command) {
  if (syncRunInFlight) return syncRunInFlight;
  const scriptPath = path.join(root, "scripts", "run-sync-scheduler.mjs");
  syncRunInFlight = execFileAsync(process.execPath, [scriptPath, command], {
    cwd: root,
    env: {
      ...process.env,
      DINOBRAIN_DATA_DIR: dataRoot,
      DINOBRAIN_SYNC_RUN_TIMEOUT_MS: "75000",
    },
    windowsHide: true,
    timeout: 90_000,
    maxBuffer: 2 * 1024 * 1024,
  })
    .then(({ stdout }) => JSON.parse(stdout))
    .finally(() => {
      syncRunInFlight = null;
      invalidateObservatoryStateCaches();
    });
  return syncRunInFlight;
}

async function maybeRunAutomaticSync() {
  if (Date.now() < automaticSyncNextProbeAt || syncRunInFlight) return;
  try {
    const state = await readBoundedSyncState();
    const queued = Number(state.queued_safe_file_count ?? 0) + Number(state.queued_conditional_count ?? 0);
    if (!state.automatic?.enabled || queued === 0) {
      automaticSyncNextProbeAt = Date.now() + 5 * 60_000;
      return;
    }
    const projected = Date.parse(state.next_eligible_automatic_sync ?? "");
    if (Number.isFinite(projected) && projected > Date.now()) {
      automaticSyncNextProbeAt = projected;
      return;
    }
    const result = await runSyncScheduler("automatic");
    const next = Date.parse(result.next_eligible_at ?? "");
    automaticSyncNextProbeAt = Number.isFinite(next) && next > Date.now() ? next : Date.now() + 60_000;
  } catch {
    automaticSyncNextProbeAt = Date.now() + 15 * 60_000;
  }
}

function rel(filePath) {
  return path.relative(dataRoot, filePath).split(path.sep).join("/");
}

async function currentStatusGeneration() {
  const pointerPath = path.join(dataRoot, STATUS_GENERATION_POINTER_RELATIVE_PATH.replaceAll("/", path.sep));
  let pointerSignature = "missing";
  try {
    const pointerStat = await fs.stat(pointerPath);
    pointerSignature = `${pointerStat.size}:${pointerStat.mtimeMs}:${pointerStat.ctimeMs}`;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const cacheFresh =
    statusGenerationCache.value &&
    statusGenerationCache.pointer_signature === pointerSignature &&
    Date.now() - statusGenerationCache.loaded_at < generationVerifyTtlMs;
  if (cacheFresh) {
    if (Date.now() - statusGenerationCache.source_checked_at < sourceStatTtlMs) return statusGenerationCache.value;
    const manifestEntries = Array.isArray(statusGenerationCache.value?.manifest?.entries)
      ? statusGenerationCache.value.manifest.entries
      : [];
    let sourcesUnchanged = manifestEntries.length > 0;
    for (const entry of manifestEntries) {
      resourceCounters.status_generation_stat_checks += 1;
      try {
        const sourcePath = path.join(dataRoot, ...String(entry.source_path ?? "").split("/"));
        const sourceStat = await fs.stat(sourcePath);
        if (sourceStat.size !== entry.size_bytes || sourceStat.mtime.toISOString() !== entry.source_mtime) {
          sourcesUnchanged = false;
          break;
        }
      } catch {
        sourcesUnchanged = false;
        break;
      }
    }
    if (sourcesUnchanged) {
      statusGenerationCache.source_checked_at = Date.now();
      return statusGenerationCache.value;
    }
  }
  if (statusGenerationCache.in_flight) return statusGenerationCache.in_flight;
  resourceCounters.status_generation_verifications += 1;
  statusGenerationCache.in_flight = loadCurrentStatusGeneration(dataRoot, {
    verifyEntries: true,
    verifySourceCoherence: true,
  }).then((value) => {
    statusGenerationCache.value = value;
    statusGenerationCache.loaded_at = Date.now();
    statusGenerationCache.source_checked_at = Date.now();
    statusGenerationCache.pointer_signature = pointerSignature;
    return value;
  }).finally(() => {
    statusGenerationCache.in_flight = null;
  });
  return statusGenerationCache.in_flight;
}

async function resolveObservablePath(filePath) {
  const relativePath = rel(filePath);
  if (!statusGenerationArtifacts.has(relativePath)) return { filePath, generation: null, managed: false };
  const generation = await currentStatusGeneration();
  const snapshotPath = resolveStatusGenerationArtifactPath(generation, relativePath);
  return { filePath: snapshotPath, generation, managed: true };
}

async function readJson(filePath) {
  const resolved = await resolveObservablePath(filePath);
  if (resolved.managed && !resolved.filePath) return null;
  try {
    const text = await fs.readFile(resolved.filePath, "utf8");
    resourceCounters.json_files_read += 1;
    resourceCounters.json_bytes_read += Buffer.byteLength(text, "utf8");
    return JSON.parse(text);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return null;
  }
}

async function readStatusArtifact(relativePath) {
  const canonicalPath = path.join(dataRoot, relativePath.replace(/\//g, path.sep));
  const resolved = await resolveObservablePath(canonicalPath);
  if (resolved.managed && !resolved.filePath) {
    return {
      ok: false,
      artifact_parse_status: "generation_invalid",
      artifact_path: relativePath,
      value: null,
      error: resolved.generation?.reason ?? "status_generation_unavailable",
    };
  }
  try {
    const text = await fs.readFile(resolved.filePath, "utf8");
    resourceCounters.json_files_read += 1;
    resourceCounters.json_bytes_read += Buffer.byteLength(text, "utf8");
    try {
      return {
        ok: true,
        artifact_parse_status: "ok",
        artifact_path: relativePath,
        value: JSON.parse(text),
      };
    } catch (error) {
      return {
        ok: false,
        artifact_parse_status: "invalid_json",
        artifact_path: relativePath,
        value: null,
        error: String(error?.message ?? error),
      };
    }
  } catch (error) {
    return {
      ok: false,
      artifact_parse_status: error?.code === "ENOENT" ? "missing" : "unreadable",
      artifact_path: relativePath,
      value: null,
      error: error?.code === "ENOENT" ? null : String(error?.message ?? error),
    };
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readDirFiles(dir, extension, { newestFirst = false, limit = Number.POSITIVE_INFINITY } = {}) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    resourceCounters.directory_scans += 1;
    resourceCounters.directory_entries_seen += entries.length;
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
      .map((entry) => path.join(dir, entry.name))
      .sort();
    if (newestFirst) files.reverse();
    const selected = Number.isFinite(limit) ? files.slice(0, Math.max(0, limit)) : files;
    resourceCounters.directory_files_selected += selected.length;
    return selected;
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function countDirFiles(relativeDir, extension = ".json") {
  const dir = path.join(dataRoot, relativeDir);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    resourceCounters.directory_scans += 1;
    resourceCounters.directory_entries_seen += entries.length;
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(extension)).length;
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

async function readOperationIndex() {
  const indexPath = path.join(dataRoot, ".dino", "index", "operations-index.json");
  const index = await readJson(indexPath);
  if (!index || index.version !== 1) return null;
  return index;
}

async function readSqliteOperations() {
  const canonicalPath = path.join(dataRoot, ".dino", "index", "sqlite", "operations.sqlite");
  const resolved = await resolveObservablePath(canonicalPath);
  if (resolved.managed && !resolved.filePath) return null;
  const shardPath = resolved.filePath;
  try {
    await fs.access(shardPath);
  } catch {
    return null;
  }

  resourceCounters.sqlite_opens += 1;
  const db = new DatabaseSync(shardPath, { readOnly: true });
  try {
    const counts = {
      tasks: db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count,
      active_tasks: db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status = 'started'").get().count,
      traces: db.prepare("SELECT COUNT(*) AS count FROM traces").get().count,
      context_packs: db.prepare("SELECT COUNT(*) AS count FROM context_packs").get().count,
      events: db.prepare("SELECT COUNT(*) AS count FROM events").get().count,
    };
    const activeTasks = db
      .prepare(`SELECT * FROM tasks WHERE status = 'started' ORDER BY updated_at DESC, path ASC LIMIT ${stateLimits.tasks}`)
      .all();
    const recentTasks = db
      .prepare(`SELECT * FROM tasks ORDER BY updated_at DESC, path ASC LIMIT ${stateLimits.tasks}`)
      .all();
    const tasks = mergeTasksByPath(activeTasks, recentTasks, stateLimits.tasks);
    const traces = db
      .prepare(`SELECT * FROM traces ORDER BY finished_at DESC, path ASC LIMIT ${stateLimits.traces}`)
      .all()
      .map(withTraceDisplay);
    const packs = db
      .prepare(`SELECT * FROM context_packs ORDER BY created_at DESC, path ASC LIMIT ${stateLimits.context_packs}`)
      .all()
      .map((pack) => ({
        ...withDisplayPath(pack),
        items: db
          .prepare("SELECT path, kind, title, summary, score FROM context_pack_items WHERE pack_path = ? ORDER BY ordinal ASC LIMIT 8")
          .all(pack.path),
      }));
    const events = db
      .prepare(`SELECT payload_json FROM events ORDER BY at DESC, event_key ASC LIMIT ${stateLimits.events}`)
      .all()
      .map((row) => JSON.parse(row.payload_json));
    return {
      generated_at: new Date().toISOString(),
      index_mode: "sqlite_shards_v3",
      counts,
      events,
      tasks,
      traces,
      context_packs: packs,
    };
  } finally {
    db.close();
  }
}

function graphColor(node) {
  const colors = {
    root: "#f0a83a",
    folder: "#4fb6a4",
    tag: "#7cc66a",
    kind: "#d7a84f",
    record: "#e6dcc2",
    wikilink: "#8f9488",
    activity_root: "#f0a83a",
    active_task: "#ffcc66",
    task: "#d99a3d",
    context_pack: "#8ac7ff",
    event: "#b99a69",
    trace: "#c7d2fe",
    memory_ref: "#f3e7c7",
    lane: "#d9b44a",
    source_snapshot: "#68b7a7",
    external_source: "#68b7a7",
    source_chunk: "#7fd1bd",
    claim: "#f0c36a",
    candidate: "#d6a15e",
    correction: "#f0a83a",
    review: "#d99a6c",
    memory: "#efe0b8",
    behavior_rule: "#ffe3a1",
    memory_audit: "#c7d2fe",
    audit: "#b7c2e2",
    gate: "#df8a7d",
    sync: "#65c6a7",
    commit: "#8bd8be",
    status: "#aab6a2",
    provenance: "#9bc3c8",
    lineage_generation: "#8fc7cf",
    wiki_record: "#e6dcc2",
    project_record: "#8ac7ff",
    operations_record: "#d99a3d",
    error_record: "#df8a7d",
  };
  return colors[node.type] ?? "#cfc4a6";
}

function normalizeGraphNode(node) {
  return {
    ...node,
    id: String(node.id ?? ""),
    type: String(node.type ?? "node"),
    label: String(node.label ?? node.id ?? ""),
    path: node.path ? String(node.path) : null,
    record_id: node.record_id ? String(node.record_id) : null,
    count: Number(node.count ?? 1),
    color: graphColor(node),
  };
}

function normalizeGraphEdge(edge) {
  return {
    ...edge,
    source: String(edge.from ?? edge.from_id ?? edge.source ?? ""),
    target: String(edge.to ?? edge.to_id ?? edge.target ?? ""),
    type: String(edge.type ?? edge.label ?? "edge"),
  };
}

function selectGraphWindow(nodes, edges, limit = graphWindowLimits.wiki_nodes) {
  const priority = new Map([
    ["root", 0],
    ["folder", 1],
    ["kind", 2],
    ["tag", 3],
    ["record", 4],
    ["wikilink", 5],
  ]);
  const orderedNodes = [...nodes].sort((a, b) => {
    const typeDelta = (priority.get(a.type) ?? 9) - (priority.get(b.type) ?? 9);
    if (typeDelta !== 0) return typeDelta;
    const countDelta = (b.count ?? 0) - (a.count ?? 0);
    if (countDelta !== 0) return countDelta;
    return a.id.localeCompare(b.id);
  });
  const selectedNodes = [];
  const selectedNodeIds = new Set();
  for (const [type, typeLimit] of Object.entries(graphNodeTypeLimits)) {
    for (const node of orderedNodes.filter((entry) => entry.type === type).slice(0, typeLimit)) {
      if (selectedNodes.length >= limit || selectedNodeIds.has(node.id)) break;
      selectedNodes.push(node);
      selectedNodeIds.add(node.id);
    }
  }
  for (const node of orderedNodes) {
    if (selectedNodes.length >= limit) break;
    if (selectedNodeIds.has(node.id)) continue;
    selectedNodes.push(node);
    selectedNodeIds.add(node.id);
  }
  const selectedIds = new Set(selectedNodes.map((node) => node.id));
  const selectedEdges = edges
    .filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target))
    .slice(0, graphWindowLimits.total_edges);
  return {
    nodes: selectedNodes,
    edges: selectedEdges,
    shown_node_count: selectedNodes.length,
    shown_edge_count: selectedEdges.length,
    truncated: nodes.length > selectedNodes.length || edges.length > selectedEdges.length,
  };
}

async function readWikiGraph() {
  const canonicalPath = path.join(dataRoot, ".dino", "index", "sqlite", "wiki.sqlite");
  const resolved = await resolveObservablePath(canonicalPath);
  if (resolved.managed && !resolved.filePath) {
    return {
      ok: false,
      index_mode: "status_generation_invalid",
      generated_at: null,
      data_root: dataRoot,
      stats: { records: 0, nodes: 0, edges: 0, shown_nodes: 0, shown_edges: 0, truncated: false },
      nodes: [],
      edges: [],
    };
  }
  const shardPath = resolved.filePath;
  try {
    await fs.access(shardPath);
    resourceCounters.sqlite_opens += 1;
    const db = new DatabaseSync(shardPath, { readOnly: true });
    try {
      const metadata = Object.fromEntries(
        db.prepare("SELECT key, value FROM metadata")
          .all()
          .map((row) => [String(row.key), String(row.value)]),
      );
      const metadataCount = (key, table) => {
        const declared = Number(metadata[key] ?? Number.NaN);
        return Number.isFinite(declared)
          ? declared
          : Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count ?? 0);
      };
      const nodeCount = metadataCount("node_count", "nodes");
      const edgeCount = metadataCount("edge_count", "edges");
      const nodes = Object.entries(graphNodeTypeLimits).flatMap(([type, typeLimit]) => db
        .prepare(`
          SELECT id, type, label, path, record_id, count
          FROM nodes
          WHERE type = ?
          ORDER BY count DESC, id ASC
          LIMIT ?
        `)
        .all(type, typeLimit)
        .map(normalizeGraphNode))
        .slice(0, graphWindowLimits.wiki_nodes);
      const nodeIds = nodes.map((node) => node.id);
      const selectedNodeIds = new Set(nodeIds);
      const edges = nodeIds.length === 0
        ? []
        : db.prepare(`
            SELECT from_id, to_id, type
            FROM edges
            WHERE from_id IN (${nodeIds.map(() => "?").join(",")})
            ORDER BY from_id ASC, type ASC, to_id ASC
            LIMIT ${graphWindowLimits.total_edges * 4}
          `).all(...nodeIds)
          .map(normalizeGraphEdge)
          .filter((edge) => selectedNodeIds.has(edge.target))
          .slice(0, graphWindowLimits.total_edges);
      const recordCount = metadataCount("record_count", "records");
      return {
        ok: true,
        index_mode: "sqlite_wiki_graph_v0",
        generated_at: metadata.generated_at ?? null,
        data_root: dataRoot,
        stats: {
          records: Number(recordCount ?? 0),
          nodes: nodeCount,
          edges: edgeCount,
          shown_nodes: nodes.length,
          shown_edges: edges.length,
          truncated: nodeCount > nodes.length || edgeCount > edges.length,
        },
        nodes,
        edges,
      };
    } finally {
      db.close();
    }
  } catch (error) {
    if (error?.code !== "ENOENT" && !String(error?.message ?? "").includes("no such table")) throw error;
  }

  const index = await readJson(path.join(dataRoot, ".dino", "index", "wiki-index.json"));
  if (Number(index?.version ?? 0) >= 1 && Array.isArray(index.nodes) && Array.isArray(index.edges)) {
    const nodes = index.nodes.map(normalizeGraphNode);
    const edges = index.edges.map(normalizeGraphEdge);
    const graph = selectGraphWindow(nodes, edges);
    return {
      ok: true,
      index_mode: `json_wiki_graph_v${index.version ?? "unknown"}`,
      generated_at: index.generated_at ?? null,
      data_root: dataRoot,
      stats: {
        records: Number(index.record_count ?? 0),
        nodes: nodes.length,
        edges: edges.length,
        shown_nodes: graph.shown_node_count,
        shown_edges: graph.shown_edge_count,
        truncated: graph.truncated,
      },
      nodes: graph.nodes,
      edges: graph.edges,
    };
  }

  return {
    ok: false,
    index_mode: "missing",
    generated_at: null,
    data_root: dataRoot,
    stats: { records: 0, nodes: 0, edges: 0, shown_nodes: 0, shown_edges: 0, truncated: false },
    nodes: [],
    edges: [],
  };
}

async function readEvents(limit = 100) {
  const eventDir = path.join(dataRoot, ".dino", "events");
  const files = await readDirFiles(eventDir, ".jsonl", { newestFirst: true, limit: 7 });
  const events = [];
  for (const file of files) {
    const handle = await fs.open(file, "r");
    let text = "";
    try {
      const { size } = await handle.stat();
      const byteLength = Math.min(size, 256 * 1024);
      const buffer = Buffer.allocUnsafe(byteLength);
      const start = Math.max(0, size - byteLength);
      const { bytesRead } = await handle.read(buffer, 0, byteLength, start);
      text = buffer.subarray(0, bytesRead).toString("utf8");
      if (start > 0) text = text.slice(Math.max(0, text.indexOf("\n") + 1));
      resourceCounters.jsonl_files_read += 1;
      resourceCounters.jsonl_bytes_read += bytesRead;
    } finally {
      await handle.close();
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        events.push({ ...JSON.parse(line), _path: rel(file) });
      } catch {
        events.push({ event: "unparseable_event", at: null, _path: rel(file), raw: line.slice(0, 240) });
      }
    }
    if (events.length >= limit * 2) break;
  }
  return events
    .sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")))
    .slice(-limit);
}

// Activity has its own bounded adapter so the shell can stay responsive without
// inflating the compact snapshot budget. The adapter deliberately returns the
// same redacted event DTOs used by the existing state projection.
async function readActivityEvents(limit = 500) {
  const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 500));
  const liveEvents = await readEvents(boundedLimit);
  const canonicalPath = path.join(dataRoot, ".dino", "index", "sqlite", "operations.sqlite");
  const resolved = await resolveObservablePath(canonicalPath);
  const indexedEvents = [];
  try {
    if (resolved.managed && !resolved.filePath) throw new Error("status_generation_unavailable");
    await fs.access(resolved.filePath);
    const db = new DatabaseSync(resolved.filePath, { readOnly: true });
    try {
      const rows = db.prepare(`SELECT payload_json FROM events ORDER BY at DESC, event_key ASC LIMIT ${boundedLimit}`).all();
      for (const row of rows) {
        try { indexedEvents.push(JSON.parse(row.payload_json)); } catch { /* redaction-safe skip */ }
      }
    } finally {
      db.close();
    }
  } catch {
    // JSONL remains the portable fallback when the SQLite shard is absent.
  }
  const merged = mergeEvents(indexedEvents, liveEvents, boundedLimit)
    .map((event) => projectEvent(event))
    .sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")));
  return {
    ok: true,
    generated_at: new Date().toISOString(),
    limit: boundedLimit,
    events: merged,
  };
}

async function readJsonDir(relativeDir, limit = 50) {
  const dir = path.join(dataRoot, relativeDir);
  const scanLimit = Math.max(limit, Math.min(limit * 2, limit + 32));
  const files = await readDirFiles(dir, ".json", { newestFirst: true, limit: scanLimit });
  const records = [];
  for (const file of files) {
    const value = await readJson(file);
    if (value) records.push({ ...value, _path: rel(file) });
  }
  const sorted = records.sort((a, b) =>
      String(b.updated_at ?? b.created_at ?? b.generated_at ?? b.finished_at ?? b.audited_at ?? "").localeCompare(
        String(a.updated_at ?? a.created_at ?? a.generated_at ?? a.finished_at ?? a.audited_at ?? ""),
      ),
    );
  return sorted.slice(0, limit);
}

async function readEvidenceGraph(options = {}) {
  const canonicalPath = path.join(dataRoot, ...EVIDENCE_GRAPH_SQLITE_RELATIVE_PATH.split("/"));
  const resolved = await resolveObservablePath(canonicalPath);
  const staleCanonicalFallback = resolved.managed && !resolved.filePath && await pathExists(canonicalPath);
  if (resolved.managed && !resolved.filePath && !staleCanonicalFallback) return null;
  const databasePath = staleCanonicalFallback ? canonicalPath : resolved.filePath;
  const graph = await readEvidenceGraphWindow(dataRoot, {
    databasePath,
    focusId: options.focusId ?? null,
    lane: options.lane ?? null,
    lifecycleState: options.lifecycleState ?? null,
    provenanceStatus: options.provenanceStatus ?? null,
    edgeTypes: options.edgeTypes ?? [],
    nodeLimit: graphWindowLimits.total_nodes,
    edgeLimit: graphWindowLimits.total_edges,
    focusDepth: 3,
  });
  if (!graph?.ok) return null;
  return {
    ...graph,
    index_mode: staleCanonicalFallback ? `${graph.index_mode}+stale_canonical_fallback` : graph.index_mode,
    stale_snapshot: staleCanonicalFallback,
    stale_reason: staleCanonicalFallback ? resolved.generation?.reason ?? "status_generation_invalid" : null,
    nodes: graph.nodes.map(normalizeGraphNode),
    edges: graph.edges.map(normalizeGraphEdge),
  };
}

async function readAuditLogs(limit = 50) {
  return await readJsonDir(".dino/audits", limit);
}

async function readGraphHealth() {
  const healthPath = path.join(dataRoot, ".dino", "index", "graph-health.json");
  const health = await readJson(healthPath);
  if (health && typeof health === "object") {
    return {
      ok: true,
      _path: rel(healthPath),
      ...health,
    };
  }
  return {
    ok: false,
    version: "missing",
    status: "missing",
    score: 0,
    generated_at: null,
    data_root: dataRoot,
    index_path: null,
    indexed_record_count: 0,
    node_count: 0,
    edge_count: 0,
    unresolved_wiki_link_count: 0,
    referenced_unresolved_wiki_link_count: 0,
    accepted_instance_count: 0,
    candidate_instance_count: 0,
    promotion_review_count: 0,
    quarantine_count: 0,
    accepted_without_source_count: 0,
    accepted_missing_source_count: 0,
    candidate_without_review_count: 0,
    source_mapping_missing_count: 0,
    warnings: ["graph_health_missing"],
    _path: rel(healthPath),
  };
}

async function readNativeInstructionAuthority() {
  const authorityPath = path.join(dataRoot, ".dino", "state", "native_instruction_authority.json");
  const authority = await readJson(authorityPath);
  if (authority && typeof authority === "object") {
    return {
      ok: true,
      _path: rel(authorityPath),
      ...authority,
    };
  }
  return {
    ok: false,
    version: "missing",
    status: "missing",
    generated_at: null,
    latest_verified_at: null,
    counts: {
      surfaces: 0,
      scanned: 0,
      required_missing: 0,
      conflicts: 0,
      warnings: 0,
      evidence: 0,
    },
    findings: [],
    warnings: ["native_instruction_authority_missing"],
    visible_status: "Native instruction authority missing",
    _path: rel(authorityPath),
  };
}

async function readSourceLineageStatus() {
  const statusPath = path.join(dataRoot, ".dino", "state", "source_lineage_status.json");
  const status = await readJson(statusPath);
  if (status && typeof status === "object") {
    return {
      ok: true,
      _path: rel(statusPath),
      ...status,
    };
  }
  return {
    ok: false,
    version: "missing",
    status: "missing",
    generated_at: null,
    latest_verified_at: null,
    counts: {
      source_chunks: 0,
      source_snapshots: 0,
      provenance_links: 0,
      lineage_generations: 0,
      verified_source_chunks: 0,
      anchor_only_unverified: 0,
      unverified_source_chunks: 0,
      claim_records: 0,
      behavior_memory_records: 0,
      project_memory_records: 0,
      verified_claim_support: 0,
      unsupported_factual_claims: 0,
      dangling_claim_paths: 0,
      stale_support: 0,
      hash_mismatches: 0,
      blockers: 0,
    },
    findings: [],
    warnings: ["source_lineage_status_missing"],
    visible_status: "Source lineage status missing",
    _path: rel(statusPath),
  };
}

async function readBehaviorRecallStatus() {
  const statusPath = path.join(dataRoot, ".dino", "state", "behavior_recall_status.json");
  const status = await readJson(statusPath);
  if (status && typeof status === "object") {
    return {
      ok: true,
      _path: rel(statusPath),
      ...status,
    };
  }
  return {
    ok: false,
    version: "missing",
    status: "missing",
    generated_at: null,
    latest_verified_at: null,
    ledger_path: ".dino/state/behavior_recall_audit.jsonl",
    counts: {
      entries: 0,
      malformed_entries: 0,
      completion: 0,
      handoff: 0,
      error: 0,
      direction_change: 0,
      correction: 0,
      performed: 0,
      skipped: 0,
      not_applicable: 0,
      correction_conflicts: 0,
      correction_records: 0,
      correction_records_without_recall: 0,
      evidence_migrations_applied: 0,
      evidence_migrations_invalid: 0,
      blockers: 0,
    },
    latest_entries: [],
    findings: [],
    warnings: ["behavior_recall_status_missing"],
    visible_status: "Behavior recall status missing",
    _path: rel(statusPath),
  };
}

async function readBehaviorRecallMigrationStatus() {
  const statusPath = path.join(dataRoot, ".dino", "state", "behavior_recall_evidence_migration.json");
  const status = await readJson(statusPath);
  if (status && typeof status === "object") return { ok: true, _path: rel(statusPath), ...status };
  return {
    ok: false,
    version: "missing",
    status: "missing",
    generated_at: null,
    counts: { planned_repairs: 0, applied_repairs: 0, unresolved: 0 },
    warnings: ["behavior_recall_evidence_migration_status_missing"],
    visible_status: "Behavior recall evidence migration status missing",
    _path: rel(statusPath),
  };
}

async function readControlledCompoundingStatus() {
  const statusPath = path.join(dataRoot, ".dino", "state", "controlled_compounding_status.json");
  const status = await readJson(statusPath);
  if (status && typeof status === "object") return { ok: true, _path: rel(statusPath), ...status };
  return {
    ok: false,
    version: "missing",
    status: "missing",
    generated_at: null,
    counts: {
      controlled_candidates: 0,
      recurring_controlled_candidates: 0,
      controlled_accepted_rules: 0,
      legacy_generated_candidates_excluded: 0,
      hot_rule_tokens: 0,
      retrieved_controlled_rules: 0,
      used_controlled_rules: 0,
      max_active_proposals_in_topic: 0,
    },
    blockers: ["controlled_compounding_status_missing"],
    warnings: ["controlled_compounding_status_missing"],
    visible_status: "Controlled compounding status missing",
    _path: rel(statusPath),
  };
}

async function readOsV2Status() {
  const [gates, gateCount, lifecycleReports, lifecycleReportCount, lifecycleStatus, behaviorEvals, behaviorEvalCount, provenanceCount, sourceChunkCount] = await Promise.all([
    readJsonDir(".dino/gates", 8),
    countDirFiles(".dino/gates"),
    readJsonDir(".dino/lifecycle", 8),
    countDirFiles(".dino/lifecycle"),
    readStatusArtifact(".dino/state/node_lifecycle.json"),
    readJsonDir(".dino/evaluations", 8),
    countDirFiles(".dino/evaluations"),
    countDirFiles(".dino/provenance"),
    countDirFiles("30_Sources/chunks"),
  ]);
  const latestGate = gates[0] ?? null;
  const latestBehavior = behaviorEvals.find((entry) => String(entry.evaluation_id ?? "").startsWith("behavior-eval-")) ?? null;
  const latestLifecycle = lifecycleStatus.value ?? lifecycleReports[0] ?? null;
  const failClosed = latestGate?.fail_closed === true;
  const status = failClosed ? "blocked" : latestGate ? String(latestGate.status ?? "ready") : "pending";
  return {
    version: DINOBRAIN_VERSION,
    status,
    fail_closed: failClosed,
    latest_gate: latestGate,
    latest_behavior_eval: latestBehavior,
    latest_lifecycle: latestLifecycle,
    counts: {
      gates: gateCount,
      lifecycle_reports: lifecycleReportCount,
      behavior_evals: behaviorEvalCount,
      provenance_links: provenanceCount,
      source_chunks: sourceChunkCount,
    },
  };
}

function sourcePaths(record) {
  const values = [
    record?.source_candidate_path,
    record?.source_path,
    record?.evidence_source,
    record?.source_paths,
    record?.evidence?.source,
    record?.source?.trace_path,
    record?.source?.task_path,
    record?.source_operation_path,
  ];
  return Array.from(
    new Set(
      values
        .flatMap((value) => (Array.isArray(value) ? value : [value]))
        .map((value) => String(value ?? "").trim())
        .filter(Boolean),
    ),
  );
}

async function readLifecycleQueue() {
  const [lifecycleArtifact, backpressureArtifact, coldArtifact] = await Promise.all([
    readStatusArtifact(".dino/state/node_lifecycle.json"),
    readStatusArtifact(".dino/state/review_queue_backpressure.json"),
    readStatusArtifact(".dino/state/cold_partitions.json"),
  ]);
  const lifecycleReport = lifecycleArtifact.value ?? null;
  const reportCounts = lifecycleReport?.counts ?? {};
  const lifecycleBlockers = Number(reportCounts.lifecycle_blockers ?? lifecycleReport?.post_audit?.invalid?.length ?? 0);
  const backpressureCounts = backpressureArtifact.value?.counts ?? {};
  const hotReviewUnits = Number(backpressureCounts.hot_review_units ?? 0);
  const pendingMergeReviews = Number(backpressureCounts.pending_merge_reviews ?? 0);
  const queuePending = hotReviewUnits + pendingMergeReviews > 0;
  const queueConstrained = backpressureArtifact.artifact_parse_status !== "ok" || backpressureArtifact.value?.status !== "healthy";
  const status = lifecycleArtifact.artifact_parse_status !== "ok"
    ? "missing"
    : lifecycleReport?.status !== "healthy" || lifecycleBlockers > 0
      ? String(lifecycleReport?.status ?? "blocked")
      : queueConstrained
        ? "queue_constrained"
      : queuePending
        ? "review_pending"
        : "healthy";
  const reportBlockers = Array.isArray(lifecycleReport?.post_audit?.invalid)
    ? lifecycleReport.post_audit.invalid.map((entry) => ({
        _path: entry.path,
        claim: Array.isArray(entry.issues) ? entry.issues.join(", ") : "lifecycle blocker",
      }))
    : [];
  const retrySummaries = [
    hotReviewUnits > 0 && {
      _path: backpressureArtifact.artifact_path,
      claim: `${hotReviewUnits} hot review units await settlement`,
    },
    pendingMergeReviews > 0 && {
      _path: backpressureArtifact.artifact_path,
      claim: `${pendingMergeReviews} merge reviews remain pending`,
    },
    Number(backpressureCounts.cold_candidates ?? 0) > 0 && {
      _path: coldArtifact.artifact_path,
      claim: `${Number(backpressureCounts.cold_candidates)} candidates are held in cold review partitions`,
    },
    Number(backpressureCounts.deterministic_hold_pending ?? 0) > 0 && {
      _path: backpressureArtifact.artifact_path,
      claim: `${Number(backpressureCounts.deterministic_hold_pending)} deterministic holds await settlement`,
    },
  ].filter(Boolean);
  return {
    status,
    node_status: lifecycleReport?.status ?? "missing",
    queue_status: queuePending ? "pending" : "clear",
    backpressure_status: backpressureArtifact.value?.status ?? "missing",
    growth_mode: backpressureArtifact.value?.growth_mode ?? "cold_only",
    cold_partition_status: coldArtifact.value?.status ?? "missing",
    artifact_path: lifecycleArtifact.artifact_path,
    transaction_id: lifecycleReport?.transaction?.transaction_id ?? lifecycleReport?.last_applied_transaction?.transaction_id ?? null,
    recovery_ref: lifecycleReport?.git?.recovery_ref ?? lifecycleReport?.last_recovery_ref ?? null,
    counts: {
      candidates: Number(reportCounts.deferred_candidate_backlog ?? reportCounts.candidates ?? 0),
      accepted: Number(reportCounts.accepted ?? 0),
      promotion_reviews: Number(reportCounts.promotion_reviews ?? 0),
      pending_merge_reviews: pendingMergeReviews,
      hot_review_units: hotReviewUnits,
      cold_candidates: Number(backpressureCounts.cold_candidates ?? 0),
      deterministic_hold_pending: Number(backpressureCounts.deterministic_hold_pending ?? 0),
      quarantined: Number(reportCounts.quarantined ?? 0),
      retrievable_accepted: Number(reportCounts.retrievable_accepted ?? 0),
      held_or_excluded: Number(reportCounts.held_or_excluded ?? 0),
      lifecycle_blockers: lifecycleBlockers,
      applied_actions: Number(reportCounts.applied_actions ?? 0),
      candidate_without_review: Number(reportCounts.candidate_without_review ?? 0),
      accepted_without_source: Number(reportCounts.accepted_without_source ?? 0),
      accepted_missing_source: Number(reportCounts.accepted_missing_source ?? 0),
    },
    retry_candidates: [...reportBlockers, ...retrySummaries].slice(0, 10),
  };
}

async function readSyncRisk() {
  if (!(await pathExists(path.join(dataRoot, ".git")))) {
    return {
      status: "no_repo",
      dirty_count: 0,
      staged_count: 0,
      untracked_count: 0,
      branch: null,
      detail: "data root is not a git worktree",
    };
  }
  try {
    const { stdout } = await execFileAsync("git", ["-C", dataRoot, "status", "--porcelain=v1", "--branch"], {
      timeout: 3500,
      windowsHide: true,
      maxBuffer: 256 * 1024,
    });
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    const branch = lines.find((line) => line.startsWith("##")) ?? null;
    const changes = lines.filter((line) => !line.startsWith("##"));
    const staged = changes.filter((line) => /^[ MADRCU][MADRCU]/.test(line) && line[0] !== " ").length;
    const untracked = changes.filter((line) => line.startsWith("??")).length;
    return {
      status: changes.length > 0 ? "at_risk" : "clean",
      dirty_count: changes.length,
      staged_count: staged,
      untracked_count: untracked,
      branch,
      detail: changes.slice(0, 12),
    };
  } catch (error) {
    return {
      status: "unknown",
      dirty_count: 0,
      staged_count: 0,
      untracked_count: 0,
      branch: null,
      detail: String(error?.message ?? error),
    };
  }
}

function latestAuditForReadiness(audits) {
  const audit = audits?.[0];
  if (!audit) return null;
  return {
    audit_id: audit.audit_id ?? null,
    task_id: audit.task_id ?? null,
    trust_score: audit.trust_score ?? null,
    verdict: audit.verdict ?? null,
    audit_path: audit._path ?? null,
    provided_memory_paths: Array.isArray(audit.provided_memory_paths) ? audit.provided_memory_paths.slice(0, 20) : [],
    declared_used_memory_paths: Array.isArray(audit.declared_used_memory_paths) ? audit.declared_used_memory_paths.slice(0, 20) : [],
    observed_used_memory_paths: Array.isArray(audit.observed_used_memory_paths) ? audit.observed_used_memory_paths.slice(0, 20) : [],
    missing_expected_memory: Array.isArray(audit.missing_expected_memory) ? audit.missing_expected_memory.slice(0, 20) : [],
    hallucinated_memory_reference: Array.isArray(audit.hallucinated_memory_reference)
      ? audit.hallucinated_memory_reference.slice(0, 20)
      : [],
  };
}

async function buildReadiness(existingState = null, loadedGeneration = null) {
  const readiness = await buildCanonicalReadiness(dataRoot, {
    loadedGeneration: loadedGeneration ?? await currentStatusGeneration(),
    verifySourceCoherence: true,
  });
  return {
    ...readiness,
    latest_audit: latestAuditForReadiness(existingState?.memory_audits),
  };
}

function readTraceSummary(events, packs, traces) {
  const latestPack = Array.isArray(packs) ? packs[0] : null;
  const latestTrace = Array.isArray(traces) ? traces[0] : null;
  const latestPreflight = Array.isArray(events)
    ? events.find((event) => ["codex_preflight_completed", "context_pack_created"].includes(String(event.event ?? "")))
    : null;
  const items = Array.isArray(latestPack?.items) ? latestPack.items : [];
  const usedMemoryPaths = Array.isArray(latestTrace?.used_memory_paths) ? latestTrace.used_memory_paths : [];
  return {
    status: latestPack ? "grounded" : "idle",
    latest_pack_path: latestPack?._path ?? latestPack?.path ?? null,
    latest_pack_id: latestPack?.pack_id ?? null,
    item_count: Number(latestPack?.item_count ?? items.length ?? 0),
    grounded_items: items.slice(0, 8).map((item) => ({
      path: item.path,
      title: item.title,
      kind: item.kind,
      score: item.score,
    })),
    latest_trace_path: latestTrace?._path ?? latestTrace?.path ?? null,
    latest_trace_task_id: latestTrace?.task_id ?? null,
    latest_trace_outcome: latestTrace?.outcome ?? null,
    used_memory_count: usedMemoryPaths.length,
    latest_preflight_at: latestPreflight?.at ?? null,
    latest_preflight_event: latestPreflight?.event ?? null,
  };
}

function summarize(events, tasks, packs) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    data_root: dataRoot,
    generated_at: new Date().toISOString(),
    event_count: events.length,
    task_count: tasks.length,
    context_pack_count: packs.length,
    today_event_count: events.filter((event) => String(event.at ?? "").startsWith(today)).length,
    active_task_count: tasks.filter((task) => task.status === "started").length,
    last_event_at: events.at(-1)?.at ?? null,
  };
}

function summarizeIndex(index) {
  const today = new Date().toISOString().slice(0, 10);
  const events = Array.isArray(index.recent_events) ? index.recent_events : [];
  const activeTasks = Array.isArray(index.active_tasks) ? index.active_tasks : [];
  return {
    data_root: dataRoot,
    generated_at: new Date().toISOString(),
    index_mode: "operations_index_v0",
    index_generated_at: index.generated_at ?? null,
    event_count: index.counts?.events ?? events.length,
    task_count: index.counts?.tasks ?? 0,
    context_pack_count: index.counts?.context_packs ?? 0,
    today_event_count: events.filter((event) => String(event.at ?? "").startsWith(today)).length,
    active_task_count: activeTasks.length,
    last_event_at: events[0]?.at ?? null,
  };
}

function withDisplayPath(record) {
  return { ...record, _path: record._path ?? record.path };
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function withTraceDisplay(record) {
  const displayed = withDisplayPath(record);
  return {
    ...displayed,
    used_memory_paths: parseJsonArray(record.used_memory_paths ?? record.used_memory_paths_json),
    context_pack_paths: parseJsonArray(record.context_pack_paths ?? record.context_pack_paths_json),
    session_archive_paths: parseJsonArray(record.session_archive_paths ?? record.session_archive_paths_json),
    candidate_paths: parseJsonArray(record.candidate_paths ?? record.candidate_paths_json),
  };
}

function recordKey(record) {
  return String(record?._path ?? record?.path ?? record?.task_id ?? record?.pack_id ?? record?.trace_path ?? "");
}

function recordTime(record) {
  return String(record?.updated_at ?? record?.created_at ?? record?.finished_at ?? record?.audited_at ?? record?.at ?? "");
}

function sortRecent(records) {
  return records.sort((a, b) => recordTime(b).localeCompare(recordTime(a)));
}

function mergeByPath(indexedRecords = [], liveRecords = [], limit = 50) {
  const byKey = new Map();
  for (const record of indexedRecords) {
    const key = recordKey(record);
    if (key) byKey.set(key, withDisplayPath(record));
  }
  for (const record of liveRecords) {
    const key = recordKey(record);
    if (key) byKey.set(key, withDisplayPath(record));
  }
  return sortRecent([...byKey.values()]).slice(0, limit);
}

function mergeTasksByPath(indexedRecords = [], liveRecords = [], limit = stateLimits.tasks) {
  const merged = mergeByPath(indexedRecords, liveRecords, indexedRecords.length + liveRecords.length);
  return merged
    .sort((left, right) => {
      const activeDelta = Number(right.status === "started") - Number(left.status === "started");
      return activeDelta || recordTime(right).localeCompare(recordTime(left));
    })
    .slice(0, limit);
}

function eventKey(event) {
  return [
    event?._path ?? "",
    event?.event ?? "",
    event?.at ?? "",
    event?.task_id ?? event?.pack_id ?? event?.audit_id ?? event?.path ?? "",
  ].join("|");
}

function mergeEvents(indexedEvents = [], liveEvents = [], limit = 100) {
  const byKey = new Map();
  for (const event of indexedEvents) byKey.set(eventKey(event), event);
  for (const event of liveEvents) byKey.set(eventKey(event), event);
  return [...byKey.values()].sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? ""))).slice(0, limit);
}

async function readLiveOperations() {
  const [events, tasks, packs, traces] = await Promise.all([
    readEvents(stateLimits.events),
    readJsonDir(".dino/tasks", stateLimits.tasks),
    readJsonDir(".dino/context-packs", stateLimits.context_packs),
    readJsonDir(".dino/traces", stateLimits.traces),
  ]);
  return {
    events: events.slice().reverse(),
    tasks,
    context_packs: packs,
    traces: traces.map(withTraceDisplay),
  };
}

function activityNodeLabel(text, max = 34) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function withActivityGraph(wikiGraph, operationState) {
  if (!wikiGraph.ok) return wikiGraph;
  const nodes = [...wikiGraph.nodes];
  const edges = [...wikiGraph.edges];
  const seen = new Set(nodes.map((node) => node.id));
  const edgeSeen = new Set(edges.map((edge) => `${edge.source}->${edge.target}:${edge.type}`));
  const nodeByPath = new Map();
  for (const node of nodes) {
    if (node.path) nodeByPath.set(String(node.path).replace(/\\/g, "/"), node.id);
  }
  const addNode = (node) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    if (node.path) nodeByPath.set(String(node.path).replace(/\\/g, "/"), node.id);
    nodes.push({ count: 1, color: graphColor(node), ...node });
  };
  const addEdge = (source, target, type, extra = {}) => {
    const key = `${source}->${target}:${type}`;
    if (seen.has(source) && seen.has(target) && !edgeSeen.has(key)) {
      edgeSeen.add(key);
      edges.push({ source, target, type, ...extra });
    }
  };
  const memoryLabel = (memoryPath, fallback = null) => {
    const name = path.basename(String(memoryPath ?? ""), ".json").replaceAll("_", " ");
    return activityNodeLabel(fallback || name || memoryPath, 42);
  };
  const ensureMemoryNode = (memoryPath, patch = {}) => {
    const cleanPath = String(memoryPath ?? "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
    if (!cleanPath) return null;
    const existing = nodeByPath.get(cleanPath);
    if (existing) return existing;
    const nodeId = `memory:${cleanPath}`;
    addNode({
      id: nodeId,
      type: "memory_ref",
      label: memoryLabel(cleanPath, patch.title),
      path: cleanPath,
      record_id: patch.kind ?? patch.record_id ?? null,
      count: Math.max(2, Number(patch.score ?? patch.count ?? 2)),
      updated_at: patch.updated_at ?? null,
    });
    return nodeId;
  };

  const tasks = Array.isArray(operationState?.tasks) ? operationState.tasks : [];
  const events = Array.isArray(operationState?.events) ? operationState.events : [];
  const packs = Array.isArray(operationState?.context_packs) ? operationState.context_packs : [];
  const traces = Array.isArray(operationState?.traces) ? operationState.traces : [];
  const activeTasks = tasks.filter((task) => task.status === "started");
  const displayedTasks = [...activeTasks, ...tasks.filter((task) => task.status !== "started")].slice(0, 14);
  const displayedPacks = packs.slice(0, 8);
  const displayedTraces = traces.slice(0, 8);
  const displayedEvents = events.slice(0, 18);
  const rootId = "activity:root";
  const taskNodeIds = new Map();
  const packNodeIds = new Map();

  addNode({
    id: rootId,
    type: "activity_root",
    label: `Live Activity (${activeTasks.length})`,
    path: ".dino",
    count: Math.max(1, activeTasks.length + displayedEvents.length),
    active_count: activeTasks.length,
  });

  for (const task of displayedTasks) {
    const taskId = String(task.task_id ?? task.path ?? task._path ?? "");
    if (!taskId) continue;
    const nodeId = `task:${taskId}`;
    const active = task.status === "started";
    addNode({
      id: nodeId,
      type: active ? "active_task" : "task",
      label: active ? `Active: ${activityNodeLabel(task.request)}` : activityNodeLabel(task.request || taskId),
      path: task._path ?? task.path ?? null,
      record_id: taskId,
      count: active ? 8 : 3,
      status: task.status,
      updated_at: task.updated_at ?? task.created_at ?? null,
    });
    taskNodeIds.set(taskId, nodeId);
    addEdge(rootId, nodeId, active ? "active_task" : "recent_task");
  }

  for (const pack of displayedPacks) {
    const packPath = String(pack._path ?? pack.path ?? pack.pack_id ?? "");
    if (!packPath) continue;
    const nodeId = `pack:${packPath}`;
    addNode({
      id: nodeId,
      type: "context_pack",
      label: activityNodeLabel(pack.question || pack.pack_id || "Context Pack"),
      path: pack._path ?? pack.path ?? null,
      record_id: pack.pack_id ?? null,
      count: Math.max(1, Number(pack.item_count ?? 1)),
      updated_at: pack.created_at ?? null,
    });
    packNodeIds.set(packPath, nodeId);
    const taskSource = pack.task_id && taskNodeIds.has(String(pack.task_id))
      ? taskNodeIds.get(String(pack.task_id))
      : rootId;
    addEdge(taskSource, nodeId, taskSource === rootId ? "context_pack" : "uses_context");
    for (const item of (Array.isArray(pack.items) ? pack.items : []).slice(0, 8)) {
      const memoryNodeId = ensureMemoryNode(item.path, item);
      if (memoryNodeId) addEdge(nodeId, memoryNodeId, "retrieves_memory", { score: Number(item.score ?? 0) });
    }
  }

  for (const trace of displayedTraces) {
    const tracePath = String(trace._path ?? trace.path ?? trace.trace_path ?? trace.task_id ?? "");
    if (!tracePath) continue;
    const nodeId = `trace:${tracePath}`;
    const usedPaths = Array.isArray(trace.used_memory_paths) ? trace.used_memory_paths : [];
    addNode({
      id: nodeId,
      type: "trace",
      label: activityNodeLabel(trace.outcome ? `Trace: ${trace.outcome}` : trace.summary || trace.task_id || "Finish trace"),
      path: trace._path ?? trace.path ?? null,
      record_id: trace.task_id ?? null,
      count: Math.max(2, usedPaths.length),
      status: trace.outcome ?? null,
      updated_at: trace.finished_at ?? null,
    });
    const taskSource = trace.task_id && taskNodeIds.has(String(trace.task_id))
      ? taskNodeIds.get(String(trace.task_id))
      : rootId;
    addEdge(taskSource, nodeId, taskSource === rootId ? "recent_trace" : "finish_trace");
    for (const packPath of (Array.isArray(trace.context_pack_paths) ? trace.context_pack_paths : []).slice(0, 4)) {
      const packNodeId = packNodeIds.get(String(packPath));
      if (packNodeId) addEdge(nodeId, packNodeId, "trace_pack");
    }
    for (const memoryPath of usedPaths.slice(0, 10)) {
      const memoryNodeId = ensureMemoryNode(memoryPath);
      if (memoryNodeId) addEdge(nodeId, memoryNodeId, "used_memory");
    }
  }

  for (const event of displayedEvents) {
    const eventId = eventKey(event);
    if (!eventId.trim()) continue;
    const nodeId = `event:${eventId}`;
    const eventName = String(event.event ?? "event");
    addNode({
      id: nodeId,
      type: "event",
      label: activityNodeLabel(eventName.replaceAll("_", " ")),
      path: event._path ?? null,
      count: eventName === "task_started" ? 3 : 1,
      event: eventName,
      updated_at: event.at ?? null,
    });
    const taskId = event.task_id ? `task:${event.task_id}` : null;
    if (taskId && seen.has(taskId)) addEdge(taskId, nodeId, "task_event");
    else addEdge(rootId, nodeId, "event");
  }

  const activityTypes = new Set(["activity_root", "active_task", "task", "context_pack", "trace", "event", "memory_ref"]);
  const nodePriority = new Map([["root", 1], ["folder", 2], ["kind", 3], ["tag", 4], ["record", 5], ["wikilink", 6]]);
  const boundedNodes = nodes
    .map((node, index) => ({ node, index }))
    .sort((left, right) => {
      const leftPriority = activityTypes.has(left.node.type) ? 0 : (nodePriority.get(left.node.type) ?? 7);
      const rightPriority = activityTypes.has(right.node.type) ? 0 : (nodePriority.get(right.node.type) ?? 7);
      return leftPriority - rightPriority || left.index - right.index;
    })
    .slice(0, graphWindowLimits.total_nodes)
    .map((entry) => entry.node);
  const boundedNodeIds = new Set(boundedNodes.map((node) => node.id));
  const boundedEdges = edges
    .filter((edge) => boundedNodeIds.has(edge.source) && boundedNodeIds.has(edge.target))
    .slice(0, graphWindowLimits.total_edges);
  const addedNodeCount = Math.max(0, nodes.length - wikiGraph.nodes.length);
  const addedEdgeCount = Math.max(0, edges.length - wikiGraph.edges.length);
  const totalNodeCount = Number(wikiGraph.stats.nodes ?? wikiGraph.nodes.length) + addedNodeCount;
  const totalEdgeCount = Number(wikiGraph.stats.edges ?? wikiGraph.edges.length) + addedEdgeCount;

  return {
    ...wikiGraph,
    index_mode: `${wikiGraph.index_mode}+operations_activity_v2`,
    stats: {
      ...wikiGraph.stats,
      nodes: totalNodeCount,
      edges: totalEdgeCount,
      shown_nodes: boundedNodes.length,
      shown_edges: boundedEdges.length,
      truncated: Boolean(wikiGraph.stats.truncated) || totalNodeCount > boundedNodes.length || totalEdgeCount > boundedEdges.length,
      operation_nodes: addedNodeCount,
      active_tasks: activeTasks.length,
      trace_nodes: nodes.filter((node) => node.type === "trace").length,
      memory_reference_nodes: nodes.filter((node) => node.type === "memory_ref").length,
      memory_edges: edges.filter((edge) => ["retrieves_memory", "used_memory"].includes(edge.type)).length,
    },
    nodes: boundedNodes,
    edges: boundedEdges,
  };
}

function compactPayloadText(value, max = 640) {
  if (typeof value !== "string") return value;
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function boundedPayloadValue(value, depth = 0) {
  if (typeof value === "string") return compactPayloadText(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const limit = depth < 2 ? 12 : 8;
    return value.slice(0, limit).map((item) => boundedPayloadValue(item, depth + 1));
  }
  if (depth >= 5) return null;
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 48)
      .map(([key, item]) => [key, boundedPayloadValue(item, depth + 1)]),
  );
}

function projectEvent(event) {
  return Object.fromEntries([
    "event", "at", "task_id", "pack_id", "audit_id", "trace_path", "context_pack_trace", "path", "_path", "error", "prompt_preview",
  ].filter((key) => event?.[key] !== undefined).map((key) => [key, compactPayloadText(event[key], 480)]));
}

function projectTask(task) {
  return {
    task_id: task?.task_id ?? null,
    status: task?.status ?? null,
    request: compactPayloadText(task?.request, 640),
    project: compactPayloadText(task?.project, 160),
    mode: task?.mode ?? null,
    sensitivity: task?.sensitivity ?? null,
    created_at: task?.created_at ?? null,
    updated_at: task?.updated_at ?? null,
    sync_policy: task?.sync_policy ?? null,
    path: task?.path ?? null,
    _path: task?._path ?? task?.path ?? null,
  };
}

function projectContextPack(pack) {
  const items = Array.isArray(pack?.items) ? pack.items : [];
  return {
    pack_id: pack?.pack_id ?? null,
    task_id: pack?.task_id ?? null,
    question: compactPayloadText(pack?.question, 480),
    created_at: pack?.created_at ?? null,
    item_count: Number(pack?.item_count ?? items.length),
    path: pack?.path ?? null,
    _path: pack?._path ?? pack?.path ?? null,
    items: items.slice(0, 8).map((item) => ({
      path: item?.path ?? null,
      kind: item?.kind ?? null,
      title: compactPayloadText(item?.title, 240),
      summary: compactPayloadText(item?.summary, 320),
      score: item?.score ?? null,
    })),
  };
}

function projectTrace(trace) {
  return {
    task_id: trace?.task_id ?? null,
    outcome: trace?.outcome ?? null,
    summary: compactPayloadText(trace?.summary, 640),
    growth_policy: trace?.growth_policy ?? null,
    finished_at: trace?.finished_at ?? null,
    path: trace?.path ?? null,
    _path: trace?._path ?? trace?.path ?? null,
    used_memory_paths: parseJsonArray(trace?.used_memory_paths ?? trace?.used_memory_paths_json).slice(0, 12),
    context_pack_paths: parseJsonArray(trace?.context_pack_paths ?? trace?.context_pack_paths_json).slice(0, 4),
  };
}

function projectAudit(audit) {
  const limitPaths = (value) => (Array.isArray(value) ? value.slice(0, 12).map((item) => compactPayloadText(String(item), 320)) : []);
  return {
    audit_id: audit?.audit_id ?? null,
    task_id: audit?.task_id ?? null,
    audited_at: audit?.audited_at ?? null,
    trust_score: audit?.trust_score ?? null,
    verdict: audit?.verdict ?? null,
    provided_memory_paths: limitPaths(audit?.provided_memory_paths),
    declared_used_memory_paths: limitPaths(audit?.declared_used_memory_paths),
    observed_used_memory_paths: limitPaths(audit?.observed_used_memory_paths),
    missing_expected_memory: limitPaths(audit?.missing_expected_memory),
    hallucinated_memory_reference: limitPaths(audit?.hallucinated_memory_reference),
    graph_health_snapshot: audit?.graph_health_snapshot ? { score: audit.graph_health_snapshot.score ?? null } : null,
    path: audit?.path ?? null,
    _path: audit?._path ?? audit?.path ?? null,
  };
}

function enforceStatePayloadBudget(payload) {
  const listKeys = ["events", "tasks", "context_packs", "traces", "memory_audits"];
  let projected = payload;
  let bytes = serializedBytes(projected);
  while (bytes > statePayloadTargetBytes && listKeys.some((key) => projected[key].length > 1)) {
    projected = {
      ...projected,
      ...Object.fromEntries(listKeys.map((key) => [key, projected[key].slice(0, Math.max(1, Math.ceil(projected[key].length / 2)))])),
    };
    bytes = serializedBytes(projected);
  }
  projected.payload = {
    projection_version: "observatory_state_projection_v1",
    budget_bytes: statePayloadBudgetBytes,
    serialized_bytes: 0,
    within_budget: bytes < statePayloadBudgetBytes,
  };
  projected.payload.serialized_bytes = serializedBytes(projected);
  projected.payload.within_budget = projected.payload.serialized_bytes < statePayloadBudgetBytes;
  projected.payload.serialized_bytes = serializedBytes(projected);
  return projected;
}

function projectStatePayload(payload) {
  return enforceStatePayloadBudget({
    ok: payload.ok === true,
    summary: boundedPayloadValue(payload.summary),
    events: payload.events.slice(0, stateLimits.events).map(projectEvent),
    tasks: payload.tasks.slice(0, stateLimits.tasks).map(projectTask),
    context_packs: payload.context_packs.slice(0, stateLimits.context_packs).map(projectContextPack),
    traces: payload.traces.slice(0, stateLimits.traces).map(projectTrace),
    memory_audits: payload.memory_audits.slice(0, stateLimits.memory_audits).map(projectAudit),
    graph_health: boundedPayloadValue(payload.graph_health),
    native_instruction_authority: boundedPayloadValue(payload.native_instruction_authority),
    source_lineage: boundedPayloadValue(payload.source_lineage),
    behavior_recall_migration: boundedPayloadValue(payload.behavior_recall_migration),
    behavior_recall: boundedPayloadValue(payload.behavior_recall),
    controlled_compounding: boundedPayloadValue(payload.controlled_compounding),
    lifecycle: boundedPayloadValue(payload.lifecycle),
    sync_risk: boundedPayloadValue(payload.sync_risk),
    sync_scheduler: boundedPayloadValue(payload.sync_scheduler),
    local_only: boundedPayloadValue(payload.local_only),
    os_v2: boundedPayloadValue(payload.os_v2),
    read_trace: boundedPayloadValue(payload.read_trace),
  });
}

function projectReadinessPayload(readiness) {
  const compactGate = (gate) => ({
    id: gate.id,
    gate_id: gate.gate_id,
    label: gate.label,
    status: gate.status,
    operational_status: gate.operational_status,
    audit_status: gate.audit_status,
    blocker_reason: gate.blocker_reason,
    reason_codes: Array.isArray(gate.reason_codes) ? gate.reason_codes.slice(0, 4) : [],
    proof_path: gate.proof_path,
    freshness: gate.freshness,
    generation_id: gate.generation_id,
    next_safe_action: gate.next_safe_action,
  });
  return {
    ok: readiness.ok,
    version: readiness.version,
    contract_version: readiness.contract_version,
    generated_at: readiness.generated_at,
    status: readiness.status,
    operational_status: readiness.operational_status,
    visible_status: readiness.visible_status,
    parity_hash: readiness.parity_hash,
    status_generation: {
      ...readiness.status_generation,
      errors: Array.isArray(readiness.status_generation?.errors) ? readiness.status_generation.errors.slice(0, 12) : [],
      reason_codes: Array.isArray(readiness.status_generation?.reason_codes)
        ? readiness.status_generation.reason_codes.slice(0, 12)
        : [],
    },
    completion_audit: readiness.completion_audit,
    health_status: {
      ...readiness.health_status,
      checks: Array.isArray(readiness.health_status?.checks)
        ? readiness.health_status.checks.map((check) => ({
            id: check.id,
            status: check.status,
            reason: check.reason,
            freshness: check.freshness,
          }))
        : [],
      warnings: Array.isArray(readiness.health_status?.warnings) ? readiness.health_status.warnings.slice(0, 12) : [],
    },
    node_lifecycle_status: boundedPayloadValue(readiness.node_lifecycle_status),
    client_mcp_direct_status: boundedPayloadValue(readiness.client_mcp_direct_status),
    rag_status: boundedPayloadValue(readiness.rag_status),
    vector_index_migration_status: boundedPayloadValue(readiness.vector_index_migration_status),
    live_semantic_query_status: boundedPayloadValue(readiness.live_semantic_query_status),
    answer_quality_status: boundedPayloadValue(readiness.answer_quality_status),
    scale_50k_status: boundedPayloadValue(readiness.scale_50k_status),
    controlled_compounding_status: boundedPayloadValue(readiness.controlled_compounding_status),
    release_manifest_status: boundedPayloadValue(readiness.release_manifest_status),
    lanes: {
      blockers: Array.isArray(readiness.lanes?.blockers) ? readiness.lanes.blockers.map(compactGate) : [],
      reviewer_pending: Array.isArray(readiness.lanes?.reviewer_pending) ? readiness.lanes.reviewer_pending.slice(0, 12) : [],
      main_pending: Array.isArray(readiness.lanes?.main_pending) ? readiness.lanes.main_pending.slice(0, 12) : [],
      verifier_pending: Array.isArray(readiness.lanes?.verifier_pending) ? readiness.lanes.verifier_pending.slice(0, 12) : [],
    },
    counts: readiness.counts,
    latest_audit: boundedPayloadValue(readiness.latest_audit),
  };
}

function compactSerializedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function enforceSnapshotPayloadBudget(snapshot) {
  const projected = {
    ...snapshot,
    state: {
      ...snapshot.state,
      events: [...snapshot.state.events],
      tasks: [...snapshot.state.tasks],
      context_packs: [...snapshot.state.context_packs],
      traces: [...snapshot.state.traces],
      memory_audits: [...snapshot.state.memory_audits],
    },
    graph: {
      ...snapshot.graph,
      nodes: [...snapshot.graph.nodes],
      edges: [...snapshot.graph.edges],
    },
  };
  const trim = (items, floor, step) => {
    if (items.length <= floor) return false;
    items.length = Math.max(floor, items.length - step);
    return true;
  };
  while (compactSerializedBytes(projected) > statePayloadTargetBytes) {
    if (trim(projected.graph.edges, 200, 40)) continue;
    if (trim(projected.state.events, 20, 5)) continue;
    if (trim(projected.state.tasks, 10, 2)) continue;
    if (trim(projected.state.traces, 5, 1)) continue;
    if (trim(projected.state.context_packs, 5, 1)) continue;
    if (trim(projected.state.memory_audits, 2, 1)) continue;
    break;
  }
  projected.graph.stats = {
    ...projected.graph.stats,
    shown_nodes: projected.graph.nodes.length,
    shown_edges: projected.graph.edges.length,
    truncated:
      projected.graph.stats?.truncated === true ||
      projected.graph.edges.length < snapshot.graph.edges.length ||
      projected.graph.nodes.length < snapshot.graph.nodes.length,
  };
  projected.state.payload = {
    ...projected.state.payload,
    serialized_bytes: compactSerializedBytes(projected.state),
    within_budget: compactSerializedBytes(projected.state) < statePayloadBudgetBytes,
  };
  projected.payload = {
    projection_version: "observatory_snapshot_projection_v1",
    budget_bytes: statePayloadBudgetBytes,
    target_bytes: statePayloadTargetBytes,
    serialized_bytes: 0,
    within_budget: false,
  };
  projected.payload.serialized_bytes = compactSerializedBytes(projected);
  projected.payload.within_budget = projected.payload.serialized_bytes < statePayloadBudgetBytes;
  projected.payload.serialized_bytes = compactSerializedBytes(projected);
  return projected;
}

async function buildState() {
  const localOnly = localOnlyStatus(dataRoot);
  const [audits, auditCount, live, sqlite, graphHealth, nativeAuthority, sourceLineage, behaviorRecallMigration, behaviorRecall, controlledCompounding, lifecycle, syncRisk, syncScheduler, osV2] = await Promise.all([
    readAuditLogs(stateLimits.memory_audits),
    countDirFiles(".dino/audits"),
    readLiveOperations(),
    readSqliteOperations(),
    readGraphHealth(),
    readNativeInstructionAuthority(),
    readSourceLineageStatus(),
    readBehaviorRecallMigrationStatus(),
    readBehaviorRecallStatus(),
    readControlledCompoundingStatus(),
    readLifecycleQueue(),
    readSyncRisk(),
    readBoundedSyncState(),
    readOsV2Status(),
  ]);
  const decorate = (payload) => projectStatePayload({
    ...payload,
    summary: {
      ...payload.summary,
      graph_health_status: graphHealth.status,
      graph_health_score: graphHealth.score,
      native_instruction_authority_status: nativeAuthority.status,
      source_lineage_status: sourceLineage.status,
      behavior_recall_migration_status: behaviorRecallMigration.status,
      behavior_recall_status: behaviorRecall.status,
      controlled_compounding_status: controlledCompounding.status,
      lifecycle_status: lifecycle.status,
      sync_risk_status: syncRisk.status,
      operating_mode: localOnly.mode,
      push_policy: localOnly.push_policy,
      backup_status: localOnly.backup?.status ?? "not_verified",
      sync_scheduler_status: syncScheduler.last_attempt?.outcome ?? (syncScheduler.queued_safe_file_count + syncScheduler.queued_conditional_count > 0 ? "queued" : "idle"),
      os_v2_status: osV2.status,
    },
    graph_health: graphHealth,
    native_instruction_authority: nativeAuthority,
    source_lineage: sourceLineage,
    behavior_recall_migration: behaviorRecallMigration,
    behavior_recall: behaviorRecall,
    controlled_compounding: controlledCompounding,
    lifecycle,
    sync_risk: syncRisk,
    local_only: localOnly,
    sync_scheduler: syncScheduler,
    os_v2: osV2,
    read_trace: readTraceSummary(payload.events, payload.context_packs, payload.traces),
  });
  if (sqlite) {
    const events = mergeEvents(sqlite.events, live.events, stateLimits.events);
    const tasks = mergeTasksByPath(sqlite.tasks, live.tasks, stateLimits.tasks);
    const contextPacks = mergeByPath(sqlite.context_packs, live.context_packs, stateLimits.context_packs);
    const traces = mergeByPath(sqlite.traces, live.traces, stateLimits.traces).map(withTraceDisplay);
    return decorate({
      ok: true,
      summary: {
        data_root: dataRoot,
        generated_at: sqlite.generated_at,
        index_mode: `${sqlite.index_mode}+live_files`,
        event_count: Math.max(sqlite.counts.events, events.length),
        task_count: Math.max(sqlite.counts.tasks, tasks.length),
        context_pack_count: Math.max(sqlite.counts.context_packs, contextPacks.length),
        memory_audit_count: auditCount,
        today_event_count: events.filter((event) => String(event.at ?? "").startsWith(new Date().toISOString().slice(0, 10))).length,
        active_task_count: Math.max(Number(sqlite.counts.active_tasks ?? 0), tasks.filter((task) => task.status === "started").length),
        last_event_at: events[0]?.at ?? null,
      },
      events,
      tasks,
      context_packs: contextPacks,
      traces,
      memory_audits: audits,
    });
  }

  const index = await readOperationIndex();
  if (index) {
    const events = mergeEvents(index.recent_events ?? [], live.events, stateLimits.events);
    const tasks = mergeTasksByPath(
      [...(index.active_tasks ?? []), ...(index.recent_tasks ?? [])].map(withDisplayPath),
      live.tasks,
      stateLimits.tasks,
    );
    const contextPacks = mergeByPath((index.recent_context_packs ?? []).map(withDisplayPath), live.context_packs, stateLimits.context_packs);
    const traces = mergeByPath((index.recent_traces ?? []).map(withTraceDisplay), live.traces, stateLimits.traces).map(withTraceDisplay);
    return decorate({
      ok: true,
      summary: {
        ...summarizeIndex(index),
        index_mode: "operations_index_v0+live_files",
        event_count: Math.max(index.counts?.events ?? 0, events.length),
        task_count: Math.max(index.counts?.tasks ?? 0, tasks.length),
        context_pack_count: Math.max(index.counts?.context_packs ?? 0, contextPacks.length),
        active_task_count: tasks.filter((task) => task.status === "started").length,
        last_event_at: events[0]?.at ?? null,
        memory_audit_count: auditCount,
      },
      events,
      tasks,
      context_packs: contextPacks,
      traces,
      memory_audits: audits,
    });
  }

  return decorate({
    ok: true,
    summary: { ...summarize(live.events.slice().reverse(), live.tasks, live.context_packs), memory_audit_count: auditCount },
    events: live.events,
    tasks: live.tasks,
    context_packs: live.context_packs,
    traces: live.traces,
    memory_audits: audits,
  });
}

async function getState() {
  return cachedResource("state", "state", buildState);
}

async function getGraph(existingState = null, options = {}) {
  const operationState = existingState ?? await getState();
  const generation = await currentStatusGeneration();
  const key = [
    String(operationState?.summary?.generated_at ?? "state-missing"),
    generation.pointer?.generation_id ?? generation.status,
    options.focusId ?? "",
    options.lane ?? "",
    options.lifecycleState ?? "",
    options.provenanceStatus ?? "",
    ...(options.edgeTypes ?? []),
  ].join(":");
  return cachedResource("graph", key, async () => {
    const [evidenceGraph, readiness] = await Promise.all([
      readEvidenceGraph(options),
      getReadiness(operationState),
    ]);
    const graph = evidenceGraph ?? withActivityGraph(await readWikiGraph(), operationState);
    return {
      ...graph,
      readiness: {
        version: readiness.version,
        parity_hash: readiness.parity_hash,
        status: readiness.status,
        operational_status: readiness.operational_status,
        generation_id: readiness.status_generation?.generation_id ?? null,
        gate_statuses: Object.fromEntries(readiness.gates.map((gate) => [gate.gate_id, gate.status])),
      },
    };
  });
}

async function getReadiness(existingState = null) {
  const operationState = existingState ?? await getState();
  const generation = await currentStatusGeneration();
  const key = `${String(operationState?.summary?.generated_at ?? "state-missing")}:${generation.pointer?.generation_id ?? generation.status}`;
  return cachedResource("readiness", key, () => buildReadiness(operationState, generation));
}

async function getSnapshot() {
  return cachedResource("snapshot", "snapshot", async () => {
    const operationState = await getState();
    const [graph, completionReadiness] = await Promise.all([
      getGraph(operationState),
      getReadiness(operationState),
    ]);
    return enforceSnapshotPayloadBudget({
      ok: operationState.ok === true,
      generated_at: new Date().toISOString(),
      state: operationState,
      graph,
      readiness: projectReadinessPayload(completionReadiness),
    });
  });
}

function html() {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DinoBrain Observatory</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0d0b;
      --panel: #121611;
      --panel-2: #171c15;
      --line: #2d382d;
      --text: #eee6d2;
      --muted: #a49c87;
      --bone: #e6dcc2;
      --amber: #d99a3d;
      --fern: #7cc66a;
      --basalt: #4fb6a4;
      --clay: #c76f47;
      --red: #df6b55;
      --violet: #b99a69;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background:
        linear-gradient(180deg, rgba(217, 154, 61, .04), transparent 36%),
        var(--bg);
      color: var(--text);
      font: 14px/1.45 "Segoe UI", system-ui, sans-serif;
      letter-spacing: 0;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 18px;
      border-bottom: 1px solid var(--line);
      background:
        linear-gradient(90deg, rgba(217, 154, 61, .08), rgba(79, 182, 164, .05) 48%, rgba(124, 198, 106, .05)),
        #0d110d;
      position: sticky;
      top: 0;
      z-index: 5;
    }
    h1 {
      margin: 0;
      font-size: 18px;
      font-weight: 700;
    }
    code {
      color: #d8cdae;
      font-family: "Cascadia Mono", Consolas, monospace;
      font-size: 12px;
      word-break: break-all;
    }
    main {
      display: grid;
      grid-template-columns: 1fr;
      gap: 0;
      min-height: calc(100vh - 138px);
      background: var(--bg);
    }
    section {
      background: var(--bg);
      min-width: 0;
      padding: 18px;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 18px;
    }
    .stat {
      border: 1px solid var(--line);
      border-radius: 8px;
      background:
        linear-gradient(180deg, rgba(238, 230, 210, .03), transparent),
        var(--panel);
      padding: 10px;
      min-height: 64px;
    }
    .stat strong {
      display: block;
      font-size: 22px;
      line-height: 1;
      margin-bottom: 7px;
    }
    .stat span, .muted {
      color: var(--muted);
      font-size: 12px;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .shell-intro {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 14px;
      align-items: center;
      margin-bottom: 14px;
      padding: 12px 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: linear-gradient(90deg, rgba(124,198,106,.08), rgba(79,182,164,.04)), var(--panel);
    }
    .shell-intro h2 { margin: 0 0 4px; font-size: 15px; }
    .shell-intro p { margin: 0; color: var(--muted); font-size: 12px; }
    .connection-state { color: var(--muted); font-size: 12px; text-align: right; }
    .connection-state strong { display: block; color: var(--text); }
    .surface-nav { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 14px; }
    .surface-nav button { border: 1px solid var(--line); border-radius: 6px; background: #10150f; color: var(--muted); padding: 5px 10px; font: inherit; font-size: 12px; cursor: pointer; }
    .surface-nav button:hover, .surface-nav button:focus-visible { border-color: var(--amber); color: var(--text); outline: none; }
    [data-surface-target] { scroll-margin-top: 76px; }
    .chip[role="button"] { cursor: pointer; }
    .chip[role="button"]:focus-visible, .activity-control:focus-visible, .event:focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; }
    .activity-panel {
      border: 1px solid #3b452f;
      border-radius: 8px;
      background: var(--panel-2);
      margin-bottom: 18px;
      overflow: hidden;
    }
    .activity-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; border-bottom: 1px solid #35422d; }
    .activity-head h2 { margin: 0; font-size: 14px; }
    .activity-meta { color: var(--muted); font-size: 12px; }
    .activity-controls { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--line); background: rgba(9,13,10,.72); }
    .activity-control, .activity-select, .activity-search { height: 28px; border: 1px solid #3b452f; border-radius: 6px; background: #0c110d; color: var(--text); padding: 4px 8px; font: inherit; }
    .activity-control { cursor: pointer; }
    .activity-control.active { border-color: var(--amber); color: #fff1c2; background: rgba(217,154,61,.12); }
    .activity-search { min-width: 170px; flex: 1 1 180px; }
    .activity-list { display: grid; gap: 6px; max-height: 310px; overflow: auto; padding: 9px 10px; overscroll-behavior: contain; }
    .activity-list.compact .event { padding: 7px 9px; }
    .activity-list.compact .event code { display: none; }
    .activity-list .event { cursor: pointer; grid-template-columns: 94px minmax(0, 1fr) auto; gap: 8px; padding: 9px; }
    .activity-list .event h2 { margin: 0; font-size: 12px; }
    .activity-list .event .event-copy { color: var(--muted); font-size: 11px; }
    .activity-list .event.normal { border-color: rgba(124,198,106,.18); }
    .activity-list .event.warning { border-color: rgba(217,154,61,.52); }
    .activity-list .event.blocked, .activity-list .event.failed { border-color: rgba(223,107,85,.62); }
    .activity-empty { padding: 22px 10px; color: var(--muted); text-align: center; }
    .inspector-backdrop { position: fixed; inset: 0; z-index: 20; background: rgba(0,0,0,.54); display: none; }
    .inspector-backdrop.open { display: block; }
    .inspector { position: fixed; z-index: 21; top: 70px; right: 18px; width: min(430px, calc(100vw - 36px)); max-height: calc(100vh - 90px); overflow: auto; border: 1px solid #536247; border-radius: 8px; background: #10160f; box-shadow: 0 24px 60px rgba(0,0,0,.5); padding: 14px; }
    .inspector-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
    .inspector h2 { margin: 0; font-size: 16px; }
    .inspector-close { border: 1px solid var(--line); border-radius: 6px; background: transparent; color: var(--text); cursor: pointer; padding: 4px 8px; }
    .inspector-status { margin: 8px 0 12px; padding: 8px; border-radius: 6px; background: rgba(124,198,106,.08); color: var(--bone); font-size: 12px; }
    .inspector section { padding: 0; margin-top: 12px; }
    .inspector section h3 { margin: 0 0 6px; font-size: 12px; color: var(--amber); }
    .inspector code { display: block; white-space: pre-wrap; }
    .health-strip {
      display: grid;
      grid-template-columns: repeat(6, minmax(120px, 1fr));
      gap: 10px;
      padding: 12px 18px;
      border-bottom: 1px solid #243024;
      background:
        radial-gradient(circle at 20% 0%, rgba(124, 198, 106, .08), transparent 34%),
        linear-gradient(90deg, rgba(79, 182, 164, .04), rgba(217, 154, 61, .045)),
        #090d0a;
    }
    .chip {
      min-height: 58px;
      border: 1px solid #2d382d;
      border-radius: 8px;
      padding: 8px 10px;
      background:
        linear-gradient(180deg, rgba(238, 230, 210, .035), transparent),
        #10150f;
      overflow: hidden;
    }
    .chip strong {
      display: block;
      color: var(--text);
      font-size: 13px;
      line-height: 1.1;
      margin-bottom: 5px;
    }
    .chip span {
      display: block;
      color: var(--muted);
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .chip.healthy, .chip.ready, .chip.clean, .chip.grounded {
      border-color: rgba(124, 198, 106, .48);
      box-shadow: inset 0 0 0 1px rgba(124, 198, 106, .08);
    }
    .chip.warning, .chip.at_risk {
      border-color: rgba(217, 154, 61, .55);
      box-shadow: inset 0 0 0 1px rgba(217, 154, 61, .08);
    }
    .chip.degraded, .chip.index_error, .chip.missing, .chip.unknown {
      border-color: rgba(223, 107, 85, .55);
      box-shadow: inset 0 0 0 1px rgba(223, 107, 85, .08);
    }
    .dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--fern);
      display: inline-block;
      box-shadow: 0 0 16px rgba(124, 198, 106, .45);
    }
    .timeline {
      display: grid;
      gap: 10px;
    }
    .graph-panel {
      border: 1px solid #3b452f;
      border-radius: 8px;
      background:
        radial-gradient(circle at 64% 38%, rgba(79, 182, 164, .08), transparent 24%),
        radial-gradient(circle at 42% 52%, rgba(217, 154, 61, .105), transparent 26%),
        linear-gradient(180deg, rgba(217, 154, 61, .08), transparent 42%),
        var(--panel-2);
      overflow: hidden;
      margin-bottom: 18px;
      box-shadow:
        inset 0 1px 0 rgba(238, 230, 210, .06),
        0 14px 34px rgba(0, 0, 0, .22);
    }
    .graph-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 12px;
      border-bottom: 1px solid #35422d;
      background:
        linear-gradient(90deg, rgba(230, 220, 194, .05), rgba(217, 154, 61, .08) 45%, rgba(79, 182, 164, .04));
    }
    .graph-head h2 {
      margin: 0;
      font-size: 14px;
    }
    .graph-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .graph-legend {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .legend-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .legend-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      border: 1px solid rgba(238, 230, 210, .28);
      display: inline-block;
    }
    #graph-search, .graph-filter {
      width: min(220px, 34vw);
      min-width: 120px;
      height: 28px;
      border: 1px solid #3b452f;
      border-radius: 6px;
      background: #0c110d;
      color: var(--text);
      padding: 4px 8px;
      font: inherit;
    }
    .graph-filter { width: auto; min-width: 112px; }
    .graph-command {
      height: 28px;
      border: 1px solid #3b452f;
      border-radius: 6px;
      background: #111810;
      color: var(--text);
      padding: 4px 9px;
      font: inherit;
      cursor: pointer;
    }
    .graph-command:hover { border-color: #d7a84f; color: #fff1c2; }
    .graph-wrap {
      position: relative;
      height: clamp(560px, 66vh, 760px);
      min-height: 560px;
      overflow: hidden;
      isolation: isolate;
      background:
        radial-gradient(circle at 50% 48%, rgba(240, 168, 58, .06), transparent 24%),
        radial-gradient(circle at 72% 32%, rgba(79, 182, 164, .05), transparent 18%),
        radial-gradient(circle at 24% 38%, rgba(138, 199, 255, .04), transparent 16%),
        linear-gradient(0deg, rgba(230, 220, 194, .04) 1px, transparent 1px),
        linear-gradient(90deg, rgba(230, 220, 194, .025) 1px, transparent 1px),
        linear-gradient(180deg, #070b08 0%, #0d140e 48%, #070907 100%);
      background-size: auto, auto, auto, 44px 44px, 44px 44px, auto;
    }
    .graph-wrap::before {
      content: "";
      position: absolute;
      inset: 0;
      z-index: 0;
      pointer-events: none;
      background:
        radial-gradient(ellipse at 50% 48%, transparent 0 20%, rgba(255, 204, 102, .07) 20.2%, transparent 20.8%),
        radial-gradient(ellipse at 50% 48%, transparent 0 35%, rgba(79, 182, 164, .045) 35.2%, transparent 35.8%),
        radial-gradient(ellipse at 50% 48%, transparent 0 51%, rgba(238, 230, 210, .032) 51.2%, transparent 51.8%);
      opacity: .78;
    }
    .graph-wrap::after {
      content: "";
      position: absolute;
      inset: 0;
      z-index: 2;
      pointer-events: none;
      background:
        linear-gradient(90deg, rgba(7, 9, 7, .58), transparent 16%, transparent 84%, rgba(7, 9, 7, .58)),
        linear-gradient(180deg, rgba(7, 9, 7, .52), transparent 18%, transparent 76%, rgba(7, 9, 7, .58));
    }
    #wiki-graph {
      position: absolute;
      inset: 0;
      z-index: 1;
      display: block;
      width: 100%;
      height: 100%;
      background: transparent;
    }
    .graph-cluster-label {
      position: absolute;
      z-index: 3;
      pointer-events: none;
      color: rgba(238, 230, 210, .58);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: .08em;
      text-transform: uppercase;
      text-shadow: 0 1px 7px rgba(0, 0, 0, .85);
    }
    .graph-cluster-label.live { left: 48%; top: 41%; color: rgba(255, 204, 102, .72); }
    .graph-cluster-label.wiki { left: 30%; top: 18%; color: rgba(238, 230, 210, .62); }
    .graph-cluster-label.sources { left: 13%; top: 33%; color: rgba(243, 231, 199, .56); }
    .graph-cluster-label.projects { right: 25%; top: 20%; color: rgba(138, 199, 255, .6); }
    .graph-cluster-label.instances { right: 18%; bottom: 29%; color: rgba(243, 231, 199, .68); }
    .graph-cluster-label.context { right: 35%; bottom: 26%; color: rgba(138, 199, 255, .62); }
    .graph-cluster-label.operations { left: 38%; bottom: 22%; color: rgba(217, 154, 61, .62); }
    .graph-cluster-label.tags { left: 20%; bottom: 30%; color: rgba(124, 198, 106, .62); }
    #graph-focus {
      position: absolute;
      z-index: 4;
      left: 14px;
      right: auto;
      bottom: 12px;
      width: min(560px, calc(100% - 28px));
      pointer-events: none;
      color: #eee6d2;
      font-size: 12px;
      line-height: 1.45;
      overflow: hidden;
      white-space: normal;
      border: 1px solid rgba(238, 230, 210, .14);
      border-radius: 8px;
      background: rgba(8, 12, 9, .72);
      box-shadow: 0 12px 30px rgba(0, 0, 0, .28), inset 0 1px 0 rgba(238, 230, 210, .06);
      padding: 9px 10px;
      backdrop-filter: blur(9px);
      text-shadow: 0 1px 2px rgba(0, 0, 0, .75);
    }
    #graph-focus:empty {
      display: none;
    }
    #graph-focus strong {
      color: #fff1c2;
      font-size: 12px;
    }
    #graph-focus code {
      color: rgba(238, 230, 210, .72);
      word-break: break-all;
    }
    #graph-focus span {
      color: rgba(238, 230, 210, .58);
    }
    .event {
      display: grid;
      grid-template-columns: 116px minmax(0, 1fr);
      gap: 12px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background:
        linear-gradient(180deg, rgba(230, 220, 194, .025), transparent),
        var(--panel);
    }
    .event time {
      color: var(--muted);
      font-size: 12px;
      font-family: "Cascadia Mono", Consolas, monospace;
    }
    .event h2 {
      margin: 0 0 5px;
      font-size: 14px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 22px;
      padding: 2px 8px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--muted);
      font-size: 12px;
    }
    .task_started .badge { color: var(--fern); border-color: rgba(124, 198, 106, .45); }
    .context_pack_created .badge { color: var(--basalt); border-color: rgba(79, 182, 164, .45); }
    .task_finished .badge { color: var(--violet); border-color: rgba(185, 154, 105, .48); }
    .memory_use_audited .badge { color: var(--amber); border-color: rgba(217, 154, 61, .5); }
    .codex_preflight_failed .badge { color: var(--red); border-color: rgba(223, 107, 85, .48); }
    .details {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      padding-top: 0;
    }
    .block {
      border: 1px solid var(--line);
      border-radius: 8px;
      background:
        linear-gradient(180deg, rgba(238, 230, 210, .025), transparent),
        var(--panel);
      padding: 12px;
      min-width: 0;
    }
    .block h2 {
      margin: 0 0 10px;
      font-size: 14px;
    }
    .kv {
      display: grid;
      grid-template-columns: 96px minmax(0, 1fr);
      gap: 6px 10px;
      margin-top: 8px;
    }
    .kv span {
      color: var(--muted);
      font-size: 12px;
    }
    .sync-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 12px; }
    .sync-actions button { height: 30px; border: 1px solid #536247; border-radius: 6px; background: #111810; color: var(--text); padding: 4px 10px; font: inherit; cursor: pointer; }
    .sync-actions button:hover, .sync-actions button:focus-visible { border-color: var(--amber); outline: none; }
    .sync-actions button:disabled { cursor: wait; opacity: .55; }
    .sync-toggle { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); font-size: 12px; }
    .sync-notice { min-height: 18px; margin: 8px 0 0; color: var(--muted); font-size: 12px; }
    .list {
      display: grid;
      gap: 7px;
    }
    .item {
      border-top: 1px solid var(--line);
      padding-top: 8px;
    }
    .item:first-child {
      border-top: 0;
      padding-top: 0;
    }
    @media (max-width: 900px) {
      main { grid-template-columns: 1fr; }
      .health-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .event { grid-template-columns: 1fr; }
      header { align-items: flex-start; flex-direction: column; }
      .toolbar { white-space: normal; }
      .graph-head { align-items: flex-start; flex-direction: column; }
      .graph-meta { align-items: flex-start; flex-direction: column; white-space: normal; width: 100%; }
      .graph-legend { flex-wrap: wrap; }
      #graph-search, .graph-filter { width: 100%; }
      .graph-wrap { height: clamp(420px, 62vh, 580px); min-height: 420px; }
      .details { grid-template-columns: 1fr; }
      .shell-intro { grid-template-columns: 1fr; }
      .connection-state { text-align: left; }
      .activity-list { max-height: 300px; }
      .inspector { top: auto; right: 10px; bottom: 10px; left: 10px; width: auto; max-height: min(64vh, 520px); }
    }
  </style>
</head>
<body>
  <header>
    <h1>DinoBrain Observatory</h1>
    <div class="toolbar"><span class="dot"></span><span id="status">connecting</span><code id="root"></code></div>
  </header>
  <nav class="health-strip" aria-label="DinoBrain OS health">
    <div id="chip-active" class="chip" role="button" tabindex="0" aria-label="현재 작업 상세"><strong>Active</strong><span>--</span></div>
    <div id="chip-readiness" class="chip" role="button" tabindex="0" aria-label="준비 상태 상세"><strong>Readiness</strong><span>--</span></div>
    <div id="chip-v2" class="chip" role="button" tabindex="0" aria-label="OS v2 상세"><strong>OS v2</strong><span>--</span></div>
    <div id="chip-mcp" class="chip" role="button" tabindex="0" aria-label="MCP 상세"><strong>MCP</strong><span>--</span></div>
    <div id="chip-read" class="chip" role="button" tabindex="0" aria-label="읽기 추적 상세"><strong>Read</strong><span>--</span></div>
    <div id="chip-lifecycle" class="chip" role="button" tabindex="0" aria-label="노드 수명주기 상세"><strong>Nodes</strong><span>--</span></div>
    <div id="chip-source" class="chip" role="button" tabindex="0" aria-label="출처 계보 상세"><strong>Sources</strong><span>--</span></div>
    <div id="chip-recall" class="chip" role="button" tabindex="0" aria-label="행동 회상 상세"><strong>Recall</strong><span>--</span></div>
    <div id="chip-compounding" class="chip" role="button" tabindex="0" aria-label="통제된 누적 상세"><strong>Compound</strong><span>--</span></div>
    <div id="chip-graph" class="chip" role="button" tabindex="0" aria-label="그래프 상태 상세"><strong>Graph</strong><span>--</span></div>
    <div id="chip-sync" class="chip" role="button" tabindex="0" aria-label="동기화 상태 상세"><strong>Sync</strong><span>--</span></div>
  </nav>
  <main>
    <section>
      <div class="shell-intro" id="overview-surface" data-surface-target="overview" tabindex="-1">
        <div><h2>현재 OS 상태</h2><p id="overview-summary">로컬 상태를 불러오는 중입니다.</p></div>
        <div class="connection-state"><strong id="connection-label">연결 중</strong><span id="connection-detail">로컬 Observatory에 연결하고 있습니다.</span></div>
      </div>
      <nav class="surface-nav" aria-label="DinoBrain surfaces">
        <button type="button" data-surface-nav="overview" data-surface-target="overview-surface">Overview</button>
        <button type="button" data-surface-nav="activity" data-surface-target="activity-surface">Activity</button>
        <button type="button" data-surface-nav="knowledge" data-surface-target="knowledge-surface">Knowledge</button>
        <button type="button" data-surface-nav="settings" data-surface-target="settings-surface">Settings</button>
      </nav>
      <div class="stats">
        <div class="stat"><strong id="stat-events">0</strong><span>events</span></div>
        <div class="stat"><strong id="stat-tasks">0</strong><span>tasks</span></div>
        <div class="stat"><strong id="stat-packs">0</strong><span>context packs</span></div>
        <div class="stat"><strong id="stat-audits">0</strong><span>memory audits</span></div>
        <div class="stat"><strong id="stat-active">0</strong><span>active tasks</span></div>
      </div>
      <div class="activity-panel" id="activity-surface" data-surface-target="activity" tabindex="-1" aria-labelledby="activity-title">
        <div class="activity-head"><h2 id="activity-title">Activity <span class="activity-meta" id="activity-count">0개</span></h2><span class="activity-meta" id="activity-last-update">업데이트 대기 중</span></div>
        <div class="activity-controls" role="toolbar" aria-label="Activity controls">
          <button type="button" class="activity-control active" data-activity-filter="all">All</button><button type="button" class="activity-control" data-activity-filter="task">Task</button><button type="button" class="activity-control" data-activity-filter="hook">Hook</button><button type="button" class="activity-control" data-activity-filter="memory">Memory</button><button type="button" class="activity-control" data-activity-filter="sync">Sync</button><button type="button" class="activity-control" data-activity-filter="attention">Warning/Error</button>
          <input class="activity-search" id="activity-search" type="search" placeholder="활동 검색" aria-label="활동 검색">
          <button type="button" class="activity-control" id="activity-pause">Pause</button><button type="button" class="activity-control active" id="activity-follow">Follow tail</button><button type="button" class="activity-control" id="activity-mode">Expanded</button><button type="button" class="activity-control" id="activity-copy-visible">Copy visible</button><button type="button" class="activity-control" id="activity-clear">Clear view</button>
        </div>
        <div id="activity-list" class="activity-list" aria-live="polite"><div class="activity-empty">활동을 불러오는 중입니다…</div></div>
      </div>
      <div class="graph-panel" id="knowledge-surface" data-surface-target="knowledge" tabindex="-1">
        <div class="graph-head">
          <h2>Knowledge Graph</h2>
          <span class="muted">기억에서 작업까지 이어진 근거 관계</span>
        </div>
        <div id="observatory-graph-host" aria-label="DinoBrain knowledge graph"></div>
      </div>
      <div id="timeline" class="timeline"></div>
    </section>
    <section class="details" id="settings-surface" data-surface-target="settings" tabindex="-1">
      <div class="block">
        <h2>Completion Readiness</h2>
        <div id="readiness-summary" class="kv"></div>
        <div id="readiness-blockers" class="list"></div>
      </div>
      <div class="block">
        <h2>Pending Lanes</h2>
        <div id="readiness-pending" class="list"></div>
      </div>
      <div class="block">
        <h2>OS Health</h2>
        <div id="os-health" class="kv"></div>
      </div>
      <div class="block">
        <h2>OS v2 Gates</h2>
        <div id="os-v2" class="kv"></div>
      </div>
      <div class="block">
        <h2>Read Trace</h2>
        <div id="read-trace" class="kv"></div>
        <div id="read-trace-items" class="list"></div>
      </div>
      <div class="block">
        <h2>Node Lifecycle</h2>
        <div id="node-lifecycle" class="kv"></div>
        <div id="lifecycle-retry" class="list"></div>
      </div>
      <div class="block">
        <h2>Source Lineage</h2>
        <div id="source-lineage" class="kv"></div>
        <div id="source-lineage-findings" class="list"></div>
      </div>
      <div class="block">
        <h2>Behavior Recall</h2>
        <div id="behavior-recall" class="kv"></div>
        <div id="behavior-recall-findings" class="list"></div>
      </div>
      <div class="block">
        <h2>Controlled Compounding</h2>
        <div id="controlled-compounding" class="kv"></div>
      </div>
      <div class="block">
        <h2>Sync Risk</h2>
        <div id="sync-risk" class="kv"></div>
      </div>
      <div class="block">
        <h2>Bounded GitHub Sync</h2>
        <div id="sync-scheduler" class="kv"></div>
        <div id="sync-queue" class="list"></div>
        <div class="sync-actions">
          <button id="sync-now" type="button">Sync now</button>
          <label class="sync-toggle"><input id="sync-automatic" type="checkbox"> Automatic sync</label>
        </div>
        <p id="sync-action-status" class="sync-notice" aria-live="polite"></p>
      </div>
      <div class="block">
        <h2>Latest Task</h2>
        <div id="latest-task" class="kv"></div>
      </div>
      <div class="block">
        <h2>Active Tasks</h2>
        <div id="active-tasks" class="list"></div>
      </div>
      <div class="block">
        <h2>Latest Context Pack</h2>
        <div id="latest-pack" class="list"></div>
      </div>
      <div class="block">
        <h2>Latest Trace</h2>
        <div id="latest-trace" class="kv"></div>
      </div>
      <div class="block">
        <h2>Latest Memory Audit</h2>
        <div id="latest-audit" class="kv"></div>
        <div id="readiness-audit-paths" class="list"></div>
      </div>
    </section>
  </main>
  <div id="inspector-backdrop" class="inspector-backdrop" aria-hidden="true"></div>
  <aside id="inspector" class="inspector" role="dialog" aria-modal="true" aria-labelledby="inspector-title" hidden>
    <div class="inspector-head"><div><h2 id="inspector-title">상세 정보</h2><div id="inspector-subtitle" class="muted"></div></div><button id="inspector-close" class="inspector-close" type="button" aria-label="상세 닫기">닫기</button></div>
    <div id="inspector-status" class="inspector-status"></div>
    <section><h3>현재 값</h3><div id="inspector-values" class="kv"></div></section>
    <section><h3>왜 이렇게 표시되나요?</h3><p id="inspector-reason" class="muted"></p></section>
    <section><h3>근거 경로 / 관련 이벤트</h3><div id="inspector-evidence" class="list"></div></section>
    <section><h3>다음 행동</h3><p id="inspector-next" class="muted"></p></section>
  </aside>
  <script>
    const statusEl = document.getElementById("status");
    const rootEl = document.getElementById("root");
    const timelineEl = document.getElementById("timeline");
    const latestTaskEl = document.getElementById("latest-task");
    const activeTasksEl = document.getElementById("active-tasks");
    const latestPackEl = document.getElementById("latest-pack");
    const latestTraceEl = document.getElementById("latest-trace");
    const latestAuditEl = document.getElementById("latest-audit");
    const readinessSummaryEl = document.getElementById("readiness-summary");
    const readinessBlockersEl = document.getElementById("readiness-blockers");
    const readinessPendingEl = document.getElementById("readiness-pending");
    const readinessAuditPathsEl = document.getElementById("readiness-audit-paths");
    const osHealthEl = document.getElementById("os-health");
    const readTraceEl = document.getElementById("read-trace");
    const readTraceItemsEl = document.getElementById("read-trace-items");
    const nodeLifecycleEl = document.getElementById("node-lifecycle");
    const lifecycleRetryEl = document.getElementById("lifecycle-retry");
    const sourceLineageEl = document.getElementById("source-lineage");
    const sourceLineageFindingsEl = document.getElementById("source-lineage-findings");
    const behaviorRecallEl = document.getElementById("behavior-recall");
    const behaviorRecallFindingsEl = document.getElementById("behavior-recall-findings");
    const controlledCompoundingEl = document.getElementById("controlled-compounding");
    const syncRiskEl = document.getElementById("sync-risk");
    const syncSchedulerEl = document.getElementById("sync-scheduler");
    const syncQueueEl = document.getElementById("sync-queue");
    const syncNowEl = document.getElementById("sync-now");
    const syncAutomaticEl = document.getElementById("sync-automatic");
    const syncActionStatusEl = document.getElementById("sync-action-status");
    const osV2El = document.getElementById("os-v2");
    const chips = {
      active: document.getElementById("chip-active"),
      readiness: document.getElementById("chip-readiness"),
      v2: document.getElementById("chip-v2"),
      mcp: document.getElementById("chip-mcp"),
      read: document.getElementById("chip-read"),
      lifecycle: document.getElementById("chip-lifecycle"),
      source: document.getElementById("chip-source"),
      recall: document.getElementById("chip-recall"),
      compounding: document.getElementById("chip-compounding"),
      graph: document.getElementById("chip-graph"),
      sync: document.getElementById("chip-sync"),
    };
    const activityListEl = document.getElementById("activity-list");
    const activityCountEl = document.getElementById("activity-count");
    const activityLastUpdateEl = document.getElementById("activity-last-update");
    const activitySearchEl = document.getElementById("activity-search");
    const connectionLabelEl = document.getElementById("connection-label");
    const connectionDetailEl = document.getElementById("connection-detail");
    const overviewSummaryEl = document.getElementById("overview-summary");
    const inspectorEl = document.getElementById("inspector");
    const inspectorBackdropEl = document.getElementById("inspector-backdrop");
    const inspectorTitleEl = document.getElementById("inspector-title");
    const inspectorSubtitleEl = document.getElementById("inspector-subtitle");
    const inspectorStatusEl = document.getElementById("inspector-status");
    const inspectorValuesEl = document.getElementById("inspector-values");
    const inspectorReasonEl = document.getElementById("inspector-reason");
    const inspectorEvidenceEl = document.getElementById("inspector-evidence");
    const inspectorNextEl = document.getElementById("inspector-next");
    let latestState = null;
    let activityEvents = [];
    let activityFilter = "all";
    let activityPaused = false;
    let activityFollowing = true;
    let activityExpanded = true;
    let activityClearedAt = 0;
    let activitySignature = "";
    let lastInvoker = null;
    const legacyGraphEnabled = false;
    const graphCanvas = document.getElementById("wiki-graph");
    const graphCtx = graphCanvas?.getContext("2d") ?? null;
    const graphStatsEl = document.getElementById("graph-stats");
    const graphFocusEl = document.getElementById("graph-focus");
    const graphSearchEl = document.getElementById("graph-search");
    const graphLaneEl = document.getElementById("graph-lane");
    const graphRelationEl = document.getElementById("graph-relation");
    const graphLifecycleEl = document.getElementById("graph-lifecycle");
    const graphProvenanceEl = document.getElementById("graph-provenance");
    const graphTraceEl = document.getElementById("graph-trace");
    const graphResetEl = document.getElementById("graph-reset");
    let graphNodes = [];
    let graphEdges = [];
    let graphSignature = "";
    let graphMouse = { x: -9999, y: -9999 };
    let graphSearch = "";
    let graphSelected = null;
    let graphViewCustom = false;
    let graphFetchInFlight = false;
    const formatTime = (value) => value ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "--";
    const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    const compact = (value, max = 180) => {
      const text = String(value ?? "").replace(/\\s+/g, " ").trim();
      return text.length > max ? text.slice(0, max - 3) + "..." : text;
    };
    const chipPlain = {
      active: { title: "현재 작업", why: "실행 중인 task가 있으면 작업 루프가 열려 있는 상태입니다.", next: "작업이 끝날 때까지 Activity에서 진행 상황을 확인하세요." },
      readiness: { title: "준비 상태", why: "완료 조건과 차단 항목을 합쳐 현재 준비 수준을 계산합니다.", next: "차단 항목이 있으면 해당 근거 경로를 먼저 검토하세요." },
      v2: { title: "OS v2", why: "OS v2 게이트와 행동 평가의 최신 결과를 보여줍니다.", next: "게이트가 차단이면 Context Pack과 gate report를 확인하세요." },
      mcp: { title: "MCP 관찰", why: "최근 관찰된 이벤트 수로 로컬 연결이 활동 중인지 표시합니다.", next: "연결이 끊겼다면 잠시 기다리거나 Observatory 서버 상태를 확인하세요." },
      read: { title: "읽기 추적", why: "최근 Context Pack과 trace에서 실제로 사용된 기억을 요약합니다.", next: "사용된 기억이 없으면 다음 task의 Context Pack 생성을 확인하세요." },
      lifecycle: { title: "노드 수명주기", why: "accepted/review/cold 노드와 lifecycle blocker를 집계합니다.", next: "보류 항목은 승인 전까지 자동으로 사용되지 않습니다." },
      source: { title: "출처 계보", why: "검증된 source chunk와 연결된 claim의 상태를 집계합니다.", next: "blocker가 있으면 표시된 source 경로를 검토하세요." },
      recall: { title: "행동 회상", why: "과거 행동 증거가 현재 회상 파이프라인에 연결됐는지 보여줍니다.", next: "오류가 있으면 recall finding의 근거 파일을 확인하세요." },
      compounding: { title: "통제된 누적", why: "검토를 통과한 규칙만 누적·검색되는지 표시합니다.", next: "proposal은 독립 검토 전까지 적용하지 마세요." },
      graph: { title: "Knowledge Graph", why: "기억·근거 연결 그래프의 인덱스 상태와 크기를 표시합니다.", next: "그래프가 비어 있으면 Graph 화면의 근거 상태와 index 경로를 확인하세요." },
      sync: { title: "GitHub 동기화", why: "현재 작업 트리의 dirty/untracked 위험을 읽기 전용으로 보여줍니다.", next: "자동 push 대신 task-scoped 안전 sync 정책을 확인하세요." },
    };
    const pathValues = (value) => {
      const paths = [];
      const walk = (item, key = "") => {
        if (!item || paths.length >= 8) return;
        if (typeof item === "string" && (key.toLowerCase().includes("path") || item.includes(".dino/") || item.includes("reports/"))) paths.push(item);
        else if (Array.isArray(item)) item.forEach((child) => walk(child, key));
        else if (typeof item === "object") Object.entries(item).forEach(([childKey, child]) => walk(child, childKey));
      };
      walk(value);
      return [...new Set(paths)];
    };
    function flattenScalars(value, prefix = "", rows = [], depth = 0) {
      if (rows.length >= 30 || depth > 4) return rows;
      if (value === null || value === undefined || value === "") {
        if (prefix) rows.push([prefix, "없음"]);
        return rows;
      }
      if (typeof value !== "object") {
        rows.push([prefix || "값", compact(value, 220)]);
        return rows;
      }
      const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value);
      if (!entries.length && prefix) rows.push([prefix, "값 없음"]);
      for (const [key, child] of entries) {
        if (rows.length >= 30) break;
        flattenScalars(child, prefix ? prefix + "." + key : key, rows, depth + 1);
      }
      return rows;
    }
    function eventSeverity(event) {
      const explicitKeys = ["status", "outcome", "action_decision", "event", "severity", "level", "result"];
      const explicit = explicitKeys.map((key) => event?.[key]).filter((value) => value !== undefined && value !== null).map((value) => String(value).toLowerCase()).join(" ");
      const text = explicit || "";
      if (/(blocked|block|quarantine)/.test(text)) return "blocked";
      if (/(failed|failure|error|denied)/.test(text)) return "failed";
      if (/(warning|warn|pending|degraded|at_risk)/.test(text)) return "warning";
      if (explicit) return "normal";
      const fallback = JSON.stringify(event).toLowerCase();
      if (/(blocked|block|quarantine)/.test(fallback) && !/blocked"\s*:\s*false/.test(fallback)) return "blocked";
      if (/(failed|failure|error|denied)/.test(fallback)) return "failed";
      if (/(warning|warn|pending|degraded|at_risk)/.test(fallback)) return "warning";
      return "normal";
    }
    function eventCategory(event) {
      const name = String(event?.event ?? "").toLowerCase();
      if (name.includes("sync")) return "sync";
      if (name.includes("memory") || name.includes("context_pack") || name.includes("trace")) return "memory";
      if (name.includes("hook") || name.includes("preflight") || name.includes("codex")) return "hook";
      if (name.includes("task")) return "task";
      return eventSeverity(event) === "normal" ? "other" : "attention";
    }
    function openInspector(kind, value, invoker = null) {
      const definition = chipPlain[kind] || { title: "Activity 이벤트", why: "구조화된 로컬 이벤트의 상세 정보입니다.", next: "추가 조치가 필요하면 원본 근거를 확인하세요." };
      lastInvoker = invoker || document.activeElement;
      inspectorTitleEl.textContent = definition.title;
      inspectorSubtitleEl.textContent = kind === "event" ? eventTitle(value) : "공유 상태 inspector";
      const status = kind === "event" ? eventSeverity(value) : (value?.status || value?.operational_status || "unknown");
      inspectorStatusEl.textContent = kind === "event" ? (status === "normal" ? "정상 이벤트" : status === "warning" ? "주의 이벤트" : status === "blocked" ? "차단 이벤트" : "실패 이벤트") + " · " + formatTime(value?.at) : "현재 상태: " + String(status);
      const rows = kind === "event"
        ? [["event", eventTitle(value)], ["time", value?.at], ["source", value?._path], ["detail", eventDetail(value)]]
        : flattenScalars(value);
      kv(inspectorValuesEl, rows.length ? rows : [["상태", "값 없음"]]);
      inspectorReasonEl.textContent = definition.why + (kind === "event" ? " 이벤트 종류는 " + eventCategory(value) + "로 분류했습니다." : "");
      const evidence = kind === "event" ? pathValues(value) : pathValues(value);
      inspectorEvidenceEl.innerHTML = evidence.length ? evidence.map((item) => "<div class=\\\"item\\\"><code>" + esc(item) + "</code></div>").join("") : '<p class="muted">표시할 근거 경로가 없습니다.</p>';
      inspectorNextEl.textContent = definition.next;
      inspectorEl.hidden = false;
      inspectorBackdropEl.classList.add("open");
      inspectorBackdropEl.setAttribute("aria-hidden", "false");
      window.setTimeout(() => document.getElementById("inspector-close")?.focus(), 0);
    }
    function closeInspector() {
      inspectorEl.hidden = true;
      inspectorBackdropEl.classList.remove("open");
      inspectorBackdropEl.setAttribute("aria-hidden", "true");
      if (lastInvoker && typeof lastInvoker.focus === "function") lastInvoker.focus();
    }
    const chipData = {
      active: () => latestState?.tasks?.find((item) => item.status === "started") || latestState?.summary || {},
      readiness: () => latestState?.readiness || latestState?.summary || {},
      v2: () => latestState?.os_v2 || {},
      mcp: () => ({ summary: latestState?.summary, events: latestState?.events?.slice(0, 5) }),
      read: () => latestState?.read_trace || {},
      lifecycle: () => latestState?.lifecycle || {},
      source: () => latestState?.source_lineage || {},
      recall: () => ({ ...(latestState?.behavior_recall_migration || {}), current: latestState?.behavior_recall || {} }),
      compounding: () => latestState?.controlled_compounding || {},
      graph: () => latestState?.graph_health || {},
      sync: () => ({ scheduler: latestState?.sync_scheduler || {}, repository: latestState?.sync_risk || {} }),
    };
    Object.entries(chips).forEach(([kind, chip]) => {
      chip.addEventListener("click", () => openInspector(kind, chipData[kind](), chip));
      chip.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openInspector(kind, chipData[kind](), chip); } });
    });
    document.getElementById("inspector-close").addEventListener("click", closeInspector);
    inspectorBackdropEl.addEventListener("click", closeInspector);
    window.addEventListener("keydown", (event) => { if (event.key === "Escape" && !inspectorEl.hidden) closeInspector(); });
    window.addEventListener("dinobrain-graph-inspect", (event) => {
      openInspector("graph", event.detail || {}, document.getElementById("knowledge-surface"));
    });
    document.querySelectorAll("[data-surface-nav]").forEach((button) => button.addEventListener("click", () => {
      const target = document.getElementById(button.dataset.surfaceTarget);
      if (!target) return;
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      window.setTimeout(() => target.focus({ preventScroll: true }), 260);
    }));
    function activityKey(event) { return String(event?.event_key || event?._path || "") + "|" + String(event?.at || "") + "|" + String(event?.event || ""); }
    function getVisibleActivity() {
      const query = String(activitySearchEl.value || "").trim().toLowerCase();
      return activityEvents.filter((event) => {
        if (activityClearedAt && Date.parse(event.at || "") <= activityClearedAt) return false;
        const category = eventCategory(event);
        if (activityFilter === "attention" && !["warning", "blocked", "failed"].includes(eventSeverity(event))) return false;
        if (activityFilter !== "all" && activityFilter !== "attention" && category !== activityFilter) return false;
        return !query || JSON.stringify(event).toLowerCase().includes(query);
      }).slice(-500);
    }
    function renderActivity() {
      const visible = getVisibleActivity();
      activityCountEl.textContent = visible.length + "개 / 최대 500개";
      activityListEl.classList.toggle("compact", !activityExpanded);
      activityListEl.innerHTML = visible.length ? visible.map((event) => {
        const severity = eventSeverity(event);
        return "<article class=\\\"event " + severity + "\\\" tabindex=\\\"0\\\" data-activity-key=\\\"" + esc(activityKey(event)) + "\\\"><time>" + esc(formatTime(event.at)) + "</time><div><h2><span class=\\\"badge\\\">" + esc(eventTitle(event)) + "</span></h2><div class=\\\"event-copy\\\">" + esc(compact(eventDetail(event), 220)) + "</div></div><button type=\\\"button\\\" class=\\\"activity-control\\\" data-copy-event=\\\"" + esc(activityKey(event)) + "\\\">Copy</button></article>";
      }).join("") : '<div class="activity-empty">' + (activityPaused ? "일시정지 중입니다. Resume을 누르면 새 활동을 확인합니다." : "표시할 활동이 없습니다. 필터를 바꾸거나 잠시 기다려 주세요.") + "</div>";
      activityListEl.querySelectorAll("[data-activity-key]").forEach((row) => {
        const event = visible.find((item) => activityKey(item) === row.dataset.activityKey);
        row.addEventListener("click", (clickEvent) => { if (clickEvent.target.closest("button")) return; openInspector("event", event, row); });
        row.addEventListener("keydown", (keyEvent) => { if ((keyEvent.key === "Enter" || keyEvent.key === " ") && !keyEvent.target.closest("button")) { keyEvent.preventDefault(); openInspector("event", event, row); } });
      });
      activityListEl.querySelectorAll("[data-copy-event]").forEach((button) => button.addEventListener("click", async (event) => {
        event.stopPropagation();
        const item = activityEvents.find((candidate) => activityKey(candidate) === button.dataset.copyEvent);
        try { await navigator.clipboard.writeText(JSON.stringify(item)); button.textContent = "Copied"; window.setTimeout(() => { button.textContent = "Copy"; }, 900); } catch { button.textContent = "Copy unavailable"; }
      }));
      if (activityFollowing) activityListEl.scrollTop = activityListEl.scrollHeight;
    }
    function mergeActivity(events) {
      const byKey = new Map(activityEvents.map((event) => [activityKey(event), event]));
      (Array.isArray(events) ? events : []).forEach((event) => byKey.set(activityKey(event), event));
      activityEvents = [...byKey.values()].sort((a, b) => String(a.at || "").localeCompare(String(b.at || ""))).slice(-500);
      const nextSignature = activityEvents.map((event) => activityKey(event) + ":" + JSON.stringify(event)).join("\u001f");
      if (nextSignature === activitySignature) return;
      activitySignature = nextSignature;
      renderActivity();
    }
    async function tickActivity() {
      if (!activityPaused) {
        try {
          const response = await fetch("/api/activity?limit=500", { cache: "no-store" });
          if (!response.ok) throw new Error("activity request failed");
          const payload = await response.json();
          mergeActivity(payload.events);
          activityLastUpdateEl.textContent = "마지막 업데이트 " + formatTime(payload.generated_at);
        } catch {
          activityLastUpdateEl.textContent = "재연결 대기 중";
        }
      }
      window.setTimeout(tickActivity, 1500);
    }
    document.querySelectorAll("[data-activity-filter]").forEach((button) => button.addEventListener("click", () => {
      document.querySelectorAll("[data-activity-filter]").forEach((item) => item.classList.toggle("active", item === button));
      activityFilter = button.dataset.activityFilter;
      renderActivity();
    }));
    activitySearchEl.addEventListener("input", renderActivity);
    document.getElementById("activity-pause").addEventListener("click", (event) => { activityPaused = !activityPaused; event.currentTarget.textContent = activityPaused ? "Resume" : "Pause"; event.currentTarget.classList.toggle("active", activityPaused); renderActivity(); });
    document.getElementById("activity-follow").addEventListener("click", (event) => { activityFollowing = !activityFollowing; event.currentTarget.classList.toggle("active", activityFollowing); });
    document.getElementById("activity-mode").addEventListener("click", (event) => { activityExpanded = !activityExpanded; event.currentTarget.textContent = activityExpanded ? "Compact" : "Expanded"; renderActivity(); });
    document.getElementById("activity-clear").addEventListener("click", () => { activityClearedAt = Date.now(); renderActivity(); });
    document.getElementById("activity-copy-visible").addEventListener("click", async (event) => { try { await navigator.clipboard.writeText(JSON.stringify(getVisibleActivity())); event.currentTarget.textContent = "Copied"; window.setTimeout(() => { event.currentTarget.textContent = "Copy visible"; }, 900); } catch { event.currentTarget.textContent = "Copy unavailable"; } });
    syncNowEl.addEventListener("click", async () => {
      if (currentLocalOnly?.enabled) {
        syncActionStatusEl.textContent = "Local-only 모드에서는 원격 push가 차단됩니다.";
        return;
      }
      syncNowEl.disabled = true;
      syncActionStatusEl.textContent = "검증된 task 범위에서 동기화를 확인하고 있습니다.";
      try {
        const response = await fetch("/api/sync/run", { method: "POST", headers: { "x-dinobrain-action": "observatory" }, cache: "no-store" });
        const payload = await response.json();
        if (!response.ok || payload.ok === false) throw new Error(payload.error || "sync request failed");
        const reasons = Array.isArray(payload.reason_codes) ? payload.reason_codes.join(", ") : "";
        syncActionStatusEl.textContent = payload.executed
          ? "동기화 결과: " + String(payload.outcome || "완료")
          : "실행하지 않음: " + (reasons || "안전한 대기 파일이 없습니다.");
        await tick();
      } catch (error) {
        syncActionStatusEl.textContent = "동기화 실패: " + compact(error?.message || error, 160);
      } finally {
        syncNowEl.disabled = false;
      }
    });
    syncAutomaticEl.addEventListener("change", async () => {
      const requested = syncAutomaticEl.checked;
      if (currentLocalOnly?.enabled) {
        syncAutomaticEl.checked = false;
        syncActionStatusEl.textContent = "Local-only 모드에서는 자동 원격 동기화를 켤 수 없습니다.";
        return;
      }
      syncAutomaticEl.disabled = true;
      syncActionStatusEl.textContent = requested ? "자동 동기화를 켜는 중입니다." : "자동 동기화를 끄는 중입니다.";
      try {
        const response = await fetch("/api/sync/automatic", {
          method: "POST",
          headers: { "content-type": "application/json", "x-dinobrain-action": "observatory" },
          body: JSON.stringify({ enabled: requested }),
        });
        const payload = await response.json();
        if (!response.ok || payload.ok === false) throw new Error(payload.error || "sync setting failed");
        syncActionStatusEl.textContent = requested
          ? "자동 동기화가 켜졌습니다. 6시간 병합과 10분 유휴 조건을 지킵니다."
          : "자동 동기화가 꺼졌습니다. 로컬 기록과 수동 Sync now는 유지됩니다.";
        await tick();
      } catch (error) {
        syncAutomaticEl.checked = !requested;
        syncActionStatusEl.textContent = "설정 변경 실패: " + compact(error?.message || error, 160);
      } finally {
        syncAutomaticEl.disabled = false;
      }
    });
    renderActivity();
    tickActivity();
    function kv(target, rows) {
      target.innerHTML = rows.map(([key, value]) => \`<span>\${esc(key)}</span><code>\${esc(value ?? "--")}</code>\`).join("");
    }
    function renderChip(target, label, value, detail, tone) {
      target.className = "chip " + String(tone || "").replace(/[^a-z0-9_-]/gi, "");
      target.innerHTML = \`<strong>\${esc(label)} \${esc(value ?? "")}</strong><span>\${esc(detail ?? "")}</span>\`;
    }
    function renderLaneItems(items) {
      return Array.isArray(items) && items.length
        ? items.map((item) => \`
          <div class="item"><code>\${esc(item.id || item.label || "")}</code><div class="muted">\${esc(compact((item.status || "") + " / " + (item.reason || item.blocker_reason || item.reason_codes?.[0] || ""), 180))}</div><code>\${esc(item.path || item.proof_path || item.proof_paths?.[0] || item.artifact_path || "")}</code><div class="muted">\${esc(item.next_safe_action || "")}</div></div>
        \`).join("")
        : '<p class="muted">No items.</p>';
    }
    function healthTone(value) {
      const status = String(value ?? "").toLowerCase();
      if (["healthy", "ready", "clean", "grounded", "pass"].includes(status)) return status === "pass" ? "ready" : status;
      if (["warning", "warn", "at_risk", "pending"].includes(status)) return status === "warn" ? "warning" : status;
      if (["degraded", "index_error", "missing", "unknown", "block", "blocked"].includes(status)) {
        return status === "block" || status === "blocked" ? "degraded" : status;
      }
      return "unknown";
    }
    function eventTitle(event) {
      return String(event.event || "event").replaceAll("_", " ");
    }
    function eventDetail(event) {
      return event.prompt_preview || event.audit_id || event.task_id || event.pack_id || event.trace_path || event.context_pack_trace || event.path || event.error || "";
    }
    function renderReadiness(readiness) {
      latestState = { ...(latestState || {}), readiness };
      renderChip(
        chips.readiness,
        "Ready",
        readiness.status || "--",
        (readiness.counts?.blockers ?? 0) + " blockers / " + (readiness.counts?.verifier_pending ?? 0) + " verifier",
        readiness.ok ? "healthy" : "warning",
      );
      kv(readinessSummaryEl, [
        ["status", readiness.status],
        ["operational", readiness.operational_status],
        ["parity", readiness.parity_hash],
        ["generation", readiness.status_generation?.generation_id],
        ["generation health", readiness.status_generation?.status],
        ["generation freshness", readiness.status_generation?.freshness],
        ["completion audit", readiness.completion_audit?.status],
        ["blockers", readiness.counts?.blockers],
        ["reviewer pending", readiness.counts?.reviewer_pending],
        ["main pending", readiness.counts?.main_pending],
        ["verifier pending", readiness.counts?.verifier_pending],
        ["health", readiness.health_status?.status],
        ["direct MCP", readiness.client_mcp_direct_status?.status],
        ["RAG provider", readiness.rag_status?.provider],
        ["semantic", readiness.rag_status?.semantic_embedding_provider],
        ["RAG blocker", readiness.rag_status?.blocker],
        ["vector migration", readiness.vector_index_migration_status?.status],
        ["vector migration id", readiness.vector_index_migration_status?.migration_id],
        ["live semantic query", readiness.live_semantic_query_status?.status],
        ["live query blocker", readiness.live_semantic_query_status?.blocker],
        ["answer quality", readiness.answer_quality_status?.status],
        ["answer quality blocker", readiness.answer_quality_status?.blocker],
        ["release manifest", readiness.release_manifest_status?.status],
        ["release tag", readiness.release_manifest_status?.expected_tag],
      ]);
      readinessBlockersEl.innerHTML = renderLaneItems(readiness.lanes?.blockers);
      readinessPendingEl.innerHTML = [
        ...(readiness.lanes?.reviewer_pending || []).map((item) => ({ ...item, id: "reviewer:" + item.id })),
        ...(readiness.lanes?.main_pending || []).map((item) => ({ ...item, id: "main:" + item.id })),
        ...(readiness.lanes?.verifier_pending || []).map((item) => ({ ...item, id: "verifier:" + item.id })),
      ].map((item) => \`
        <div class="item"><code>\${esc(item.id)}</code><div class="muted">\${esc(compact((item.status || "") + " / " + (item.reason || ""), 180))}</div><code>\${esc(item.path || "")}</code><div class="muted">\${esc(item.next_safe_action || "")}</div></div>
      \`).join("") || '<p class="muted">No pending lanes.</p>';
      const audit = readiness.latest_audit;
      readinessAuditPathsEl.innerHTML = audit ? [
        ["provided", audit.provided_memory_paths],
        ["declared", audit.declared_used_memory_paths],
        ["observed", audit.observed_used_memory_paths],
        ["missing", audit.missing_expected_memory],
        ["hallucinated", audit.hallucinated_memory_reference],
      ].map(([label, paths]) => \`
        <div class="item"><code>\${esc(label)}</code><div class="muted">\${esc((paths || []).slice(0, 4).join(" | ") || "none")}</div></div>
      \`).join("") : '<p class="muted">No audit path details.</p>';
    }
    function graphSize() {
      const rect = graphCanvas.getBoundingClientRect();
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const width = Math.max(1, Math.floor(rect.width * dpr));
      const height = Math.max(1, Math.floor(rect.height * dpr));
      if (graphCanvas.width !== width || graphCanvas.height !== height) {
        graphCanvas.width = width;
        graphCanvas.height = height;
      }
      return { width, height, dpr };
    }
    function graphRadius(node) {
      if (node.type === "lane") return 10.2;
      if (node.type === "root") return 10.8;
      if (node.type === "activity_root") return 12.4;
      if (node.type === "active_task") return 8.9;
      if (node.type === "task") return 6.1;
      if (node.type === "context_pack") return 5.9;
      if (node.type === "trace") return 5.4;
      if (node.type === "memory_ref") return 5.8;
      if (node.type === "event") return 3.8;
      if (node.type === "folder") return 8.1;
      if (node.type === "tag") return 5.9;
      if (node.type === "kind") return 5.7;
      if (node.type === "record") return 5.1;
      if (["source_chunk", "source_snapshot", "external_source", "claim"].includes(node.type)) return 5.7;
      if (["candidate", "correction", "review", "memory", "behavior_rule"].includes(node.type)) return 5.9;
      if (["audit", "memory_audit", "gate", "sync", "commit", "status"].includes(node.type)) return 5.2;
      return 4.2;
    }
    function graphNodeStroke(node, active) {
      if (active) return "rgba(238, 230, 210, .98)";
      if (node.type === "record") return "rgba(84, 70, 44, .9)";
      if (node.type === "active_task") return "rgba(255, 231, 154, .98)";
      if (node.type === "activity_root") return "rgba(245, 188, 91, .98)";
      if (node.type === "task") return "rgba(217, 154, 61, .78)";
      if (node.type === "context_pack") return "rgba(138, 199, 255, .74)";
      if (node.type === "trace") return "rgba(199, 210, 254, .78)";
      if (node.type === "memory_ref") return "rgba(243, 231, 199, .82)";
      if (node.type === "event") return "rgba(185, 154, 105, .58)";
      if (node.type === "root") return "rgba(245, 188, 91, .95)";
      if (node.type === "tag") return "rgba(138, 216, 119, .78)";
      if (node.type === "folder") return "rgba(101, 212, 192, .78)";
      if (node.type === "kind") return "rgba(217, 154, 61, .78)";
      if (node.lane === "blocked") return "rgba(239, 139, 124, .92)";
      if (node.lane === "reviewer_pending") return "rgba(240, 168, 58, .88)";
      if (node.lane === "verifier_pending") return "rgba(138, 199, 255, .82)";
      if (node.lane === "main_pending") return "rgba(101, 198, 167, .84)";
      return "rgba(230, 220, 194, .38)";
    }
    function graphEdgeStyle(edge, active) {
      const semanticEvidence = ["source_to_chunk", "chunk_to_claim", "correction_to_rule", "candidate_to_review", "predecessor_to_successor"];
      const operationalEvidence = ["context_provided", "memory_declared_used", "memory_observed_used", "task_to_trace", "sync_to_commit"];
      if (active) {
        if (edge.type === "used_memory" || edge.type === "memory_declared_used" || edge.type === "memory_observed_used") return { color: "rgba(243, 231, 199, .92)", width: 1.82, bead: true, moving: true };
        if (edge.type === "retrieves_memory") return { color: "rgba(138, 199, 255, .86)", width: 1.74, bead: true, moving: true };
        if (semanticEvidence.includes(edge.type)) return { color: "rgba(127, 209, 189, .9)", width: 1.75, bead: true, moving: edge.type !== "candidate_to_review" };
        if (operationalEvidence.includes(edge.type)) return { color: "rgba(138, 199, 255, .9)", width: 1.78, bead: true, moving: true };
        return {
          color: edge.type === "has_tag" ? "rgba(124, 198, 106, .82)" : "rgba(255, 204, 102, .9)",
          width: 1.65,
          bead: true,
          moving: ["active_task", "uses_context", "finish_trace", "used_memory", "retrieves_memory"].includes(edge.type),
        };
      }
      if (edge.type === "active_task") return { color: "rgba(255, 204, 102, .22)", width: 1.12, bead: true, moving: true };
      if (edge.type === "uses_context") return { color: "rgba(138, 199, 255, .16)", width: .94, bead: true, moving: true };
      if (edge.type === "finish_trace") return { color: "rgba(199, 210, 254, .15)", width: .9, bead: true, moving: true };
      if (edge.type === "recent_trace") return { color: "rgba(199, 210, 254, .08)", width: .7, bead: true, moving: false };
      if (edge.type === "trace_pack") return { color: "rgba(138, 199, 255, .12)", width: .76, bead: true, moving: false };
      if (edge.type === "retrieves_memory") return { color: "rgba(138, 199, 255, .13)", width: .82, bead: true, moving: true };
      if (edge.type === "used_memory") return { color: "rgba(243, 231, 199, .14)", width: .88, bead: true, moving: true };
      if (semanticEvidence.includes(edge.type)) return { color: "rgba(127, 209, 189, .16)", width: .9, bead: true, moving: edge.type !== "candidate_to_review" };
      if (operationalEvidence.includes(edge.type)) return { color: "rgba(138, 199, 255, .17)", width: .94, bead: true, moving: true };
      if (edge.type === "in_lane") return { color: "rgba(217, 180, 74, .10)", width: .72, bead: false, moving: false };
      if (edge.type === "task_event") return { color: "rgba(185, 154, 105, .072)", width: .68, bead: true, moving: true };
      if (edge.type === "context_pack") return { color: "rgba(138, 199, 255, .09)", width: .72, bead: true, moving: false };
      if (edge.type === "wiki_link") return { color: "rgba(230, 220, 194, .082)", width: .72, bead: true };
      if (edge.type === "has_tag") return { color: "rgba(124, 198, 106, .05)", width: .62, bead: false };
      if (edge.type === "in_folder") return { color: "rgba(79, 182, 164, .06)", width: .64, bead: false };
      return { color: "rgba(190, 154, 91, .048)", width: .64, bead: false };
    }
    function graphHash(value) {
      let hash = 2166136261;
      const text = String(value ?? "");
      for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return hash >>> 0;
    }
    function graphUnit(value) {
      return (graphHash(value) % 1000) / 1000;
    }
    function graphPoseJitter(node, pose, amount = .018) {
      const jitterX = (graphUnit(node.id + ":x") - .5) * amount;
      const jitterY = (graphUnit(node.id + ":y") - .5) * amount;
      return {
        ...pose,
        x: Math.max(.035, Math.min(.965, pose.x + jitterX)),
        y: Math.max(.045, Math.min(.955, pose.y + jitterY)),
      };
    }
    function graphClusterPart(node, index) {
      const label = String(node.label || node.path || node.id || "").toLowerCase();
      if (node.type === "lane") return node.lane === "active" ? "live" : "operations";
      if (["source_snapshot", "source_chunk", "external_source", "provenance", "lineage_generation"].includes(node.type)) return "sources";
      if (["candidate", "correction", "review", "memory", "behavior_rule"].includes(node.type)) return "instances";
      if (["audit", "memory_audit", "gate", "sync", "commit", "status"].includes(node.type)) return "operations";
      if (node.type === "wiki_record" || node.type === "claim") return "wiki";
      if (node.type === "project_record") return "projects";
      if (node.type === "operations_record" || node.type === "error_record") return "operations";
      if (node.type === "activity_root") return "live";
      if (node.type === "active_task") return "live";
      if (node.type === "context_pack") return "context";
      if (node.type === "trace") return "operations";
      if (node.type === "memory_ref") return "instances";
      if (node.type === "event") return "operations";
      if (node.type === "task") return node.status === "started" ? "live" : "operations";
      if (node.type === "tag") return "tags";
      if (node.type === "kind") return "types";
      if (node.type === "root") {
        if (label.includes("30_sources") || label.includes("source")) return "sources";
        if (label.includes("20_wiki") || label.includes("wiki")) return "wiki";
        if (label.includes("40_projects") || label.includes("project")) return "projects";
        if (label.includes("50_instances") || label.includes("instance")) return "instances";
        if (label.includes("60_operations") || label.includes("operation")) return "operations";
        if (label.includes("70_error") || label.includes("error")) return "archive";
        return index % 2 === 0 ? "wiki" : "projects";
      }
      if (node.type === "folder") {
        if (label.includes("30_sources") || label.includes("source")) return "sources";
        if (label.includes("20_wiki") || label.includes("wiki")) return "wiki";
        if (label.includes("40_projects") || label.includes("project")) return "projects";
        if (label.includes("50_instances") || label.includes("instance")) return "instances";
        if (label.includes("60_operations") || label.includes("operation")) return "operations";
        if (label.includes("70_error") || label.includes("error")) return "archive";
        if (label.includes("accepted")) return "instances";
        return "wiki";
      }
      if (node.type === "record") {
        if (label.includes("30_sources") || label.includes("source")) return "sources";
        if (label.includes("20_wiki") || label.includes("wiki")) return "wiki";
        if (label.includes("40_projects") || label.includes("project")) return "projects";
        if (label.includes("50_instances") || label.includes("instance")) return "instances";
        if (label.includes("60_operations") || label.includes("operation")) return "operations";
        if (label.includes("70_error") || label.includes("error")) return "archive";
        return "wiki";
      }
      if (label.includes("context") || label.includes("pack")) return "context";
      if (label.includes("operation") || label.includes("task") || label.includes("trace")) return "operations";
      if (label.includes("instance") || label.includes("memory")) return "instances";
      if (label.includes("project")) return "projects";
      if (label.includes("source")) return "sources";
      if (label.includes("wiki")) return "wiki";
      if (label.includes("error") || label.includes("archive")) return "archive";
      return index % 3 === 0 ? "wiki" : index % 3 === 1 ? "projects" : "instances";
    }
    function graphClusterAnchor(part) {
      const anchors = {
        live: { x: .50, y: .48 },
        wiki: { x: .35, y: .30 },
        sources: { x: .20, y: .39 },
        projects: { x: .65, y: .30 },
        instances: { x: .71, y: .63 },
        operations: { x: .43, y: .69 },
        context: { x: .58, y: .62 },
        tags: { x: .24, y: .66 },
        types: { x: .30, y: .54 },
        archive: { x: .14, y: .63 },
      };
      return anchors[part] || anchors.wiki;
    }
    function graphReadablePose(node, ordinal, total, index) {
      const part = node.clusterPart || graphClusterPart(node, index);
      const anchor = graphClusterAnchor(part);
      const rootish = node.type === "root" || node.type === "folder" || node.type === "activity_root";
      if (node.type === "activity_root") return graphPoseJitter(node, { ...anchor, part, lock: .095 }, .006);
      if (node.type === "root") return graphPoseJitter(node, { ...anchor, part, lock: .12 }, .004);
      if (node.type === "folder") {
        const slot = ordinal % 6;
        const angle = (-Math.PI / 2) + slot * (Math.PI * 2 / 6);
        return graphPoseJitter(node, {
          x: anchor.x + Math.cos(angle) * .048,
          y: anchor.y + Math.sin(angle) * .040,
          part,
          lock: .10,
        }, .007);
      }
      const ringSize = part === "live" ? 7 : part === "operations" || part === "instances" ? 9 : 8;
      const slot = ordinal % ringSize;
      const ring = Math.floor(ordinal / ringSize);
      const baseAngle = graphUnit(node.id + ":angle") * Math.PI * 2;
      const angle = slot * (Math.PI * 2 / ringSize) + baseAngle * .28;
      const density = Math.max(1, total);
      const spread = Math.min(.13, .055 + ring * .027 + Math.min(.034, density * .0028));
      const xSpread = part === "sources" || part === "archive" ? spread * 1.15 : spread;
      const ySpread = part === "live" ? spread * .78 : spread * .86;
      const typePull = node.type === "event" ? .78 : node.type === "tag" ? .72 : node.type === "context_pack" ? .86 : 1;
      return graphPoseJitter(node, {
        x: anchor.x + Math.cos(angle) * xSpread * typePull,
        y: anchor.y + Math.sin(angle) * ySpread * typePull,
        part,
        lock: rootish ? .10 : part === "live" ? .082 : .067,
      }, .012);
    }
    function graphClusterPose(node, ordinal, total, index, graphTotal) {
      return graphReadablePose(node, ordinal, total, index, graphTotal);
    }
    function graphLayoutTarget(node, size) {
      const padX = Math.max(34 * size.dpr, size.width * .055);
      const padY = Math.max(30 * size.dpr, size.height * .075);
      const usableWidth = Math.max(1, size.width - padX * 2);
      const usableHeight = Math.max(1, size.height - padY * 2);
      return {
        x: padX + node.poseX * usableWidth,
        y: padY + node.poseY * usableHeight,
      };
    }
    function graphShouldLabel(node, active) {
      if (active) return true;
      if (node.type === "activity_root") return true;
      if (node.type === "root") return true;
      if (node.type === "lane") return true;
      if (node.type === "active_task") return false;
      if (node.type === "context_pack") return false;
      if (node.type !== "folder") return false;
      const label = String(node.label || "");
      return /^(20|30|40|50|60)_/i.test(label) || /wiki|source|project|instance|operation/i.test(label);
    }
    function matchesGraphSearch(node) {
      if (!graphSearch) return false;
      const haystack = [node.label, node.path, node.type, node.record_id, node.status, node.clusterPart].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(graphSearch);
    }
    function graphHoverNode() {
      let best = null;
      let bestDistance = Infinity;
      for (const node of graphNodes) {
        const distance = Math.hypot(node.x - graphMouse.x, node.y - graphMouse.y);
        const hitRadius = node.r + 8;
        if (distance <= hitRadius && distance < bestDistance) {
          best = node;
          bestDistance = distance;
        }
      }
      return best;
    }
    function graphConnectedIds(focus) {
      if (!focus) return null;
      const connected = new Set([focus.id]);
      for (const edge of graphEdges) {
        if (edge.source === focus.id) connected.add(edge.target);
        if (edge.target === focus.id) connected.add(edge.source);
      }
      return connected;
    }
    function graphEdgeActive(edge, focus, connected) {
      if (matchesGraphSearch(edge.sourceNode) || matchesGraphSearch(edge.targetNode)) return true;
      if (!focus || !connected) return false;
      return edge.source === focus.id || edge.target === focus.id;
    }
    function graphCurveControl(edge, size) {
      const a = edge.sourceNode;
      const b = edge.targetNode;
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const bend = (graphUnit(edge.source + edge.target + edge.type) - .5) * Math.min(82 * size.dpr, distance * .32);
      return {
        x: midX + (-dy / distance) * bend,
        y: midY + (dx / distance) * bend,
      };
    }
    function graphCurvePoint(a, c, b, t) {
      const mt = 1 - t;
      return {
        x: mt * mt * a.x + 2 * mt * t * c.x + t * t * b.x,
        y: mt * mt * a.y + 2 * mt * t * c.y + t * t * b.y,
      };
    }
    function drawGraphClusterBackdrops(size, now) {
      const clusters = [
        ["live", "rgba(255, 204, 102, .11)", .20],
        ["wiki", "rgba(238, 230, 210, .055)", .18],
        ["sources", "rgba(243, 231, 199, .045)", .16],
        ["projects", "rgba(138, 199, 255, .06)", .18],
        ["instances", "rgba(243, 231, 199, .065)", .18],
        ["context", "rgba(138, 199, 255, .055)", .15],
        ["operations", "rgba(217, 154, 61, .055)", .17],
        ["tags", "rgba(124, 198, 106, .045)", .15],
      ];
      graphCtx.save();
      graphCtx.globalCompositeOperation = "lighter";
      for (const [part, color, scale] of clusters) {
        const anchor = graphClusterAnchor(part);
        const x = anchor.x * size.width;
        const y = anchor.y * size.height;
        const pulse = 1 + Math.sin(now / 1500 + graphHash(part) * .001) * .035;
        const radius = Math.max(size.width, size.height) * scale * pulse;
        const gradient = graphCtx.createRadialGradient(x, y, 0, x, y, radius);
        gradient.addColorStop(0, color);
        gradient.addColorStop(.62, "rgba(0, 0, 0, 0)");
        graphCtx.fillStyle = gradient;
        graphCtx.beginPath();
        graphCtx.arc(x, y, radius, 0, Math.PI * 2);
        graphCtx.fill();
      }
      graphCtx.restore();
    }
    function graphFocusHtml(focus, connected) {
      if (!focus) return "";
      const connectedCount = connected ? Math.max(0, connected.size - 1) : 0;
      const label = compact(focus.label || focus.id, 88);
      const detail = compact(focus.path || focus.record_id || focus.status || focus.type, 140);
      const evidenceEdge = graphEdges.find((edge) => edge.source === focus.id || edge.target === focus.id);
      const evidence = compact(focus.evidence_path || evidenceEdge?.evidence_path || "", 150);
      return \`<strong>\${esc(label)}</strong><br><span>\${esc(focus.type)} / \${esc(focus.lane || "normal")} / links \${esc(connectedCount)}</span><br><code>\${esc(detail)}</code>\${evidence ? \`<br><code>\${esc(evidence)}</code>\` : ""}\`;
    }
    function setGraphOptions(select, values, allLabel) {
      const current = select.value || "all";
      const normalized = [...new Set((values || []).filter(Boolean))];
      const signature = normalized.join("|");
      if (select.dataset.signature === signature) return;
      select.dataset.signature = signature;
      select.innerHTML = \`<option value="all">\${esc(allLabel)}</option>\` + normalized.map((value) => \`<option value="\${esc(value)}">\${esc(String(value).replaceAll("_", " "))}</option>\`).join("");
      select.value = normalized.includes(current) ? current : "all";
    }
    function renderGraph(graph) {
      const modePrefix = currentLocalOnly?.enabled ? "LOCAL ONLY / " : "";
      graphStatsEl.textContent = modePrefix + (graph.ok
        ? graph.stats.shown_nodes + "/" + graph.stats.nodes + " nodes / " + graph.stats.shown_edges + "/" + graph.stats.edges + " edges" + (graph.stats.active_tasks ? " / active " + graph.stats.active_tasks : "") + (graph.stats.memory_edges ? " / memory links " + graph.stats.memory_edges : "")
        : "index missing");
      setGraphOptions(graphLaneEl, graph.filters?.lanes, "All lanes");
      setGraphOptions(graphRelationEl, graph.filters?.edge_types, "All relations");
      setGraphOptions(graphLifecycleEl, graph.filters?.lifecycle_states, "All lifecycle");
      setGraphOptions(graphProvenanceEl, graph.filters?.provenance_statuses, "All provenance");
      const signature = graph.nodes.map((node) => [node.id, node.type, node.label, node.status, node.updated_at].join(":")).join("\\n") + "\\n---\\n" + graph.edges.map((edge) => edge.source + ">" + edge.target + ":" + edge.type).join("\\n");
      if (signature === graphSignature) return;
      graphSignature = signature;
      const size = graphSize();
      const previous = new Map(graphNodes.map((node) => [node.id, node]));
      const prepared = graph.nodes.map((node, index) => ({ ...node, clusterPart: graphClusterPart(node, index) }));
      const partCounts = new Map();
      for (const node of prepared) partCounts.set(node.clusterPart, (partCounts.get(node.clusterPart) || 0) + 1);
      const partSeen = new Map();
      graphNodes = prepared.map((node, index) => {
        const old = previous.get(node.id);
        const ordinal = partSeen.get(node.clusterPart) || 0;
        partSeen.set(node.clusterPart, ordinal + 1);
        const pose = graphClusterPose(node, ordinal, partCounts.get(node.clusterPart) || 1, index, prepared.length);
        const target = graphLayoutTarget({ poseX: pose.x, poseY: pose.y }, size);
        const driftX = (graphUnit(node.id + ":start-x") - .5) * 7 * size.dpr;
        const driftY = (graphUnit(node.id + ":start-y") - .5) * 7 * size.dpr;
        return {
          ...node,
          x: old?.x ?? target.x + driftX,
          y: old?.y ?? target.y + driftY,
          vx: old?.vx ?? 0,
          vy: old?.vy ?? 0,
          poseX: pose.x,
          poseY: pose.y,
          poseLock: pose.lock ?? .22,
          clusterPart: pose.part || node.clusterPart,
          clusterOrdinal: ordinal,
          r: graphRadius(node),
        };
      });
      const byId = new Map(graphNodes.map((node) => [node.id, node]));
      graphEdges = graph.edges
        .map((edge) => ({ ...edge, sourceNode: byId.get(edge.source), targetNode: byId.get(edge.target) }))
        .filter((edge) => edge.sourceNode && edge.targetNode);
      if (graphSelected && !byId.has(graphSelected)) graphSelected = null;
    }
    function stepGraph() {
      const size = graphSize();
      const centerX = size.width / 2;
      const centerY = size.height / 2;
      for (let edgeIndex = 0; edgeIndex < graphEdges.length; edgeIndex += 1) {
        const edge = graphEdges[edgeIndex];
        const a = edge.sourceNode;
        const b = edge.targetNode;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const target = edge.type === "wiki_link"
          ? 62
          : ["used_memory", "retrieves_memory", "trace_pack"].includes(edge.type)
            ? 78
            : edge.type === "active_task"
              ? 76
              : 92;
        const force = (distance - target * size.dpr) * 0.000006;
        const fx = dx * force;
        const fy = dy * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
      for (let i = 0; i < graphNodes.length; i += 1) {
        const a = graphNodes[i];
        for (let j = i + 1; j < graphNodes.length; j += 1) {
          const b = graphNodes[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const distanceSq = Math.max(64, dx * dx + dy * dy);
          const force = Math.min(0.09, 38 / distanceSq);
          const distance = Math.sqrt(distanceSq);
          const fx = (dx / distance) * force;
          const fy = (dy / distance) * force;
          a.vx -= fx;
          a.vy -= fy;
          b.vx += fx;
          b.vy += fy;
        }
      }
      for (const node of graphNodes) {
        const target = graphLayoutTarget(node, size);
        node.targetX = target.x;
        node.targetY = target.y;
        node.vx += (target.x - node.x) * node.poseLock;
        node.vy += (target.y - node.y) * node.poseLock;
        node.vx += (centerX - node.x) * 0.000008;
        node.vy += (centerY - node.y) * 0.000006;
        node.vx *= 0.58;
        node.vy *= 0.58;
        const margin = Math.max(18 * size.dpr, 18);
        node.x = Math.max(margin, Math.min(size.width - margin, node.x + node.vx));
        node.y = Math.max(margin, Math.min(size.height - margin, node.y + node.vy));
      }
    }
    function drawGraph() {
      const size = graphSize();
      const now = performance.now();
      graphCtx.clearRect(0, 0, size.width, size.height);
      drawGraphClusterBackdrops(size, now);
      const hoveredNode = graphHoverNode();
      const selectedNode = graphSelected ? graphNodes.find((node) => node.id === graphSelected) : null;
      const searchFocus = graphSearch ? graphNodes.find(matchesGraphSearch) : null;
      const focus = hoveredNode || selectedNode || searchFocus || null;
      const connected = graphConnectedIds(focus);
      const labelBoxes = [];
      for (let edgeIndex = 0; edgeIndex < graphEdges.length; edgeIndex += 1) {
        const edge = graphEdges[edgeIndex];
        const a = edge.sourceNode;
        const b = edge.targetNode;
        const highlighted = graphEdgeActive(edge, focus, connected);
        const faded = focus && !highlighted;
        const style = graphEdgeStyle(edge, highlighted);
        const control = graphCurveControl(edge, size);
        graphCtx.lineWidth = Math.max(1, style.width * size.dpr);
        graphCtx.strokeStyle = style.color;
        graphCtx.globalAlpha = faded ? .16 : 1;
        graphCtx.beginPath();
        graphCtx.moveTo(a.x, a.y);
        graphCtx.quadraticCurveTo(control.x, control.y, b.x, b.y);
        graphCtx.stroke();
        if (style.bead) {
          const beadT = style.moving ? ((now / 1150 + edgeIndex * 0.071) % 1) : 0.5;
          const point = graphCurvePoint(a, control, b, beadT);
          graphCtx.beginPath();
          graphCtx.fillStyle = highlighted ? "rgba(238, 230, 210, .86)" : "rgba(230, 220, 194, .24)";
          graphCtx.arc(point.x, point.y, highlighted || style.moving ? 2.2 * size.dpr : 1.4 * size.dpr, 0, Math.PI * 2);
          graphCtx.fill();
        }
      }
      graphCtx.globalAlpha = 1;
      for (const node of graphNodes) {
        const highlighted = matchesGraphSearch(node);
        const hovered = hoveredNode?.id === node.id;
        const selected = graphSelected === node.id;
        const linked = connected?.has(node.id) ?? false;
        const faded = focus && !linked && !highlighted && !hovered && !selected;
        const active = highlighted || hovered || selected || linked;
        const livePulse = node.type === "active_task" || node.type === "activity_root" || node.type === "trace";
        const pulse = livePulse ? 1.6 + Math.sin(now / 260 + node.x * 0.01) * 1.2 : 0;
        const radius = active ? node.r + 2.4 : node.r + Math.max(0, pulse * 0.35);
        if (active || livePulse) {
          graphCtx.beginPath();
          graphCtx.globalAlpha = faded ? .18 : 1;
          graphCtx.fillStyle = node.type === "tag"
            ? "rgba(124, 198, 106, .14)"
            : node.type === "context_pack"
              ? "rgba(138, 199, 255, .14)"
              : node.type === "memory_ref"
                ? "rgba(243, 231, 199, .13)"
                : "rgba(217, 154, 61, .16)";
          graphCtx.arc(node.x, node.y, radius + (6 + pulse) * size.dpr, 0, Math.PI * 2);
          graphCtx.fill();
        }
        graphCtx.beginPath();
        graphCtx.fillStyle = node.color || "#c5d5e8";
        graphCtx.globalAlpha = faded ? 0.18 : graphSearch && !highlighted && !hovered && !linked ? 0.35 : 0.96;
        graphCtx.arc(node.x, node.y, radius, 0, Math.PI * 2);
        graphCtx.fill();
        graphCtx.lineWidth = Math.max(1, (node.type === "root" ? 2 : 1.25) * size.dpr);
        graphCtx.strokeStyle = graphNodeStroke(node, active);
        graphCtx.stroke();
        if (selected) {
          graphCtx.beginPath();
          graphCtx.globalAlpha = .95;
          graphCtx.strokeStyle = "rgba(255, 241, 194, .88)";
          graphCtx.lineWidth = Math.max(1, 1.15 * size.dpr);
          graphCtx.arc(node.x, node.y, radius + 7 * size.dpr, 0, Math.PI * 2);
          graphCtx.stroke();
        }
        if (node.type === "record" || node.type === "root" || node.type === "activity_root" || node.type === "active_task" || node.type === "memory_ref" || node.type === "trace") {
          graphCtx.beginPath();
          graphCtx.globalAlpha = faded ? 0.14 : graphSearch && !highlighted && !hovered && !linked ? 0.28 : 0.9;
          graphCtx.strokeStyle = node.type === "root"
            ? "rgba(91, 55, 20, .68)"
            : node.type === "trace"
              ? "rgba(39, 53, 95, .62)"
              : "rgba(91, 78, 54, .54)";
          graphCtx.lineWidth = Math.max(1, .8 * size.dpr);
          graphCtx.arc(node.x, node.y, Math.max(2, radius * .52), 0, Math.PI * 2);
          graphCtx.stroke();
        }
        if (node.type === "tag") {
          graphCtx.beginPath();
          graphCtx.fillStyle = "rgba(15, 31, 18, .55)";
          graphCtx.arc(node.x + radius * .28, node.y - radius * .22, Math.max(1.3, radius * .24), 0, Math.PI * 2);
          graphCtx.fill();
        }
        graphCtx.globalAlpha = 1;
        if (graphShouldLabel(node, active)) {
          graphCtx.font = Math.round(11 * size.dpr) + "px Segoe UI, sans-serif";
          const label = node.label.slice(0, 34);
          const rightSide = node.poseX > .58;
          const labelWidth = graphCtx.measureText(label).width;
          const preferredX = rightSide
            ? node.x - node.r - labelWidth - 10 * size.dpr
            : node.x + node.r + 7 * size.dpr;
          const labelX = Math.max(8 * size.dpr, Math.min(size.width - labelWidth - 8 * size.dpr, preferredX));
          const labelY = node.y - node.r - (node.type === "root" || node.type === "folder" ? 7 * size.dpr : 2);
          const box = {
            x: labelX - 5,
            y: labelY - 15 * size.dpr,
            width: labelWidth + 12,
            height: 22 * size.dpr,
          };
          const overlaps = labelBoxes.some((other) =>
            box.x < other.x + other.width &&
            box.x + box.width > other.x &&
            box.y < other.y + other.height &&
            box.y + box.height > other.y
          );
          if (active || !overlaps) {
            graphCtx.globalAlpha = faded ? .28 : 1;
            graphCtx.fillStyle = active ? "#fff1c2" : "#e6dcc2";
            graphCtx.shadowColor = active ? "rgba(255, 204, 102, .42)" : "rgba(0, 0, 0, .75)";
            graphCtx.shadowBlur = active ? 9 * size.dpr : 4 * size.dpr;
            graphCtx.fillText(label, labelX, labelY);
            graphCtx.shadowBlur = 0;
            labelBoxes.push(box);
          }
        }
      }
      graphCtx.globalAlpha = 1;
      graphFocusEl.innerHTML = graphFocusHtml(focus, connected);
    }
    function animateGraph() {
      if (!legacyGraphEnabled) return;
      stepGraph();
      drawGraph();
      requestAnimationFrame(animateGraph);
    }
    if (legacyGraphEnabled) graphSearchEl.addEventListener("input", () => {
      graphSearch = graphSearchEl.value.trim().toLowerCase();
    });
    async function refreshGraphView(focusId = null) {
      if (graphFetchInFlight) return;
      graphFetchInFlight = true;
      try {
        const params = new URLSearchParams();
        if (focusId) params.set("focus", focusId);
        if (graphLaneEl.value !== "all") params.set("lane", graphLaneEl.value);
        if (graphRelationEl.value !== "all") params.set("edge_type", graphRelationEl.value);
        if (graphLifecycleEl.value !== "all") params.set("lifecycle", graphLifecycleEl.value);
        if (graphProvenanceEl.value !== "all") params.set("provenance", graphProvenanceEl.value);
        const response = await fetch("/api/graph?" + params.toString(), { cache: "no-store" });
        if (!response.ok) throw new Error("graph request failed");
        graphViewCustom = Boolean(focusId) || [...params.keys()].length > 0;
        renderGraph(await response.json());
      } finally {
        graphFetchInFlight = false;
      }
    }
    for (const control of legacyGraphEnabled ? [graphLaneEl, graphRelationEl, graphLifecycleEl, graphProvenanceEl] : []) {
      control.addEventListener("change", () => void refreshGraphView());
    }
    if (legacyGraphEnabled) graphTraceEl.addEventListener("click", () => {
      if (graphSelected) void refreshGraphView(graphSelected);
    });
    if (legacyGraphEnabled) graphResetEl.addEventListener("click", () => {
      for (const control of [graphLaneEl, graphRelationEl, graphLifecycleEl, graphProvenanceEl]) control.value = "all";
      graphSelected = null;
      graphViewCustom = false;
      void refreshGraphView();
    });
    if (legacyGraphEnabled) graphCanvas.addEventListener("mousemove", (event) => {
      const rect = graphCanvas.getBoundingClientRect();
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      graphMouse = { x: (event.clientX - rect.left) * dpr, y: (event.clientY - rect.top) * dpr };
      graphCanvas.style.cursor = graphHoverNode() ? "pointer" : "default";
    });
    if (legacyGraphEnabled) graphCanvas.addEventListener("mouseleave", () => {
      graphMouse = { x: -9999, y: -9999 };
      graphCanvas.style.cursor = "default";
    });
    if (legacyGraphEnabled) graphCanvas.addEventListener("click", () => {
      const hovered = graphHoverNode();
      graphSelected = hovered ? (graphSelected === hovered.id ? null : hovered.id) : null;
    });
    let currentLocalOnly = null;
    if (legacyGraphEnabled) {
      window.addEventListener("resize", graphSize);
      requestAnimationFrame(animateGraph);
    }
    function render(data) {
      latestState = data;
      statusEl.textContent = "live - " + formatTime(data.summary.generated_at);
      connectionLabelEl.textContent = "연결됨";
      connectionDetailEl.textContent = "최근 상태 " + formatTime(data.summary.generated_at) + " · Activity는 1.5초마다 확인합니다.";
      const activeTaskCount = (data.tasks || []).filter((item) => item.status === "started").length;
      const blockerCount = Number(data.readiness?.counts?.blockers || 0);
      overviewSummaryEl.textContent = activeTaskCount
        ? activeTaskCount + "개 작업이 진행 중입니다. " + (blockerCount ? blockerCount + "개 확인 항목이 있습니다." : "현재 차단 항목은 없습니다.")
        : blockerCount
          ? "진행 중인 작업은 없고 " + blockerCount + "개 확인 항목이 있습니다."
          : "정상 연결됨 · 진행 중인 작업과 차단 항목이 없습니다.";
      rootEl.textContent = data.summary.data_root;
      document.getElementById("stat-events").textContent = data.summary.event_count;
      document.getElementById("stat-tasks").textContent = data.summary.task_count;
      document.getElementById("stat-packs").textContent = data.summary.context_pack_count;
      document.getElementById("stat-audits").textContent = data.summary.memory_audit_count ?? 0;
      document.getElementById("stat-active").textContent = data.summary.active_task_count;
      const graphHealth = data.graph_health || {};
      const lifecycle = data.lifecycle || { counts: {} };
      const sourceLineage = data.source_lineage || { counts: {} };
      const behaviorRecallMigration = data.behavior_recall_migration || { counts: {} };
      const behaviorRecall = data.behavior_recall || { counts: {} };
      const controlledCompounding = data.controlled_compounding || { counts: {} };
      const readTrace = data.read_trace || {};
      const syncRisk = data.sync_risk || {};
      const localOnly = data.local_only || {};
      currentLocalOnly = localOnly;
      const syncScheduler = data.sync_scheduler || { automatic: {}, queued_items: [] };
      const queuedSyncCount = Number(syncScheduler.queued_safe_file_count || 0) + Number(syncScheduler.queued_conditional_count || 0);
      const osV2 = data.os_v2 || { counts: {} };
      renderChip(
        chips.active,
        "Active",
        data.summary.active_task_count || "0",
        data.summary.active_task_count ? "task loop is open" : "idle",
        data.summary.active_task_count ? "warning" : "ready",
      );
      renderChip(
        chips.v2,
        "OS v2",
        osV2.status || "--",
        "gates " + (osV2.counts?.gates ?? 0) + " / evals " + (osV2.counts?.behavior_evals ?? 0),
        healthTone(osV2.status),
      );
      renderChip(chips.mcp, "MCP", data.summary.event_count || "0", "events observed", data.summary.event_count ? "healthy" : "unknown");
      renderChip(
        chips.read,
        "Read",
        readTrace.status || "idle",
        readTrace.latest_pack_path || "no recent Context Pack",
        healthTone(readTrace.status),
      );
      renderChip(
        chips.lifecycle,
        "Nodes",
        lifecycle.status || "--",
        "memory " + (lifecycle.counts?.retrievable_accepted ?? 0) + " / review " + (lifecycle.counts?.hot_review_units ?? 0) + " / cold " + (lifecycle.counts?.cold_candidates ?? 0),
        healthTone(lifecycle.status),
      );
      renderChip(
        chips.source,
        "Sources",
        sourceLineage.status || "--",
        "verified " + (sourceLineage.counts?.verified_source_chunks ?? 0) + " / generations " + (sourceLineage.counts?.lineage_generations ?? 0) + " / blockers " + (sourceLineage.counts?.blockers ?? 0),
        healthTone(sourceLineage.status),
      );
      renderChip(
        chips.recall,
        "Recall",
        behaviorRecall.status || "--",
        "entries " + (behaviorRecall.counts?.entries ?? 0) + " / blockers " + (behaviorRecall.counts?.blockers ?? 0),
        healthTone(behaviorRecall.status),
      );
      renderChip(
        chips.compounding,
        "Compound",
        controlledCompounding.status || "--",
        "rules " + (controlledCompounding.counts?.controlled_accepted_rules ?? 0) + " / proposals " + (controlledCompounding.counts?.controlled_candidates ?? 0),
        healthTone(controlledCompounding.status),
      );
      renderChip(
        chips.graph,
        "Graph",
        graphHealth.score ?? "--",
        graphHealth.status || "missing",
        healthTone(graphHealth.status),
      );
      if (localOnly.enabled) {
        renderChip(
          chips.sync,
          "Local Only",
          "PUSH BLOCKED",
          "review loop / backup " + (localOnly.backup?.status || "not verified"),
          localOnly.backup?.status === "verified" ? "healthy" : "ready",
        );
      } else {
        renderChip(
          chips.sync,
          "Sync",
          syncScheduler.last_attempt?.outcome || (queuedSyncCount ? "queued" : "idle"),
          queuedSyncCount + " queued · auto " + (syncScheduler.automatic?.enabled ? "on" : "off"),
          syncScheduler.last_attempt?.outcome === "blocked" || syncScheduler.last_attempt?.outcome === "retry_required" ? "warning" : "ready",
        );
      }
      kv(osHealthEl, [
        ["status", graphHealth.status],
        ["score", graphHealth.score],
        ["records", graphHealth.indexed_record_count],
        ["nodes", graphHealth.node_count],
        ["edges", graphHealth.edge_count],
        ["unresolved", graphHealth.unresolved_wiki_link_count],
        ["warnings", Array.isArray(graphHealth.warnings) ? graphHealth.warnings.join(", ") : ""],
        ["path", graphHealth._path],
      ]);
      kv(osV2El, [
        ["version", osV2.version],
        ["status", osV2.status],
        ["fail closed", osV2.fail_closed],
        ["latest gate", osV2.latest_gate && (osV2.latest_gate._path || osV2.latest_gate.gate_id)],
        ["gate status", osV2.latest_gate && osV2.latest_gate.status],
        ["action decision", osV2.latest_gate && osV2.latest_gate.action_decision],
        ["context verified", osV2.latest_gate && osV2.latest_gate.context_evidence?.contextTraceVerified],
        ["context fresh", osV2.latest_gate && osV2.latest_gate.context_evidence?.contextTraceFresh],
        ["event order", osV2.latest_gate && osV2.latest_gate.preflight_evidence?.eventOrderVerified],
        ["sync observation", osV2.latest_gate && osV2.latest_gate.sync_observation?.status],
        ["behavior lift", osV2.latest_behavior_eval && osV2.latest_behavior_eval.average_memory_lift],
        ["lifecycle", osV2.latest_lifecycle && (osV2.latest_lifecycle.status || osV2.latest_lifecycle.lifecycle_id)],
        ["sources", osV2.counts?.source_chunks],
        ["provenance", osV2.counts?.provenance_links],
        ["compounding", controlledCompounding.status],
      ]);
      kv(controlledCompoundingEl, [
        ["status", controlledCompounding.status],
        ["reviewed rules", controlledCompounding.counts?.controlled_accepted_rules],
        ["recurring proposals", controlledCompounding.counts?.recurring_controlled_candidates],
        ["hot rule tokens", controlledCompounding.counts?.hot_rule_tokens],
        ["retrieved rules", controlledCompounding.counts?.retrieved_controlled_rules],
        ["used rules", controlledCompounding.counts?.used_controlled_rules],
        ["legacy excluded", controlledCompounding.counts?.legacy_generated_candidates_excluded],
        ["blockers", Array.isArray(controlledCompounding.blockers) ? controlledCompounding.blockers.join(", ") : ""],
        ["path", controlledCompounding._path],
      ]);
      kv(readTraceEl, [
        ["status", readTrace.status],
        ["pack", readTrace.latest_pack_path],
        ["items", readTrace.item_count],
        ["trace", readTrace.latest_trace_path],
        ["used", readTrace.used_memory_count],
        ["preflight", readTrace.latest_preflight_at],
      ]);
      readTraceItemsEl.innerHTML = Array.isArray(readTrace.grounded_items) && readTrace.grounded_items.length
        ? readTrace.grounded_items.map((item) => \`
          <div class="item"><code>\${esc(item.path)}</code><div class="muted">\${esc(compact(item.title || item.kind || "", 120))}</div></div>
        \`).join("")
        : '<p class="muted">No grounded read trace yet.</p>';
      kv(nodeLifecycleEl, [
        ["status", lifecycle.status],
        ["node gate", lifecycle.node_status],
        ["queue", lifecycle.queue_status],
        ["backpressure", lifecycle.backpressure_status],
        ["growth mode", lifecycle.growth_mode],
        ["cold partitions", lifecycle.cold_partition_status],
        ["candidates", lifecycle.counts?.candidates],
        ["review", lifecycle.counts?.promotion_reviews],
        ["merge review", lifecycle.counts?.pending_merge_reviews],
        ["hot review units", lifecycle.counts?.hot_review_units],
        ["cold candidates", lifecycle.counts?.cold_candidates],
        ["deterministic holds", lifecycle.counts?.deterministic_hold_pending],
        ["accepted", lifecycle.counts?.accepted],
        ["quarantined", lifecycle.counts?.quarantined],
        ["retrievable", lifecycle.counts?.retrievable_accepted],
        ["held / excluded", lifecycle.counts?.held_or_excluded],
        ["blockers", lifecycle.counts?.lifecycle_blockers],
        ["transaction", lifecycle.transaction_id],
        ["path", lifecycle.artifact_path],
      ]);
      lifecycleRetryEl.innerHTML = Array.isArray(lifecycle.retry_candidates) && lifecycle.retry_candidates.length
        ? lifecycle.retry_candidates.slice(0, 6).map((item) => \`
          <div class="item"><code>\${esc(item._path || item.path || item.candidate_id || item.review_id || "")}</code><div class="muted">\${esc(compact(item.claim || item.title || item.notes || "", 140))}</div></div>
        \`).join("")
        : '<p class="muted">No lifecycle blockers or retry candidates.</p>';
      kv(sourceLineageEl, [
        ["status", sourceLineage.status],
        ["verified chunks", sourceLineage.counts?.verified_source_chunks],
        ["source snapshots", sourceLineage.counts?.source_snapshots],
        ["lineage generations", sourceLineage.counts?.lineage_generations],
        ["anchor only", sourceLineage.counts?.anchor_only_unverified],
        ["unverified chunks", sourceLineage.counts?.unverified_source_chunks],
        ["claim records", sourceLineage.counts?.claim_records],
        ["supported claims", sourceLineage.counts?.verified_claim_support],
        ["unsupported claims", sourceLineage.counts?.unsupported_factual_claims],
        ["dangling claims", sourceLineage.counts?.dangling_claim_paths],
        ["stale support", sourceLineage.counts?.stale_support],
        ["hash mismatches", sourceLineage.counts?.hash_mismatches],
        ["blockers", sourceLineage.counts?.blockers],
        ["path", sourceLineage._path],
      ]);
      sourceLineageFindingsEl.innerHTML = Array.isArray(sourceLineage.findings) && sourceLineage.findings.length
        ? sourceLineage.findings.slice(0, 6).map((finding) => \`
          <div class="item"><code>\${esc(finding.signal || "")}</code><div class="muted">\${esc(compact((finding.path || "") + " / " + (finding.reason || ""), 160))}</div></div>
        \`).join("")
        : '<p class="muted">No source lineage blockers.</p>';
      kv(behaviorRecallEl, [
        ["status", behaviorRecall.status],
        ["evidence migration", behaviorRecallMigration.status],
        ["migrated evidence", behaviorRecall.counts?.evidence_migrations_applied],
        ["invalid migrations", behaviorRecall.counts?.evidence_migrations_invalid],
        ["entries", behaviorRecall.counts?.entries],
        ["completion", behaviorRecall.counts?.completion],
        ["handoff", behaviorRecall.counts?.handoff],
        ["error", behaviorRecall.counts?.error],
        ["direction change", behaviorRecall.counts?.direction_change],
        ["correction", behaviorRecall.counts?.correction],
        ["performed", behaviorRecall.counts?.performed],
        ["conflicts", behaviorRecall.counts?.correction_conflicts],
        ["blockers", behaviorRecall.counts?.blockers],
        ["path", behaviorRecall._path],
      ]);
      behaviorRecallFindingsEl.innerHTML = Array.isArray(behaviorRecall.findings) && behaviorRecall.findings.length
        ? behaviorRecall.findings.slice(0, 6).map((finding) => \`
          <div class="item"><code>\${esc(finding.signal || "")}</code><div class="muted">\${esc(compact((finding.path || "") + " / " + (finding.reason || ""), 160))}</div></div>
        \`).join("")
        : '<p class="muted">No behavior recall blockers.</p>';
      kv(syncRiskEl, [
        ["mode", localOnly.mode],
        ["push policy", localOnly.push_policy],
        ["candidate loop", localOnly.candidate_loop],
        ["auto accept", localOnly.auto_accept],
        ["source/runtime split", localOnly.source_runtime_separated],
        ["backup", localOnly.backup?.status || "not verified"],
        ["backup verified", localOnly.backup?.verified_at],
        ["final app", localOnly.final_app_commit],
        ["final data", localOnly.final_data_commit],
        ["status", syncRisk.status],
        ["branch", syncRisk.branch],
        ["dirty", syncRisk.dirty_count],
        ["staged", syncRisk.staged_count],
        ["untracked", syncRisk.untracked_count],
        ["detail", Array.isArray(syncRisk.detail) ? syncRisk.detail.join(" | ") : syncRisk.detail],
      ]);
      kv(syncSchedulerEl, [
        ["automatic", syncScheduler.automatic?.enabled ? "enabled" : "disabled"],
        ["cadence", (syncScheduler.automatic?.coalesce_hours ?? 6) + "h coalesce · " + (syncScheduler.automatic?.idle_minutes ?? 10) + "m idle"],
        ["daily cap", (syncScheduler.automatic?.pushes_in_rolling_24h ?? 0) + " / " + (syncScheduler.automatic?.maximum_pushes_per_24h ?? 4)],
        ["last success", syncScheduler.last_successful_sync ? new Date(syncScheduler.last_successful_sync).toLocaleString() : "none"],
        ["last attempt", syncScheduler.last_attempt ? syncScheduler.last_attempt.outcome + " · " + syncScheduler.last_attempt.reason : "none"],
        ["next automatic", syncScheduler.next_eligible_automatic_sync ? new Date(syncScheduler.next_eligible_automatic_sync).toLocaleString() : "not scheduled"],
        ["queued safe", syncScheduler.queued_safe_file_count],
        ["queued conditional", syncScheduler.queued_conditional_count],
        ["blocked", syncScheduler.blocked_count],
        ["branch", syncScheduler.branch],
        ["remote parity", syncScheduler.remote_parity],
        ["skip reasons", Array.isArray(syncScheduler.skip_reasons) ? syncScheduler.skip_reasons.join(", ") : ""],
      ]);
      syncQueueEl.innerHTML = Array.isArray(syncScheduler.queued_items) && syncScheduler.queued_items.length
        ? syncScheduler.queued_items.slice(0, 8).map((item) => \`<div class="item"><code>\${esc(item.path)}</code><div class="muted">\${esc(item.task_id)} · \${esc(item.classification)} · eligible \${esc(new Date(item.eligible_at).toLocaleString())}</div></div>\`).join("")
        : '<p class="muted">동기화 대기 파일이 없습니다.</p>';
      syncAutomaticEl.checked = Boolean(syncScheduler.automatic?.enabled);
      const remoteSyncBlocked = Boolean(localOnly.enabled || syncScheduler.push_policy === "blocked");
      syncNowEl.disabled = remoteSyncBlocked;
      syncAutomaticEl.disabled = remoteSyncBlocked;
      if (remoteSyncBlocked) {
        syncAutomaticEl.checked = false;
        syncActionStatusEl.textContent = "Local-only 모드: 원격 push는 봉인되어 있고 로컬 기록과 암호화 백업만 유지됩니다.";
      }
      timelineEl.innerHTML = data.events.map((event) => \`
        <article class="event \${esc(event.event)}">
          <time>\${esc(formatTime(event.at))}</time>
          <div>
            <h2><span class="badge">\${esc(eventTitle(event))}</span></h2>
            <code>\${esc(compact(eventDetail(event), 260))}</code>
          </div>
        </article>
      \`).join("") || '<p class="muted">No DinoBrain events yet.</p>';
      const task = data.tasks[0];
      kv(latestTaskEl, task ? [
        ["task", task.task_id],
        ["status", task.status],
        ["project", task.project],
        ["sync", task.sync_policy],
        ["path", task._path],
        ["request", compact(task.request, 220)]
      ] : []);
      const activeTasks = data.tasks.filter((item) => item.status === "started");
      activeTasksEl.innerHTML = activeTasks.length
        ? activeTasks.slice(0, 8).map((item) => \`
          <div class="item"><code>\${esc(item.task_id)}</code><div class="muted">\${esc(compact(item.request, 160))}</div><code>\${esc(item._path || item.path || "")}</code></div>
        \`).join("")
        : '<p class="muted">No active task.</p>';
      const pack = data.context_packs[0];
      latestPackEl.innerHTML = pack ? [
        \`<div class="item"><code>\${esc(pack._path)}</code></div>\`,
        ...(pack.items || []).slice(0, 7).map((item) => \`<div class="item"><code>\${esc(item.path)}</code><div class="muted">\${esc(compact(item.summary, 190))}</div></div>\`)
      ].join("") : '<p class="muted">No Context Pack yet.</p>';
      const trace = data.traces[0];
      kv(latestTraceEl, trace ? [
        ["task", trace.task_id],
        ["outcome", trace.outcome],
        ["path", trace._path],
        ["used", Array.isArray(trace.used_memory_paths) ? trace.used_memory_paths.length : 0],
        ["summary", compact(trace.summary, 220)]
      ] : []);
      const audit = data.memory_audits && data.memory_audits[0];
      kv(latestAuditEl, audit ? [
        ["audit", audit.audit_id],
        ["task", audit.task_id],
        ["score", audit.trust_score],
        ["verdict", audit.verdict],
        ["graph", audit.graph_health_snapshot && audit.graph_health_snapshot.score],
        ["path", audit._path]
      ] : []);
    }
    const pollIntervalMs = 3000;
    let pollInFlight = false;
    async function tick() {
      if (pollInFlight) return;
      pollInFlight = true;
      try {
        const response = await fetch("/api/snapshot", { cache: "no-store" });
        if (!response.ok) throw new Error("snapshot request failed: " + response.status);
        const snapshot = await response.json();
        latestState = { ...snapshot.state, readiness: snapshot.readiness };
        render(snapshot.state);
        window.dispatchEvent(new CustomEvent("dinobrain-graph-update", { detail: snapshot.graph }));
        renderReadiness(snapshot.readiness);
      } catch (error) {
        statusEl.textContent = "disconnected";
        connectionLabelEl.textContent = "연결 끊김";
        connectionDetailEl.textContent = "자동으로 다시 연결을 시도하고 있습니다.";
      } finally {
        pollInFlight = false;
        window.setTimeout(tick, pollIntervalMs);
      }
    }
    tick();
  </script>
  <script type="module">
    import { mountObservatoryGraph } from "/assets/observatory-graph.mjs";

    const graphHost = document.getElementById("observatory-graph-host");
    const graphWidget = mountObservatoryGraph(graphHost, {
      graphUrl: "/api/graph",
      subscribe(callback) {
        const handler = (event) => callback(event.detail);
        window.addEventListener("dinobrain-graph-update", handler);
        return () => window.removeEventListener("dinobrain-graph-update", handler);
      },
      onEvidencePath(evidencePath, payload) {
        window.dispatchEvent(new CustomEvent("dinobrain-graph-inspect", {
          detail: { ...payload, evidence_path: evidencePath, status: payload?.status || "evidence" },
        }));
      },
      onReindex(action) {
        navigator.clipboard?.writeText(action.command).catch(() => undefined);
        window.dispatchEvent(new CustomEvent("dinobrain-graph-inspect", {
          detail: {
            status: "action_available",
            action: action.label,
            command: action.command,
            scope: action.scope,
            next_action: "복사된 명령을 앱 폴더에서 실행하면 로컬 그래프 인덱스만 다시 만듭니다.",
          },
        }));
      },
    });
    window.__dinobrainObservatoryGraph = graphWidget;
  </script>
</body>
</html>`;
}

function sendJson(response, value, statusCode = 200) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body, "utf8"),
  });
  response.end(body);
}

async function readSmallJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2048) throw new Error("request_body_too_large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function hasObservatoryActionHeader(request) {
  return request.headers["x-dinobrain-action"] === "observatory";
}

const server = http.createServer(async (request, response) => {
  resourceCounters.http_requests += 1;
  resourceCounters.http_active += 1;
  resourceCounters.http_peak_active = Math.max(resourceCounters.http_peak_active, resourceCounters.http_active);
  try {
    const requestUrl = new URL(request.url ?? "/", `http://${host}:${port}`);
    if (requestUrl.pathname === "/assets/observatory-graph.mjs") {
      const body = await fs.readFile(path.join(root, "scripts", "observatory-graph.mjs"));
      response.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
        "content-length": body.length,
      });
      response.end(body);
      return;
    }
    if (requestUrl.pathname === "/api/health") {
      const [graphHealth, readiness] = await Promise.all([readGraphHealth(), getReadiness()]);
      sendJson(response, {
        ok: true,
        observatory_version: observatoryVersion,
        app_root: root,
        data_root: dataRoot,
        local_only: localOnlyStatus(dataRoot),
        graph_health: graphHealth,
        readiness: {
          version: readiness.version,
          parity_hash: readiness.parity_hash,
          status: readiness.status,
          operational_status: readiness.operational_status,
          generation_id: readiness.status_generation?.generation_id ?? null,
          gate_statuses: Object.fromEntries(readiness.gates.map((gate) => [gate.gate_id, gate.status])),
        },
        cache: cacheHealth(),
        resources: {
          ...resourceCounters,
          state_payload_budget_bytes: statePayloadBudgetBytes,
          generation_verify_ttl_ms: generationVerifyTtlMs,
          source_stat_ttl_ms: sourceStatTtlMs,
          process_memory: process.memoryUsage(),
        },
        endpoints: ["/api/health", "/api/snapshot", "/api/activity", "/api/state", "/api/readiness", "/api/graph", "/api/graph-health", "/api/sync-state", "/api/sync/run", "/api/sync/automatic"],
      });
      return;
    }

    if (requestUrl.pathname === "/api/sync-state") {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "method_not_allowed" }, 405);
        return;
      }
      sendJson(response, await readBoundedSyncState());
      return;
    }

    if (requestUrl.pathname === "/api/sync/run") {
      if (request.method !== "POST" || !hasObservatoryActionHeader(request)) {
        sendJson(response, { ok: false, error: "observatory_action_required" }, 403);
        return;
      }
      if (localOnlyStatus(dataRoot).enabled === true) {
        sendJson(response, { ok: false, outcome: "blocked", error: "local_only_remote_push_disabled" }, 409);
        return;
      }
      sendJson(response, await runSyncScheduler("manual"));
      return;
    }

    if (requestUrl.pathname === "/api/sync/automatic") {
      if (request.method !== "POST" || !hasObservatoryActionHeader(request)) {
        sendJson(response, { ok: false, error: "observatory_action_required" }, 403);
        return;
      }
      const payload = await readSmallJsonBody(request);
      if (typeof payload.enabled !== "boolean") {
        sendJson(response, { ok: false, error: "enabled_boolean_required" }, 400);
        return;
      }
      if (payload.enabled && localOnlyStatus(dataRoot).enabled === true) {
        sendJson(response, { ok: false, automatic_enabled: false, error: "local_only_remote_push_disabled" }, 409);
        return;
      }
      const state = await setSyncSchedulerAutomaticEnabled({ dataRoot, enabled: payload.enabled });
      invalidateObservatoryStateCaches();
      automaticSyncNextProbeAt = 0;
      sendJson(response, { ok: true, automatic_enabled: state.automatic_enabled, immediate_push: false });
      return;
    }

    if (requestUrl.pathname === "/api/snapshot") {
      sendJson(response, await getSnapshot());
      return;
    }

    if (requestUrl.pathname === "/api/activity") {
      sendJson(response, await readActivityEvents(requestUrl.searchParams.get("limit") ?? 500));
      return;
    }

    if (requestUrl.pathname === "/api/readiness") {
      sendJson(response, await getReadiness());
      return;
    }

    if (requestUrl.pathname === "/api/graph-health") {
      const [graphHealth, readiness] = await Promise.all([readGraphHealth(), getReadiness()]);
      sendJson(response, {
        ...graphHealth,
        readiness: {
          version: readiness.version,
          parity_hash: readiness.parity_hash,
          status: readiness.status,
          operational_status: readiness.operational_status,
          generation_id: readiness.status_generation?.generation_id ?? null,
          gate_statuses: Object.fromEntries(readiness.gates.map((gate) => [gate.gate_id, gate.status])),
        },
      });
      return;
    }

    if (requestUrl.pathname === "/api/state") {
      sendJson(response, await getState());
      return;
    }

    if (requestUrl.pathname === "/api/graph") {
      const edgeTypes = requestUrl.searchParams.getAll("edge_type").flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
      sendJson(response, await getGraph(null, {
        focusId: requestUrl.searchParams.get("focus"),
        lane: requestUrl.searchParams.get("lane"),
        lifecycleState: requestUrl.searchParams.get("lifecycle"),
        provenanceStatus: requestUrl.searchParams.get("provenance"),
        edgeTypes,
      }));
      return;
    }

    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(html());
  } catch (error) {
    if (!response.headersSent) {
      sendJson(response, { ok: false, error: String(error?.message || error).slice(0, 240) }, 500);
    } else if (!response.writableEnded) {
      response.end();
    }
  } finally {
    resourceCounters.http_active = Math.max(0, resourceCounters.http_active - 1);
  }
});

server.listen(port, host, () => {
  console.log(JSON.stringify({ ok: true, url: `http://${host}:${port}/`, data_root: dataRoot }, null, 2));
});

const automaticSyncTimer = setInterval(() => {
  void maybeRunAutomaticSync();
}, 60_000);
automaticSyncTimer.unref();
void maybeRunAutomaticSync();
