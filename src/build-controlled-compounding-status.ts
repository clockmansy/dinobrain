import path from "node:path";

import { buildAndWriteControlledCompoundingStatus } from "./controlled-compounding.js";

const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"));
const result = await buildAndWriteControlledCompoundingStatus(dataRoot);
console.log(JSON.stringify({ ok: result.report.status === "healthy", data_root: dataRoot, path: result.path, report: result.report }, null, 2));
if (result.report.status !== "healthy") process.exitCode = 1;
