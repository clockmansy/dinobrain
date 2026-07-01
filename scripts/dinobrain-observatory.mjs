import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(root, "..", "dinobrain-data"));
const host = process.env.DINOBRAIN_OBSERVATORY_HOST ?? "127.0.0.1";
const port = Number(process.env.DINOBRAIN_OBSERVATORY_PORT ?? process.argv.find((arg) => arg.startsWith("--port="))?.split("=")[1] ?? 3847);

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
    root: "#6aa9ff",
    folder: "#50d890",
    tag: "#2dd4bf",
    kind: "#f2bc57",
    record: "#b394ff",
    wikilink: "#91a1b4",
  };
  return colors[node.type] ?? "#c5d5e8";
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

async function readJsonDir(relativeDir, limit = 50) {
  const dir = path.join(dataRoot, relativeDir);
  const files = await readDirFiles(dir, ".json");
  const records = [];
  for (const file of files) {
    const value = await readJson(file);
    if (value) records.push({ ...value, _path: rel(file) });
  }
  return records
    .sort((a, b) =>
      String(b.updated_at ?? b.created_at ?? b.finished_at ?? b.audited_at ?? "").localeCompare(
        String(a.updated_at ?? a.created_at ?? a.finished_at ?? a.audited_at ?? ""),
      ),
    )
    .slice(0, limit);
}

async function readAuditLogs(limit = 50) {
  return await readJsonDir(".dino/audits", limit);
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

async function state() {
  const audits = await readAuditLogs();
  const sqlite = await readSqliteOperations();
  if (sqlite) {
    return {
      ok: true,
      summary: {
        data_root: dataRoot,
        generated_at: sqlite.generated_at,
        index_mode: sqlite.index_mode,
        event_count: sqlite.counts.events,
        task_count: sqlite.counts.tasks,
        context_pack_count: sqlite.counts.context_packs,
        memory_audit_count: audits.length,
        today_event_count: sqlite.events.filter((event) => String(event.at ?? "").startsWith(new Date().toISOString().slice(0, 10))).length,
        active_task_count: sqlite.tasks.filter((task) => task.status === "started").length,
        last_event_at: sqlite.events[0]?.at ?? null,
      },
      events: sqlite.events,
      tasks: sqlite.tasks,
      context_packs: sqlite.context_packs,
      traces: sqlite.traces,
      memory_audits: audits,
    };
  }

  const index = await readOperationIndex();
  if (index) {
    return {
      ok: true,
      summary: { ...summarizeIndex(index), memory_audit_count: audits.length },
      events: (index.recent_events ?? []).slice(0, 100),
      tasks: (index.recent_tasks ?? []).slice(0, 50).map(withDisplayPath),
      context_packs: (index.recent_context_packs ?? []).slice(0, 50).map(withDisplayPath),
      traces: (index.recent_traces ?? []).slice(0, 50).map(withTraceDisplay),
      memory_audits: audits,
    };
  }

  const [events, tasks, packs, traces] = await Promise.all([
    readEvents(),
    readJsonDir(".dino/tasks"),
    readJsonDir(".dino/context-packs"),
    readJsonDir(".dino/traces"),
  ]);
  return {
    ok: true,
    summary: { ...summarize(events, tasks, packs), memory_audit_count: audits.length },
    events: events.slice().reverse(),
    tasks,
    context_packs: packs,
    traces: traces.map(withTraceDisplay),
    memory_audits: audits,
  };
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
      --bg: #0b0f14;
      --panel: #111820;
      --line: #223041;
      --text: #e7eef7;
      --muted: #91a1b4;
      --blue: #6aa9ff;
      --green: #50d890;
      --amber: #f2bc57;
      --red: #ff6b6b;
      --violet: #b394ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
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
      background: #0d131a;
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
      color: #c5d5e8;
      font-family: "Cascadia Mono", Consolas, monospace;
      font-size: 12px;
      word-break: break-all;
    }
    main {
      display: grid;
      grid-template-columns: minmax(360px, 1.25fr) minmax(320px, 0.75fr);
      gap: 1px;
      min-height: calc(100vh - 57px);
      background: var(--line);
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
      background: var(--panel);
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
    .dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--green);
      display: inline-block;
      box-shadow: 0 0 16px rgba(80, 216, 144, .45);
    }
    .timeline {
      display: grid;
      gap: 10px;
    }
    .graph-panel {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      overflow: hidden;
      margin-bottom: 18px;
    }
    .graph-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
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
    #graph-search {
      width: min(220px, 34vw);
      min-width: 120px;
      height: 28px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #0b1118;
      color: var(--text);
      padding: 4px 8px;
      font: inherit;
    }
    .graph-wrap {
      position: relative;
      height: clamp(300px, 43vh, 520px);
      min-height: 300px;
    }
    #wiki-graph {
      display: block;
      width: 100%;
      height: 100%;
      background: #080c11;
    }
    #graph-focus {
      position: absolute;
      left: 12px;
      right: 12px;
      bottom: 10px;
      pointer-events: none;
      color: var(--muted);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .event {
      display: grid;
      grid-template-columns: 116px minmax(0, 1fr);
      gap: 12px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
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
    .task_started .badge { color: var(--green); border-color: rgba(80, 216, 144, .45); }
    .context_pack_created .badge { color: var(--blue); border-color: rgba(106, 169, 255, .45); }
    .task_finished .badge { color: var(--violet); border-color: rgba(179, 148, 255, .45); }
    .memory_use_audited .badge { color: var(--amber); border-color: rgba(242, 188, 87, .45); }
    .codex_preflight_failed .badge { color: var(--red); border-color: rgba(255, 107, 107, .45); }
    .details {
      display: grid;
      gap: 12px;
    }
    .block {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
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
      .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .event { grid-template-columns: 1fr; }
      header { align-items: flex-start; flex-direction: column; }
      .toolbar { white-space: normal; }
      .graph-head { align-items: flex-start; flex-direction: column; }
      #graph-search { width: 100%; }
    }
  </style>
</head>
<body>
  <header>
    <h1>DinoBrain Observatory</h1>
    <div class="toolbar"><span class="dot"></span><span id="status">connecting</span><code id="root"></code></div>
  </header>
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
          <h2>LLM Wiki Graph</h2>
          <div class="graph-meta"><span id="graph-stats">0 nodes / 0 edges</span><input id="graph-search" placeholder="Search"></div>
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
        <h2>Latest Task</h2>
        <div id="latest-task" class="kv"></div>
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
    const latestPackEl = document.getElementById("latest-pack");
    const latestTraceEl = document.getElementById("latest-trace");
    const latestAuditEl = document.getElementById("latest-audit");
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
      if (node.type === "root") return 8;
      if (node.type === "folder") return 6.5;
      if (node.type === "tag") return 5.8;
      if (node.type === "kind") return 5.4;
      if (node.type === "record") return 4.8;
      return 4.2;
    }
    function matchesGraphSearch(node) {
      if (!graphSearch) return false;
      const haystack = [node.label, node.path, node.type].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(graphSearch);
    }
    function renderGraph(graph) {
      graphStatsEl.textContent = graph.ok
        ? graph.stats.shown_nodes + "/" + graph.stats.nodes + " nodes / " + graph.stats.shown_edges + "/" + graph.stats.edges + " edges"
        : "index missing";
      const signature = graph.nodes.map((node) => node.id).join("\\n") + "\\n---\\n" + graph.edges.map((edge) => edge.source + ">" + edge.target + ":" + edge.type).join("\\n");
      if (signature === graphSignature) return;
      graphSignature = signature;
      const size = graphSize();
      const previous = new Map(graphNodes.map((node) => [node.id, node]));
      graphNodes = graph.nodes.map((node, index) => {
        const old = previous.get(node.id);
        const angle = (index / Math.max(1, graph.nodes.length)) * Math.PI * 2;
        const radius = Math.min(size.width, size.height) * 0.28;
        return {
          ...node,
          x: old?.x ?? size.width / 2 + Math.cos(angle) * radius,
          y: old?.y ?? size.height / 2 + Math.sin(angle) * radius,
          vx: old?.vx ?? 0,
          vy: old?.vy ?? 0,
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
      for (const edge of graphEdges) {
        const a = edge.sourceNode;
        const b = edge.targetNode;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const target = edge.type === "wiki_link" ? 78 : 112;
        const force = (distance - target) * 0.0009;
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
        node.vx += (centerX - node.x) * 0.0009;
        node.vy += (centerY - node.y) * 0.0009;
        node.vx *= 0.88;
        node.vy *= 0.88;
        node.x = Math.max(18, Math.min(size.width - 18, node.x + node.vx));
        node.y = Math.max(18, Math.min(size.height - 18, node.y + node.vy));
      }
    }
    function drawGraph() {
      const size = graphSize();
      graphCtx.clearRect(0, 0, size.width, size.height);
      graphCtx.lineWidth = Math.max(1, size.dpr);
      let focus = null;
      for (const edge of graphEdges) {
        const a = edge.sourceNode;
        const b = edge.targetNode;
        const highlighted = matchesGraphSearch(a) || matchesGraphSearch(b);
        graphCtx.strokeStyle = highlighted ? "rgba(106,169,255,.75)" : "rgba(145,161,180,.18)";
        graphCtx.beginPath();
        graphCtx.moveTo(a.x, a.y);
        graphCtx.lineTo(b.x, b.y);
        graphCtx.stroke();
      }
      for (const node of graphNodes) {
        const highlighted = matchesGraphSearch(node);
        const hovered = Math.hypot(node.x - graphMouse.x, node.y - graphMouse.y) <= node.r + 5;
        if (hovered || highlighted) focus = node;
        graphCtx.beginPath();
        graphCtx.fillStyle = node.color || "#c5d5e8";
        graphCtx.globalAlpha = graphSearch && !highlighted && !hovered ? 0.35 : 0.95;
        graphCtx.arc(node.x, node.y, highlighted || hovered ? node.r + 2.2 : node.r, 0, Math.PI * 2);
        graphCtx.fill();
        graphCtx.globalAlpha = 1;
        if (highlighted || hovered || node.type === "root") {
          graphCtx.fillStyle = "#e7eef7";
          graphCtx.font = Math.round(11 * size.dpr) + "px Segoe UI, sans-serif";
          graphCtx.fillText(node.label.slice(0, 34), node.x + node.r + 5, node.y - node.r - 2);
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
    response.end(JSON.stringify(await readWikiGraph(), null, 2));
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
