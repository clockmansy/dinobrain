import path from "node:path";

import { buildAndWriteReleaseManifestReport } from "./release-manifest.js";

const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"));

async function main(): Promise<void> {
  const started = Date.now();
  const result = await buildAndWriteReleaseManifestReport(dataRoot, { appRoot: process.cwd() });
  const ok = result.report.status === "healthy";
  console.log(
    JSON.stringify(
      {
        ok,
        data_root: dataRoot,
        elapsed_ms: Date.now() - started,
        release_manifest_status_path: result.statusPath,
        status: result.report.status,
        visible_status: result.report.visible_status,
        package_version: result.report.package_version,
        authoritative_version: result.report.authoritative_version,
        version_aligned: result.report.version_aligned,
        expected_tag: result.report.expected_tag,
        app_head: result.report.app_git.head,
        data_head: result.report.data_git.head,
        tag_target: result.report.tag.target,
        zip_path: result.report.assets.zip_path,
        zip_sha256: result.report.assets.sha256_actual,
        blockers: result.report.blockers,
        warnings: result.report.warnings,
      },
      null,
      2,
    ),
  );
  if (!ok) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
