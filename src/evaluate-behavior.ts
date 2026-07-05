import path from "node:path";

import { evaluateBehaviorMemoryLift } from "./behavior-eval.js";

const dataRoot = path.resolve(process.env.DINOBRAIN_DATA_DIR ?? path.join(process.cwd(), "..", "dinobrain-data"));
const goldenPath = process.env.DINOBRAIN_BEHAVIOR_GOLDEN_FILE;
const allowMissingGolden = /^(1|true|yes|on)$/i.test(process.env.DINOBRAIN_BEHAVIOR_ALLOW_MISSING ?? "");

const report = await evaluateBehaviorMemoryLift(dataRoot, { allowMissingGolden, goldenPath });
console.log(JSON.stringify(report, null, 2));
if (report.ok !== true) process.exitCode = 1;
