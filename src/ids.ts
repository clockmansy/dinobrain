import { randomUUID } from "node:crypto";

function safeIdSlug(value: string, limit: number): string {
  const slug = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, limit);
  return slug || "record";
}

function compactTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/[.Z]/g, "");
}

export function makeUniqueId(prefix: string, description: string, slugLength = 28): string {
  return `${prefix}-${compactTimestamp()}-${safeIdSlug(description, slugLength)}-${randomUUID()}`;
}
