import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type DinoBrainVersionManifest = {
  schema_version: 1;
  version: string;
  data_contract_version: number;
};

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export const VERSION_MANIFEST_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "version.json",
);

function loadVersionManifest(): DinoBrainVersionManifest {
  const parsed = JSON.parse(readFileSync(VERSION_MANIFEST_PATH, "utf8")) as Partial<DinoBrainVersionManifest>;
  if (parsed.schema_version !== 1) throw new Error("Unsupported DinoBrain version manifest schema");
  if (typeof parsed.version !== "string" || !SEMVER.test(parsed.version)) {
    throw new Error("DinoBrain version manifest contains an invalid version");
  }
  if (!Number.isInteger(parsed.data_contract_version) || Number(parsed.data_contract_version) < 1) {
    throw new Error("DinoBrain version manifest contains an invalid data contract version");
  }
  return parsed as DinoBrainVersionManifest;
}

export const DINOBRAIN_VERSION_MANIFEST = Object.freeze(loadVersionManifest());
export const DINOBRAIN_VERSION = DINOBRAIN_VERSION_MANIFEST.version;
export const DINOBRAIN_DATA_CONTRACT_VERSION = DINOBRAIN_VERSION_MANIFEST.data_contract_version;
