import { promises as fs } from "node:fs";
import path from "node:path";

export const DATA_CLASSIFICATION_POLICY_VERSION = "data_classification_20260711_v1";
export const PUBLIC_DATA_MAX_SCAN_BYTES = 8 * 1024 * 1024;

export type DataPathClassification = "syncable" | "conditional" | "blocked";

export type DataClassificationFinding = {
  id: string;
  category: "path" | "file_type" | "size" | "decode" | "secret" | "machine_local" | "raw_transcript" | "review" | "parse";
  severity: "blocker" | "review";
  line?: number;
  detail?: string;
};

export type DataPathDecision = {
  classification: DataPathClassification;
  policy: string;
  explicit_allowlist: boolean;
  reasons: string[];
};

export type DataFileClassification = {
  policy_version: string;
  path: string;
  classification: DataPathClassification;
  path_classification: DataPathClassification;
  policy: string;
  explicit_allowlist: boolean;
  reasons: string[];
  findings: DataClassificationFinding[];
  scan: {
    required: boolean;
    complete: boolean;
    deleted: boolean;
    size_bytes: number;
    max_scan_bytes: number;
    file_type: string;
    decode_status: "not_required" | "not_scanned" | "utf8" | "undecodable";
    parse_status: "not_applicable" | "not_scanned" | "ok" | "invalid";
  };
};

type PathRule = {
  id: string;
  pattern: RegExp;
};

const BLOCKED_PATH_RULES: PathRule[] = [
  { id: "raw_conversation_path", pattern: /^10_Conversations\/raw\// },
  { id: "raw_instance_path", pattern: /^50_Instances\/raw\// },
  { id: "private_source_path", pattern: /^30_Sources\/private\// },
  { id: "attachment_path", pattern: /^attachments\// },
  { id: "secret_dino_path", pattern: /^\.dino\/(?:secrets|local)\.json$/ },
  { id: "cache_path", pattern: /^\.dino\/(?:cache|tmp|locks|local-backups|review-admissions)\// },
  { id: "task_sync_scope_path", pattern: /^\.dino\/sync-scopes\// },
  { id: "generated_index_path", pattern: /^\.dino\/index\// },
  { id: "operation_event_path", pattern: /^\.dino\/events\// },
  { id: "private_behavior_recall_migration_path", pattern: /^\.dino\/migrations\/behavior-recall\// },
  { id: "private_behavior_recall_migration_status", pattern: /^\.dino\/state\/behavior_recall_evidence_migration\.json$/ },
  { id: "environment_file", pattern: /(^|\/)\.env(?:\.|$)/ },
  { id: "private_key_file", pattern: /\.(?:pem|key|p12|pfx)$/i },
];

const CONDITIONAL_PATH_RULES: PathRule[] = [
  { id: "candidate_instance_path", pattern: /^50_Instances\/candidates\// },
  { id: "review_queue_path", pattern: /^80_Review_Queue\// },
  { id: "operation_task_path", pattern: /^\.dino\/tasks\// },
  { id: "operation_trace_path", pattern: /^\.dino\/traces\// },
  { id: "operation_context_pack_path", pattern: /^\.dino\/context-packs\// },
  { id: "operation_gate_path", pattern: /^\.dino\/gates\// },
  { id: "operation_audit_path", pattern: /^\.dino\/audits\// },
  { id: "operation_evaluation_path", pattern: /^\.dino\/evaluations\// },
  { id: "operation_lifecycle_path", pattern: /^\.dino\/lifecycle\// },
  { id: "operation_quarantine_path", pattern: /^\.dino\/quarantine\// },
  { id: "operation_compounding_path", pattern: /^\.dino\/compounding\// },
  { id: "operation_migration_path", pattern: /^\.dino\/migrations\// },
  { id: "operation_provenance_path", pattern: /^\.dino\/provenance\// },
  { id: "operation_proof_path", pattern: /^\.dino\/proofs\// },
  { id: "operation_state_path", pattern: /^\.dino\/state\// },
  { id: "node_lifecycle_status_path", pattern: /^\.dino\/state\/node_lifecycle\.json$/ },
  {
    id: "review_queue_status_path",
    pattern: /^\.dino\/state\/(?:review_worklist|review_worklist_actions|review_queue_backpressure|review_queue_admission|cold_partitions)\.json$/,
  },
];

const SYNCABLE_PATH_RULES: PathRule[] = [
  { id: "home_path", pattern: /^00_Home\// },
  { id: "wiki_path", pattern: /^20_Wiki\// },
  { id: "source_path", pattern: /^30_Sources\// },
  { id: "project_path", pattern: /^40_Projects\// },
  { id: "accepted_instance_path", pattern: /^50_Instances\/accepted\// },
  { id: "instance_readme_path", pattern: /^50_Instances\/README\.md$/ },
  { id: "operations_path", pattern: /^60_Operations\// },
  { id: "error_book_path", pattern: /^70_Error_Book\// },
  { id: "dino_readme_path", pattern: /^\.dino\/README\.md$/ },
  { id: "data_hook_path", pattern: /^\.githooks\/(?:pre-commit|pre-push|verify-public-data-guard\.ps1)$/ },
  { id: "readme_path", pattern: /^README\.md$/ },
  { id: "gitignore_path", pattern: /^\.gitignore$/ },
  { id: "gitattributes_path", pattern: /^\.gitattributes$/ },
];

const TEXT_EXTENSIONS = new Set([
  ".csv",
  ".json",
  ".jsonl",
  ".md",
  ".ps1",
  ".sh",
  ".toml",
  ".tsv",
  ".txt",
  ".yaml",
  ".yml",
]);

const SECRET_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  { id: "private_key_block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/ },
  { id: "openai_key_shape", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { id: "github_token_shape", pattern: /\b(?:github_pat_[A-Za-z0-9_]{20,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,})\b/ },
  { id: "aws_access_key_shape", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: "bearer_token_shape", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}\b/i },
  { id: "jwt_shape", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  {
    id: "credential_assignment",
    pattern: /\b(api[_-]?key|secret|token|password|session[_-]?id|session[_-]?token|cookie|refresh[_-]?token)\s*[:=]\s*["']?[^"'\s,;}]{8,}/i,
  },
];

const RAW_TRANSCRIPT_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  { id: "raw_full_transcript_true", pattern: /raw_full_transcript_stored["']?\s*[:=]\s*true/i },
  { id: "message_content_true", pattern: /message_content_stored["']?\s*[:=]\s*true/i },
  { id: "conversation_messages_with_content", pattern: /"messages"\s*:\s*\[[\s\S]{0,3000}"content"\s*:/ },
  { id: "codex_rollout_item", pattern: /"(response_item|turn_context|session_meta)"\s*:/ },
];

const MACHINE_LOCAL_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  { id: "windows_user_path", pattern: /\b[A-Z]:\\Users\\[^"'\s]+/ },
  { id: "windows_drive_path", pattern: /\b[A-Z]:\\(?!Users\\)[^"'\s]+/ },
  { id: "posix_user_path", pattern: /(?:^|[\s"'])\/(?:Users|home)\/[^"'\s]+/m },
];

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function matchingRule(rules: PathRule[], relativePath: string): PathRule | null {
  return rules.find((rule) => rule.pattern.test(relativePath)) ?? null;
}

export function classifyDataPath(relativePath: string): DataPathDecision {
  const normalized = normalizePath(relativePath);
  const blocked = matchingRule(BLOCKED_PATH_RULES, normalized);
  if (blocked) {
    return {
      classification: "blocked",
      policy: blocked.id,
      explicit_allowlist: true,
      reasons: ["path is explicitly local-only or secret-bearing"],
    };
  }
  const conditional = matchingRule(CONDITIONAL_PATH_RULES, normalized);
  if (conditional) {
    return {
      classification: "conditional",
      policy: conditional.id,
      explicit_allowlist: true,
      reasons: ["path is explicitly classified and requires review before sync"],
    };
  }
  const syncable = matchingRule(SYNCABLE_PATH_RULES, normalized);
  if (syncable) {
    return {
      classification: "syncable",
      policy: syncable.id,
      explicit_allowlist: true,
      reasons: ["path is explicitly allowlisted for reviewed public sync"],
    };
  }
  return {
    classification: "blocked",
    policy: "unclassified_path",
    explicit_allowlist: false,
    reasons: ["path is not covered by an explicit public-data policy rule"],
  };
}

function lineFor(text: string, index: number): number {
  return text.slice(0, index).split(/\r\n|\r|\n/).length;
}

function firstPatternFinding(
  text: string,
  patterns: Array<{ id: string; pattern: RegExp }>,
  category: DataClassificationFinding["category"],
): DataClassificationFinding[] {
  const findings: DataClassificationFinding[] = [];
  for (const entry of patterns) {
    const match = entry.pattern.exec(text);
    entry.pattern.lastIndex = 0;
    if (!match) continue;
    findings.push({ id: entry.id, category, severity: "blocker", line: lineFor(text, match.index) });
  }
  return findings;
}

export function scanDataText(text: string): DataClassificationFinding[] {
  return [
    ...firstPatternFinding(text, SECRET_PATTERNS, "secret"),
    ...firstPatternFinding(text, RAW_TRANSCRIPT_PATTERNS, "raw_transcript"),
    ...firstPatternFinding(text, MACHINE_LOCAL_PATTERNS, "machine_local"),
  ];
}

function hasReviewLineage(record: Record<string, unknown>): boolean {
  return Boolean(
    record.source_candidate_path ||
      record.reviewed_by ||
      record.reviewed_at ||
      String(record.review_status ?? "").toLowerCase().includes("accepted"),
  );
}

function structuredContentFindings(relativePath: string, text: string): {
  findings: DataClassificationFinding[];
  parseStatus: DataFileClassification["scan"]["parse_status"];
} {
  const findings: DataClassificationFinding[] = [];
  const normalized = normalizePath(relativePath);
  const extension = path.posix.extname(normalized).toLowerCase();
  let parseStatus: DataFileClassification["scan"]["parse_status"] = "not_applicable";
  let parsed: Record<string, unknown> | null = null;

  if (extension === ".json") {
    try {
      const value = JSON.parse(text) as unknown;
      parsed = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
      parseStatus = "ok";
    } catch {
      parseStatus = "invalid";
      findings.push({ id: "invalid_json", category: "parse", severity: "blocker" });
    }
  } else if (extension === ".jsonl") {
    parseStatus = "ok";
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].trim()) continue;
      try {
        JSON.parse(lines[index]);
      } catch {
        parseStatus = "invalid";
        findings.push({ id: "invalid_jsonl", category: "parse", severity: "blocker", line: index + 1 });
        break;
      }
    }
  }

  if (/^50_Instances\/accepted\/.+\.json$/.test(normalized) && parsed?.auto_generated === true && !hasReviewLineage(parsed)) {
    findings.push({ id: "auto_generated_accepted_without_review_lineage", category: "review", severity: "blocker" });
  }

  if (/^60_Operations\/review-worklists\/.+\.json$/.test(normalized)) {
    const privateFields = ["representative_claim", "candidate_paths", "review_paths", "members", "source_session_refs"];
    for (const field of privateFields) {
      if (new RegExp(`"${field}"\\s*:`).test(text)) {
        findings.push({ id: `unsafe_review_worklist_field:${field}`, category: "review", severity: "blocker" });
      }
    }
  }

  if (/^60_Operations\/behavior-recall-migrations\/.+\.json$/.test(normalized)) {
    const privateFields = ["recall_id", "task_id", "old_evidence_path", "new_evidence_path", "data_root"];
    for (const field of privateFields) {
      if (new RegExp(`"${field}"\\s*:`).test(text)) {
        findings.push({ id: `unsafe_behavior_recall_migration_field:${field}`, category: "review", severity: "blocker" });
      }
    }
  }

  return { findings, parseStatus };
}

function fileType(relativePath: string): { supported: boolean; value: string } {
  const normalized = normalizePath(relativePath);
  const base = path.posix.basename(normalized);
  const extension = path.posix.extname(normalized).toLowerCase();
  if (base === ".gitignore" || base === "pre-commit" || base === "pre-push") return { supported: true, value: "text" };
  return { supported: TEXT_EXTENSIONS.has(extension), value: extension || "unknown" };
}

export function classifyDataFile(input: {
  relativePath: string;
  content?: Uint8Array | null;
  sizeBytes?: number;
  deleted?: boolean;
  scanContent?: boolean;
  maxScanBytes?: number;
  fileKind?: "file" | "symlink" | "other";
}): DataFileClassification {
  const normalized = normalizePath(input.relativePath);
  const pathDecision = classifyDataPath(normalized);
  const deleted = input.deleted === true;
  const scanRequired = !deleted;
  const scanEnabled = input.scanContent !== false;
  const maxScanBytes = input.maxScanBytes ?? PUBLIC_DATA_MAX_SCAN_BYTES;
  const sizeBytes = Math.max(0, input.sizeBytes ?? input.content?.byteLength ?? 0);
  const findings: DataClassificationFinding[] = [];
  const fileKind = input.fileKind ?? "file";
  const type = fileKind === "file" ? fileType(normalized) : { supported: false, value: fileKind };
  let decodeStatus: DataFileClassification["scan"]["decode_status"] = deleted ? "not_required" : "not_scanned";
  let parseStatus: DataFileClassification["scan"]["parse_status"] = deleted ? "not_applicable" : "not_scanned";
  let complete = deleted;

  if (!pathDecision.explicit_allowlist) {
    findings.push({ id: "unclassified_path", category: "path", severity: "blocker" });
  }

  if (!deleted && !scanEnabled) {
    findings.push({ id: "content_scan_required", category: "decode", severity: "blocker" });
  } else if (!deleted && fileKind !== "file") {
    findings.push({ id: "unsupported_file_kind", category: "file_type", severity: "blocker", detail: fileKind });
  } else if (!deleted && sizeBytes > maxScanBytes) {
    findings.push({
      id: "file_exceeds_complete_scan_limit",
      category: "size",
      severity: "blocker",
      detail: `size=${sizeBytes};limit=${maxScanBytes}`,
    });
  } else if (!deleted && !type.supported) {
    findings.push({ id: "unsupported_or_binary_file_type", category: "file_type", severity: "blocker", detail: type.value });
  } else if (!deleted && input.content == null) {
    findings.push({ id: "file_content_unavailable", category: "decode", severity: "blocker" });
  } else if (!deleted) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(input.content!);
      if (text.includes("\0")) throw new Error("nul_byte");
      decodeStatus = "utf8";
      const structured = structuredContentFindings(normalized, text);
      parseStatus = structured.parseStatus;
      findings.push(...scanDataText(text), ...structured.findings);
      complete = true;
    } catch {
      decodeStatus = "undecodable";
      parseStatus = "not_scanned";
      findings.push({ id: "content_not_strict_utf8", category: "decode", severity: "blocker" });
    }
  }

  const blocker = pathDecision.classification === "blocked" || findings.some((finding) => finding.severity === "blocker");
  const classification: DataPathClassification = blocker ? "blocked" : pathDecision.classification;
  const findingReasons = findings.map((finding) => finding.id);

  return {
    policy_version: DATA_CLASSIFICATION_POLICY_VERSION,
    path: normalized,
    classification,
    path_classification: pathDecision.classification,
    policy: blocker && pathDecision.classification !== "blocked" ? findings[0]?.id ?? pathDecision.policy : pathDecision.policy,
    explicit_allowlist: pathDecision.explicit_allowlist,
    reasons: Array.from(new Set([...pathDecision.reasons, ...findingReasons])),
    findings,
    scan: {
      required: scanRequired,
      complete,
      deleted,
      size_bytes: sizeBytes,
      max_scan_bytes: maxScanBytes,
      file_type: type.value,
      decode_status: decodeStatus,
      parse_status: parseStatus,
    },
  };
}

export async function classifyDataFileAtPath(input: {
  root: string;
  relativePath: string;
  deleted?: boolean;
  scanContent?: boolean;
  maxScanBytes?: number;
}): Promise<DataFileClassification> {
  if (input.deleted) return classifyDataFile({ ...input, content: null, sizeBytes: 0 });
  const fullPath = path.resolve(input.root, normalizePath(input.relativePath));
  const root = path.resolve(input.root);
  if (fullPath !== root && !fullPath.startsWith(`${root}${path.sep}`)) {
    return classifyDataFile({ relativePath: input.relativePath, content: null, sizeBytes: 0, scanContent: false });
  }
  try {
    const stat = await fs.lstat(fullPath);
    const fileKind = stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : "other";
    if (fileKind !== "file") {
      return classifyDataFile({ relativePath: input.relativePath, content: null, sizeBytes: stat.size, fileKind });
    }
    const maxScanBytes = input.maxScanBytes ?? PUBLIC_DATA_MAX_SCAN_BYTES;
    const content = stat.size <= maxScanBytes && input.scanContent !== false ? await fs.readFile(fullPath) : null;
    return classifyDataFile({
      relativePath: input.relativePath,
      content,
      sizeBytes: stat.size,
      scanContent: input.scanContent,
      maxScanBytes,
      fileKind,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return classifyDataFile({ relativePath: input.relativePath, content: null, sizeBytes: 0, scanContent: false });
    }
    throw error;
  }
}
