import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
} from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { atomicWriteJson } from "./concurrency.js";

export const PRIVATE_BACKUP_VERSION = "dinobrain_private_backup_v1";
export const PRIVATE_BACKUP_INVENTORY_POLICY_VERSION = "private_inventory_20260711_v1";

const MAGIC = Buffer.from("DINOBRAIN_PRIVATE_BACKUP_V1\n", "ascii");
const TAG_BYTES = 16;
const IO_CHUNK_BYTES = 1024 * 1024;
const MAX_PUBLIC_HEADER_BYTES = 64 * 1024;
const MAX_FRAME_HEADER_BYTES = 1024 * 1024;
const DEFAULT_MAX_FILES = 100_000;
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024 * 1024;
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_BYTES = 32;

export const DEFAULT_PRIVATE_DATA_PATHS = [
  "10_Conversations/raw",
  "30_Sources/private",
  "50_Instances/raw",
  "attachments/private",
  ".dino/secrets.json",
  ".dino/local.json",
  ".dino/events",
  ".dino/review-admissions",
] as const;

export type PrivateBackupSourceIdentity = {
  app_commit: string;
  data_commit: string;
  data_contract_version: number;
};

export type PrivateBackupRoot = {
  scope: string;
  root: string;
  relative_paths: string[];
};

export type PrivateBackupPublicHeader = {
  version: typeof PRIVATE_BACKUP_VERSION;
  inventory_policy_version: typeof PRIVATE_BACKUP_INVENTORY_POLICY_VERSION;
  backup_id: string;
  created_at: string;
  cipher: "aes-256-gcm";
  auth_tag_bytes: number;
  iv_base64: string;
  key_id: string;
  kdf: {
    name: "scrypt";
    salt_base64: string;
    n: number;
    r: number;
    p: number;
    key_bytes: number;
  };
  source_identity: PrivateBackupSourceIdentity;
};

type InventoryEntry = {
  scope: string;
  relative_path: string;
  source_path: string;
  size_bytes: number;
  sha256: string;
};

type PrivateManifestFrame = {
  type: "manifest";
  version: typeof PRIVATE_BACKUP_VERSION;
  inventory_policy_version: typeof PRIVATE_BACKUP_INVENTORY_POLICY_VERSION;
  backup_id: string;
  created_at: string;
  source_identity: PrivateBackupSourceIdentity;
  entry_count: number;
  total_plaintext_bytes: number;
  inventory_sha256: string;
  scopes: string[];
};

type PrivateFileFrame = {
  type: "file";
  scope: string;
  relative_path: string;
  size_bytes: number;
  sha256: string;
};

type PrivateEndFrame = {
  type: "end";
  entry_count: number;
  total_plaintext_bytes: number;
  inventory_sha256: string;
};

type PrivateFrame = PrivateManifestFrame | PrivateFileFrame | PrivateEndFrame;

export type CreatePrivateBackupOptions = {
  roots: PrivateBackupRoot[];
  output_path: string;
  recovery_key: Uint8Array;
  source_identity: PrivateBackupSourceIdentity;
  created_at?: string;
  max_files?: number;
  max_total_bytes?: number;
};

export type CreatePrivateBackupResult = {
  ok: true;
  status: "created";
  version: typeof PRIVATE_BACKUP_VERSION;
  inventory_policy_version: typeof PRIVATE_BACKUP_INVENTORY_POLICY_VERSION;
  backup_id: string;
  created_at: string;
  archive_sha256: string;
  archive_size_bytes: number;
  inventory_sha256: string;
  entry_count: number;
  total_plaintext_bytes: number;
  key_id: string;
  source_identity: PrivateBackupSourceIdentity;
};

export type RestorePrivateBackupOptions = {
  archive_path: string;
  recovery_key: Uint8Array;
  target_roots: Record<string, string>;
  expected_source_identity?: Partial<PrivateBackupSourceIdentity>;
  max_age_ms?: number;
  now?: Date;
  overwrite_private?: boolean;
  staging_parent?: string;
  receipt_path?: string;
  max_files?: number;
  max_total_bytes?: number;
};

export type RestorePrivateBackupResult = {
  ok: true;
  status: "restored";
  version: typeof PRIVATE_BACKUP_VERSION;
  inventory_policy_version: typeof PRIVATE_BACKUP_INVENTORY_POLICY_VERSION;
  backup_id: string;
  created_at: string;
  archive_sha256: string;
  archive_size_bytes: number;
  inventory_sha256: string;
  restored_entry_count: number;
  restored_plaintext_bytes: number;
  key_id: string;
  source_identity: PrivateBackupSourceIdentity;
};

export class PrivateBackupError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PrivateBackupError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new PrivateBackupError(code, message);
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateSourceIdentity(value: PrivateBackupSourceIdentity): PrivateBackupSourceIdentity {
  if (
    !value ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(value.app_commit) ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(value.data_commit) ||
    !Number.isSafeInteger(value.data_contract_version) ||
    value.data_contract_version < 1
  ) {
    fail("backup_source_identity_invalid", "Backup source identity is invalid");
  }
  return {
    app_commit: value.app_commit.toLowerCase(),
    data_commit: value.data_commit.toLowerCase(),
    data_contract_version: value.data_contract_version,
  };
}

function normalizeScope(value: string): string {
  const scope = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(scope)) fail("invalid_backup_scope", `Invalid backup scope: ${value}`);
  return scope;
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (!normalized || /^[A-Za-z]:\//.test(normalized) || path.posix.isAbsolute(normalized)) {
    fail("invalid_backup_path", `Backup path must be repository-relative: ${value}`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    fail("invalid_backup_path", `Backup path escapes its source root: ${value}`);
  }
  return normalized;
}

function resolveInside(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...normalizeRelativePath(relativePath).split("/"));
  if (target === resolvedRoot || !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    fail("backup_path_escape", `Path escapes configured root: ${relativePath}`);
  }
  return target;
}

function isInside(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

export function assertRecoveryKeyOutsideRoots(filePath: string, protectedRoots: string[]): void {
  const resolved = path.resolve(filePath);
  if (protectedRoots.some((root) => isInside(root, resolved))) {
    fail("recovery_key_inside_protected_root", "Recovery key must be stored outside app, data, and backup roots");
  }
}

function canonicalEntry(entry: Pick<InventoryEntry, "scope" | "relative_path" | "size_bytes" | "sha256">): string {
  return JSON.stringify({
    scope: entry.scope,
    relative_path: entry.relative_path,
    size_bytes: entry.size_bytes,
    sha256: entry.sha256,
  });
}

function encodeFrame(frame: PrivateFrame): Buffer {
  const body = Buffer.from(JSON.stringify(frame), "utf8");
  if (body.length < 2 || body.length > MAX_FRAME_HEADER_BYTES) fail("backup_frame_too_large", "Backup frame header is invalid");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(body.length, 0);
  return Buffer.concat([length, body]);
}

async function writeAll(handle: Awaited<ReturnType<typeof fs.open>>, value: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < value.byteLength) {
    const written = await handle.write(value, offset, value.byteLength - offset, null);
    if (written.bytesWritten <= 0) fail("backup_write_failed", "Archive write made no progress");
    offset += written.bytesWritten;
  }
}

async function readExact(
  handle: Awaited<ReturnType<typeof fs.open>>,
  length: number,
  position: number,
): Promise<Buffer> {
  const output = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(output, offset, length - offset, position + offset);
    if (result.bytesRead === 0) fail("backup_truncated", "Encrypted backup ended unexpectedly");
    offset += result.bytesRead;
  }
  return output;
}

async function hashRegularFile(filePath: string): Promise<{ sha256: string; size_bytes: number }> {
  const handle = await fs.open(filePath, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(IO_CHUNK_BYTES);
  let size = 0;
  try {
    const before = await handle.stat();
    if (!before.isFile()) fail("unsupported_backup_file", `Only regular files may be backed up: ${filePath}`);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
    }
    const after = await handle.stat();
    if (before.size !== after.size || after.size !== size || before.mtimeMs !== after.mtimeMs) {
      fail("backup_source_changed", "A private source file changed while its hash was captured");
    }
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest("hex"), size_bytes: size };
}

async function walkRegularFiles(root: string, relativePath: string, output: string[]): Promise<void> {
  const fullPath = resolveInside(root, relativePath);
  let stat;
  try {
    stat = await fs.lstat(fullPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) fail("backup_symlink_blocked", `Symlinks and junctions are not backed up: ${relativePath}`);
  if (stat.isFile()) {
    output.push(normalizeRelativePath(relativePath));
    return;
  }
  if (!stat.isDirectory()) fail("unsupported_backup_file", `Unsupported private backup file type: ${relativePath}`);
  const children = await fs.readdir(fullPath, { withFileTypes: true });
  children.sort((a, b) => a.name.localeCompare(b.name));
  for (const child of children) {
    await walkRegularFiles(root, `${normalizeRelativePath(relativePath)}/${child.name}`, output);
  }
}

async function collectInventory(
  roots: PrivateBackupRoot[],
  maxFiles: number,
  maxTotalBytes: number,
): Promise<{ entries: InventoryEntry[]; total_bytes: number; inventory_sha256: string }> {
  const entries: InventoryEntry[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const configured of roots) {
    const scope = normalizeScope(configured.scope);
    const root = path.resolve(configured.root);
    const rootStat = await fs.lstat(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!rootStat) continue;
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("invalid_backup_root", `Backup root is not a regular directory: ${scope}`);
    const files: string[] = [];
    for (const selector of configured.relative_paths) await walkRegularFiles(root, selector, files);
    for (const relativePath of Array.from(new Set(files)).sort((a, b) => a.localeCompare(b))) {
      const identity = `${scope}/${relativePath}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const sourcePath = resolveInside(root, relativePath);
      const digest = await hashRegularFile(sourcePath);
      totalBytes += digest.size_bytes;
      if (entries.length + 1 > maxFiles) fail("backup_file_limit_exceeded", `Private backup exceeds ${maxFiles} files`);
      if (totalBytes > maxTotalBytes) fail("backup_size_limit_exceeded", `Private backup exceeds ${maxTotalBytes} bytes`);
      entries.push({
        scope,
        relative_path: relativePath,
        source_path: sourcePath,
        size_bytes: digest.size_bytes,
        sha256: digest.sha256,
      });
    }
  }
  entries.sort((a, b) => a.scope.localeCompare(b.scope) || a.relative_path.localeCompare(b.relative_path));
  const inventoryHash = createHash("sha256");
  for (const entry of entries) inventoryHash.update(`${canonicalEntry(entry)}\n`);
  return { entries, total_bytes: totalBytes, inventory_sha256: inventoryHash.digest("hex") };
}

async function deriveKey(recoveryKey: Uint8Array, salt: Uint8Array): Promise<Buffer> {
  if (recoveryKey.byteLength < 32 || recoveryKey.byteLength > 8192) {
    fail("invalid_recovery_key", "Recovery key material must be between 32 and 8192 bytes");
  }
  return await new Promise<Buffer>((resolve, reject) => {
    scryptCallback(
      Buffer.from(recoveryKey),
      salt,
      SCRYPT_KEY_BYTES,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 },
      (error, derived) => error ? reject(error) : resolve(derived),
    );
  });
}

export function recoveryKeyId(recoveryKey: Uint8Array): string {
  return sha256(Buffer.concat([Buffer.from("dinobrain-recovery-key-id-v1\0", "utf8"), Buffer.from(recoveryKey)])).slice(0, 32);
}

export async function readRecoveryKeyFile(filePath: string): Promise<Buffer> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) fail("invalid_recovery_key_file", "Recovery key file is invalid");
  const value = Buffer.from((await fs.readFile(filePath, "utf8")).trim(), "utf8");
  if (value.byteLength < 32) fail("invalid_recovery_key", "Recovery key file does not contain enough key material");
  return value;
}

export async function generateRecoveryKeyFile(
  filePath: string,
  protectedRoots: string[] = [],
): Promise<{ key_id: string }> {
  const resolved = path.resolve(filePath);
  assertRecoveryKeyOutsideRoots(resolved, protectedRoots);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const material = `DINOBRAIN-RECOVERY-KEY-V1:${randomBytes(32).toString("base64url")}`;
  const handle = await fs.open(resolved, "wx", 0o600);
  try {
    await handle.writeFile(`${material}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { key_id: recoveryKeyId(Buffer.from(material, "utf8")) };
}

export async function defaultPrivateDataRoot(
  dataRoot: string,
  options: { include_credentials?: boolean; include_local_backups?: boolean } = {},
): Promise<PrivateBackupRoot> {
  const relativePaths: string[] = [...DEFAULT_PRIVATE_DATA_PATHS];
  if (options.include_local_backups) relativePaths.push(".dino/local-backups");
  if (options.include_credentials) {
    const entries = await fs.readdir(dataRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name === ".env" || entry.name.startsWith(".env.") || /\.(?:pem|key|p12|pfx)$/i.test(entry.name)) {
        relativePaths.push(entry.name);
      }
    }
  }
  return { scope: "data", root: path.resolve(dataRoot), relative_paths: Array.from(new Set(relativePaths)) };
}

export async function createEncryptedPrivateBackup(
  options: CreatePrivateBackupOptions,
): Promise<CreatePrivateBackupResult> {
  const outputPath = path.resolve(options.output_path);
  if (options.roots.some((root) => isInside(root.root, outputPath))) {
    fail("backup_output_inside_source_root", "Encrypted backup must be written outside every protected source root");
  }
  const createdAt = options.created_at ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) fail("invalid_backup_timestamp", "Backup timestamp is invalid");
  const backupId = `private-backup-${new Date(createdAt).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID()}`;
  const sourceIdentity = validateSourceIdentity(options.source_identity);
  const inventory = await collectInventory(
    options.roots,
    options.max_files ?? DEFAULT_MAX_FILES,
    options.max_total_bytes ?? DEFAULT_MAX_TOTAL_BYTES,
  );
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const keyId = recoveryKeyId(options.recovery_key);
  const publicHeader: PrivateBackupPublicHeader = {
    version: PRIVATE_BACKUP_VERSION,
    inventory_policy_version: PRIVATE_BACKUP_INVENTORY_POLICY_VERSION,
    backup_id: backupId,
    created_at: createdAt,
    cipher: "aes-256-gcm",
    auth_tag_bytes: TAG_BYTES,
    iv_base64: iv.toString("base64"),
    key_id: keyId,
    kdf: {
      name: "scrypt",
      salt_base64: salt.toString("base64"),
      n: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      key_bytes: SCRYPT_KEY_BYTES,
    },
    source_identity: sourceIdentity,
  };
  const headerBytes = Buffer.from(JSON.stringify(publicHeader), "utf8");
  if (headerBytes.length > MAX_PUBLIC_HEADER_BYTES) fail("backup_header_too_large", "Public backup header is too large");
  const headerLength = Buffer.allocUnsafe(4);
  headerLength.writeUInt32BE(headerBytes.length, 0);
  const prefix = Buffer.concat([MAGIC, headerLength, headerBytes]);
  const key = await deriveKey(options.recovery_key, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(prefix);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const tempPath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.partial`);
  let output: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    output = await fs.open(tempPath, "wx", 0o600);
    await writeAll(output, prefix);
    const writeEncrypted = async (plain: Uint8Array): Promise<void> => {
      const encrypted = cipher.update(plain);
      if (encrypted.length > 0) await writeAll(output!, encrypted);
    };
    const manifest: PrivateManifestFrame = {
      type: "manifest",
      version: PRIVATE_BACKUP_VERSION,
      inventory_policy_version: PRIVATE_BACKUP_INVENTORY_POLICY_VERSION,
      backup_id: backupId,
      created_at: createdAt,
      source_identity: sourceIdentity,
      entry_count: inventory.entries.length,
      total_plaintext_bytes: inventory.total_bytes,
      inventory_sha256: inventory.inventory_sha256,
      scopes: Array.from(new Set(inventory.entries.map((entry) => entry.scope))).sort(),
    };
    await writeEncrypted(encodeFrame(manifest));
    const buffer = Buffer.allocUnsafe(IO_CHUNK_BYTES);
    for (const entry of inventory.entries) {
      const frame: PrivateFileFrame = {
        type: "file",
        scope: entry.scope,
        relative_path: entry.relative_path,
        size_bytes: entry.size_bytes,
        sha256: entry.sha256,
      };
      await writeEncrypted(encodeFrame(frame));
      const source = await fs.open(entry.source_path, "r");
      const verification = createHash("sha256");
      let size = 0;
      try {
        while (true) {
          const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
          if (bytesRead === 0) break;
          const chunk = buffer.subarray(0, bytesRead);
          verification.update(chunk);
          size += bytesRead;
          await writeEncrypted(chunk);
        }
      } finally {
        await source.close();
      }
      if (size !== entry.size_bytes || verification.digest("hex") !== entry.sha256) {
        fail("backup_source_changed", "A private source file changed while the encrypted archive was written");
      }
    }
    await writeEncrypted(encodeFrame({
      type: "end",
      entry_count: inventory.entries.length,
      total_plaintext_bytes: inventory.total_bytes,
      inventory_sha256: inventory.inventory_sha256,
    }));
    const final = cipher.final();
    if (final.length > 0) await writeAll(output, final);
    await writeAll(output, cipher.getAuthTag());
    await output.sync();
    await output.close();
    output = null;
    await fs.link(tempPath, outputPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") fail("backup_output_exists", "Encrypted backup output already exists");
      throw error;
    });
    await fs.unlink(tempPath);
    const archive = await hashRegularFile(outputPath);
    return {
      ok: true,
      status: "created",
      version: PRIVATE_BACKUP_VERSION,
      inventory_policy_version: PRIVATE_BACKUP_INVENTORY_POLICY_VERSION,
      backup_id: backupId,
      created_at: createdAt,
      archive_sha256: archive.sha256,
      archive_size_bytes: archive.size_bytes,
      inventory_sha256: inventory.inventory_sha256,
      entry_count: inventory.entries.length,
      total_plaintext_bytes: inventory.total_bytes,
      key_id: keyId,
      source_identity: sourceIdentity,
    };
  } finally {
    key.fill(0);
    if (output) await output.close().catch(() => undefined);
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function assertNoSymlinkParents(root: string, relativePath: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const rootStat = await fs.lstat(resolvedRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (rootStat?.isSymbolicLink() || (rootStat && !rootStat.isDirectory())) fail("restore_target_root_invalid", "Restore target root is not a regular directory");
  let cursor = resolvedRoot;
  const segments = normalizeRelativePath(relativePath).split("/").slice(0, -1);
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    const stat = await fs.lstat(cursor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("restore_symlink_parent_blocked", "Restore target contains a symlink or non-directory parent");
  }
}

async function copyAtomic(source: string, destination: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temp = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.${randomUUID()}.restore`);
  try {
    await fs.copyFile(source, temp, fsConstants.COPYFILE_EXCL);
    const handle = await fs.open(temp, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.link(temp, destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") fail("restore_target_race", "Restore destination appeared during atomic promotion");
      throw error;
    });
    await fs.unlink(temp);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

export async function inspectPrivateBackupHeader(archivePath: string): Promise<PrivateBackupPublicHeader> {
  const handle = await fs.open(archivePath, "r");
  try {
    const stat = await handle.stat();
    if (stat.size < MAGIC.length + 4 + TAG_BYTES + 2) fail("backup_truncated", "Encrypted backup is too small");
    const magic = await readExact(handle, MAGIC.length, 0);
    if (!magic.equals(MAGIC)) fail("backup_magic_invalid", "Encrypted backup magic is invalid");
    const lengthBytes = await readExact(handle, 4, MAGIC.length);
    const headerLength = lengthBytes.readUInt32BE(0);
    if (headerLength < 2 || headerLength > MAX_PUBLIC_HEADER_BYTES) fail("backup_header_invalid", "Encrypted backup header length is invalid");
    const header = JSON.parse((await readExact(handle, headerLength, MAGIC.length + 4)).toString("utf8")) as PrivateBackupPublicHeader;
    if (
      header.version !== PRIVATE_BACKUP_VERSION ||
      header.inventory_policy_version !== PRIVATE_BACKUP_INVENTORY_POLICY_VERSION ||
      header.cipher !== "aes-256-gcm" ||
      header.auth_tag_bytes !== TAG_BYTES ||
      header.kdf?.name !== "scrypt" ||
      header.kdf.n !== SCRYPT_N ||
      header.kdf.r !== SCRYPT_R ||
      header.kdf.p !== SCRYPT_P ||
      header.kdf.key_bytes !== SCRYPT_KEY_BYTES ||
      !/^[a-f0-9]{32}$/i.test(header.key_id) ||
      !Number.isFinite(Date.parse(header.created_at))
    ) {
      fail("backup_header_unsupported", "Encrypted backup header uses an unsupported policy");
    }
    header.source_identity = validateSourceIdentity(header.source_identity);
    return header;
  } finally {
    await handle.close();
  }
}

export async function restoreEncryptedPrivateBackup(
  options: RestorePrivateBackupOptions,
): Promise<RestorePrivateBackupResult> {
  const archivePath = path.resolve(options.archive_path);
  const archive = await fs.open(archivePath, "r");
  const stagingParent = path.resolve(options.staging_parent ?? os.tmpdir());
  await fs.mkdir(stagingParent, { recursive: true });
  const stagingRoot = await fs.mkdtemp(path.join(stagingParent, "dinobrain-private-restore-"));
  const payloadRoot = path.join(stagingRoot, "payload");
  const rollbackRoot = path.join(stagingRoot, "rollback");
  let openStagedFile: Awaited<ReturnType<typeof fs.open>> | null = null;
  let key: Buffer | null = null;
  let preserveStaging = false;
  try {
    const stat = await archive.stat();
    if (stat.size < MAGIC.length + 4 + TAG_BYTES + 2) fail("backup_truncated", "Encrypted backup is too small");
    const magic = await readExact(archive, MAGIC.length, 0);
    if (!magic.equals(MAGIC)) fail("backup_magic_invalid", "Encrypted backup magic is invalid");
    const lengthBytes = await readExact(archive, 4, MAGIC.length);
    const headerLength = lengthBytes.readUInt32BE(0);
    if (headerLength < 2 || headerLength > MAX_PUBLIC_HEADER_BYTES) fail("backup_header_invalid", "Encrypted backup header length is invalid");
    const headerBytes = await readExact(archive, headerLength, MAGIC.length + 4);
    let header: PrivateBackupPublicHeader;
    try {
      header = JSON.parse(headerBytes.toString("utf8")) as PrivateBackupPublicHeader;
    } catch {
      fail("backup_header_invalid", "Encrypted backup public header is not valid JSON");
    }
    if (
      header.version !== PRIVATE_BACKUP_VERSION ||
      header.inventory_policy_version !== PRIVATE_BACKUP_INVENTORY_POLICY_VERSION ||
      header.cipher !== "aes-256-gcm" ||
      header.auth_tag_bytes !== TAG_BYTES ||
      header.kdf?.name !== "scrypt" ||
      header.kdf.n !== SCRYPT_N ||
      header.kdf.r !== SCRYPT_R ||
      header.kdf.p !== SCRYPT_P ||
      header.kdf.key_bytes !== SCRYPT_KEY_BYTES ||
      !/^[a-f0-9]{32}$/i.test(header.key_id) ||
      !Number.isFinite(Date.parse(header.created_at))
    ) {
      fail("backup_header_unsupported", "Encrypted backup header uses an unsupported policy");
    }
    header.source_identity = validateSourceIdentity(header.source_identity);
    if (header.key_id !== recoveryKeyId(options.recovery_key)) fail("recovery_key_mismatch", "Recovery key id does not match the encrypted backup");
    const prefixLength = MAGIC.length + 4 + headerLength;
    const ciphertextLength = stat.size - prefixLength - TAG_BYTES;
    if (ciphertextLength <= 0) fail("backup_truncated", "Encrypted backup contains no payload");
    const tag = await readExact(archive, TAG_BYTES, stat.size - TAG_BYTES);
    const salt = Buffer.from(header.kdf.salt_base64, "base64");
    const iv = Buffer.from(header.iv_base64, "base64");
    if (salt.length !== 16 || iv.length !== 12) fail("backup_header_invalid", "Encrypted backup salt or IV is invalid");
    key = await deriveKey(options.recovery_key, salt);
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    const prefix = Buffer.concat([magic, lengthBytes, headerBytes]);
    const archiveHash = createHash("sha256").update(prefix);
    decipher.setAAD(prefix);
    decipher.setAuthTag(tag);

    let pending = Buffer.alloc(0);
    let manifest: PrivateManifestFrame | null = null;
    let endFrame: PrivateEndFrame | null = null;
    let currentFile: {
      frame: PrivateFileFrame;
      path: string;
      remaining: number;
      bytes: number;
      hash: ReturnType<typeof createHash>;
    } | null = null;
    const restoredEntries: Array<{ frame: PrivateFileFrame; staged_path: string }> = [];
    const seen = new Set<string>();
    const inventoryHash = createHash("sha256");
    let totalPlaintext = 0;
    let declaredPlaintext = 0;
    const maxFiles = options.max_files ?? DEFAULT_MAX_FILES;
    const maxTotalBytes = options.max_total_bytes ?? DEFAULT_MAX_TOTAL_BYTES;

    const finishCurrentFile = async (): Promise<void> => {
      if (!currentFile || currentFile.remaining !== 0 || !openStagedFile) return;
      await openStagedFile.sync();
      await openStagedFile.close();
      openStagedFile = null;
      const digest = currentFile.hash.digest("hex");
      if (digest !== currentFile.frame.sha256 || currentFile.bytes !== currentFile.frame.size_bytes) {
        fail("backup_file_hash_mismatch", "Decrypted private file hash does not match its authenticated frame");
      }
      inventoryHash.update(`${canonicalEntry({
        scope: currentFile.frame.scope,
        relative_path: currentFile.frame.relative_path,
        size_bytes: currentFile.frame.size_bytes,
        sha256: currentFile.frame.sha256,
      })}\n`);
      totalPlaintext += currentFile.bytes;
      restoredEntries.push({ frame: currentFile.frame, staged_path: currentFile.path });
      currentFile = null;
    };

    const handleFrame = async (frame: PrivateFrame): Promise<void> => {
      if (endFrame) fail("backup_frame_after_end", "Encrypted backup contains data after the end frame");
      if (frame.type === "manifest") {
        if (manifest || restoredEntries.length > 0 || currentFile) fail("backup_manifest_order_invalid", "Encrypted backup manifest is not first");
        if (
          frame.version !== PRIVATE_BACKUP_VERSION ||
          frame.inventory_policy_version !== PRIVATE_BACKUP_INVENTORY_POLICY_VERSION ||
          frame.backup_id !== header.backup_id ||
          frame.created_at !== header.created_at ||
          JSON.stringify(validateSourceIdentity(frame.source_identity)) !== JSON.stringify(header.source_identity)
        ) fail("backup_manifest_mismatch", "Encrypted manifest does not match the authenticated public header");
        if (
          !Number.isSafeInteger(frame.entry_count) ||
          frame.entry_count < 0 ||
          frame.entry_count > maxFiles ||
          !Number.isSafeInteger(frame.total_plaintext_bytes) ||
          frame.total_plaintext_bytes < 0 ||
          frame.total_plaintext_bytes > maxTotalBytes ||
          !/^[a-f0-9]{64}$/i.test(frame.inventory_sha256)
        ) fail("backup_manifest_limits_invalid", "Encrypted backup manifest exceeds restore limits");
        manifest = frame;
        return;
      }
      if (!manifest) fail("backup_manifest_missing", "Encrypted backup file frame appeared before its manifest");
      if (frame.type === "end") {
        endFrame = frame;
        return;
      }
      const scope = normalizeScope(frame.scope);
      const relativePath = normalizeRelativePath(frame.relative_path);
      if (!Number.isSafeInteger(frame.size_bytes) || frame.size_bytes < 0 || !/^[a-f0-9]{64}$/i.test(frame.sha256)) {
        fail("backup_file_frame_invalid", "Encrypted backup file frame is invalid");
      }
      const identity = `${scope}/${relativePath}`;
      if (seen.has(identity)) fail("backup_duplicate_path", "Encrypted backup contains a duplicate destination path");
      seen.add(identity);
      declaredPlaintext += frame.size_bytes;
      if (seen.size > maxFiles || declaredPlaintext > maxTotalBytes) {
        fail("backup_restore_limit_exceeded", "Encrypted backup exceeds configured restore limits");
      }
      if (!Object.hasOwn(options.target_roots, scope)) fail("restore_scope_unmapped", `Restore target is not configured for scope ${scope}`);
      const stagedPath = resolveInside(payloadRoot, identity);
      await fs.mkdir(path.dirname(stagedPath), { recursive: true });
      openStagedFile = await fs.open(stagedPath, "wx", 0o600);
      currentFile = {
        frame: { ...frame, scope, relative_path: relativePath },
        path: stagedPath,
        remaining: frame.size_bytes,
        bytes: 0,
        hash: createHash("sha256"),
      };
      if (frame.size_bytes === 0) await finishCurrentFile();
    };

    const feed = async (plain: Buffer): Promise<void> => {
      let input = pending.length > 0 ? Buffer.concat([pending, plain]) : plain;
      pending = Buffer.alloc(0);
      while (input.length > 0) {
        if (currentFile) {
          const take = Math.min(currentFile.remaining, input.length);
          if (take > 0) {
            const part = input.subarray(0, take);
            await openStagedFile!.write(part, 0, part.length, null);
            currentFile.hash.update(part);
            currentFile.remaining -= take;
            currentFile.bytes += take;
            input = input.subarray(take);
          }
          if (currentFile.remaining === 0) await finishCurrentFile();
          continue;
        }
        if (input.length < 4) {
          pending = Buffer.from(input);
          return;
        }
        const frameLength = input.readUInt32BE(0);
        if (frameLength < 2 || frameLength > MAX_FRAME_HEADER_BYTES) fail("backup_frame_invalid", "Encrypted backup frame length is invalid");
        if (input.length < 4 + frameLength) {
          pending = Buffer.from(input);
          return;
        }
        let frame: PrivateFrame;
        try {
          frame = JSON.parse(input.subarray(4, 4 + frameLength).toString("utf8")) as PrivateFrame;
        } catch {
          fail("backup_frame_invalid", "Encrypted backup frame is not valid JSON");
        }
        input = input.subarray(4 + frameLength);
        await handleFrame(frame);
      }
    };

    const encryptedBuffer = Buffer.allocUnsafe(IO_CHUNK_BYTES);
    let encryptedOffset = 0;
    while (encryptedOffset < ciphertextLength) {
      const requested = Math.min(encryptedBuffer.length, ciphertextLength - encryptedOffset);
      const { bytesRead } = await archive.read(encryptedBuffer, 0, requested, prefixLength + encryptedOffset);
      if (bytesRead === 0) fail("backup_truncated", "Encrypted backup payload ended unexpectedly");
      encryptedOffset += bytesRead;
      const encrypted = encryptedBuffer.subarray(0, bytesRead);
      archiveHash.update(encrypted);
      const plain = decipher.update(encrypted);
      if (plain.length > 0) await feed(plain);
    }
    try {
      const final = decipher.final();
      if (final.length > 0) await feed(final);
    } catch {
      fail("backup_authentication_failed", "Encrypted backup authentication failed");
    }
    archiveHash.update(tag);
    const archiveAfter = await archive.stat();
    if (archiveAfter.size !== stat.size || archiveAfter.mtimeMs !== stat.mtimeMs) {
      fail("backup_archive_changed", "Encrypted backup changed while it was restored");
    }
    const archiveIdentity = { sha256: archiveHash.digest("hex"), size_bytes: stat.size };
    const authenticatedManifest = manifest as PrivateManifestFrame | null;
    const authenticatedEndFrame = endFrame as PrivateEndFrame | null;
    if (openStagedFile || currentFile || pending.length > 0 || !authenticatedManifest || !authenticatedEndFrame) {
      fail("backup_payload_incomplete", "Authenticated backup payload is incomplete");
    }
    const computedInventoryHash = inventoryHash.digest("hex");
    if (
      authenticatedManifest.entry_count !== restoredEntries.length ||
      authenticatedEndFrame.entry_count !== restoredEntries.length ||
      authenticatedManifest.total_plaintext_bytes !== totalPlaintext ||
      authenticatedEndFrame.total_plaintext_bytes !== totalPlaintext ||
      authenticatedManifest.inventory_sha256 !== computedInventoryHash ||
      authenticatedEndFrame.inventory_sha256 !== computedInventoryHash
    ) fail("backup_inventory_mismatch", "Authenticated backup inventory totals do not match restored bytes");

    const createdAt = Date.parse(authenticatedManifest.created_at);
    const now = (options.now ?? new Date()).getTime();
    if (!Number.isFinite(createdAt) || createdAt > now + 5 * 60_000) fail("backup_timestamp_invalid", "Backup timestamp is invalid or in the future");
    if (options.max_age_ms !== undefined && now - createdAt > options.max_age_ms) fail("backup_stale", "Encrypted backup is older than the configured restore window");
    for (const [keyName, expected] of Object.entries(options.expected_source_identity ?? {})) {
      if (expected !== undefined && authenticatedManifest.source_identity[keyName as keyof PrivateBackupSourceIdentity] !== expected) {
        fail("backup_source_identity_mismatch", `Encrypted backup source identity does not match ${keyName}`);
      }
    }

    const destinations = [] as Array<{
      entry: { frame: PrivateFileFrame; staged_path: string };
      destination: string;
      existed: boolean;
      rollback_path: string;
      original_sha256: string | null;
      original_size_bytes: number | null;
    }>;
    for (const entry of restoredEntries) {
      const targetRoot = path.resolve(options.target_roots[entry.frame.scope]);
      await assertNoSymlinkParents(targetRoot, entry.frame.relative_path);
      const destination = resolveInside(targetRoot, entry.frame.relative_path);
      const existing = await fs.lstat(destination).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (existing?.isSymbolicLink() || (existing && !existing.isFile())) fail("restore_target_invalid", "Restore destination is not a regular file");
      if (existing && !options.overwrite_private) fail("restore_target_conflict", "Private restore destination already exists");
      const original = existing ? await hashRegularFile(destination) : null;
      destinations.push({
        entry,
        destination,
        existed: Boolean(existing),
        rollback_path: resolveInside(rollbackRoot, `${entry.frame.scope}/${entry.frame.relative_path}`),
        original_sha256: original?.sha256 ?? null,
        original_size_bytes: original?.size_bytes ?? null,
      });
    }

    for (const item of destinations.filter((entry) => entry.existed)) {
      await fs.mkdir(path.dirname(item.rollback_path), { recursive: true });
      await fs.copyFile(item.destination, item.rollback_path, fsConstants.COPYFILE_EXCL);
      const backup = await hashRegularFile(item.rollback_path);
      if (backup.sha256 !== item.original_sha256 || backup.size_bytes !== item.original_size_bytes) {
        fail("restore_rollback_backup_failed", "Could not verify a private restore rollback copy");
      }
    }

    const applied: typeof destinations = [];
    try {
      for (const item of destinations) {
        await assertNoSymlinkParents(path.resolve(options.target_roots[item.entry.frame.scope]), item.entry.frame.relative_path);
        applied.push(item);
        if (item.existed) await fs.rm(item.destination, { force: true });
        await copyAtomic(item.entry.staged_path, item.destination);
        const restored = await hashRegularFile(item.destination);
        if (restored.sha256 !== item.entry.frame.sha256 || restored.size_bytes !== item.entry.frame.size_bytes) {
          fail("restore_verification_failed", "Restored private file failed its final hash verification");
        }
      }
    } catch (error) {
      const rollbackFailures: string[] = [];
      for (const item of [...applied].reverse()) {
        try {
          await fs.rm(item.destination, { force: true });
          if (item.existed) {
            await copyAtomic(item.rollback_path, item.destination);
            const restoredOriginal = await hashRegularFile(item.destination);
            if (
              restoredOriginal.sha256 !== item.original_sha256 ||
              restoredOriginal.size_bytes !== item.original_size_bytes
            ) {
              fail("restore_rollback_hash_mismatch", "A restored rollback copy did not match the original private file");
            }
          }
        } catch (rollbackError) {
          rollbackFailures.push(
            `${item.entry.frame.scope}/${item.entry.frame.relative_path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          );
        }
      }
      if (rollbackFailures.length > 0) {
        preserveStaging = true;
        fail(
          "restore_rollback_failed",
          `Private restore failed and rollback requires manual recovery from ${rollbackRoot}. ${rollbackFailures.join("; ")}`,
        );
      }
      throw error;
    }

    const result: RestorePrivateBackupResult = {
      ok: true,
      status: "restored",
      version: PRIVATE_BACKUP_VERSION,
      inventory_policy_version: PRIVATE_BACKUP_INVENTORY_POLICY_VERSION,
      backup_id: authenticatedManifest.backup_id,
      created_at: authenticatedManifest.created_at,
      archive_sha256: archiveIdentity.sha256,
      archive_size_bytes: archiveIdentity.size_bytes,
      inventory_sha256: computedInventoryHash,
      restored_entry_count: restoredEntries.length,
      restored_plaintext_bytes: totalPlaintext,
      key_id: header.key_id,
      source_identity: authenticatedManifest.source_identity,
    };
    if (options.receipt_path) await atomicWriteJson(options.receipt_path, result);
    return result;
  } finally {
    if (key) key.fill(0);
    if (openStagedFile) await openStagedFile.close().catch(() => undefined);
    await archive.close().catch(() => undefined);
    if (!preserveStaging) await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
