import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const VERSION_MANIFEST_PATH = path.join(root, "version.json");

const parsed = JSON.parse(readFileSync(VERSION_MANIFEST_PATH, "utf8"));
if (parsed.schema_version !== 1) throw new Error("Unsupported DinoBrain version manifest schema");
if (typeof parsed.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(parsed.version)) {
  throw new Error("DinoBrain version manifest contains an invalid version");
}
if (!Number.isInteger(parsed.data_contract_version) || parsed.data_contract_version < 1) {
  throw new Error("DinoBrain version manifest contains an invalid data contract version");
}

export const VERSION_MANIFEST = Object.freeze(parsed);
export const DINOBRAIN_VERSION = VERSION_MANIFEST.version;
export const DINOBRAIN_DATA_CONTRACT_VERSION = VERSION_MANIFEST.data_contract_version;
