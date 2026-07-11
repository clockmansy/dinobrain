import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PRIVATE_BACKUP_INVENTORY_POLICY_VERSION,
  PRIVATE_BACKUP_VERSION,
  PrivateBackupError,
  createEncryptedPrivateBackup,
  defaultPrivateDataRoot,
  generateRecoveryKeyFile,
  inspectPrivateBackupHeader,
  readRecoveryKeyFile,
  restoreEncryptedPrivateBackup,
} from "../dist/private-backup.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-private-backup-"));
const sourceData = path.join(fixtureRoot, "source-data");
const sourceCodex = path.join(fixtureRoot, "source-codex");
const backupDir = path.join(fixtureRoot, "encrypted");
const keyFile = path.join(fixtureRoot, "recovery-key.txt");
const wrongKeyFile = path.join(fixtureRoot, "wrong-key.txt");
const archivePath = path.join(backupDir, "private-backup.dinobrain");
const staleArchivePath = path.join(backupDir, "stale-backup.dinobrain");
const sourceIdentity = {
  app_commit: "a".repeat(40),
  data_commit: "b".repeat(40),
  data_contract_version: 3,
};

function write(relativeRoot, relativePath, value) {
  const target = path.join(relativeRoot, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, value);
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function gitHead(repo) {
  return execFileSync("git", ["-c", `safe.directory=${repo}`, "-C", repo, "rev-parse", "HEAD"], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function git(repo, args) {
  return execFileSync("git", ["-c", `safe.directory=${repo}`, "-C", repo, ...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runCli(args) {
  const output = execFileSync(process.execPath, [path.join(root, "dist", "run-private-backup.js"), ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output);
}

function expectFailure(code, operation) {
  return operation().then(
    () => assert.fail(`Expected ${code}`),
    (error) => {
      assert(error instanceof PrivateBackupError, `Expected PrivateBackupError, got ${error}`);
      assert.equal(error.code, code);
      return error;
    },
  );
}

function fileContains(filePath, needle) {
  const target = Buffer.from(needle, "utf8");
  const handle = openSync(filePath, "r");
  const buffer = Buffer.alloc(1024 * 1024 + target.length);
  let carry = 0;
  try {
    while (true) {
      const bytesRead = readSync(handle, buffer, carry, 1024 * 1024, null);
      if (bytesRead === 0) return false;
      const used = carry + bytesRead;
      if (buffer.subarray(0, used).includes(target)) return true;
      carry = Math.min(target.length - 1, used);
      buffer.copyWithin(0, used - carry, used);
    }
  } finally {
    closeSync(handle);
  }
}

async function restoreTarget(name, key, options = {}) {
  const data = path.join(fixtureRoot, name, "data");
  const codex = path.join(fixtureRoot, name, "codex");
  mkdirSync(data, { recursive: true });
  mkdirSync(codex, { recursive: true });
  return {
    data,
    codex,
    result: await restoreEncryptedPrivateBackup({
      archive_path: options.archive ?? archivePath,
      recovery_key: key,
      target_roots: { data, codex_config: codex },
      expected_source_identity: options.identity ?? sourceIdentity,
      max_age_ms: options.maxAgeMs ?? 90 * 24 * 60 * 60 * 1000,
      now: options.now,
      overwrite_private: options.overwrite ?? false,
      staging_parent: path.join(fixtureRoot, "staging"),
    }),
  };
}

try {
  write(sourceData, "10_Conversations/raw/session.json", '{"private":"session-secret-SAFE03"}\n');
  write(sourceData, "30_Sources/private/source.md", "private-source-SAFE03\n");
  write(sourceData, ".dino/local.json", '{"machine":"local-only-SAFE03"}\n');
  write(sourceData, ".dino/secrets.json", '{"credential":"credential-SAFE03"}\n');
  write(sourceData, "attachments/private/large.bin", Buffer.alloc(8 * 1024 * 1024, 0x5a));
  write(sourceCodex, "config.toml", '[mcp_servers.dinobrain]\nsecret = "config-secret-SAFE03"\n');
  mkdirSync(backupDir, { recursive: true });

  await generateRecoveryKeyFile(keyFile, [sourceData, sourceCodex, backupDir]);
  await generateRecoveryKeyFile(wrongKeyFile, [sourceData, sourceCodex, backupDir]);
  const key = await readRecoveryKeyFile(keyFile);
  const wrongKey = await readRecoveryKeyFile(wrongKeyFile);
  const dataRoot = await defaultPrivateDataRoot(sourceData);
  const roots = [
    dataRoot,
    { scope: "codex_config", root: sourceCodex, relative_paths: ["config.toml", "hooks.json"] },
  ];

  const rssBefore = process.memoryUsage().rss;
  const created = await createEncryptedPrivateBackup({
    roots,
    output_path: archivePath,
    recovery_key: key,
    source_identity: sourceIdentity,
  });
  const header = await inspectPrivateBackupHeader(archivePath);
  assert.equal(created.entry_count, 6);
  assert.equal(header.key_id, created.key_id);
  assert.equal(header.version, PRIVATE_BACKUP_VERSION);
  assert.deepEqual(header.source_identity, sourceIdentity);
  assert(!JSON.stringify(header).includes("session.json"));
  assert(!JSON.stringify(created).includes(fixtureRoot));
  assert(!fileContains(archivePath, "session-secret-SAFE03"));
  assert(!fileContains(archivePath, "config-secret-SAFE03"));

  const good = await restoreTarget("good-restore", key);
  assert.equal(good.result.restored_entry_count, created.entry_count);
  assert.equal(readFileSync(path.join(good.data, "10_Conversations/raw/session.json"), "utf8"), '{"private":"session-secret-SAFE03"}\n');
  assert.equal(readFileSync(path.join(good.codex, "config.toml"), "utf8"), '[mcp_servers.dinobrain]\nsecret = "config-secret-SAFE03"\n');
  assert.equal(sha256File(path.join(good.data, "attachments/private/large.bin")), sha256File(path.join(sourceData, "attachments/private/large.bin")));

  const wrongRoot = path.join(fixtureRoot, "wrong-key-target");
  await expectFailure("recovery_key_mismatch", async () => await restoreEncryptedPrivateBackup({
    archive_path: archivePath,
    recovery_key: wrongKey,
    target_roots: { data: path.join(wrongRoot, "data"), codex_config: path.join(wrongRoot, "codex") },
    staging_parent: path.join(fixtureRoot, "staging"),
  }));
  assert(!existsSync(path.join(wrongRoot, "data", "10_Conversations", "raw", "session.json")));

  const truncatedPath = path.join(backupDir, "truncated.dinobrain");
  copyFileSync(archivePath, truncatedPath);
  truncateSync(truncatedPath, created.archive_size_bytes - 31);
  await expectFailure("backup_authentication_failed", async () => await restoreEncryptedPrivateBackup({
    archive_path: truncatedPath,
    recovery_key: key,
    target_roots: { data: path.join(fixtureRoot, "truncated-target", "data"), codex_config: path.join(fixtureRoot, "truncated-target", "codex") },
    staging_parent: path.join(fixtureRoot, "staging"),
  }));

  const staleCreatedAt = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
  await createEncryptedPrivateBackup({
    roots,
    output_path: staleArchivePath,
    recovery_key: key,
    source_identity: sourceIdentity,
    created_at: staleCreatedAt,
  });
  await expectFailure("backup_stale", async () => await restoreEncryptedPrivateBackup({
    archive_path: staleArchivePath,
    recovery_key: key,
    target_roots: { data: path.join(fixtureRoot, "stale-target", "data"), codex_config: path.join(fixtureRoot, "stale-target", "codex") },
    max_age_ms: 30 * 24 * 60 * 60 * 1000,
    staging_parent: path.join(fixtureRoot, "staging"),
  }));

  await expectFailure("backup_source_identity_mismatch", async () => await restoreEncryptedPrivateBackup({
    archive_path: archivePath,
    recovery_key: key,
    target_roots: { data: path.join(fixtureRoot, "identity-target", "data"), codex_config: path.join(fixtureRoot, "identity-target", "codex") },
    expected_source_identity: { data_commit: "c".repeat(40) },
    staging_parent: path.join(fixtureRoot, "staging"),
  }));

  const conflictData = path.join(fixtureRoot, "conflict-target", "data");
  const conflictCodex = path.join(fixtureRoot, "conflict-target", "codex");
  write(conflictData, "10_Conversations/raw/session.json", "existing-private-file\n");
  mkdirSync(conflictCodex, { recursive: true });
  await expectFailure("restore_target_conflict", async () => await restoreEncryptedPrivateBackup({
    archive_path: archivePath,
    recovery_key: key,
    target_roots: { data: conflictData, codex_config: conflictCodex },
    staging_parent: path.join(fixtureRoot, "staging"),
  }));
  assert.equal(readFileSync(path.join(conflictData, "10_Conversations/raw/session.json"), "utf8"), "existing-private-file\n");

  const overwrite = await restoreEncryptedPrivateBackup({
    archive_path: archivePath,
    recovery_key: key,
    target_roots: { data: conflictData, codex_config: conflictCodex },
    overwrite_private: true,
    staging_parent: path.join(fixtureRoot, "staging"),
  });
  assert.equal(overwrite.status, "restored");
  assert.equal(readFileSync(path.join(conflictData, "10_Conversations/raw/session.json"), "utf8"), '{"private":"session-secret-SAFE03"}\n');

  await expectFailure("recovery_key_inside_protected_root", async () => await generateRecoveryKeyFile(
    path.join(sourceData, "unsafe-recovery-key.txt"),
    [sourceData],
  ));
  await expectFailure("invalid_backup_path", async () => await createEncryptedPrivateBackup({
    roots: [{ scope: "data", root: sourceData, relative_paths: ["../escape"] }],
    output_path: path.join(backupDir, "invalid-path.dinobrain"),
    recovery_key: key,
    source_identity: sourceIdentity,
  }));
  await expectFailure("backup_output_inside_source_root", async () => await createEncryptedPrivateBackup({
    roots,
    output_path: path.join(sourceData, "unsafe-backup.dinobrain"),
    recovery_key: key,
    source_identity: sourceIdentity,
  }));
  await expectFailure("backup_output_exists", async () => await createEncryptedPrivateBackup({
    roots,
    output_path: archivePath,
    recovery_key: key,
    source_identity: sourceIdentity,
  }));

  const cliApp = path.join(fixtureRoot, "cli-app");
  const cliData = path.join(fixtureRoot, "cli-data");
  const cliClone = path.join(fixtureRoot, "cli-clone");
  const cliBackupDir = path.join(fixtureRoot, "cli-encrypted");
  const cliArchive = path.join(cliBackupDir, "private.dinobrain");
  const cliKey = path.join(fixtureRoot, "cli-recovery-key.txt");
  mkdirSync(cliApp, { recursive: true });
  mkdirSync(cliData, { recursive: true });
  mkdirSync(cliBackupDir, { recursive: true });
  write(cliApp, "README.md", "# CLI app fixture\n");
  write(cliData, ".gitignore", "10_Conversations/raw/\n.dino/local.json\n");
  write(cliData, "20_Wiki/reviewed.md", "# Reviewed public memory\n");
  for (const repo of [cliApp, cliData]) {
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "safe03@example.invalid"]);
    git(repo, ["config", "user.name", "SAFE-03 Verifier"]);
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "fixture baseline"]);
  }
  write(cliData, "10_Conversations/raw/cli-session.json", '{"private":"cli-private-SAFE03"}\n');
  write(cliData, ".dino/local.json", '{"local":"cli-local-SAFE03"}\n');
  const keygen = runCli([
    "keygen", "--key-file", cliKey,
    "--protect-root", cliApp,
    "--protect-root", cliData,
    "--protect-root", cliBackupDir,
  ]);
  assert.equal(keygen.ok, true);
  const cliCreated = runCli([
    "create",
    "--app-root", cliApp,
    "--data-root", cliData,
    "--output", cliArchive,
    "--key-file", cliKey,
  ]);
  assert.equal(cliCreated.status, "created");
  const inspected = runCli(["inspect", "--archive", cliArchive]);
  assert.equal(inspected.header.backup_id, cliCreated.backup_id);
  assert.deepEqual(inspected.header.source_identity, cliCreated.source_identity);
  execFileSync("git", ["clone", cliData, cliClone], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const cliRestored = runCli([
    "restore",
    "--apply",
    "--app-root", cliApp,
    "--data-root", cliClone,
    "--archive", cliArchive,
    "--key-file", cliKey,
  ]);
  assert.equal(cliRestored.status, "restored");
  assert.equal(readFileSync(path.join(cliClone, "10_Conversations/raw/cli-session.json"), "utf8"), '{"private":"cli-private-SAFE03"}\n');
  assert.equal(
    readFileSync(path.join(cliClone, "20_Wiki/reviewed.md"), "utf8").replace(/\r\n/g, "\n"),
    "# Reviewed public memory\n",
  );
  assert.equal(gitHead(cliClone), gitHead(cliData));

  const rssDeltaBytes = Math.max(0, process.memoryUsage().rss - rssBefore);
  assert(rssDeltaBytes < 192 * 1024 * 1024, `Streaming backup/restore RSS delta exceeded 192 MiB: ${rssDeltaBytes}`);
  const implementationSha256 = createHash("sha256")
    .update(readFileSync(path.join(root, "dist", "private-backup.js")))
    .update(readFileSync(path.join(root, "scripts", "verify-private-backup-restore.mjs")))
    .digest("hex");
  const status = {
    version: "encrypted_restore_status_v1",
    status: "healthy",
    generated_at: new Date().toISOString(),
    drill_kind: "isolated_fixture",
    archive_version: PRIVATE_BACKUP_VERSION,
    inventory_policy_version: PRIVATE_BACKUP_INVENTORY_POLICY_VERSION,
    cipher: "aes-256-gcm",
    kdf: "scrypt",
    implementation_sha256: implementationSha256,
    app_commit_at_verification: gitHead(root),
    counts: {
      backed_up_files: created.entry_count,
      restored_files: good.result.restored_entry_count,
      plaintext_bytes: created.total_plaintext_bytes,
    },
    resource_usage: {
      rss_delta_bytes: rssDeltaBytes,
      max_rss_delta_bytes: 192 * 1024 * 1024,
      bounded_streaming: true,
    },
    scenarios: [
      "authenticated_restore",
      "plaintext_not_visible_in_archive",
      "source_identity_available_for_checkout",
      "wrong_key_blocked",
      "truncated_archive_blocked",
      "stale_backup_blocked",
      "source_identity_mismatch_blocked",
      "existing_target_conflict_blocked",
      "explicit_private_overwrite_verified",
      "recovery_key_inside_vault_blocked",
      "path_escape_blocked",
      "archive_inside_source_root_blocked",
      "existing_archive_not_overwritten",
      "cli_keygen_create_inspect_restore",
      "git_clone_plus_private_restore",
    ],
    proof_hashes: {
      archive_sha256: created.archive_sha256,
      inventory_sha256: created.inventory_sha256,
      key_id: created.key_id,
    },
  };
  assert(!JSON.stringify(status).includes(fixtureRoot));
  let statusPath = null;
  if (process.argv.includes("--write-status")) {
    const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(root, "..", "dinobrain-data"));
    statusPath = path.join(dataRoot, ".dino", "state", "encrypted_restore_status.json");
    mkdirSync(path.dirname(statusPath), { recursive: true });
    writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify({ ok: true, status_path: statusPath ? ".dino/state/encrypted_restore_status.json" : null, report: status }, null, 2));
  key.fill(0);
  wrongKey.fill(0);
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
