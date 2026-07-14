import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shellPath = path.join(root, "scripts", "dinobrain-observatory.mjs");
const source = await readFile(shellPath, "utf8");
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

try {
  execFileSync(process.execPath, ["--check", shellPath], { cwd: root, stdio: "pipe" });
  check("shell syntax", true, "node --check passed");
} catch (error) {
  check("shell syntax", false, error?.stderr?.toString() || error?.message || "syntax check failed");
}

const requiredMarkers = [
  ["shared inspector", "id=\"inspector\""],
  ["keyboard close", "event.key === \"Escape\""],
  ["activity endpoint", "/api/activity"],
  ["bounded activity adapter", "Math.min(500"],
  ["activity pause/resume", "activity-pause"],
  ["activity severity filter", "data-activity-filter=\"attention\""],
  ["activity search", "activity-search"],
  ["activity follow tail", "activity-follow"],
  ["activity clear", "activity-clear"],
  ["reconnect status", "연결 끊김"],
  ["plain-language live summary", 'id="overview-summary"'],
  ["focus return", "lastInvoker.focus"],
  ["four-surface navigation", "data-surface-nav=\"overview\""],
  ["activity surface target", "data-surface-nav=\"activity\""],
  ["knowledge surface target", "data-surface-nav=\"knowledge\""],
  ["settings surface target", "data-surface-nav=\"settings\""],
  ["nested inspector flatten", "flattenScalars"],
  ["explicit empty inspector row", "값 없음"],
  ["filtered visible copy", "JSON.stringify(getVisibleActivity())"],
  ["stable activity signature", "activitySignature"],
  ["explicit severity fields", "action_decision"],
  ["bounded sync status", 'id="sync-scheduler"'],
  ["safe scoped sync action", 'id="sync-now"'],
  ["automatic sync toggle", 'id="sync-automatic"'],
  ["sync action origin guard", "x-dinobrain-action"],
  ["sync state endpoint", "/api/sync-state"],
  ["automatic scheduler loop", "maybeRunAutomaticSync"],
];
for (const [name, marker] of requiredMarkers) check(name, source.includes(marker), marker);

const chipCount = (source.match(/role="button" tabindex="0"/g) || []).length;
check("all health controls are activatable", chipCount >= 10, `${chipCount} keyboard-activatable chips found`);
const boundedRows = source.includes("slice(-500)") && source.includes("max-height: 310px");
check("DOM and memory are bounded", boundedRows, "activity rows are capped at 500 with a scroll window");
check("empty Activity markup has no trailing quote", !source.includes('+ "</div>\';'), "empty state closes with valid HTML");

const url = process.env.OBSERVATORY_URL;
if (url) {
  try {
    const response = await fetch(new URL("/api/activity?limit=500", url));
    const payload = await response.json();
    check("activity runtime endpoint", response.ok && payload.ok === true, `${response.status} / ${payload.events?.length ?? 0} events`);
    check("activity runtime bound", Array.isArray(payload.events) && payload.events.length <= 500, `${payload.events?.length ?? 0} events`);
    const syncResponse = await fetch(new URL("/api/sync-state", url));
    const syncPayload = await syncResponse.json();
    check("sync runtime endpoint", syncResponse.ok && syncPayload.version && syncPayload.automatic, `${syncResponse.status} / ${syncPayload.version ?? "missing"}`);
    const rejectedSync = await fetch(new URL("/api/sync/run", url), { method: "POST" });
    check("sync runtime action guard", rejectedSync.status === 403, `${rejectedSync.status}`);
  } catch (error) {
    check("activity runtime endpoint", false, error?.message || "request failed");
  }
}

const failed = checks.filter((item) => !item.ok);
console.log(JSON.stringify({ ok: failed.length === 0, checked: checks.length, failed: failed.length, checks }, null, 2));
if (failed.length) process.exitCode = 1;
