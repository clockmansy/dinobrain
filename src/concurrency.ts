import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

type FileLockOptions = {
  timeoutMs?: number;
  staleMs?: number;
};

const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_STALE_MS = 300_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(attempt: number): number {
  return Math.min(200, 20 + attempt * 15) + Math.floor(Math.random() * 20);
}

async function removeOwnedLock(lockPath: string, owner: string): Promise<void> {
  try {
    const lock = JSON.parse(await fs.readFile(lockPath, "utf8")) as { owner?: string };
    if (lock.owner !== owner) return;
    await fs.unlink(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function refreshOwnedLock(lockPath: string, owner: string): Promise<void> {
  try {
    const lock = JSON.parse(await fs.readFile(lockPath, "utf8")) as { owner?: string };
    if (lock.owner !== owner) return;
    const now = new Date();
    await fs.utimes(lockPath, now, now);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function withFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const owner = `${process.pid}-${randomUUID()}`;
  const startedAt = Date.now();
  let attempt = 0;

  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  while (true) {
    try {
      const handle = await fs.open(lockPath, "wx");
      try {
        await handle.writeFile(
          `${JSON.stringify({ owner, pid: process.pid, acquired_at: new Date().toISOString() })}\n`,
          "utf8",
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          await fs.unlink(lockPath);
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        const statCode = (statError as NodeJS.ErrnoException).code;
        if (statCode !== "EPERM" && statCode !== "EACCES") throw statError;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for file lock: ${lockPath}`);
      }
      await sleep(retryDelay(attempt));
      attempt += 1;
    }
  }

  const heartbeatMs = Math.max(1_000, Math.min(30_000, Math.floor(staleMs / 3)));
  const heartbeat = setInterval(() => {
    void refreshOwnedLock(lockPath, owner).catch(() => undefined);
  }, heartbeatMs);
  heartbeat.unref();

  try {
    return await operation();
  } finally {
    clearInterval(heartbeat);
    await removeOwnedLock(lockPath, owner);
  }
}

function isRetryableRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EBUSY" || code === "EPERM";
}

async function renameWithRetry(source: string, destination: string): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fs.rename(source, destination);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableRenameError(error)) throw error;
      await sleep(retryDelay(attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Could not replace ${destination}`);
}

export async function atomicWriteBytes(
  filePath: string,
  value: Uint8Array,
  validate?: (candidatePath: string) => Promise<void>,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(tempPath, "wx");
    await handle.writeFile(value);
    await handle.sync();
    await handle.close();
    handle = null;
    if (validate) await validate(tempPath);
    await renameWithRetry(tempPath, filePath);
    if (validate) await validate(filePath);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export async function atomicWriteText(
  filePath: string,
  value: string,
  validate?: (candidatePath: string) => Promise<void>,
): Promise<void> {
  await atomicWriteBytes(filePath, Buffer.from(value, "utf8"), validate);
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  JSON.parse(serialized);
  await atomicWriteText(filePath, serialized, async (candidatePath) => {
    JSON.parse(await fs.readFile(candidatePath, "utf8"));
  });
}

export async function appendFileWithLock(filePath: string, value: string): Promise<void> {
  await withFileLock(`${filePath}.append.lock`, async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const handle = await fs.open(filePath, "a");
    try {
      await handle.writeFile(value, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
}
