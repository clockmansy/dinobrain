import { withFileLock } from "./concurrency.js";
import { dataPath } from "./context.js";

export const TASK_LIFECYCLE_MUTATION_LOCK = ".dino/locks/task-lifecycle-mutation.lock";

export async function withTaskLifecycleMutationLock<T>(
  dataRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = dataPath(dataRoot, ...TASK_LIFECYCLE_MUTATION_LOCK.split("/"));
  return withFileLock(lockPath, operation, {
    timeoutMs: 120_000,
    staleMs: 15 * 60_000,
  });
}
