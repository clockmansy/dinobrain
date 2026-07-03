import http from "node:http";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(root, "..", "dinobrain-data"));
const host = process.env.DINOBRAIN_OBSERVATORY_HOST ?? "127.0.0.1";
const port = Number(process.env.DINOBRAIN_OBSERVATORY_PORT ?? process.argv.find((arg) => arg.startsWith("--port="))?.split("=")[1] ?? 3847);
const observatoryVersion = "2026-07-03-os-health-cockpit-v1";
const execFileAsync = promisify(execFile);

function rel(filePath) {
  return path.relative(dataRoot, filePath).split(path.sep).join("/");
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return null;
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

async function readDirFiles(dir, extension) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
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
  const shardPath = path.join(dataRoot, ".dino", "index", "sqlite", "operations.sqlite");
  try {
    await fs.access(shardPath);
  } catch {
    return null;
  }

  const db = new DatabaseSync(shardPath, { readOnly: true });
  try {
    const counts = {
      tasks: db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count,
      traces: db.prepare("SELECT COUNT(*) AS count FROM traces").get().count,
      context_packs: db.prepare("SELECT COUNT(*) AS count FROM context_packs").get().count,
      events: db.prepare("SELECT COUNT(*) AS count FROM events").get().count,
    };
    const tasks = db
      .prepare("SELECT * FROM tasks ORDER BY updated_at DESC, path ASC LIMIT 50")
      .all()
      .map(withDisplayPath);
    const traces = db
      .prepare("SELECT * FROM traces ORDER BY finished_at DESC, path ASC LIMIT 50")
      .all()
      .map(withTraceDisplay);
    const packs = db
      .prepare("SELECT * FROM context_packs ORDER BY created_at DESC, path ASC LIMIT 50")
      .all()
      .map((pack) => ({
        ...withDisplayPath(pack),
        items: db
          .prepare("SELECT path, kind, title, summary, score FROM context_pack_items WHERE pack_path = ? ORDER BY ordinal ASC")
          .all(pack.path),
      }));
    const events = db
      .prepare("SELECT payload_json FROM events ORDER BY at DESC, event_key ASC LIMIT 100")
      .all()
      .map((row) => JSON.parse(row.payload_json));
    return {
      generated_at: new Date().toISOString(),
      index_mode: "sqlite_shards_v0",
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
  };
  return colors[node.type] ?? "#cfc4a6";
}

function normalizeGraphNode(node) {
  return {
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
    source: String(edge.from ?? edge.from_id ?? edge.source ?? ""),
    target: String(edge.to ?? edge.to_id ?? edge.target ?? ""),
    type: String(edge.type ?? edge.label ?? "edge"),
  };
}

function selectGraphWindow(nodes, edges, limit = 450) {
  const priority = new Map([
    ["root", 0],
    ["folder", 1],
    ["kind", 2],
    ["tag", 3],
    ["record", 4],
    ["wikilink", 5],
  ]);
  const selectedNodes = [...nodes]
    .sort((a, b) => {
      const typeDelta = (priority.get(a.type) ?? 9) - (priority.get(b.type) ?? 9);
      if (typeDelta !== 0) return typeDelta;
      const countDelta = (b.count ?? 0) - (a.count ?? 0);
      if (countDelta !== 0) return countDelta;
      return a.id.localeCompare(b.id);
    })
    .slice(0, limit);
  const selectedIds = new Set(selectedNodes.map((node) => node.id));
  const selectedEdges = edges.filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target));
  return {
    nodes: selectedNodes,
    edges: selectedEdges,
    shown_node_count: selectedNodes.length,
    shown_edge_count: selectedEdges.length,
    truncated: nodes.length > selectedNodes.length || edges.length > selectedEdges.length,
  };
}

async function readWikiGraph() {
  const shardPath = path.join(dataRoot, ".dino", "index", "sqlite", "wiki.sqlite");
  try {
    await fs.access(shardPath);
    const db = new DatabaseSync(shardPath, { readOnly: true });
    try {
      const metadata = Object.fromEntries(
        db.prepare("SELECT key, value FROM metadata")
          .all()
          .map((row) => [String(row.key), String(row.value)]),
      );
      const nodes = db.prepare("SELECT id, type, label, path, record_id, count FROM nodes").all().map(normalizeGraphNode);
      const edges = db.prepare("SELECT from_id, to_id, type FROM edges").all().map(normalizeGraphEdge);
      const recordCount = db.prepare("SELECT COUNT(*) AS count FROM records").get().count;
      const graph = selectGraphWindow(nodes, edges);
      return {
        ok: true,
        index_mode: "sqlite_wiki_graph_v0",
        generated_at: metadata.generated_at ?? null,
        data_root: dataRoot,
        stats: {
          records: Number(recordCount ?? 0),
          nodes: nodes.length,
          edges: edges.length,
          shown_nodes: graph.shown_node_count,
          shown_edges: graph.shown_edge_count,
          truncated: graph.truncated,
        },
        nodes: graph.nodes,
        edges: graph.edges,
      };
    } finally {
      db.close();
    }
  } catch (error) {
    if (error?.code !== "ENOENT" && !String(error?.message ?? "").includes("no such table")) throw error;
  }

  const index = await readJson(path.join(dataRoot, ".dino", "index", "wiki-index.json"));
  if (index?.version === 1 && Array.isArray(index.nodes) && Array.isArray(index.edges)) {
    const nodes = index.nodes.map(normalizeGraphNode);
    const edges = index.edges.map(normalizeGraphEdge);
    const graph = selectGraphWindow(nodes, edges);
    return {
      ok: true,
      index_mode: "json_wiki_graph_v0",
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
  const files = (await readDirFiles(eventDir, ".jsonl")).slice(-7);
  const events = [];
  for (const file of files) {
    const text = await fs.readFile(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        events.push({ ...JSON.parse(line), _path: rel(file) });
      } catch {
        events.push({ event: "unparseable_event", at: null, _path: rel(file), raw: line.slice(0, 240) });
      }
    }
  }
  return events
    .sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")))
    .slice(-limit);
}

async function readJsonDir(relativeDir, limit = 50, preserveRecord = () => false) {
  const dir = path.join(dataRoot, relativeDir);
  const files = await readDirFiles(dir, ".json");
  const records = [];
  for (const file of files) {
    const value = await readJson(file);
    if (value) records.push({ ...value, _path: rel(file) });
  }
  const sorted = records.sort((a, b) =>
      String(b.updated_at ?? b.created_at ?? b.finished_at ?? b.audited_at ?? "").localeCompare(
        String(a.updated_at ?? a.created_at ?? a.finished_at ?? a.audited_at ?? ""),
      ),
    );
  const selected = sorted.slice(0, limit);
  const selectedPaths = new Set(selected.map((record) => record._path));
  for (const record of sorted) {
    if (!selectedPaths.has(record._path) && preserveRecord(record)) {
      selected.push(record);
      selectedPaths.add(record._path);
    }
  }
  return selected;
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

function sourcePath(record) {
  return String(record?.source_candidate_path ?? record?.source_path ?? record?.evidence_source ?? "").trim();
}

async function readLifecycleQueue() {
  const [candidates, accepted, reviews, quarantines] = await Promise.all([
    readJsonDir("50_Instances/candidates", 60),
    readJsonDir("50_Instances/accepted", 80),
    readJsonDir("80_Review_Queue/promotion", 60),
    readJsonDir(".dino/quarantine", 40),
  ]);
  const reviewIds = new Set(reviews.map((entry) => path.basename(String(entry._path ?? entry.path ?? ""), ".json")));
  const candidateWithoutReview = candidates.filter((entry) => !reviewIds.has(path.basename(String(entry._path ?? entry.path ?? ""), ".json")));
  const acceptedWithoutSource = accepted.filter((entry) => !sourcePath(entry));
  const acceptedMissingSource = [];
  for (const entry of accepted) {
    const source = sourcePath(entry);
    if (source && !(await pathExists(path.join(dataRoot, source.replace(/\//g, path.sep))))) acceptedMissingSource.push(entry);
  }
  const retryCandidates = [...candidateWithoutReview, ...acceptedWithoutSource, ...acceptedMissingSource].slice(0, 10);
  const status = retryCandidates.length > 0 || reviews.length > 0 ? "warning" : "ready";
  return {
    status,
    counts: {
      candidates: candidates.length,
      accepted: accepted.length,
      promotion_reviews: reviews.length,
      quarantined: quarantines.length,
      candidate_without_review: candidateWithoutReview.length,
      accepted_without_source: acceptedWithoutSource.length,
      accepted_missing_source: acceptedMissingSource.length,
    },
    candidates: candidates.slice(0, 12),
    promotion_reviews: reviews.slice(0, 12),
    accepted: accepted.slice(0, 12),
    quarantines: quarantines.slice(0, 8),
    retry_candidates: retryCandidates,
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
    readEvents(),
    readJsonDir(".dino/tasks", 80, (task) => task.status === "started"),
    readJsonDir(".dino/context-packs"),
    readJsonDir(".dino/traces"),
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
  const addNode = (node) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    nodes.push({ count: 1, color: graphColor(node), ...node });
  };
  const addEdge = (source, target, type) => {
    if (seen.has(source) && seen.has(target)) edges.push({ source, target, type });
  };

  const tasks = Array.isArray(operationState?.tasks) ? operationState.tasks : [];
  const events = Array.isArray(operationState?.events) ? operationState.events : [];
  const packs = Array.isArray(operationState?.context_packs) ? operationState.context_packs : [];
  const activeTasks = tasks.filter((task) => task.status === "started");
  const displayedTasks = [...activeTasks, ...tasks.filter((task) => task.status !== "started")].slice(0, 14);
  const displayedPacks = packs.slice(0, 8);
  const displayedEvents = events.slice(0, 18);
  const rootId = "activity:root";

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
    addEdge(rootId, nodeId, "context_pack");
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

  return {
    ...wikiGraph,
    index_mode: `${wikiGraph.index_mode}+operations_activity_v1`,
    stats: {
      ...wikiGraph.stats,
      nodes: nodes.length,
      edges: edges.length,
      shown_nodes: nodes.length,
      shown_edges: edges.length,
      operation_nodes: nodes.length - wikiGraph.nodes.length,
      active_tasks: activeTasks.length,
    },
    nodes,
    edges,
  };
}

async function state() {
  const [audits, live, sqlite, graphHealth, lifecycle, syncRisk] = await Promise.all([
    readAuditLogs(),
    readLiveOperations(),
    readSqliteOperations(),
    readGraphHealth(),
    readLifecycleQueue(),
    readSyncRisk(),
  ]);
  const decorate = (payload) => ({
    ...payload,
    summary: {
      ...payload.summary,
      graph_health_status: graphHealth.status,
      graph_health_score: graphHealth.score,
      lifecycle_status: lifecycle.status,
      sync_risk_status: syncRisk.status,
    },
    graph_health: graphHealth,
    lifecycle,
    sync_risk: syncRisk,
    read_trace: readTraceSummary(payload.events, payload.context_packs, payload.traces),
  });
  if (sqlite) {
    const events = mergeEvents(sqlite.events, live.events, 120);
    const tasks = mergeByPath(sqlite.tasks, live.tasks, 80);
    const contextPacks = mergeByPath(sqlite.context_packs, live.context_packs, 80);
    const traces = mergeByPath(sqlite.traces, live.traces, 80).map(withTraceDisplay);
    return decorate({
      ok: true,
      summary: {
        data_root: dataRoot,
        generated_at: sqlite.generated_at,
        index_mode: `${sqlite.index_mode}+live_files`,
        event_count: Math.max(sqlite.counts.events, events.length),
        task_count: Math.max(sqlite.counts.tasks, tasks.length),
        context_pack_count: Math.max(sqlite.counts.context_packs, contextPacks.length),
        memory_audit_count: audits.length,
        today_event_count: events.filter((event) => String(event.at ?? "").startsWith(new Date().toISOString().slice(0, 10))).length,
        active_task_count: tasks.filter((task) => task.status === "started").length,
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
    const events = mergeEvents(index.recent_events ?? [], live.events, 120);
    const tasks = mergeByPath((index.recent_tasks ?? []).map(withDisplayPath), live.tasks, 80);
    const contextPacks = mergeByPath((index.recent_context_packs ?? []).map(withDisplayPath), live.context_packs, 80);
    const traces = mergeByPath((index.recent_traces ?? []).map(withTraceDisplay), live.traces, 80).map(withTraceDisplay);
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
        memory_audit_count: audits.length,
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
    summary: { ...summarize(live.events.slice().reverse(), live.tasks, live.context_packs), memory_audit_count: audits.length },
    events: live.events,
    tasks: live.tasks,
    context_packs: live.context_packs,
    traces: live.traces,
    memory_audits: audits,
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
    #graph-search {
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
    .graph-wrap {
      position: relative;
      height: clamp(500px, 61vh, 720px);
      min-height: 500px;
      background:
        radial-gradient(circle at 46% 52%, rgba(240, 168, 58, .10), transparent 23%),
        radial-gradient(circle at 83% 16%, rgba(79, 182, 164, .08), transparent 18%),
        linear-gradient(0deg, rgba(230, 220, 194, .04) 1px, transparent 1px),
        linear-gradient(90deg, rgba(230, 220, 194, .025) 1px, transparent 1px),
        repeating-linear-gradient(176deg, rgba(217, 154, 61, .045) 0 2px, transparent 2px 38px),
        linear-gradient(180deg, #070b08 0%, #0d140e 48%, #070907 100%);
      background-size: auto, auto, 44px 44px, 44px 44px, auto, auto;
    }
    #wiki-graph {
      display: block;
      width: 100%;
      height: 100%;
      background: transparent;
    }
    #graph-focus {
      position: absolute;
      left: 12px;
      right: 12px;
      bottom: 10px;
      pointer-events: none;
      color: #d8cdae;
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-shadow: 0 1px 2px rgba(0, 0, 0, .75);
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
      #graph-search { width: 100%; }
      .graph-wrap { height: clamp(380px, 62vh, 520px); min-height: 380px; }
      .details { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <h1>DinoBrain Observatory</h1>
    <div class="toolbar"><span class="dot"></span><span id="status">connecting</span><code id="root"></code></div>
  </header>
  <nav class="health-strip" aria-label="DinoBrain OS health">
    <div id="chip-active" class="chip"><strong>Active</strong><span>--</span></div>
    <div id="chip-mcp" class="chip"><strong>MCP</strong><span>--</span></div>
    <div id="chip-read" class="chip"><strong>Read Trace</strong><span>--</span></div>
    <div id="chip-lifecycle" class="chip"><strong>Lifecycle</strong><span>--</span></div>
    <div id="chip-graph" class="chip"><strong>Graph Health</strong><span>--</span></div>
    <div id="chip-sync" class="chip"><strong>GitHub Sync</strong><span>--</span></div>
  </nav>
  <main>
    <section>
      <div class="stats">
        <div class="stat"><strong id="stat-events">0</strong><span>events</span></div>
        <div class="stat"><strong id="stat-tasks">0</strong><span>tasks</span></div>
        <div class="stat"><strong id="stat-packs">0</strong><span>context packs</span></div>
        <div class="stat"><strong id="stat-audits">0</strong><span>memory audits</span></div>
        <div class="stat"><strong id="stat-active">0</strong><span>active tasks</span></div>
      </div>
      <div class="graph-panel">
        <div class="graph-head">
          <h2>DinoBrain Fossil Graph</h2>
          <div class="graph-meta">
            <span id="graph-stats">0 nodes / 0 edges</span>
            <span class="graph-legend">
              <span class="legend-chip"><span class="legend-dot" style="background:#e6dcc2"></span>record</span>
              <span class="legend-chip"><span class="legend-dot" style="background:#4fb6a4"></span>folder</span>
              <span class="legend-chip"><span class="legend-dot" style="background:#7cc66a"></span>tag</span>
              <span class="legend-chip"><span class="legend-dot" style="background:#d99a3d"></span>core</span>
              <span class="legend-chip"><span class="legend-dot" style="background:#ffcc66"></span>active</span>
            </span>
            <input id="graph-search" placeholder="Search">
          </div>
        </div>
        <div class="graph-wrap">
          <canvas id="wiki-graph"></canvas>
          <div id="graph-focus"></div>
        </div>
      </div>
      <div id="timeline" class="timeline"></div>
    </section>
    <section class="details">
      <div class="block">
        <h2>OS Health</h2>
        <div id="os-health" class="kv"></div>
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
        <h2>Sync Risk</h2>
        <div id="sync-risk" class="kv"></div>
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
      </div>
    </section>
  </main>
  <script>
    const statusEl = document.getElementById("status");
    const rootEl = document.getElementById("root");
    const timelineEl = document.getElementById("timeline");
    const latestTaskEl = document.getElementById("latest-task");
    const activeTasksEl = document.getElementById("active-tasks");
    const latestPackEl = document.getElementById("latest-pack");
    const latestTraceEl = document.getElementById("latest-trace");
    const latestAuditEl = document.getElementById("latest-audit");
    const osHealthEl = document.getElementById("os-health");
    const readTraceEl = document.getElementById("read-trace");
    const readTraceItemsEl = document.getElementById("read-trace-items");
    const nodeLifecycleEl = document.getElementById("node-lifecycle");
    const lifecycleRetryEl = document.getElementById("lifecycle-retry");
    const syncRiskEl = document.getElementById("sync-risk");
    const chips = {
      active: document.getElementById("chip-active"),
      mcp: document.getElementById("chip-mcp"),
      read: document.getElementById("chip-read"),
      lifecycle: document.getElementById("chip-lifecycle"),
      graph: document.getElementById("chip-graph"),
      sync: document.getElementById("chip-sync"),
    };
    const graphCanvas = document.getElementById("wiki-graph");
    const graphCtx = graphCanvas.getContext("2d");
    const graphStatsEl = document.getElementById("graph-stats");
    const graphFocusEl = document.getElementById("graph-focus");
    const graphSearchEl = document.getElementById("graph-search");
    let graphNodes = [];
    let graphEdges = [];
    let graphSignature = "";
    let graphMouse = { x: -9999, y: -9999 };
    let graphSearch = "";
    const formatTime = (value) => value ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "--";
    const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    const compact = (value, max = 180) => {
      const text = String(value ?? "").replace(/\\s+/g, " ").trim();
      return text.length > max ? text.slice(0, max - 3) + "..." : text;
    };
    function kv(target, rows) {
      target.innerHTML = rows.map(([key, value]) => \`<span>\${esc(key)}</span><code>\${esc(value ?? "--")}</code>\`).join("");
    }
    function renderChip(target, label, value, detail, tone) {
      target.className = "chip " + String(tone || "").replace(/[^a-z0-9_-]/gi, "");
      target.innerHTML = \`<strong>\${esc(label)} \${esc(value ?? "")}</strong><span>\${esc(detail ?? "")}</span>\`;
    }
    function healthTone(value) {
      const status = String(value ?? "").toLowerCase();
      if (["healthy", "ready", "clean", "grounded"].includes(status)) return status;
      if (["warning", "at_risk"].includes(status)) return status;
      if (["degraded", "index_error", "missing", "unknown"].includes(status)) return status;
      return "unknown";
    }
    function eventTitle(event) {
      return String(event.event || "event").replaceAll("_", " ");
    }
    function eventDetail(event) {
      return event.prompt_preview || event.audit_id || event.task_id || event.pack_id || event.trace_path || event.context_pack_trace || event.path || event.error || "";
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
      if (node.type === "root") return 9.5;
      if (node.type === "activity_root") return 10.2;
      if (node.type === "active_task") return 8.4;
      if (node.type === "task") return 6.1;
      if (node.type === "context_pack") return 5.9;
      if (node.type === "event") return 3.8;
      if (node.type === "folder") return 6.8;
      if (node.type === "tag") return 5.9;
      if (node.type === "kind") return 5.7;
      if (node.type === "record") return 5.1;
      return 4.2;
    }
    function graphNodeStroke(node, active) {
      if (active) return "rgba(238, 230, 210, .98)";
      if (node.type === "record") return "rgba(84, 70, 44, .9)";
      if (node.type === "active_task") return "rgba(255, 231, 154, .98)";
      if (node.type === "activity_root") return "rgba(245, 188, 91, .98)";
      if (node.type === "task") return "rgba(217, 154, 61, .78)";
      if (node.type === "context_pack") return "rgba(138, 199, 255, .74)";
      if (node.type === "event") return "rgba(185, 154, 105, .58)";
      if (node.type === "root") return "rgba(245, 188, 91, .95)";
      if (node.type === "tag") return "rgba(138, 216, 119, .78)";
      if (node.type === "folder") return "rgba(101, 212, 192, .78)";
      if (node.type === "kind") return "rgba(217, 154, 61, .78)";
      return "rgba(230, 220, 194, .38)";
    }
    function graphEdgeStyle(edge, active) {
      if (active) {
        return {
          color: edge.type === "has_tag" ? "rgba(124, 198, 106, .82)" : "rgba(255, 204, 102, .9)",
          width: 1.65,
          bead: true,
        };
      }
      if (edge.type === "active_task") return { color: "rgba(255, 204, 102, .46)", width: 1.8, bead: true, moving: true };
      if (edge.type === "task_event") return { color: "rgba(185, 154, 105, .28)", width: 1.1, bead: true, moving: true };
      if (edge.type === "context_pack") return { color: "rgba(138, 199, 255, .24)", width: 1.1, bead: true, moving: false };
      if (edge.type === "wiki_link") return { color: "rgba(230, 220, 194, .28)", width: 1.15, bead: true };
      if (edge.type === "has_tag") return { color: "rgba(124, 198, 106, .20)", width: 1, bead: false };
      if (edge.type === "in_folder") return { color: "rgba(79, 182, 164, .18)", width: 1, bead: false };
      return { color: "rgba(190, 154, 91, .17)", width: 1, bead: false };
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
    function graphPointOnPath(points, t) {
      if (!points.length) return { x: .5, y: .5 };
      if (points.length === 1) return { x: points[0][0], y: points[0][1] };
      const segments = [];
      let total = 0;
      for (let i = 0; i < points.length - 1; i += 1) {
        const a = points[i];
        const b = points[i + 1];
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        segments.push({ a, b, length });
        total += length;
      }
      let remaining = Math.max(0, Math.min(1, t)) * total;
      for (const segment of segments) {
        if (remaining <= segment.length || segment === segments[segments.length - 1]) {
          const local = segment.length ? remaining / segment.length : 0;
          return {
            x: segment.a[0] + (segment.b[0] - segment.a[0]) * local,
            y: segment.a[1] + (segment.b[1] - segment.a[1]) * local,
          };
        }
        remaining -= segment.length;
      }
      const last = points[points.length - 1];
      return { x: last[0], y: last[1] };
    }
    function graphPoseJitter(node, pose, amount = .018) {
      const jitterX = (graphUnit(node.id + ":x") - .5) * amount;
      const jitterY = (graphUnit(node.id + ":y") - .5) * amount;
      return {
        x: Math.max(.025, Math.min(.975, pose.x + jitterX)),
        y: Math.max(.035, Math.min(.965, pose.y + jitterY)),
      };
    }
    function graphDinoPart(node, index) {
      const label = String(node.label || node.path || node.id || "").toLowerCase();
      if (node.type === "activity_root" || node.type === "root") return "heart";
      if (node.type === "active_task") return "shoulder";
      if (node.type === "folder") {
        if (label.includes("30_sources") || label.includes("source")) return "head";
        if (label.includes("20_wiki") || label.includes("wiki")) return "skull";
        if (label.includes("40_projects") || label.includes("project")) return "throat";
        if (label.includes("50_instances") || label.includes("instance")) return "front-leg";
        if (label.includes("60_operations") || label.includes("operation")) return "hind-foot";
        return "spine";
      }
      if (node.type === "context_pack") return "back";
      if (node.type === "active_task" || node.type === "task") return "body";
      if (node.type === "kind") return index % 4 === 0 ? "front-leg" : "rib";
      if (node.type === "tag") return index % 4 === 0 ? "outline" : index % 4 === 1 ? "front-leg" : "rib";
      if (node.type === "event") return index % 5 === 0 ? "tail" : index % 5 === 1 ? "belly" : index % 5 === 2 ? "hind-foot" : index % 5 === 3 ? "front-leg" : "body";
      if (node.type === "record") {
        const bucket = graphHash(node.id) % 6;
        return ["outline", "tail", "belly", "back", "mid-leg", "front-leg"][bucket];
      }
      return "body";
    }
    function graphDinoPose(node, ordinal, total, index, graphTotal) {
      const label = String(node.label || "").toLowerCase();
      if (node.type === "folder") {
        if (label.includes("30_sources") || label.includes("source")) return { x: .965, y: .055, part: "head", lock: .13 };
        if (label.includes("20_wiki") || label.includes("wiki")) return { x: .915, y: .12, part: "skull", lock: .125 };
        if (label.includes("40_projects") || label.includes("project")) return { x: .86, y: .245, part: "throat", lock: .118 };
        if (label.includes("50_instances") || label.includes("instance")) return { x: .67, y: .705, part: "front-leg", lock: .095 };
        if (label.includes("60_operations") || label.includes("operation")) return { x: .40, y: .94, part: "hind-foot", lock: .095 };
      }
      if (node.type === "activity_root" || node.type === "root") return { x: .42, y: .50, part: "heart", lock: .105 };
      if (node.type === "active_task") return { x: .62, y: .49, part: "shoulder", lock: .095 };
      const part = node.dinoPart || graphDinoPart(node, index);
      const t = total <= 1 ? .5 : ordinal / Math.max(1, total - 1);
      const allT = graphTotal <= 1 ? .5 : index / Math.max(1, graphTotal - 1);
      const paths = {
        outline: [[.02, .75], [.105, .745], [.215, .675], [.33, .535], [.43, .39], [.57, .37], [.705, .315], [.79, .205], [.86, .075], [.975, .055]],
        spine: [[.18, .64], [.31, .52], [.45, .385], [.60, .38], [.72, .31], [.815, .18], [.92, .10]],
        back: [[.205, .60], [.34, .48], [.50, .38], [.64, .38], [.765, .265], [.88, .12]],
        tail: [[.02, .79], [.105, .775], [.21, .71], [.31, .61], [.39, .555]],
        belly: [[.30, .645], [.43, .695], [.56, .66], [.69, .565]],
        body: [[.31, .545], [.415, .455], [.54, .455], [.665, .53], [.595, .63], [.425, .635]],
        rib: [[.34, .525], [.45, .465], [.57, .475], [.69, .525], [.565, .635], [.40, .625]],
        "mid-leg": [[.45, .58], [.44, .75], [.41, .94]],
        "front-leg": [[.625, .555], [.695, .745], [.75, .94]],
        "hind-foot": [[.35, .60], [.305, .775], [.255, .94]],
        shoulder: [[.595, .465], [.685, .42], [.75, .315]],
        throat: [[.705, .38], [.79, .255], [.87, .145]],
        head: [[.84, .075], [.91, .035], [.985, .055]],
        skull: [[.84, .13], [.91, .105], [.965, .125]],
        heart: [[.39, .49], [.43, .50], [.485, .525]],
      };
      if (part === "body") {
        const angle = allT * Math.PI * 2;
        return graphPoseJitter(node, {
          x: .485 + Math.cos(angle) * (.16 + graphUnit(node.id + ":body") * .045),
          y: .54 + Math.sin(angle) * (.12 + graphUnit(node.id + ":body-y") * .045),
        }, .022);
      }
      if (part === "rib") {
        const ribIndex = ordinal % 6;
        const ribT = (Math.floor(ordinal / 6) + .5) / Math.max(1, Math.ceil(total / 6));
        return graphPoseJitter(node, {
          x: .325 + ribIndex * .073,
          y: .465 + ribT * .24 + Math.sin(ribIndex * 1.7) * .03,
        }, .012);
      }
      if (part === "belly") {
        return graphPoseJitter(node, graphPointOnPath(paths.belly, t), .016);
      }
      const point = graphPointOnPath(paths[part] || paths.body, t);
      return graphPoseJitter(node, point, part === "outline" || part === "tail" ? .012 : .018);
    }
    function graphDinoTarget(node, size) {
      const padX = Math.max(28 * size.dpr, size.width * .035);
      const padY = Math.max(26 * size.dpr, size.height * .055);
      return {
        x: padX + node.poseX * (size.width - padX * 2),
        y: padY + node.poseY * (size.height - padY * 2),
      };
    }
    function graphShouldLabel(node, active) {
      if (active) return true;
      if (node.type === "activity_root" || node.type === "root") return true;
      if (node.type === "active_task") return node.dinoOrdinal === 0;
      if (node.type !== "folder") return false;
      const label = String(node.label || "");
      return /^(20|30|40|50|60)_/i.test(label) || /wiki|source|project|instance|operation/i.test(label);
    }
    function matchesGraphSearch(node) {
      if (!graphSearch) return false;
      const haystack = [node.label, node.path, node.type].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(graphSearch);
    }
    function renderGraph(graph) {
      graphStatsEl.textContent = graph.ok
        ? graph.stats.shown_nodes + "/" + graph.stats.nodes + " nodes / " + graph.stats.shown_edges + "/" + graph.stats.edges + " edges" + (graph.stats.active_tasks ? " / active " + graph.stats.active_tasks : "")
        : "index missing";
      const signature = graph.nodes.map((node) => [node.id, node.type, node.label, node.status, node.updated_at].join(":")).join("\\n") + "\\n---\\n" + graph.edges.map((edge) => edge.source + ">" + edge.target + ":" + edge.type).join("\\n");
      if (signature === graphSignature) return;
      graphSignature = signature;
      const size = graphSize();
      const previous = new Map(graphNodes.map((node) => [node.id, node]));
      const prepared = graph.nodes.map((node, index) => ({ ...node, dinoPart: graphDinoPart(node, index) }));
      const partCounts = new Map();
      for (const node of prepared) partCounts.set(node.dinoPart, (partCounts.get(node.dinoPart) || 0) + 1);
      const partSeen = new Map();
      graphNodes = prepared.map((node, index) => {
        const old = previous.get(node.id);
        const ordinal = partSeen.get(node.dinoPart) || 0;
        partSeen.set(node.dinoPart, ordinal + 1);
        const pose = graphDinoPose(node, ordinal, partCounts.get(node.dinoPart) || 1, index, prepared.length);
        const target = graphDinoTarget({ poseX: pose.x, poseY: pose.y }, size);
        const driftX = (graphUnit(node.id + ":start-x") - .5) * 22 * size.dpr;
        const driftY = (graphUnit(node.id + ":start-y") - .5) * 22 * size.dpr;
        return {
          ...node,
          x: old?.x ?? target.x + driftX,
          y: old?.y ?? target.y + driftY,
          vx: old?.vx ?? 0,
          vy: old?.vy ?? 0,
          poseX: pose.x,
          poseY: pose.y,
          poseLock: pose.lock ?? .074,
          dinoPart: pose.part || node.dinoPart,
          dinoOrdinal: ordinal,
          r: graphRadius(node),
        };
      });
      const byId = new Map(graphNodes.map((node) => [node.id, node]));
      graphEdges = graph.edges
        .map((edge) => ({ ...edge, sourceNode: byId.get(edge.source), targetNode: byId.get(edge.target) }))
        .filter((edge) => edge.sourceNode && edge.targetNode);
    }
    function stepGraph() {
      const size = graphSize();
      const centerX = size.width / 2;
      const centerY = size.height / 2;
      const now = performance.now();
      for (let edgeIndex = 0; edgeIndex < graphEdges.length; edgeIndex += 1) {
        const edge = graphEdges[edgeIndex];
        const a = edge.sourceNode;
        const b = edge.targetNode;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const target = edge.type === "wiki_link" ? 76 : edge.type === "active_task" ? 92 : 108;
        const force = (distance - target * size.dpr) * 0.00009;
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
          const force = Math.min(0.42, 160 / distanceSq);
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
        const target = graphDinoTarget(node, size);
        node.targetX = target.x;
        node.targetY = target.y;
        node.vx += (target.x - node.x) * node.poseLock;
        node.vy += (target.y - node.y) * node.poseLock;
        node.vx += (centerX - node.x) * 0.00002;
        node.vy += (centerY - node.y) * 0.000015;
        node.vx *= 0.72;
        node.vy *= 0.72;
        const margin = Math.max(18 * size.dpr, 18);
        node.x = Math.max(margin, Math.min(size.width - margin, node.x + node.vx));
        node.y = Math.max(margin, Math.min(size.height - margin, node.y + node.vy));
      }
    }
    function drawGraph() {
      const size = graphSize();
      const now = performance.now();
      graphCtx.clearRect(0, 0, size.width, size.height);
      let focus = null;
      const labelBoxes = [];
      for (let edgeIndex = 0; edgeIndex < graphEdges.length; edgeIndex += 1) {
        const edge = graphEdges[edgeIndex];
        const a = edge.sourceNode;
        const b = edge.targetNode;
        const highlighted = matchesGraphSearch(a) || matchesGraphSearch(b);
        const style = graphEdgeStyle(edge, highlighted);
        graphCtx.lineWidth = Math.max(1, style.width * size.dpr);
        graphCtx.strokeStyle = style.color;
        graphCtx.beginPath();
        graphCtx.moveTo(a.x, a.y);
        graphCtx.lineTo(b.x, b.y);
        graphCtx.stroke();
        if (style.bead) {
          const beadT = style.moving ? ((now / 1150 + edgeIndex * 0.071) % 1) : 0.5;
          const midX = a.x + (b.x - a.x) * beadT;
          const midY = a.y + (b.y - a.y) * beadT;
          graphCtx.beginPath();
          graphCtx.fillStyle = highlighted ? "rgba(238, 230, 210, .82)" : "rgba(230, 220, 194, .22)";
          graphCtx.arc(midX, midY, highlighted || style.moving ? 2.2 * size.dpr : 1.4 * size.dpr, 0, Math.PI * 2);
          graphCtx.fill();
        }
      }
      for (const node of graphNodes) {
        const highlighted = matchesGraphSearch(node);
        const hovered = Math.hypot(node.x - graphMouse.x, node.y - graphMouse.y) <= node.r + 5;
        if (hovered || highlighted) focus = node;
        const active = highlighted || hovered;
        const livePulse = node.type === "active_task" || node.type === "activity_root";
        const pulse = livePulse ? 1.6 + Math.sin(now / 260 + node.x * 0.01) * 1.2 : 0;
        const radius = active ? node.r + 2.4 : node.r + Math.max(0, pulse * 0.35);
        if (active || livePulse) {
          graphCtx.beginPath();
          graphCtx.fillStyle = node.type === "tag" ? "rgba(124, 198, 106, .14)" : "rgba(217, 154, 61, .16)";
          graphCtx.arc(node.x, node.y, radius + (6 + pulse) * size.dpr, 0, Math.PI * 2);
          graphCtx.fill();
        }
        graphCtx.beginPath();
        graphCtx.fillStyle = node.color || "#c5d5e8";
        graphCtx.globalAlpha = graphSearch && !highlighted && !hovered ? 0.35 : 0.95;
        graphCtx.arc(node.x, node.y, radius, 0, Math.PI * 2);
        graphCtx.fill();
        graphCtx.lineWidth = Math.max(1, (node.type === "root" ? 2 : 1.25) * size.dpr);
        graphCtx.strokeStyle = graphNodeStroke(node, active);
        graphCtx.stroke();
        if (node.type === "record" || node.type === "root" || node.type === "activity_root" || node.type === "active_task") {
          graphCtx.beginPath();
          graphCtx.globalAlpha = graphSearch && !highlighted && !hovered ? 0.28 : 0.9;
          graphCtx.strokeStyle = node.type === "root" ? "rgba(91, 55, 20, .68)" : "rgba(91, 78, 54, .54)";
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
          const labelX = rightSide ? node.x + node.r + 8 * size.dpr : node.x + node.r + 5 * size.dpr;
          const labelY = node.y - node.r - (node.type === "folder" ? 6 * size.dpr : 2);
          const box = {
            x: labelX - 5,
            y: labelY - 15 * size.dpr,
            width: graphCtx.measureText(label).width + 12,
            height: 22 * size.dpr,
          };
          const overlaps = labelBoxes.some((other) =>
            box.x < other.x + other.width &&
            box.x + box.width > other.x &&
            box.y < other.y + other.height &&
            box.y + box.height > other.y
          );
          if (active || !overlaps) {
            graphCtx.fillStyle = active ? "#fff1c2" : "#e6dcc2";
            graphCtx.shadowColor = active ? "rgba(255, 204, 102, .42)" : "rgba(0, 0, 0, .75)";
            graphCtx.shadowBlur = active ? 9 * size.dpr : 4 * size.dpr;
            graphCtx.fillText(label, labelX, labelY);
            graphCtx.shadowBlur = 0;
            labelBoxes.push(box);
          }
        }
      }
      graphFocusEl.textContent = focus ? [focus.type, focus.path || focus.label].filter(Boolean).join(" / ") : "";
    }
    function animateGraph() {
      stepGraph();
      drawGraph();
      requestAnimationFrame(animateGraph);
    }
    graphSearchEl.addEventListener("input", () => {
      graphSearch = graphSearchEl.value.trim().toLowerCase();
    });
    graphCanvas.addEventListener("mousemove", (event) => {
      const rect = graphCanvas.getBoundingClientRect();
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      graphMouse = { x: (event.clientX - rect.left) * dpr, y: (event.clientY - rect.top) * dpr };
    });
    graphCanvas.addEventListener("mouseleave", () => {
      graphMouse = { x: -9999, y: -9999 };
    });
    window.addEventListener("resize", graphSize);
    requestAnimationFrame(animateGraph);
    function render(data) {
      statusEl.textContent = "live - " + formatTime(data.summary.generated_at);
      rootEl.textContent = data.summary.data_root;
      document.getElementById("stat-events").textContent = data.summary.event_count;
      document.getElementById("stat-tasks").textContent = data.summary.task_count;
      document.getElementById("stat-packs").textContent = data.summary.context_pack_count;
      document.getElementById("stat-audits").textContent = data.summary.memory_audit_count ?? 0;
      document.getElementById("stat-active").textContent = data.summary.active_task_count;
      const graphHealth = data.graph_health || {};
      const lifecycle = data.lifecycle || { counts: {} };
      const readTrace = data.read_trace || {};
      const syncRisk = data.sync_risk || {};
      renderChip(
        chips.active,
        "Active",
        data.summary.active_task_count || "0",
        data.summary.active_task_count ? "task loop is open" : "idle",
        data.summary.active_task_count ? "warning" : "ready",
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
        "review " + (lifecycle.counts?.promotion_reviews ?? 0) + " / accepted " + (lifecycle.counts?.accepted ?? 0),
        healthTone(lifecycle.status),
      );
      renderChip(
        chips.graph,
        "Graph",
        graphHealth.score ?? "--",
        graphHealth.status || "missing",
        healthTone(graphHealth.status),
      );
      renderChip(
        chips.sync,
        "Sync",
        syncRisk.status || "--",
        (syncRisk.dirty_count ?? 0) + " dirty / " + (syncRisk.untracked_count ?? 0) + " untracked",
        healthTone(syncRisk.status),
      );
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
        ["candidates", lifecycle.counts?.candidates],
        ["review", lifecycle.counts?.promotion_reviews],
        ["accepted", lifecycle.counts?.accepted],
        ["quarantined", lifecycle.counts?.quarantined],
        ["source missing", lifecycle.counts?.accepted_without_source],
        ["retry", Array.isArray(lifecycle.retry_candidates) ? lifecycle.retry_candidates.length : 0],
      ]);
      lifecycleRetryEl.innerHTML = Array.isArray(lifecycle.retry_candidates) && lifecycle.retry_candidates.length
        ? lifecycle.retry_candidates.slice(0, 6).map((item) => \`
          <div class="item"><code>\${esc(item._path || item.path || item.candidate_id || item.review_id || "")}</code><div class="muted">\${esc(compact(item.claim || item.title || item.notes || "", 140))}</div></div>
        \`).join("")
        : '<p class="muted">No retry candidates.</p>';
      kv(syncRiskEl, [
        ["status", syncRisk.status],
        ["branch", syncRisk.branch],
        ["dirty", syncRisk.dirty_count],
        ["staged", syncRisk.staged_count],
        ["untracked", syncRisk.untracked_count],
        ["detail", Array.isArray(syncRisk.detail) ? syncRisk.detail.join(" | ") : syncRisk.detail],
      ]);
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
    async function tick() {
      try {
        const [stateResponse, graphResponse] = await Promise.all([
          fetch("/api/state", { cache: "no-store" }),
          fetch("/api/graph", { cache: "no-store" }),
        ]);
        render(await stateResponse.json());
        renderGraph(await graphResponse.json());
      } catch (error) {
        statusEl.textContent = "disconnected";
      }
    }
    tick();
    setInterval(tick, 1200);
  </script>
</body>
</html>`;
}

const server = http.createServer(async (request, response) => {
  if (request.url === "/api/health") {
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify({
      ok: true,
      observatory_version: observatoryVersion,
      app_root: root,
      data_root: dataRoot,
      graph_health: await readGraphHealth(),
      endpoints: ["/api/health", "/api/state", "/api/graph", "/api/graph-health"],
    }, null, 2));
    return;
  }

  if (request.url === "/api/graph-health") {
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify(await readGraphHealth(), null, 2));
    return;
  }

  if (request.url === "/api/state") {
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify(await state(), null, 2));
    return;
  }

  if (request.url === "/api/graph") {
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify(withActivityGraph(await readWikiGraph(), await state()), null, 2));
    return;
  }

  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(html());
});

server.listen(port, host, () => {
  console.log(JSON.stringify({ ok: true, url: `http://${host}:${port}/`, data_root: dataRoot }, null, 2));
});
