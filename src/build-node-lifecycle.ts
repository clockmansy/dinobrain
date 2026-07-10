import path from "node:path";

import { applyNodeLifecycle } from "./lifecycle.js";

const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"));

function argumentValue(name: string): string | null {
  const exact = process.argv.find((value) => value.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1) || null;
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function main(): Promise<void> {
  const started = Date.now();
  const apply = process.argv.includes("--apply");
  const rollbackTransactionId = argumentValue("--rollback");
  const reviewer = argumentValue("--reviewer") ?? "node-lifecycle-cli";
  if (apply && rollbackTransactionId) throw new Error("Use either --apply or --rollback <transaction-id>, not both.");
  if (process.argv.includes("--rollback") && !rollbackTransactionId) {
    throw new Error("--rollback requires a transaction id.");
  }
  const result = await applyNodeLifecycle(dataRoot, {
    apply,
    reviewer,
    rollbackTransactionId,
  });
  const output = {
    ...result,
    data_root: dataRoot,
    elapsed_ms: Date.now() - started,
  };
  console.log(JSON.stringify(output, null, 2));
  if (result.ok !== true) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
