import path from "node:path";

import {
  DATA_CLASSIFICATION_POLICY_VERSION,
  classifyCompleteGitHistory,
  classifyPrePushGitHistory,
  classifyStagedGitFiles,
} from "./lib/data-classifier-git.mjs";

function valueAfter(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      value += chunk;
    });
    process.stdin.on("end", () => resolve(value));
    process.stdin.on("error", reject);
    if (process.stdin.isTTY) resolve("");
  });
}

async function main() {
  if (process.argv.includes("--print-policy-version")) {
    process.stdout.write(`${DATA_CLASSIFICATION_POLICY_VERSION}\n`);
    return;
  }

  const repo = path.resolve(valueAfter("--repo") || process.cwd());
  const mode = valueAfter("--mode") || "pre-commit";
  const expectedVersion = valueAfter("--expected-policy-version");
  if (expectedVersion && expectedVersion !== DATA_CLASSIFICATION_POLICY_VERSION) {
    throw new Error(`Classifier policy mismatch: configured=${expectedVersion}; runtime=${DATA_CLASSIFICATION_POLICY_VERSION}`);
  }

  let report;
  if (mode === "pre-commit") {
    report = classifyStagedGitFiles(repo);
  } else if (mode === "pre-push") {
    report = classifyPrePushGitHistory(repo, await readStdin());
  } else if (mode === "history-all") {
    report = classifyCompleteGitHistory(repo);
  } else {
    throw new Error(`Unsupported classifier mode: ${mode}`);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`DinoBrain data classifier failed closed: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
