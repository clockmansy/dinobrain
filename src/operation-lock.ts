import path from "node:path";

import { withFileLock } from "./concurrency.js";

export const OPERATIONS_WRITE_LOCK_RELATIVE_PATH = ".dino/index/operations-write.lock";

export function withOperationsWriteLock<T>(dataRoot: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = path.join(path.resolve(dataRoot), ...OPERATIONS_WRITE_LOCK_RELATIVE_PATH.split("/"));
  return withFileLock(lockPath, operation);
}
