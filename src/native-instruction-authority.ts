import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { dataPath } from "./context.js";
import { FULL_MEMORY_STATE_DIR } from "./full-memory-audit.js";

export const NATIVE_INSTRUCTION_AUTHORITY_VERSION = "native_instruction_authority_v1";
export const NATIVE_INSTRUCTION_AUTHORITY_RELATIVE_PATH = `${FULL_MEMORY_STATE_DIR}/native_instruction_authority.json`;

export type NativeInstructionAuthorityStatus = "healthy" | "needs_attention";
export type NativeInstructionFindingSignal =
  | "native_memory_drift"
  | "wrong_memory_reference_detected"
  | "unsafe_native_instruction"
  | "hook_authority_conflict"
  | "required_surface_missing";

export type NativeInstructionSurface = {
  id: string;
  path: string;
  exists: boolean;
  required: boolean;
  bytes: number | null;
  sha256: string | null;
  mtime: string | null;
  line_count: number | null;
  finding_count: number;
  evidence_count: number;
};

export type NativeInstructionFinding = {
  signal: NativeInstructionFindingSignal;
  severity: "fail" | "warn";
  rule_id: string;
  surface_id: string;
  path: string;
  line: number | null;
  reason: string;
};

export type NativeInstructionEvidence = {
  rule_id: string;
  surface_id: string;
  path: string;
  line: number;
};

export type NativeInstructionAuthorityReport = {
  version: typeof NATIVE_INSTRUCTION_AUTHORITY_VERSION;
  status: NativeInstructionAuthorityStatus;
  generated_at: string;
  latest_verified_at: string | null;
  data_root: string;
  app_root: string;
  home_dir: string;
  program_data: string;
  authority_rules: Array<{
    id: string;
    required: boolean;
    evidence_count: number;
  }>;
  surfaces: NativeInstructionSurface[];
  findings: NativeInstructionFinding[];
  evidence: NativeInstructionEvidence[];
  counts: {
    surfaces: number;
    scanned: number;
    required_missing: number;
    conflicts: number;
    warnings: number;
    evidence: number;
  };
  warnings: string[];
  visible_status: string;
};

type BuildOptions = {
  now?: Date;
  appRoot?: string;
  homeDir?: string;
  programData?: string;
};

type SurfaceSpec = {
  id: string;
  path: string;
  required: boolean;
};

type ConflictRule = {
  id: string;
  signal: NativeInstructionFindingSignal;
  reason: string;
  patterns: RegExp[];
};

type EvidenceRule = {
  id: string;
  required: boolean;
  patterns: RegExp[];
};

const TEXT_EXTENSIONS = new Set([
  ".json",
  ".toml",
  ".md",
  ".txt",
  ".ps1",
  ".mjs",
  ".js",
  ".ts",
  ".yml",
  ".yaml",
  ".rules",
]);
const MAX_REPO_CODEX_SURFACES = 80;
const MAX_NATIVE_RULE_SURFACES = 80;

const EVIDENCE_RULES: EvidenceRule[] = [
  {
    id: "current_user_instruction_outranks_memory",
    required: true,
    patterns: [
      /current\s+user\s+instructions?.{0,80}(outrank|take\s+priority|priority)/i,
      /(latest|current)\s+user.{0,60}(instruction|message).{0,80}(outrank|priority|first)/i,
      /사용자.{0,40}지시.{0,40}우선/i,
    ],
  },
  {
    id: "os_memory_is_subordinate_evidence",
    required: true,
    patterns: [
      /(stored\s+)?memory.{0,80}(subordinate|context,\s*not\s+authority|context\s+not\s+authority|evidence)/i,
      /context\s+pack.{0,80}(subordinate|context|evidence)/i,
    ],
  },
  {
    id: "candidate_memory_untrusted_until_reviewed",
    required: true,
    patterns: [
      /candidate\s+memory.{0,80}untrusted/i,
      /candidate.{0,80}untrusted.{0,80}(review|accepted)/i,
      /review\s+queue.{0,80}(untrusted|requires?\s+review)/i,
    ],
  },
  {
    id: "no_raw_transcript_or_secret_storage",
    required: true,
    patterns: [
      /do\s+not\s+store.{0,80}(secrets?|api\s+keys?|tokens?|raw\s+(full\s+)?(conversation|transcript|logs?))/i,
      /no\s+raw\s+(transcript|conversation|session)/i,
      /raw\s+(transcript|conversation).{0,80}(never|not|no)/i,
    ],
  },
  {
    id: "auto_sync_scoped_by_policy",
    required: true,
    patterns: [
      /do\s+not\s+run\s+broad.{0,80}sync/i,
      /auto[-_ ]?sync.{0,80}(policy|scoped|conditional|approved)/i,
      /policy[- ]approved.{0,80}(sync|records?)/i,
    ],
  },
  {
    id: "hook_trust_not_bypassed",
    required: true,
    patterns: [
      /(does\s+not|cannot|must\s+not).{0,80}bypass.{0,40}hook\s+trust/i,
      /hook\s+trust.{0,80}(cannot|does\s+not|must\s+not).{0,40}bypass/i,
      /hook\s+trust.{0,80}user\s+(approval|decision)/i,
      /hook\s+trust.{0,80}(user\s+decision|approve|approval|prompt)/i,
      /trust\s+prompt.{0,80}(user|approve|manual)/i,
    ],
  },
];

const CONFLICT_RULES: ConflictRule[] = [
  {
    id: "memory_outranks_current_user",
    signal: "native_memory_drift",
    reason: "Stored memory or Context Pack is claimed to outrank the current user instruction.",
    patterns: [
      /(stored\s+)?(os\s+)?memory.{0,80}(outranks|overrides|has\s+priority\s+over|takes\s+priority\s+over|wins\s+over).{0,80}(current|latest)?\s*user/i,
      /context\s+pack.{0,80}(outranks|overrides|has\s+priority\s+over|takes\s+priority\s+over).{0,80}(current|latest)?\s*user/i,
      /기억.{0,40}사용자.{0,40}우선/i,
    ],
  },
  {
    id: "must_obey_memory_on_conflict",
    signal: "native_memory_drift",
    reason: "Native instructions require obeying memory even when it conflicts with the latest user request.",
    patterns: [
      /(always|must).{0,40}(obey|follow|prefer).{0,40}(stored\s+)?memory.{0,100}(conflict|despite|instead\s+of).{0,60}user/i,
      /user.{0,60}(subordinate|lower\s+priority).{0,80}memory/i,
    ],
  },
  {
    id: "candidate_or_review_queue_trusted",
    signal: "wrong_memory_reference_detected",
    reason: "Candidate or review queue memory is treated as trusted before acceptance.",
    patterns: [
      /candidate.{0,80}(\btrusted\b|authoritative|approved\s+by\s+default|safe\s+by\s+default)/i,
      /review\s+queue.{0,80}(\btrusted\b|authoritative|approved\s+by\s+default|safe\s+by\s+default)/i,
      /rejected.{0,80}(\btrusted\b|authoritative|use\s+as\s+truth)/i,
    ],
  },
  {
    id: "raw_transcript_or_secret_storage_required",
    signal: "unsafe_native_instruction",
    reason: "Native instructions require storing raw transcripts, secrets, tokens, or private keys.",
    patterns: [
      /(store|save|sync|publish|upload).{0,60}(raw|full).{0,30}(transcript|conversation|session\s+logs?)/i,
      /(store|save|sync|publish|upload).{0,60}(secrets?|api\s+keys?|tokens?|credentials?|private\s+keys?)/i,
    ],
  },
  {
    id: "broad_auto_sync_allowed",
    signal: "unsafe_native_instruction",
    reason: "Native instructions allow broad or unreviewed auto-sync outside policy.",
    patterns: [
      /auto[-_ ]?sync.{0,80}(\ball\b|\beverything\b|unscoped|broad|without\s+review|without\s+policy|without\s+checks?)/i,
      /(sync|push).{0,60}(\ball\b|\beverything\b).{0,60}(memory|data|records?)/i,
    ],
  },
  {
    id: "hook_trust_bypass_claimed",
    signal: "hook_authority_conflict",
    reason: "Native instructions claim hook trust can be bypassed or auto-approved.",
    patterns: [
      /(bypass|skip).{0,60}hook\s+trust/i,
      /auto(matically)?[-_ ]?(approve|trust).{0,60}hook/i,
      /hook.{0,60}(automatic\s+approval|approved\s+without\s+user|trusted\s+without\s+user)/i,
    ],
  },
];

function nowIso(date: Date): string {
  return date.toISOString();
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function relativeOrAbsolute(base: string, filePath: string): string {
  const relative = path.relative(base, filePath);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative.split(path.sep).join("/");
  return path.resolve(filePath);
}

function isNegated(line: string, matchIndex: number): boolean {
  const before = line.slice(Math.max(0, matchIndex - 36), matchIndex).toLowerCase();
  return /\b(no|not|never|without|cannot|can't|do\s+not|does\s+not|must\s+not|should\s+not|don't)\b/.test(before);
}

function hasTextExtension(filePath: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function listRepoCodexSurfaces(appRoot: string): Promise<SurfaceSpec[]> {
  const root = path.join(appRoot, ".codex");
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(root, { withFileTypes: true, recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath ?? root, entry.name))
    .filter(hasTextExtension)
    .slice(0, MAX_REPO_CODEX_SURFACES)
    .map((filePath, index) => ({ id: `repo_codex_${index + 1}`, path: filePath, required: false }));
}

async function listTextSurfaces(root: string, idPrefix: string, limit = MAX_NATIVE_RULE_SURFACES): Promise<SurfaceSpec[]> {
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(root, { withFileTypes: true, recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath ?? root, entry.name))
    .filter(hasTextExtension)
    .slice(0, limit)
    .map((filePath, index) => ({ id: `${idPrefix}_${index + 1}`, path: filePath, required: false }));
}

async function optionalFileSurface(id: string, filePath: string): Promise<SurfaceSpec[]> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.isFile() && hasTextExtension(filePath)) return [{ id, path: filePath, required: false }];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return [];
}

async function listCodexNativeInstructionSurfaces(home: string): Promise<SurfaceSpec[]> {
  const codexRoot = path.join(home, ".codex");
  const surfaces = [
    ...(await listTextSurfaces(path.join(codexRoot, "rules"), "codex_rules")),
    ...(await listTextSurfaces(path.join(codexRoot, "instructions"), "codex_instructions")),
    ...(await listTextSurfaces(path.join(codexRoot, "custom-instructions"), "codex_custom_instructions")),
    ...(await listTextSurfaces(path.join(codexRoot, "custom_instructions"), "codex_custom_instructions")),
    ...(await optionalFileSurface("codex_rules_file", path.join(codexRoot, "rules.md"))),
    ...(await optionalFileSurface("codex_instructions_file", path.join(codexRoot, "instructions.md"))),
    ...(await optionalFileSurface("codex_custom_instructions_file", path.join(codexRoot, "custom-instructions.md"))),
    ...(await optionalFileSurface("codex_custom_instructions_file_alt", path.join(codexRoot, "custom_instructions.md"))),
  ];
  return dedupeSurfaces(surfaces);
}

async function listClaudeNativeInstructionSurfaces(home: string): Promise<SurfaceSpec[]> {
  const claudeRoot = path.join(home, ".claude");
  const surfaces = [
    ...(await listTextSurfaces(path.join(claudeRoot, "rules"), "claude_rules")),
    ...(await listTextSurfaces(path.join(claudeRoot, "instructions"), "claude_instructions")),
    ...(await listTextSurfaces(path.join(claudeRoot, "custom-instructions"), "claude_custom_instructions")),
    ...(await listTextSurfaces(path.join(claudeRoot, "custom_instructions"), "claude_custom_instructions")),
    ...(await optionalFileSurface("claude_home_claude", path.join(claudeRoot, "CLAUDE.md"))),
    ...(await optionalFileSurface("claude_instructions_file", path.join(claudeRoot, "instructions.md"))),
    ...(await optionalFileSurface("claude_custom_instructions_file", path.join(claudeRoot, "custom-instructions.md"))),
    ...(await optionalFileSurface("claude_custom_instructions_file_alt", path.join(claudeRoot, "custom_instructions.md"))),
  ];
  return dedupeSurfaces(surfaces);
}

function dedupeSurfaces(surfaces: SurfaceSpec[]): SurfaceSpec[] {
  const seen = new Set<string>();
  const deduped: SurfaceSpec[] = [];
  for (const surface of surfaces) {
    const key = path.resolve(surface.path).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(surface);
  }
  return deduped;
}

async function collectSurfaceSpecs(options: Required<Pick<BuildOptions, "appRoot" | "homeDir" | "programData">>): Promise<SurfaceSpec[]> {
  const appRoot = path.resolve(options.appRoot);
  const home = path.resolve(options.homeDir);
  const programData = path.resolve(options.programData);
  return [
    { id: "repo_agents", path: path.join(appRoot, "AGENTS.md"), required: true },
    { id: "repo_claude", path: path.join(appRoot, "CLAUDE.md"), required: false },
    ...(await listRepoCodexSurfaces(appRoot)),
    { id: "codex_config", path: path.join(home, ".codex", "config.toml"), required: false },
    { id: "codex_hooks", path: path.join(home, ".codex", "hooks.json"), required: false },
    ...(await listCodexNativeInstructionSurfaces(home)),
    { id: "claude_settings", path: path.join(home, ".claude", "settings.json"), required: false },
    ...(await listClaudeNativeInstructionSurfaces(home)),
    { id: "installer", path: path.join(appRoot, "install.ps1"), required: true },
    { id: "codex_hook_mjs", path: path.join(appRoot, "scripts", "dinobrain-user-prompt-hook.mjs"), required: false },
    { id: "codex_hook_ps1", path: path.join(appRoot, "scripts", "dinobrain-user-prompt-hook.ps1"), required: false },
    { id: "codex_hook_approval_ps1", path: path.join(appRoot, "scripts", "start-codex-hook-approval.ps1"), required: false },
    { id: "codex_live_proof_ps1", path: path.join(appRoot, "scripts", "start-codex-live-proof.ps1"), required: false },
    { id: "codex_hooks_doc", path: path.join(appRoot, "docs", "CODEX_HOOKS.md"), required: false },
    { id: "install_doc", path: path.join(appRoot, "docs", "INSTALL.md"), required: false },
    {
      id: "codex_managed_requirements",
      path: path.join(programData, "OpenAI", "Codex", "requirements.toml"),
      required: false,
    },
    {
      id: "codex_managed_wrapper",
      path: path.join(programData, "OpenAI", "Codex", "DinoBrainHooks", "dinobrain-managed-user-prompt-hook.ps1"),
      required: false,
    },
  ];
}

function findingForMissing(surface: SurfaceSpec): NativeInstructionFinding {
  return {
    signal: "required_surface_missing",
    severity: "fail",
    rule_id: "required_native_surface_present",
    surface_id: surface.id,
    path: surface.path,
    line: null,
    reason: "Required native instruction surface is missing.",
  };
}

async function scanSurface(
  surface: SurfaceSpec,
  appRoot: string,
): Promise<{
  surface: NativeInstructionSurface;
  findings: NativeInstructionFinding[];
  evidence: NativeInstructionEvidence[];
}> {
  const findings: NativeInstructionFinding[] = [];
  const evidence: NativeInstructionEvidence[] = [];
  let text: string | null = null;
  let stat: import("node:fs").Stats | null = null;
  try {
    stat = await fs.stat(surface.path);
    if (stat.size <= 512 * 1024) text = stripBom(await fs.readFile(surface.path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (text === null) {
    if (surface.required) findings.push(findingForMissing(surface));
    return {
      surface: {
        id: surface.id,
        path: relativeOrAbsolute(appRoot, surface.path),
        exists: false,
        required: surface.required,
        bytes: null,
        sha256: null,
        mtime: null,
        line_count: null,
        finding_count: findings.length,
        evidence_count: 0,
      },
      findings,
      evidence,
    };
  }

  const lines = text.split(/\r?\n/);
  for (const [lineIndex, line] of lines.entries()) {
    for (const rule of CONFLICT_RULES) {
      for (const pattern of rule.patterns) {
        const match = pattern.exec(line);
        if (!match) continue;
        if (isNegated(line, match.index)) continue;
        findings.push({
          signal: rule.signal,
          severity: "fail",
          rule_id: rule.id,
          surface_id: surface.id,
          path: relativeOrAbsolute(appRoot, surface.path),
          line: lineIndex + 1,
          reason: rule.reason,
        });
        break;
      }
    }
    for (const rule of EVIDENCE_RULES) {
      if (rule.patterns.some((pattern) => pattern.test(line))) {
        evidence.push({
          rule_id: rule.id,
          surface_id: surface.id,
          path: relativeOrAbsolute(appRoot, surface.path),
          line: lineIndex + 1,
        });
      }
    }
  }

  return {
    surface: {
      id: surface.id,
      path: relativeOrAbsolute(appRoot, surface.path),
      exists: true,
      required: surface.required,
      bytes: stat?.size ?? Buffer.byteLength(text),
      sha256: sha256(text),
      mtime: stat?.mtime.toISOString() ?? null,
      line_count: lines.length,
      finding_count: findings.length,
      evidence_count: evidence.length,
    },
    findings,
    evidence,
  };
}

function dedupeEvidence(evidence: NativeInstructionEvidence[]): NativeInstructionEvidence[] {
  const seen = new Set<string>();
  const deduped: NativeInstructionEvidence[] = [];
  for (const item of evidence) {
    const key = `${item.rule_id}\0${item.path}\0${item.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function missingEvidenceFindings(evidence: NativeInstructionEvidence[]): NativeInstructionFinding[] {
  const present = new Set(evidence.map((item) => item.rule_id));
  return EVIDENCE_RULES.filter((rule) => rule.required && !present.has(rule.id)).map((rule) => ({
    signal: "native_memory_drift",
    severity: "fail",
    rule_id: rule.id,
    surface_id: "aggregate",
    path: "native-instruction-surfaces",
    line: null,
    reason: `Required authority rule evidence is missing: ${rule.id}.`,
  }));
}

export function getNativeInstructionAuthorityPath(dataRoot: string): string {
  return dataPath(dataRoot, ...NATIVE_INSTRUCTION_AUTHORITY_RELATIVE_PATH.split("/"));
}

export async function buildNativeInstructionAuthorityReport(
  dataRoot: string,
  options: BuildOptions = {},
): Promise<NativeInstructionAuthorityReport> {
  const appRoot = path.resolve(options.appRoot ?? process.env.DINOBRAIN_APP_DIR ?? process.cwd());
  const homeDir = path.resolve(options.homeDir ?? homedir());
  const programData = path.resolve(options.programData ?? process.env.ProgramData ?? "C:\\ProgramData");
  const specs = await collectSurfaceSpecs({ appRoot, homeDir, programData });
  const scanned = await Promise.all(specs.map((surface) => scanSurface(surface, appRoot)));
  const surfaces = scanned.map((item) => item.surface);
  const evidence = dedupeEvidence(scanned.flatMap((item) => item.evidence));
  const findings = [...scanned.flatMap((item) => item.findings), ...missingEvidenceFindings(evidence)];
  const conflicts = findings.filter((finding) => finding.severity === "fail").length;
  const warnings = findings.filter((finding) => finding.severity === "warn").length;
  const status: NativeInstructionAuthorityStatus = conflicts > 0 ? "needs_attention" : "healthy";
  const generatedAt = nowIso(options.now ?? new Date());
  return {
    version: NATIVE_INSTRUCTION_AUTHORITY_VERSION,
    status,
    generated_at: generatedAt,
    latest_verified_at: status === "healthy" ? generatedAt : null,
    data_root: path.resolve(dataRoot),
    app_root: appRoot,
    home_dir: homeDir,
    program_data: programData,
    authority_rules: EVIDENCE_RULES.map((rule) => ({
      id: rule.id,
      required: rule.required,
      evidence_count: evidence.filter((item) => item.rule_id === rule.id).length,
    })),
    surfaces,
    findings,
    evidence,
    counts: {
      surfaces: surfaces.length,
      scanned: surfaces.filter((surface) => surface.exists).length,
      required_missing: findings.filter((finding) => finding.signal === "required_surface_missing").length,
      conflicts,
      warnings,
      evidence: evidence.length,
    },
    warnings: [
      conflicts > 0 ? "native_instruction_authority_conflict_detected" : "",
      surfaces.some((surface) => surface.required && !surface.exists) ? "required_native_instruction_surface_missing" : "",
    ].filter(Boolean),
    visible_status: status === "healthy" ? "Native instruction authority healthy" : "Native instruction authority needs attention",
  };
}

export async function buildAndWriteNativeInstructionAuthorityReport(
  dataRoot: string,
  options: BuildOptions = {},
): Promise<{ report: NativeInstructionAuthorityReport; path: string }> {
  const report = await buildNativeInstructionAuthorityReport(dataRoot, options);
  const reportPath = getNativeInstructionAuthorityPath(dataRoot);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report, path: reportPath };
}
