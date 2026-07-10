import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, atomicWriteText } from "./lib/atomic-files.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(appRoot, "..", "dinobrain-data"));
const outDir = path.resolve(process.env.DINOBRAIN_GRAPH_OUT_DIR ?? path.join(appRoot, "reports"));
const htmlPath = path.join(outDir, "dinobrain-vault-graph.html");
const svgPath = path.join(outDir, "dinobrain-vault-graph.svg");
const jsonPath = path.join(outDir, "dinobrain-vault-graph.json");

const supportedExtensions = new Set([".md", ".json"]);
const topLevelColors = new Map([
  ["00_Home", "#60a5fa"],
  ["20_Wiki", "#8b5cf6"],
  ["30_Sources", "#14b8a6"],
  ["40_Projects", "#f97316"],
  ["50_Instances", "#22c55e"],
  ["60_Operations", "#eab308"],
  ["70_Error_Book", "#ef4444"],
  ["80_Review_Queue", "#ec4899"],
  [".dino", "#94a3b8"],
]);

function normalizeRel(value) {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function dataPath(...parts) {
  const target = path.resolve(dataRoot, ...parts);
  if (!isInside(target, dataRoot)) {
    throw new Error(`Path escapes data root: ${parts.join("/")}`);
  }
  return target;
}

async function walk(dir, files = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return files;
    throw error;
  }

  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, files);
    } else if (entry.isFile() && supportedExtensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(full);
    }
  }
  return files;
}

function parseFrontmatter(markdown) {
  if (!markdown.startsWith("---\n")) return { metadata: {}, body: markdown };
  const end = markdown.indexOf("\n---\n", 4);
  if (end < 0) return { metadata: {}, body: markdown };
  const raw = markdown.slice(4, end);
  const metadata = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    const trimmed = rawValue.trim();
    if (/^\[.*\]$/.test(trimmed)) {
      metadata[key] = trimmed
        .slice(1, -1)
        .split(",")
        .map((item) => item.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      metadata[key] = trimmed.replace(/^["']|["']$/g, "");
    }
  }
  return { metadata, body: markdown.slice(end + 5) };
}

function firstHeading(body) {
  return body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
}

function firstParagraph(body) {
  return (
    body
      .replace(/^---[\s\S]*?---\s*/m, "")
      .split(/\n\s*\n/)
      .map((part) => part.replace(/^#+\s+.+$/gm, "").trim())
      .find((part) => part.length > 0) ?? ""
  ).slice(0, 220);
}

function stringArray(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") return value.split(/[, ]+/).filter(Boolean);
  return [];
}

function basenameLabel(relPath) {
  const extension = path.extname(relPath);
  return path.basename(relPath, extension);
}

function topLevel(relPath) {
  return normalizeRel(relPath).split("/")[0] || "root";
}

function nodeColor(node) {
  if (node.type === "root") return "#6366f1";
  if (node.type === "tag") return "#2dd4bf";
  if (node.type === "case") return "#f59e0b";
  if (node.type === "missing") return "#64748b";
  return topLevelColors.get(node.group) ?? "#a78bfa";
}

function addNode(nodes, id, patch) {
  if (!nodes.has(id)) {
    nodes.set(id, {
      id,
      label: patch.label ?? id,
      type: patch.type ?? "node",
      group: patch.group ?? "root",
      path: patch.path ?? null,
      size: patch.size ?? 5,
      detail: patch.detail ?? "",
    });
    return;
  }
  Object.assign(nodes.get(id), patch);
}

function addEdge(edges, seen, source, target, label, weight = 1) {
  if (!source || !target || source === target) return;
  const key = `${source}\u0000${target}\u0000${label}`;
  if (seen.has(key)) return;
  seen.add(key);
  edges.push({ source, target, label, weight });
}

function resolveWikiTarget(rawTarget, pathIndex, basenameIndex) {
  const target = rawTarget.split("|")[0].split("#")[0].trim();
  if (!target) return null;
  const normalized = normalizeRel(target);
  const candidates = [
    normalized,
    `${normalized}.md`,
    `${normalized}.json`,
    `20_Wiki/${normalized}.md`,
    `30_Sources/${normalized}.md`,
    `40_Projects/${normalized}.md`,
    `50_Instances/accepted/${normalized}.json`,
  ];
  for (const candidate of candidates) {
    if (pathIndex.has(candidate)) return `file:${candidate}`;
  }
  const baseMatches = basenameIndex.get(path.basename(normalized).toLowerCase()) ?? [];
  if (baseMatches.length === 1) return `file:${baseMatches[0]}`;
  return `missing:${normalized}`;
}

function relationshipPaths(record) {
  const paths = [];
  for (const key of [
    "candidate_path",
    "accepted_path",
    "source_candidate_path",
    "target_path",
    "trace_path",
    "quarantine_path",
    "review_path",
  ]) {
    if (typeof record[key] === "string" && record[key].trim()) {
      paths.push({ key, value: normalizeRel(record[key]) });
    }
  }
  if (Array.isArray(record.expected_paths)) {
    for (const expected of record.expected_paths) {
      paths.push({ key: "expected_path", value: normalizeRel(String(expected)) });
    }
  }
  return paths;
}

async function buildGraph() {
  const nodes = new Map();
  const edges = [];
  const edgeSeen = new Set();
  const files = await walk(dataRoot);
  const relFiles = files.map((file) => normalizeRel(path.relative(dataRoot, file))).sort();
  const pathIndex = new Set(relFiles);
  const basenameIndex = new Map();

  addNode(nodes, "vault", {
    label: "DinoBrain Vault",
    type: "root",
    group: "root",
    size: 16,
    detail: dataRoot,
  });

  for (const rel of relFiles) {
    const base = basenameLabel(rel).toLowerCase();
    basenameIndex.set(base, [...(basenameIndex.get(base) ?? []), rel]);
  }

  for (const rel of relFiles) {
    const parts = rel.split("/");
    let parentId = "vault";
    for (let i = 0; i < parts.length - 1; i += 1) {
      const folderRel = parts.slice(0, i + 1).join("/");
      const folderId = `folder:${folderRel}`;
      addNode(nodes, folderId, {
        label: parts[i],
        type: "folder",
        group: parts[0],
        path: folderRel,
        size: i === 0 ? 11 : 8,
        detail: folderRel,
      });
      addEdge(edges, edgeSeen, parentId, folderId, "contains", 0.35);
      parentId = folderId;
    }

    const full = dataPath(rel);
    const raw = await fs.readFile(full, "utf8");
    const extension = path.extname(rel).toLowerCase();
    const fileId = `file:${rel}`;
    const fileGroup = topLevel(rel);

    let title = basenameLabel(rel);
    let detail = rel;
    let tags = [];
    let jsonRecord = null;

    if (extension === ".md") {
      const { metadata, body } = parseFrontmatter(raw);
      title = String(metadata.title ?? firstHeading(body) ?? title);
      detail = [rel, metadata.summary ? String(metadata.summary) : firstParagraph(body)].filter(Boolean).join("\n");
      tags = stringArray(metadata.tags);
    } else if (extension === ".json") {
      try {
        jsonRecord = JSON.parse(raw);
      } catch {
        jsonRecord = null;
      }
      if (jsonRecord && typeof jsonRecord === "object" && !Array.isArray(jsonRecord)) {
        title = String(jsonRecord.title ?? jsonRecord.claim ?? jsonRecord.id ?? title);
        detail = [rel, jsonRecord.description, jsonRecord.claim, jsonRecord.summary].filter(Boolean).join("\n");
        tags = stringArray(jsonRecord.tags);
      }
    }

    addNode(nodes, fileId, {
      label: title,
      type: extension === ".json" ? "json" : "markdown",
      group: fileGroup,
      path: rel,
      size: fileGroup === ".dino" ? 6 : 8,
      detail,
    });
    addEdge(edges, edgeSeen, parentId, fileId, "contains", 0.45);

    for (const tag of tags) {
      const tagId = `tag:${tag.toLowerCase()}`;
      addNode(nodes, tagId, {
        label: `#${tag}`,
        type: "tag",
        group: "tag",
        size: 7,
        detail: `Tag: ${tag}`,
      });
      addEdge(edges, edgeSeen, fileId, tagId, "tag", 0.55);
    }

    if (extension === ".md") {
      for (const match of raw.matchAll(/\[\[([^\]]+)\]\]/g)) {
        const targetId = resolveWikiTarget(match[1], pathIndex, basenameIndex);
        if (!targetId) continue;
        if (targetId.startsWith("missing:")) {
          addNode(nodes, targetId, {
            label: targetId.slice("missing:".length),
            type: "missing",
            group: "missing",
            size: 5,
            detail: "Unresolved wikilink",
          });
        }
        addEdge(edges, edgeSeen, fileId, targetId, "wikilink", 1.4);
      }
    }

    if (jsonRecord && typeof jsonRecord === "object" && !Array.isArray(jsonRecord)) {
      for (const relation of relationshipPaths(jsonRecord)) {
        const targetId = pathIndex.has(relation.value) ? `file:${relation.value}` : `missing:${relation.value}`;
        if (targetId.startsWith("missing:")) {
          addNode(nodes, targetId, {
            label: relation.value,
            type: "missing",
            group: "missing",
            size: 5,
            detail: "Referenced path not found",
          });
        }
        addEdge(edges, edgeSeen, fileId, targetId, relation.key, 1.2);
      }

      if (Array.isArray(jsonRecord.cases)) {
        for (const testCase of jsonRecord.cases) {
          const caseId = `case:${testCase.id}`;
          addNode(nodes, caseId, {
            label: testCase.id,
            type: "case",
            group: "evaluation",
            size: 5,
            detail: String(testCase.question ?? ""),
          });
          addEdge(edges, edgeSeen, fileId, caseId, "case", 0.8);
          for (const expected of testCase.expected_paths ?? []) {
            const expectedPath = normalizeRel(String(expected));
            const targetId = pathIndex.has(expectedPath) ? `file:${expectedPath}` : `missing:${expectedPath}`;
            addEdge(edges, edgeSeen, caseId, targetId, "expects", 1.1);
          }
        }
      }
    }
  }

  const nodeList = [...nodes.values()].map((node) => ({
    ...node,
    color: nodeColor(node),
  }));
  const stats = {
    data_root: dataRoot,
    generated_at: new Date().toISOString(),
    nodes: nodeList.length,
    edges: edges.length,
    files: relFiles.length,
    markdown_files: relFiles.filter((file) => file.endsWith(".md")).length,
    json_files: relFiles.filter((file) => file.endsWith(".json")).length,
    wikilinks: edges.filter((edge) => edge.label === "wikilink").length,
    tags: nodeList.filter((node) => node.type === "tag").length,
    relation_edges: edges.filter((edge) => !["contains", "tag", "wikilink"].includes(edge.label)).length,
  };

  return { stats, nodes: nodeList, edges };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderHtml(graph) {
  const graphJson = JSON.stringify(graph);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DinoBrain Vault Graph</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, Segoe UI, Arial, sans-serif; }
    body { margin: 0; background: #0b1020; color: #e5e7eb; overflow: hidden; }
    #app { display: grid; grid-template-columns: 1fr 360px; height: 100vh; }
    canvas { width: 100%; height: 100%; display: block; background: radial-gradient(circle at 70% 20%, #172036, #080b13 62%); }
    aside { border-left: 1px solid #273244; background: #0f172a; padding: 18px; overflow: auto; }
    h1 { font-size: 18px; margin: 0 0 8px; }
    h2 { font-size: 13px; margin: 22px 0 8px; color: #93c5fd; text-transform: uppercase; letter-spacing: .08em; }
    p, li { font-size: 13px; line-height: 1.5; color: #cbd5e1; }
    .stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 14px 0; }
    .stat { background: #111827; border: 1px solid #263244; border-radius: 8px; padding: 8px; }
    .stat strong { display: block; color: #fff; font-size: 18px; }
    .legend { display: grid; gap: 7px; }
    .legend span { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: #cbd5e1; }
    .dot { width: 10px; height: 10px; border-radius: 99px; display: inline-block; }
    input { width: 100%; box-sizing: border-box; border: 1px solid #334155; border-radius: 8px; background: #020617; color: #e5e7eb; padding: 10px 12px; }
    code { color: #a7f3d0; word-break: break-all; }
    .node-detail { white-space: pre-wrap; font-size: 12px; color: #cbd5e1; background: #020617; border: 1px solid #1f2937; border-radius: 8px; padding: 10px; }
  </style>
</head>
<body>
  <div id="app">
    <canvas id="graph"></canvas>
    <aside>
      <h1>DinoBrain Vault Graph</h1>
      <p>Drag nodes. Use search to highlight files, folders, tags, and relationship nodes.</p>
      <input id="search" placeholder="Search nodes">
      <div class="stats">
        <div class="stat"><strong>${graph.stats.files}</strong>files</div>
        <div class="stat"><strong>${graph.stats.edges}</strong>edges</div>
        <div class="stat"><strong>${graph.stats.wikilinks}</strong>wikilinks</div>
        <div class="stat"><strong>${graph.stats.relation_edges}</strong>OS relation edges</div>
      </div>
      <p><code>${escapeHtml(graph.stats.data_root)}</code></p>
      <h2>Legend</h2>
      <div class="legend">
        <span><i class="dot" style="background:#6366f1"></i>Vault root</span>
        <span><i class="dot" style="background:#8b5cf6"></i>Wiki / curated memory</span>
        <span><i class="dot" style="background:#22c55e"></i>Accepted instances</span>
        <span><i class="dot" style="background:#94a3b8"></i>.dino traces/evaluations</span>
        <span><i class="dot" style="background:#2dd4bf"></i>Tags</span>
        <span><i class="dot" style="background:#f59e0b"></i>Golden eval cases</span>
      </div>
      <h2>Selected</h2>
      <div id="selected" class="node-detail">Click a node.</div>
      <h2>Reading</h2>
      <p>Pure Obsidian wikilinks are counted separately. A low wikilink count means the current graph is mostly OS structure, folder policy, tags, and evaluation relationships rather than hand-authored note-to-note links.</p>
    </aside>
  </div>
  <script>
    const graph = ${graphJson};
    const canvas = document.getElementById("graph");
    const ctx = canvas.getContext("2d");
    const selected = document.getElementById("selected");
    const search = document.getElementById("search");
    const nodes = graph.nodes.map((node, index) => ({ ...node, index, x: 0, y: 0, vx: 0, vy: 0 }));
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const edges = graph.edges.map((edge) => ({ ...edge, source: byId.get(edge.source), target: byId.get(edge.target) })).filter((edge) => edge.source && edge.target);
    let width = 0, height = 0, dragging = null, pointer = null, query = "";

    function resize() {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(400, rect.width);
      height = Math.max(300, rect.height);
      canvas.width = Math.floor(width * devicePixelRatio);
      canvas.height = Math.floor(height * devicePixelRatio);
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      seedPositions();
    }

    function seedPositions() {
      const groups = [...new Set(nodes.map((node) => node.group))];
      const groupAngle = new Map(groups.map((group, index) => [group, (Math.PI * 2 * index) / groups.length]));
      for (const node of nodes) {
        if (node.id === "vault") {
          node.x = width * 0.5; node.y = height * 0.5;
        } else {
          const angle = groupAngle.get(node.group) ?? 0;
          const radius = node.type === "folder" ? Math.min(width, height) * 0.22 : Math.min(width, height) * (0.28 + Math.random() * 0.22);
          node.x = width * 0.5 + Math.cos(angle + Math.random() * 0.7 - 0.35) * radius;
          node.y = height * 0.5 + Math.sin(angle + Math.random() * 0.7 - 0.35) * radius;
        }
      }
    }

    function tick() {
      for (const edge of edges) {
        const dx = edge.target.x - edge.source.x;
        const dy = edge.target.y - edge.source.y;
        const distance = Math.hypot(dx, dy) || 1;
        const desired = edge.label === "contains" ? 95 : 135;
        const force = (distance - desired) * 0.0025 * (edge.weight || 1);
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        if (edge.source.id !== "vault") { edge.source.vx += fx; edge.source.vy += fy; }
        edge.target.vx -= fx; edge.target.vy -= fy;
      }
      for (let i = 0; i < nodes.length; i += 1) {
        for (let j = i + 1; j < nodes.length; j += 1) {
          const a = nodes[i], b = nodes[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const distance = Math.max(1, Math.hypot(dx, dy));
          if (distance > 220) continue;
          const force = 18 / (distance * distance);
          const fx = (dx / distance) * force;
          const fy = (dy / distance) * force;
          if (a.id !== "vault") { a.vx -= fx; a.vy -= fy; }
          if (b.id !== "vault") { b.vx += fx; b.vy += fy; }
        }
      }
      for (const node of nodes) {
        if (node === dragging) {
          node.x = pointer.x; node.y = pointer.y; node.vx = 0; node.vy = 0;
          continue;
        }
        if (node.id === "vault") {
          node.x += (width * 0.5 - node.x) * 0.08;
          node.y += (height * 0.5 - node.y) * 0.08;
          continue;
        }
        node.vx += (width * 0.5 - node.x) * 0.0006;
        node.vy += (height * 0.5 - node.y) * 0.0006;
        node.vx *= 0.86; node.vy *= 0.86;
        node.x = Math.max(24, Math.min(width - 24, node.x + node.vx));
        node.y = Math.max(24, Math.min(height - 24, node.y + node.vy));
      }
    }

    function matches(node) {
      if (!query) return true;
      const haystack = [node.label, node.path, node.type, node.group, node.detail].join(" ").toLowerCase();
      return haystack.includes(query);
    }

    function draw() {
      ctx.clearRect(0, 0, width, height);
      for (let i = 0; i < 4; i += 1) tick();
      ctx.lineCap = "round";
      for (const edge of edges) {
        const visible = matches(edge.source) || matches(edge.target);
        ctx.globalAlpha = query && !visible ? 0.07 : edge.label === "contains" ? 0.18 : 0.34;
        ctx.strokeStyle = edge.label === "wikilink" ? "#a78bfa" : edge.label === "tag" ? "#2dd4bf" : "#64748b";
        ctx.lineWidth = edge.label === "contains" ? 1 : 1.5;
        ctx.beginPath();
        ctx.moveTo(edge.source.x, edge.source.y);
        ctx.lineTo(edge.target.x, edge.target.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      for (const node of nodes) {
        const hit = matches(node);
        const radius = node.size + (hit && query ? 4 : 0);
        ctx.globalAlpha = query && !hit ? 0.22 : 1;
        ctx.fillStyle = node.color;
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,.55)";
        ctx.lineWidth = node.id === "vault" ? 2 : 1;
        ctx.stroke();
        if (radius >= 8 || hit) {
          ctx.font = hit && query ? "600 12px Segoe UI, Arial" : "11px Segoe UI, Arial";
          ctx.fillStyle = "#e5e7eb";
          ctx.fillText(node.label.slice(0, 34), node.x + radius + 5, node.y + 4);
        }
      }
      ctx.globalAlpha = 1;
      requestAnimationFrame(draw);
    }

    function canvasPoint(event) {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }
    function nearestNode(point) {
      let best = null, bestDistance = Infinity;
      for (const node of nodes) {
        const distance = Math.hypot(node.x - point.x, node.y - point.y);
        if (distance < bestDistance && distance < node.size + 12) {
          best = node; bestDistance = distance;
        }
      }
      return best;
    }
    canvas.addEventListener("pointerdown", (event) => {
      pointer = canvasPoint(event);
      dragging = nearestNode(pointer);
      if (dragging) {
        selected.textContent = [dragging.label, dragging.type, dragging.path || "", dragging.detail || ""].filter(Boolean).join("\\n");
        canvas.setPointerCapture(event.pointerId);
      }
    });
    canvas.addEventListener("pointermove", (event) => { pointer = canvasPoint(event); });
    canvas.addEventListener("pointerup", () => { dragging = null; });
    search.addEventListener("input", () => { query = search.value.trim().toLowerCase(); });
    addEventListener("resize", resize);
    resize();
    draw();
  </script>
</body>
</html>
`;
}

function polarPoint(cx, cy, radius, angle) {
  return {
    x: cx + Math.cos(angle) * radius,
    y: cy + Math.sin(angle) * radius,
  };
}

function renderSvg(graph) {
  const width = 1400;
  const height = 950;
  const cx = width / 2;
  const cy = height / 2;
  const groups = [...new Set(graph.nodes.map((node) => node.group))].sort();
  const groupAngles = new Map(groups.map((group, index) => [group, (Math.PI * 2 * index) / groups.length - Math.PI / 2]));
  const nodesByGroup = new Map();
  for (const node of graph.nodes) {
    if (!nodesByGroup.has(node.group)) nodesByGroup.set(node.group, []);
    nodesByGroup.get(node.group).push(node);
  }

  const positions = new Map();
  positions.set("vault", { x: cx, y: cy });
  for (const [group, groupNodes] of nodesByGroup) {
    const angle = groupAngles.get(group) ?? 0;
    const center = polarPoint(cx, cy, 270, angle);
    groupNodes.forEach((node, index) => {
      if (node.id === "vault") return;
      const spread = (index - (groupNodes.length - 1) / 2) * 0.13;
      const ring = node.type === "folder" ? 130 : 210 + (index % 4) * 34;
      positions.set(node.id, polarPoint(center.x, center.y, ring, angle + spread));
    });
  }

  const edgeLines = graph.edges
    .map((edge) => {
      const source = positions.get(edge.source);
      const target = positions.get(edge.target);
      if (!source || !target) return "";
      const stroke = edge.label === "wikilink" ? "#a78bfa" : edge.label === "tag" ? "#2dd4bf" : "#475569";
      const widthValue = edge.label === "contains" ? 1 : 1.4;
      const opacity = edge.label === "contains" ? 0.18 : 0.38;
      return `<line x1="${source.x.toFixed(1)}" y1="${source.y.toFixed(1)}" x2="${target.x.toFixed(1)}" y2="${target.y.toFixed(1)}" stroke="${stroke}" stroke-width="${widthValue}" opacity="${opacity}" />`;
    })
    .join("\n");

  const nodeCircles = graph.nodes
    .map((node) => {
      const position = positions.get(node.id);
      if (!position) return "";
      const radius = node.size + 2;
      const label = escapeHtml(node.label).slice(0, 42);
      return `<g>
  <circle cx="${position.x.toFixed(1)}" cy="${position.y.toFixed(1)}" r="${radius}" fill="${node.color}" stroke="#e5e7eb" stroke-opacity=".42" />
  <text x="${(position.x + radius + 5).toFixed(1)}" y="${(position.y + 4).toFixed(1)}" fill="#e5e7eb" font-size="11" font-family="Segoe UI, Arial">${label}</text>
</g>`;
    })
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="#080b13" />
<circle cx="${cx}" cy="${cy}" r="390" fill="#101827" opacity=".65" />
<text x="28" y="42" fill="#f8fafc" font-size="24" font-family="Segoe UI, Arial" font-weight="700">DinoBrain Vault Graph</text>
<text x="28" y="70" fill="#cbd5e1" font-size="13" font-family="Segoe UI, Arial">files=${graph.stats.files} edges=${graph.stats.edges} wikilinks=${graph.stats.wikilinks} os-relations=${graph.stats.relation_edges}</text>
${edgeLines}
${nodeCircles}
</svg>
`;
}

async function main() {
  const graph = await buildGraph();
  await fs.mkdir(outDir, { recursive: true });
  await atomicWriteJson(jsonPath, graph);
  await atomicWriteText(htmlPath, renderHtml(graph));
  await atomicWriteText(svgPath, renderSvg(graph));
  console.log(
    JSON.stringify(
      {
        ok: true,
        ...graph.stats,
        html_path: htmlPath,
        svg_path: svgPath,
        json_path: jsonPath,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
