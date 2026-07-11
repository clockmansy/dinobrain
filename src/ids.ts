import { createHash, randomUUID } from "node:crypto";

function compactTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/[.Z]/g, "");
}

export function makeUniqueId(prefix: string, description: string, slugLength = 28): string {
  const opaqueLength = Math.max(8, Math.min(40, slugLength));
  const descriptionHash = createHash("sha256").update(description).digest("hex").slice(0, opaqueLength);
  return `${prefix}-${compactTimestamp()}-${descriptionHash}-${randomUUID()}`;
}
