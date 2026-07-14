import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localOnly = await import(pathToFileURL(path.join(root, "dist", "local-only.js")).href);
const semantic = await import(pathToFileURL(path.join(root, "dist", "semantic-embeddings.js")).href);
const hybrid = await import(pathToFileURL(path.join(root, "dist", "hybrid-retrieval.js")).href);
const scheduler = await import(pathToFileURL(path.join(root, "dist", "observatory-sync-state.js")).href);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true }).trim();
}

function initializeRepo(repo, files) {
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "local-only-test@example.invalid"]);
  git(repo, ["config", "user.name", "DinoBrain Local Only Test"]);
  git(repo, ["remote", "add", "origin", "https://example.invalid/dinobrain.git"]);
  for (const [relativePath, value] of Object.entries(files)) {
    const filePath = path.join(repo, ...relativePath.split("/"));
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, value, "utf8");
  }
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "test baseline"]);
}

const fixture = mkdtempSync(path.join(tmpdir(), "dinobrain-local-only-"));
try {
  const app = path.join(fixture, "app");
  const data = path.join(fixture, "data");
  const hook = path.join(fixture, "managed-hook.ps1");
  initializeRepo(app, { "README.md": "app\n" });
  initializeRepo(data, {
    "20_Wiki/README.md": "# Wiki\n",
    ".dino/tasks/task.json": "{}\n",
    ".dino/index/wiki-index.json": "{}\n",
    ".dino/migrations/migration.json": "{}\n",
    ".dino/evaluations/rag-golden.json": "{}\n",
  });
  mkdirSync(path.join(data, ".githooks"), { recursive: true });
  git(data, ["config", "core.hooksPath", ".githooks"]);
  writeFileSync(path.join(data, ".githooks", "pre-push"), "#!/bin/sh\nexit 0\n", "utf8");
  writeFileSync(hook, '$env:DINOBRAIN_HOOK_AUTO_SYNC = "1"\nWrite-Output "hook"\n', "utf8");

  execFileSync(
    "powershell.exe",
    [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts", "activate-local-only.ps1"),
      "-AppPath", app, "-VaultPath", data, "-ManagedHookPath", hook,
    ],
    { cwd: root, windowsHide: true, stdio: "pipe" },
  );

  assert(git(app, ["branch", "--show-current"]) === "local-main", "app did not enter local-main");
  assert(git(data, ["branch", "--show-current"]) === "local-main", "data did not enter local-main");
  assert(git(app, ["config", "--get", "remote.origin.pushurl"]) === "disabled://dinobrain-local-only", "app push URL not blocked");
  assert(git(data, ["config", "--get", "remote.origin.pushurl"]) === "disabled://dinobrain-local-only", "data push URL not blocked");
  assert(readFileSync(path.join(app, ".git", "hooks", "pre-push"), "utf8").includes("DINOBRAIN_LOCAL_ONLY_PUSH_BLOCK"), "app pre-push guard missing");
  assert(readFileSync(path.join(data, ".githooks", "pre-push"), "utf8").includes("DINOBRAIN_LOCAL_ONLY_PUSH_BLOCK"), "data pre-push guard missing");
  assert(readFileSync(path.join(data, ".githooks", "pre-commit"), "utf8").includes("DINOBRAIN_LOCAL_ONLY_SOURCE_GUARD"), "data local source guard missing");
  assert(existsSync(path.join(data, ".dino", "tasks", "task.json")), "runtime separation deleted live runtime data");
  assert(!git(data, ["ls-files", ".dino/tasks/task.json"]), "runtime task remained tracked");
  assert(!git(data, ["ls-files", ".dino/migrations/migration.json"]), "runtime migration remained tracked");
  assert(git(data, ["ls-files", ".dino/evaluations/rag-golden.json"]) === ".dino/evaluations/rag-golden.json", "evaluation source was removed from local history");
  mkdirSync(path.join(data, "15_Profile"), { recursive: true });
  writeFileSync(path.join(data, "15_Profile", "Identity.md"), "# Local identity\n", "utf8");
  git(data, ["add", "15_Profile/Identity.md"]);
  git(data, ["commit", "-m", "local profile source"]);
  assert(git(data, ["ls-files", "15_Profile/Identity.md"]) === "15_Profile/Identity.md", "local Profile source could not be committed");
  assert(git(data, ["ls-files", "20_Wiki/README.md"]) === "20_Wiki/README.md", "source Wiki was removed from local history");
  assert(localOnly.isLocalOnlyMode(data), "local_only marker was not recognized");
  assert(localOnly.localOnlyPushBlock(data, true)?.reason === "local_only_remote_push_disabled", "MCP push policy did not block");
  const schedulerState = await scheduler.setSyncSchedulerAutomaticEnabled({ dataRoot: data, enabled: true });
  assert(schedulerState.automatic_enabled === false, "local-only mode allowed automatic sync to be enabled");
  let schedulerExecutions = 0;
  const schedulerResult = await scheduler.runManualSafeScopedSync({
    dataRoot: data,
    execute: async () => {
      schedulerExecutions += 1;
      throw new Error("local-only scheduler executor must not run");
    },
  });
  assert(schedulerExecutions === 0, "local-only mode invoked the remote sync executor");
  assert(schedulerResult.executed === false, "local-only mode executed a scheduler attempt");
  assert(schedulerResult.reason_codes.includes("local_only_remote_push_disabled"), "local-only scheduler block reason missing");
  const schedulerStatus = await scheduler.readObservatorySyncState({ dataRoot: data });
  assert(schedulerStatus.push_policy === "blocked", "Observatory scheduler did not expose blocked push policy");
  assert(schedulerStatus.automatic.enabled === false, "Observatory scheduler exposed automatic sync as enabled");
  assert(schedulerStatus.manual_sync.enabled === false, "Observatory scheduler exposed manual sync as enabled");
  const hookText = readFileSync(hook, "utf8");
  assert(/DINOBRAIN_HOOK_AUTO_SYNC\s*=\s*"0"/.test(hookText), "managed hook auto-sync remained enabled");
  assert(/DINOBRAIN_HOOK_IMPORT_SESSION\s*=\s*"1"/.test(hookText), "candidate capture was not enabled");
  assert(semantic.DEFAULT_SEMANTIC_MODEL.includes("multilingual"), "default semantic model is not multilingual");
  assert(hybrid.rootIntentsForQuery("내 이름이 뭐야").includes("15_Profile/"), "Korean identity query did not route to Profile");

  console.log(JSON.stringify({ ok: true, status: "verified", mode: localOnly.localOnlyStatus(data).mode }, null, 2));
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
