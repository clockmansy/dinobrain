/**
 * LC-03 graph adapter for the Observatory shell.
 *
 * The monolithic server owns fetching `/api/graph`; this module owns the
 * browser-side contract, layout, interaction state, and canvas widget.  It is
 * deliberately dependency-free so the shell can import it without changing
 * the evidence-graph index contract.
 */
export const OBSERVATORY_GRAPH_ADAPTER_VERSION = "observatory_graph_v1";
export const OBSERVATORY_GRAPH_MAX_RADIUS_PX = 8;

const GRAPH_WIDTH = 1000;
const GRAPH_HEIGHT = 640;
const FIT_PADDING = 56;
const LIVE_ACTIVITY_WINDOW_MS = 5 * 60 * 1000;

export const DEFAULT_REINDEX_ACTION = Object.freeze({
  id: "rebuild_evidence_graph",
  label: "증거 그래프 재색인",
  description: "로컬 evidence graph 인덱스를 다시 만들고 현재 화면을 새로 고칩니다.",
  command: "npm run graph:evidence",
  scope: "local_index_only",
});

const TYPE_ALIASES = new Map([
  ["source_snapshot", "source"],
  ["external_source", "source"],
  ["source", "source"],
  ["source_chunk", "chunk"],
  ["chunk", "chunk"],
  ["wiki_record", "claim"],
  ["claim", "claim"],
  ["memory", "memory"],
  ["behavior_rule", "memory"],
  ["task", "task"],
  ["trace", "trace"],
  ["context_pack", "context_pack"],
  ["project_record", "project"],
  ["project", "project"],
]);

const TYPE_GROUPS = {
  source: "evidence",
  chunk: "evidence",
  claim: "knowledge",
  memory: "knowledge",
  context_pack: "activity",
  task: "activity",
  trace: "activity",
  project: "project",
};

const GROUP_ANCHORS = {
  evidence: { x: 0.18, y: 0.34 },
  knowledge: { x: 0.48, y: 0.35 },
  activity: { x: 0.76, y: 0.35 },
  project: { x: 0.5, y: 0.76 },
  other: { x: 0.5, y: 0.13 },
};

export const OBSERVATORY_GRAPH_PALETTE = Object.freeze({
  source: "#4fb6a4",
  chunk: "#9bd6cb",
  claim: "#d99a3d",
  memory: "#7cc66a",
  context_pack: "#b99a69",
  task: "#c76f47",
  trace: "#e6dcc2",
  project: "#a49c87",
  other: "#a49c87",
});

export const OBSERVATORY_GRAPH_LEGEND_TYPES = Object.freeze([
  "source", "chunk", "claim", "memory", "task", "trace", "project",
]);

const LEGEND_LABELS = {
  source: "source",
  chunk: "chunk",
  claim: "claim",
  memory: "memory",
  task: "task",
  trace: "trace",
  project: "project",
};

const RELATION_COLORS = {
  source_to_chunk: "rgba(79, 182, 164, .68)",
  chunk_to_claim: "rgba(217, 154, 61, .72)",
  context_provided: "rgba(185, 154, 105, .66)",
  memory_declared_used: "rgba(124, 198, 106, .86)",
  memory_observed_used: "rgba(124, 198, 106, .98)",
  task_to_trace: "rgba(230, 220, 194, .8)",
  predecessor_to_successor: "rgba(79, 182, 164, .66)",
};

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asText(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function compactText(value, max = 120) {
  const text = asText(value).replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function canonicalType(node) {
  const raw = asText(node?.type, "record");
  if (TYPE_ALIASES.has(raw)) return TYPE_ALIASES.get(raw);
  if (asText(node?.path).startsWith("20_Wiki/")) return "claim";
  if (asText(node?.path).startsWith("40_Projects/")) return "project";
  return raw;
}

function inferEvidencePaths(record) {
  const details = record && typeof record.details === "object" && !Array.isArray(record.details) ? record.details : {};
  return unique([
    asText(record?.path),
    asText(record?.evidence_path),
    asText(details.evidence_path),
    asText(details.source_path),
    asText(details.source_uri),
  ]);
}

function normalizeNode(node, index) {
  const rawType = asText(node?.type, "record");
  const type = canonicalType(node);
  const details = node && typeof node.details === "object" && !Array.isArray(node.details) ? node.details : {};
  const lifecycle = asText(node?.lifecycle_state, asText(node?.lifecycle));
  const provenance = asText(node?.provenance_status, asText(node?.provenance, asText(details.verification_status)));
  const updatedAt = asText(node?.updated_at, asText(details.updated_at));
  const id = asText(node?.id, `generated:${stableHash(`${rawType}:${node?.path ?? index}`)}`);
  return {
    id,
    type,
    rawType,
    group: TYPE_GROUPS[type] ?? "other",
    label: compactText(asText(node?.label, asText(node?.path, id)), 92),
    path: asText(node?.path),
    lane: asText(node?.lane, "normal"),
    lifecycle,
    provenance,
    status: asText(node?.status),
    updatedAt,
    recentUse: asText(details.recent_use, asText(details.last_used_at, updatedAt)),
    evidencePaths: inferEvidencePaths(node),
    details,
    priority: Number.isFinite(Number(node?.priority)) ? Number(node.priority) : Number(node?.count ?? 1),
    weight: Number.isFinite(Number(node?.count)) ? Number(node.count) : 1,
  };
}

function normalizeEdge(edge, index, nodeIds) {
  const source = asText(edge?.source, asText(edge?.from_id));
  const target = asText(edge?.target, asText(edge?.to_id));
  if (!source || !target || !nodeIds.has(source) || !nodeIds.has(target)) return null;
  const details = edge && typeof edge.details === "object" && !Array.isArray(edge.details) ? edge.details : {};
  const type = asText(edge?.type, "related");
  return {
    id: asText(edge?.id, `edge:${stableHash(`${source}:${type}:${target}:${index}`)}`),
    source,
    target,
    type,
    evidencePath: asText(edge?.evidence_path, asText(details.evidence_path)),
    provenance: asText(edge?.provenance_status, asText(details.verification_status)),
    lane: asText(edge?.lane, "normal"),
    status: asText(edge?.status),
    updatedAt: asText(edge?.updated_at),
    details,
    priority: Number.isFinite(Number(edge?.priority)) ? Number(edge.priority) : 1,
  };
}

function emptyStateFor(payload, sourceError = null) {
  const stats = payload?.stats && typeof payload.stats === "object" ? payload.stats : {};
  const mode = asText(payload?.index_mode);
  const count = Number(stats.nodes ?? asArray(payload?.nodes).length ?? 0);
  if (sourceError) {
    return {
      code: "graph_request_failed",
      title: "지식 그래프를 읽지 못했습니다",
      reason: compactText(sourceError, 180),
      action: DEFAULT_REINDEX_ACTION,
    };
  }
  if (!payload || payload.ok === false || mode.includes("missing")) {
    return {
      code: "index_missing",
      title: "증거 그래프 인덱스가 없습니다",
      reason: "로컬 evidence graph 인덱스 파일을 찾을 수 없어 노드와 관계를 표시할 수 없습니다.",
      action: DEFAULT_REINDEX_ACTION,
    };
  }
  if (count === 0) {
    return {
      code: "index_empty",
      title: "증거 그래프가 아직 비어 있습니다",
      reason: "색인 가능한 source, chunk, claim, task, trace, project 기록이 아직 없습니다.",
      action: DEFAULT_REINDEX_ACTION,
    };
  }
  return null;
}

/**
 * Normalizes the evidence-graph HTTP DTO into the stable LC-03 adapter DTO.
 * It preserves raw types while exposing canonical source/chunk/claim/task/
 * trace/project types for rendering and filtering.
 */
export function normalizeObservatoryGraph(payload, { error = null } = {}) {
  const rawNodes = asArray(payload?.nodes);
  const nodes = rawNodes.map(normalizeNode);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = asArray(payload?.edges)
    .map((edge, index) => normalizeEdge(edge, index, nodeIds))
    .filter(Boolean);
  const emptyState = emptyStateFor(payload, error);
  const stats = payload?.stats && typeof payload.stats === "object" ? payload.stats : {};
  const sourceFilters = payload?.filters && typeof payload.filters === "object" ? payload.filters : {};
  return {
    version: OBSERVATORY_GRAPH_ADAPTER_VERSION,
    ok: !emptyState,
    indexMode: asText(payload?.index_mode, emptyState ? "evidence_graph_missing" : "evidence_graph_v1"),
    generatedAt: asText(payload?.generated_at),
    nodes,
    edges,
    stats: {
      nodes: Number(stats.nodes ?? nodes.length),
      edges: Number(stats.edges ?? edges.length),
      shownNodes: Number(stats.shown_nodes ?? nodes.length),
      shownEdges: Number(stats.shown_edges ?? edges.length),
      truncated: Boolean(stats.truncated),
    },
    filters: {
      types: unique(nodes.map((node) => node.type)).sort(),
      states: unique([...nodes.map((node) => node.lane), ...asArray(sourceFilters.lanes)]).sort(),
      lifecycle: unique([...nodes.map((node) => node.lifecycle), ...asArray(sourceFilters.lifecycle_states)]).sort(),
      provenance: unique([...nodes.map((node) => node.provenance), ...asArray(sourceFilters.provenance_statuses)]).sort(),
    },
    emptyState,
  };
}

function layoutNodes(nodes) {
  const groups = new Map();
  for (const node of nodes) {
    if (!groups.has(node.group)) groups.set(node.group, []);
    groups.get(node.group).push(node);
  }
  const positions = new Map();
  for (const [group, groupNodes] of groups) {
    const anchor = GROUP_ANCHORS[group] ?? GROUP_ANCHORS.other;
    const sorted = [...groupNodes].sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
    const radius = Math.max(54, Math.min(164, 31 * Math.sqrt(sorted.length)));
    sorted.forEach((node, index) => {
      const angle = (Math.PI * 2 * index) / Math.max(1, sorted.length) - Math.PI / 2 + (stableHash(node.id) % 17) * 0.015;
      const ring = index === 0 ? 0 : radius * (0.52 + ((index % 3) * 0.18));
      positions.set(node.id, {
        x: anchor.x * GRAPH_WIDTH + Math.cos(angle) * ring,
        y: anchor.y * GRAPH_HEIGHT + Math.sin(angle) * ring,
      });
    });
  }
  return positions;
}

function nodeMatches(node, filters) {
  if (filters.type !== "all" && node.type !== filters.type) return false;
  if (filters.state !== "all" && node.lane !== filters.state) return false;
  if (filters.lifecycle !== "all" && node.lifecycle !== filters.lifecycle) return false;
  if (filters.provenance !== "all" && node.provenance !== filters.provenance) return false;
  return true;
}

function searchMatches(node, query) {
  if (!query) return false;
  const haystack = [node.label, node.path, node.type, node.lifecycle, node.provenance, ...node.evidencePaths].join(" ").toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function adjacencyFor(edges) {
  const adjacency = new Map();
  for (const edge of edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, []);
    adjacency.get(edge.source).push({ id: edge.target, edge });
    adjacency.get(edge.target).push({ id: edge.source, edge });
  }
  return adjacency;
}

function evidencePath(selectedId, nodes, edges) {
  if (!selectedId) return { nodeIds: new Set(), edgeIds: new Set() };
  const taskTargets = nodes.filter((node) => node.type === "task").map((node) => node.id);
  const targets = new Set(taskTargets.length ? taskTargets : nodes.filter((node) => node.type === "trace").map((node) => node.id));
  if (targets.has(selectedId)) return { nodeIds: new Set([selectedId]), edgeIds: new Set() };
  const adjacency = adjacencyFor(edges);
  const relationCost = {
    memory_observed_used: 0.2,
    memory_declared_used: 0.3,
    task_to_trace: 0.3,
    source_to_chunk: 0.4,
    chunk_to_claim: 0.4,
    correction_to_rule: 0.5,
    predecessor_to_successor: 0.6,
    context_provided: 1.6,
  };
  const remaining = new Set(nodes.map((node) => node.id));
  const distance = new Map(nodes.map((node) => [node.id, Number.POSITIVE_INFINITY]));
  distance.set(selectedId, 0);
  const previous = new Map();
  let destination = null;
  while (remaining.size && !destination) {
    const current = [...remaining].sort((left, right) => distance.get(left) - distance.get(right) || left.localeCompare(right))[0];
    if (!Number.isFinite(distance.get(current))) break;
    remaining.delete(current);
    if (targets.has(current)) {
      destination = current;
      break;
    }
    const next = [...(adjacency.get(current) ?? [])].sort((left, right) => left.id.localeCompare(right.id));
    for (const item of next) {
      if (!remaining.has(item.id)) continue;
      const candidate = distance.get(current) + (relationCost[item.edge.type] ?? 2);
      const existing = distance.get(item.id);
      if (candidate < existing || (candidate === existing && item.edge.id.localeCompare(previous.get(item.id)?.edgeId ?? "") < 0)) {
        distance.set(item.id, candidate);
        previous.set(item.id, { nodeId: current, edgeId: item.edge.id });
      }
    }
  }
  if (!destination) return { nodeIds: new Set([selectedId]), edgeIds: new Set() };
  const nodeIds = new Set([destination]);
  const edgeIds = new Set();
  let cursor = destination;
  while (previous.has(cursor)) {
    const step = previous.get(cursor);
    nodeIds.add(step.nodeId);
    edgeIds.add(step.edgeId);
    cursor = step.nodeId;
  }
  return { nodeIds, edgeIds };
}

function neighborsFor(selectedId, edges) {
  const nodeIds = new Set(selectedId ? [selectedId] : []);
  const edgeIds = new Set();
  if (!selectedId) return { nodeIds, edgeIds };
  for (const edge of edges) {
    if (edge.source === selectedId || edge.target === selectedId) {
      nodeIds.add(edge.source);
      nodeIds.add(edge.target);
      edgeIds.add(edge.id);
    }
  }
  return { nodeIds, edgeIds };
}

function bounded(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function fitGraphTransform(nodes, viewport, padding = FIT_PADDING) {
  const width = Math.max(1, Number(viewport?.width) || GRAPH_WIDTH);
  const height = Math.max(1, Number(viewport?.height) || GRAPH_HEIGHT);
  if (!nodes.length) return { scale: 1, x: width / 2 - GRAPH_WIDTH / 2, y: height / 2 - GRAPH_HEIGHT / 2 };
  const xs = nodes.map((node) => node.x);
  const ys = nodes.map((node) => node.y);
  const minX = Math.min(...xs) - 28;
  const maxX = Math.max(...xs) + 28;
  const minY = Math.min(...ys) - 28;
  const maxY = Math.max(...ys) + 28;
  const graphWidth = Math.max(1, maxX - minX);
  const graphHeight = Math.max(1, maxY - minY);
  const scale = bounded(Math.min((width - padding * 2) / graphWidth, (height - padding * 2) / graphHeight), 0.28, 2.2);
  return {
    scale,
    x: (width - graphWidth * scale) / 2 - minX * scale,
    y: (height - graphHeight * scale) / 2 - minY * scale,
  };
}

export function buildGraphInspectorPayload(view) {
  const selected = view.nodes.find((node) => node.id === view.selection);
  if (!selected) return null;
  const related = view.edges.filter((edge) => edge.source === selected.id || edge.target === selected.id);
  return {
    id: selected.id,
    title: selected.label,
    type: selected.type,
    raw_type: selected.rawType,
    lifecycle: selected.lifecycle || "unknown",
    provenance: selected.provenance || "unknown",
    state: selected.lane,
    status: selected.status || "unknown",
    recent_use: selected.recentUse || null,
    path: selected.path || null,
    evidence_paths: unique([...selected.evidencePaths, ...related.map((edge) => edge.evidencePath)]),
    relations: related.map((edge) => ({
      type: edge.type,
      direction: edge.source === selected.id ? "outbound" : "inbound",
      node_id: edge.source === selected.id ? edge.target : edge.source,
      evidence_path: edge.evidencePath || null,
      provenance: edge.provenance || null,
    })),
  };
}

/** Returns only present semantic types, so the overlay legend stays compact. */
export function getObservatoryGraphLegend(view) {
  const counts = new Map();
  for (const node of asArray(view?.nodes)) counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
  return OBSERVATORY_GRAPH_LEGEND_TYPES
    .filter((type) => counts.has(type))
    .map((type) => ({ type, label: LEGEND_LABELS[type], color: OBSERVATORY_GRAPH_PALETTE[type], count: counts.get(type) }));
}

export function shouldAnimateGraph(view, { reducedMotion = false, now = Date.now() } = {}) {
  if (reducedMotion || !view?.nodes?.length) return false;
  return view.nodes.some((node) => {
    if (node.type === "task" && ["active", "started", "running"].includes(node.lifecycle || node.status)) return true;
    const timestamp = Date.parse(node.recentUse || node.updatedAt || "");
    return Number.isFinite(timestamp) && now - timestamp >= 0 && now - timestamp <= LIVE_ACTIVITY_WINDOW_MS;
  });
}

/**
 * Stateful but framework-free interaction controller.  The integrator can use
 * this without the canvas widget for its own shell implementation.
 */
export function createObservatoryGraphController(initialPayload = null, options = {}) {
  let model = normalizeObservatoryGraph(initialPayload ?? { ok: false, index_mode: "evidence_graph_missing" });
  let filters = { type: "all", state: "all", lifecycle: "all", provenance: "all", query: "" };
  let selection = null;
  let viewport = { width: Number(options.width) || GRAPH_WIDTH, height: Number(options.height) || GRAPH_HEIGHT };
  let transform = { scale: 1, x: 0, y: 0 };
  let fitted = false;

  function nodesWithLayout() {
    const positions = layoutNodes(model.nodes);
    return model.nodes.map((node) => ({ ...node, ...(positions.get(node.id) ?? { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 }) }));
  }

  function getView() {
    const allNodes = nodesWithLayout();
    const filterNodes = allNodes.filter((node) => nodeMatches(node, filters));
    const visibleIds = new Set(filterNodes.map((node) => node.id));
    const edges = model.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
    const selected = selection && visibleIds.has(selection) ? selection : null;
    const neighbors = neighborsFor(selected, edges);
    const path = evidencePath(selected, filterNodes, edges);
    const searchIds = new Set(filterNodes.filter((node) => searchMatches(node, filters.query)).map((node) => node.id));
    return {
      ...model,
      nodes: filterNodes.map((node) => ({
        ...node,
        selected: node.id === selected,
        neighbor: neighbors.nodeIds.has(node.id),
        path: path.nodeIds.has(node.id),
        searchMatch: searchIds.has(node.id),
        dimmed: Boolean(selected && !neighbors.nodeIds.has(node.id) && !path.nodeIds.has(node.id) && !searchIds.has(node.id)),
      })),
      edges: edges.map((edge) => ({
        ...edge,
        selected: neighbors.edgeIds.has(edge.id),
        path: path.edgeIds.has(edge.id),
        dimmed: Boolean(selected && !neighbors.edgeIds.has(edge.id) && !path.edgeIds.has(edge.id)),
      })),
      selection: selected,
      filters: { ...filters, available: model.filters },
      viewport: { ...viewport },
      transform: { ...transform },
    };
  }

  function fit() {
    const view = getView();
    transform = fitGraphTransform(view.nodes, viewport);
    fitted = true;
    return getView();
  }

  function setModel(payload, modelOptions = {}) {
    const hadNodes = model.nodes.length > 0;
    model = normalizeObservatoryGraph(payload, modelOptions);
    if (selection && !model.nodes.some((node) => node.id === selection)) selection = null;
    if (!fitted || modelOptions.fit === true || (!hadNodes && model.nodes.length > 0)) fit();
    return getView();
  }

  function setViewport(nextViewport) {
    viewport = { width: Math.max(1, Number(nextViewport?.width) || viewport.width), height: Math.max(1, Number(nextViewport?.height) || viewport.height) };
    if (!fitted) return fit();
    return getView();
  }

  function setFilters(next) {
    filters = { ...filters, ...next };
    if (selection && !getView().nodes.some((node) => node.id === selection)) selection = null;
    return getView();
  }

  return {
    getView,
    fit,
    reset() {
      filters = { type: "all", state: "all", lifecycle: "all", provenance: "all", query: "" };
      selection = null;
      return fit();
    },
    setGraph: setModel,
    setViewport,
    setFilters,
    setQuery(query) {
      return setFilters({ query: asText(query).toLowerCase() });
    },
    select(nodeId) {
      selection = model.nodes.some((node) => node.id === nodeId) ? nodeId : null;
      return getView();
    },
    clearSelection() {
      selection = null;
      return getView();
    },
    panBy(deltaX, deltaY) {
      transform = { ...transform, x: transform.x + Number(deltaX || 0), y: transform.y + Number(deltaY || 0) };
      return getView();
    },
    zoomAt(factor, point) {
      const nextScale = bounded(transform.scale * Number(factor || 1), 0.22, 3.5);
      const anchorX = Number(point?.x) || viewport.width / 2;
      const anchorY = Number(point?.y) || viewport.height / 2;
      const ratio = nextScale / transform.scale;
      transform = {
        scale: nextScale,
        x: anchorX - (anchorX - transform.x) * ratio,
        y: anchorY - (anchorY - transform.y) * ratio,
      };
      return getView();
    },
    inspector() {
      return buildGraphInspectorPayload(getView());
    },
  };
}

export function graphNodeRadius(node) {
  return bounded(4.2 + Math.sqrt(Math.max(1, node.weight)) * 0.9, 4.5, OBSERVATORY_GRAPH_MAX_RADIUS_PX);
}

function applyTransform(node, transform) {
  return { x: node.x * transform.scale + transform.x, y: node.y * transform.scale + transform.y };
}

function labelAllowed(node, view, labelBoxes, ctx) {
  if (node.selected || node.neighbor || node.path || node.searchMatch) return true;
  if (view.transform.scale < 0.9) return false;
  const weight = node.priority + node.weight;
  if (weight < 3) return false;
  const point = applyTransform(node, view.transform);
  const width = ctx.measureText(node.label).width + 10;
  const box = { x: point.x + graphNodeRadius(node) + 7, y: point.y - 15, width, height: 18 };
  const collision = labelBoxes.some((other) => box.x < other.x + other.width && box.x + box.width > other.x && box.y < other.y + other.height && box.y + box.height > other.y);
  if (collision) return false;
  labelBoxes.push(box);
  return true;
}

/** Draws a bounded, semantically zoomed graph into a supplied 2D canvas context. */
export function drawObservatoryGraph(ctx, view, { width, height, reducedMotion = false, now = Date.now() } = {}) {
  if (!ctx || !view) return;
  const canvasWidth = Number(width) || ctx.canvas?.width || GRAPH_WIDTH;
  const canvasHeight = Number(height) || ctx.canvas?.height || GRAPH_HEIGHT;
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  if (!view.ok || !view.nodes.length) return;
  const byId = new Map(view.nodes.map((node) => [node.id, node]));
  ctx.save();
  ctx.lineCap = "round";
  for (const edge of view.edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;
    const a = applyTransform(source, view.transform);
    const b = applyTransform(target, view.transform);
    ctx.globalAlpha = edge.dimmed ? 0.12 : edge.path ? 1 : edge.selected ? 0.86 : 0.38;
    ctx.strokeStyle = RELATION_COLORS[edge.type] ?? "rgba(180, 194, 214, .48)";
    ctx.lineWidth = edge.path ? 2.8 : edge.selected ? 2.1 : 1.1;
    if (edge.path) ctx.setLineDash([]);
    else if (edge.dimmed) ctx.setLineDash([2, 6]);
    else ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  const labelBoxes = [];
  for (const node of view.nodes) {
    const point = applyTransform(node, view.transform);
    const radius = graphNodeRadius(node);
    const live = shouldAnimateGraph({ nodes: [node] }, { reducedMotion, now });
    const pulse = live && !reducedMotion ? 1 + Math.sin(now / 440 + stableHash(node.id) * 0.01) * 0.09 : 1;
    ctx.globalAlpha = node.dimmed ? 0.18 : 1;
    if (node.selected || node.neighbor || node.path || live) {
      ctx.beginPath();
      ctx.fillStyle = node.path ? "rgba(255, 232, 157, .22)" : "rgba(163, 211, 255, .12)";
      ctx.arc(point.x, point.y, (radius + 8) * pulse, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.fillStyle = OBSERVATORY_GRAPH_PALETTE[node.type] ?? OBSERVATORY_GRAPH_PALETTE.other;
    ctx.arc(point.x, point.y, radius * pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = node.selected ? 2.6 : node.path ? 2 : 1;
    ctx.strokeStyle = node.selected ? "#fff2c9" : "rgba(8, 15, 22, .78)";
    ctx.stroke();
    ctx.globalAlpha = node.dimmed ? 0.23 : 1;
    ctx.fillStyle = "#f4ecd8";
    ctx.font = "12px Segoe UI, sans-serif";
    if (labelAllowed(node, view, labelBoxes, ctx)) {
      ctx.shadowColor = "rgba(11, 13, 11, .96)";
      ctx.shadowBlur = 5;
      ctx.fillText(compactText(node.label, 34), point.x + radius + 7, point.y + 4);
      ctx.shadowBlur = 0;
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function makeElement(tag, attributes = {}) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "text") element.textContent = value;
    else if (key === "class") element.className = value;
    else element.setAttribute(key, value);
  }
  return element;
}

function optionList(select, values, label) {
  const current = select.value || "all";
  select.replaceChildren(new Option(label, "all"));
  for (const value of values) select.add(new Option(String(value).replaceAll("_", " "), value));
  select.value = [...select.options].some((option) => option.value === current) ? current : "all";
}

function readableDetails(payload) {
  if (!payload) return [];
  return [
    ["유형", payload.type],
    ["수명주기", payload.lifecycle],
    ["출처 검증", payload.provenance],
    ["상태", payload.state],
    ["최근 사용", payload.recent_use ?? "없음"],
    ["기록", payload.path ?? "없음"],
  ];
}

/**
 * Mounts a complete LC-03 canvas graph into an element. `onReindex` receives
 * only the safe local action descriptor; the shell decides whether and how to
 * execute it. `onEvidencePath` receives a selected evidence path.
 */
export function mountObservatoryGraph(host, options = {}) {
  if (!host || typeof document === "undefined") throw new Error("mountObservatoryGraph requires a browser host element");
  const controller = createObservatoryGraphController(options.initialGraph ?? null, options.viewport);
  const reducedMedia = typeof window?.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false, addEventListener() {}, removeEventListener() {} };
  let reducedMotion = Boolean(reducedMedia.matches);
  let frame = null;
  let drag = null;
  let destroyed = false;
  let resizeObserver = null;

  const root = makeElement("section", { class: "observatory-graph", "aria-label": "지식 그래프" });
  const toolbar = makeElement("div", { class: "observatory-graph__toolbar" });
  const search = makeElement("input", { type: "search", placeholder: "노드, 경로 또는 증거 검색", "aria-label": "지식 그래프 검색" });
  const type = makeElement("select", { "aria-label": "유형 필터" });
  const state = makeElement("select", { "aria-label": "상태 필터" });
  const lifecycle = makeElement("select", { "aria-label": "수명주기 필터" });
  const fitButton = makeElement("button", { type: "button", text: "맞춤" });
  const resetButton = makeElement("button", { type: "button", text: "초기화" });
  const status = makeElement("p", { class: "observatory-graph__status", "aria-live": "polite" });
  const stage = makeElement("div", { class: "observatory-graph__stage" });
  const canvas = makeElement("canvas", { class: "observatory-graph__canvas", tabindex: "0", "aria-label": "확대, 이동, 선택 가능한 지식 그래프" });
  const legend = makeElement("div", { class: "observatory-graph__legend", "aria-label": "그래프 유형 범례" });
  const empty = makeElement("div", { class: "observatory-graph__empty", role: "status" });
  const inspector = makeElement("aside", { class: "observatory-graph__inspector", "aria-live": "polite" });
  const style = makeElement("style", { text: `
    .observatory-graph { --graph-bg: var(--bg, #0b0d0b); --graph-panel: var(--panel, #121611); --graph-panel-2: var(--panel-2, #171c15); --graph-line: var(--line, #2d382d); --graph-text: var(--text, #eee6d2); --graph-muted: var(--muted, #a49c87); --graph-bone: var(--bone, #e6dcc2); --graph-amber: var(--amber, #d99a3d); --graph-fern: var(--fern, #7cc66a); --graph-teal: var(--basalt, #4fb6a4); --graph-clay: var(--clay, #c76f47); color: var(--graph-text); min-width: 0; }
    .observatory-graph__toolbar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 6px; }
    .observatory-graph__toolbar input { min-width: min(100%, 230px); flex: 1 1 220px; }
    .observatory-graph button, .observatory-graph input, .observatory-graph select { color: var(--graph-text); background: var(--graph-panel-2); border: 1px solid var(--graph-line); border-radius: 6px; padding: 6px 8px; font: inherit; }
    .observatory-graph button:hover { border-color: var(--graph-teal); color: var(--graph-bone); }
    .observatory-graph button:focus-visible, .observatory-graph input:focus-visible, .observatory-graph select:focus-visible, .observatory-graph__canvas:focus-visible { outline: 2px solid var(--graph-amber); outline-offset: 2px; }
    .observatory-graph__status { color: var(--graph-muted); margin: 0 0 6px; font-size: 12px; }
    .observatory-graph__stage { position: relative; min-height: 340px; border: 1px solid var(--graph-line); border-radius: 8px; overflow: hidden; background: var(--graph-bg); }
    .observatory-graph__canvas { display: block; width: 100%; height: min(56vw, 500px); min-height: 340px; touch-action: none; cursor: grab; }
    .observatory-graph__canvas.is-node-hover { cursor: pointer; }
    .observatory-graph__canvas.is-panning { cursor: grabbing; }
    .observatory-graph__canvas[hidden], .observatory-graph__empty[hidden] { display: none; }
    .observatory-graph__legend { position: absolute; z-index: 1; top: 8px; left: 8px; display: flex; flex-wrap: wrap; gap: 4px 7px; max-width: calc(100% - 16px); padding: 4px 6px; border: 1px solid color-mix(in srgb, var(--graph-line) 88%, transparent); border-radius: 6px; background: color-mix(in srgb, var(--graph-bg) 92%, transparent); color: var(--graph-bone); font-size: 11px; line-height: 1.2; pointer-events: none; }
    .observatory-graph__legend[hidden] { display: none; }
    .observatory-graph__legend-item { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; }
    .observatory-graph__legend-dot { width: 7px; height: 7px; border-radius: 50%; box-shadow: 0 0 0 1px rgba(11, 13, 11, .65); }
    .observatory-graph__empty { display: grid; place-items: center; align-content: center; gap: 7px; min-height: 340px; padding: 20px; text-align: center; color: var(--graph-bone); background: var(--graph-panel); }
    .observatory-graph__empty strong { color: var(--graph-amber); }
    .observatory-graph__empty p { max-width: 56ch; margin: 0; color: var(--graph-text); }
    .observatory-graph__empty button { border-color: var(--graph-amber); }
    .observatory-graph__inspector { margin-top: 8px; border-top: 1px solid var(--graph-line); background: transparent; padding: 8px 0 0; min-height: 40px; }
    .observatory-graph__inspector dl { display: grid; grid-template-columns: minmax(88px, auto) 1fr; gap: 4px 12px; margin: 0; }
    .observatory-graph__inspector dt { color: var(--graph-muted); } .observatory-graph__inspector dd { margin: 0; color: var(--graph-bone); overflow-wrap: anywhere; }
    .observatory-graph__evidence { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    @media (max-width: 520px) { .observatory-graph__canvas { height: 360px; } .observatory-graph__toolbar > * { flex: 1 1 46%; } .observatory-graph__legend { top: 6px; left: 6px; font-size: 10px; } }
    @media (prefers-reduced-motion: reduce) { .observatory-graph *, .observatory-graph *::before, .observatory-graph *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; } }
  ` });
  toolbar.append(search, type, state, lifecycle, fitButton, resetButton);
  stage.append(canvas, legend, empty);
  root.append(style, toolbar, status, stage, inspector);
  host.replaceChildren(root);
  const context = canvas.getContext("2d");

  function canvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    controller.setViewport({ width: rect.width, height: rect.height });
    render();
  }

  function renderInspector(view) {
    const payload = buildGraphInspectorPayload(view);
    inspector.replaceChildren();
    if (!payload) {
      inspector.textContent = "노드를 선택하면 유형, 수명주기, 출처 검증, 최근 사용과 증거 경로를 보여 줍니다.";
      return;
    }
    const title = makeElement("strong", { text: payload.title });
    const list = makeElement("dl");
    for (const [key, value] of readableDetails(payload)) {
      list.append(makeElement("dt", { text: key }), makeElement("dd", { text: String(value) }));
    }
    inspector.append(title, list);
    if (payload.evidence_paths.length) {
      const evidence = makeElement("div", { class: "observatory-graph__evidence" });
      for (const path of payload.evidence_paths) {
        const button = makeElement("button", { type: "button", text: compactText(path, 72), title: path });
        button.addEventListener("click", () => options.onEvidencePath?.(path, payload));
        evidence.append(button);
      }
      inspector.append(evidence);
    }
  }

  function renderEmpty(emptyState) {
    empty.replaceChildren();
    const heading = makeElement("strong", { text: emptyState.title });
    const reason = makeElement("p", { text: emptyState.reason });
    const action = makeElement("button", { type: "button", text: emptyState.action.label });
    action.addEventListener("click", () => {
      options.onReindex?.(emptyState.action);
      root.dispatchEvent(new CustomEvent("observatory-graph-reindex", { bubbles: true, detail: emptyState.action }));
    });
    empty.append(heading, reason, action);
  }

  function renderLegend(view) {
    const entries = getObservatoryGraphLegend(view);
    legend.hidden = entries.length === 0;
    legend.replaceChildren();
    for (const entry of entries) {
      const item = makeElement("span", { class: "observatory-graph__legend-item", title: `${entry.label}: ${entry.count}` });
      const dot = makeElement("span", { class: "observatory-graph__legend-dot" });
      dot.style.background = entry.color;
      item.append(dot, document.createTextNode(`${entry.label} ${entry.count}`));
      legend.append(item);
    }
  }

  function render() {
    if (destroyed) return;
    const view = controller.getView();
    optionList(type, view.filters.available.types, "모든 유형");
    optionList(state, view.filters.available.states, "모든 상태");
    optionList(lifecycle, view.filters.available.lifecycle, "모든 수명주기");
    if (search.value !== view.filters.query) search.value = view.filters.query;
    const emptyState = view.emptyState;
    empty.hidden = !emptyState;
    canvas.hidden = Boolean(emptyState);
    if (emptyState) {
      legend.hidden = true;
      renderEmpty(emptyState);
      status.textContent = `${emptyState.code}: ${emptyState.action.command}`;
      renderInspector(view);
      return;
    }
    renderLegend(view);
    status.textContent = `${view.nodes.length}/${view.stats.nodes} 노드 · ${view.edges.length}/${view.stats.edges} 관계${view.stats.truncated ? " · 일부만 표시" : ""}`;
    drawObservatoryGraph(context, view, { width: canvas.clientWidth, height: canvas.clientHeight, reducedMotion });
    renderInspector(view);
  }

  function animate() {
    frame = null;
    const view = controller.getView();
    if (!shouldAnimateGraph(view, { reducedMotion })) return;
    drawObservatoryGraph(context, view, { width: canvas.clientWidth, height: canvas.clientHeight, reducedMotion });
    frame = requestAnimationFrame(animate);
  }

  function scheduleAnimation() {
    if (frame) cancelAnimationFrame(frame);
    frame = null;
    if (shouldAnimateGraph(controller.getView(), { reducedMotion })) frame = requestAnimationFrame(animate);
  }

  function update(nextView) {
    render(nextView);
    scheduleAnimation();
    return controller.getView();
  }

  function nodeAt(point) {
    const view = controller.getView();
    return view.nodes.find((node) => {
      const transformed = applyTransform(node, view.transform);
      return Math.hypot(point.x - transformed.x, point.y - transformed.y) <= nodeRadius(node) + 5;
    });
  }

  search.addEventListener("input", () => update(controller.setQuery(search.value)));
  type.addEventListener("change", () => update(controller.setFilters({ type: type.value })));
  state.addEventListener("change", () => update(controller.setFilters({ state: state.value })));
  lifecycle.addEventListener("change", () => update(controller.setFilters({ lifecycle: lifecycle.value })));
  fitButton.addEventListener("click", () => update(controller.fit()));
  resetButton.addEventListener("click", () => update(controller.reset()));
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    update(controller.zoomAt(event.deltaY < 0 ? 1.14 : 0.88, canvasPoint(event)));
  }, { passive: false });
  canvas.addEventListener("pointerdown", (event) => {
    drag = { point: canvasPoint(event), moved: false };
    canvas.classList.remove("is-node-hover");
    canvas.classList.add("is-panning");
    canvas.setPointerCapture?.(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    const point = canvasPoint(event);
    if (!drag) {
      canvas.classList.toggle("is-node-hover", Boolean(nodeAt(point)));
      return;
    }
    const deltaX = point.x - drag.point.x;
    const deltaY = point.y - drag.point.y;
    drag.moved ||= Math.hypot(deltaX, deltaY) > 3;
    drag.point = point;
    update(controller.panBy(deltaX, deltaY));
  });
  canvas.addEventListener("pointerup", (event) => {
    const point = canvasPoint(event);
    const wasDrag = drag?.moved;
    drag = null;
    canvas.classList.remove("is-panning");
    if (!wasDrag) update(controller.select(nodeAt(point)?.id ?? null));
    canvas.classList.toggle("is-node-hover", Boolean(nodeAt(point)));
  });
  canvas.addEventListener("pointercancel", () => {
    drag = null;
    canvas.classList.remove("is-panning", "is-node-hover");
  });
  canvas.addEventListener("pointerleave", () => {
    if (!drag) canvas.classList.remove("is-node-hover");
  });
  canvas.addEventListener("keydown", (event) => {
    if (event.key === "Escape") update(controller.clearSelection());
    if (event.key === "0") update(controller.fit());
    if (event.key === "+" || event.key === "=") update(controller.zoomAt(1.14));
    if (event.key === "-") update(controller.zoomAt(0.88));
  });
  const onReducedMotionChange = (event) => {
    reducedMotion = Boolean(event.matches);
    update(controller.getView());
  };
  reducedMedia.addEventListener?.("change", onReducedMotionChange);
  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(resizeCanvas);
    resizeObserver.observe(canvas);
  }

  const unsubscribe = typeof options.subscribe === "function"
    ? options.subscribe((payload) => update(controller.setGraph(payload)))
    : null;

  async function refresh() {
    const fetcher = options.fetcher ?? fetch;
    try {
      const response = await fetcher(options.graphUrl ?? "/api/graph", { cache: "no-store" });
      if (!response?.ok) throw new Error(`graph request failed: ${response?.status ?? "unknown"}`);
      return update(controller.setGraph(await response.json()));
    } catch (error) {
      return update(controller.setGraph({ ok: false, index_mode: "evidence_graph_missing" }, { error: error instanceof Error ? error.message : String(error) }));
    }
  }

  resizeCanvas();
  update(controller.getView());
  if (options.autoLoad !== false && !options.initialGraph) void refresh();
  return {
    controller,
    refresh,
    setGraph(payload) { return update(controller.setGraph(payload)); },
    destroy() {
      destroyed = true;
      if (frame) cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      reducedMedia.removeEventListener?.("change", onReducedMotionChange);
      if (typeof unsubscribe === "function") unsubscribe();
      root.remove();
    },
  };
}
