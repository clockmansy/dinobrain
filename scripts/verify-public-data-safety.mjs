import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DATA_CLASSIFICATION_POLICY_VERSION,
  PUBLIC_DATA_MAX_SCAN_BYTES,
  classifyDataFile,
  classifyDataPath,
} from "../dist/data-classification.js";
import { classifyCompleteGitHistory } from "./lib/data-classifier-git.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "..");
const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR || path.join(appRoot, "..", "dinobrain-data"));
const shouldWrite = process.argv.includes("--write");
const failOnWarnings = process.argv.includes("--fail-on-warnings");
const jsonOnly = process.argv.includes("--json");
const maxScanBytes = PUBLIC_DATA_MAX_SCAN_BYTES;
const generatedAt = new Date().toISOString();

function git(args, cwd = dataRoot, options = {}) {
  return execFileSync("git", ["-c", `safe.directory=${cwd}`, "-C", cwd, ...args], {
    encoding: options.encoding || "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function toSlash(value) {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function splitZ(value) {
  return value.split("\0").filter(Boolean);
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

function scanFile(relativePath, tracked) {
  const policy = classifyDataPath(relativePath);
  if (tracked && policy.classification === "blocked") {
    addFinding("blocker", "blocked_path_is_tracked", relativePath, { policy: policy.policy });
  }
  const { content, size, fileKind, missing } = readContent(relativePath);
  if (missing) return policy;
  const classification = classifyDataFile({ relativePath, content, sizeBytes: size, maxScanBytes, fileKind });
  for (const finding of classification.findings) {
    addFinding(finding.severity === "blocker" ? "blocker" : "warning", finding.id, relativePath, {
      category: finding.category,
      ...(finding.line ? { line: finding.line } : {}),
      ...(finding.detail ? { detail: finding.detail } : {}),
    });
  }

  return policy;
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
    addFinding("warning", "wiki_index_missing_for_exclusion_check", indexPath);
    return { checked: false, reason: "missing wiki index" };
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
    return { checked: true, record_count: records.length };
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
  let output = "";
  try {
    output = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  } catch {
    return [];
  }
  const entries = splitZ(output);
  const files = [];
  for (const entry of entries) {
    if (entry.startsWith("?? ")) files.push(toSlash(entry.slice(3)));
  }
  return files.sort();
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
    `- tracked files scanned: ${report.scanned.tracked_files}`,
    `- untracked files classified: ${report.scanned.untracked_files}`,
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

  const trackedFiles = gitTrackedFiles();
  const untrackedFiles = gitUntrackedFiles();
  const remote = remoteUrl();
  const repo = parseGitHubRepo(remote);
  const githubVisibility = await fetchGitHubRepoInfo(repo);
  const policyCounts = {
    syncable: 0,
    conditional: 0,
    blocked: 0,
    unknown: 0,
  };

  for (const relativePath of trackedFiles) {
    const policy = scanFile(relativePath, true);
    policyCounts[policy.classification] += 1;
  }

  for (const relativePath of untrackedFiles) {
    const policy = classifyDataPath(relativePath);
    if (policy.classification === "blocked") {
      addFinding("warning", "local_only_untracked_present", relativePath, { policy: policy.policy });
    } else if (policy.classification === "conditional") {
      addFinding("warning", "conditional_untracked_present", relativePath, { policy: policy.policy });
    }
    if (pathExists(relativePath)) {
      scanFile(relativePath, false);
    }
  }

  const indexExclusion = checkIndexExclusions();
  const docVisibility = checkAppDocsAgainstVisibility(githubVisibility);
  const gitHistory = classifyCompleteGitHistory(dataRoot);
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
      branch_state: branchState(),
      github_visibility: githubVisibility,
      visibility_policy: "treat data as public when GitHub says public or visibility is unknown",
    },
    scanned: {
      tracked_files: trackedFiles.length,
      untracked_files: untrackedFiles.length,
      max_scan_bytes: maxScanBytes,
      scan_completeness_policy: "fail_closed_no_partial_scan",
      path_policy_counts: policyCounts,
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
        `tracked_files=${trackedFiles.length}`,
        `untracked_files=${untrackedFiles.length}`,
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
