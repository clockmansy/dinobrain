import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const tempRoot = mkdtempSync(path.join(tmpdir(), "dinobrain-chatgpt-import-"));
const exportRoot = path.join(tempRoot, "export");
const dataRoot = path.join(tempRoot, "data");
const zipPath = path.join(tempRoot, "chatgpt-export.zip");
const powershell = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

function writeJson(name, value) {
  writeFileSync(path.join(exportRoot, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function message(id, role, text, createTime, extraParts = []) {
  return {
    id,
    author: { role },
    create_time: createTime,
    content: { parts: [text, ...extraParts] },
  };
}

function conversation({ id, title, createdAt, doNotRemember = false, messages }) {
  const mapping = {};
  messages.forEach((item, index) => {
    mapping[`node-${index + 1}`] = {
      id: `node-${index + 1}`,
      parent: index === 0 ? null : `node-${index}`,
      children: index + 1 < messages.length ? [`node-${index + 2}`] : [],
      message: item,
    };
  });
  return {
    conversation_id: id,
    id,
    title,
    create_time: createdAt,
    update_time: createdAt + 10,
    current_node: `node-${messages.length}`,
    is_archived: false,
    is_do_not_remember: doNotRemember,
    mapping,
  };
}

function runImporter(extraArgs = []) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(appRoot, "scripts", "import-chatgpt-export.mjs"),
      "--zip",
      zipPath,
      "--data-root",
      dataRoot,
      ...extraArgs,
    ],
    { cwd: appRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "ChatGPT importer failed");
  return JSON.parse(result.stdout);
}

function powershellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function allFiles(root) {
  const files = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  }
  walk(root);
  return files;
}

try {
  mkdirSync(exportRoot, { recursive: true });
  mkdirSync(dataRoot, { recursive: true });
  const secret = "sk-testSECRETSECRETSECRETSECRET";
  const publicLeakSentinel = "RAW_PUBLIC_LEAK_SENTINEL";
  const assistantSentinel = "ASSISTANT_CONTENT_MUST_NOT_PERSIST";
  const doNotRememberSentinel = "DO_NOT_REMEMBER_CONTENT_MUST_NOT_PERSIST";
  const createdAt = Date.UTC(2026, 0, 2, 3, 4, 5) / 1000;
  const conversations = [
    conversation({
      id: "conversation-one",
      title: "Plan first user@example.com",
      createdAt,
      messages: [
        message(
          "message-one",
          "user",
          `LLM Wiki knowledge compounding. Start with a plan. token=${secret} ${publicLeakSentinel}`,
          createdAt,
          [{ asset_pointer: "file-service://file-test-secret" }],
        ),
        message("message-two", "assistant", assistantSentinel, createdAt + 1),
      ],
    }),
    conversation({
      id: "conversation-two",
      title: "Private conversation",
      createdAt: createdAt + 100,
      doNotRemember: true,
      messages: [message("message-three", "user", doNotRememberSentinel, createdAt + 100)],
    }),
  ];

  writeJson("conversations-000.json", conversations);
  writeJson("codex.json", []);
  writeJson("conversation_asset_file_names.json", { "file-test.dat": "private-upload.pdf" });
  writeJson("library_files.json", [{ id: "library-one", file_name: "private-upload.pdf", mime_type: "application/pdf" }]);
  writeJson("shared_conversations.json", []);
  writeJson("user.json", { email: "user@example.com", phone_number: "010-1234-5678", token: secret });
  writeJson("user_settings.json", [{ settings: { training_allowed: false } }]);
  writeJson("export_manifest.json", {
    version: 1,
    manifest_file: "export_manifest.json",
    export_files: [],
    logical_files: {
      "conversations.json": { files: ["conversations-000.json"], shard_count: 1, sharded: true },
      "codex.json": { files: ["codex.json"], sharded: false },
      "conversation_asset_file_names.json": { files: ["conversation_asset_file_names.json"], sharded: false },
      "file-test.dat": { files: ["file-test.dat"], sharded: false },
      "library_files.json": { files: ["library_files.json"], sharded: false },
      "shared_conversations.json": { files: ["shared_conversations.json"], sharded: false },
      "user.json": { files: ["user.json"], sharded: false },
      "user_settings.json": { files: ["user_settings.json"], sharded: false },
    },
  });
  writeFileSync(path.join(exportRoot, "file-test.dat"), Buffer.from("fixture attachment"));
  writeFileSync(path.join(exportRoot, "chat.html"), "<html>fixture</html>\n", "utf8");

  const zipResult = spawnSync(
    powershell,
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory(${powershellLiteral(exportRoot)}, ${powershellLiteral(zipPath)})`,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (zipResult.status !== 0) throw new Error(zipResult.stderr || "Could not create ChatGPT import fixture ZIP");

  const dryRun = runImporter();
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.mode, "dry_run");
  assert.equal(dryRun.conversation_count, 2);
  assert.equal(dryRun.message_count, 3);
  assert.equal(dryRun.source_card_count, 2);
  assert.equal(dryRun.attachment_entry_count, 1);
  assert.equal(allFiles(dataRoot).length, 0, "dry run wrote data files");

  const firstWrite = runImporter(["--write"]);
  assert.equal(firstWrite.ok, true);
  assert.equal(firstWrite.mode, "write");
  assert.equal(firstWrite.write_counts.imported, 8, "expected four files per conversation plus public artifacts");
  assert(firstWrite.supported_rules.some((rule) => rule.id === "knowledge_compounding_from_sessions"));

  const sourceDir = path.join(dataRoot, "30_Sources", "private", "chatgpt", "conversations");
  const sourceCards = readdirSync(sourceDir).map((name) => JSON.parse(readFileSync(path.join(sourceDir, name), "utf8")));
  assert.equal(sourceCards.length, 2);
  const regularCard = sourceCards.find((card) => card.do_not_remember === false);
  const privateCard = sourceCards.find((card) => card.do_not_remember === true);
  assert(regularCard.summary.includes("[REDACTED_SECRET]"));
  assert(!regularCard.summary.includes(secret));
  assert(!regularCard.summary.includes(assistantSentinel));
  assert.equal(privateCard.summary, "Content withheld because the exported conversation is marked do-not-remember.");
  assert(!JSON.stringify(privateCard).includes(doNotRememberSentinel));

  const archives = readdirSync(path.join(dataRoot, "10_Conversations", "raw")).map((name) =>
    JSON.parse(readFileSync(path.join(dataRoot, "10_Conversations", "raw", name), "utf8")),
  );
  assert.equal(archives.length, 2);
  assert(archives.every((archive) => archive.storage_policy.raw_full_transcript_stored === false));
  assert(archives.every((archive) => archive.messages.every((item) => !Object.hasOwn(item, "content") && !Object.hasOwn(item, "preview"))));

  const publicFiles = [
    path.join(dataRoot, "20_Wiki", "ChatGPT-Conversation-Registry.md"),
    path.join(dataRoot, "20_Wiki", "ChatGPT-Session-Knowledge-Profile.md"),
    path.join(dataRoot, "60_Operations", "session-imports", "chatgpt-export-registry.json"),
    path.join(dataRoot, "60_Operations", "session-promotions", "chatgpt-session-knowledge-promotion.json"),
  ];
  const publicText = publicFiles.map((file) => readFileSync(file, "utf8")).join("\n");
  for (const forbidden of [secret, publicLeakSentinel, assistantSentinel, doNotRememberSentinel, "user@example.com", "010-1234-5678"]) {
    assert(!publicText.includes(forbidden), `public artifact leaked: ${forbidden}`);
  }
  const registryReport = JSON.parse(readFileSync(publicFiles[2], "utf8"));
  assert.equal(registryReport.coverage.chatgpt_conversation_count, 2);
  assert.equal(registryReport.coverage.parse_errors, 0);
  assert.equal(registryReport.privacy.raw_full_transcript_stored, false);
  assert.equal(registryReport.sessions.length, 2);
  assert.equal(registryReport.privacy.excluded_sensitive_entries[0].entry, "user.json");

  const secondWrite = runImporter(["--write"]);
  assert.equal(secondWrite.write_counts.skipped, 4, "local source records were not idempotent");
  assert.equal(secondWrite.write_counts.imported, 0);

  console.log(
    JSON.stringify(
      {
        ok: true,
        conversations: firstWrite.conversation_count,
        messages: firstWrite.message_count,
        source_cards: firstWrite.source_card_count,
        supported_rules: firstWrite.supported_rules.map((rule) => rule.id),
        raw_full_transcript_stored: false,
        public_secret_leaks: 0,
        idempotent_local_records: secondWrite.write_counts.skipped,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
