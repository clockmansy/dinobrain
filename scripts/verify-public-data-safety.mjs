import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DATA_CLASSIFICATION_POLICY_VERSION,
  PUBLIC_DATA_MAX_SCAN_BYTES,
  classifyDataFile,
  classifyDataPath,
} from "../dist/data-classification.js";
import { classifyCompleteGitHistory, classifyGitTree } from "./lib/data-classifier-git.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "..");
const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR || path.join(appRoot, "..", "dinobrain-data"));
const shouldWrite = process.argv.includes("--write");
const failOnWarnings = !process.argv.includes("--allow-warnings");
const jsonOnly = process.argv.includes("--json");
const maxScanBytes = PUBLIC_DATA_MAX_SCAN_BYTES;
const generatedAt = new Date().toISOString();

function git(args, cwd = dataRoot, options = {}) {
  return execFileSync("git", ["-c", `safe.directory=${cwd}`, "-C", cwd, ...args], {
    encoding: Object.prototype.hasOwnProperty.call(options, "encoding") ? options.encoding : "utf8",
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

function toSlash(value) {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function splitZ(value) {
  return value.split("\0").filter(Boolean);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function localPathLabel(relativePath) {
  return `(local-path-sha256:${sha256(relativePath).slice(0, 20)})`;
}

function pathExists(relativePath) {
  return existsSync(path.join(dataRoot, relativePath));
}

function readContent(relativePath) {
  const fullPath = path.join(dataRoot, relativePath);
  let size = 0;
  let fileKind = "file";
  try {
    const stat = lstatSync(fullPath);
    size = stat.size;
    fileKind = stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : "other";
  } catch (error) {
    if (error.code === "ENOENT") return { content: null, size: 0, fileKind: "other", missing: true };
    throw error;
  }
  const content = fileKind === "file" && size <= maxScanBytes ? readFileSync(fullPath) : null;
  return {
    content,
    size,
    fileKind,
  };
}

function modeToFileKind(mode) {
  if (mode === "120000") return "symlink";
  if (mode === "100644" || mode === "100755") return "file";
  return "other";
}

function gitHeadEntries() {
  const entries = [];
  for (const token of splitZ(git(["ls-tree", "-r", "-z", "--full-tree", "HEAD"]))) {
    const match = token.match(/^(\d{6})\s+(\w+)\s+([0-9a-f]+)\t([\s\S]+)$/i);
    if (!match) throw new Error(`Unexpected git ls-tree entry: ${token.slice(0, 160)}`);
    entries.push({
      mode: match[1],
      type: match[2],
      oid: match[3],
      path: toSlash(match[4]),
      fileKind: modeToFileKind(match[1]),
    });
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function readHeadEntry(entry) {
  let size = 0;
  try {
    size = Number(git(["cat-file", "-s", entry.oid]).trim());
  } catch (error) {
    return { content: null, size: 0, fileKind: entry.fileKind, error: error.message };
  }
  if (entry.fileKind !== "file" || !Number.isFinite(size) || size > maxScanBytes) {
    return { content: null, size, fileKind: entry.fileKind };
  }
  try {
    return {
      content: git(["cat-file", "blob", entry.oid], dataRoot, {
        encoding: null,
        maxBuffer: maxScanBytes + 1024 * 1024,
      }),
      size,
      fileKind: entry.fileKind,
    };
  } catch (error) {
    return { content: null, size, fileKind: entry.fileKind, error: error.message };
  }
}

function parseGitHubRepo(remoteUrl) {
  const cleaned = remoteUrl.trim().replace(/\.git$/, "");
  let match = cleaned.match(/github\.com[:/]([^/\s]+)\/([^/\s]+)$/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

function fetchGitHubRepoInfo(repo) {
  if (!repo) return Promise.resolve({ status: "unknown", reason: "remote is not a GitHub repo" });
  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}`;
  return new Promise((resolve) => {
    const request = https.get(
      url,
      {
        timeout: 3000,
        headers: {
          "User-Agent": "DinoBrain-public-data-safety",
          Accept: "application/vnd.github+json",
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode === 404) {
            resolve({ status: "not_found_or_private", owner: repo.owner, repo: repo.repo });
            return;
          }
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            resolve({ status: "unknown", owner: repo.owner, repo: repo.repo, http_status: response.statusCode });
            return;
          }
          try {
            const parsed = JSON.parse(body);
            resolve({
              status: "observed",
              owner: repo.owner,
              repo: repo.repo,
              private: Boolean(parsed.private),
              visibility: parsed.visibility || (parsed.private ? "private" : "public"),
              html_url: parsed.html_url || null,
            });
          } catch (error) {
            resolve({ status: "unknown", owner: repo.owner, repo: repo.repo, reason: error.message });
          }
        });
      },
    );
    request.on("timeout", () => {
      request.destroy();
      resolve({ status: "unknown", owner: repo.owner, repo: repo.repo, reason: "GitHub API timeout" });
    });
    request.on("error", (error) => {
      resolve({ status: "unknown", owner: repo.owner, repo: repo.repo, reason: error.message });
    });
  });
}

function hasReviewLineage(record) {
  return Boolean(
    record.source_candidate_path ||
      record.reviewed_by ||
      record.reviewed_at ||
      String(record.review_status || "").toLowerCase().includes("accepted"),
  );
}

const findings = [];
const findingCounts = new Map();
const findingLevelCounts = new Map();
const maxExamplesPerFinding = 25;

function addFinding(level, id, relativePath, detail = {}) {
  const count = (findingCounts.get(id) || 0) + 1;
  findingCounts.set(id, count);
  findingLevelCounts.set(level, (findingLevelCounts.get(level) || 0) + 1);
  if (count <= maxExamplesPerFinding) {
    findings.push({
      level,
      id,
      path: relativePath,
      ...detail,
    });
  }
}

function recordClassificationFindings(relativePath, classification, idPrefix = "") {
  for (const finding of classification.findings) {
    addFinding(finding.severity === "blocker" ? "blocker" : "warning", `${idPrefix}${finding.id}`, relativePath, {
      category: finding.category,
      ...(finding.line ? { line: finding.line } : {}),
      ...(finding.detail ? { detail: finding.detail } : {}),
    });
  }
}

function scanCommittedEntry(entry) {
  const relativePath = entry.path;
  const policy = classifyDataPath(relativePath);
  if (policy.classification === "blocked") {
    addFinding("blocker", "blocked_path_is_committed", relativePath, { policy: policy.policy });
  }
  const { content, size, fileKind, error } = readHeadEntry(entry);
  if (error) addFinding("blocker", "committed_blob_unreadable", relativePath, { detail: error });
  const classification = classifyDataFile({ relativePath, content, sizeBytes: size, maxScanBytes, fileKind });
  recordClassificationFindings(relativePath, classification);
  return policy;
}

function classifyWorkingFile(relativePath) {
  const { content, size, fileKind, missing } = readContent(relativePath);
  if (missing) return null;
  return classifyDataFile({ relativePath, content, sizeBytes: size, maxScanBytes, fileKind });
}

function countRequiredCategories(paths) {
  const categories = {
    accepted_memories: /^50_Instances\/accepted\//,
    task_summaries: /^\.dino\/tasks\//,
    traces: /^\.dino\/traces\//,
    context_packs: /^\.dino\/context-packs\//,
    events: /^\.dino\/events\//,
    gates: /^\.dino\/gates\//,
    audits: /^\.dino\/audits\//,
    operations_records: /^60_Operations\//,
  };
  const counts = Object.fromEntries(Object.keys(categories).map((key) => [key, 0]));
  for (const relativePath of paths) {
    for (const [key, pattern] of Object.entries(categories)) {
      if (pattern.test(relativePath)) counts[key] += 1;
    }
  }
  return counts;
}

function checkIndexExclusions() {
  const indexPath = ".dino/index/wiki-index.json";
  if (!pathExists(indexPath)) {
    return {
      checked: false,
      status: "not_present_local_only",
      reason: "generated Wiki index is local-only and absent from the public checkout",
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(path.join(dataRoot, indexPath), "utf8"));
    const records = Array.isArray(parsed.records) ? parsed.records : [];
    const excludedRoots = [/^10_Conversations\/raw\//, /^50_Instances\/candidates\//, /^80_Review_Queue\//];
    for (const record of records) {
      const recordPath = String(record.path || "");
      if (excludedRoots.some((pattern) => pattern.test(recordPath))) {
        addFinding("blocker", "unreviewed_or_raw_record_indexed", indexPath, { record_path: recordPath });
      }
      if (/^50_Instances\/accepted\/.+\.json$/.test(recordPath)) {
        const fullRecordPath = path.join(dataRoot, recordPath);
        try {
          const parsed = JSON.parse(readFileSync(fullRecordPath, "utf8"));
          if (parsed.auto_generated === true && !hasReviewLineage(parsed)) {
            addFinding("blocker", "unreviewed_generated_accepted_indexed", indexPath, { record_path: recordPath });
          }
        } catch (error) {
          addFinding("blocker", "indexed_accepted_record_unreadable", indexPath, { record_path: recordPath, error: error.message });
        }
      }
    }
    return { checked: true, status: "checked", record_count: records.length };
  } catch (error) {
    addFinding("blocker", "wiki_index_unreadable", indexPath, { error: error.message });
    return { checked: false, reason: error.message };
  }
}

function checkAppDocsAgainstVisibility(dataVisibility) {
  const docsToCheck = ["README.md", "docs/INSTALL.md", "docs/SYNC_POLICY.md"];
  const publicData =
    dataVisibility.status === "observed" ? dataVisibility.private === false : dataVisibility.status !== "not_found_or_private";
  const privateOnlyPhrases = [
    /data vault lives in a separate private repository/i,
    /private data vault/i,
    /GitHub access to both private repos/i,
    /private sync server/i,
  ];
  const results = [];
  for (const relativePath of docsToCheck) {
    const fullPath = path.join(appRoot, relativePath);
    if (!existsSync(fullPath)) continue;
    const text = readFileSync(fullPath, "utf8");
    for (const pattern of privateOnlyPhrases) {
      if (pattern.test(text)) {
        const level = publicData ? "blocker" : "warning";
        addFinding(level, "public_private_doc_conflict", relativePath, { pattern: String(pattern) });
        results.push({ path: relativePath, pattern: String(pattern), level });
      }
    }
  }
  return { checked_files: docsToCheck, conflicts: results };
}

function gitTrackedFiles() {
  return splitZ(git(["ls-files", "-z"])).map(toSlash).sort();
}

function gitUntrackedFiles() {
  const output = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const entries = splitZ(output);
  const files = [];
  for (const entry of entries) {
    if (entry.startsWith("?? ")) files.push(toSlash(entry.slice(3)));
  }
  return files.sort();
}

function gitNameList(args) {
  return splitZ(git(args)).map(toSlash).sort();
}

function gitDirtyState() {
  const staged = gitNameList(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACDMRTUXB"]);
  const unstaged = gitNameList(["diff", "--name-only", "-z", "--diff-filter=ACDMRTUXB"]);
  const untracked = gitUntrackedFiles();
  return {
    staged,
    unstaged,
    untracked,
    all: Array.from(new Set([...staged, ...unstaged, ...untracked])).sort(),
  };
}

function buildLocalExclusions(dirty) {
  const staged = new Set(dirty.staged);
  const untracked = new Set(dirty.untracked);
  const byPathClassification = { syncable: 0, conditional: 0, blocked: 0 };
  const byContentClassification = { syncable: 0, conditional: 0, blocked: 0, deleted: 0 };
  const contentFindingCounts = {};
  const ledgerEntries = [];

  for (const relativePath of dirty.all) {
    const policy = classifyDataPath(relativePath);
    byPathClassification[policy.classification] += 1;
    const content = classifyWorkingFile(relativePath);
    const contentClassification = content?.classification ?? "deleted";
    byContentClassification[contentClassification] += 1;
    const contentFindingIds = content?.findings.map((finding) => finding.id) ?? [];
    for (const id of contentFindingIds) contentFindingCounts[id] = (contentFindingCounts[id] ?? 0) + 1;

    if (!policy.explicit_allowlist) {
      addFinding("blocker", "unclassified_local_dirty_path", localPathLabel(relativePath), { policy: policy.policy });
    }
    if (staged.has(relativePath)) {
      addFinding("blocker", "staged_local_change_present", localPathLabel(relativePath), { policy: policy.policy });
    }
    ledgerEntries.push({
      path: relativePath,
      path_classification: policy.classification,
      policy: policy.policy,
      explicit_allowlist: policy.explicit_allowlist,
      content_classification: contentClassification,
      content_findings: contentFindingIds,
      staged: staged.has(relativePath),
      untracked: untracked.has(relativePath),
      completion_claim: "excluded_local_dirty",
    });
  }

  const ledgerSha256 = sha256(JSON.stringify(ledgerEntries));
  return {
    summary: {
    all_paths_explicitly_classified: dirty.all.every((relativePath) => classifyDataPath(relativePath).explicit_allowlist),
    staged_count: dirty.staged.length,
    dirty_count: dirty.all.length,
    by_path_classification: byPathClassification,
    by_content_classification: byContentClassification,
    content_finding_counts: contentFindingCounts,
      ledger_id: `local-exclusions-${ledgerSha256.slice(0, 20)}`,
      ledger_sha256: ledgerSha256,
      ledger_entry_count: ledgerEntries.length,
      raw_paths_in_public_report: false,
    },
    ledger: {
      version: 1,
      generated_at: generatedAt,
      data_root: dataRoot,
      ledger_sha256: ledgerSha256,
      entries: ledgerEntries,
    },
  };
}

function persistLocalExclusionLedger(localExclusions) {
  const ledgerRoot = path.resolve(
    process.env.DINOBRAIN_PUBLIC_SAFETY_LEDGER_DIR ||
      path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "DinoBrain", "public-safety-ledgers"),
  );
  mkdirSync(ledgerRoot, { recursive: true });
  const ledgerPath = path.join(ledgerRoot, `${localExclusions.summary.ledger_id}.json`);
  writeFileSync(ledgerPath, `${JSON.stringify(localExclusions.ledger, null, 2)}\n`, "utf8");
  return {
    persisted: true,
    ledger_id: localExclusions.summary.ledger_id,
    ledger_sha256: localExclusions.summary.ledger_sha256,
  };
}

function remoteUrl() {
  try {
    return git(["config", "--get", "remote.origin.url"]).trim();
  } catch {
    return "";
  }
}

function branchState() {
  try {
    return git(["status", "--short", "--branch"]).trim();
  } catch (error) {
    return `unavailable: ${error.message}`;
  }
}

function revParse(ref) {
  try {
    return git(["rev-parse", ref]).trim();
  } catch {
    return null;
  }
}

function repositoryParity() {
  let upstreamRef = null;
  try {
    upstreamRef = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).trim() || null;
  } catch {
    // Repositories without an upstream can still be inspected; release parity is checked separately.
  }
  const head = revParse("HEAD");
  const upstreamHead = upstreamRef ? revParse(upstreamRef) : null;
  if (head && upstreamHead && head !== upstreamHead) {
    addFinding("blocker", "local_head_differs_from_upstream", "(git metadata)", {
      head,
      upstream_ref: upstreamRef,
      upstream_head: upstreamHead,
    });
  }
  return {
    head,
    upstream_ref: upstreamRef,
    upstream_head: upstreamHead,
    head_matches_upstream: Boolean(head && upstreamHead && head === upstreamHead),
  };
}

function summarizeFindings() {
  const byLevel = Object.fromEntries(findingLevelCounts.entries());
  const byId = {};
  for (const [id, count] of findingCounts.entries()) {
    byId[id] = count;
  }
  return { by_level: byLevel, by_id: byId };
}

function writeMarkdownReport(report, outputPath) {
  const lines = [
    "# DinoBrain Public Data Safety Report",
    "",
    `Generated at: ${report.generated_at}`,
    `Status: ${report.status}`,
    `Data repo: ${report.data_repo.remote || "unknown"}`,
    `GitHub visibility: ${report.data_repo.github_visibility.visibility || report.data_repo.github_visibility.status}`,
    "",
    "## Scan Scope",
    "",
    `- committed HEAD files scanned: ${report.scanned.committed_files}`,
    `- local dirty files explicitly excluded: ${report.scanned.local_exclusions.dirty_count}`,
    `- max bytes per file: ${report.scanned.max_scan_bytes}`,
    `- history blob paths scanned: ${report.scanned.git_history.history_unique_blob_paths}`,
    `- classifier policy: ${report.policy_version}`,
    "",
    "## Required Categories",
    "",
    ...Object.entries(report.scanned.required_category_counts).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "## Findings",
    "",
    `- blockers: ${report.finding_summary.by_level.blocker || 0}`,
    `- warnings: ${report.finding_summary.by_level.warning || 0}`,
    "",
  ];
  if (report.findings.length === 0) {
    lines.push("No findings.");
  } else {
    for (const finding of report.findings.slice(0, 80)) {
      const detail = Object.entries(finding)
        .filter(([key]) => !["level", "id", "path"].includes(key))
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(", ");
      lines.push(`- ${finding.level}: ${finding.id} :: ${finding.path}${detail ? ` (${detail})` : ""}`);
    }
    const omitted = Math.max(0, report.findings.length - 80);
    if (omitted > 0) lines.push(`- ${omitted} additional example findings omitted from markdown.`);
  }
  lines.push(
    "",
    "## Policy Assertions",
    "",
    "- Raw conversation archives must remain local-only and untracked.",
    "- Candidate and review queue records must not appear in the default Wiki index.",
    "- Public/private documentation must match observed GitHub visibility.",
    "- Sensitive pattern matches are reported by type and line only; matched secret values are never printed.",
    "",
  );
  writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
}

async function main() {
  if (!existsSync(dataRoot)) {
    throw new Error(`DinoBrain data root not found: ${dataRoot}`);
  }

  const committedTree = classifyGitTree(dataRoot, "HEAD");
  const trackedFiles = committedTree.results.map((entry) => entry.path).sort();
  const dirty = gitDirtyState();
  const remote = remoteUrl();
  const repo = parseGitHubRepo(remote);
  const githubVisibility = await fetchGitHubRepoInfo(repo);
  const policyCounts = {
    syncable: 0,
    conditional: 0,
    blocked: 0,
    unknown: 0,
  };

  for (const entry of committedTree.results) {
    const policy = classifyDataPath(entry.path);
    if (policy.classification === "blocked") {
      addFinding("blocker", "blocked_path_is_committed", entry.path, { policy: policy.policy });
    }
    recordClassificationFindings(entry.path, entry);
    policyCounts[policy.classification] += 1;
  }

  const localExclusions = buildLocalExclusions(dirty);
  let localLedgerPersistence;
  try {
    localLedgerPersistence = persistLocalExclusionLedger(localExclusions);
  } catch (error) {
    localLedgerPersistence = { persisted: false, error: error.message };
    addFinding("blocker", "local_exclusion_ledger_write_failed", "(local-ledger)", { detail: error.message });
  }

  const indexExclusion = checkIndexExclusions();
  const docVisibility = checkAppDocsAgainstVisibility(githubVisibility);
  const parity = repositoryParity();
  const gitHistory = classifyCompleteGitHistory(dataRoot, { revisions: ["HEAD"] });
  for (let index = 0; index < gitHistory.summary.blocked; index += 1) {
    const example = gitHistory.blocker_examples[index] ?? null;
    addFinding("blocker", "git_history_risk_detected", example?.path ?? "(historical blob)", {
      policy: example?.policy ?? "historical_content_block",
      findings: example?.findings ?? [],
    });
  }
  const findingSummary = summarizeFindings();
  const blockerCount = findingSummary.by_level.blocker || 0;
  const warningCount = findingSummary.by_level.warning || 0;
  const status = blockerCount > 0 ? "fail" : warningCount > 0 ? "degraded" : "pass";

  const report = {
    report_type: "dinobrain_public_data_safety",
    policy_version: DATA_CLASSIFICATION_POLICY_VERSION,
    generated_at: generatedAt,
    status,
    result: {
      ok: blockerCount === 0 && (!failOnWarnings || warningCount === 0),
      blocker_count: blockerCount,
      warning_count: warningCount,
    },
    data_repo: {
      remote,
      ...parity,
      github_visibility: githubVisibility,
      visibility_policy: "treat data as public when GitHub says public or visibility is unknown",
    },
    scanned: {
      tracked_files: trackedFiles.length,
      committed_files: committedTree.results.length,
      untracked_files: dirty.untracked.length,
      dirty_files: dirty.all.length,
      max_scan_bytes: maxScanBytes,
      scan_completeness_policy: "fail_closed_committed_tree_and_HEAD_history_with_explicit_local_dirty_exclusions",
      completion_claim_scope: "committed HEAD tree and history reachable from HEAD; unstaged local state is excluded only when every path is explicitly classified",
      path_policy_counts: policyCounts,
      committed_tree: committedTree.report,
      local_exclusions: {
        ...localExclusions.summary,
        ledger_persisted: localLedgerPersistence.persisted === true,
      },
      git_history: gitHistory,
      required_category_counts: countRequiredCategories(trackedFiles),
      index_exclusion: indexExclusion,
      doc_visibility: docVisibility,
    },
    finding_summary: findingSummary,
    findings,
    suppressed_example_counts: Object.fromEntries(
      Array.from(findingCounts.entries())
        .map(([id, count]) => [id, Math.max(0, count - maxExamplesPerFinding)])
        .filter(([, count]) => count > 0),
    ),
  };

  if (shouldWrite) {
    const reportDir = path.join(dataRoot, "60_Operations", "public-data-safety");
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(path.join(reportDir, "public-data-safety-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    writeMarkdownReport(report, path.join(reportDir, "public-data-safety-report.md"));
  }

  if (jsonOnly) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        `DinoBrain public-data safety: ${status}`,
        `committed_files=${committedTree.results.length}`,
        `local_dirty_excluded=${dirty.all.length}`,
        `blockers=${blockerCount}`,
        `warnings=${warningCount}`,
        `visibility=${githubVisibility.visibility || githubVisibility.status}`,
        shouldWrite ? "report_written=60_Operations/public-data-safety/public-data-safety-report.{json,md}" : "report_written=false",
        "",
      ].join("\n"),
    );
  }

  if (blockerCount > 0 || (failOnWarnings && warningCount > 0)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
