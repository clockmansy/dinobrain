import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  createEncryptedPrivateBackup,
  assertRecoveryKeyOutsideRoots,
  defaultPrivateDataRoot,
  generateRecoveryKeyFile,
  inspectPrivateBackupHeader,
  readRecoveryKeyFile,
  restoreEncryptedPrivateBackup,
  type PrivateBackupRoot,
  type PrivateBackupSourceIdentity,
} from "./private-backup.js";

function argsMap(values: string[]): Map<string, string[]> {
  const output = new Map<string, string[]>();
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key?.startsWith("--")) continue;
    const next = values[index + 1];
    const value = next && !next.startsWith("--") ? (index += 1, next) : "true";
    output.set(key.slice(2), [...(output.get(key.slice(2)) ?? []), value]);
  }
  return output;
}

function required(map: Map<string, string[]>, key: string): string {
  const value = map.get(key)?.at(-1)?.trim();
  if (!value) throw new Error(`Missing required --${key}`);
  return value;
}

function flag(map: Map<string, string[]>, key: string): boolean {
  return /^(?:1|true|yes|on)$/i.test(map.get(key)?.at(-1) ?? "false");
}

function gitHead(root: string): string {
  return execFileSync("git", ["-c", `safe.directory=${path.resolve(root)}`, "-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function sourceIdentity(appRoot: string, dataRoot: string): PrivateBackupSourceIdentity {
  return { app_commit: gitHead(appRoot), data_commit: gitHead(dataRoot), data_contract_version: 3 };
}

function userConfigRoots(map: Map<string, string[]>): PrivateBackupRoot[] {
  const includeUserConfig = flag(map, "include-user-config");
  const includeClientAuth = flag(map, "include-client-auth");
  if (!includeUserConfig && !includeClientAuth) return [];
  return [
    {
      scope: "codex_config",
      root: path.resolve(map.get("codex-home")?.at(-1) ?? path.join(homedir(), ".codex")),
      relative_paths: [
        ...(includeUserConfig ? ["config.toml", "hooks.json"] : []),
        ...(includeClientAuth ? ["auth.json"] : []),
      ],
    },
    {
      scope: "claude_config",
      root: path.resolve(map.get("claude-home")?.at(-1) ?? path.join(homedir(), ".claude")),
      relative_paths: [
        ...(includeUserConfig ? ["settings.json"] : []),
        ...(includeClientAuth ? [".credentials.json"] : []),
      ],
    },
  ];
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "";
  const map = argsMap(process.argv.slice(3));
  if (command === "keygen") {
    const keyFile = path.resolve(required(map, "key-file"));
    const protectedRoots = map.get("protect-root") ?? [];
    console.log(JSON.stringify({ ok: true, key_file_created: true, ...(await generateRecoveryKeyFile(keyFile, protectedRoots)) }, null, 2));
    return;
  }
  if (command === "inspect") {
    const header = await inspectPrivateBackupHeader(path.resolve(required(map, "archive")));
    console.log(JSON.stringify({ ok: true, header }, null, 2));
    return;
  }
  if (command === "create") {
    const appRoot = path.resolve(map.get("app-root")?.at(-1) ?? process.cwd());
    const dataRoot = path.resolve(required(map, "data-root"));
    const outputPath = path.resolve(required(map, "output"));
    const keyFile = path.resolve(required(map, "key-file"));
    assertRecoveryKeyOutsideRoots(keyFile, [appRoot, dataRoot, path.dirname(outputPath)]);
    const key = await readRecoveryKeyFile(keyFile);
    try {
      const clientAuthOnly = flag(map, "client-auth-only");
      if (clientAuthOnly && !flag(map, "include-client-auth")) {
        throw new Error("--client-auth-only requires --include-client-auth.");
      }
      const roots = [
        ...(clientAuthOnly
          ? []
          : [
              await defaultPrivateDataRoot(dataRoot, {
                include_credentials: flag(map, "include-credentials"),
                include_local_backups: flag(map, "include-local-backups"),
              }),
            ]),
        ...userConfigRoots(map),
      ];
      const result = await createEncryptedPrivateBackup({
        roots,
        output_path: outputPath,
        recovery_key: key,
        source_identity: sourceIdentity(appRoot, dataRoot),
      });
      if (clientAuthOnly && result.entry_count !== 2) {
        await rm(outputPath, { force: true });
        throw new Error("Client auth capsule requires both Codex auth.json and Claude .credentials.json.");
      }
      console.log(JSON.stringify(result, null, 2));
    } finally {
      key.fill(0);
    }
    return;
  }
  if (command === "restore") {
    if (!flag(map, "apply")) throw new Error("Restore is dry by default. Pass --apply only after checking target roots and backup identity.");
    const appRoot = path.resolve(map.get("app-root")?.at(-1) ?? process.cwd());
    const dataRoot = path.resolve(required(map, "data-root"));
    const archivePath = path.resolve(required(map, "archive"));
    const keyFile = path.resolve(required(map, "key-file"));
    assertRecoveryKeyOutsideRoots(keyFile, [appRoot, dataRoot, path.dirname(archivePath)]);
    const key = await readRecoveryKeyFile(keyFile);
    const targetRoots: Record<string, string> = { data: dataRoot };
    if (flag(map, "include-user-config") || flag(map, "include-client-auth")) {
      targetRoots.codex_config = path.resolve(map.get("codex-home")?.at(-1) ?? path.join(homedir(), ".codex"));
      targetRoots.claude_config = path.resolve(map.get("claude-home")?.at(-1) ?? path.join(homedir(), ".claude"));
    }
    const maxAgeDays = Number(map.get("max-age-days")?.at(-1) ?? 90);
    try {
      const result = await restoreEncryptedPrivateBackup({
        archive_path: archivePath,
        recovery_key: key,
        target_roots: targetRoots,
        expected_source_identity: sourceIdentity(appRoot, dataRoot),
        max_age_ms: Number.isFinite(maxAgeDays) && maxAgeDays > 0 ? maxAgeDays * 24 * 60 * 60 * 1000 : undefined,
        overwrite_private: flag(map, "overwrite-private"),
        receipt_path: map.get("receipt")?.at(-1) ? path.resolve(map.get("receipt")!.at(-1)!) : undefined,
      });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      key.fill(0);
    }
    return;
  }
  throw new Error("Usage: run-private-backup <keygen|inspect|create|restore> [options]");
}

main().catch((error) => {
  const value = error as Error & { code?: string };
  console.error(JSON.stringify({ ok: false, error_code: value.code ?? "private_backup_failed", error: value.message }, null, 2));
  process.exit(1);
});
