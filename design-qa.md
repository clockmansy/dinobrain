**Design Direction**
- Goal: remove the dinosaur/fossil visual metaphor from the Observatory graph entirely.
- Target: a clean operational knowledge graph that prioritizes scanning, clustering, search, and hover detail.

**Implementation**
- URL: `http://127.0.0.1:3847/`
- Latest screenshot: `C:/Users/USER/Documents/dinobrain/.codex-remote-attachments/dinobrain-observatory-no-dino-viewport.png`
- Viewport: desktop 1280x720, graph panel scrolled into view.
- State: live Observatory data.

**Focused Region**
- Region: Knowledge Graph canvas.
- Evidence: graph nodes are now organized by semantic clusters: Sources, Wiki, Projects, Instances, Operations, Live Activity, Context, Tags, Types, and Archive.
- Removed visual metaphor: no silhouette, no fossil guide routes, no decorative anatomical scaffold, and no always-on long task labels.

**Findings**
- No actionable P0/P1/P2 findings remain after build and rendered-screen verification.

**Required Surfaces**
- Fonts and typography: existing Observatory font stack remains intact; default labels are limited to graph hubs and important folders.
- Layout: graph canvas keeps the dashboard density while providing enough room for semantic clusters.
- Colors: existing dark operational palette remains, with amber/teal/blue retained only as data-role colors.
- Interaction: search and hover remain the path to detailed labels and highlighted edges.
- Copy: graph title is now `Knowledge Graph`.

**Patches Made**
- Removed the graph background silhouette/guide renderer.
- Removed fossil/dinosaur naming from the graph renderer.
- Replaced pose/silhouette terminology with cluster/layout terminology.
- Updated the graph title from `DinoBrain Fossil Graph` to `Knowledge Graph`.
- Removed the prior dinosaur reference image as the QA source of truth.

final result: passed
