import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEFAULT_REINDEX_ACTION,
  OBSERVATORY_GRAPH_ADAPTER_VERSION,
  OBSERVATORY_GRAPH_LEGEND_TYPES,
  OBSERVATORY_GRAPH_MAX_RADIUS_PX,
  OBSERVATORY_GRAPH_PALETTE,
  buildGraphInspectorPayload,
  createObservatoryGraphController,
  drawObservatoryGraph,
  getObservatoryGraphLegend,
  graphNodeRadius,
  normalizeObservatoryGraph,
  shouldAnimateGraph,
} from "./observatory-graph.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fixtureGraph() {
  return {
    ok: true,
    index_mode: "evidence_graph_v1",
    generated_at: "2026-07-13T12:00:00.000Z",
    stats: { nodes: 7, edges: 7, shown_nodes: 7, shown_edges: 7, truncated: false },
    filters: {
      lanes: ["active", "normal"],
      lifecycle_states: ["started", "accepted", "verified", "completed"],
      provenance_statuses: ["verified", "accepted_by_review"],
    },
    nodes: [
      {
        id: "source:guide",
        type: "source_snapshot",
        label: "Evidence guide",
        path: "30_Sources/fetched/guide.json",
        lifecycle_state: "verified",
        provenance_status: "verified",
        evidence_path: "30_Sources/fetched/guide.json",
      },
      {
        id: "chunk:guide-1",
        type: "source_chunk",
        label: "Guide chunk 1",
        path: "30_Sources/chunks/guide-1.json",
        lifecycle_state: "verified",
        provenance_status: "verified",
        evidence_path: "30_Sources/chunks/guide-1.json",
      },
      {
        id: "claim:graph",
        type: "wiki_record",
        label: "Important graph claim",
        path: "20_Wiki/Graph Claim.md",
        lifecycle_state: "accepted",
        provenance_status: "verified",
        evidence_path: "20_Wiki/Graph Claim.md",
      },
      {
        id: "memory:graph-rule",
        type: "memory",
        label: "Graph evidence rule",
        path: "50_Instances/accepted/graph-rule.json",
        lifecycle_state: "accepted",
        provenance_status: "accepted_by_review",
        evidence_path: "50_Instances/accepted/graph-rule.json",
        details: { summary: "Trace evidence from source through task." },
      },
      {
        id: "project:observatory",
        type: "project_record",
        label: "Observatory completion",
        path: "40_Projects/Observatory.md",
        lifecycle_state: "active",
        provenance_status: "verified",
        evidence_path: "40_Projects/Observatory.md",
      },
      {
        id: "task:lc03",
        type: "task",
        label: "Finish LC-03 knowledge graph",
        path: ".dino/tasks/lc03.json",
        lane: "active",
        lifecycle_state: "started",
        provenance_status: "verified",
        updated_at: "2026-07-13T11:59:00.000Z",
        evidence_path: ".dino/tasks/lc03.json",
      },
      {
        id: "trace:lc03",
        type: "trace",
        label: "LC-03 evidence trace",
        path: ".dino/traces/lc03.json",
        lifecycle_state: "completed",
        provenance_status: "verified",
        evidence_path: ".dino/traces/lc03.json",
      },
    ],
    edges: [
      { id: "e1", source: "source:guide", target: "chunk:guide-1", type: "source_to_chunk", evidence_path: "30_Sources/chunks/guide-1.json", priority: 120 },
      { id: "e2", source: "chunk:guide-1", target: "claim:graph", type: "chunk_to_claim", evidence_path: "20_Wiki/Graph Claim.md", priority: 120 },
      { id: "e3", source: "claim:graph", target: "memory:graph-rule", type: "supported_by", evidence_path: "50_Instances/accepted/graph-rule.json", priority: 90 },
      { id: "e4", source: "task:lc03", target: "memory:graph-rule", type: "context_provided", evidence_path: ".dino/context-packs/lc03.json", priority: 120 },
      { id: "e5", source: "task:lc03", target: "trace:lc03", type: "task_to_trace", evidence_path: ".dino/traces/lc03.json", priority: 120 },
      { id: "e6", source: "trace:lc03", target: "memory:graph-rule", type: "memory_declared_used", evidence_path: ".dino/traces/lc03.json", priority: 120 },
      { id: "e7", source: "project:observatory", target: "task:lc03", type: "project_contains_task", evidence_path: "40_Projects/Observatory.md", priority: 90 },
    ],
  };
}

function mockCanvasContext() {
  const calls = { arcs: 0, strokes: 0, labels: 0 };
  return {
    canvas: { width: 960, height: 520 },
    calls,
    save() {}, restore() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, setLineDash() {},
    arc() { calls.arcs += 1; }, fill() {}, stroke() { calls.strokes += 1; }, fillText() { calls.labels += 1; },
    measureText(value) { return { width: String(value).length * 7 }; },
    set globalAlpha(_value) {}, set lineCap(_value) {}, set strokeStyle(_value) {}, set lineWidth(_value) {},
    set fillStyle(_value) {}, set font(_value) {},
  };
}

const fixtureRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-lc03-graph-"));
const fixturePath = path.join(fixtureRoot, "graph-fixture.json");
try {
  writeFileSync(fixturePath, `${JSON.stringify(fixtureGraph(), null, 2)}\n`, "utf8");
  const payload = JSON.parse(readFileSync(fixturePath, "utf8"));
  const model = normalizeObservatoryGraph(payload);
  assert(model.version === OBSERVATORY_GRAPH_ADAPTER_VERSION, "adapter did not report its exported version");
  assert(model.ok === true && model.emptyState === null, "non-empty evidence graph was treated as empty");
  for (const type of ["source", "chunk", "claim", "memory", "task", "trace", "project"]) {
    assert(model.nodes.some((node) => node.type === type), `fixture did not expose canonical ${type} node`);
  }
  assert(model.edges.some((edge) => edge.type === "source_to_chunk" && edge.evidencePath), "source/chunk evidence relationship missing");
  assert(model.edges.some((edge) => edge.type === "memory_declared_used" && edge.evidencePath), "memory provenance relationship missing");
  for (const type of OBSERVATORY_GRAPH_LEGEND_TYPES) {
    assert(typeof OBSERVATORY_GRAPH_PALETTE[type] === "string", `palette omitted ${type}`);
  }
  assert(new Set(OBSERVATORY_GRAPH_LEGEND_TYPES.map((type) => OBSERVATORY_GRAPH_PALETTE[type])).size === OBSERVATORY_GRAPH_LEGEND_TYPES.length, "semantic palette colors are not distinct");
  assert(!["#70b7ff", "#8fc7ef"].some((color) => Object.values(OBSERVATORY_GRAPH_PALETTE).includes(color)), "legacy blue/slate palette remained in adapter contract");

  const controller = createObservatoryGraphController(payload, { width: 960, height: 520 });
  controller.setViewport({ width: 960, height: 520 });
  controller.fit();
  let view = controller.select("memory:graph-rule");
  assert(view.nodes.find((node) => node.id === "memory:graph-rule")?.selected, "selected memory was not retained");
  assert(view.nodes.find((node) => node.id === "task:lc03")?.path, "selected memory did not highlight a task evidence path");
  assert(view.nodes.find((node) => node.id === "trace:lc03")?.path, "selected memory did not highlight a trace evidence path");
  assert(view.nodes.find((node) => node.id === "source:guide")?.dimmed, "unrelated source was not progressively dimmed after selection");
  assert(view.edges.find((edge) => edge.id === "e6")?.path, "used-memory relation was not emphasized on the evidence path");
  const legend = getObservatoryGraphLegend(view);
  assert(legend.length === OBSERVATORY_GRAPH_LEGEND_TYPES.length, "dynamic legend did not expose every fixture type");
  assert(legend.every((entry) => entry.count === 1 && entry.color === OBSERVATORY_GRAPH_PALETTE[entry.type]), "legend did not preserve semantic color/count mapping");
  assert(graphNodeRadius({ weight: 1 }) <= OBSERVATORY_GRAPH_MAX_RADIUS_PX && graphNodeRadius({ weight: 99999 }) <= OBSERVATORY_GRAPH_MAX_RADIUS_PX, "graph node radius exceeded compact 8px contract");

  const inspector = buildGraphInspectorPayload(view);
  assert(inspector?.type === "memory", "inspector did not expose canonical selected type");
  assert(inspector?.provenance === "accepted_by_review", "inspector did not expose provenance");
  assert(inspector?.evidence_paths.includes(".dino/traces/lc03.json"), "inspector did not expose traversable evidence path");

  const beforeZoom = view.transform.scale;
  view = controller.zoomAt(1.3, { x: 420, y: 220 });
  assert(view.transform.scale > beforeZoom, "zoom control did not increase scale");
  const beforePan = view.transform.x;
  view = controller.panBy(21, -11);
  assert(view.transform.x !== beforePan, "pan control did not move the viewport");
  view = controller.setQuery("important");
  assert(view.nodes.find((node) => node.id === "claim:graph")?.searchMatch, "search did not mark matching claim");
  view = controller.setFilters({ type: "task", state: "active" });
  assert(view.nodes.length === 1 && view.nodes[0].id === "task:lc03", "type/state filters did not constrain the graph deterministically");
  view = controller.reset();
  assert(view.selection === null && view.nodes.length === 7, "reset did not clear selection and filters");

  const context = mockCanvasContext();
  drawObservatoryGraph(context, controller.select("memory:graph-rule"), { width: 960, height: 520, reducedMotion: true, now: Date.parse("2026-07-13T12:00:00.000Z") });
  assert(context.calls.arcs >= 7 && context.calls.strokes >= 7, "canvas renderer did not draw bounded nodes and relations");
  assert(shouldAnimateGraph(controller.getView(), { reducedMotion: false, now: Date.parse("2026-07-13T12:00:00.000Z") }), "active task did not enable meaningful live activity motion");
  assert(!shouldAnimateGraph(controller.getView(), { reducedMotion: true, now: Date.parse("2026-07-13T12:00:00.000Z") }), "reduced-motion did not suppress nonessential animation");

  const missing = normalizeObservatoryGraph({ ok: false, index_mode: "evidence_graph_missing", stats: { nodes: 0, edges: 0 } });
  assert(missing.ok === false && missing.emptyState?.code === "index_missing", "missing index did not produce an actionable empty state");
  assert(missing.emptyState.action.command === DEFAULT_REINDEX_ACTION.command, "missing index did not provide canonical reindex action");
  const empty = normalizeObservatoryGraph({ ok: true, index_mode: "evidence_graph_v1", stats: { nodes: 0, edges: 0 }, nodes: [], edges: [] });
  assert(empty.ok === false && empty.emptyState?.code === "index_empty", "zero-node index did not produce an actionable empty state");

  console.log(JSON.stringify({
    ok: true,
    adapter_version: OBSERVATORY_GRAPH_ADAPTER_VERSION,
    fixture: fixturePath,
    nodes: model.nodes.length,
    edges: model.edges.length,
    selected_path: [...controller.select("memory:graph-rule").nodes].filter((node) => node.path).map((node) => node.id),
    empty_states: [missing.emptyState.code, empty.emptyState.code],
    palette: "charcoal-green-teal-amber-bone",
    legend: legend.map((entry) => entry.type),
    max_radius_px: OBSERVATORY_GRAPH_MAX_RADIUS_PX,
    reduced_motion: "pass",
  }, null, 2));
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
