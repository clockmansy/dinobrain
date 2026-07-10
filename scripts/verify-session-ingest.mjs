import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DINOBRAIN_VERSION } from "./lib/version-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(root, "dist", "index.js");
const tempDataRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-session-ingest-"));

for (const dir of [
  "10_Conversations/raw",
  "50_Instances/candidates",
  "80_Review_Queue/promotion",
  ".dino/events",
]) {
  mkdirSync(path.join(tempDataRoot, dir), { recursive: true });
}

spawnSync("git", ["init"], { cwd: tempDataRoot, stdio: "ignore" });
const pressureSeed = spawnSync(process.execPath, [path.join(root, "dist", "build-review-backpressure.js")], {
  cwd: root,
  env: { ...process.env, DINOBRAIN_DATA_DIR: tempDataRoot },
  encoding: "utf8",
});
if (pressureSeed.status !== 0) {
  throw new Error(`Could not seed review admission state: ${pressureSeed.stderr || pressureSeed.stdout}`);
}

const client = new Client({
  name: "dinobrain-session-ingest-verify",
  version: DINOBRAIN_VERSION,
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: root,
  env: {
    ...process.env,
    DINOBRAIN_DATA_DIR: tempDataRoot,
  },
  stderr: "pipe",
});

function parseTool(result) {
  const text = result.content?.find((part) => part.type === "text")?.text;
  if (!text) throw new Error("Tool did not return text content");
  return JSON.parse(text);
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(tempDataRoot, relativePath), "utf8"));
}

function filesUnder(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(fullPath));
    if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

function assertNoSecretLeak() {
  const forbidden = [
    "sk-testSECRETSECRETSECRETSECRET",
    "should-not-leak",
    "bearer-secret-value",
    "plain-password",
    "ghp_TESTTOKENVALUE1234567890",
    "AKIAIOSFODNN7EXAMPLE",
    "eyJhbGciOiJIUzI1NiJ9",
    "session-cookie-secret",
  ];
  for (const filePath of filesUnder(tempDataRoot)) {
    if (filePath.includes(`${path.sep}.git${path.sep}`)) continue;
    const text = readFileSync(filePath, "utf8");
    for (const value of forbidden) {
      if (text.includes(value)) {
        throw new Error(`Sensitive value leaked into ${path.relative(tempDataRoot, filePath)}: ${value}`);
      }
    }
  }
}

try {
  await client.connect(transport);

  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name);
  if (!toolNames.includes("import_session")) {
    throw new Error("Missing import_session tool");
  }

  const imported = parseTool(
    await client.callTool({
      name: "import_session",
      arguments: {
        source: "codex-test-session",
        project: "dinobrain",
        title: "session ingest verification",
        sensitivity: "normal",
        max_candidates: 10,
        raw_retention: "redacted_excerpt",
        messages: [
          {
            role: "user",
            content:
              "\ub098\ub294 \uacc4\ud68d\uc11c\uc5d0 \ub9de\ucd98 \uc5c5\ubb34\ub9cc \uc6d0\ud574.",
          },
          {
            role: "user",
            content:
              "SQLite \uc0e4\ub529 \uad6c\uc870\ub85c \uacb0\uc815\ud558\uc790.",
          },
          {
            role: "assistant",
            content:
              "\uc624\ub958\uac00 \ub098\uba74 \uc6d0\uc778 \ubd84\uc11d \uba3c\uc800 \ud558\uace0 fix \uae30\ub85d\uc744 \ub0a8\uae34\ub2e4.",
          },
          {
            role: "assistant",
            content:
              "\uc124\uce58 \ubc29\ubc95\uc740 install.ps1\uc744 \uc2e4\ud589\ud558\uace0 verify:os\ub85c \uac80\uc99d\ud55c\ub2e4.",
          },
          {
            role: "user",
            content: "\ub098\uc911\uc5d0 LLM Wiki proposal\uc744 \ub9ac\ubdf0\ud558\uc790.",
          },
          {
            role: "tool",
            content:
              "api_key: should-not-leak sk-testSECRETSECRETSECRETSECRET Bearer bearer-secret-value password=plain-password ghp_TESTTOKENVALUE1234567890 AKIAIOSFODNN7EXAMPLE cookie=session-cookie-secret eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
          },
        ],
      },
    }),
  );

  if (imported.ok !== true) throw new Error(`import_session failed: ${JSON.stringify(imported)}`);
  if (imported.raw_full_transcript_stored !== false) {
    throw new Error("import_session must report raw_full_transcript_stored=false");
  }
  if (!imported.archive_path.startsWith("10_Conversations/raw/")) {
    throw new Error(`Unexpected archive path: ${imported.archive_path}`);
  }
  if (!existsSync(path.join(tempDataRoot, imported.archive_path))) {
    throw new Error(`Missing session archive: ${imported.archive_path}`);
  }
  if (imported.candidate_count < 4) {
    throw new Error(`Expected several candidates, got ${imported.candidate_count}`);
  }

  const archive = readJson(imported.archive_path);
  if (archive.storage_policy?.raw_full_transcript_stored !== false) {
    throw new Error("Session archive did not preserve raw-full-transcript guard");
  }
  if (archive.sync_policy !== "local_only" || archive.temperature !== "cold") {
    throw new Error("Session archive must be cold and local-only");
  }
  if (!Array.isArray(archive.redactions) || archive.redactions.length < 2) {
    throw new Error("Session archive did not record expected redactions");
  }
  if (
    !archive.messages.every(
      (message) =>
        typeof message.redacted_sha256 === "string" &&
        message.redacted_sha256.length === 64 &&
        (message.preview === null || message.preview.length <= 360),
    )
  ) {
    throw new Error("Session archive message previews are not bounded metadata/excerpts");
  }

  const candidates = imported.candidate_paths.map((candidatePath) => readJson(candidatePath));
  const categories = new Set(candidates.map((candidate) => candidate.category));
  for (const expectedCategory of ["user_preference", "project_decision", "error_fix", "how_to", "idea"]) {
    if (!categories.has(expectedCategory)) {
      throw new Error(`Missing extracted category: ${expectedCategory}`);
    }
  }
  for (const candidate of candidates) {
    if (candidate.status !== "pending_review" || candidate.auto_promote !== false) {
      throw new Error(`Candidate bypassed review: ${candidate.candidate_id}`);
    }
    if (!candidate.promotion_blockers?.includes("session_extraction_v0")) {
      throw new Error(`Candidate missing session extraction blocker: ${candidate.candidate_id}`);
    }
    if (!["hot", "warm", "cold"].includes(candidate.temperature)) {
      throw new Error(`Candidate missing hot/warm/cold temperature: ${candidate.candidate_id}`);
    }
  }
  for (const reviewPath of imported.review_paths) {
    const review = readJson(reviewPath);
    if (review.type !== "session_extract_promotion" || review.status !== "pending") {
      throw new Error(`Unexpected review record: ${reviewPath}`);
    }
  }

  const search = parseTool(
    await client.callTool({
      name: "wiki_search",
      arguments: {
        query: "\uacc4\ud68d\uc11c SQLite proposal",
        limit: 20,
      },
    }),
  );
  const searchPaths = new Set(search.results.map((result) => result.path));
  for (const importedPath of [imported.archive_path, ...imported.candidate_paths, ...imported.review_paths]) {
    if (searchPaths.has(importedPath)) {
      throw new Error(`Imported unreviewed path appeared in wiki_search: ${importedPath}`);
    }
  }

  const contextPack = parseTool(
    await client.callTool({
      name: "get_context_pack",
      arguments: {
        question: "\uacc4\ud68d\uc11c SQLite proposal",
        limit: 20,
      },
    }),
  );
  const contextPaths = new Set(contextPack.items.map((item) => item.path));
  for (const importedPath of [imported.archive_path, ...imported.candidate_paths, ...imported.review_paths]) {
    if (contextPaths.has(importedPath)) {
      throw new Error(`Imported unreviewed path appeared in Context Pack: ${importedPath}`);
    }
  }

  assertNoSecretLeak();

  const gitSync = parseTool(
    await client.callTool({
      name: "git_sync",
      arguments: {
        include_sensitive_scan: true,
      },
    }),
  );
  const syncFiles = new Map(gitSync.files.map((file) => [file.path, file]));
  const rawFile = syncFiles.get(imported.archive_path);
  if (!rawFile || rawFile.classification !== "blocked" || rawFile.action !== "do_not_sync") {
    throw new Error("git_sync did not block imported raw session archive");
  }
  for (const candidatePath of imported.candidate_paths) {
    const file = syncFiles.get(candidatePath);
    if (!file || file.classification !== "conditional") {
      throw new Error(`git_sync did not mark candidate as conditional: ${candidatePath}`);
    }
  }
  for (const reviewPath of imported.review_paths) {
    const file = syncFiles.get(reviewPath);
    if (!file || file.classification !== "conditional") {
      throw new Error(`git_sync did not mark review item as conditional: ${reviewPath}`);
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        data_root: tempDataRoot,
        session_id: imported.session_id,
        archive_path: imported.archive_path,
        candidate_count: imported.candidate_count,
        temperature_counts: imported.temperature_counts,
        category_counts: imported.category_counts,
        redaction_hits: imported.redaction_hits,
        search_result_count: search.result_count,
        context_item_count: contextPack.item_count,
        git_sync_summary: gitSync.summary,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
}
