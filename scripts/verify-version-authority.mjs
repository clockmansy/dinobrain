import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DINOBRAIN_DATA_CONTRACT_VERSION, DINOBRAIN_VERSION, VERSION_MANIFEST_PATH } from "./lib/version-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function json(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

function xmlVersion(relativePath, element) {
  const text = readFileSync(path.join(root, relativePath), "utf8");
  return text.match(new RegExp(`<${element}[^>]*>([^<]+)</${element}>`))?.[1]?.trim() ?? null;
}

const packageJson = json("package.json");
const packageLock = json("package-lock.json");
const projectVersion = xmlVersion("installer/DinoBrainSetup/DinoBrainSetup.csproj", "Version");
const setupVersion = xmlVersion("installer/DinoBrainSetup/DinoBrainSetup.csproj", "SetupVersion");
const osContractSource = readFileSync(path.join(root, "src", "os-contract.ts"), "utf8");
const installerBuildSource = readFileSync(path.join(root, "scripts", "build-windows-installer.ps1"), "utf8");
const releaseSource = readFileSync(path.join(root, "scripts", "publish-github-release.ps1"), "utf8");
const hookSource = readFileSync(path.join(root, "scripts", "dinobrain-user-prompt-hook.mjs"), "utf8");
const observatorySource = readFileSync(path.join(root, "scripts", "dinobrain-observatory.mjs"), "utf8");

assert(packageJson.version === DINOBRAIN_VERSION, "package.json version does not match version.json");
assert(packageLock.version === DINOBRAIN_VERSION, "package-lock.json root version does not match version.json");
assert(packageLock.packages?.[""]?.version === DINOBRAIN_VERSION, "package-lock.json package version does not match version.json");
assert(projectVersion === DINOBRAIN_VERSION, "installer project Version does not match version.json");
assert(setupVersion === DINOBRAIN_VERSION, "installer SetupVersion does not match version.json");
assert(
  osContractSource.includes('import { DINOBRAIN_VERSION } from "./version.js"'),
  "OS contract does not derive its version from version.json",
);
assert(!/DINOBRAIN_OS_VERSION\s*=\s*["']\d/.test(osContractSource), "OS contract still contains a version literal");
assert(installerBuildSource.includes('Join-Path $root "version.json"'), "installer build does not read version.json");
assert(releaseSource.includes('Join-Path $root "version.json"'), "release publisher does not read version.json");
assert(!/2\.2\.\d+/.test(hookSource), "Codex hook still contains a release version literal");
assert(!/version:\s*["']2\.2\./.test(observatorySource), "Observatory still contains an OS release version literal");

console.log(
  JSON.stringify(
    {
      ok: true,
      version_manifest_path: VERSION_MANIFEST_PATH,
      version: DINOBRAIN_VERSION,
      data_contract_version: DINOBRAIN_DATA_CONTRACT_VERSION,
      aligned: [
        "version.json",
        "package.json",
        "package-lock.json",
        "installer csproj",
        "OS contract",
        "installer build",
        "release publisher",
        "Codex hook",
        "Observatory",
      ],
    },
    null,
    2,
  ),
);
